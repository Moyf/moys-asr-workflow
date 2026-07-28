# pyright: reportAny=false, reportUnusedCallResult=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

import argparse
import importlib
import sys
from collections.abc import Sequence
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Moy's ASR Workflow GUI")
    parser.add_argument("--smoke-import", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--transcribe",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--transcribe-soniox",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--tk",
        action="store_true",
        help="Launch the legacy tkinter GUI instead of the webview launcher.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args, rest = build_parser().parse_known_args(argv)
    if args.smoke_import:
        return 0
    if args.transcribe:
        return _run_internal_transcribe(rest)
    if args.transcribe_soniox:
        return _run_internal_transcribe_soniox(rest)
    if args.serve:
        return _run_internal_serve(rest)
    if args.tk:
        from maw.gui import run_app
    else:
        from maw.gui_web import run_app

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


def _run_internal_transcribe_soniox(argv: Sequence[str]) -> int:
    import generate_subtitle_soniox_api

    old_argv = sys.argv[:]
    try:
        sys.argv = ["generate_subtitle_soniox_api.py", *argv]
        result = generate_subtitle_soniox_api.main()
    finally:
        sys.argv = old_argv
    return 0 if result is None else int(result)


def _run_internal_serve(argv: Sequence[str]) -> int:
    server_dir = Path(__file__).resolve().parent / "server-editor"
    if str(server_dir) not in sys.path:
        sys.path.insert(0, str(server_dir))
    serve = importlib.import_module("serve")

    old_argv = sys.argv[:]
    try:
        sys.argv = ["serve.py", *argv]
        result = serve.main()
    finally:
        sys.argv = old_argv
    return 0 if result is None else int(result)


if __name__ == "__main__":
    raise SystemExit(main())
