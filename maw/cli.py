# pyright: reportAny=false, reportMissingImports=false, reportUnknownArgumentType=false, reportUnknownMemberType=false

from __future__ import annotations

import argparse
import ctypes
import io
import json
import os
import sys
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from maw.gui_config import DEFAULT_MODEL_ID
from maw.gui_platform import asset_path
from maw.gui_workflow import (
    _child_environment,
    default_srt_path,
    render_editor_html,
)


DEFAULT_SERVER_PORT = 8250
_WINDOWS_STD_OUTPUT = -11
_WINDOWS_STD_ERROR = -12
_INVALID_HANDLE_VALUE = -1


def _port_value(value: str) -> int:
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("端口必须是 1 到 65535 之间的整数") from error
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("端口必须是 1 到 65535 之间的整数")
    return port


def build_parser(prog: str | None = None) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=prog or Path(sys.argv[0]).name,
        description="MAW 命令行：直接转写媒体，或启动/停止本机字幕编辑器 Server。",
        epilog=(
            "示例:\n"
            "  MAW.exe -i \"clip.mp3\" -o \"clip.srt\" \"clip.mosp\"\n"
            "  MAW.exe --provider soniox -i \"clip.mp4\" -o \"clip.srt\"\n"
            "  MAW.exe --server 8250\n"
            "  MAW.exe --stop-server 8250\n"
            "\n"
            "API Key 仍从环境变量或 MAW 本机 .env 读取，不要把密钥写进命令行。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    server_group = parser.add_mutually_exclusive_group()
    server_group.add_argument(
        "--server",
        nargs="?",
        const="",
        metavar="PORT",
        help="启动本机 Server；可写 --server 8250，省略端口时使用 8250",
    )
    server_group.add_argument(
        "--stop-server",
        nargs="?",
        const="",
        metavar="PORT",
        help="停止指定端口上的 MAW Server；省略端口时使用 8250",
    )
    parser.add_argument("--port", type=_port_value, help="用 --server/--stop-server 指定端口的另一种写法")
    parser.add_argument("server_project", nargs="?", metavar="PROJECT", help="Server 启动时打开的 .mosp/.json 工程")
    parser.add_argument("--media", dest="server_media", help="Server 工程的媒体路径覆盖")
    parser.add_argument("-s", "--stickers", help="表情包目录（Server 或工程 HTML 使用）")
    parser.add_argument("--no-open", action="store_true", help="启动 Server 后不自动打开浏览器")
    parser.add_argument("--no-waveform", action="store_true", help="Server 启动时跳过波形预计算")
    parser.add_argument("--waveform-peaks-per-second", type=int, help="Server 波形峰值密度")

    parser.add_argument("-i", "--input", help="要转写的音频或视频路径")
    parser.add_argument(
        "-o",
        "--output",
        dest="outputs",
        nargs="+",
        metavar="OUTPUT",
        help="输出路径：第一个是 SRT，第二个可选路径是 .mosp；省略时按输入自动命名",
    )
    parser.add_argument("--mosp", dest="mosp_output", help="单独指定 .mosp 工程输出路径（等价于 -o SRT MOSP 的第二个路径）")
    parser.add_argument("--provider", choices=("qwen", "soniox", "bcut"), default="qwen", help="ASR 供应商（默认 qwen；bcut 为免 Key 实验性接口，仅中文）")
    parser.add_argument("--model", help="覆盖当前供应商的 ASR 模型")
    parser.add_argument("--max-len", type=int, help="每条字幕最大字数")
    parser.add_argument("--min-len", type=int, help="句号间最短字数")
    parser.add_argument("--language", help="语言提示；Soniox 可写逗号分隔的多个语言")
    parser.add_argument("--keep-punct", action="store_true", help="保留字幕末尾的逗号和句号")
    parser.add_argument("--gap-split", type=int, help="静音切句阈值（毫秒）")
    parser.add_argument("--speaker", action="store_true", help="开启说话人分离")
    parser.add_argument("--speaker-colors", action="store_true", help="开启说话人分离并写入字幕颜色快照")
    parser.add_argument("-ll", "--length-limit", help="只处理媒体前 N 时长，例如 2m、20s、1h")
    parser.add_argument("--json", dest="json_output", action="store_true", help="兼容旧 CLI；MAW CLI 默认总是生成 .mosp")
    parser.add_argument("--with-waveform", action="store_true", help="把波形峰值写入 .mosp 工程")
    html_group = parser.add_mutually_exclusive_group()
    html_group.add_argument("--html", action="store_true", help="额外生成便携 .edit.html（默认不生成）")
    html_group.add_argument("--no-html", dest="no_html", action="store_true", help="兼容旧 CLI；默认行为就是不生成 HTML")
    parser.add_argument("--debug", action="store_true", help="输出 API 调试信息")

    parser.add_argument("--region", help="Qwen 地域，例如 beijing 或 singapore")
    parser.add_argument("--workspace-id", help="Qwen Workspace ID；也可放在 .env")
    parser.add_argument("--file-url", help="Qwen 已上传文件的公网/OSS URL")
    parser.add_argument("--vocabulary-id", help="Qwen 预编译词表 ID")
    parser.add_argument("--hotword", action="append", help="Qwen 即时热词；可重复传入")
    parser.add_argument("--hotword-file", help="Qwen 即时热词 UTF-8 文本文件")
    parser.add_argument("--hotword-weight", help="Qwen 即时热词权重（1-5 或 50）")
    parser.add_argument("--context", help="Qwen-Audio context，最多 400 字符")
    parser.add_argument("--context-file", help="从 UTF-8 文件读取 Qwen-Audio context")
    parser.add_argument(
        "--soniox-context-json",
        help="Soniox context JSON（general/text/terms/translation_terms，约 10000 字符以内）",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    prepare_cli_stdio()
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.server is not None:
        return _run_server(parser, args)
    if args.stop_server is not None:
        return _run_stop_server(parser, args)
    return _run_transcription(parser, args)


def prepare_cli_stdio() -> None:
    """Make help/errors usable when the GUI PyInstaller bootloader has no streams."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    if os.name == "nt":
        if sys.stdout is None:
            sys.stdout = _windows_stream(_WINDOWS_STD_OUTPUT)
        if sys.stderr is None:
            sys.stderr = _windows_stream(_WINDOWS_STD_ERROR)
        if sys.stdout is None or sys.stderr is None:
            _attach_parent_console()
            if sys.stdout is None:
                sys.stdout = _open_console_stream()
            if sys.stderr is None:
                sys.stderr = _open_console_stream()
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8", errors="replace")
    if sys.stderr is None:
        sys.stderr = sys.stdout


def _windows_stream(handle_number: int) -> io.TextIOBase | None:
    try:
        import msvcrt

        handle = ctypes.windll.kernel32.GetStdHandle(handle_number)
        if handle in (0, _INVALID_HANDLE_VALUE):
            return None
        fd = msvcrt.open_osfhandle(handle, os.O_WRONLY | os.O_BINARY)
        return os.fdopen(fd, "w", encoding="utf-8", errors="replace", buffering=1, closefd=False)
    except (AttributeError, OSError, ValueError):
        return None


def _attach_parent_console() -> None:
    try:
        ctypes.windll.kernel32.AttachConsole(-1)
    except (AttributeError, OSError):
        return


def _open_console_stream() -> io.TextIOBase | None:
    try:
        return open("CONOUT$", "w", encoding="utf-8", errors="replace")
    except OSError:
        return None


def _run_transcription(parser: argparse.ArgumentParser, args: argparse.Namespace) -> int:
    if not args.input:
        parser.error("转写必须提供 -i/--input；启动 Server 请使用 --server")
    if args.port is not None or args.server_project or args.server_media or args.no_open or args.no_waveform or args.waveform_peaks_per_second is not None:
        parser.error("--port、Server 工程和 Server 专用参数只能与 --server/--stop-server 一起使用")
    if args.outputs and len(args.outputs) > 2:
        parser.error("-o/--output 最多接受两个路径：SRT 和 MOSP")
    if args.outputs and args.mosp_output:
        parser.error("请在 -o/--output 的第二个路径和 --mosp 中选择一个工程输出路径")
    if args.provider == "soniox" and (
        any(
            value is not None
            for value in (
                args.region,
                args.workspace_id,
                args.file_url,
                args.vocabulary_id,
                args.hotword_file,
                args.hotword_weight,
                args.context,
                args.context_file,
            )
        )
        or args.hotword
    ):
        parser.error("--provider soniox 不支持 Qwen 专用的地域、词表、热词、context 或 file-url 参数")
    if args.provider == "bcut" and (
        any(
            value is not None
            for value in (
                args.region,
                args.workspace_id,
                args.file_url,
                args.vocabulary_id,
                args.hotword_file,
                args.hotword_weight,
                args.context,
                args.context_file,
                args.model,
                args.language,
            )
        )
        or args.hotword
        or args.speaker
        or args.speaker_colors
        ):
        parser.error("--provider bcut 不支持语言、模型、说话人、地域、词表、热词、context 或 file-url 参数")
    if args.provider == "qwen" and args.soniox_context_json is not None:
        parser.error("--soniox-context-json 仅适用于 --provider soniox")

    input_path = Path(args.input).expanduser()
    if args.outputs:
        srt_path = Path(args.outputs[0]).expanduser().resolve()
        mosp_path = Path(args.outputs[1]).expanduser().resolve() if len(args.outputs) == 2 else None
    else:
        srt_path = default_srt_path(
            input_path,
            provider=args.provider,
            model=args.model or DEFAULT_MODEL_ID,
        ).resolve()
        mosp_path = None
    if args.mosp_output:
        mosp_path = Path(args.mosp_output).expanduser().resolve()
    srt_path.parent.mkdir(parents=True, exist_ok=True)
    expected_mosp = srt_path.with_suffix(".mosp")
    final_mosp = mosp_path or expected_mosp
    final_mosp.parent.mkdir(parents=True, exist_ok=True)

    generator_args = _generator_args(args, input_path, srt_path)
    with _runtime_environment(args.workspace_id):
        result = _invoke_generator(args.provider, generator_args)
    if result != 0:
        return result
    if not srt_path.is_file() or not expected_mosp.is_file():
        print("转写返回成功，但没有生成预期的 SRT/.mosp 文件", file=sys.stderr)
        return 1
    if final_mosp != expected_mosp:
        expected_mosp.replace(final_mosp)
    if args.html:
        html_path = srt_path.with_suffix(".edit.html")
        try:
            rendered_html = render_editor_html(final_mosp, input_path, html_path)
        except Exception as error:  # HTML was explicitly requested; report a failing artifact.
            print(f"便携 HTML 生成失败：{error}", file=sys.stderr)
            return 1
        if rendered_html is None or not html_path.is_file():
            print("便携 HTML 生成失败：没有生成预期的 .edit.html 文件", file=sys.stderr)
            return 1
    print(f"SRT: {srt_path}")
    print(f"MOSP: {final_mosp}")
    if args.html:
        print(f"HTML: {html_path}")
    return 0


def _generator_args(args: argparse.Namespace, input_path: Path, srt_path: Path) -> list[str]:
    # Render the optional HTML in this process so frozen MAW can use the
    # bundled editor module and web assets without requiring edit.py on disk.
    result = [str(input_path), "--output", str(srt_path), "--json", "--no-html"]
    if args.max_len is not None:
        result.extend(["--max-len", str(args.max_len)])
    if args.min_len is not None:
        result.extend(["--min-len", str(args.min_len)])
    for flag, value in (
        ("--language", args.language),
        ("--gap-split", args.gap_split),
        ("--length-limit", args.length_limit),
        ("--model", args.model),
        ("--stickers", args.stickers),
        ("--region", args.region),
        ("--file-url", args.file_url),
        ("--vocabulary-id", args.vocabulary_id),
        ("--hotword-file", args.hotword_file),
        ("--hotword-weight", args.hotword_weight),
        ("--context", args.context),
        ("--context-file", args.context_file),
        ("--context-json", args.soniox_context_json),
    ):
        if value is not None and value != "":
            result.extend([flag, str(value)])
    if args.keep_punct:
        result.append("--keep-punct")
    if args.speaker:
        result.append("--speaker")
    if args.speaker_colors:
        result.append("--speaker-colors")
    if args.with_waveform:
        result.append("--with-waveform")
    if args.debug:
        result.append("--debug")
    for hotword in args.hotword or []:
        result.extend(["--hotword", hotword])
    return result


def _invoke_generator(provider: str, argv: Sequence[str]) -> int:
    if provider == "soniox":
        import generate_subtitle_soniox_api as generator

        script_name = "generate_subtitle_soniox_api.py"
    elif provider == "bcut":
        import generate_subtitle_bcut_api as generator

        script_name = "generate_subtitle_bcut_api.py"
    else:
        import generate_subtitle_qwen_api as generator

        script_name = "generate_subtitle_qwen_api.py"
    old_argv = sys.argv[:]
    try:
        sys.argv = [script_name, *argv]
        result = generator.main()
    finally:
        sys.argv = old_argv
    return 0 if result is None else int(result)


def _run_server(parser: argparse.ArgumentParser, args: argparse.Namespace) -> int:
    port, project = _resolve_server_target(parser, args.server, args.port, args.server_project)
    if any(
        (
            args.input,
            args.outputs,
            args.mosp_output,
            args.provider != "qwen",
            args.model,
            args.max_len is not None,
            args.min_len is not None,
            args.language,
            args.keep_punct,
            args.gap_split is not None,
            args.speaker,
            args.speaker_colors,
            args.length_limit,
            args.json_output,
            args.with_waveform,
            args.html,
            args.no_html,
            args.debug,
            args.region,
            args.workspace_id,
            args.file_url,
            args.vocabulary_id,
            args.hotword,
            args.hotword_file,
            args.hotword_weight,
            args.context,
            args.context_file,
            args.soniox_context_json,
        )
    ):
        parser.error("转写参数不能与 --server 混用")
    if args.server_media and not project:
        parser.error("--media 需要和 Server 工程路径一起使用")
    server_args: list[str] = []
    if project:
        server_args.append(str(Path(project).expanduser()))
        if args.server_media:
            server_args.extend(["--media", str(Path(args.server_media).expanduser())])
    if args.stickers:
        server_args.extend(["--stickers", args.stickers])
    server_args.extend(["--port", str(port)])
    if args.no_open:
        server_args.append("--no-open")
    if args.no_waveform:
        server_args.append("--no-waveform")
    if args.waveform_peaks_per_second is not None:
        server_args.extend(["--waveform-peaks-per-second", str(args.waveform_peaks_per_second)])
    with _runtime_environment(""):
        return _invoke_server(server_args)


def _resolve_server_target(
    parser: argparse.ArgumentParser,
    target: str,
    explicit_port: int | None,
    project: str | None,
) -> tuple[int, str | None]:
    port = explicit_port or DEFAULT_SERVER_PORT
    if target:
        try:
            port = _port_value(target)
        except argparse.ArgumentTypeError:
            if project:
                parser.error("--server 后只能有一个工程路径；请用 --port 指定端口")
            project = target
    return port, project


def _invoke_server(argv: Sequence[str]) -> int:
    server_dir = asset_path("server-editor")
    if str(server_dir) not in sys.path:
        sys.path.insert(0, str(server_dir))
    import importlib

    server = importlib.import_module("serve")
    old_argv = sys.argv[:]
    try:
        sys.argv = ["serve.py", *argv]
        result = server.main()
    finally:
        sys.argv = old_argv
    return 0 if result is None else int(result)


def _run_stop_server(parser: argparse.ArgumentParser, args: argparse.Namespace) -> int:
    if any(
        (
            args.input,
            args.outputs,
            args.mosp_output,
            args.server_project,
            args.server_media,
            args.stickers,
            args.no_open,
            args.no_waveform,
            args.waveform_peaks_per_second is not None,
            args.provider != "qwen",
            args.model,
            args.max_len is not None,
            args.min_len is not None,
            args.language,
            args.keep_punct,
            args.gap_split is not None,
            args.speaker,
            args.speaker_colors,
            args.length_limit,
            args.json_output,
            args.with_waveform,
            args.html,
            args.no_html,
            args.debug,
            args.region,
            args.workspace_id,
            args.file_url,
            args.vocabulary_id,
            args.hotword,
            args.hotword_file,
            args.hotword_weight,
            args.context,
            args.context_file,
            args.soniox_context_json,
        )
    ):
        parser.error("转写参数不能与 --stop-server 混用")
    target = args.stop_server
    if target:
        try:
            port = _port_value(target)
        except argparse.ArgumentTypeError:
            parser.error("--stop-server 后只能填写端口号")
        if args.port is not None and args.port != port:
            parser.error("--stop-server 的端口与 --port 不一致")
    else:
        port = args.port or DEFAULT_SERVER_PORT
    if _request_server_shutdown(port):
        print(f"已请求停止 MAW Server：127.0.0.1:{port}")
        return 0
    try:
        from maw.gui_web import _stop_external_maw_server

        if _stop_external_maw_server(port):
            print(f"已停止 MAW Server：127.0.0.1:{port}")
            return 0
    except (ImportError, OSError):
        pass
    print(f"没有找到可安全停止的 MAW Server：127.0.0.1:{port}", file=sys.stderr)
    return 1


def _request_server_shutdown(port: int) -> bool:
    request = Request(
        f"http://127.0.0.1:{port}/api/shutdown",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=1.5) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, OSError, ValueError, TimeoutError):
        return False
    return response.status == 200 and payload.get("ok") is True and payload.get("service") == "maw-editor"


@contextmanager
def _runtime_environment(workspace_id: str) -> Iterator[None]:
    runtime = _child_environment(os.environ, "", provider="")
    keys = ("PATH", "PYTHONUNBUFFERED", "PYTHONUTF8", "PYTHONIOENCODING")
    previous = {key: os.environ.get(key) for key in keys}
    previous_workspace = os.environ.get("DASHSCOPE_WORKSPACE_ID")
    try:
        for key in keys:
            if key in runtime:
                os.environ[key] = runtime[key]
        if workspace_id:
            os.environ["DASHSCOPE_WORKSPACE_ID"] = workspace_id
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        if previous_workspace is None:
            os.environ.pop("DASHSCOPE_WORKSPACE_ID", None)
        else:
            os.environ["DASHSCOPE_WORKSPACE_ID"] = previous_workspace
