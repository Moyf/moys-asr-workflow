# -*- mode: python ; coding: utf-8 -*-

import sys
from pathlib import Path

try:
    from PyInstaller.utils.hooks import collect_data_files, collect_submodules
except ImportError:  # pragma: no cover - only reached outside a PyInstaller build
    collect_data_files = lambda _package: []
    collect_submodules = lambda _package: []

ROOT = Path(SPECPATH).resolve()

binaries = []
if sys.platform == "linux":
    # Qt 6.5+ 的 xcb 平台插件需要 libxcb-cursor；部分环境（如 ubuntu-22.04
    # runner）PyInstaller 的 ldd 分析收集不到它，导致 AppImage 无法启动。
    # 显式收集，保证 AppImage 自包含。
    try:
        import subprocess

        def _ld_so_path(name: str) -> str | None:
            table = subprocess.check_output(["ldconfig", "-p"], text=True, stderr=subprocess.DEVNULL)
            for line in table.splitlines():
                parts = line.split("=>")
                if len(parts) == 2 and name in parts[0]:
                    return parts[1].strip()
            return None

        libxcb_cursor = _ld_so_path("libxcb-cursor.so.0")
        if libxcb_cursor:
            # 必须放在 Qt 的 LibrariesPath（_internal/PyQt6/Qt6/lib）：QLibrary
            # 搜索 xcb-cursor 时走 Qt 库目录，不走 LD_LIBRARY_PATH。
            binaries.append((libxcb_cursor, "PyQt6/Qt6/lib"))
            # Qt 用 QLibrary("xcb-cursor") 找无版本 libxcb-cursor.so；
            # ubuntu 等发行版只提供 .so.0，需复制一份无版本名。
            unversioned = Path(libxcb_cursor).with_name("libxcb-cursor.so")
            if not unversioned.exists():
                import shutil
                import tempfile

                tmpdir = tempfile.mkdtemp(prefix="maw-spec-")
                unversioned = Path(tmpdir) / "libxcb-cursor.so"
                shutil.copy2(libxcb_cursor, unversioned)
            binaries.append((str(unversioned), "PyQt6/Qt6/lib"))
    except Exception as exc:  # noqa: BLE001 - 收集失败时回退 ldd 默认行为
        print(f"Warning: libxcb-cursor collection failed: {exc}", file=sys.stderr)

datas = [
    (str(ROOT / "web"), "web"),
    (str(ROOT / "server-editor"), "server-editor"),
    (str(ROOT / "LICENSE"), "."),
    (str(ROOT / "THIRD_PARTY_NOTICES.md"), "."),
    (str(ROOT / "FAQ-常见问题.txt"), "."),
    (str(ROOT / "blank-editor.html"), "."),
    (str(ROOT / "assets" / "maw.ico"), "assets"),
    (str(ROOT / "assets" / "show.webp"), "assets"),
    (str(ROOT / "generate_subtitle_local.py"), "local-runtime"),
    (str(ROOT / "generate_subtitle_qwen_api.py"), "local-runtime"),
    (str(ROOT / "edit.py"), "local-runtime"),
    (str(ROOT / "maw" / "waveform.py"), "local-runtime/maw"),
    (str(ROOT / "maw" / "reapeaks.py"), "local-runtime/maw"),
    (str(ROOT / "maw" / "media_cache.py"), "local-runtime/maw"),
    (str(ROOT / "maw" / "__init__.py"), "local-runtime/maw"),
    (str(ROOT / "maw" / "local_asr.py"), "local-runtime/maw"),
    (str(ROOT / "maw" / "local_runtime_worker.py"), "local-runtime/maw"),
    (str(ROOT / "maw" / "media.py"), "local-runtime/maw"),
    (str(ROOT / "maw" / "project.py"), "local-runtime/maw"),
    (str(ROOT / "maw" / "project_preview.py"), "local-runtime/maw"),
    (str(ROOT / "maw" / "qwen_audio.py"), "local-runtime/maw"),
    (str(ROOT / "maw" / "speaker.py"), "local-runtime/maw"),
    (str(ROOT / "maw" / "__init__.py"), "ocr-runtime/maw"),
    (str(ROOT / "maw" / "media.py"), "ocr-runtime/maw"),
    (str(ROOT / "maw" / "postprocess.py"), "ocr-runtime/maw"),
    (str(ROOT / "maw" / "postprocess_io.py"), "ocr-runtime/maw"),
    (str(ROOT / "maw" / "postprocess_ocr.py"), "ocr-runtime/maw"),
    (str(ROOT / "maw" / "project.py"), "ocr-runtime/maw"),
    (str(ROOT / "maw" / "project_preview.py"), "ocr-runtime/maw"),
    (str(ROOT / "maw" / "ocr_runtime_worker.py"), "ocr-runtime/maw"),
]
opencc_datas = collect_data_files("opencc")
datas.extend(opencc_datas)
opencc_hiddenimports = collect_submodules("opencc")

# OCR dependencies and model files stay outside the frozen bundle. The bundled
# worker only bootstraps the optional runtime when the user installs it.

excluded_local_modules = [
    "accelerate",
    "funasr",
    "hf_xet",
    "huggingface_hub",
    "modelscope",
    "qwen_asr",
    "onnxruntime",
    "PIL",
    "rapidocr",
    "torch",
    "torchaudio",
    "transformers",
]

a = Analysis(
    [str(ROOT / "maw_gui.py")],
    pathex=[str(ROOT), str(ROOT / "server-editor")],
    binaries=binaries,
    datas=datas,
    hiddenimports=[
        "edit",
        "maw.media_cache",
        "maw.waveform",
        "maw.reapeaks",
        "waveform",
        "generate_subtitle_qwen_api",
        "generate_subtitle_soniox_api",
        "generate_subtitle_local",
        "generate_subtitle_bcut_api",
        "serve",
        "maw.gui_web",
        "maw.gui_config",
        "maw.gui_workflow",
        "maw.local_models",
        "maw.local_runtime",
        "maw.local_asr",
        "maw.ocr_runtime",
        "maw.cli",
        "maw.postprocess",
        "maw.text_conversion",
        "maw.postprocess_io",
        "maw.postprocess_llm",
        "maw.postprocess_ffmpeg",
        "maw.postprocess_match",
        "maw.postprocess_ocr",
        "maw.project",
        "maw.soniox",
        "maw.bcut",
        "opencc",
        *opencc_hiddenimports,
        "reapeaks",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excluded_local_modules,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='MAW',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / 'assets' / 'maw.ico') if sys.platform == 'win32' else None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='MAW',
)

if sys.platform == 'darwin':
    app = BUNDLE(
        coll,
        name='MAW.app',
        icon=str(ROOT / 'assets' / 'maw.icns'),
        bundle_identifier='com.moy.mawsasrworkflow',
    )
