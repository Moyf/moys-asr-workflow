# Moy's ASR Workflow (MAW)

[![中文 README](https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-2563eb?style=flat-square)](README.md)

[![GitHub Release](https://img.shields.io/github/v/release/Moyf/moys-asr-workflow?display_name=tag&sort=semver)](https://github.com/Moyf/moys-asr-workflow/releases/latest)
[![GitHub Downloads](https://img.shields.io/github/downloads/Moyf/moys-asr-workflow/total?label=downloads)](https://github.com/Moyf/moys-asr-workflow/releases)
[![GitHub Stars](https://img.shields.io/github/stars/Moyf/moys-asr-workflow)](https://github.com/Moyf/moys-asr-workflow/stargazers)
[![License](https://img.shields.io/github/license/Moyf/moys-asr-workflow)](LICENSE)

> Local media → ASR → SRT + `.mosp` project → MAWE editor → export.

MAW is an API-first subtitle generation and editing workflow. It provides Windows/macOS desktop packages, a public CLI, and a local Server editor. Editing and project storage stay on your machine.

## Quick start

1. [Download the latest release](https://github.com/Moyf/moys-asr-workflow/releases/latest). On Windows, choose `MAWxFF-Windows-x64-v*.zip` if FFmpeg is not installed; choose the smaller `MAW-Windows-x64-v*.zip` if `ffmpeg` and `ffprobe` are already available. macOS users should download the corresponding `MAW.app` package.
2. Extract the package and launch `MAW.exe` or `MAW.app`.
3. Configure an ASR provider API key in the Launcher, choose your media, and start transcription.
4. Review and edit the subtitles in MAWE, then export SRT or another supported format.

For installation, provider setup, editing, and troubleshooting, start with the [complete workflow guide](docs/WORKFLOW.md) (currently in Chinese).

## Core capabilities

- Transcribe with Qwen, Fun-ASR, or Soniox and generate SRT plus a `.mosp` project.
- Edit in the MAWE Server editor with waveform navigation, split/merge, silence-gap handling, video preview, and multiple export formats.
- Use the public CLI for batch jobs and AI automation: [CLI documentation](docs/CLI.md) (Chinese).
- [Local Qwen3-ASR / FunASR](docs/LOCAL_ASR.md) and the key-free Bcut ASR path are experimental.

## Documentation

- [Complete workflow](docs/WORKFLOW.md) — installation, provider setup, transcription, editing, export, and troubleshooting.
- [ASR providers and configuration](docs/PROVIDERS.md) — provider choices, API keys, pricing, and privacy boundaries (Chinese).
- [Editor guide](docs/EDITOR_GUIDE.md) — MAWE editing, saving, and export (Chinese).
- [Keyboard timing adjustments](docs/KEYBOARD_ADJUSTMENT.md) — shortcuts and timing rules (Chinese).
- [CLI and automation](docs/CLI.md) — full options, examples, Server management, and exit codes (Chinese).
- [LLM subtitle post-processing protocol](docs/LLM_POSTPROCESS_PROTOCOL.md) — input/output and security boundaries (Chinese).
- [JSON project schema](JSON_SCHEMA.md) — `.mosp` / `.json` data contract (Chinese).
- [Development notes](docs/DEVELOPMENT.md) — product boundaries, data contracts, and development checks (Chinese).

## Data and limitations

- When a cloud provider is selected, media is uploaded directly to that provider. MAW has no hosted transcription service and does not manage your API keys.
- The `.mosp` project is the source of truth. SRT is useful for delivery but does not preserve all word-level timing, waveform, color, or project metadata.
- Pricing, retention, and availability depend on each provider; see [ASR providers and configuration](docs/PROVIDERS.md).
- [Three-minute video overview](https://www.bilibili.com/video/BV1hXum6yELT)

## Support and license

Please use [GitHub Issues](https://github.com/Moyf/moys-asr-workflow/issues) for questions and bug reports. Chinese-language discussion is available in [QQ group 1079160201](https://qm.qq.com/q/4YtxZIpzxC).

Licensed under [AGPL-3.0-only](LICENSE).
