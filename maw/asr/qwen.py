# pyright: reportAny=false, reportAttributeAccessIssue=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportMissingTypeStubs=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedVariable=false, reportImplicitStringConcatenation=false, reportArgumentType=false, reportIndexIssue=false

"""使用阿里云百炼 Qwen / Qwen-Audio / Fun-ASR 文件转写 API 生成视频字幕（云端版）。

特点：
- 无需 GPU、模型权重，只调 API（DASHSCOPE_API_KEY）
- 走 filetrans 异步模式，原生支持字/词级时间戳，最长 12 小时音频
- Qwen-Audio / Fun-ASR 可选说话人分离，speaker 标签写入 MAW 工程
- Qwen-Audio 支持即时热词、预编译 vocabulary_id 和 context 上下文
- 文件自动上传到 DashScope 临时 OSS（oss:// URL，48 小时有效）
- 全程 RESTful API（不用 SDK，因为 SDK 不支持 oss:// 给 filetrans）
- 标点由 API 的 words[].punctuation 字段直接给出，跳过本地 LCS 对齐算法

输出为通用的 UTF-8 JSON 工程格式（默认保存为 `.mosp`，包含 items/text/language），可直接交给 edit.py 编辑。
配置读取 .env 文件（DASHSCOPE_API_KEY 等）。
"""

import argparse
import json
import os
import re as _re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

import requests

from maw.project_tracks import make_project
from maw.editor_entry_policy import should_generate_standalone_editor
from maw.stickers import get_default_sticker_dir
from maw.asr.common import (
    _run_media_tool,
    _resolve_media_tool,
    extract_audio,
    get_duration_sec,
    generate_srt,
    parse_duration,
)
from maw.asr.segmentation import (
    _DEFAULT_EXTRA_STRONG_PUNCT,
    _DEFAULT_STRIP_TAIL_PUNCT,
    configure_extra_strong_punct,
    WESTERN_MAX_WORDS,
    WESTERN_MIN_WORDS,
    repair_nonpositive_duration_segments,
    split_coarse_segments,
    _zero_duration_range,
    build_segments_preserving_speakers,
    build_segments_from_api_sentences,
)
from maw.app_paths import default_env_path
from maw.project import repair_segment_durations
from maw.qwen_audio import parse_qwen_audio_hotwords
from maw.speaker import speaker_color_summary, apply_project_speaker_colors
from maw.console import configure_utf8_stdio
from maw.energy_valley import snap_cue_boundaries
from maw.ffmpeg import resolve_ffmpeg_tools
from maw.language import (
    normalize_language_code,
    normalize_timestamp_range,
    resolve_language,
    split_mode_for_text,
    timestamp_items_cover_text,
    timestamp_granularity_for_items,
)
from maw.project_io import write_mosp

from maw.media_cache import embed_media_caches, merge_media_caches
from maw.media import resolve_default_audio_track
from maw.output_naming import (
    DASHSCOPE_PRICE_PER_SECOND,
    DASHSCOPE_QWEN_AUDIO_31_INPUT_PRICE_PER_MILLION_TOKENS,
    DASHSCOPE_QWEN_AUDIO_31_OUTPUT_PRICE_PER_MILLION_TOKENS,
    estimate_dashscope_cost,
    estimate_qwen_audio_31_cost,
    format_elapsed,
    format_maw_stat,
    debug_artifact_path,
)


# ===== 路径与常量 =====

HOTWORDS_FILE = Path(__file__).resolve().parents[2] / "hotwords.txt"
ENV_FILE = default_env_path()

QWEN3_ASR_FILETRANS_MODEL = "qwen3-asr-flash-filetrans"
QWEN_AUDIO_FILETRANS_MODEL = "qwen-audio-3.0-asr-flash-filetrans"
QWEN_AUDIO_31_FILETRANS_MODEL = "qwen-audio-3.1-asr-flash-filetrans"
FILETRANS_MODEL = QWEN_AUDIO_FILETRANS_MODEL
FUNASR_MODEL = "fun-asr"
POLL_HEARTBEAT_SECONDS = 15

TASK_SUCCESS_STATUSES = frozenset({"SUCCEEDED", "SUCCESS", "COMPLETED", "COMPLETE"})
TASK_FAILURE_STATUSES = frozenset({"FAILED", "FAILURE", "ERROR"})


# 本地 language 名 → DashScope language code
LANGUAGE_MAP = {
    "chinese": "zh", "zh": "zh", "zhongwen": "zh", "中文": "zh", "普通话": "zh",
    "cantonese": "yue", "yue": "yue", "粤语": "yue", "广东话": "yue",
    "english": "en", "en": "en",
    "japanese": "ja", "ja": "ja", "日语": "ja",
    "korean": "ko", "ko": "ko", "韩语": "ko",
    "german": "de", "de": "de",
    "french": "fr", "fr": "fr",
    "russian": "ru", "ru": "ru",
    "spanish": "es", "es": "es",
}


# ===== .env 读取（零依赖，不引入 python-dotenv） =====

def _load_env_file() -> dict[str, str]:
    """读取 .env 文件，返回 key=value 字典。"""
    if not ENV_FILE.exists():
        return {}
    config: dict[str, str] = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        config[k.strip()] = v.strip()
    return config


def _get_config() -> dict:
    """合并 .env 文件和系统环境变量（系统环境变量优先）。"""
    env = _load_env_file()

    def pick(key: str, default: str = "") -> str:
        return os.getenv(key) or env.get(key, default)

    region = pick("DASHSCOPE_REGION", "beijing").lower()
    workspace_id = pick("DASHSCOPE_WORKSPACE_ID")

    return {
        "api_key": pick("DASHSCOPE_API_KEY"),
        "region": region,
        "workspace_id": workspace_id,
        "default_language": pick("DASHSCOPE_DEFAULT_LANGUAGE"),
        "enable_words": pick("DASHSCOPE_ENABLE_WORDS", "true").lower() == "true",
        "enable_itn": pick("DASHSCOPE_ENABLE_ITN", "false").lower() == "true",
        "qwen_audio_vocabulary_id": pick("DASHSCOPE_QWEN_AUDIO_VOCABULARY_ID"),
        "funasr_vocabulary_id": pick("DASHSCOPE_FUNASR_VOCABULARY_ID"),
        "qwen_audio_hotword_weight": _validate_hotword_weight(
            pick("DASHSCOPE_QWEN_AUDIO_HOTWORD_WEIGHT", "5")
        ),
        "qwen_audio_context_file": pick("DASHSCOPE_QWEN_AUDIO_CONTEXT_FILE"),
        "poll_interval": int(pick("DASHSCOPE_POLL_INTERVAL", "5") or "5"),
        "poll_timeout": int(pick("DASHSCOPE_POLL_TIMEOUT", "1800") or "1800"),
        "ffmpeg_path": pick("FFMPEG_PATH"),
        "base_url": _compute_base_url(region, workspace_id),
    }


def _compute_base_url(region: str, workspace_id: str) -> str:
    if region == "singapore":
        if not workspace_id:
            raise ValueError(
                "DASHSCOPE_REGION=singapore 时必须在 .env 配置 DASHSCOPE_WORKSPACE_ID"
            )
        return f"https://{workspace_id}.ap-southeast-1.maas.aliyuncs.com"
    if region != "beijing":
        print(f"[警告] 未知地域 '{region}'，按北京（华北2）处理")
    if workspace_id:
        return f"https://{workspace_id}.cn-beijing.maas.aliyuncs.com"
    return "https://dashscope.aliyuncs.com"


def _normalize_language(lang: str | None) -> str | None:
    """把 'Chinese'/'中文' 等友好名映射成 DashScope 的 'zh' 代码。"""
    if not lang:
        return None
    key = lang.strip().lower()
    if key in {"auto", "automatic", "detect", "自动", "自动识别"}:
        return None
    return LANGUAGE_MAP.get(key, normalize_language_code(lang) or key)


def _validate_hotword_weight(value: str | int) -> int:
    """验证 Qwen-Audio 即时热词的权重。"""
    try:
        weight = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Qwen-Audio 热词权重必须是 1-5 或 50") from exc
    if weight not in (*range(1, 6), 50):
        raise ValueError("Qwen-Audio 热词权重必须是 1-5 或 50")
    return weight


def parse_hotword_weight(value: str) -> int:
    """argparse 用的 Qwen-Audio 即时热词权重解析器。"""
    try:
        return _validate_hotword_weight(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


QWEN_AUDIO_FILETRANS_MODELS = frozenset({
    QWEN_AUDIO_FILETRANS_MODEL,
    QWEN_AUDIO_31_FILETRANS_MODEL,
})


def is_funasr_model(model: str) -> bool:
    return model == FUNASR_MODEL or model.startswith("fun-asr-") or model.startswith("fun-asr-mtl")


def is_qwen_audio_model(model: str) -> bool:
    return model in QWEN_AUDIO_FILETRANS_MODELS


def is_qwen_audio_31_model(model: str) -> bool:
    return model == QWEN_AUDIO_31_FILETRANS_MODEL


def is_qwen3_model(model: str) -> bool:
    return model == QWEN3_ASR_FILETRANS_MODEL


def _usage_int(usage: dict, key: str) -> int:
    """从云端 usage 字典里取非负整数；缺失或非法时返回 0。"""
    try:
        value = int(usage.get(key) or 0)
    except (TypeError, ValueError):
        return 0
    return value if value >= 0 else 0


def supports_speaker_diarization(model: str) -> bool:
    return is_funasr_model(model) or is_qwen_audio_model(model)


def uses_file_urls(model: str) -> bool:
    return is_funasr_model(model) or is_qwen_audio_model(model)


def _dashscope_error_detail(response: requests.Response) -> str:
    """提取 DashScope 错误码与消息，不输出请求头或 API Key。"""
    try:
        body = response.json()
    except (ValueError, requests.exceptions.JSONDecodeError):
        text = response.text.strip()
        return text[:1000] if text else "服务端未返回错误正文"

    if not isinstance(body, dict):
        return str(body)[:1000]
    output = body.get("output")
    output = output if isinstance(output, dict) else {}
    code = body.get("code") or output.get("code") or ""
    message = body.get("message") or output.get("message") or ""
    request_id = body.get("request_id") or output.get("request_id") or ""
    parts = [
        f"code={code}" if code else "",
        f"message={message}" if message else "",
        f"request_id={request_id}" if request_id else "",
    ]
    detail = " | ".join(part for part in parts if part)
    return detail or json.dumps(body, ensure_ascii=False)[:1000]


def _dashscope_error_hint(status_code: int, detail: str) -> str:
    if "API-Key restrictions" in detail:
        return (
            "这枚 API Key 的自定义权限拒绝了本次调用。请在百炼 API Key 页面把权限改为“全部”，"
            "或在“自定义”的可访问模型中加入 fun-asr，并确认 IP 白名单允许当前网络；"
            "子业务空间还需先开放 Fun-ASR 模型调用权限。"
        )
    if "AllocationQuota.FreeTierOnly" in detail:
        return "请在百炼控制台关闭“仅使用免费额度”或为账户开通按量付费后重试。"
    if any(code in detail for code in ("Workspace.AccessDenied", "WorkSpaceNotFound", "WorkspaceNotFound")):
        return "请确认 API Key、地域和 Workspace ID 属于同一业务空间；北京地域也可填写 Workspace ID 使用专属域名。"
    if status_code == 403:
        return "请检查 Fun-ASR 模型权限、账户额度/付费开关，以及 API Key 与地域是否匹配。"
    return ""


def _raise_for_dashscope_status(response: requests.Response, action: str) -> None:
    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        detail = _dashscope_error_detail(response)
        hint = _dashscope_error_hint(response.status_code, detail)
        suffix = f"\n建议：{hint}" if hint else ""
        raise RuntimeError(
            f"{action}失败 (HTTP {response.status_code}): {detail}{suffix}"
        ) from exc


def load_hotwords(path: str | os.PathLike[str] | None = None) -> list[str]:
    """从 UTF-8 热词文件读取列表，忽略注释行和空行。"""
    source = Path(path).expanduser() if path else HOTWORDS_FILE
    if not source.exists():
        if path:
            raise FileNotFoundError(f"即时热词文件不存在: {source}")
        return []
    words = []
    for line in source.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            words.append(line)
    return words


def load_context_file(path: str | os.PathLike[str] | None) -> str:
    """读取 Qwen-Audio 上下文文件；空路径表示不启用上下文。"""
    if not path:
        return ""
    context_path = Path(path).expanduser()
    if not context_path.exists():
        raise FileNotFoundError(f"Qwen-Audio 上下文文件不存在: {context_path}")
    return context_path.read_text(encoding="utf-8").strip()


def build_qwen_audio_context(context_text: str | None) -> list[dict] | None:
    """把领域词表/前文整理成官方 REST API 的 input.messages 形状。"""
    text = (context_text or "").strip()
    if not text:
        return None
    # 官方限制每轮上下文总长 400 字符；单条 user input_text 足够表达领域词表。
    return [{
        "role": "user",
        "content": [{"type": "input_text", "text": text[:400]}],
    }]


# ===== SRT / 时间戳工具（与本地版一致） =====


# ===== 切句逻辑（与本地版 _split_words_to_segments 一致，纯 Python 复制） =====

# 共享断句配置里的「需要断句符号」：转写侧强断句符号的唯一来源。
# 模块默认值与 CLI 参数默认值、Launcher 默认计划保持一致（无隐式内置
# 强标点）；configure_extra_strong_punct 按运行时配置整体覆盖，空集合 =
# 仅按换行断句。


# 兼容旧私有名（maw/soniox.py 等复用方请用 split_by_silence）


# ===== 双轨切句：CJK 检测 + 空格语言（英文等）切句 =====

# 默认按词数计量：英文每条字幕 3–13 词（Netflix 风格上限约 14 词）。
# Keep the old provider-module names as compatibility aliases while the
# actual defaults live in the shared language contract.

# 英文句末强标点保留现行句子识别策略；超长补拆标点只读共享配置。
# 判定时剥掉的尾部引号/括号（如 word." 仍视为句号结尾）


# 无词级时间码时的文本切块断点：强/弱标点与西文常用标点，并上额外断句符号。


# ===== DashScope filetrans API 调用 =====

def get_upload_policy(base_url: str, api_key: str, model: str) -> dict:
    """获取 DashScope 临时 OSS 上传凭证。"""
    resp = requests.get(
        f"{base_url}/api/v1/uploads",
        params={"action": "getPolicy", "model": model},
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=30,
    )
    _raise_for_dashscope_status(resp, "获取上传凭证")
    body = resp.json()
    # DashScope 返回结构：{ "request_id": "...", "data": {...} } 或 { "output": {...} }
    if body.get("code") and body.get("code") != 200 and body.get("code") != "200":
        raise RuntimeError(f"获取上传凭证失败: {body}")
    data = body.get("data") or body.get("output") or body
    if not data:
        raise RuntimeError(f"上传凭证响应为空: {body}")
    return data


def upload_to_oss(policy: dict, file_path: str) -> str:
    """用 OSS Post Object 协议上传文件，返回 oss:// URL。

    DashScope 上传凭证实测字段（2026 北京地域）：
        policy: base64 编码的 OSS policy（conditions 含 bucket/x-oss-object-acl 等）
        signature: HMAC-SHA1 签名
        upload_dir: 文件在 OSS 的目录前缀（如 "dashscope-instant/<uid>/<date>/<uuid>"）
        upload_host: 完整的 OSS 上传地址（如 "https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com"）
        oss_access_key_id: AccessKeyId
        x_oss_object_acl: "private"（policy conditions 强制要求）
        x_oss_forbid_overwrite: "true"（policy conditions 强制要求）
        max_file_size_mb: 单文件上限（实测 1024MB）

    OSS Post Object 协议要求：form fields 必须包含 policy conditions 里声明的所有字段，
    否则 OSS 返回 403。所以 x_oss_object_acl / x_oss_forbid_overwrite 必须回传。
    """
    upload_host = policy.get("upload_host") or policy.get("host")
    if not upload_host:
        raise RuntimeError(
            f"上传凭证缺少 upload_host 字段。请把以下内容反馈给开发者：\n"
            f"{json.dumps(policy, ensure_ascii=False, indent=2)}"
        )

    # upload_host 形如 https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com
    # 解析出 bucket
    host_clean = upload_host.replace("https://", "").replace("http://", "").rstrip("/")
    parts = host_clean.split(".", 2)
    if len(parts) < 3:
        raise RuntimeError(f"无法从 upload_host 解析 bucket: {upload_host}")
    bucket = parts[0]

    upload_dir = policy.get("upload_dir") or policy.get("key_prefix") or policy.get("object_prefix")
    if not upload_dir:
        raise RuntimeError(
            f"上传凭证缺少 upload_dir 字段。请把以下内容反馈给开发者：\n"
            f"{json.dumps(policy, ensure_ascii=False, indent=2)}"
        )

    policy_str = policy.get("policy")
    signature = policy.get("signature")
    access_key_id = policy.get("oss_access_key_id") or policy.get("access_key_id")
    if not all([policy_str, signature, access_key_id]):
        raise RuntimeError(
            f"上传凭证缺少 policy/signature/access_key_id。请把以下内容反馈给开发者：\n"
            f"{json.dumps(policy, ensure_ascii=False, indent=2)}"
        )

    safe_name = Path(file_path).name.replace(" ", "_").replace("\\", "/").split("/")[-1]
    final_key = f"{upload_dir}/{safe_name}"

    # OSS Post Object form fields
    form_fields = {
        "key": final_key,
        "OSSAccessKeyId": access_key_id,
        "policy": policy_str,
        "signature": signature,
        "success_action_status": "200",
    }
    # policy conditions 强制要求的字段（实测必须回传，否则 OSS 返回 AccessDenied）
    if policy.get("x_oss_object_acl"):
        form_fields["x-oss-object-acl"] = policy["x_oss_object_acl"]
    if policy.get("x_oss_forbid_overwrite"):
        form_fields["x-oss-forbid-overwrite"] = policy["x_oss_forbid_overwrite"]

    file_size = Path(file_path).stat().st_size
    max_mb = policy.get("max_file_size_mb", 0)
    if max_mb and file_size > max_mb * 1024 * 1024:
        raise RuntimeError(
            f"文件过大: {file_size/1024/1024:.1f}MB > 上限 {max_mb}MB。"
            f"请缩短音频或自行上传到 OSS 后用 --file-url 传入"
        )

    print(f"[upload] bucket={bucket}, key={final_key}, size={file_size/1024/1024:.1f}MB")

    with open(file_path, "rb") as f:
        files = {"file": (safe_name, f)}
        resp = requests.post(upload_host, data=form_fields, files=files, timeout=600)

    if resp.status_code != 200:
        raise RuntimeError(f"OSS 上传失败 (HTTP {resp.status_code}): {resp.text[:500]}")

    # oss:// URL 不含 bucket 前缀（文档示例：f"oss://{key}"）
    # filetrans 配合 X-DashScope-OssResourceResolve Header 能解析这个格式
    return f"oss://{final_key}"


def submit_filetrans(base_url: str, api_key: str, file_url: str,
                     language: str | None, enable_words: bool,
                     enable_itn: bool, model: str = FILETRANS_MODEL,
                     enable_speaker: bool = False,
                     vocabulary_id: str | None = None,
                     hotwords: list[str] | None = None,
                     hotword_weight: int = 5,
                     context: list[dict] | None = None,
                     keep_dialect: bool = False) -> str:
    """提交异步 ASR 任务，返回 task_id。"""
    if is_qwen_audio_model(model):
        params: dict = {
            "channel_id": [0],
            "diarization_enabled": enable_speaker,
        }
        if language:
            params["language_hints"] = [language]
        if vocabulary_id:
            params["vocabulary_id"] = vocabulary_id
        if hotwords:
            weight = _validate_hotword_weight(hotword_weight)
            entries, _issues = parse_qwen_audio_hotwords(hotwords, weight)
            params["vocabulary"] = {entry.text: entry.weight for entry in entries}
            if not params["vocabulary"]:
                params.pop("vocabulary")
        # keep_dialect 仅 qwen-audio-3.1-asr-flash-filetrans 支持：
        # false（默认）把方言转写为普通话文本，true 保留方言原文。
        if keep_dialect and is_qwen_audio_31_model(model):
            params["keep_dialect"] = True
        input_payload = {"file_urls": [file_url]}
        if context:
            input_payload["messages"] = context
    elif is_funasr_model(model):
        params: dict = {
            "channel_id": [0],
            "diarization_enabled": enable_speaker,
        }
        if language:
            params["language_hints"] = [language]
        if vocabulary_id:
            params["vocabulary_id"] = vocabulary_id
        input_payload = {"file_urls": [file_url]}
    elif is_qwen3_model(model):
        params = {
            "channel_id": [0],
            "enable_words": enable_words,
            "enable_itn": enable_itn,
        }
        if language:
            params["language"] = language
        input_payload = {"file_url": file_url}
    else:
        raise ValueError(f"不支持的 DashScope filetrans 模型: {model}")

    resp = requests.post(
        f"{base_url}/api/v1/services/audio/asr/transcription",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
            # SDK 不支持 oss://，但 RESTful 加这个 Header 后支持
            "X-DashScope-OssResourceResolve": "enable",
        },
        json={
            "model": model,
            "input": input_payload,
            "parameters": params,
        },
        timeout=30,
    )
    _raise_for_dashscope_status(resp, "提交 ASR 任务")
    body = resp.json()
    output = body.get("output", {})
    task_id = output.get("task_id")
    if not task_id:
        raise RuntimeError(f"提交任务失败: {body}")
    return task_id


def poll_task(base_url: str, api_key: str, task_id: str,
              interval: int, timeout: int,
              model: str = FILETRANS_MODEL,
              on_status=print) -> tuple[str, dict]:
    """轮询任务状态，返回 transcription_url。"""
    url = f"{base_url}/api/v1/tasks/{task_id}"
    deadline = time.monotonic() + max(timeout, 0)
    started_at = time.monotonic()
    last_report_at = started_at
    last_status = ""

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"ASR 任务超时（{timeout}秒），task_id={task_id}")

        resp = requests.get(
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=min(30, max(1, remaining)),
        )
        _raise_for_dashscope_status(resp, "查询 ASR 任务")
        body = resp.json()
        output = body.get("output", {})
        status = str(output.get("task_status", "UNKNOWN")).strip().upper()
        now = time.monotonic()

        if status != last_status:
            on_status(f"[filetrans] 任务状态: {status}")
            last_status = status
            last_report_at = now
        elif now - last_report_at >= POLL_HEARTBEAT_SECONDS:
            elapsed = int(now - started_at)
            on_status(
                f"[filetrans] 任务仍在处理中（状态: {status}，已等待约 {elapsed}s），"
                f"下一次检查约 {max(interval, 0)}s 后。"
            )
            last_report_at = now

        if status in TASK_SUCCESS_STATUSES:
            if uses_file_urls(model):
                results = output.get("results") or []
                result = next(
                    (
                        item for item in results
                        if str(item.get("subtask_status", "SUCCEEDED")).strip().upper()
                        in TASK_SUCCESS_STATUSES
                        and item.get("transcription_url")
                    ),
                    None,
                )
                if result is None:
                    failed = results[0] if results else output
                    code = failed.get("code", "UNKNOWN")
                    message = failed.get("message", "任务成功但音频子任务失败")
                    raise RuntimeError(f"ASR 子任务失败 [{code}]: {message}")
                turl = result.get("transcription_url")
            else:
                result = output.get("result", {})
                turl = result.get("transcription_url")
            if not turl:
                raise RuntimeError(f"任务成功但无 transcription_url: {body}")
            usage = body.get("usage", {})
            return turl, usage
        if status in TASK_FAILURE_STATUSES:
            code = output.get("code", "UNKNOWN")
            msg = output.get("message", "未知错误")
            raise RuntimeError(f"ASR 任务失败 [{code}]: {msg}")
        if status == "UNKNOWN":
            raise RuntimeError(f"任务不存在或已过期: {body}")

        time.sleep(min(max(interval, 0), max(remaining, 0)))


def download_transcription(transcription_url: str) -> dict:
    """下载并解析识别结果 JSON。"""
    resp = requests.get(transcription_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


# ===== filetrans 结果 → 本地版 transcribe() 输出格式 =====


def _emit_sentence_diagnostics(
    missing_range_sentences: int,
    text_mismatch: tuple[int, int] | None,
) -> None:
    """句子级数据不完整时把可读原因写进日志（没有 raw 也能从日志定位）。"""
    if missing_range_sentences:
        print(
            f"[警告] {missing_range_sentences} 个云端句子缺少有效时间范围，"
            "已跳过这些句子，其余句子不受影响。"
        )
    if text_mismatch:
        print(
            "[警告] 云端整段文本与句子拼接不一致"
            f"（text {text_mismatch[0]} 字符 vs 句子拼接 {text_mismatch[1]} 字符），"
            "句子数组可能不完整；已按句子时间码输出，缺失的内容不会有字幕，"
            "可勾选「调试运行」保存原始返回以便排查。"
        )


def parse_transcription_result(result: dict) -> dict:
    """把 filetrans JSON 转成本地版 transcribe() 的输出格式。

    filetrans:
        transcripts[].sentences[].words[] = {begin_time, end_time, text, punctuation}
        (begin_time/end_time 已是毫秒)
    本地版:
        items[] = {text(含标点), start, end}, text(完整文本), language

    关键简化：filetrans 把标点单独放 punctuation 字段，直接拼到 item.text 末尾即可，
    无需本地版的 _align_punctuation() LCS 对齐。
    """
    transcripts = result.get("transcripts", [])
    if not transcripts:
        return {
            "text": "",
            "language": "",
            "items": [],
            "timestamp_granularity": "unknown",
        }

    # 只取第一个音轨（channel_id=0）
    t = transcripts[0]
    all_items: list[dict] = []
    segments: list[dict] = []
    sentence_texts: list[str] = []
    detected_language = normalize_language_code(result.get("language") or result.get("lang"))
    has_word_timestamps = False
    has_fallback_segment = False
    missing_range_sentences = 0
    text_mismatch: tuple[int, int] | None = None

    raw_sentences = t.get("sentences", [])
    raw_sentences = raw_sentences if isinstance(raw_sentences, list) else []
    for sent in raw_sentences:
        if not isinstance(sent, dict):
            continue
        if not detected_language and sent.get("language"):
            detected_language = normalize_language_code(sent["language"])

        words = sent.get("words") or []
        words = words if isinstance(words, list) else []
        segment_items: list[dict] = []
        raw_word_texts: list[str] = []
        invalid_word_timestamp = False
        for word in words:
            if not isinstance(word, dict):
                invalid_word_timestamp = True
                continue
            word_text = str(word.get("text") or "")
            punctuation = str(word.get("punctuation") or "")
            item_text = word_text + punctuation
            if not item_text:
                continue
            raw_word_texts.append(item_text)
            timestamp = normalize_timestamp_range(
                word.get("begin_time"), word.get("end_time")
            )
            if timestamp is None:
                timestamp = _zero_duration_range(
                    word.get("begin_time"), word.get("end_time")
                )
            if timestamp is None:
                invalid_word_timestamp = True
                continue
            segment_items.append({
                "text": item_text,
                "start": timestamp[0],
                "end": timestamp[1],
            })

        valid_item_range = (
            min(item["start"] for item in segment_items),
            max(item["end"] for item in segment_items),
        ) if segment_items else None

        # A partial word list is not safe to flatten: the missing token may be
        # in the middle of the sentence. Keep the complete sentence text and
        # use only the sentence range when it is valid.
        segment_text = str(sent.get("text") or "".join(raw_word_texts))
        if (
            segment_items
            and not invalid_word_timestamp
            and not timestamp_items_cover_text(segment_text, segment_items)
        ):
            invalid_word_timestamp = True
        if invalid_word_timestamp:
            segment_items = []
            has_fallback_segment = True
        elif segment_items:
            has_word_timestamps = True
            all_items.extend(segment_items)
        else:
            has_fallback_segment = True

        if segment_text.strip():
            sentence_texts.append(segment_text)

        sentence_range = normalize_timestamp_range(
            sent.get("begin_time"), sent.get("end_time")
        )
        if sentence_range is None:
            sentence_range = _zero_duration_range(
                sent.get("begin_time"), sent.get("end_time")
            )
        if sentence_range is None and valid_item_range is not None:
            # Even when one word is malformed, the valid word envelope is a
            # useful conservative sentence range.  Never expose those words
            # as precise items in that case; the sentence text remains intact.
            sentence_range = valid_item_range
        elif sentence_range is not None and valid_item_range is not None:
            # Some gateways report a rounded sentence range that is narrower
            # than one of its word ranges.  The enclosing range must contain
            # every item before callers use it as a coarse fallback.
            sentence_range = (
                min(sentence_range[0], valid_item_range[0]),
                max(sentence_range[1], valid_item_range[1]),
            )
        if sentence_range is None or not segment_text.strip():
            if segment_text.strip():
                missing_range_sentences += 1
            continue
        segment = {
            "start": sentence_range[0],
            "end": sentence_range[1],
            "text": segment_text.strip(),
        }
        if segment_items and not invalid_word_timestamp:
            segment["items"] = [dict(item) for item in segment_items]
        segments.append(segment)

    text = str(t.get("text") or "")
    if not text:
        # Some compatible filetrans responses omit the transcript-level text
        # while keeping sentence text.  Do not reject an otherwise usable
        # timestamped response just because this redundant field is absent.
        text = "".join(sentence_texts)
    plain_text = _re.sub(r"\s+", "", text)
    plain_joined = _re.sub(r"\s+", "", "".join(sentence_texts))
    if text and sentence_texts and plain_text != plain_joined:
        # 云端整段文本与句子拼接不一致说明句子数组可能不完整（漏句）。保留
        # 有效句子的时间码并提示缺漏，比把整份时间码废弃成整段单条字幕
        # （1.6.x 之前的行为）诚实得多：坏句子不该废掉全部好句子。
        text_mismatch = (len(plain_text), len(plain_joined))
    _emit_sentence_diagnostics(missing_range_sentences, text_mismatch)
    return {
        "text": text,
        "language": detected_language,
        "items": all_items,
        "segments": segments if has_fallback_segment else [],
        "timestamp_granularity": (
            "word" if has_word_timestamps and not has_fallback_segment
            else "segment" if segments
            else "unknown"
        ),
    }


def parse_funasr_transcription_result(result: dict) -> dict:
    """把 Fun-ASR/Qwen-Audio 的句级结果映射为 MAW items 和句子组。"""
    transcripts = result.get("transcripts", [])
    if not transcripts:
        return {
            "text": "",
            "language": "",
            "items": [],
            "sentences": [],
            "timestamp_granularity": "unknown",
        }

    transcript = transcripts[0]
    all_items: list[dict] = []
    parsed_sentences: list[dict] = []
    sentence_texts: list[str] = []
    detected_language = normalize_language_code(result.get("language") or result.get("lang"))
    has_word_timestamps = False
    has_fallback_sentence = False
    missing_range_sentences = 0
    text_mismatch: tuple[int, int] | None = None
    raw_sentences = transcript.get("sentences", [])
    raw_sentences = raw_sentences if isinstance(raw_sentences, list) else []
    for sentence in raw_sentences:
        if not isinstance(sentence, dict):
            continue
        if not detected_language and sentence.get("language"):
            detected_language = normalize_language_code(sentence["language"])
        speaker_id = sentence.get("speaker_id")
        speaker = str(speaker_id) if speaker_id is not None else None
        words = sentence.get("words") or []
        words = words if isinstance(words, list) else []
        raw_items: list[dict] = []
        raw_word_texts: list[str] = []
        invalid_word_timestamp = False
        for word in words:
            if not isinstance(word, dict):
                invalid_word_timestamp = True
                continue
            item_text = str(word.get("text") or "") + str(word.get("punctuation") or "")
            if not item_text:
                continue
            raw_word_texts.append(item_text)
            timestamp = normalize_timestamp_range(
                word.get("begin_time"), word.get("end_time")
            )
            if timestamp is None:
                timestamp = _zero_duration_range(
                    word.get("begin_time"), word.get("end_time")
                )
            if timestamp is None:
                invalid_word_timestamp = True
                continue
            item: dict[str, object] = {
                "text": item_text,
                "start": timestamp[0],
                "end": timestamp[1],
            }
            if speaker is not None:
                item["speaker"] = speaker
            raw_items.append(item)

        sentence_text = str(sentence.get("text") or "".join(raw_word_texts))

        # Qwen-Audio commonly returns one phrase in ``words``. Treat a single
        # phrase as the sentence span it is, not as a word sequence. A partial
        # list is also sentence-level because its missing boundary is unknown.
        sentence_items = (
            raw_items
            if raw_items and len(raw_items) > 1 and not invalid_word_timestamp
            else []
        )
        if sentence_items and not timestamp_items_cover_text(sentence_text, sentence_items):
            sentence_items = []
            invalid_word_timestamp = True
        if sentence_items:
            has_word_timestamps = True
            all_items.extend(sentence_items)
        else:
            has_fallback_sentence = True

        if sentence_text.strip():
            sentence_texts.append(sentence_text)

        valid_item_range = (
            min(item["start"] for item in raw_items),
            max(item["end"] for item in raw_items),
        ) if raw_items else None
        sentence_range = normalize_timestamp_range(
            sentence.get("begin_time"), sentence.get("end_time")
        )
        if sentence_range is None:
            sentence_range = _zero_duration_range(
                sentence.get("begin_time"), sentence.get("end_time")
            )
        if sentence_range is None and valid_item_range is not None:
            # A malformed word list still has usable outer bounds in some
            # responses.  Keep the sentence as coarse, never partial words.
            sentence_range = valid_item_range
        elif sentence_range is not None and valid_item_range is not None:
            # Keep the sentence envelope valid even when the provider's outer
            # range is rounded inward relative to its word timestamps.
            sentence_range = (
                min(sentence_range[0], valid_item_range[0]),
                max(sentence_range[1], valid_item_range[1]),
            )
        if sentence_range is None or not sentence_text.strip():
            if sentence_text.strip():
                missing_range_sentences += 1
            continue
        parsed_sentence: dict[str, object] = {
            "text": sentence_text.strip(),
            "start": sentence_range[0],
            "end": sentence_range[1],
        }
        if sentence_items:
            parsed_sentence["items"] = [dict(item) for item in sentence_items]
        if speaker is not None:
            parsed_sentence["speaker"] = speaker
        parsed_sentences.append(parsed_sentence)

    text = str(transcript.get("text") or "")
    if not text:
        # Fun-ASR variants may only expose text on sentence entries.
        text = "".join(sentence_texts)
    plain_text = _re.sub(r"\s+", "", text)
    plain_joined = _re.sub(r"\s+", "", "".join(sentence_texts))
    if text and sentence_texts and plain_text != plain_joined:
        # 与 parse_transcription_result 同策略：坏句子不该废掉全部好句子，
        # 保留有效句子的时间码并把缺漏写进日志。
        text_mismatch = (len(plain_text), len(plain_joined))
    _emit_sentence_diagnostics(missing_range_sentences, text_mismatch)
    return {
        "text": text,
        "language": detected_language,
        "items": all_items,
        "sentences": parsed_sentences,
        "timestamp_granularity": (
            "word" if has_word_timestamps and not has_fallback_sentence
            else "segment" if parsed_sentences
            else "unknown"
        ),
    }


# ===== 顶层转写入口 =====

def _configured_vocabulary_id(model: str, config: dict) -> str:
    if is_qwen_audio_model(model):
        return str(config.get("qwen_audio_vocabulary_id") or "").strip()
    if is_funasr_model(model):
        return str(config.get("funasr_vocabulary_id") or "").strip()
    return ""


def transcribe(audio_path: str, language: str | None, hotwords: list[str],
               config: dict, file_url_override: str | None = None,
               model: str = FILETRANS_MODEL,
               enable_speaker: bool = False,
               vocabulary_id: str | None = None,
               context_text: str | None = None,
               hotword_weight: int | None = None,
               keep_dialect: bool = False,
               capture_raw: bool = False) -> dict:
    """调 DashScope filetrans API 做转录。

    返回可由本项目编辑器读取的工程数据：
        {"text": str, "language": str, "items": [{"text", "start", "end"}, ...]}
    """
    base_url = config["base_url"]
    api_key = config["api_key"]
    if not api_key:
        raise SystemExit(
            "[错误] 未配置 DASHSCOPE_API_KEY。请在 .env 文件填入（参考 .env.example），\n"
            "       或设置系统环境变量 DASHSCOPE_API_KEY。\n"
            "       获取或查看 API Key：https://platform.qianwenai.com/home/"
        )

    print(f"[准备] 开始云端转写（模型: {model}）")

    resolved_vocabulary_id = (vocabulary_id or _configured_vocabulary_id(model, config)).strip()
    resolved_hotword_weight = hotword_weight
    if resolved_hotword_weight is None:
        resolved_hotword_weight = int(config.get("qwen_audio_hotword_weight", 5))
    context = build_qwen_audio_context(context_text)

    if hotwords:
        if is_qwen_audio_model(model):
            filtered_hotwords, hotword_issues = parse_qwen_audio_hotwords(
                hotwords,
                resolved_hotword_weight,
            )
            for issue in hotword_issues:
                print(
                    f"[热词] 忽略第 {issue.index} 项（{issue.code}）：{issue.text}"
                )
            hotword_count = len(filtered_hotwords)
        else:
            hotword_count = len(hotwords)
        if is_qwen_audio_model(model):
            print(
                f"[热词] 将通过 Qwen-Audio 即时 vocabulary 发送 {hotword_count} 个热词，"
                f"weight={resolved_hotword_weight}。"
            )
        elif is_funasr_model(model):
            print(
                f"[热词] 检测到 {len(hotwords)} 个本地热词。Fun-ASR 仅接受百炼控制台"
                f"预建的 vocabulary_id，当前未发送 hotwords.txt。"
            )
        else:
            print(f"[热词] 检测到 {len(hotwords)} 个热词。注意：filetrans API 暂不支持热词注入，"
                  f"当前模型未发送 hotwords.txt。")
    if context:
        if is_qwen_audio_model(model):
            context_chars = len(context[0]["content"][0]["text"])
            print(f"[上下文] 已启用 Qwen-Audio context（{context_chars} 字符，最多发送 400 字符）。")
        else:
            print("[上下文] 当前模型不支持 Qwen-Audio context，已忽略。")
    if keep_dialect:
        if is_qwen_audio_31_model(model):
            print("[方言] keep_dialect 已启用：保留方言原文，不转写为普通话文本。")
        else:
            print("[方言] 当前模型不支持 keep_dialect，已忽略。")

    # 1) 准备 file_url
    if file_url_override:
        file_url = file_url_override
        print(f"[filetrans] 使用用户提供的 URL: {file_url}")
    else:
        print(f"[upload] 获取上传凭证 ({model})...")
        policy = get_upload_policy(base_url, api_key, model)
        file_url = upload_to_oss(policy, audio_path)
        print(f"[upload] 上传完成: {file_url}")

    # 2) 提交异步任务
    norm_lang = _normalize_language(language) or _normalize_language(config["default_language"])
    if is_qwen_audio_model(model):
        print(
            f"[filetrans] 提交 Qwen-Audio 任务 (language={norm_lang or 'auto'}, "
            f"speaker={'on' if enable_speaker else 'off'})..."
        )
    elif is_funasr_model(model):
        print(
            f"[filetrans] 提交 Fun-ASR 任务 (language={norm_lang or 'auto'}, "
            f"speaker={'on' if enable_speaker else 'off'})..."
        )
    else:
        print(f"[filetrans] 提交 Qwen 任务 (language={norm_lang or 'auto'}, "
              f"enable_words={config['enable_words']})...")
    task_id = submit_filetrans(
        base_url, api_key, file_url,
        language=norm_lang,
        enable_words=config["enable_words"],
        enable_itn=config["enable_itn"],
        model=model,
        enable_speaker=enable_speaker,
        vocabulary_id=resolved_vocabulary_id or None,
        hotwords=hotwords if is_qwen_audio_model(model) else None,
        hotword_weight=resolved_hotword_weight,
        context=context if is_qwen_audio_model(model) else None,
        keep_dialect=keep_dialect,
    )
    print(f"[filetrans] 任务已提交: task_id={task_id}")

    # 3) 轮询
    t0 = time.perf_counter()
    transcription_url, task_usage = poll_task(
        base_url, api_key, task_id,
        interval=config["poll_interval"],
        timeout=config["poll_timeout"],
        model=model,
    )
    elapsed_poll = time.perf_counter() - t0
    if uses_file_urls(model):
        audio_secs = task_usage.get("duration", 0)
        if is_qwen_audio_31_model(model):
            input_tokens = _usage_int(task_usage, "input_tokens")
            output_tokens = _usage_int(task_usage, "output_tokens")
            token_cost = estimate_qwen_audio_31_cost(input_tokens, output_tokens)
            cost_note = f"，约 {token_cost:.4f} 元" if token_cost is not None else ""
            print(
                f"[filetrans] 任务完成，耗时 {elapsed_poll:.1f}s | 计费语音 {audio_secs}s"
                f"（3.1 按 Token：输入 {input_tokens} tok / 输出 {output_tokens} tok{cost_note}）"
            )
        else:
            print(f"[filetrans] 任务完成，耗时 {elapsed_poll:.1f}s | 计费语音 {audio_secs}s")
    else:
        audio_secs = task_usage.get("seconds", 0)
        est_tokens = audio_secs * 25  # 文档：每秒音频 = 25 tokens
        print(f"[filetrans] 任务完成，耗时 {elapsed_poll:.1f}s | "
              f"计费 {audio_secs}s 音频 ≈ {est_tokens} tokens")

    # 4) 下载 + 解析
    print("[filetrans] 正在下载转写结果...")
    raw = download_transcription(transcription_url)
    print("[解析] 正在解析云端返回的词级时间戳...")
    result = parse_funasr_transcription_result(raw) if uses_file_urls(model) else parse_transcription_result(raw)
    if capture_raw:
        result["_raw_response"] = raw
    language_value, language_source = resolve_language(
        result.get("language"),
        norm_lang,
        str(result.get("text") or ""),
    )
    result["language"] = language_value
    result["language_source"] = language_source
    result["split_mode"] = split_mode_for_text(
        str(result.get("text") or ""),
        language_value,
    )
    if result.get("timestamp_granularity") in {None, "unknown"}:
        result["timestamp_granularity"] = timestamp_granularity_for_items(
            result.get("items") or [],
            result["split_mode"],
            has_segments=bool(result.get("sentences")),
        )
    result["usage"] = task_usage
    return result


# ===== main CLI =====

def main():
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(
        description="使用阿里云百炼 Qwen / Qwen-Audio / Fun-ASR API 生成视频字幕（云端版）",
    )
    parser.add_argument("input", help="输入视频或音频文件路径")
    parser.add_argument("-o", "--output", help="输出 SRT 路径（默认与输入同目录）")
    parser.add_argument(
        "-l", "--max-len", type=int, default=18,
        help="每条字幕最大字数（默认 18；仅 CJK 内容生效，空格语言按词数自动处理）",
    )
    parser.add_argument(
        "--min-len", type=int, default=5,
        help="句号间最短字数，不足则合并（默认 5；仅 CJK 内容生效）",
    )
    parser.add_argument(
        "--max-words", type=int, default=WESTERN_MAX_WORDS,
        help=f"英文单条字幕最大单词数（默认 {WESTERN_MAX_WORDS}；仅空格语言生效）",
    )
    parser.add_argument(
        "--min-words", type=int, default=WESTERN_MIN_WORDS,
        help=f"英文短句合并阈值（默认 {WESTERN_MIN_WORDS}；仅空格语言生效）",
    )
    parser.add_argument(
        "--language", default=None,
        help="指定语言（zh/yue/en/ja/ko/de/fr 等，或 Chinese/English，默认自动识别）",
    )
    parser.add_argument(
        "--keep-punct", action="store_true",
        help="保留全部句尾标点，覆盖 --strip-tail-punct 的显式删除设置",
    )
    parser.add_argument(
        "--strip-tail-punct", default=_DEFAULT_STRIP_TAIL_PUNCT,
        help="句尾剥除的标点集合；传空串禁用剥除（默认保留全部标点）",
    )
    parser.add_argument(
        "--extra-strong-punct", default=_DEFAULT_EXTRA_STRONG_PUNCT,
        help="强断句符号集合（与 Launcher 共享断句配置默认清单一致；每个字符并入强断句符号，仅换行始终生效）",
    )
    parser.add_argument(
        "--gap-split", type=int, default=500,
        help="静音切句阈值（毫秒），相邻字停顿超过此值则切句（默认 500）",
    )
    parser.add_argument(
        "--speaker", action="store_true",
        help="Qwen-Audio/Fun-ASR 开启说话人分离，speaker 标签写入工程 JSON",
    )
    parser.add_argument(
        "--speaker-colors", action="store_true",
        help="Qwen-Audio/Fun-ASR 在说话人分离基础上，把不同说话人映射成 5 种字幕颜色",
    )
    parser.add_argument(
        "--json", dest="json_out", action="store_true",
        help="同时输出含字级时间戳的工程文件（默认 .mosp，供 edit.py 加载）",
    )
    parser.add_argument(
        "--with-waveform", action="store_true",
        help="在媒体旁生成 .quapeaks 波形缓存（不再写进工程文件；GUI 转写默认开启）",
    )
    parser.add_argument(
        "--audio-track", type=int, default=0,
        help="使用第几个音频轨道（从 0 开始，默认 0）",
    )
    parser.add_argument("--default-audio-track", type=int, help=argparse.SUPPRESS)
    parser.add_argument(
        "--with-spectral", action="store_true",
        help="在 .ReaPeaks 波形缓存中额外生成频谱数据（需要 --with-waveform）",
    )
    parser.add_argument(
        "-s", "--stickers", default=get_default_sticker_dir(),
        help="表情包文件夹路径，传给 edit.py（默认读 .env 的 STICKER_DIR）",
    )
    parser.add_argument(
        "--no-html", action="store_true",
        help="禁用自动生成 edit HTML（仅 1.x 默认 --json 时会一并生成；2.0 起始终不生成）",
    )
    parser.add_argument(
        "-ll", "--length-limit", type=parse_duration, default=None,
        help="只处理音频前 N 时长，用于测试（示例: 10m, 20s, 1h, 90）",
    )
    parser.add_argument(
        "--file-url", default=None,
        help="直接提供公网/OSS 可访问的音频 URL，跳过本地上传（用于已上传到 OSS 的场景）",
    )
    parser.add_argument(
        "--region", default=None,
        help="覆盖 .env 的 DASHSCOPE_REGION（beijing / singapore）",
    )
    parser.add_argument(
        "--model", default=FILETRANS_MODEL,
        help=f"覆盖 ASR 模型（默认 {FILETRANS_MODEL}；可选 "
             f"{QWEN_AUDIO_31_FILETRANS_MODEL} / {QWEN_AUDIO_FILETRANS_MODEL} / {FUNASR_MODEL}）",
    )
    parser.add_argument(
        "--vocabulary-id", default=None,
        help="覆盖当前模型的百炼预编译 vocabulary_id（也可在 .env 配置）",
    )
    parser.add_argument(
        "--hotword", action="append", default=None,
        help="追加一个 Qwen-Audio 即时热词；可重复传入，与 hotwords.txt 合并",
    )
    parser.add_argument(
        "--hotword-file", default=None,
        help="使用指定 UTF-8 文本文件作为 Qwen-Audio 即时热词来源，替代默认 hotwords.txt",
    )
    parser.add_argument(
        "--hotword-weight", type=parse_hotword_weight, default=None,
        help="Qwen-Audio hotwords.txt 的即时热词权重（1-5 或 50；默认读 .env 的 5）",
    )
    parser.add_argument(
        "--context", default=None,
        help="Qwen-Audio context 领域词表/前文；最多发送 400 字符",
    )
    parser.add_argument(
        "--context-file", default=None,
        help="从 UTF-8 文件读取 Qwen-Audio context（与 --context 二选一）",
    )
    parser.add_argument(
        "--keep-dialect", action="store_true",
        help="保留方言表达，不转写为普通话文本（仅 qwen-audio-3.1-asr-flash-filetrans 支持）",
    )
    parser.add_argument(
        "--debug", action="store_true",
        help="输出 API 原始结果用于调试",
    )
    parser.add_argument(
        "--debug-raw", action="store_true",
        help="保存 ASR 服务端返回的完整原始 JSON，用于排查断句、标点和时间码",
    )
    parser.add_argument(
        "--no-model-tag", action="store_true",
        help="默认输出文件名不附加模型标识段（默认附加，如 qwen3-asr-api）",
    )
    args = parser.parse_args()
    if args.audio_track < 0:
        parser.error("--audio-track 必须是非负整数")
    if args.default_audio_track is not None and args.default_audio_track < 0:
        parser.error("--default-audio-track 必须是非负整数")
    if args.with_spectral and not args.with_waveform:
        parser.error("--with-spectral 需要同时指定 --with-waveform")
    if args.max_len < 1 or args.min_len < 1 or args.max_words < 1 or args.min_words < 1 or args.gap_split < 0:
        parser.error("字幕切分参数无效")
    if args.max_len < args.min_len or args.max_words < args.min_words:
        parser.error("最大值不能小于对应的短句合并阈值")
    enable_speaker = args.speaker or args.speaker_colors
    if enable_speaker and not supports_speaker_diarization(args.model):
        parser.error("--speaker / --speaker-colors 仅适用于 Qwen-Audio 或 Fun-ASR 模型")
    if args.context is not None and args.context_file:
        parser.error("--context 与 --context-file 只能二选一")
    if args.keep_dialect and not is_qwen_audio_31_model(args.model):
        parser.error("--keep-dialect 仅适用于 qwen-audio-3.1-asr-flash-filetrans")
    configure_extra_strong_punct(args.extra_strong_punct)

    input_path = Path(args.input)
    if not input_path.exists() and not args.file_url:
        print(f"错误: 文件不存在 - {input_path}", file=sys.stderr)
        raise SystemExit(1)

    if args.output:
        output_path = Path(args.output)
    else:
        output_path = input_path.with_suffix(".srt")

    # 读配置（CLI args 覆盖 .env）
    config = _get_config()
    ffmpeg_tools = resolve_ffmpeg_tools(configured_path=config.get("ffmpeg_path"))
    ffmpeg_path = ffmpeg_tools.ffmpeg
    ffprobe_path = ffmpeg_tools.ffprobe
    default_audio_track = resolve_default_audio_track(
        input_path,
        args.default_audio_track,
        ffprobe_path=ffprobe_path,
    )
    print(f"[准备] 已载入转写配置（模型: {args.model}）")
    if args.region:
        config["region"] = args.region.lower()
        config["base_url"] = _compute_base_url(config["region"], config["workspace_id"])

    try:
        print("[准备] 正在读取上下文和热词配置...")
        context_text = args.context
        if context_text is None:
            context_text = load_context_file(args.context_file or config["qwen_audio_context_file"])
    except (OSError, UnicodeError) as exc:
        parser.error(str(exc))

    video_exts = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"}
    is_video = input_path.suffix.lower() in video_exts

    try:
        hotwords = load_hotwords(args.hotword_file)
    except (OSError, UnicodeError) as exc:
        parser.error(str(exc))
    for hotword in args.hotword or []:
        normalized = hotword.strip()
        if normalized and normalized not in hotwords:
            hotwords.append(normalized)

    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"[媒体] 正在准备输入媒体: {input_path.name}")
        if args.file_url:
            audio_path = ""  # 不需要本地文件
            duration = 0.0
        else:
            if is_video:
                audio_path = str(Path(tmpdir) / "audio.wav")
                print("[媒体] 正在读取原始视频时长...")
                source_duration = get_duration_sec(
                    str(input_path),
                    ffprobe_path=ffprobe_path,
                )
                video_limit = args.length_limit if args.length_limit and args.length_limit < source_duration else None
                extract_audio(
                    str(input_path),
                    audio_path,
                    duration_limit=video_limit,
                    ffmpeg_path=ffmpeg_path,
                    audio_track=args.audio_track,
                )
                print("[媒体] 正在读取提取后音频时长...")
                duration = get_duration_sec(audio_path, ffprobe_path=ffprobe_path)
                if video_limit is not None:
                    lm, ls = divmod(int(video_limit), 60)
                    print(f"[info] 测试模式：从视频直接提取前 {lm}分{ls}秒，跳过其余内容")
            else:
                # 复制到 tmpdir 统一处理（避免 length_limit 改原文件）
                audio_path = str(Path(tmpdir) / input_path.name)
                print("[媒体] 正在复制音频到临时工作目录...")
                shutil.copy2(input_path, audio_path)

            if not is_video:
                print("[媒体] 正在读取音频时长...")
                duration = get_duration_sec(audio_path, ffprobe_path=ffprobe_path)
            m, s = divmod(int(duration), 60)
            print(f"[info] 音频总时长: {m}分{s}秒")
            if enable_speaker and duration > 2 * 60 * 60:
                print(
                    "[警告] Qwen-Audio/Fun-ASR 官方建议说话人分离音频不超过 2 小时；"
                    "当前任务可能失败或超时。"
                )

            if args.length_limit and args.length_limit < duration:
                limit_sec = args.length_limit
                limited_path = str(Path(tmpdir) / "audio_limited.wav")
                print("[ffmpeg] 正在为测试模式截取并重新采样音频...")
                cmd = [
                    _resolve_media_tool("ffmpeg", ffmpeg_path), "-i", audio_path,
                    "-t", str(limit_sec),
                    "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
                    "-y", limited_path,
                ]
                _run_media_tool(cmd, check=True, capture_output=True)
                audio_path = limited_path
                duration = limit_sec
                lm, ls = divmod(int(limit_sec), 60)
                print(f"[info] 已截取前 {lm}分{ls}秒用于测试")

        print("[filetrans] 本地媒体准备完成，开始连接云端...")
        print(f"转写开始: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        t0 = time.perf_counter()
        result = transcribe(
            audio_path, args.language, hotwords, config,
            file_url_override=args.file_url,
            model=args.model,
            enable_speaker=enable_speaker,
            vocabulary_id=args.vocabulary_id,
            context_text=context_text,
            hotword_weight=args.hotword_weight,
            keep_dialect=args.keep_dialect,
            capture_raw=args.debug_raw,
        )
        elapsed = time.perf_counter() - t0
        print(f"转写结束: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

        raw_response = result.pop("_raw_response", None)
        if not result or not result.get("text"):
            print("错误: 未识别到任何内容", file=sys.stderr)
            raise SystemExit(2)

        print(f"[解析] 云端结果已返回，包含 {len(result.get('items', []))} 个时间戳项。")
        print(f"[info] 检测语言: {result.get('language', 'unknown')}")

        if args.debug:
            print("\n--- debug ---")
            print(f"text: {result['text'][:200]}...")
            print(f"items count: {len(result['items'])}")
            print(f"first 5 items: {result['items'][:5]}")
            print("--- end debug ---\n")

        items = result["items"]
        api_sentences = result.get("sentences") if uses_file_urls(args.model) else None
        if api_sentences:
            print("[解析] 正在按云端句子边界整理字幕...")
            split_mode = split_mode_for_text(result.get("text", ""), result.get("language"))
            segments = build_segments_from_api_sentences(
                api_sentences,
                max_len=args.max_len,
                min_len=args.min_len,
                gap_split_ms=args.gap_split,
                max_words=args.max_words,
                min_words=args.min_words,
                split_mode=split_mode,
            )
            print(f"[解析] 字幕整理完成：{len(segments)} 条（保留云端句子边界）。")
        elif result.get("timestamp_granularity") == "segment" and result.get("segments"):
            print("[解析] 云端未返回完整词级时间码，保留服务端段边界并对超长段二次拆分...")
            split_mode = split_mode_for_text(result.get("text", ""), result.get("language"))
            coarse_segments = repair_nonpositive_duration_segments([
                dict(segment) for segment in result["segments"]
            ])
            interpolated_boundary_indices: set[int] = set()
            segments = split_coarse_segments(
                coarse_segments,
                max_len=args.max_len,
                min_len=args.min_len,
                gap_split_ms=args.gap_split,
                max_words=args.max_words,
                min_words=args.min_words,
                split_mode=split_mode,
                interpolated_boundary_indices=interpolated_boundary_indices,
            )
            if audio_path and Path(audio_path).is_file():
                snapped = snap_cue_boundaries(segments, audio_path, boundary_indices=interpolated_boundary_indices)
                if snapped:
                    print(f"[输出] 已将 {snapped} 个插值切点吸附到语音能量谷")
            print(f"[解析] 字幕整理完成：{len(segments)} 条（保留云端句子边界）。")
        elif not items:
            print("[警告] 未获得时间戳，输出整段为单条字幕")
            segments = repair_nonpositive_duration_segments(
                [{"start": 0, "end": int(duration * 1000), "text": result["text"]}]
            )
        else:
            print("[解析] 正在按停顿和字数整理字幕（中文首次运行可能加载 jieba 词典）...")
            split_mode = split_mode_for_text(result.get("text", ""), result.get("language"))
            segments = build_segments_preserving_speakers(
                items, max_len=args.max_len, min_len=args.min_len,
                gap_split_ms=args.gap_split,
                max_words=args.max_words,
                min_words=args.min_words,
                split_mode=split_mode,
            )
            print(f"[解析] 字幕整理完成：{len(segments)} 条。")

        original_segment_count = len(segments)
        segments = [segment for segment in segments if str(segment.get("text") or "").strip()]
        removed_blank_count = original_segment_count - len(segments)
        if removed_blank_count:
            print(f"[警告] 已过滤 {removed_blank_count} 条空白识别结果")

        # 兜底：上游可能返回 0 长（甚至倒挂）的词/段时间码，
        # 拉齐到至少 100ms，避免拆分后看不见字幕块、工程无法保存。
        print("[解析] 正在校验和修复时间码...")
        repaired_count = repair_segment_durations(segments)
        if repaired_count:
            print(f"[info] 已兜底修复 {repaired_count} 处 0 长/倒挂时间码（保底 100ms）")

        # 媒体缓存必须在临时目录清理前生成：audio_path 指向 tmpdir 内的
        # 提取音频，with 块结束后文件即被删除。先暂存结果，待 segments
        # 后处理完成、写出工程时再合并（合并键见 media_cache.CACHE_KEYS）。
        cache_result = None
        if args.json_out and args.with_waveform:
            cache_result = embed_media_caches(
                {"media": str(input_path)},
                Path(audio_path) if audio_path else input_path,
                source_media_path=input_path,
                generate_spectral=args.with_spectral,
                ffmpeg_bin=str(ffmpeg_path) if ffmpeg_path is not None else None,
                audio_track=args.audio_track if is_video else 0,
                default_audio_track=default_audio_track,
            )

    if enable_speaker:
        speakers = sorted({str(seg["speaker"]) for seg in segments if seg.get("speaker") is not None})
        print(f"[speaker] 识别到 {len(speakers)} 个说话人: {', '.join(speakers)}")
        if args.speaker_colors:
            stats = speaker_color_summary(segments)
            print(f"[speaker] 已为 {stats['colored_segments']} 条字幕写入颜色快照")
            if stats["overflow"]:
                print("[警告] 说话人超过 5 个，颜色已循环复用，请在编辑器中手动调整")

    # 剥句末标点（与本地版一致；--keep-punct 优先，空集合禁用）
    if not args.keep_punct and args.strip_tail_punct:
        for seg in segments:
            seg["text"] = seg["text"].rstrip(args.strip_tail_punct)
            seg_items = seg.get("items")
            if seg_items:
                k = len(seg_items) - 1
                while k >= 0:
                    seg_items[k]["text"] = seg_items[k]["text"].rstrip(args.strip_tail_punct)
                    if seg_items[k]["text"]:
                        break
                    seg_items.pop(k)
                    k -= 1

    print(f"[输出] 正在生成 SRT（{len(segments)} 条字幕）...")
    srt_content = generate_srt(segments)

    if duration > 0:
        rtf = elapsed / duration
        speed = (1 / rtf) if rtf > 0 else 0
    else:
        rtf = 0
        speed = 0
    if not args.output:
        ts_prefix = f"[{datetime.now().strftime('%y%m%d%H%M')}]"
        name_parts = []
        if not args.no_model_tag:
            model_tag = (
                "fun-asr" if is_funasr_model(args.model)
                else "qwen-audio-3.1-asr-api" if is_qwen_audio_31_model(args.model)
                else "qwen-audio-asr-api" if is_qwen_audio_model(args.model)
                else "qwen3-asr-api"
            )
            name_parts.append(model_tag)
        suffix = f".{'.'.join(name_parts)}" if name_parts else ""
        output_path = output_path.with_name(
            f"{ts_prefix}{output_path.stem}{suffix}.srt"
        )

    output_path.write_text(srt_content, encoding="utf-8")
    print(f"\n字幕已保存到: {output_path}")
    print(f"共 {len(segments)} 条字幕")
    if args.debug_raw:
        if raw_response is None:
            raise RuntimeError("调试模式未获得 ASR 原始返回数据")
        raw_path = debug_artifact_path(
            input_path,
            output_path,
            ".asr-response.json",
            explicit_output=bool(args.output),
        )
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        with raw_path.open("w", encoding="utf-8", newline="\n") as raw_file:
            json.dump(raw_response, raw_file, ensure_ascii=False, indent=2)
            raw_file.write("\n")
        print(f"[调试] ASR 原始返回已保存到: {raw_path}")
    print(f"转写耗时: {format_elapsed(elapsed)}")
    if duration > 0:
        print(f"媒体时长: {format_elapsed(duration)}")
        print(f"转写时长为媒体时长的 {rtf:.2f} 倍")
        print(f"实际 RTF: {rtf:.3f} ({speed:.1f}x 实时)")
        if is_qwen_audio_31_model(args.model):
            usage_stats = result.get("usage") if isinstance(result, dict) else None
            input_tokens = _usage_int(usage_stats or {}, "input_tokens")
            output_tokens = _usage_int(usage_stats or {}, "output_tokens")
            token_cost = (
                estimate_qwen_audio_31_cost(input_tokens, output_tokens)
                if input_tokens or output_tokens else None
            )
            if token_cost is not None:
                print(
                    f"预计费用: 约 {token_cost:.4f} 元（按 Token：输入 {input_tokens} tok × "
                    f"{DASHSCOPE_QWEN_AUDIO_31_INPUT_PRICE_PER_MILLION_TOKENS} 元/百万 + "
                    f"输出 {output_tokens} tok × "
                    f"{DASHSCOPE_QWEN_AUDIO_31_OUTPUT_PRICE_PER_MILLION_TOKENS} 元/百万）"
                )
            else:
                print("预计费用: 按 Token 计费（北京 输入 ¥0.8 / 百万 Token、输出 ¥2.7 / 百万 Token），以百炼账单为准")
        else:
            cost = estimate_dashscope_cost(duration)
            if cost is not None:
                print(
                    f"预计费用: 约 {cost:.2f} 元"
                    f"（{DASHSCOPE_PRICE_PER_SECOND} 元/秒 × {duration:.1f} 秒）"
                )

    if args.json_out:
        json_path = output_path.with_suffix(".mosp")
        json_data = make_project(
            [
                {
                    "start": seg["start"],
                    "end": seg["end"],
                    "text": seg["text"],
                    **({"items": seg["items"]} if "items" in seg else {}),
                    **({"speaker": seg["speaker"]} if seg.get("speaker") is not None else {}),
                }
                for seg in segments
            ],
            main_fields={
                'language': normalize_language_code(result.get('language')),
                'language_source': result.get('language_source', 'unknown'),
                'split_mode': result.get('split_mode') or split_mode_for_text(str(result.get('text') or ''), result.get('language')),
                'timestamp_granularity': result.get('timestamp_granularity') or timestamp_granularity_for_items(result.get('items') or [], result.get('split_mode') or 'word', has_segments=bool(segments)),
                'model': args.model if is_funasr_model(args.model) else 'qwen-audio-3.1-asr-api' if is_qwen_audio_31_model(args.model) else 'qwen-audio-asr-api' if is_qwen_audio_model(args.model) else 'qwen3-asr-api',
            },
            project_fields={
                'media': str(input_path),
            },
        )
        if args.speaker_colors:
            apply_project_speaker_colors(json_data)
        if cache_result is not None:
            json_data = merge_media_caches(json_data, cache_result)
        print("[输出] 正在写入工程文件...")
        write_mosp(
            json_path,
            json_data,
            media_path=input_path,
            ffprobe_path=ffprobe_path,
            selected_audio_track=args.audio_track if is_video else 0,
        )
        print(f"工程文件已保存到: {json_path}")

        if should_generate_standalone_editor(not args.no_html):
            edit_script = Path(__file__).resolve().parents[2] / "edit.py"
            if not edit_script.exists():
                print("[警告] 找不到 edit.py，跳过 HTML 生成")
            else:
                cmd = [sys.executable, str(edit_script), str(json_path)]
                if args.stickers:
                    sticker_dir = Path(args.stickers)
                    if sticker_dir.exists():
                        cmd += ["-s", str(sticker_dir)]
                    else:
                        print(f"[提示] 表情包目录不存在，跳过：{sticker_dir}")
                print(f"[edit] 生成 HTML: {' '.join(cmd[1:])}")
                try:
                    subprocess.run(cmd, check=True)
                except subprocess.CalledProcessError as e:
                    print(f"[警告] edit.py 失败 (exit {e.returncode})")

    maw_stat = format_maw_stat(rtf)
    if maw_stat:
        print(maw_stat)


if __name__ == "__main__":
    main()
