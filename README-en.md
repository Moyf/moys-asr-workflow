# Moy's ASR Workflow (MAW)

[![中文 README](https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-2563eb?style=flat-square)](README.md)

[![GitHub Release](https://img.shields.io/github/v/release/Moyf/moys-asr-workflow?display_name=tag&sort=semver)](https://github.com/Moyf/moys-asr-workflow/releases/latest)
[![GitHub Downloads](https://img.shields.io/github/downloads/Moyf/moys-asr-workflow/total?label=downloads)](https://github.com/Moyf/moys-asr-workflow/releases)
[![GitHub Stars](https://img.shields.io/github/stars/Moyf/moys-asr-workflow)](https://github.com/Moyf/moys-asr-workflow/stargazers)
[![License](https://img.shields.io/github/license/Moyf/moys-asr-workflow)](LICENSE)

> Local media → ASR → SRT + `.mosp` project → MAWE editor → export.

MAW connects subtitle generation with review, cleanup, and delivery. It provides a graphical Launcher, a public CLI, and the local MAWE browser editor, with cloud ASR as the main transcription path. It is suited to subtitle-heavy recordings such as presentations, interviews, and courses.

Use a script to assist proofreading, try reversible pause removal, edit multiple subtitle tracks, and hand the result to other tools. Keep the `.mosp` project so the next revision can continue from your existing work.

![MAWE editor with video and subtitle list on the left, waveform and overlapping subtitles on the right](docs/assets/1.6.0/overlay-track.webp)

*Editor example from 1.6.0: review text and video on the left, adjust timing against the waveform on the right. Workspace layouts are configurable.*

Latest beta: [v1.8.0-beta.1](https://github.com/Moyf/moys-asr-workflow/releases/tag/v1.8.0-beta.1).

## Why MAW

- **Connect text with sound:** retain the word or character timing supplied by your ASR provider, then navigate, split, and adjust boundaries on a multi-row waveform. Segment-only timing still needs listening and is not word-level precision.
- **Put your script to work:** local script matching corrects text without an LLM. Optional AI spoken-recording cleanup treats the transcript as the spoken content and the script as evidence; clear discarded takes can be removed reversibly, while uncertain decisions become review markers.
- **Try the edit before committing to it:** gap removal records reversible decisions without rewriting the original media or subtitle times. Preview the compressed timeline and export matching subtitles, OTIO, or FFconcat for the next tool.
- **Reuse a complete workflow:** ASR presets, sequential batch transcription, and automatic post-processing reduce repeated setup. Inspect stage outputs, retry a failed stage, save the project, and deliver subtitles or a burned-in video.

MAW does not replace a full video editor. ASR output and AI decisions still require human review.

## Quick start

1. [Download a package](https://github.com/Moyf/moys-asr-workflow/releases/latest) for your system and architecture. The full MAW bundle includes FFmpeg/FFprobe; MAW-lite requires both tools installed separately. Keep the complete extracted directory. The official Windows Installer (`MAW-Setup-Windows-x64-v*.exe`, bundled with the MOSE editor) installs per-user under `%LOCALAPPDATA%\Programs\MAW` without administrator rights.
2. Launch `MAW.exe` on Windows or `MAW.app` on macOS.
3. Choose an ASR provider, configure your own key, and transcribe a short sample before processing the full recording.
4. Open MAWE, review the subtitles, save the `.mosp` project, and export SRT or ASS.

For source installation and a complete first run, see the [workflow guide](docs/WORKFLOW.md). Detailed documentation is currently in Chinese.

The official Windows Installer checks for updates at startup at most once per day; you can also check manually in Settings → Software updates. The updater downloads and verifies the newer Installer from the public GitHub Release. Portable, macOS, and Linux copies open the relevant release page for manual downloads. Updates keep `.env`, logs, model caches, and update state under `%LOCALAPPDATA%\MAW`. The Windows installer is not code-signed yet, so SmartScreen may warn on first launch; verify the official source and file hash.

## Core capabilities

- Transcribe with Qwen, Fun-ASR, Soniox, Tencent Cloud, Volcengine Doubao, or an OpenAI-compatible ASR endpoint and generate SRT plus a `.mosp` project.
- Edit in MAWE with multi-row waveform navigation, split/merge, linked boundaries, reversible gap removal, markers and regions, and main, secondary, and overlapping subtitles. The Windows suite also includes the preferred MOSE Electron editor, which shares the MAW Server, `.mosp` project, waveform, media, and export contracts; the Launcher falls back to the Server editor when MOSE is unavailable.
- Review ASS styles, including actual rendered frames in the localhost editor; export main, secondary, or combined bilingual SRT, ASS, TXT, OTIO, and FFconcat as appropriate.
- Match scripts locally or choose AI cleanup, LLM proofreading, translation, and sentence splitting. Automatic processing keeps original snapshots and stage results and can retry from a failed stage.
- Burn subtitles into video, extract a selected audio track, generate green-screen subtitle video, or rebuild media from retained intervals.
- Use the public CLI for batch jobs and AI automation: [CLI documentation](docs/CLI.md) (Chinese).
- [Local ASR models](docs/LOCAL_ASR.md) and the key-free Bcut ASR path are experimental.

## Documentation

- [Documentation index](docs/README.md): user guides, technical contracts, and historical records.
- [Workflow](docs/WORKFLOW.md), [Launcher](docs/LAUNCHER_GUIDE.md), and [providers](docs/PROVIDERS.md): install, configure, and transcribe.
- [Toolbox](docs/TOOLBOX.md) and [automatic processing](docs/POSTPROCESS_PIPELINE.md): script matching, cleanup, translation, OCR, and media tools.
- [Editor](docs/EDITOR_GUIDE.md), [keyboard timing](docs/KEYBOARD_ADJUSTMENT.md), [multiple subtitles](docs/MULTI_SUBTITLE.md), and [ASS styles](docs/ASS_STYLES.md): edit, save, and export.
- [CLI](docs/CLI.md) and [local ASR](docs/LOCAL_ASR.md): automate tasks and use experimental local models.
- [FAQ](docs/FAQ.md), [project schema](JSON_SCHEMA.md), [LLM protocol](docs/LLM_POSTPROCESS_PROTOCOL.md), and [development](docs/DEVELOPMENT.md).

## Data and limitations

Keep the original media and `.mosp` project. Projects contain UTF-8 JSON; older `.json` projects remain supported. SRT and ASS are delivery formats and cannot restore all available word timing, tracks, markers, or editing state. Waveform data is a rebuildable cache, not project source data. The localhost Server supports versioned backups; see the [editor guide](docs/EDITOR_GUIDE.md) for recovery and media relocation.

Cloud transcription sends audio directly to the selected provider. Optional LLM processing sends subtitle text, and AI cleanup also sends script text. MAW has no hosted transcription server; editing and saving normally happen locally. Keys are configured on your machine. Pricing and data policies depend on the provider.

Keep the official suite layout as `MAW\MAW.exe` and `MAW\MOSE\MOSE.exe`; MOSE cannot run without the sibling `MAW.exe`. The `.mosp` association points to `MAW.exe --open-project`, so a double-click passes through the update check before opening MOSE. It is registered only for the current user, respects an existing Windows default-app choice, and still accepts legacy `.json` files without associating that extension.

## Support and license

Please use [GitHub Issues](https://github.com/Moyf/moys-asr-workflow/issues) for questions and bug reports. Chinese-language discussion is available in [QQ group 1079160201](https://qm.qq.com/q/4YtxZIpzxC).

Licensed under [AGPL-3.0-only](LICENSE).
