# pyright: reportAny=false, reportUnusedCallResult=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

import argparse
import importlib
import importlib.util
import sys
import traceback
from collections.abc import Sequence
from pathlib import Path

from maw.app_paths import default_log_directory
from maw.console import configure_utf8_stdio


_INTERNAL_FLAGS = frozenset(
    {
        "--smoke-import",
        "--transcribe",
        "--transcribe-soniox",
        "--transcribe-local",
        "--transcribe-bcut",
        "--transcribe-tencent",
        "--serve",
        "--serve-alignment",
    }
)
_TRANSCRIPTION_FLAGS = frozenset(
    {
        "--transcribe",
        "--transcribe-soniox",
        "--transcribe-local",
        "--transcribe-bcut",
        "--transcribe-tencent",
    }
)
_GUI_DEBUG_FLAGS = frozenset({"-dbg", "--debug", "-dt", "--devtools"})
_WINDOWS_BLOCKED_RUNTIME_MARKERS = (
    "python.runtime.loader.initialize",
    "python.runtime.dll",
)


def _gui_port_value(value: str) -> int:
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("端口必须是 1 到 65535 之间的整数") from error
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("端口必须是 1 到 65535 之间的整数")
    return port


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
    parser.add_argument("--transcribe-tencent", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--serve",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--serve-alignment",
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
    parser.add_argument(
        "--port",
        dest="debug_port",
        type=_gui_port_value,
        help="调试 Launcher 时默认使用的本机编辑器端口",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    configure_utf8_stdio()
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
    if args.transcribe_tencent:
        return _run_internal_transcribe_tencent(rest)
    if args.serve:
        return _run_internal_serve(rest)
    if args.serve_alignment:
        return _run_internal_alignment_serve(rest)

    from maw.gui_web import run_app

    if args.debug_port is None:
        run_app(debug=args.debug or args.devtools, devtools=args.devtools)
    else:
        run_app(debug=args.debug or args.devtools, devtools=args.devtools, server_port=args.debug_port)
    return 0


def run_entrypoint(argv: Sequence[str] | None = None) -> int:
    """Handle only the two known frozen-package failures at the executable boundary.

    This is deliberately a narrow boundary.  PyInstaller's native traceback is
    useful for every other GUI, server, and CLI failure, so unknown exceptions
    must continue through unchanged.
    """
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    try:
        return main(raw_argv)
    except Exception as error:  # noqa: BLE001 - final executable boundary
        if _is_gui_invocation(raw_argv):
            if not _is_windows_blocked_runtime_error(error):
                if sys.platform == "win32":
                    _show_unknown_startup_hint()
                raise
            log_path = _write_startup_error_log(error)
            _show_startup_error(error, log_path)
            return 1
        if _is_transcription_invocation(raw_argv) and _is_ffmpeg_missing_error(error):
            print(f"错误：{_friendly_child_error(error)}", file=sys.stderr)
            return 1
        raise


def _is_gui_invocation(argv: Sequence[str]) -> bool:
    return not argv or _is_gui_debug_invocation(argv)


def _is_transcription_invocation(argv: Sequence[str]) -> bool:
    return bool(argv) and argv[0] in _TRANSCRIPTION_FLAGS


def _is_windows_blocked_runtime_error(error: Exception) -> bool:
    if sys.platform != "win32":
        return False
    detail = str(error).casefold()
    return any(marker in detail for marker in _WINDOWS_BLOCKED_RUNTIME_MARKERS)


def _show_unknown_startup_hint() -> None:
    """Give Windows users a short owner/FAQ route before the native traceback."""
    if sys.platform != "win32":
        return
    message = (
        "MAW 启动时遇到未识别错误。\n\n"
        "此提示不会替代随后出现的完整错误信息。请先查看发布包内的 FAQ-常见问题.txt；"
        "如仍无法解决，可前往项目 Issue 页面反馈：\n"
        "https://github.com/Moyf/moys-asr-workflow/issues/new\n\n"
        "随后将保留并显示原始错误详情。"
    )
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, message, "MAW 启动失败", 0x10)
    except (AttributeError, OSError):
        pass


def _is_ffmpeg_missing_error(error: Exception) -> bool:
    """Return true only for an explicit missing FFmpeg/FFprobe executable.

    A generic ``FileNotFoundError`` is commonly a missing media/config file and
    must not be presented as an FFmpeg problem.  Require either the executable
    name as the exception filename, or an explicit WinError/not-found message
    that names one of the two tools.
    """
    detail = str(error).casefold()
    filename = Path(str(getattr(error, "filename", "") or "")).name.casefold()
    if filename in {"ffmpeg", "ffmpeg.exe", "ffprobe", "ffprobe.exe"}:
        return True
    mentions_tool = "ffmpeg" in detail or "ffprobe" in detail
    if not mentions_tool:
        return False
    return any(
        marker in detail
        for marker in (
            "[winerror 2]",
            "system cannot find",
            "系统找不到指定的文件",
            "not found",
            "找不到",
        )
    )


def _friendly_child_error(error: Exception) -> str:
    detail = str(error).strip()
    filename = Path(str(getattr(error, "filename", "") or "")).name.casefold()
    if isinstance(error, FileNotFoundError) and filename in {"ffmpeg", "ffmpeg.exe", "ffprobe", "ffprobe.exe"}:
        return (
            "找不到 FFmpeg / FFprobe。请下载不带 lite 的完整 MAW；"
            "或安装 FFmpeg，并确保 ffmpeg 与 ffprobe 均可用。"
        )
    return detail or error.__class__.__name__


def _startup_error_log_path() -> Path:
    """Return the shared MAW startup diagnostics path."""
    return default_log_directory() / "launcher-startup.log"


def _startup_error_fallback_log_path() -> Path:
    """Return the shared MAW startup diagnostics path."""
    return default_log_directory() / "launcher-startup.log"


def _write_startup_error_log(error: Exception) -> Path | None:
    content = "".join(traceback.format_exception(type(error), error, error.__traceback__))
    paths = [_startup_error_log_path()]
    fallback = _startup_error_fallback_log_path()
    if fallback not in paths:
        paths.append(fallback)
    for path in paths:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
        except OSError:
            continue
        return path
    return None


def _startup_error_message(error: Exception, log_path: Path | None = None) -> str:
    detail = str(error).strip()
    if any(marker in detail.casefold() for marker in _WINDOWS_BLOCKED_RUNTIME_MARKERS):
        message = (
            "MAW 的运行组件被 Windows 阻止加载。\n\n"
            "请按以下步骤处理：\n"
            "1. 退出 MAW，并找到最初下载的 MAW ZIP 压缩包。\n"
            "2. 右键 ZIP → 属性 → 勾选“解除锁定”→ 应用。\n"
            "3. 删除当前解压目录，再从已解除锁定的 ZIP 完整解压。\n"
            "4. 保留 MAW.exe、_internal 和 bootstrap 在同一目录中。\n\n"
            "若仍无法启动，请查看发布包内的 FAQ-常见问题.txt。"
        )
    else:
        summary = detail or error.__class__.__name__
        message = f"MAW 启动失败：{summary}\n\n请查看发布包内的 FAQ-常见问题.txt。"
    if log_path is not None:
        message += f"\n\n诊断日志：{log_path}"
    return message


def _show_startup_error(error: Exception, log_path: Path | None = None) -> None:
    message = _startup_error_message(error, log_path)
    if sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(None, message, "MAW 启动失败", 0x10)
            return
        except (AttributeError, OSError):
            pass
    print(message, file=sys.stderr)


def _is_gui_debug_invocation(argv: Sequence[str]) -> bool:
    if not argv or not any(argument in _GUI_DEBUG_FLAGS for argument in argv):
        return False
    expects_port = False
    for argument in argv:
        if expects_port:
            expects_port = False
            continue
        if argument == "--port" or argument.startswith("--port="):
            expects_port = argument == "--port"
            continue
        if argument not in _GUI_DEBUG_FLAGS:
            return False
    return not expects_port


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


def _run_internal_transcribe_tencent(argv: Sequence[str]) -> int:
    import generate_subtitle_tencent_api

    old_argv = sys.argv[:]
    try:
        sys.argv = ["generate_subtitle_tencent_api.py", *argv]
        result = generate_subtitle_tencent_api.main()
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


def _run_internal_alignment_serve(argv: Sequence[str]) -> int:
    server_path = Path(__file__).resolve().parent / "server-align" / "serve.py"
    spec = importlib.util.spec_from_file_location("_maw_alignment_server", server_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载口播对齐 Server：{server_path}")
    serve = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = serve
    spec.loader.exec_module(serve)

    old_argv = sys.argv[:]
    try:
        sys.argv = ["serve.py", *argv]
        result = serve.main()
    finally:
        sys.argv = old_argv
    return 0 if result is None else int(result)


if __name__ == "__main__":
    raise SystemExit(run_entrypoint())
