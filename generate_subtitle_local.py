"""Local QwenASR / FunASR / MOSS / faster-whisper -> SRT + MAW project CLI.

This remains a source-mode first step.  Model packages are optional; the
Launcher only routes to this CLI and lets the upstream runtime prepare its
cache, rather than bundling a model manager into the application.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Sequence

# Windows embedded Python uses ``python*._pth`` to control ``sys.path`` and
# does not add the directory of a script executed by path.  The packaged copy
# lives beside ``local-runtime/maw``; source mode has the same sibling layout
# at the repository root.  Add that package root before importing MAW modules.
_BUNDLE_ROOT = Path(__file__).resolve().parent
if str(_BUNDLE_ROOT) not in sys.path:
    sys.path.insert(0, str(_BUNDLE_ROOT))

from maw.console import configure_utf8_stdio  # noqa: E402
from maw.output_naming import format_elapsed, format_maw_stat  # noqa: E402
from maw.ffmpeg import resolve_ffmpeg_tools  # noqa: E402
from maw.language import (  # noqa: E402
    DEFAULT_MAX_WORDS,
    DEFAULT_MIN_WORDS,
)
from maw.local_asr import (  # noqa: E402
    FUNASR_DEFAULT_MODEL,
    QWEN_DEFAULT_CHUNK_SECONDS,
    QWEN_DEFAULT_FORCED_ALIGNER,
    QWEN_DEFAULT_MODEL,
    WHISPER_DEFAULT_MODEL,
    build_local_segments,
    create_local_engine,
    parse_duration,
    prepared_audio,
    write_local_outputs,
)
from maw.media import resolve_default_audio_track  # noqa: E402
from maw.local_debug import LocalDebugWriter, transcription_payload  # noqa: E402

ALIGNMENT_MODE_FILL = "fill"
ALIGNMENT_MODE_GENERATE = "generate"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="使用本地 QwenASR、FunASR、MOSS、FireRedASR2-CTC 或 faster-whisper 生成 MAW 字幕工程",
    )
    parser.add_argument("input", help="输入视频或音频文件路径")
    parser.add_argument(
        "--engine", choices=("qwen-asr", "funasr", "moss", "firered", "whisper"), default="qwen-asr",
        help="本地推理引擎（默认: qwen-asr；firered 走 sherpa-onnx CPU 运行时）",
    )
    parser.add_argument(
        "--model", help=(
            f"模型 ID 或本地模型路径（Qwen 默认: {QWEN_DEFAULT_MODEL}；"
            f"FunASR 默认: {FUNASR_DEFAULT_MODEL}；Whisper 默认: {WHISPER_DEFAULT_MODEL}，"
            "也可用 small/turbo 等 HF Hub 名称或已转换的 CTranslate2 目录）"
        ),
    )
    parser.add_argument("--model-path", help="显式指定已经下载好的模型目录")
    parser.add_argument(
        "--device", choices=("auto", "cpu", "cuda"), default="auto",
        help="推理设备（默认: auto，优先 CUDA；不可用时回退 CPU）",
    )
    parser.add_argument(
        "--forced-aligner", default=QWEN_DEFAULT_FORCED_ALIGNER,
        help=f"QwenASR Forced Aligner 模型 ID 或本地路径（默认: {QWEN_DEFAULT_FORCED_ALIGNER}）",
    )
    parser.add_argument(
        "--alignment-model", default="",
        help="为没有字词时间码的转写补齐时间码：qwen3-forced-aligner-0.6b 或 firered-asr2-ctc",
    )
    parser.add_argument(
        "--alignment-model-path", default="",
        help="对齐模型的显式本地目录；不填时使用 MAW 模型缓存",
    )
    parser.add_argument(
        "--alignment-mode", choices=(ALIGNMENT_MODE_FILL, ALIGNMENT_MODE_GENERATE), default=ALIGNMENT_MODE_FILL,
        help="对齐模式：fill 只补缺失项，generate 重新生成全部项（默认: fill）",
    )
    parser.add_argument("--vad-model", help="FunASR 可选 VAD 模型")
    parser.add_argument("--punc-model", help="FunASR 可选标点模型")
    parser.add_argument(
        "--firered-punc",
        choices=("none", "ct-punc"),
        default="ct-punc",
        help="FireRed 是否使用 ct-punc 自动标点（默认: ct-punc）",
    )
    parser.add_argument("--speaker-model", help="FunASR 可选说话人模型")
    parser.add_argument("--speaker-colors", action="store_true", help="为说话人段落生成颜色快照")
    parser.add_argument("--language", help="语言提示，例如 zh 或 en")
    parser.add_argument(
        "--audio-track", type=int, default=0,
        help="使用第几个音频轨道（从 0 开始，默认 0）",
    )
    parser.add_argument("--default-audio-track", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--hotword", action="append", default=[], help="热词，可重复传入")
    parser.add_argument(
        "--hotword-file", action="append", default=[], metavar="FILE",
        help="UTF-8 热词文件，一行一个词；可重复传入",
    )
    parser.add_argument(
        "--batch-size-s", type=int, default=None,
        help=f"长音频分块秒数（Qwen 默认 {QWEN_DEFAULT_CHUNK_SECONDS}；FunASR 默认 300）",
    )
    parser.add_argument("-ll", "--length-limit", type=parse_duration, help="只处理前 N 秒，例如 2m")
    parser.add_argument("-o", "--output", help="输出 SRT 路径（默认与输入同目录）")
    parser.add_argument("--max-len", type=int, default=18, help="中文单条字幕最大字符数")
    parser.add_argument("--min-len", type=int, default=5, help="中文短句合并阈值")
    parser.add_argument("--max-words", type=int, default=DEFAULT_MAX_WORDS, help="英文单条字幕最大单词数")
    parser.add_argument("--min-words", type=int, default=DEFAULT_MIN_WORDS, help="英文短句合并阈值（单词数）")
    parser.add_argument("--gap-split", type=int, default=800, help="静音超过多少毫秒时切句")
    parser.add_argument(
        "--strip-tail-punct", default="，。",
        help="句尾剥除的标点集合；传空串禁用剥除（默认剥逗号和句号）",
    )
    parser.add_argument("--json", action="store_true", help="同时生成 .mosp 工程")
    parser.add_argument("--with-waveform", action="store_true", help="在媒体旁生成 .quapeaks 波形缓存（不再写进工程文件）")
    parser.add_argument(
        "--with-spectral", action="store_true",
        help="在 .ReaPeaks 波形缓存中额外生成频谱数据（需要 --with-waveform）",
    )
    parser.add_argument("--no-html", action="store_true", help="不生成便携 HTML 编辑器")
    parser.add_argument(
        "--debug-raw", action="store_true",
        help="保存本地引擎可用的原始/中间调试产物及清单",
    )
    parser.add_argument(
        "--no-model-tag", action="store_true",
        help="默认输出文件名不附加引擎标识段（默认附加，如 qwen-asr-local）",
    )
    return parser


def default_output_path(
    input_path: Path,
    engine: str,
    *,
    no_model_tag: bool = False,
) -> Path:
    tag = {
        "qwen-asr": "qwen-asr-local",
        "funasr": "funasr-local",
        "moss": "moss-local",
        "whisper": "whisper-local",
        "firered": "firered-local",
    }.get(engine, "local")
    name_parts: list[str] = []
    if not no_model_tag:
        name_parts.append(tag)
    suffix = f".{'.'.join(name_parts)}" if name_parts else ""
    return input_path.with_name(f"{input_path.stem}{suffix}.srt")


def load_hotword_files(paths: Sequence[str]) -> list[str]:
    """Read UTF-8 hotword lists, ignoring blank lines and ``#`` comments."""
    hotwords: list[str] = []
    for raw_path in paths:
        path = Path(raw_path).expanduser()
        for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
            value = raw_line.strip()
            if value and not value.startswith("#") and value not in hotwords:
                hotwords.append(value)
    return hotwords


def main(argv: Sequence[str] | None = None) -> int:
    configure_utf8_stdio()
    args = build_parser().parse_args(argv)
    input_path = Path(args.input).expanduser().resolve()
    if not input_path.exists() or not input_path.is_file():
        print(f"错误: 输入文件不存在: {input_path}")
        return 2
    if args.batch_size_s is not None and args.batch_size_s <= 0:
        print("错误: --batch-size-s 必须大于 0")
        return 2
    if args.length_limit is not None and args.length_limit <= 0:
        print("错误: --length-limit 必须大于 0")
        return 2
    if args.audio_track < 0:
        print("错误: --audio-track 必须是非负整数")
        return 2
    if args.default_audio_track is not None and args.default_audio_track < 0:
        print("错误: --default-audio-track 必须是非负整数")
        return 2
    if args.max_len < 1 or args.min_len < 1 or args.max_words < 1 or args.min_words < 1 or args.gap_split < 0:
        print("错误: 字幕切分参数无效")
        return 2
    if args.max_len < args.min_len or args.max_words < args.min_words:
        print("错误: 最大值不能小于对应的短句合并阈值")
        return 2
    if args.with_waveform and not args.json:
        print("错误: --with-waveform 需要同时指定 --json")
        return 2
    if args.with_spectral and not args.with_waveform:
        print("错误: --with-spectral 需要同时指定 --with-waveform")
        return 2
    try:
        file_hotwords = load_hotword_files(args.hotword_file)
    except OSError as error:
        print(f"错误: 无法读取热词文件: {error}")
        return 2
    hotwords = list(dict.fromkeys([*args.hotword, *file_hotwords]))
    batch_size_s = args.batch_size_s
    if batch_size_s is None:
        batch_size_s = QWEN_DEFAULT_CHUNK_SECONDS if args.engine == "qwen-asr" else 300

    output_arg = Path(args.output).expanduser().resolve() if args.output else None
    output_srt = output_arg or default_output_path(
        input_path,
        args.engine,
        no_model_tag=args.no_model_tag,
    )
    debug_writer = (
        LocalDebugWriter(output_srt, engine=args.engine, model=args.model or args.engine)
        if args.debug_raw
        else None
    )
    ffmpeg_tools = resolve_ffmpeg_tools()
    ffmpeg_path = ffmpeg_tools.ffmpeg
    ffprobe_path = ffmpeg_tools.ffprobe
    default_audio_track = resolve_default_audio_track(
        input_path,
        args.default_audio_track,
        ffprobe_path=ffprobe_path,
    )
    engine = create_local_engine(
        args.engine,
        model=args.model,
        model_path=args.model_path,
        device=args.device,
        forced_aligner=args.forced_aligner,
        vad_model=args.vad_model,
        punc_model=args.punc_model,
        speaker_model=args.speaker_model,
        use_punc=args.firered_punc == "ct-punc",
        debug_writer=debug_writer.write if debug_writer else None,
    )
    if debug_writer:
        debug_writer.model = str(getattr(engine, "model", "") or args.model or args.engine)

    try:
        with prepared_audio(
            input_path,
            args.length_limit,
            on_event=print,
            ffmpeg_path=ffmpeg_path,
            ffprobe_path=ffprobe_path,
            audio_track=args.audio_track,
        ) as (audio_path, duration_ms):
            duration_sec = duration_ms / 1000.0
            print(f"转写开始: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            t0 = time.perf_counter()
            result = engine.transcribe(
                audio_path,
                language=args.language,
                batch_size_s=batch_size_s,
                hotwords=hotwords,
                on_event=print,
                ffmpeg_path=ffmpeg_path,
                ffprobe_path=ffprobe_path,
            )
            if debug_writer:
                debug_writer.write_transcription("local-transcription", result)
            if args.alignment_model:
                from maw.timestamp_alignment import align_local_transcription

                if debug_writer:
                    debug_writer.write_transcription("alignment-before", result)
                print(f"字词时间码对齐开始：{args.alignment_model}（{args.alignment_mode}）")
                result = align_local_transcription(
                    result,
                    audio_path=audio_path,
                    model_id=args.alignment_model,
                    mode=args.alignment_mode,
                    model_path=args.alignment_model_path,
                    device=args.device,
                    ffmpeg_path=ffmpeg_path,
                    on_event=print,
                )
                if debug_writer:
                    debug_writer.write_transcription("alignment-after", result)
            elapsed = time.perf_counter() - t0
            print(f"转写结束: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            rtf = (elapsed / duration_sec) if duration_sec > 0 else 0.0
            segments = build_local_segments(
                result,
                duration_ms=duration_ms,
                max_len=args.max_len,
                min_len=args.min_len,
                gap_split_ms=args.gap_split,
                max_words=args.max_words,
                min_words=args.min_words,
                strip_tail_punct=args.strip_tail_punct,
            )
            if args.speaker_colors:
                from maw.speaker import apply_speaker_colors

                apply_speaker_colors(segments)
            if not segments:
                print("错误: 本地模型没有返回可用的转写文本")
                return 1
            if debug_writer:
                debug_writer.write(
                    "segments",
                    {
                        "transcription": transcription_payload(result),
                        "segments": segments,
                    },
                )
            outputs = write_local_outputs(
                input_path=input_path,
                cache_media_path=audio_path,
                output_srt=output_srt,
                transcription=result,
                segments=segments,
                write_json=args.json,
                generate_html=args.json and not args.no_html,
                with_waveform=args.with_waveform,
                generate_spectral=args.with_spectral,
                ffmpeg_path=ffmpeg_path,
                ffprobe_path=ffprobe_path,
                audio_track=args.audio_track,
                default_audio_track=default_audio_track,
            )
            if debug_writer:
                debug_manifest = debug_writer.write_manifest(
                    outputs={
                        "srt": outputs.srt,
                        "mosp": outputs.json or "",
                        "html": outputs.html or "",
                    }
                )
                print(f"本地调试清单已保存: {debug_manifest}")
                for stage, artifact in debug_writer.artifacts.items():
                    print(f"本地调试产物 [{stage}] 已保存: {artifact}")
    except Exception as error:  # noqa: BLE001 - CLI boundary prints actionable error.
        print(f"错误: {error}")
        return 1

    print(f"SRT 已保存: {outputs.srt}")
    if outputs.json:
        print(f"工程已保存: {outputs.json}")
    if outputs.html:
        print(f"HTML 已保存: {outputs.html}")
    print(f"字幕段数: {len(segments)}")
    print(f"转写耗时: {format_elapsed(elapsed)}")
    if duration_sec > 0:
        print(f"媒体时长: {format_elapsed(duration_sec)}")
        print(f"转写时长为媒体时长的 {rtf:.2f} 倍")
        print(f"实际 RTF: {rtf:.3f} ({(1 / rtf):.1f}x 实时)" if rtf > 0 else f"实际 RTF: {rtf:.3f}")
    maw_stat = format_maw_stat(rtf)
    if maw_stat:
        print(maw_stat)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
