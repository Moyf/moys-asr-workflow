# Third-party notices

本仓库不打包模型或云端 API 服务。默认的 `MAW-Windows` 与 `MAW-macOS-arm64` 包会附带对应平台的 `ffmpeg` 与 `ffprobe`；可选的 `MAW-lite` 包不含 FFmpeg；Linux 的 `MAW-Linux-x86_64.AppImage` 始终内置静态 `ffmpeg`/`ffprobe`（BtbN 构建）。Windows 包还会在 `bootstrap/uv.exe` 携带 uv，供用户通过 GUI 创建本地 ASR 运行环境。运行时可能使用下列外部组件；许可证和服务条款以各项目及服务方的最新文本为准。

| Component | Purpose | License / terms |
|---|---|---|
| [requests](https://requests.readthedocs.io/) | HTTP requests to the ASR API | Apache-2.0 |
| [jieba](https://github.com/fxsjy/jieba) | Chinese subtitle segmentation | MIT |
| [fontTools](https://github.com/fonttools/fonttools) | Convert installed font outlines into font-independent Lottie vector glyphs | MIT |
| [opencc-python-reimplemented](https://github.com/yichen0831/opencc-python) / [OpenCC](https://github.com/BYVoid/OpenCC) | Local Simplified/Traditional Chinese conversion in the post-processing toolbox | Apache-2.0 |
| [reapeaks](https://pypi.org/project/reapeaks/) | Rust kernel that generates the `.ReaPeaks` waveform/spectral cache beside media files | MIT OR Apache-2.0 |
| [RapidOCR](https://github.com/RapidAI/RapidOCR) / PP-OCRv6 | Local CPU OCR for the 「OCR 字幕去重」 toolbox; the frozen bundle includes the PP-OCRv6 tiny model files | Apache-2.0; bundled model files remain subject to upstream model terms |
| [ONNX Runtime](https://onnxruntime.ai/) | CPU inference runtime for RapidOCR | MIT |
| [Pillow](https://python-pillow.github.io/) | Decode, crop, and resize video frames before OCR | HPND |
| [sv-ttk](https://github.com/rdbende/Sun-Valley-ttk-theme) | Sun Valley themed ttk widgets for the desktop GUI | MIT |
| [PyQt6](https://riverbankcomputing.com/software/pyqt/) / [QtPy](https://github.com/spyder-ide/qtpy) | Linux desktop GUI backend for pywebview (Launcher) | PyQt6: GPL-3.0 or a commercial license from Riverbank Computing; Qt: LGPL-3.0 |
| [Noto Color Emoji](https://github.com/googlefonts/noto-emoji) | Color emoji font for the Linux launcher keycap headers (1️⃣ etc.). On first launch the app downloads it to the user cache directory (`MAW_EMOJI_FONT_URL` can override the source), then the page references it locally; subsequent runs are offline. Not bundled or shipped. File sha256 at integration time: `72a635cb3d2f3524c51620cdde406b217204e8a6a06c6a096ff8ed4b5fd6e27b` | SIL OFL 1.1 |
| [PyInstaller](https://pyinstaller.org/) | Build the optional Windows application bundle | GPL-2.0-or-later with a bootloader exception that permits distributing bundled applications |
| [Python](https://www.python.org/) | Runtime embedded in the optional Windows application bundle | Python Software Foundation License |
| [FFmpeg](https://ffmpeg.org/) / [Gyan Windows build](https://www.gyan.dev/ffmpeg/builds/) / [OSXExperts macOS build](https://www.osxexperts.net/) / [BtbN Linux build](https://github.com/BtbN/FFmpeg-Builds) | Inspect media, extract audio, and build waveform peaks | `MAW-Windows` includes FFmpeg 8.1.2 Essentials executables under GPL-3.0; `MAW-macOS-arm64` includes FFmpeg 8.1 Apple Silicon static `ffmpeg` and `ffprobe` binaries; the optional `MAW-lite` packages do not bundle FFmpeg; the Linux `MAW-Linux-x86_64.AppImage` bundles the BtbN `linux64-gpl` static `ffmpeg`/`ffprobe` build. The bundled `ffmpeg/` directory includes FFmpeg license files and source/provider references. |
| [uv](https://github.com/astral-sh/uv) | Bootstrap a user-managed Python environment for optional local ASR | MIT or Apache-2.0; the bundled binary is obtained from the uv release used by the Windows build |
| [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) / `qwen-asr` | Optional local Qwen speech-recognition runtime | Not installed by default and not bundled; runtime code and downloaded model checkpoints remain subject to their upstream licenses and terms |
| [FunASR](https://github.com/modelscope/FunASR) / `funasr` | Optional local speech-recognition runtime | Not installed by default and not bundled; runtime code and downloaded model checkpoints remain subject to their upstream licenses and terms |
| Alibaba Cloud Model Studio / Qwen ASR | Speech recognition API | External service; subject to Alibaba Cloud terms, billing, and privacy policy |
| [Soniox](https://soniox.com/) | Speech recognition API | External service; subject to Soniox terms, billing, and privacy policy |
| [DeepSeek](https://www.deepseek.com/) / [Zhipu Coding Plan](https://open.bigmodel.cn/) / Alibaba Cloud Model Studio Qwen / custom OpenAI-compatible endpoint | Optional subtitle text post-processing in the Launcher toolbox | External services; subject to the selected provider's terms, billing, and privacy policy |

The `web/` editor, Python scripts, and documentation in this repository are distributed under the repository's `AGPL-3.0-only` license unless a file states otherwise.
