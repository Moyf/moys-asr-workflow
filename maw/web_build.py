"""web 前端 bundle 的新鲜度预检与自动重建。

editor / launcher 的 esbuild bundle 是构建产物，不进 Git。三个运行时入口
（``server-editor/serve.py``、``maw/gui_web.py``、``edit.py --blank``）在
读取产物前调用 :func:`ensure_bundle`：产物缺失或与源码不一致时自动调用本
仓库的 esbuild 构建重建；环境里没有 Node.js / 依赖未安装时，抛出带修复指
引的 :class:`BundlePreflightError`。

新鲜度判定复刻 ``scripts/build-editor.mjs`` 写入 ``.meta.json`` 的哈希方案：
清单文件列表（sourceFiles）、每个源文件的 sha256（inputs）、模块配置文本
哈希（configHash）、构建器脚本哈希（builderHash）与依赖声明哈希
（dependencyHash）。bundleHash 同时验证产物完整性。

本模块只依赖标准库：打包配置（MAW.spec）与所有 Python 入口都能安全引用。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final

_BUILD_TIMEOUT_SECONDS: Final = 120.0
# ThreadingHTTPServer 的页面渲染与 GUI 启动可能并发触发重建；进程内串行
# 预检避免重复构建，跨进程由构建器的原子发布与 bundleHash 保证安全。
_BUILD_LOCK = threading.Lock()


class BundlePreflightError(RuntimeError):
    """bundle 缺失或过期且无法自动重建；message 面向用户给出修复指引。"""


@dataclass(frozen=True)
class _BundleSpec:
    kind: str
    bundle: Path
    meta: Path
    config: Path
    manifest: Path
    builders: tuple[Path, ...]
    build_script: str
    pnpm_script: str


_SPECS: Final[dict[str, _BundleSpec]] = {
    "editor": _BundleSpec(
        kind="editor",
        bundle=Path("web/editor/boot/editor-bundle.js"),
        meta=Path("web/editor/boot/editor-bundle.meta.json"),
        config=Path("web/editor-modules.json"),
        manifest=Path("web/editor-scripts.txt"),
        builders=(Path("scripts/build-editor.mjs"),),
        build_script="scripts/build-editor.mjs",
        pnpm_script="build:editor",
    ),
    "launcher": _BundleSpec(
        kind="launcher",
        bundle=Path("web/launcher/boot/launcher-bundle.js"),
        meta=Path("web/launcher/boot/launcher-bundle.meta.json"),
        config=Path("web/launcher-modules.json"),
        manifest=Path("web/launcher-scripts.txt"),
        builders=(Path("scripts/build-launcher.mjs"), Path("scripts/build-editor.mjs")),
        build_script="scripts/build-launcher.mjs",
        pnpm_script="build:launcher",
    ),
}


def _sha256_text(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _manifest_files(text: str) -> list[str]:
    """按构建器的解析规则展开清单：去掉 ``#`` 注释与空白行。"""
    entries: list[str] = []
    for line in text.splitlines():
        entry = line.split("#", 1)[0].strip()
        if entry:
            entries.append(entry)
    return entries


def _read_or_none(path: Path) -> str | None:
    try:
        # 与 Node 的 utf8 读取一致，不把 CRLF 静默转为 LF 后再算哈希。
        with path.open(encoding="utf-8", newline="") as stream:
            return stream.read()
    except (OSError, UnicodeError):
        return None


def bundle_status(root: Path, kind: str) -> tuple[str, str]:
    """返回 ``(状态, 说明)``，状态为 ``fresh`` / ``missing`` / ``stale``。"""
    spec = _SPECS[kind]
    if not (root / spec.bundle).is_file():
        return "missing", f"缺少构建产物 {spec.bundle.as_posix()}"
    meta_text = _read_or_none(root / spec.meta)
    if meta_text is None:
        return "stale", f"无法读取构建信息 {spec.meta.as_posix()}"
    try:
        meta = json.loads(meta_text)
    except ValueError:
        return "stale", f"{spec.meta.as_posix()} 不是有效的 JSON"
    if not isinstance(meta, dict) or type(meta.get("format")) is not int or meta["format"] != 1:
        return "stale", f"{spec.meta.as_posix()} 的 format 版本未知"
    inputs = meta.get("inputs")
    source_files = meta.get("sourceFiles")
    if not isinstance(inputs, dict) or not isinstance(source_files, list):
        return "stale", f"{spec.meta.as_posix()} 缺少 inputs/sourceFiles"

    manifest_text = _read_or_none(root / spec.manifest)
    if manifest_text is None:
        return "stale", f"无法读取清单 {spec.manifest.as_posix()}"
    files = _manifest_files(manifest_text)
    if not files or len(files) != len(set(files)) or any(
        not file.endswith(".js") or re.search(r"[\\:]", file)
        or any(part in ("", ".", "..") for part in file.split("/"))
        or file in (item.bundle.relative_to("web").as_posix() for item in _SPECS.values())
        for file in files
    ):
        return "stale", f"清单 {spec.manifest.as_posix()} 含无效源文件路径"
    if files != source_files:
        return "stale", f"清单 {spec.manifest.as_posix()} 与构建时不一致"
    if not set(files) <= set(inputs) or any(
        not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
        for value in inputs.values()
    ):
        return "stale", "构建信息未完整覆盖清单中的源码哈希"
    # G00 接缝允许静态 import 图把清单之外的传递依赖拉进构建；
    # 多出的 inputs 条目同样按源码哈希核对，缺失或漂移都判过期。
    for relative in set(inputs) - set(files):
        if not (root / "web" / relative).is_file():
            return "stale", f"传递依赖账本包含清单外源码: {relative}"

    web_root = (root / "web").resolve()
    for relative, expected in inputs.items():
        source = root / "web" / relative
        if not source.resolve().is_relative_to(web_root):
            return "stale", f"源文件路径越出 web/: {relative}"
        text = _read_or_none(source)
        if text is None:
            return "stale", f"源文件丢失: web/{relative}"
        if _sha256_text(text) != expected:
            return "stale", f"源码已变更: web/{relative}"

    config_text = _read_or_none(root / spec.config)
    if config_text is None or _sha256_text(config_text) != meta.get("configHash"):
        return "stale", f"模块配置 {spec.config.as_posix()} 已变更"

    builder_texts = [_read_or_none(root / builder) for builder in spec.builders]
    if any(text is None for text in builder_texts):
        return "stale", "构建器脚本丢失"
    joined = "\n".join(text for text in builder_texts if text is not None)
    if _sha256_text(joined) != meta.get("builderHash"):
        return "stale", "构建器脚本已变更"

    dependencies = [_read_or_none(root / name) for name in ("package.json", "pnpm-lock.yaml")]
    if any(text is None for text in dependencies) or _sha256_text(
        "\n".join(text for text in dependencies if text is not None)
    ) != meta.get("dependencyHash"):
        return "stale", "前端构建依赖声明已变更或缺失"
    bundle_text = _read_or_none(root / spec.bundle)
    if bundle_text is None or _sha256_text(bundle_text) != meta.get("bundleHash"):
        return "stale", "bundle 内容与构建信息不一致"

    return "fresh", "产物与源码一致"


def _manual_message(spec: _BundleSpec, status: str, reason: str, blocker: str) -> str:
    state = "缺失" if status == "missing" else "过期"
    return (
        f"{spec.bundle.as_posix()} {state}（{reason}），{blocker}，无法自动重建。\n"
        "请先安装 Node.js（≥22.13）与 pnpm，然后在仓库根目录执行：\n"
        f"  pnpm install --frozen-lockfile\n"
        f"  pnpm run {spec.pnpm_script}"
    )


def _kind_label(kind: str) -> str:
    return "编辑器" if kind == "editor" else "Launcher"


def _packaged_error(spec: _BundleSpec, reason: str) -> str:
    return (
        f"打包产物中的 {spec.bundle.as_posix()} 缺失（{reason}）。\n"
        "这是打包缺陷：发布打包流程会先构建 bundle 再收集 web/，请用最新打包脚本重新打包。"
    )


def _run_build(root: Path, spec: _BundleSpec, status: str, reason: str) -> None:
    node = shutil.which("node")
    if node is None:
        raise BundlePreflightError(_manual_message(spec, status, reason, "未找到 Node.js"))
    if not (root / "node_modules" / "esbuild").exists():
        raise BundlePreflightError(
            _manual_message(spec, status, reason, "JS 依赖尚未安装（node_modules 缺失）")
        )
    command = [node, spec.build_script, "--write", str(root)]
    try:
        completed = subprocess.run(  # noqa: S603 - 固定参数调用仓库内构建脚本
            command,
            cwd=root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_BUILD_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise BundlePreflightError(
            f"自动重建 {spec.bundle.as_posix()} 超时（>{_BUILD_TIMEOUT_SECONDS:.0f}s）。"
            f"请手动执行 pnpm run {spec.pnpm_script} 查看具体错误。"
        ) from error
    except OSError as error:
        raise BundlePreflightError(
            _manual_message(spec, status, reason, f"Node.js 无法启动（{error}）")
        ) from error
    if completed.returncode != 0:
        tail = "\n".join((completed.stderr or completed.stdout or "").splitlines()[-8:])
        raise BundlePreflightError(
            f"自动重建 {spec.bundle.as_posix()} 失败（exit {completed.returncode}）。\n"
            f"命令: pnpm run {spec.pnpm_script}\n{tail}"
        )


def ensure_bundle(root: Path, kind: str, *, allow_build: bool = True) -> str:
    """确保 *kind* bundle 存在且与源码一致，必要时自动重建。

    *allow_build=False* 用于打包后的 frozen 环境：打包管线已经保证
    「先构建、后收集」（打包脚本显式构建 + MAW.spec fail fast），且包内
    不含 scripts/ 构建器脚本，逐字节一致性校验没有比较对象，因此只做
    存在性检查；缺失一律视为打包缺陷，绝不尝试在用户机器上构建。
    成功返回 ``fresh``，失败抛出 :class:`BundlePreflightError`。
    """
    with _BUILD_LOCK:
        spec = _SPECS[kind]
        if not allow_build:
            if not (root / spec.bundle).is_file():
                raise BundlePreflightError(_packaged_error(spec, "bundle 文件不在包内"))
            return "fresh"
        status, reason = bundle_status(root, kind)
        if status == "fresh":
            return status
        started = time.monotonic()
        _run_build(root, spec, status, reason)
        final_status, final_reason = bundle_status(root, kind)
        if final_status != "fresh":
            raise BundlePreflightError(
                f"自动重建后 {spec.bundle.as_posix()} 仍不一致（{final_reason}）。"
                f"请手动执行 pnpm run {spec.pnpm_script} 查看具体错误。"
            )
        print(
            f"[web-build] {_kind_label(kind)} bundle 已自动重建（{reason}，"
            f"耗时 {time.monotonic() - started:.1f}s）"
        )
        return final_status
