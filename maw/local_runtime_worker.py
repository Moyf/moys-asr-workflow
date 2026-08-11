"""Small helper executed by the user-managed local ASR Python environment."""

from __future__ import annotations

import argparse
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

from maw.local_asr import create_local_engine


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
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
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
