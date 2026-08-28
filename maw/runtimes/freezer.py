"""托管 Runtime 依赖清单的通用冻结器（声明驱动，取代按 runtime 分派）。

构建管线（``scripts/build-windows.ps1`` / ``scripts/build-appimage.sh`` /
release.yml 的 macOS 步骤）与源码模式自动补齐（``maw/runtimes/base.py``）
共用同一份命令构造与编排逻辑：将来新增 GPU runtime 只需在
``RuntimeSpec`` 声明 ``requirements_in`` / ``requirements_in_args``，不再
需要改动任何构建脚本或分派函数。

- 主清单：``spec.requirements_in`` 非 None → ``uv pip compile <in>``
  （moss，因 Transformers 与 local 互斥而独立声明）；否则 →
  ``uv export --extra <requirements_key>``（pyproject optional-dependencies）。
- CPU 变体（``requirements-{key}-cpu.txt``）：对声明源执行
  :func:`cpu_requirements_lines`（剥离 ``+cuNNN`` 本地版本号、丢弃 darwin
  分支、剥掉 ``!= 'darwin'`` 冗余条件），生成临时 in 文件到 ``build/`` 下，
  再 ``uv pip compile --generate-hashes`` 冻结。local 的声明源是 uv export
  产物中的直接依赖行（版本已锁定，唯一真源仍是 pyproject/uv.lock）；
  moss 的声明源是 ``moss-requirements.in`` 本身。
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from maw.runtimes.base import RuntimeSpec

# uv export 产物里直接依赖的 `# via` 标注（pyproject [project].name）。
PROJECT_NAME: str = "moys-asr-workflow"

# 新 runtime 名单（与 maw/runtimes/__init__.py 的注册表保持一致；仅 CLI 过滤用）。
RUNTIME_KEYS: tuple[str, ...] = ("local", "ocr", "moss")

_CU_PIN_RE = re.compile(r"\+cu[0-9]+")
_DARWIN_ONLY_RE = re.compile(r";\s*sys_platform\s*==\s*'darwin'")
_NON_DARWIN_MARKER_RE = re.compile(r";\s*sys_platform\s*!=\s*'darwin'")


def strip_gpu_pins(line: str) -> str:
    """剥离单条依赖 spec 中的 GPU 本地版本后缀（``+cuNNN``）。

    ``torch==2.13.0+cu130`` → ``torch==2.13.0``；无后缀的行原样返回。
    GPU 本地版本只存在于 pytorch 专用 index，在 PyPI（CPU wheel 源）无效，
    CPU 变体必须剥掉后才能被默认源解析。
    """
    return _CU_PIN_RE.sub("", line)


def cpu_requirements_lines(source: str) -> list[str]:
    """把依赖声明文本转换为 CPU 变体行列表（local 与 moss 共用的通用规则）：

    - 剥离 ``+cuNNN`` 本地版本号（GPU index 专属版本在 PyPI 无效）；
    - 丢弃 ``sys_platform == 'darwin'`` 分支（CPU 变体仅被非 darwin 且无
      NVIDIA GPU 的机器消费，darwin 的 torch 本来就是 CPU wheel）；
    - 剥掉 ``sys_platform != 'darwin'`` 冗余条件（整份清单即非 darwin 语义）；
    - 源注释与空行不带入（可追溯性由 :func:`cpu_input_text` 的头部注释承担，
      源注释里对 GPU index 的说明对 CPU 清单是误导）。
    """
    lines: list[str] = []
    for raw in source.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if _DARWIN_ONLY_RE.search(line):
            continue
        line = _NON_DARWIN_MARKER_RE.sub("", line).rstrip()
        lines.append(strip_gpu_pins(line))
    return lines


def cpu_input_text(source: str, *, header: str | None = None) -> str:
    """生成 CPU 变体的 in 文件内容（头部注释 + 转换后的依赖行，LF 结尾）。"""
    lines = cpu_requirements_lines(source)
    if header:
        lines.insert(0, header)
    return "\n".join(lines) + "\n"


def direct_pins_from_export(export_text: str) -> list[str]:
    """从 ``uv export`` 的 requirements-txt 产物提取直接依赖的 pin 行。

    直接依赖 = ``# via`` 标注里含项目名（或 ``-r`` 的包）；返回值形如
    ``["funasr==1.4.2", "torch==2.13.0 ; sys_platform != 'darwin'"]``，
    版本已按 uv.lock 锁定，剥离哈希与传递依赖，可作为 compile 输入。
    """
    pins: list[str] = []
    current: tuple[str, list[str]] | None = None  # (pin 行, via 条目列表)

    def flush() -> None:
        nonlocal current
        if current is None:
            return
        pin, via = current
        if any(PROJECT_NAME in item or item.startswith("-r ") for item in via):
            pins.append(pin)
        current = None

    for raw in export_text.splitlines():
        line = raw.strip()
        match = re.match(r"^([A-Za-z0-9_.-]+)==(.*)$", line)
        if match:
            flush()
            version = match.group(2).rstrip(" \\")
            current = [f"{match.group(1)}=={version}", []]
            continue
        if current is None:
            continue
        if line.startswith("# via"):
            rest = line[len("# via"):].strip()
            if rest:
                current[1].append(rest)
        elif line.startswith("#") and line.lstrip("#").strip():
            current[1].append(line.lstrip("#").strip())
    flush()
    return pins


def main_freeze_command(uv: Path, spec: "RuntimeSpec", build_dir: Path) -> list[str] | None:
    """主清单冻结命令：in 文件声明 → uv pip compile；否则 uv export extra。"""
    target = str(build_dir / spec.requirements_bundle_name)
    if spec.requirements_in is not None:
        return [
            str(uv), "pip", "compile", spec.requirements_in, "-p", spec.python_version,
            *spec.requirements_in_args,
            "--index-strategy", "unsafe-best-match",
            "-o", target,
        ]
    return [
        str(uv), "export", "--frozen", "--extra", spec.requirements_key, "--no-dev",
        "--format", "requirements-txt",
        "-o", target,
    ]


def cpu_input_path(spec: "RuntimeSpec", build_dir: Path) -> Path:
    """生成式 CPU 变体的 in 文件路径（build/ 下，gitignored，不入库）。"""
    return build_dir / f"{spec.key}-cpu-requirements.in"


def cpu_output_path(spec: "RuntimeSpec", build_dir: Path) -> Path:
    """CPU 变体 frozen txt 路径（``requirements-{key}-cpu.txt``）。"""
    return build_dir / (spec.requirements_bundle_name[: -len(".txt")] + "-cpu.txt")


def cpu_freeze_command(uv: Path, spec: "RuntimeSpec", build_dir: Path) -> list[str] | None:
    """CPU 变体冻结命令；无 CUDA 组件的 runtime（ocr）返回 None。"""
    if not spec.cuda_fallback_packages:
        return None
    return [
        str(uv), "pip", "compile", str(cpu_input_path(spec, build_dir)), "-p", spec.python_version,
        "--generate-hashes",
        "--index-strategy", "unsafe-best-match",
        "-o", str(cpu_output_path(spec, build_dir)),
    ]


def ensure_frozen(
    uv: Path,
    spec: "RuntimeSpec",
    *,
    cpu: bool,
    build_dir: Path,
    run: Callable[[list[str]], object],
    emit: Callable[[str], None] | None = None,
) -> None:
    """补足缺失的 frozen 清单（幂等；命令经 ``run`` 执行，可被测试注入）。

    - 主清单缺失 → 执行主清单冻结命令；
    - CPU 变体缺失 → 先保证声明源就绪（local 需要主清单 export 产物提取
      直接依赖；moss 直接读 in 文件），生成式 in 写进 ``build/`` 后 compile。
    - 无 CUDA 组件的 runtime（ocr）请求 CPU 变体时直接返回，交上层
      ``requirements_path`` 给出缺失指引（实际不会被请求）。
    """
    if not cpu:
        command = main_freeze_command(uv, spec, build_dir)
        if command is None or (build_dir / spec.requirements_bundle_name).is_file():
            return
        _notify(emit, spec)
        run(command)
        return
    if not spec.cuda_fallback_packages:
        return
    if cpu_output_path(spec, build_dir).is_file():
        return
    if spec.requirements_in is not None:
        source_text = Path(spec.requirements_in).read_text(encoding="utf-8")
        source_name = spec.requirements_in
    else:
        # local：直接依赖的唯一真源是 uv.lock（经 uv export 锁定版本）。
        main_txt = build_dir / spec.requirements_bundle_name
        if not main_txt.is_file():
            command = main_freeze_command(uv, spec, build_dir)
            if command is None:
                return
            _notify(emit, spec)
            run(command)
        export_text = main_txt.read_text(encoding="utf-8")
        pins = direct_pins_from_export(export_text)
        if not pins:
            raise RuntimeError(
                f"{spec.key}：uv export 产物中未找到直接依赖行"
                f"（# via {PROJECT_NAME}），无法生成 CPU 变体声明"
            )
        source_text = "\n".join(pins) + "\n"
        source_name = main_txt.name
    header = _cpu_input_header(spec, source_name)
    cpu_input_path(spec, build_dir).write_text(
        cpu_input_text(source_text, header=header), encoding="utf-8", newline="\n"
    )
    command = cpu_freeze_command(uv, spec, build_dir)
    if command is None:
        return
    _notify(emit, spec)
    run(command)


def _cpu_input_header(spec: "RuntimeSpec", source_name: str) -> str:
    """生成式 CPU in 文件的头部注释（不含 ``+cuNNN`` 字样，说明来源与用法）。"""
    return (
        f"# {spec.message_prefix}的 CPU 变体依赖（无 NVIDIA GPU 机器首装用）。\n"
        f"# 由 maw/runtimes/freezer.py 从 {source_name} 自动生成，与构建管线\n"
        f"# 统一执行：\n"
        f"#   uv pip compile {cpu_input_path(spec, Path('build')).as_posix()} -p {spec.python_version}\n"
        f"#     --generate-hashes --index-strategy unsafe-best-match\n"
        f"#     -o {cpu_output_path(spec, Path('build')).as_posix()}"
    )


def _notify(emit: Callable[[str], None] | None, spec: "RuntimeSpec") -> None:
    if emit is not None:
        emit(f"正在生成{spec.message_prefix}依赖清单（uv 冻结，与构建管线一致）……")


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def main(argv: list[str] | None = None) -> None:
    """CLI：``python -m maw.runtimes.freezer freeze [--runtime local|ocr|moss]``。

    构建脚本（Windows / Linux / macOS 三平台共用）以此生成全部托管 Runtime
    的 frozen 清单；``--runtime`` 可重复，缺省处理全部。
    """
    parser = argparse.ArgumentParser(
        prog="python -m maw.runtimes.freezer",
        description="托管 Runtime 依赖清单冻结器（与源码模式自动补齐同源）",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    freeze = sub.add_parser("freeze", help="生成缺失的 frozen requirements 清单")
    freeze.add_argument(
        "--runtime",
        action="append",
        choices=list(RUNTIME_KEYS),
        help="只处理指定 runtime（可重复）；缺省全部",
    )
    args = parser.parse_args(argv)
    if args.command != "freeze":
        parser.error(f"未知命令：{args.command}")

    uv = shutil.which("uv")
    if uv is None:
        raise SystemExit("未找到 uv（构建管线前置依赖）。")
    # 延迟 import 避免与 maw.runtimes.base 的双向依赖。
    from maw.runtimes import get_runtime

    keys = args.runtime or list(RUNTIME_KEYS)
    # 与 base._build_dir() 同一约定：frozen 清单统一放仓库根 build/ 下。
    build_dir = _repo_root() / "build"
    build_dir.mkdir(parents=True, exist_ok=True)

    for key in keys:
        spec = get_runtime(key).spec
        for cpu in (False, True):
            ensure_frozen(
                Path(uv),
                spec,
                cpu=cpu,
                build_dir=build_dir,
                run=lambda command: _cli_run(command, _repo_root()),
                emit=lambda message: print(message, flush=True),
            )
    print("OK: 托管 Runtime 依赖清单已就绪。")


def _cli_run(command: list[str], cwd: Path) -> object:
    print("$ " + " ".join(command), flush=True)
    result = subprocess.run(command, cwd=str(cwd))
    if result.returncode != 0:
        raise SystemExit(f"命令失败（exit {result.returncode}）：{' '.join(command)}")
    return result.returncode


if __name__ == "__main__":
    main(sys.argv[1:])