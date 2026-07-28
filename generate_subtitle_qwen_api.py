# pyright: reportAny=false, reportAttributeAccessIssue=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportMissingTypeStubs=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedVariable=false, reportImplicitStringConcatenation=false, reportArgumentType=false, reportIndexIssue=false

"""使用阿里云 qwen3-asr-flash-filetrans API 生成视频字幕（云端版）。

特点：
- 无需 GPU、模型权重，只调 API（DASHSCOPE_API_KEY）
- 走 filetrans 异步模式，原生支持字级时间戳，最长 12 小时音频
- 文件自动上传到 DashScope 临时 OSS（oss:// URL，48 小时有效）
- 全程 RESTful API（不用 SDK，因为 SDK 不支持 oss:// 给 filetrans）
- 标点由 API 的 words[].punctuation 字段直接给出，跳过本地 LCS 对齐算法

输出为通用的 JSON 工程格式（items/text/language），可直接交给 edit.py 编辑。
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

from edit import get_default_sticker_dir


# ===== 路径与常量 =====

HOTWORDS_FILE = Path(__file__).parent / "hotwords.txt"
ENV_FILE = Path(__file__).parent / ".env"

FILETRANS_MODEL = "qwen3-asr-flash-filetrans"

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
        "poll_interval": int(pick("DASHSCOPE_POLL_INTERVAL", "5") or "5"),
        "poll_timeout": int(pick("DASHSCOPE_POLL_TIMEOUT", "1800") or "1800"),
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
    return "https://dashscope.aliyuncs.com"


def _normalize_language(lang: str | None) -> str | None:
    """把 'Chinese'/'中文' 等友好名映射成 DashScope 的 'zh' 代码。"""
    if not lang:
        return None
    key = lang.strip().lower()
    return LANGUAGE_MAP.get(key, key)


# ===== ffmpeg 工具函数（与本地版一致） =====

def extract_audio(video_path: str, output_path: str) -> None:
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vn", "-acodec", "pcm_s16le",
        "-ar", "16000", "-ac", "1",
        "-y", output_path,
    ]
    print(f"[ffmpeg] 正在提取音频: {video_path}")
    subprocess.run(cmd, check=True, capture_output=True)
    print("[ffmpeg] 音频提取完成")


def get_duration_sec(filepath: str) -> float:
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "csv=p=0", filepath,
    ]
    out = subprocess.run(cmd, check=True, capture_output=True, text=True)
    return float(out.stdout.strip())


def parse_duration(value: str) -> float:
    """解析时长字符串，支持 h/m/s 后缀。"""
    value = value.strip().lower()
    m = _re.fullmatch(r'([\d.]+)\s*(h|m|s)?', value)
    if not m:
        raise argparse.ArgumentTypeError(f"无法解析时长: '{value}'，示例: 10m, 20s, 1h, 90")
    num = float(m.group(1))
    unit = m.group(2)
    if unit == 'h':
        return num * 3600
    elif unit == 'm':
        return num * 60
    return num


# 兼容旧私有名（generate_subtitle_soniox_api.py 等复用方请用 parse_duration）
_parse_duration = parse_duration


def load_hotwords() -> list[str]:
    """从 hotwords.txt 读取热词列表，忽略注释行和空行。"""
    if not HOTWORDS_FILE.exists():
        return []
    words = []
    for line in HOTWORDS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            words.append(line)
    return words


# ===== SRT / 时间戳工具（与本地版一致） =====

def format_timestamp(ms: int) -> str:
    h = ms // 3_600_000
    ms %= 3_600_000
    m = ms // 60_000
    ms %= 60_000
    s = ms // 1_000
    ms %= 1_000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def generate_srt(segments: list[dict]) -> str:
    lines = []
    for i, seg in enumerate(segments, 1):
        start = format_timestamp(seg["start"])
        end = format_timestamp(seg["end"])
        text = seg["text"].strip()
        lines.append(f"{i}\n{start} --> {end}\n{text}\n")
    return "\n".join(lines)


# ===== 切句逻辑（与本地版 _split_words_to_segments 一致，纯 Python 复制） =====

def _split_by_silence(items: list[dict], min_gap_ms: int) -> list[list[dict]]:
    """按相邻 item 之间的静音间隔切分。"""
    if not items or min_gap_ms <= 0:
        return [items] if items else []
    groups: list[list[dict]] = []
    cur: list[dict] = [items[0]]
    for prev, nxt in zip(items, items[1:]):
        gap = nxt["start"] - prev["end"]
        if gap >= min_gap_ms:
            groups.append(cur)
            cur = []
        cur.append(nxt)
    if cur:
        groups.append(cur)
    return groups


def _split_long_group(items: list[dict], max_len: int, weak_punct: set) -> list[list[dict]]:
    text_total = "".join(it["text"] for it in items)
    if len(text_total) <= max_len:
        return [items]

    # 优先按弱标点拆
    cum_len = 0
    punct_idx = None
    for i, it in enumerate(items):
        cum_len += len(it["text"])
        if cum_len > max_len:
            break
        if any(c in weak_punct for c in it["text"]):
            punct_idx = i + 1

    if punct_idx is not None and punct_idx < len(items):
        return _split_long_group(items[:punct_idx], max_len, weak_punct) + \
               _split_long_group(items[punct_idx:], max_len, weak_punct)

    # 用 jieba 分词找断点
    try:
        import jieba
        words = list(jieba.cut(text_total))
    except ImportError:
        words = list(text_total)  # 无 jieba 则按字硬切
    boundaries = []
    pos = 0
    for w in words:
        pos += len(w)
        boundaries.append(pos)

    best_char_pos = None
    for b in boundaries:
        if 0 < b <= max_len:
            if best_char_pos is None or abs(b - max_len) < abs(best_char_pos - max_len):
                best_char_pos = b

    if best_char_pos is not None and best_char_pos < len(text_total):
        cum_len = 0
        split_idx = None
        for i, it in enumerate(items):
            cum_len += len(it["text"])
            if cum_len >= best_char_pos:
                split_idx = i + 1
                break
        if split_idx is not None and 0 < split_idx < len(items):
            return _split_long_group(items[:split_idx], max_len, weak_punct) + \
                   _split_long_group(items[split_idx:], max_len, weak_punct)

    # 兜底：按 max_len 字符硬切
    cum_len = 0
    for i, it in enumerate(items):
        cum_len += len(it["text"])
        if cum_len >= max_len:
            return [items[:i + 1]] + _split_long_group(items[i + 1:], max_len, weak_punct)
    return [items]


def split_words_to_segments(items: list[dict], max_len: int, min_len: int = 5,
                             gap_split_ms: int = 1000) -> list[dict]:
    """把字/词级 timestamps 合并成句子级字幕。

    切分策略（与本地版一致）：
    0. 按静音间隔（>= gap_split_ms）预切
    1. 每个静音组内按强标点（。！？；\\n）继续切句
    2. 合并过短片段（< min_len 字符）
    3. 对超长片段，按弱标点（，、：,;）拆分
    4. 没有弱标点时，用 jieba 分词找最佳断点
    """
    STRONG_PUNCT = set("。！？；\n")
    WEAK_PUNCT = set("，、：,;")

    def to_seg(group):
        text = "".join(it["text"] for it in group)
        return {
            "start": group[0]["start"],
            "end": group[-1]["end"],
            "text": text,
            "items": [dict(it) for it in group],
        }

    final: list[list[dict]] = []
    silence_groups = _split_by_silence(items, gap_split_ms)

    for sg in silence_groups:
        raw_groups: list[list[dict]] = []
        buf: list[dict] = []
        for it in sg:
            buf.append(it)
            if any(c in STRONG_PUNCT for c in it["text"]):
                raw_groups.append(buf)
                buf = []
        if buf:
            raw_groups.append(buf)

        merged: list[list[dict]] = []
        for grp in raw_groups:
            seg_text = "".join(it["text"] for it in grp)
            if merged and len(seg_text) < min_len:
                merged[-1].extend(grp)
            else:
                merged.append(list(grp))
        if len(merged) >= 2:
            last_text = "".join(it["text"] for it in merged[-1])
            if len(last_text) < min_len:
                merged[-2].extend(merged.pop())

        for grp in merged:
            final.extend(_split_long_group(grp, max_len, WEAK_PUNCT))

    return [to_seg(g) for g in final if g]


# ===== DashScope filetrans API 调用 =====

def get_upload_policy(base_url: str, api_key: str, model: str) -> dict:
    """获取 DashScope 临时 OSS 上传凭证。"""
    resp = requests.get(
        f"{base_url}/api/v1/uploads",
        params={"action": "getPolicy", "model": model},
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=30,
    )
    resp.raise_for_status()
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
    # 解析出 bucket 和 endpoint
    host_clean = upload_host.replace("https://", "").replace("http://", "").rstrip("/")
    parts = host_clean.split(".", 2)
    if len(parts) < 3:
        raise RuntimeError(f"无法从 upload_host 解析 bucket: {upload_host}")
    bucket = parts[0]
    endpoint = parts[1] + "." + parts[2]

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
                     enable_itn: bool, model: str = FILETRANS_MODEL) -> str:
    """提交异步 ASR 任务，返回 task_id。"""
    params: dict = {
        "channel_id": [0],
        "enable_words": enable_words,
        "enable_itn": enable_itn,
    }
    if language:
        params["language"] = language

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
            "input": {"file_url": file_url},
            "parameters": params,
        },
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    output = body.get("output", {})
    task_id = output.get("task_id")
    if not task_id:
        raise RuntimeError(f"提交任务失败: {body}")
    return task_id


def poll_task(base_url: str, api_key: str, task_id: str,
              interval: int, timeout: int) -> str:
    """轮询任务状态，返回 transcription_url。"""
    url = f"{base_url}/api/v1/tasks/{task_id}"
    deadline = time.time() + timeout
    last_status = ""

    while time.time() < deadline:
        resp = requests.get(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=30)
        resp.raise_for_status()
        body = resp.json()
        output = body.get("output", {})
        status = output.get("task_status", "UNKNOWN")

        if status != last_status:
            print(f"[filetrans] 任务状态: {status}")
            last_status = status

        if status == "SUCCEEDED":
            result = output.get("result", {})
            turl = result.get("transcription_url")
            if not turl:
                raise RuntimeError(f"任务成功但无 transcription_url: {body}")
            usage = body.get("usage", {})
            return turl, usage
        if status == "FAILED":
            code = output.get("code", "UNKNOWN")
            msg = output.get("message", "未知错误")
            raise RuntimeError(f"ASR 任务失败 [{code}]: {msg}")
        if status == "UNKNOWN":
            raise RuntimeError(f"任务不存在或已过期: {body}")

        time.sleep(interval)

    raise TimeoutError(f"ASR 任务超时（{timeout}秒），task_id={task_id}")


def download_transcription(transcription_url: str) -> dict:
    """下载并解析识别结果 JSON。"""
    resp = requests.get(transcription_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


# ===== filetrans 结果 → 本地版 transcribe() 输出格式 =====

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
        return {"text": "", "language": "", "items": []}

    # 只取第一个音轨（channel_id=0）
    t = transcripts[0]
    all_items: list[dict] = []
    detected_language = ""

    for sent in t.get("sentences", []):
        if not detected_language and sent.get("language"):
            detected_language = sent["language"]

        words = sent.get("words") or []
        if not words:
            # 未启用字级时间戳时的兜底：用句子级
            all_items.append({
                "text": sent.get("text", ""),
                "start": sent.get("begin_time", 0),
                "end": sent.get("end_time", 0),
            })
            continue

        for w in words:
            text = w.get("text", "")
            punct = w.get("punctuation", "")
            all_items.append({
                "text": text + punct,
                "start": w.get("begin_time", 0),
                "end": w.get("end_time", 0),
            })

    return {
        "text": t.get("text", ""),
        "language": detected_language,
        "items": all_items,
    }


# ===== 顶层转写入口 =====

def transcribe(audio_path: str, language: str | None, hotwords: list[str],
               config: dict, file_url_override: str | None = None,
               model: str = FILETRANS_MODEL) -> dict:
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
            "       API Key 申请：https://help.aliyun.com/zh/model-studio/get-api-key"
        )

    if hotwords:
        print(f"[热词] 检测到 {len(hotwords)} 个热词。注意：filetrans API 暂不支持热词注入，"
              f"本地 qwen-asr 版本才支持（通过 context 软提示）。")

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
    print(f"[filetrans] 提交任务 (language={norm_lang or 'auto'}, "
          f"enable_words={config['enable_words']})...")
    task_id = submit_filetrans(
        base_url, api_key, file_url,
        language=norm_lang,
        enable_words=config["enable_words"],
        enable_itn=config["enable_itn"],
        model=model,
    )
    print(f"[filetrans] 任务已提交: task_id={task_id}")

    # 3) 轮询
    t0 = time.perf_counter()
    transcription_url, task_usage = poll_task(
        base_url, api_key, task_id,
        interval=config["poll_interval"],
        timeout=config["poll_timeout"],
    )
    elapsed_poll = time.perf_counter() - t0
    audio_secs = task_usage.get("seconds", 0)
    est_tokens = audio_secs * 25  # 文档：每秒音频 = 25 tokens
    print(f"[filetrans] 任务完成，耗时 {elapsed_poll:.1f}s | "
          f"计费 {audio_secs}s 音频 ≈ {est_tokens} tokens")

    # 4) 下载 + 解析
    raw = download_transcription(transcription_url)
    result = parse_transcription_result(raw)
    result["usage"] = task_usage
    return result


# ===== main CLI =====

def main():
    parser = argparse.ArgumentParser(
        description="使用阿里云 qwen3-asr-flash-filetrans API 生成视频字幕（云端版）",
    )
    parser.add_argument("input", help="输入视频或音频文件路径")
    parser.add_argument("-o", "--output", help="输出 SRT 路径（默认与输入同目录）")
    parser.add_argument(
        "-l", "--max-len", type=int, default=21,
        help="每条字幕最大字数（默认 21）",
    )
    parser.add_argument(
        "--min-len", type=int, default=5,
        help="句号间最短字数，不足则合并（默认 5）",
    )
    parser.add_argument(
        "--language", default=None,
        help="指定语言（zh/yue/en/ja/ko/de/fr 等，或 Chinese/English，默认自动识别）",
    )
    parser.add_argument(
        "--keep-punct", action="store_true",
        help="保留每条字幕末尾的逗号和句号（默认去除）",
    )
    parser.add_argument(
        "--gap-split", type=int, default=1500,
        help="静音切句阈值（毫秒），相邻字停顿超过此值则切句（默认 1500）",
    )
    parser.add_argument(
        "--json", dest="json_out", action="store_true",
        help="同时输出含字级时间戳的 JSON 文件（供 edit.py 加载）",
    )
    parser.add_argument(
        "-s", "--stickers", default=get_default_sticker_dir(),
        help="表情包文件夹路径，传给 edit.py（默认读 .env 的 STICKER_DIR）",
    )
    parser.add_argument(
        "--no-html", action="store_true",
        help="禁用自动生成 edit HTML（默认 --json 时会一并生成）",
    )
    parser.add_argument(
        "-ll", "--length-limit", type=_parse_duration, default=None,
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
        help=f"覆盖 ASR 模型（默认 {FILETRANS_MODEL}）",
    )
    parser.add_argument(
        "--debug", action="store_true",
        help="输出 API 原始结果用于调试",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists() and not args.file_url:
        print(f"错误: 文件不存在 - {input_path}")
        return

    if args.output:
        output_path = Path(args.output)
    else:
        output_path = input_path.with_suffix(".srt")

    # 读配置（CLI args 覆盖 .env）
    config = _get_config()
    if args.region:
        config["region"] = args.region.lower()
        config["base_url"] = _compute_base_url(config["region"], config["workspace_id"])

    video_exts = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"}
    is_video = input_path.suffix.lower() in video_exts

    hotwords = load_hotwords()

    with tempfile.TemporaryDirectory() as tmpdir:
        if args.file_url:
            audio_path = ""  # 不需要本地文件
            duration = 0.0
        else:
            if is_video:
                audio_path = str(Path(tmpdir) / "audio.wav")
                extract_audio(str(input_path), audio_path)
            else:
                # 复制到 tmpdir 统一处理（避免 length_limit 改原文件）
                audio_path = str(Path(tmpdir) / input_path.name)
                shutil.copy2(input_path, audio_path)

            duration = get_duration_sec(audio_path)
            m, s = divmod(int(duration), 60)
            print(f"[info] 音频总时长: {m}分{s}秒")

            if args.length_limit and args.length_limit < duration:
                limit_sec = args.length_limit
                limited_path = str(Path(tmpdir) / "audio_limited.wav")
                cmd = [
                    "ffmpeg", "-i", audio_path,
                    "-t", str(limit_sec),
                    "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
                    "-y", limited_path,
                ]
                subprocess.run(cmd, check=True, capture_output=True)
                audio_path = limited_path
                duration = limit_sec
                lm, ls = divmod(int(limit_sec), 60)
                print(f"[info] 已截取前 {lm}分{ls}秒用于测试")

        t0 = time.perf_counter()
        result = transcribe(
            audio_path, args.language, hotwords, config,
            file_url_override=args.file_url,
            model=args.model,
        )
        elapsed = time.perf_counter() - t0

        if not result or not result.get("text"):
            print("错误: 未识别到任何内容")
            return

        print(f"[info] 检测语言: {result.get('language', 'unknown')}")

        if args.debug:
            print("\n--- debug ---")
            print(f"text: {result['text'][:200]}...")
            print(f"items count: {len(result['items'])}")
            print(f"first 5 items: {result['items'][:5]}")
            print("--- end debug ---\n")

        items = result["items"]
        if not items:
            print("[警告] 未获得时间戳，输出整段为单条字幕")
            segments = [{"start": 0, "end": int(duration * 1000), "text": result["text"]}]
        else:
            segments = split_words_to_segments(
                items, args.max_len, args.min_len, args.gap_split
            )

    # 剥句末标点（与本地版一致）
    if not args.keep_punct:
        for seg in segments:
            seg["text"] = seg["text"].rstrip("，。")
            seg_items = seg.get("items")
            if seg_items:
                k = len(seg_items) - 1
                while k >= 0:
                    seg_items[k]["text"] = seg_items[k]["text"].rstrip("，。")
                    if seg_items[k]["text"]:
                        break
                    k -= 1

    srt_content = generate_srt(segments)

    em, es = divmod(int(elapsed), 60)
    if duration > 0:
        rtf = elapsed / duration
        speed = (1 / rtf) if rtf > 0 else 0
    else:
        rtf = 0
        speed = 0
    if not args.output:
        speed_tag = f"{speed:.1f}x" if speed else "na"
        ts_prefix = f"[{datetime.now().strftime('%y%m%d%H%M')}]"
        output_path = output_path.with_name(
            f"{ts_prefix}{output_path.stem}.qwen3-asr-api.{speed_tag}.srt"
        )

    output_path.write_text(srt_content, encoding="utf-8")
    print(f"\n字幕已保存到: {output_path}")
    print(f"共 {len(segments)} 条字幕")
    if duration > 0:
        print(f"处理用时: {em}分{es}秒 | 实际 RTF: {rtf:.3f} ({speed:.1f}x 实时)")
    else:
        print(f"处理用时: {em}分{es}秒")

    if args.json_out:
        json_path = output_path.with_suffix(".json")
        json_data = {
            "media": str(input_path),
            "language": result.get("language", ""),
            "model": "qwen3-asr-api",
            "segments": [
                {
                    "start": seg["start"],
                    "end": seg["end"],
                    "text": seg["text"],
                    "items": seg.get("items", []),
                }
                for seg in segments
            ],
        }
        json_path.write_text(
            json.dumps(json_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"JSON 已保存到: {json_path}")

        if not args.no_html:
            edit_script = Path(__file__).parent / "edit.py"
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


if __name__ == "__main__":
    main()
