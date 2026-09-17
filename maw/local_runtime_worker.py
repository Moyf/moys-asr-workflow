"""Small helper executed by the user-managed local ASR Python environment."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path

# When Python executes a file by path, sys.path starts with the file's
# directory (the bundled ``maw`` package), not the directory containing it.
# Add that package root so this helper works in both source and packaged
# ``local-runtime`` layouts.
_BUNDLE_ROOT = Path(__file__).resolve().parents[1]
if str(_BUNDLE_ROOT) not in sys.path:
    sys.path.insert(0, str(_BUNDLE_ROOT))

from maw.console import configure_utf8_stdio  # noqa: E402
from maw.local_asr import create_local_engine  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MAW local runtime helper")
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("--engine", required=True)
    prepare.add_argument("--model", required=True)
    prepare.add_argument("--model-path", default="")
    prepare.add_argument("--device", default="auto")
    prepare.add_argument("--forced-aligner", default="")
    prepare.add_argument("--vad-model", default="")
    prepare.add_argument("--punc-model", default="")
    prepare.add_argument("--speaker-model", default="")
    prepare.add_argument("--trust-remote-code", action="store_true")
    prepare_aligner = subparsers.add_parser("prepare-aligner")
    prepare_aligner.add_argument("--model-id", required=True)
    prepare_aligner.add_argument("--model-path", default="")
    timestamp_align = subparsers.add_parser("timestamp-align")
    timestamp_align.add_argument("--project-path", default="")
    timestamp_align.add_argument("--srt-path", default="")
    timestamp_align.add_argument("--media-path", default="")
    timestamp_align.add_argument("--model-id", required=True)
    timestamp_align.add_argument("--output-mode", default="both")
    timestamp_align.add_argument("--alignment-mode", default="fill")
    timestamp_align.add_argument("--model-path", default="")
    timestamp_align.add_argument("--output-directory", default="")
    timestamp_align.add_argument("--device", default="auto")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    configure_utf8_stdio()
    args = build_parser().parse_args(argv)
    if args.command == "prepare-aligner":
        from maw.alignment_models import prepare_alignment_model

        prepare_alignment_model(
            args.model_id,
            model_path=args.model_path,
            on_event=print,
        )
        print("[local] 对齐模型组件准备完成。")
        return 0
    if args.command == "timestamp-align":
        from maw.alignment_models import resolve_model_cache_root
        from maw.timestamp_alignment import TimestampAlignmentRequest, run_timestamp_alignment

        artifact, report = run_timestamp_alignment(
            TimestampAlignmentRequest(
                project_path=Path(args.project_path) if args.project_path else None,
                srt_path=Path(args.srt_path) if args.srt_path else None,
                media_path=Path(args.media_path) if args.media_path else None,
                model_id=args.model_id,
                output_mode=args.output_mode,
                mode=args.alignment_mode,
                model_path=Path(args.model_path) if args.model_path else None,
                model_cache_root=resolve_model_cache_root(),
                device=args.device,
                output_directory=Path(args.output_directory) if args.output_directory else None,
            )
        )
        print(json.dumps({
            "type": "result",
            "artifact": {
                "sourceProjectPath": str(artifact.source_project_path or ""),
                "sourceSrtPath": str(artifact.source_srt_path or ""),
                "projectPath": str(artifact.project_path or ""),
                "srtPath": str(artifact.srt_path or ""),
                "translatedSrtPath": str(artifact.translated_srt_path or ""),
                "warnings": list(artifact.warnings),
            },
            "report": report.to_payload(),
        }, ensure_ascii=False))
        return 0
    if args.command != "prepare":
        return 2
    engine = create_local_engine(
        args.engine,
        model=args.model,
        model_path=args.model_path or None,
        device=args.device,
        forced_aligner=args.forced_aligner or None,
        vad_model=args.vad_model or None,
        punc_model=args.punc_model or None,
        speaker_model=args.speaker_model or None,
        trust_remote_code=args.trust_remote_code,
    )
    loader = getattr(engine, "_load", None)
    if not callable(loader):
        raise RuntimeError("本地模型运行时不支持预加载")
    loader(print)
    print("[local] 模型组件准备完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
