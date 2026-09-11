# pyright: reportAny=false, reportAttributeAccessIssue=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportMissingTypeStubs=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedVariable=false, reportImplicitStringConcatenation=false, reportArgumentType=false, reportIndexIssue=false

"""使用豆包（火山引擎）大模型录音文件识别 API 生成视频字幕（云端版）。

特点：
- 无需 GPU、模型权重，只调 API（VOLC_API_KEY，新版控制台单 Key 鉴权）
- 异步 submit/query，字/词级毫秒时间戳，最长 120 分钟音频（base64 直传 ≤25MB）
- --speaker 开启说话人分离（utterance 级 speaker 写入 segments/items）
- --speaker-colors 在说话人基础上把不同 speaker 一次性映射成 5 种字幕颜色
- --hotword 即时热词直传 corpus.context
- 音频统一提取为 ogg + opus 24kbps 单声道 16kHz（约 10.8MB/小时，留足余量）

输出为通用的 UTF-8 JSON 工程格式（默认保存为 `.mosp`，包含 items/text/language，
可选 speaker/color），可直接交给 edit.py 编辑。配置读取 .env 文件（VOLC_API_KEY 等）。
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

from maw.stickers import get_default_sticker_dir
from generate_subtitle_qwen_api import (
    FFMPEG_MISSING_MESSAGE,
    WESTERN_MAX_WORDS,
    WESTERN_MIN_WORDS,
    generate_srt,
    get_duration_sec,
    parse_duration,
)
from maw.console import configure_utf8_stdio
from maw.ffmpeg import resolve_ffmpeg_tool
from maw.project_io import write_mosp
from maw.project import repair_segment_durations, validate_project
from maw.doubao import (
    AUDIO_BITRATE,
    AUDIO_CODEC,
    AUDIO_FORMAT,
    AUDIO_SAMPLE_RATE,
    MAX_AUDIO_SECONDS,
    build_segments,
    load_config,
    transcribe,
)
from maw.media_cache import embed_media_caches, merge_media_caches
from maw.media import resolve_default_audio_track
from maw.output_naming import format_elapsed, format_maw_stat, maw_root
from maw.speaker import apply_speaker_colors
from maw.language import (
    resolve_language,
    split_mode_for_text,
    timestamp_granularity_for_items,
)


def _run_media_tool(cmd: list[str], **kwargs):
    try:
        return subprocess.run(cmd, **kwargs)
    except FileNotFoundError as exc:
        executable = Path(str(cmd[0])).stem.lower() if cmd else ""
        if executable in {"ffmpeg", "ffprobe"}:
            raise RuntimeError(FFMPEG_MISSING_MESSAGE) from exc
        raise


def _resolve_media_tool(
    tool: str,
    configured_path: str | os.PathLike[str] | None = None,
) -> str:
    resolved = resolve_ffmpeg_tool(
        tool,
        configured_path,
        allow_missing_explicit=bool(configured_path),
    )
    if resolved is None:
        raise RuntimeError(FFMPEG_MISSING_MESSAGE)
    return str(resolved)


def extract_audio_ogg(
    input_path: str,
    output_path: str,
    duration_limit: float | None = None,
    *,
    ffmpeg_path: str | os.PathLike[str] | None = None,
    audio_track: int = 0,
) -> None:
    """把任意媒体的第一音轨提取为 ogg + opus 24kbps 单声道 16kHz。"""
    if not isinstance(audio_track, int) or isinstance(audio_track, bool) or audio_track < 0:
        raise ValueError("audio_track must be a non-negative integer")
    cmd = [
        _resolve_media_tool("ffmpeg", ffmpeg_path),
        "-i",
        input_path,
        "-map",
        f"0:a:{audio_track}",
    ]
    if duration_limit is not None:
        cmd.extend(["-t", str(duration_limit)])
    cmd.extend([
        "-vn",
        "-acodec", "libopus",
        "-b:a", AUDIO_BITRATE,
        "-ar", str(AUDIO_SAMPLE_RATE),
        "-ac", "1",
        "-y", output_path,
    ])
    print("[ffmpeg] 正在提取音频（ogg / opus 24kbps 单声道）...")
    _run_media_tool(cmd, check=True, capture_output=True)
    print("[ffmpeg] 音频提取完成")


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(
        description="使用豆包（火山引擎）大模型录音文件识别生成视频字幕（云端版）",
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
    parser.add_argument("--max-words", type=int, default=WESTERN_MAX_WORDS, help="英文单条字幕最大单词数")
    parser.add_argument("--min-words", type=int, default=WESTERN_MIN_WORDS, help="英文短句合并阈值（单词数）")
    parser.add_argument(
        "--language", default=None,
        help="语言提示（如 zh / en / ja；豆包不显式区分中文与粤语，默认自动识别）",
    )
    parser.add_argument(
        "--keep-punct", action="store_true",
        help="保留每条字幕末尾的逗号和句号（默认去除）",
    )
    parser.add_argument(
        "--strip-tail-punct", default="，。",
        help="句尾剥除的标点集合；传空串禁用剥除（默认剥逗号和句号）",
    )
    parser.add_argument(
        "--gap-split", type=int, default=800,
        help="静音切句阈值（毫秒），相邻字停顿超过此值则切句（默认 800）",
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
        "--hotword", action="append",
        help="即时热词；可重复传入（写入豆包 corpus.context）",
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
        help="禁用自动生成 edit HTML（默认 --json 时会一并生成）",
    )
    parser.add_argument(
        "-ll", "--length-limit", type=parse_duration, default=None,
        help="只处理音频前 N 时长，用于测试（示例: 10m, 20s, 1h, 90）",
    )
    parser.add_argument(
        "--model", default=None,
        help="覆盖豆包资源 ID（默认读 .env 的 VOLC_ASR_RESOURCE_ID，兜底 volc.seedasr.auc）",
    )
    parser.add_argument(
        "--debug", action="store_true",
        help="输出 API 解析结果用于调试",
    )
    parser.add_argument(
        "--debug-raw", action="store_true",
        help="保存豆包 query API 返回的完整原始 JSON，用于排查解析和时间码",
    )
    parser.add_argument(
        "--no-model-tag", action="store_true",
        help="默认输出文件名不附加供应商标识段（默认附加 doubao）",
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
    resource_id = args.model or config["resource_id"]
    ffmpeg_path = _resolve_media_tool("ffmpeg", config.get("ffmpeg_path"))
    ffprobe_path = _resolve_media_tool("ffprobe", config.get("ffmpeg_path"))
    default_audio_track = resolve_default_audio_track(
        input_path,
        args.default_audio_track,
        ffprobe_path=ffprobe_path,
    )
    print(f"[准备] 已载入豆包转写配置（资源: {resource_id}）")

    video_exts = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"}
    is_video = input_path.suffix.lower() in video_exts

    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"[媒体] 正在准备输入媒体: {input_path.name}")
        source_duration = get_duration_sec(str(input_path), ffprobe_path=ffprobe_path)
        video_limit = args.length_limit if args.length_limit and args.length_limit < source_duration else None
        audio_path = str(Path(tmpdir) / "audio.ogg")
        extract_audio_ogg(
            str(input_path),
            audio_path,
            duration_limit=video_limit if is_video else args.length_limit,
            ffmpeg_path=ffmpeg_path,
            audio_track=args.audio_track if is_video else 0,
        )
        if is_video and video_limit is not None:
            lm, ls = divmod(int(video_limit), 60)
            print(f"[info] 测试模式：从视频直接提取前 {lm}分{ls}秒，跳过其余内容")
        duration = get_duration_sec(audio_path, ffprobe_path=ffprobe_path)
        m, s = divmod(int(duration), 60)
        print(f"[info] 音频总时长: {m}分{s}秒")

        if duration > MAX_AUDIO_SECONDS:
            raise SystemExit(
                f"[错误] 音频时长 {int(duration // 60)} 分钟超过豆包 base64 直传上限"
                f"（120 分钟）。请用 -ll 截取部分时长，或先把音频分割成多个文件。"
            )

        print("[doubao] 本地媒体准备完成，开始连接火山引擎...")
        print(f"转写开始: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        t0 = time.perf_counter()
        result = transcribe(
            audio_path, config,
            language=args.language,
            enable_speaker=enable_speaker,
            hotwords=args.hotword,
            audio_format=AUDIO_FORMAT,
            audio_codec=AUDIO_CODEC,
            resource_id=resource_id,
            capture_raw=args.debug_raw,
        )
        elapsed = time.perf_counter() - t0
        print(f"转写结束: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

        raw_response = result.pop("_raw_response", None)
        if not result or not result.get("text"):
            print("错误: 未识别到任何内容", file=sys.stderr)
            raise SystemExit(2)

        print(f"[解析] 云端结果已返回，包含 {len(result.get('items', []))} 个时间戳项。")

        items = result["items"]
        if args.debug:
            print("\n--- debug ---")
            print(f"text: {result['text'][:200]}...")
            print(f"items count: {len(items)}")
            print(f"first 5 items: {items[:5]}")
            print("--- end debug ---\n")

        if result.get("timestamp_granularity") == "segment" and result.get("segments"):
            print("[解析] 云端词级时间码不完整，保留可用的句级时间范围...")
            segments = [dict(segment) for segment in result["segments"]]
        elif not items:
            print("[警告] 未获得时间戳，输出整段为单条字幕")
            segments = [{"start": 0, "end": int(duration * 1000), "text": result["text"]}]
        else:
            print("[解析] 正在按停顿和字数整理字幕（中文首次运行可能加载 jieba 词典）...")
            segments = build_segments(
                items, max_len=args.max_len, min_len=args.min_len,
                gap_split_ms=args.gap_split,
                max_words=args.max_words, min_words=args.min_words,
                split_mode=split_mode_for_text(result.get("text", ""), result.get("language")),
            )
            print(f"[解析] 字幕整理完成：{len(segments)} 条。")

        # 兜底：缺时间戳/倒挂的字会形成 0 长 item，
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
                ffmpeg_bin=str(ffmpeg_path) if ffmpeg_path is not None else None,
                audio_track=args.audio_track if is_video else 0,
                default_audio_track=default_audio_track if is_video else 0,
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

    # 剥句末标点（与 Qwen 版一致；--keep-punct 优先，空集合禁用）
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
            name_parts.append("doubao")
        suffix = f".{'.'.join(name_parts)}" if name_parts else ""
        output_path = output_path.with_name(
            f"{ts_prefix}{output_path.stem}{suffix}.srt"
        )

    output_path.write_text(srt_content, encoding="utf-8")
    print(f"\n字幕已保存到: {output_path}")
    print(f"共 {len(segments)} 条字幕")
    if args.debug_raw:
        if raw_response is None:
            raise RuntimeError("调试模式未获得豆包 query 原始返回数据")
        raw_path = (
            maw_root(input_path) / f"{output_path.stem}.asr-response.json"
            if not args.output
            else output_path.with_suffix(".asr-response.json")
        )
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        with raw_path.open("w", encoding="utf-8", newline="\n") as raw_file:
            json.dump(raw_response, raw_file, ensure_ascii=False, indent=2)
            raw_file.write("\n")
        print(f"[调试] 豆包 query 原始返回已保存到: {raw_path}")
    print(f"转写耗时: {format_elapsed(elapsed)}")
    if duration > 0:
        print(f"媒体时长: {format_elapsed(duration)}")
        print(f"转写时长为媒体时长的 {rtf:.2f} 倍")
        print(f"实际 RTF: {rtf:.3f} ({speed:.1f}x 实时)")

    if args.json_out:
        language, language_source = resolve_language(
            result.get("language"),
            args.language,
            str(result.get("text") or ""),
        )
        split_mode = split_mode_for_text(str(result.get("text") or ""), language)
        json_path = output_path.with_suffix(".mosp")
        json_data = {
            "media": str(input_path),
            "language": language,
            "language_source": language_source,
            "split_mode": split_mode,
            "timestamp_granularity": result.get("timestamp_granularity") or timestamp_granularity_for_items(
                result.get("items") or [], split_mode, has_segments=bool(segments)
            ),
            "model": f"doubao-{resource_id}",
            "segments": [
                {
                    "start": seg["start"],
                    "end": seg["end"],
                    "text": seg["text"],
                    **({"items": seg["items"]} if "items" in seg else {}),
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
        write_mosp(
            json_path,
            json_data,
            media_path=input_path,
            ffprobe_path=ffprobe_path,
            selected_audio_track=args.audio_track if is_video else 0,
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

    maw_stat = format_maw_stat(rtf)
    if maw_stat:
        print(maw_stat)
    return 0


if __name__ == "__main__":
    main()
