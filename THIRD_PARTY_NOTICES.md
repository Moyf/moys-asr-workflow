# Third-party notices

本仓库不打包模型或云端 API 服务。标准 Windows/macOS 包不含 FFmpeg；可选的 `MAWxFF-Windows` 与 `MAWxFF-macOS-arm64` 包会分别附带对应平台的 `ffmpeg` 与 `ffprobe`。运行时可能使用下列外部组件；许可证和服务条款以各项目及服务方的最新文本为准。

| Component | Purpose | License / terms |
|---|---|---|
| [requests](https://requests.readthedocs.io/) | HTTP requests to the ASR API | Apache-2.0 |
| [jieba](https://github.com/fxsjy/jieba) | Chinese subtitle segmentation | MIT |
| [sv-ttk](https://github.com/rdbende/Sun-Valley-ttk-theme) | Sun Valley themed ttk widgets for the desktop GUI | MIT |
| [PyInstaller](https://pyinstaller.org/) | Build the optional Windows application bundle | GPL-2.0-or-later with a bootloader exception that permits distributing bundled applications |
| [Python](https://www.python.org/) | Runtime embedded in the optional Windows application bundle | Python Software Foundation License |
| [FFmpeg](https://ffmpeg.org/) / [Gyan Windows build](https://www.gyan.dev/ffmpeg/builds/) / [OSXExperts macOS build](https://www.osxexperts.net/) | Inspect media, extract audio, and build waveform peaks | Not bundled in standard packages. `MAWxFF-Windows` includes FFmpeg 8.1.2 Essentials executables under GPL-3.0; `MAWxFF-macOS-arm64` includes FFmpeg 8.1 Apple Silicon static `ffmpeg` and `ffprobe` binaries. The bundled `ffmpeg/` directory includes FFmpeg license files and source/provider references. |
| Alibaba Cloud Model Studio / Qwen ASR | Speech recognition API | External service; subject to Alibaba Cloud terms, billing, and privacy policy |
| [Soniox](https://soniox.com/) | Speech recognition API | External service; subject to Soniox terms, billing, and privacy policy |

The `web/` editor, Python scripts, and documentation in this repository are distributed under the repository's `AGPL-3.0-only` license unless a file states otherwise.
