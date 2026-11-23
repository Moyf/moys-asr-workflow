# pyright: reportAny=false, reportAttributeAccessIssue=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportMissingTypeStubs=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedVariable=false, reportImplicitStringConcatenation=false, reportArgumentType=false, reportIndexIssue=false

"""使用 MOSS（模思智能开放平台）云端转写生成视频字幕。

特点：
- 无需 GPU、模型权重，只调 API（MOSS_API_KEY，Bearer 鉴权）
- moss-transcribe-diarize-pro 异步任务：multipart 上传 → task_id → 轮询
- 说话人分离是模型固有输出（diarize=true），speaker 写入 segments
- --keyterm（别名 --hotword）传官方 keyterms，最多 20 个、每个 ≤30 字符
- 仅段级时间码：超长句段按标点/字数设置二次拆分（段内时间为文本占比
  插值并吸附语音能量谷，不携带 items 冒充词级精度）；需要精确字词时间码
  时在 Launcher 用对齐模型补齐
- 句尾标点默认保留（与统一 CLI 契约一致），仅显式 --strip-tail-punct 剥除
- 音频统一提取为 ogg + opus 24kbps 单声道 16kHz（约 10.8MB/小时）
- 单次任务 ≤60 分钟（官方限制），超长素材请先用 -ll 截取或自行分割

输出为通用的 UTF-8 JSON 工程格式（默认保存为 `.mosp`，包含 segments/text/
language，可选 speaker/color），可直接交给 edit.py 编辑。配置读取 .env 文件
（MOSS_API_KEY 等）。
"""

from __future__ import annotations

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
from maw.asr.common import (
    FFMPEG_MISSING_MESSAGE,
    generate_srt,
    get_duration_sec,
    parse_duration,
)
from maw.asr.segmentation import (
    WESTERN_MAX_WORDS,
    WESTERN_MIN_WORDS,
    repair_nonpositive_duration_segments,
    split_coarse_segments,
)
from maw.console import configure_utf8_stdio
from maw.energy_valley import snap_cue_boundaries
from maw.ffmpeg import resolve_ffmpeg_tool
from maw.language import resolve_language, split_mode_for_text
from maw.project_io import write_mosp
from maw.project import repair_segment_durations, validate_project
from maw.moss import (
    AUDIO_BITRATE,
    AUDIO_SAMPLE_RATE,
    MAX_AUDIO_SECONDS,
    MAX_AUDIO_SECONDS_TOLERANCE,
    load_config,
    transcribe,
)
from maw.media_cache import embed_media_caches, merge_media_caches
from maw.media import resolve_default_audio_track
from maw.output_naming import debug_artifact_path, format_elapsed, format_maw_stat
from maw.speaker import apply_speaker_colors


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


def _strip_trailing_punct(segments: list[dict], strip_chars: str) -> None:
    """剥句末标点（与豆包/Qwen 版一致；--keep-punct 优先，空集合禁用）。"""
    if not strip_chars:
        return
    for segment in segments:
        segment["text"] = str(segment.get("text") or "").rstrip(strip_chars)


def build_subtitle_segments(
    segments: list[dict],
    *,
    max_len: int,
    min_len: int,
    gap_split_ms: int,
    max_words: int = WESTERN_MAX_WORDS,
    min_words: int = WESTERN_MIN_WORDS,
    split_mode: str | None = None,
) -> tuple[list[dict], set[int]]:
    """MOSS 句级分段 → 遵循断句设置的字幕段；返回 (segments, 插值切点序号)。

    与 Qwen 句级兜底、本地 MOSS 引擎走同一条 coarse-segment 路径：超长段按
    标点（连续语言）或词边界（西文）二次拆分，段内时间按文本占比插值；
    拆分产物不携带 items——插值时间不得冒充词级精度。speaker 随拆分透传。
    插值切点序号供调用方做语音能量谷吸附。
    """
    coarse = repair_nonpositive_duration_segments([dict(segment) for segment in segments])
    interpolated_boundary_indices: set[int] = set()
    pieces = split_coarse_segments(
        coarse,
        max_len=max_len,
        min_len=min_len,
        gap_split_ms=gap_split_ms,
        max_words=max_words,
        min_words=min_words,
        split_mode=split_mode,
        interpolated_boundary_indices=interpolated_boundary_indices,
    )
    return pieces, interpolated_boundary_indices


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(
        description="使用 MOSS（模思智能开放平台）云端转写生成视频字幕（说话人分离）",
    )
    parser.add_argument("input", help="输入视频或音频文件路径")
    parser.add_argument("-o", "--output", help="输出 SRT 路径（默认与输入同目录）")
    parser.add_argument(
        "--model", default=None,
        help="覆盖 MOSS 模型 ID（默认读 .env 的 MOSS_MODEL，兜底 moss-transcribe-diarize-pro）",
    )
    parser.add_argument(
        "--keyterm", "--hotword", dest="keyterm", action="append", default=[],
        help="keyterms 热词，可重复传入（最多 20 个、每个 ≤30 字符）",
    )
    parser.add_argument(
        "--speaker", action="store_true",
        help="兼容统一接口：MOSS 说话人分离为模型固有输出，无需开启（恒为开）",
    )
    parser.add_argument(
        "--speaker-colors", action="store_true",
        help="把不同说话人一次性映射成 5 种字幕颜色（可在编辑器修改）",
    )
    parser.add_argument(
        "--keep-punct", action="store_true",
        help="兼容旧调用：默认已保留全部句尾标点；覆盖显式 --strip-tail-punct 删除设置",
    )
    parser.add_argument(
        "--strip-tail-punct", default="",
        help="句尾剥除的标点集合；传空串禁用剥除（默认保留全部标点）",
    )
    parser.add_argument(
        "-ll", "--length-limit", type=parse_duration, default=None,
        help="只处理音频前 N 时长，用于测试（示例: 10m, 20s, 1h, 90）",
    )
    parser.add_argument(
        "--max-len", type=int, default=18,
        help="中文单条字幕最大字符数；超长句段按标点二次拆分（默认 18）",
    )
    parser.add_argument(
        "--min-len", type=int, default=5,
        help="中文短句合并阈值（默认 5；仅 CJK 内容生效）",
    )
    parser.add_argument(
        "--max-words", type=int, default=WESTERN_MAX_WORDS,
        help="英文单条字幕最大单词数（默认共享断句配置）",
    )
    parser.add_argument(
        "--min-words", type=int, default=WESTERN_MIN_WORDS,
        help="英文短句合并阈值（单词数，默认共享断句配置）",
    )
    parser.add_argument(
        "--gap-split", type=int, default=500,
        help="静音切句阈值（毫秒，默认 500；句段内部无词级静音信息时不参与拆分）",
    )
    parser.add_argument(
        "--json", dest="json_out", action="store_true",
        help="同时输出工程文件（默认 .mosp，供 edit.py 加载）",
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
        "--debug", action="store_true",
        help="输出 API 解析结果用于调试",
    )
    parser.add_argument(
        "--debug-raw", action="store_true",
        help="保存 MOSS 任务查询返回的完整原始 JSON，用于排查解析和时间码",
    )
    parser.add_argument(
        "--no-model-tag", action="store_true",
        help="默认输出文件名不附加供应商标识段（默认附加 moss）",
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

    config = load_config()
    model_id = args.model or config["model"]
    ffmpeg_path = _resolve_media_tool("ffmpeg", config.get("ffmpeg_path"))
    ffprobe_path = _resolve_media_tool("ffprobe", config.get("ffmpeg_path"))
    default_audio_track = resolve_default_audio_track(
        input_path,
        args.default_audio_track,
        ffprobe_path=ffprobe_path,
    )
    print(f"[准备] 已载入 MOSS 转写配置（模型: {model_id}）")

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

        # 转码会引入毫秒级容器误差（如 3600s 素材 → 3600.006s）：恰好 60 分钟
        # 的合法素材不能因舍入被拒，用小容差判定超限。
        if duration > MAX_AUDIO_SECONDS + MAX_AUDIO_SECONDS_TOLERANCE:
            raise SystemExit(
                f"[错误] 音频时长 {int(duration // 60)} 分钟超过 MOSS 单次任务上限"
                f"（60 分钟）。请用 -ll 截取部分时长，或先把音频分割成多个文件。"
            )

        print("[moss] 本地媒体准备完成，开始连接 MOSS 开放平台...")
        print(f"转写开始: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        t0 = time.perf_counter()
        result = transcribe(
            audio_path, config,
            model=model_id,
            keyterms=args.keyterm,
            capture_raw=args.debug_raw,
        )
        elapsed = time.perf_counter() - t0
        print(f"转写结束: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

        raw_response = result.pop("_raw_response", None)
        if not result or not result.get("text"):
            print("错误: 未识别到任何内容", file=sys.stderr)
            raise SystemExit(2)

        print(f"[解析] 云端结果已返回，包含 {len(result.get('segments', []))} 个说话人分段。")

        segments = [dict(segment) for segment in result["segments"]]
        if args.debug:
            print("\n--- debug ---")
            print(f"text: {result['text'][:200]}...")
            print(f"segments count: {len(segments)}")
            print(f"first 5 segments: {segments[:5]}")
            print("--- end debug ---\n")

        # 句级分段同样遵循断句设置：超长段按标点/字数二次拆分（与 Qwen 句级
        # 兜底、本地 MOSS 引擎同一条 coarse-segment 路径）。段内时间为文本
        # 占比插值，随后吸附到语音能量谷；拆分产物不携带 items。
        split_mode = split_mode_for_text(str(result.get("text") or ""), result.get("language"))
        overlong_before = sum(
            1 for seg in segments
            if (len(str(seg.get("text") or "").split()) > args.max_words
                if split_mode == "word"
                else len(str(seg.get("text") or "")) > args.max_len)
        )
        if overlong_before:
            print(f"[解析] 正在按标点/字数设置拆分 {overlong_before} 个超长句段...")
        segments, interpolated_boundary_indices = build_subtitle_segments(
            segments,
            max_len=args.max_len,
            min_len=args.min_len,
            gap_split_ms=args.gap_split,
            max_words=args.max_words,
            min_words=args.min_words,
            split_mode=split_mode,
        )
        if overlong_before:
            print(f"[解析] 拆分完成：共 {len(segments)} 条字幕（段内切点为插值近似，可在编辑器微调）")
        # 插值切点吸附语音能量谷：读取提取音频，失败时静默跳过不阻塞输出。
        snapped = snap_cue_boundaries(segments, audio_path, boundary_indices=interpolated_boundary_indices)
        if snapped:
            print(f"[输出] 已将 {snapped} 个插值切点吸附到语音能量谷")

        # 兜底：0 长/倒挂时间码拉齐到至少 100ms，避免工程无法保存。
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

    speakers = sorted({str(seg["speaker"]) for seg in segments if seg.get("speaker")})
    if speakers:
        print(f"[speaker] 识别到 {len(speakers)} 个说话人: {', '.join(speakers)}")
    if args.speaker_colors:
        if not speakers:
            print("[警告] 结果中没有说话人标签，跳过配色")
        else:
            stats = apply_speaker_colors(segments)
            print(f"[speaker] 已为 {stats['colored_segments']} 条字幕写入颜色快照")
            if stats["overflow"]:
                print(f"[警告] 说话人超过 {len(stats['speakers'])} 个（>5），颜色已循环复用，"
                      f"不同说话人可能同色，请在编辑器中手动调整")

    if not args.keep_punct:
        _strip_trailing_punct(segments, args.strip_tail_punct)
        segments = [seg for seg in segments if str(seg.get("text") or "").strip()]

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
            name_parts.append("moss")
        suffix = f".{'.'.join(name_parts)}" if name_parts else ""
        output_path = output_path.with_name(
            f"{ts_prefix}{output_path.stem}{suffix}.srt"
        )

    output_path.write_text(srt_content, encoding="utf-8")
    print(f"\n字幕已保存到: {output_path}")
    print(f"共 {len(segments)} 条字幕")
    if args.debug_raw:
        if raw_response is None:
            raise RuntimeError("调试模式未获得 MOSS 任务原始返回数据")
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
        print(f"[调试] MOSS 任务原始返回已保存到: {raw_path}")
    print(f"转写耗时: {format_elapsed(elapsed)}")
    if duration > 0:
        print(f"媒体时长: {format_elapsed(duration)}")
        print(f"转写时长为媒体时长的 {rtf:.2f} 倍")
        print(f"实际 RTF: {rtf:.3f} ({speed:.1f}x 实时)")

    if args.json_out:
        language, language_source = resolve_language(
            result.get("language"),
            None,
            str(result.get("text") or ""),
        )
        split_mode = split_mode_for_text(str(result.get("text") or ""), language)
        json_path = output_path.with_suffix(".mosp")
        json_data = {
            "media": str(input_path),
            "language": language,
            "language_source": language_source,
            "split_mode": split_mode,
            "timestamp_granularity": result.get("timestamp_granularity") or "segment",
            "model": model_id,
            "segments": [
                {
                    "start": seg["start"],
                    "end": seg["end"],
                    "text": seg["text"],
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
    return 0


if __name__ == "__main__":
    main()
