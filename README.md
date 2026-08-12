# Moy's ASR Workflow（MAW）

[![English README](https://img.shields.io/badge/README-English-2563eb?style=flat-square)](README-en.md)

[![GitHub Release](https://img.shields.io/github/v/release/Moyf/moys-asr-workflow?display_name=tag&sort=semver)](https://github.com/Moyf/moys-asr-workflow/releases/latest)
[![GitHub Downloads](https://img.shields.io/github/downloads/Moyf/moys-asr-workflow/total?label=downloads)](https://github.com/Moyf/moys-asr-workflow/releases)
[![GitHub Stars](https://img.shields.io/github/stars/Moyf/moys-asr-workflow)](https://github.com/Moyf/moys-asr-workflow/stargazers)
[![License](https://img.shields.io/github/license/Moyf/moys-asr-workflow)](LICENSE)

> 本地媒体 → AI 转写 → SRT + `.mosp` 工程 → MAWE 编辑 → 导出。

MAW 是一个以 API 转写为主的字幕生成与编辑工作流。它提供 Windows/macOS 图形版、公开 CLI 和本机 Server 编辑器；字幕编辑与工程保存都在本机完成。

## 快速开始

1. [下载最新版](https://github.com/Moyf/moys-asr-workflow/releases/latest)。Windows 没有 FFmpeg 时选择 `MAWxFF-Windows-x64-v*.zip`；已安装 `ffmpeg` / `ffprobe` 时选择体积更小的 `MAW-Windows-x64-v*.zip`，macOS 下载对应的 `MAW.app`。
2. 解压并启动 `MAW.exe` 或 `MAW.app`。
3. 在 Launcher 配置转写服务的 API Key，选择媒体并点击生成。
4. 在 MAWE 中检查、编辑字幕，导出 SRT 或其他格式。

第一次使用、API 配置、编辑和排错：请从[完整工作流](docs/WORKFLOW.md)开始。

## 核心能力

- 使用 Qwen / Fun-ASR / Soniox 转写，生成 SRT 与 `.mosp` 工程。
- MAWE Server 编辑器支持波形定位、拆分合并、静音空隙处理、画面预览和多种导出格式。
- 公开 CLI 可用于批处理和 AI 自动化，详见[命令行文档](docs/CLI.md)。
- [本地 Qwen3-ASR / FunASR](docs/LOCAL_ASR.md) 和免 Key 的必剪 ASR 均属于实验性入口，仅适合体验。

## 文档

- [完整工作流](docs/WORKFLOW.md) ：安装、配置、转写、编辑、导出和排错。
- [ASR 服务与配置](docs/PROVIDERS.md) ：服务商选择、Key、费用和隐私边界。
- [编辑器指南](docs/EDITOR_GUIDE.md) ：MAWE 的编辑、保存和导出。
- [字幕按键调整](docs/KEYBOARD_ADJUSTMENT.md) ：快捷键和时间微调规则。
- [命令行与自动化](docs/CLI.md) ：完整参数、范例、Server 管理和退出码。
- [LLM 字幕后处理协议](docs/LLM_POSTPROCESS_PROTOCOL.md) ：后处理的输入输出与安全边界。
- [OCR 字幕去重](docs/OCR_SUBTITLE_DEDUP.md) ：画面字幕识别、禁用规则、视频输入、报告和性能说明。
- [JSON 工程文件规范](JSON_SCHEMA.md) ：`.mosp` / `.json` 数据契约。
- [开发说明](docs/DEVELOPMENT.md) ：产品边界、数据契约和开发检查。

## 重要说明

- 选择云端服务转写时，媒体会直接上传到对应服务商；MAW 没有自己的云端服务器，也不会代管 API Key。
- `.mosp` 工程是字幕真源；SRT 适合交付，但不会保留全部字级时间码、波形、颜色和其他工程数据。
- 费用、数据保留和服务可用性以服务商当前政策为准，详见[ASR 服务与配置](docs/PROVIDERS.md)。
- [3 分钟视频速览](https://www.bilibili.com/video/BV1hXum6yELT)

## Star History

<a href="https://www.star-history.com/?repos=Moyf%2Fmoys-asr-workflow&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&theme=dark&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
 </picture>
</a>

## 反馈与许可

问题和建议请提 [GitHub Issues](https://github.com/Moyf/moys-asr-workflow/issues)；交流可加入 [QQ 群 1079160201](https://qm.qq.com/q/4YtxZIpzxC)。

本项目采用 [AGPL-3.0-only](LICENSE)。
