"""Local QwenASR / FunASR -> SRT + MAW project CLI.

This remains a source-mode first step.  Model packages are optional; the
Launcher only routes to this CLI and lets the upstream runtime prepare its
cache, rather than bundling a model manager into the application.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

from maw.local_asr import (
    FUNASR_DEFAULT_MODEL,
    QWEN_DEFAULT_CHUNK_SECONDS,
    QWEN_DEFAULT_FORCED_ALIGNER,
    QWEN_DEFAULT_MODEL,
    build_local_segments,
    create_local_engine,
    parse_duration,
    prepared_audio,
    write_local_outputs,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="使用本地 QwenASR 或 FunASR 生成 MAW 字幕工程",
    )
    parser.add_argument("input", help="输入视频或音频文件路径")
    parser.add_argument(
        "--engine", choices=("qwen-asr", "funasr"), default="qwen-asr",
        help="本地推理引擎（默认: qwen-asr）",
    )
    parser.add_argument(
        "--model", help=f"模型 ID 或本地模型路径（Qwen 默认: {QWEN_DEFAULT_MODEL}；FunASR 默认: {FUNASR_DEFAULT_MODEL}）",
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
    parser.add_argument("--vad-model", help="FunASR 可选 VAD 模型")
    parser.add_argument("--punc-model", help="FunASR 可选标点模型")
    parser.add_argument("--speaker-model", help="FunASR 可选说话人模型")
    parser.add_argument("--language", help="语言提示，例如 zh 或 en")
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
    parser.add_argument("--max-len", type=int, default=21, help="中文单条字幕最大字符数")
    parser.add_argument("--min-len", type=int, default=5, help="中文短句合并阈值")
    parser.add_argument("--gap-split", type=int, default=1000, help="静音超过多少毫秒时切句")
    parser.add_argument("--json", action="store_true", help="同时生成 .mosp 工程")
    parser.add_argument("--with-waveform", action="store_true", help="把波形缓存嵌入 .mosp")
    parser.add_argument("--no-html", action="store_true", help="不生成便携 HTML 编辑器")
    return parser


def default_output_path(input_path: Path, engine: str) -> Path:
    tag = "qwen-asr-local" if engine == "qwen-asr" else "funasr-local"
    return input_path.with_name(f"{input_path.stem}.{tag}.srt")


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
    if args.with_waveform and not args.json:
        print("错误: --with-waveform 需要同时指定 --json")
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

    output_srt = Path(args.output).expanduser().resolve() if args.output else default_output_path(input_path, args.engine)
    engine = create_local_engine(
        args.engine,
        model=args.model,
        model_path=args.model_path,
        device=args.device,
        forced_aligner=args.forced_aligner,
        vad_model=args.vad_model,
        punc_model=args.punc_model,
        speaker_model=args.speaker_model,
    )

    try:
        with prepared_audio(input_path, args.length_limit, on_event=print) as (audio_path, duration_ms):
            result = engine.transcribe(
                audio_path,
                language=args.language,
                batch_size_s=batch_size_s,
                hotwords=hotwords,
                on_event=print,
            )
            segments = build_local_segments(
                result,
                duration_ms=duration_ms,
                max_len=args.max_len,
                min_len=args.min_len,
                gap_split_ms=args.gap_split,
            )
            if not segments:
                print("错误: 本地模型没有返回可用的转写文本")
                return 1
            outputs = write_local_outputs(
                input_path=input_path,
                cache_media_path=audio_path,
                output_srt=output_srt,
                transcription=result,
                segments=segments,
                write_json=args.json,
                generate_html=args.json and not args.no_html,
                with_waveform=args.with_waveform,
            )
    except Exception as error:  # noqa: BLE001 - CLI boundary prints actionable error.
        print(f"错误: {error}")
        return 1

    print(f"SRT 已保存: {outputs.srt}")
    if outputs.json:
        print(f"工程已保存: {outputs.json}")
    if outputs.html:
        print(f"HTML 已保存: {outputs.html}")
    print(f"字幕段数: {len(segments)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
