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
]

excluded_runtime_paths = [
    ".env",
    "*.key",
    "*.pem",
    "*.mp4",
    "*.mov",
    "*.mkv",
    "*.avi",
    "*.wav",
    "*.mp3",
    "*.m4a",
    "*.flac",
    "*.srt",
    "*.edit.html",
    "*.waveform.json",
    "node_modules",
    "tests",
    "test-results",
    "playwright-report",
    "ffmpeg",
    "ffmpeg.exe",
    "ffprobe.exe",
]

a = Analysis(
    [str(ROOT / "maw_gui.py")],
    pathex=[str(ROOT), str(ROOT / "server-editor")],
    binaries=[],
    datas=datas,
    hiddenimports=[
        "edit",
        "waveform",
        "generate_subtitle_qwen_api",
        "generate_subtitle_soniox_api",
        "serve",
        "maw.gui_web",
        "maw.gui_config",
        "maw.gui_workflow",
        "maw.cli",
        "maw.postprocess",
        "maw.postprocess_io",
        "maw.postprocess_llm",
        "maw.postprocess_ffmpeg",
        "maw.postprocess_match",
        "maw.project",
        "maw.soniox",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excluded_runtime_paths,
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
