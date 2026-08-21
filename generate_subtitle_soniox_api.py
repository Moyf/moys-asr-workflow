# pyright: reportAny=false, reportAttributeAccessIssue=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportMissingTypeStubs=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedVariable=false, reportImplicitStringConcatenation=false, reportArgumentType=false, reportIndexIssue=false

"""使用 Soniox 异步 STT API 生成视频字幕（云端版，可选说话人分离）。

特点：
- 无需 GPU、模型权重，只调 API（SONIOX_API_KEY）
- 官方 Files API 直接上传 + 异步轮询，token 级毫秒时间戳
- --speaker 开启说话人分离（token 级 speaker 写入 segments/items）
- --speaker-colors 在说话人基础上把不同 speaker 一次性映射成 5 种字幕颜色
- 单文件最长 5 小时；转写完成后自动清理云端文件与转写记录

输出为通用的 UTF-8 JSON 工程格式（默认保存为 `.mosp`，包含 items/text/language，可选 speaker/color），
可直接交给 edit.py 编辑。配置读取 .env 文件（SONIOX_API_KEY 等）。
"""

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

from edit import get_default_sticker_dir
from generate_subtitle_qwen_api import (
    LANGUAGE_MAP,
    configure_console_output,
    extract_audio,
    generate_srt,
    get_duration_sec,
    parse_duration,
)
from maw.project import repair_segment_durations, validate_project
from maw.soniox import (
    MAX_AUDIO_SECONDS,
    SonioxContextError,
    apply_speaker_colors,
    build_segments,
    load_config,
    parse_soniox_context_json,
    transcribe,
)
from media_cache import embed_media_caches, merge_media_caches


def _language_hints(raw: str | None) -> list[str]:
    """'zh,en' 或 'Chinese,English' 等 → Soniox language_hints ISO 码列表。"""
    if not raw:
        return []
    hints: list[str] = []
    for part in raw.split(","):
        key = part.strip().lower()
        if key:
            hints.append(LANGUAGE_MAP.get(key, key))
    return hints


def main():
    parser = argparse.ArgumentParser(
        description="使用 Soniox 异步 STT API 生成视频字幕（云端版，可选说话人分离）",
    )
    parser.add_argument("input", help="输入视频或音频文件路径")
    parser.add_argument("-o", "--output", help="输出 SRT 路径（默认与输入同目录）")
    parser.add_argument(
        "-l", "--max-len", type=int, default=21,
        help="每条字幕最大字数（默认 21；仅 CJK 内容生效，空格语言按词数自动处理）",
    )
    parser.add_argument(
        "--min-len", type=int, default=5,
        help="句号间最短字数，不足则合并（默认 5；仅 CJK 内容生效）",
    )
    parser.add_argument(
        "--language", default=None,
        help="语言提示，逗号分隔（如 zh,en 或 Chinese；默认自动识别）",
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
        "--speaker", action="store_true",
        help="开启说话人分离，speaker 标签写入工程文件（不改变字幕颜色）",
    )
    parser.add_argument(
        "--speaker-colors", action="store_true",
        help="在 --speaker 基础上，把不同说话人一次性映射成 5 种字幕颜色（可在编辑器修改）",
    )
    parser.add_argument(
        "--json", dest="json_out", action="store_true",
        help="同时输出含 token 级时间戳的工程文件（默认 .mosp，供 edit.py 加载）",
    )
    parser.add_argument(
        "--with-waveform", action="store_true",
        help="将波形峰值数据嵌入工程文件（GUI 转写默认开启）",
    )
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
        help="禁用自动生成 edit HTML（默认 --json 时会一并生成）",
    )
    parser.add_argument(
        "-ll", "--length-limit", type=parse_duration, default=None,
        help="只处理音频前 N 时长，用于测试（示例: 10m, 20s, 1h, 90）",
    )
    parser.add_argument(
        "--model", default=None,
        help="覆盖 Soniox 模型（默认读 .env 的 SONIOX_MODEL，兜底 stt-async-v5）",
    )
    parser.add_argument(
        "--context-json", default=None,
        help="Soniox context JSON；支持 general/text/terms/translation_terms，最多约 10000 字符",
    )
    parser.add_argument(
        "--debug", action="store_true",
        help="输出 API 解析结果用于调试",
    )
    parser.add_argument(
        "--debug-raw", action="store_true",
        help="保存 Soniox transcript API 返回的完整原始 JSON，用于排查解析和时间码",
    )
    args = parser.parse_args()
    configure_console_output()
    if args.with_spectral and not args.with_waveform:
        parser.error("--with-spectral 需要同时指定 --with-waveform")

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"错误: 文件不存在 - {input_path}", file=sys.stderr)
        raise SystemExit(1)

    if args.output:
        output_path = Path(args.output)
    else:
        output_path = input_path.with_suffix(".srt")

    enable_speaker = args.speaker or args.speaker_colors
    config = load_config()
    print(f"[准备] 已载入 Soniox 转写配置（模型: {args.model or config['model']}）")

    try:
        context = parse_soniox_context_json(args.context_json)
    except SonioxContextError as error:
        parser.error(str(error))

    video_exts = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"}
    is_video = input_path.suffix.lower() in video_exts

    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"[媒体] 正在准备输入媒体: {input_path.name}")
        if is_video:
            audio_path = str(Path(tmpdir) / "audio.wav")
            print("[媒体] 正在读取原始视频时长...")
            source_duration = get_duration_sec(str(input_path))
            video_limit = args.length_limit if args.length_limit and args.length_limit < source_duration else None
            extract_audio(str(input_path), audio_path, duration_limit=video_limit)
            print("[媒体] 正在读取提取后音频时长...")
            duration = get_duration_sec(audio_path)
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
            duration = get_duration_sec(audio_path)
        m, s = divmod(int(duration), 60)
        print(f"[info] 音频总时长: {m}分{s}秒")

        if duration > MAX_AUDIO_SECONDS:
            raise SystemExit(
                f"[错误] 音频时长 {int(duration // 60)} 分钟超过 Soniox 单文件上限（300 分钟）。\n"
                f"       请用 -ll 截取部分时长，或先把音频分割成多个文件。"
            )

        if args.length_limit and args.length_limit < duration:
            limit_sec = args.length_limit
            limited_path = str(Path(tmpdir) / "audio_limited.wav")
            print("[ffmpeg] 正在为测试模式截取并重新采样音频...")
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

        print("[soniox] 本地媒体准备完成，开始连接 Soniox...")
        t0 = time.perf_counter()
        result = transcribe(
            audio_path, config,
            language_hints=_language_hints(args.language),
            enable_speaker=enable_speaker,
            model=args.model,
            context=context,
            capture_raw=args.debug_raw,
        )
        elapsed = time.perf_counter() - t0

        raw_response = result.pop("_raw_response", None)
        if not result or not result.get("text"):
            print("错误: 未识别到任何内容", file=sys.stderr)
            raise SystemExit(2)

        print(f"[解析] 云端结果已返回，包含 {len(result.get('items', []))} 个时间戳项。")
        print(f"[info] 检测语言: {result.get('language', 'unknown')}")

        items = result["items"]
        if args.debug:
            print("\n--- debug ---")
            print(f"text: {result['text'][:200]}...")
            print(f"items count: {len(items)}")
            print(f"first 5 items: {items[:5]}")
            print("--- end debug ---\n")

        if not items:
            print("[警告] 未获得时间戳，输出整段为单条字幕")
            segments = [{"start": 0, "end": int(duration * 1000), "text": result["text"]}]
        else:
            print("[解析] 正在按停顿和字数整理字幕（中文首次运行可能加载 jieba 词典）...")
            segments = build_segments(
                items, max_len=args.max_len, min_len=args.min_len,
                gap_split_ms=args.gap_split,
            )
            print(f"[解析] 字幕整理完成：{len(segments)} 条。")

        # 兜底：缺时间戳/倒挂的 token 会形成 0 长 item，
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
                Path(audio_path),
                source_media_path=input_path,
                generate_spectral=args.with_spectral,
            )

    if enable_speaker:
        speakers = sorted({str(seg["speaker"]) for seg in segments if seg.get("speaker")})
        print(f"[speaker] 识别到 {len(speakers)} 个说话人: {', '.join(speakers)}")
        if args.speaker_colors:
            stats = apply_speaker_colors(segments)
            print(f"[speaker] 已为 {stats['colored_segments']} 条字幕写入颜色快照")
            if stats["overflow"]:
                print(f"[警告] 说话人超过 {len(stats['speakers'])} 个（>5），颜色已循环复用，"
                      f"不同说话人可能同色，请在编辑器中手动调整")

    # 剥句末标点（与 Qwen 版一致）
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

    print(f"[输出] 正在生成 SRT（{len(segments)} 条字幕）...")
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
            f"{ts_prefix}{output_path.stem}.soniox.{speed_tag}.srt"
        )

    output_path.write_text(srt_content, encoding="utf-8")
    print(f"\n字幕已保存到: {output_path}")
    print(f"共 {len(segments)} 条字幕")
    if args.debug_raw:
        if raw_response is None:
            raise RuntimeError("调试模式未获得 Soniox transcript 原始返回数据")
        raw_path = output_path.with_suffix(".asr-response.json")
        with raw_path.open("w", encoding="utf-8", newline="\n") as raw_file:
            json.dump(raw_response, raw_file, ensure_ascii=False, indent=2)
            raw_file.write("\n")
        print(f"[调试] Soniox transcript 原始返回已保存到: {raw_path}")
    if duration > 0:
        print(f"处理用时: {em}分{es}秒 | 实际 RTF: {rtf:.3f} ({speed:.1f}x 实时)")
    else:
        print(f"处理用时: {em}分{es}秒")

    if args.json_out:
        json_path = output_path.with_suffix(".mosp")
        json_data = {
            "media": str(input_path),
            "language": result.get("language", ""),
            "model": f"soniox-{args.model or config['model']}",
            "segments": [
                {
                    "start": seg["start"],
                    "end": seg["end"],
                    "text": seg["text"],
                    "items": seg.get("items", []),
                    **({"speaker": seg["speaker"]} if seg.get("speaker") else {}),
                    **({"color": seg["color"]} if seg.get("color") else {}),
                    **({"color_ref": seg["color_ref"]} if seg.get("color_ref") else {}),
                }
                for seg in segments
            ],
        }
        if cache_result is not None:
            json_data = merge_media_caches(json_data, cache_result)
        print("[输出] 正在校验工程文件...")
        check = validate_project(json_data)
        if not check.ok:
            print("[警告] 工程文件未通过契约校验，请把以下内容反馈给开发者：")
            for err in check.errors[:10]:
                print(f"  {err.path}: {err.message}")
        print("[输出] 正在写入工程文件...")
        json_path.write_text(
            json.dumps(json_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"工程文件已保存到: {json_path}")

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
