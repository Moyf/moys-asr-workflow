# pyright: reportAny=false, reportUnusedCallResult=false

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Moy's ASR Workflow GUI")
    parser.add_argument("--smoke-import", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--transcribe",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args, rest = build_parser().parse_known_args(argv)
    if args.smoke_import:
        return 0
    if args.transcribe:
        return _run_internal_transcribe(rest)
    from maw.gui import run_app

    run_app()
    return 0


def _run_internal_transcribe(argv: Sequence[str]) -> int:
    import generate_subtitle_qwen_api

    old_argv = sys.argv[:]
    try:
        sys.argv = ["generate_subtitle_qwen_api.py", *argv]
        result = generate_subtitle_qwen_api.main()
    finally:
        sys.argv = old_argv
    return 0 if result is None else int(result)


if __name__ == "__main__":
    raise SystemExit(main())
