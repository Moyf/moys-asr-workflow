# pyright: reportAny=false, reportUnusedCallResult=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

import argparse
import importlib
import sys
from collections.abc import Sequence
from pathlib import Path


_INTERNAL_FLAGS = frozenset(
    {
        "--smoke-import",
        "--transcribe",
        "--transcribe-soniox",
        "--transcribe-local",
        "--transcribe-bcut",
        "--serve",
    }
)
_GUI_DEBUG_FLAGS = frozenset({"-dbg", "--debug", "-dt", "--devtools"})


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
        "--transcribe-local",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--transcribe-bcut",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "-dbg",
        "--debug",
        action="store_true",
        help="开启 Launcher 的 pywebview 调试能力",
    )
    parser.add_argument(
        "-dt",
        "--devtools",
        action="store_true",
        help="启动 Launcher 后自动打开 DevTools（同时开启调试）",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    if raw_argv and not _is_gui_debug_invocation(raw_argv) and raw_argv[0] not in _INTERNAL_FLAGS:
        from maw.cli import main as cli_main

        return cli_main(raw_argv)

    args, rest = build_parser().parse_known_args(raw_argv)
    if args.smoke_import:
        return 0
    if args.transcribe:
        return _run_internal_transcribe(rest)
    if args.transcribe_soniox:
        return _run_internal_transcribe_soniox(rest)
    if args.transcribe_local:
        return _run_internal_transcribe_local(rest)
    if args.transcribe_bcut:
        return _run_internal_transcribe_bcut(rest)
    if args.serve:
        return _run_internal_serve(rest)

    from maw.gui_web import run_app

    run_app(debug=args.debug or args.devtools, devtools=args.devtools)
    return 0


def _is_gui_debug_invocation(argv: Sequence[str]) -> bool:
    return bool(argv) and all(argument in _GUI_DEBUG_FLAGS for argument in argv)


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


def _run_internal_transcribe_local(argv: Sequence[str]) -> int:
    import generate_subtitle_local

    old_argv = sys.argv[:]
    try:
        sys.argv = ["generate_subtitle_local.py", *argv]
        result = generate_subtitle_local.main()
    finally:
        sys.argv = old_argv
    return 0 if result is None else int(result)


def _run_internal_transcribe_bcut(argv: Sequence[str]) -> int:
    import generate_subtitle_bcut_api

    old_argv = sys.argv[:]
    try:
        sys.argv = ["generate_subtitle_bcut_api.py", *argv]
        result = generate_subtitle_bcut_api.main()
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
