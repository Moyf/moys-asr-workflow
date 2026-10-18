# Moy's ASR Workflow (MAW)

[![中文 README](https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-2563eb?style=flat-square)](README.md)

[![GitHub Release](https://img.shields.io/github/v/release/Moyf/moys-asr-workflow?display_name=tag&sort=semver)](https://github.com/Moyf/moys-asr-workflow/releases/latest)
[![GitHub Downloads](https://img.shields.io/github/downloads/Moyf/moys-asr-workflow/total?label=downloads)](https://github.com/Moyf/moys-asr-workflow/releases)
[![GitHub Stars](https://img.shields.io/github/stars/Moyf/moys-asr-workflow)](https://github.com/Moyf/moys-asr-workflow/stargazers)
[![License](https://img.shields.io/github/license/Moyf/moys-asr-workflow)](LICENSE)

> Generate and refine subtitles for spoken videos, interviews, and courses.

MAW connects speech transcription, waveform editing, script-assisted cleanup, and subtitle export. Generate subtitles in the Launcher, review text and timing in the MAWE browser editor, and save a project to continue editing later.

The default transcription path uses cloud APIs: bring your own **API key** and pay the selected provider. Editing and project storage happen locally. [Local ASR models](docs/INDEX.md#user-local-asr) are experimental.

[Download](https://github.com/Moyf/moys-asr-workflow/releases/latest) · [Website](https://moyf.github.io/moys-asr-workflow/) · [Online editor](https://moyf.github.io/moys-asr-workflow/editor/) · [Release history](https://moyf.github.io/moys-asr-workflow/releases/)

![MAWE editor with video and subtitle list on the left, waveform and overlapping subtitles on the right](docs/assets/1.6.0/overlay-track.webp)

*Editor example from 1.6.0: review text and video on the left, adjust timing against the waveform on the right. Workspace layouts are configurable.*

## Why MAW

- **Review against the waveform:** locate, split, and adjust subtitle boundaries while retaining the word or character timing supplied by your ASR provider. Segment-only timing still needs listening; it does not become word-level precision automatically.
- **Reduce repetitive cleanup:** match an existing script locally, or use optional AI cleanup to identify repeated takes and filler with review markers and comparison results. Preview reversible gap removal before deciding what to keep.
- **Deliver several subtitle formats from one project:** manage main, secondary, and overlapping subtitles, speakers, and ASS styles. Export SRT / ASS or burn subtitles into video; use OTIO and other exchange formats for further editing.
- **Continue from your last edit:** a `.mosp` project preserves timing, tracks, markers, and editing state. Presets, batch transcription, and automatic processing help reuse common workflows with inspectable, retryable stage outputs.

This overview describes the current **1.9 beta** workflow. Check the corresponding [release notes](https://moyf.github.io/moys-asr-workflow/releases/) for stable-version availability. MAW does not replace a full video editor; transcription and AI decisions still need human review.

## Quick start

Choose the [stable release](https://github.com/Moyf/moys-asr-workflow/releases/latest) for everyday use. To try current new features, choose [v1.9.0-beta.3](https://github.com/Moyf/moys-asr-workflow/releases/tag/v1.9.0-beta.3) and keep project backups.

1. **Download a package:** choose your system and architecture from the selected release's attachments. The full MAW bundle includes FFmpeg/FFprobe; choose MAW-lite if both tools are already installed. Platform availability depends on that release's actual attachments.
2. **Open the Launcher:** extract the complete directory and run `MAW.exe` on Windows, open `MAW.app` on macOS, or grant execution permission to the Linux `.AppImage` and launch it. See the [FAQ](docs/INDEX.md#user-faq) for startup issues.
3. **Try a short recording:** choose a provider, configure your API key, and transcribe a one- or two-minute sample before processing a complete recording.
4. **Review, save, and export:** open the editor, check text and timing, save the `.mosp` project, and export SRT or ASS. Reopen the project for future revisions.

For source installation and a complete first run, see the [workflow guide](docs/INDEX.md#user-workflow). Detailed documentation is currently in Chinese.

## Versions and updates

- [Release history](https://moyf.github.io/moys-asr-workflow/releases/): illustrated notes for stable versions, version navigation, and available downloads. Notes are currently in Chinese.
- [All GitHub Releases](https://github.com/Moyf/moys-asr-workflow/releases): stable and prerelease packages.
- [CHANGELOG](CHANGELOG.md): unreleased changes, beta history, and the source for stable release notes, also saved in the [release archive](docs/releases/).

## Documentation

- [Documentation index](docs/INDEX.md): user guides, technical contracts, and historical records.
- [Workflow](docs/INDEX.md#user-workflow), [Launcher](docs/INDEX.md#user-launcher), and [providers](docs/INDEX.md#user-providers): install, configure, and transcribe.
- [Toolbox](docs/INDEX.md#user-toolbox) and [automatic processing](docs/INDEX.md#user-postprocess): script matching, cleanup, translation, OCR, and media tools.
- [Editor](docs/INDEX.md#user-editor), [keyboard timing](docs/INDEX.md#user-keyboard), [multiple subtitles](docs/INDEX.md#user-multi-subtitle), and [ASS styles](docs/INDEX.md#user-ass): edit, save, and export.
- [CLI](docs/INDEX.md#user-cli) and [local ASR](docs/INDEX.md#user-local-asr): automate tasks and use experimental local models.
- [FAQ](docs/INDEX.md#user-faq), [project schema](JSON_SCHEMA.md), [LLM protocol](docs/INDEX.md#engineering-llm), and [development](docs/INDEX.md#engineering-development).

## Data, costs, and privacy

Keep the original media and `.mosp` project. Projects contain UTF-8 JSON; older `.json` projects remain supported. SRT and ASS are delivery formats and cannot restore all available word timing, tracks, markers, or editing state. Waveform data is a rebuildable cache, not project source data. The localhost Server supports versioned backups; see the [editor guide](docs/INDEX.md#user-editor) for recovery and media relocation.

Cloud transcription sends audio directly to the selected provider. Optional LLM processing sends subtitle text, and AI cleanup also sends script text. MAW has no hosted transcription server; editing and saving normally happen locally. Keys are configured on your machine. Pricing and data policies depend on the provider.

## Support and license

Please use [GitHub Issues](https://github.com/Moyf/moys-asr-workflow/issues) for questions and bug reports. Chinese-language discussion is available in [QQ group 1079160201](https://qm.qq.com/q/4YtxZIpzxC).

Licensed under [AGPL-3.0-only](LICENSE).
