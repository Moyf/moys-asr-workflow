# -*- mode: python ; coding: utf-8 -*-

import sys
from pathlib import Path


ROOT = Path(SPECPATH).resolve()

datas = [
    (str(ROOT / "web"), "web"),
    (str(ROOT / "server-editor"), "server-editor"),
    (str(ROOT / "LICENSE"), "."),
    (str(ROOT / "THIRD_PARTY_NOTICES.md"), "."),
    (str(ROOT / "blank-editor.html"), "."),
    (str(ROOT / "assets" / "maw.ico"), "assets"),
    (str(ROOT / "assets" / "show.webp"), "assets"),
    (str(ROOT / "generate_subtitle_local.py"), "local-runtime"),
    (str(ROOT / "generate_subtitle_qwen_api.py"), "local-runtime"),
    (str(ROOT / "edit.py"), "local-runtime"),
    (str(ROOT / "waveform.py"), "local-runtime"),
    (str(ROOT / "reapeaks.py"), "local-runtime"),
    (str(ROOT / "reapeaks_generate.py"), "local-runtime"),
    (str(ROOT / "media_cache.py"), "local-runtime"),
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

binaries = []

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
        "maw.postprocess_io",
        "maw.postprocess_llm",
        "maw.postprocess_ffmpeg",
        "maw.postprocess_match",
        "maw.postprocess_ocr",
        "maw.project",
        "maw.soniox",
        "maw.bcut",
        "numpy",
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
