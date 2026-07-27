"""使用本地 Qwen3-ASR 模型生成视频字幕（本地 GPU 版）。

特点：
- 无需 API Key，直接调用本地 GPU 推理 Qwen3-ASR 模型
- 可选 Qwen3-ASR-0.6B（默认，节约显存）或 Qwen3-ASR-1.7B
- 使用 Qwen3-ForcedAligner-0.6B 获取字级时间戳
- 支持热词（通过 context 软提示），从 hotwords.txt 读取
- 输出与云端版完全兼容的 JSON 工程格式（可直接交给 edit.py）

依赖：
    pip install qwen-asr

用法：
    uv run python generate_subtitle_local.py "D:/Videos/example.mp4" --json
    uv run python generate_subtitle_local.py "D:/Videos/example.mp4" --model 1.7B --json
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
from typing import Optional

# 复用云端版的工具函数
from generate_subtitle_qwen_api import (
    extract_audio,
    get_duration_sec,
    _parse_duration,
    split_words_to_segments,
    generate_srt,
    format_timestamp,
    load_hotwords,
    HOTWORDS_FILE,
)
from edit import get_default_sticker_dir


# ===== 路径与常量 =====

ENV_FILE = Path(__file__).parent / ".env"

# 可用的 ASR 模型
ASR_MODELS = {
    "0.6B": "Qwen/Qwen3-ASR-0.6B",
    "1.7B": "Qwen/Qwen3-ASR-1.7B",
}
DEFAULT_ASR_MODEL = "0.6B"

# ForcedAligner 固定用 0.6B（更轻量，时间戳精度已足够）
FORCED_ALIGNER_MODEL = "Qwen/Qwen3-ForcedAligner-0.6B"


# ===== .env 读取（零依赖） =====

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


def _get_local_config() -> dict:
    """读取本地模型相关配置。"""
    env = _load_env_file()

    def pick(key: str, default: str = "") -> str:
        return os.getenv(key) or env.get(key, default)

    return {
        "model_path": pick("QWEN3_ASR_MODEL_PATH"),       # 本地模型路径（可选，默认从 HF 加载）
        "aligner_path": pick("QWEN3_ASR_ALIGNER_PATH"),   # 本地 aligner 路径（可选）
        "device": pick("QWEN3_ASR_DEVICE", "cuda:0"),     # 推理设备
        "dtype": pick("QWEN3_ASR_DTYPE", "bfloat16"),     # 模型精度
        "max_new_tokens": int(pick("QWEN3_ASR_MAX_TOKENS", "256") or "256"),
        "batch_size": int(pick("QWEN3_ASR_BATCH_SIZE", "1") or "1"),
    }


# ===== CUDA 检测 =====

def _check_cuda() -> bool:
    """检测 CUDA 是否可用。"""
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False


# ===== 顶层转写入口（本地模型） =====

def transcribe_local(
    audio_path: str,
    language: Optional[str],
    hotwords: list[str],
    model_size: str = DEFAULT_ASR_MODEL,
    local_config: Optional[dict] = None,
) -> dict:
    """使用本地 Qwen3-ASR 模型做转录。

    参数：
        audio_path: 音频文件路径（16kHz mono WAV）
        language: 语言（如 "Chinese" / "English"，None=自动识别）
        hotwords: 热词列表
        model_size: "0.6B" 或 "1.7B"
        local_config: 本地配置字典

    返回与云端版 transcribe() 一致的格式：
        {"text": str, "language": str, "items": [{"text", "start", "end"}, ...]}
    """
    config = local_config or _get_local_config()
    device = config.get("device", "cuda:0")

    # 检查 CUDA
    if not _check_cuda():
        print("[警告] CUDA 不可用，将使用 CPU 推理（极慢！建议配置 GPU）")
        device = "cpu"

    # 确定模型名/路径
    model_name = config.get("model_path") or ASR_MODELS.get(model_size, ASR_MODELS[DEFAULT_ASR_MODEL])
    aligner_name = config.get("aligner_path") or FORCED_ALIGNER_MODEL
    dtype_str = config.get("dtype", "bfloat16")
    max_new_tokens = config.get("max_new_tokens", 256)

    import torch

    dtype_map = {
        "bfloat16": torch.bfloat16,
        "float16": torch.float16,
        "float32": torch.float32,
    }
    dtype = dtype_map.get(dtype_str, torch.bfloat16)

    print(f"[local] 正在加载 ASR 模型: {model_name}")
    print(f"[local] 正在加载 ForcedAligner: {aligner_name}")
    t0 = time.perf_counter()

    from qwen_asr import Qwen3ASRModel

    model = Qwen3ASRModel.from_pretrained(
        model_name,
        dtype=dtype,
        device_map=device,
        # attn_implementation="flash_attention_2",  # 8GB 显存，谨慎启用
        forced_aligner=aligner_name,
        forced_aligner_kwargs=dict(
            dtype=dtype,
            device_map=device,
            # attn_implementation="flash_attention_2",
        ),
        max_inference_batch_size=config.get("batch_size", 1),
        max_new_tokens=max_new_tokens,
    )

    elapsed_load = time.perf_counter() - t0
    print(f"[local] 模型加载完成，耗时 {elapsed_load:.1f}s")

    # 准备热词 → context
    context_str = ""
    if hotwords:
        # Qwen3-ASR 的 context 参数接受空格分隔的热词字符串
        context_str = " ".join(hotwords)
        print(f"[热词] 已注入 {len(hotwords)} 个热词: {context_str}")

    # 转写
    lang_param = language if language else None
    context_param = [context_str] if context_str else None

    print(f"[local] 开始转写 (language={lang_param or 'auto'})...")
    t1 = time.perf_counter()

    results = model.transcribe(
        audio=[audio_path],
        language=[lang_param] if lang_param else [None],
        context=context_param if context_param else None,
        return_time_stamps=True,
    )

    elapsed_transcribe = time.perf_counter() - t1
    print(f"[local] 转写完成，耗时 {elapsed_transcribe:.1f}s")

    if not results or len(results) == 0:
        raise RuntimeError("模型未返回任何识别结果")

    result = results[0]
    print(f"[info] 检测语言: {result.language}")
    print(f"[info] 识别文本: {result.text[:100]}...")

    # 转换时间戳为 MAW 标准格式
    items: list[dict] = []
    if result.time_stamps is not None and len(result.time_stamps) > 0:
        for ts in result.time_stamps:
            items.append({
                "text": ts.text,
                "start": int(ts.start_time * 1000),  # 秒 → 毫秒
                "end": int(ts.end_time * 1000),
            })

    return {
        "text": result.text,
        "language": result.language or "",
        "items": items,
    }


# ===== main CLI =====

def main():
    parser = argparse.ArgumentParser(
        description="使用本地 Qwen3-ASR 模型生成视频字幕（本地 GPU 版）",
        epilog=(
            "示例:\n"
            "  uv run python generate_subtitle_local.py video.mp4 --json\n"
            "  uv run python generate_subtitle_local.py video.mp4 --model 1.7B --json\n"
            "  uv run python generate_subtitle_local.py video.mp4 --language zh --hotwords \"热词1 热词2\"\n"
            "\n"
            "首次运行会自动从 Hugging Face 下载模型（约 2-4GB），请保证网络通畅。\n"
            "国内用户推荐先用 ModelScope 下载到本地，再用 --model-path 指定路径:\n"
            "  pip install modelscope\n"
            "  modelscope download --model Qwen/Qwen3-ASR-0.6B --local_dir ./models/Qwen3-ASR-0.6B\n"
            "  modelscope download --model Qwen/Qwen3-ForcedAligner-0.6B --local_dir ./models/Qwen3-ForcedAligner-0.6B\n"
            "\n"
            ".env 配置项:\n"
            "  QWEN3_ASR_MODEL_PATH=./Qwen3-ASR-0.6B   # 本地模型路径\n"
            "  QWEN3_ASR_ALIGNER_PATH=./Qwen3-ForcedAligner-0.6B  # 本地 aligner 路径\n"
            "  QWEN3_ASR_DEVICE=cuda:0                 # 推理设备\n"
            "  QWEN3_ASR_DTYPE=bfloat16                # 模型精度\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
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
        help="指定语言（Chinese/English 等，默认自动识别）",
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
        "--debug", action="store_true",
        help="输出原始结果用于调试",
    )
    parser.add_argument(
        "--model", default=DEFAULT_ASR_MODEL,
        choices=list(ASR_MODELS.keys()),
        help=f"模型大小（默认 {DEFAULT_ASR_MODEL}，可选: {', '.join(ASR_MODELS.keys())}）",
    )
    parser.add_argument(
        "--hotwords", default=None, nargs="*",
        help="额外热词（以空格分隔，会与 hotwords.txt 合并）；"
             "示例: --hotwords \"人工智能\" \"深度学习\"",
    )
    parser.add_argument(
        "--model-path", default=None,
        help="本地 ASR 模型路径（如 ./models/Qwen3-ASR-0.6B，默认从 HuggingFace 加载）",
    )
    parser.add_argument(
        "--aligner-path", default=None,
        help="本地 ForcedAligner 模型路径（如 ./models/Qwen3-ForcedAligner-0.6B）",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"错误: 文件不存在 - {input_path}")
        return

    if args.output:
        output_path = Path(args.output)
    else:
        output_path = input_path.with_suffix(".srt")

    # 读取热词：hotwords.txt + 命令行参数
    hotwords = load_hotwords()
    if args.hotwords:
        for hw in args.hotwords:
            hw = hw.strip()
            if hw and hw not in hotwords:
                hotwords.append(hw)

    if hotwords:
        print(f"[热词] 共 {len(hotwords)} 个热词: {' '.join(hotwords)}")

    video_exts = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"}
    is_video = input_path.suffix.lower() in video_exts

    with tempfile.TemporaryDirectory() as tmpdir:
        if is_video:
            audio_path = str(Path(tmpdir) / "audio.wav")
            extract_audio(str(input_path), audio_path)
        else:
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

        # CLI --model-path / --aligner-path 覆盖 .env 配置
        local_config = _get_local_config()
        if args.model_path:
            local_config["model_path"] = args.model_path
        if args.aligner_path:
            local_config["aligner_path"] = args.aligner_path

        t0 = time.perf_counter()
        result = transcribe_local(
            audio_path, args.language, hotwords,
            model_size=args.model,
            local_config=local_config,
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

    # 剥句末标点（与云端版一致）
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
        model_tag = f"qwen3-asr-{args.model}"
        output_path = output_path.with_name(
            f"{ts_prefix}{output_path.stem}.{model_tag}.{speed_tag}.srt"
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
        model_name = f"qwen3-asr-local-{args.model}"
        json_data = {
            "media": str(input_path),
            "language": result.get("language", ""),
            "model": model_name,
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
