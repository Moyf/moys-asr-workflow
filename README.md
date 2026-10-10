# Moy's ASR Workflow（MAW）

[![English README](https://img.shields.io/badge/README-English-2563eb?style=flat-square)](README-en.md)
[![GitHub Release](https://img.shields.io/github/v/release/Moyf/moys-asr-workflow?display_name=tag&sort=semver)](https://github.com/Moyf/moys-asr-workflow/releases/latest)
[![GitHub Downloads](https://img.shields.io/github/downloads/Moyf/moys-asr-workflow/total?label=downloads)](https://github.com/Moyf/moys-asr-workflow/releases)
[![GitHub Stars](https://img.shields.io/github/stars/Moyf/moys-asr-workflow)](https://github.com/Moyf/moys-asr-workflow/stargazers)
[![License](https://img.shields.io/github/license/Moyf/moys-asr-workflow)](LICENSE)

> 本地媒体 → ASR 转写 → SRT + `.mosp` 工程 → MAWE 编辑 → 导出。

MAW 帮你把字幕生成后的校对、整理和交付接起来。它以云端 API 转写为主，提供图形 Launcher、命令行和本机浏览器编辑器 MAWE，适合口播、访谈、课程等字幕密集的内容。

除了修改文字和时间，你还可以用文稿辅助校对、可逆地移除停顿、管理主副字幕，再交付字幕或剪辑交换文件。保留 `.mosp` 工程，下一次修改就能从当前结果继续。

[官网](https://moyf.github.io/moys-asr-workflow/) · [在线编辑器](https://moyf.github.io/moys-asr-workflow/editor/) · [3 分钟视频速览](https://www.bilibili.com/video/BV1hXum6yELT)

![MAWE 编辑器：左侧视频与字幕列表，右侧多行波形和叠加字幕](docs/assets/1.6.0/overlay-track.webp)

*编辑器界面示例（1.6.0）：左侧校对文字与预览，右侧结合波形调整字幕时间。布局可按工作区修改。*

## 为什么用 MAW

- **文字与声音对应起来**：保留服务商提供的字词时间码，在多行波形上定位、拆分和调整边界；只有句级时间码的结果仍需试听，不能当成逐词精度。
- **已有文稿帮你减少重复校对**：普通文稿匹配在本地修正文字，无需 LLM；可选的 AI 口播整理以录音转写为准，把文稿当证据，明确废片可逆移除，疑点写入标记与区段等待复核。
- **先试剪，再决定**：空隙移除保存可撤销的编辑决定，原媒体和原字幕时间不变。试听压缩后的节奏，再导出去空隙字幕、OTIO 或 FFconcat 交给后续工具。
- **从一次任务到固定流程**：识别预设、顺序批量转写与自动后处理串起常用步骤；阶段产物可查，失败步骤可重试，最终保存工程并交付 SRT、ASS 或烧录视频。

这些能力服务于同一条工作流。MAW 不替代完整剪辑软件，ASR 和 AI 整理的结果仍需人工检查。

## 开始使用

最新测试版：[v1.8.0-beta.1](https://github.com/Moyf/moys-asr-workflow/releases/tag/v1.8.0-beta.1)。下方 Releases 入口提供稳定版。

1. 从 [Releases](https://github.com/Moyf/moys-asr-workflow/releases/latest) 选择与你的系统和架构对应的包。完整版 `MAW` 包含 FFmpeg / FFprobe；`MAW-lite` 需要自行安装这两个工具。实际可下载平台以该版本附件为准。
2. 解压完整目录，启动 Windows 的 `MAW.exe` 或 macOS 的 `MAW.app`。
3. 在 Launcher 选择服务商、配置自己的 API Key，选择媒体并生成字幕。首次配置可先用 `2m` 做短片验证。
4. 打开 MAWE 检查文字和时间，保存 `.mosp` 工程，再导出 SRT 或 ASS。

源码安装、命令行起步和媒体迁移见 [从零完成一次字幕工程](docs/WORKFLOW.md)；遇到启动或转写问题看 [常见问题](docs/FAQ.md)。

## 可以做什么

- 云端转写：Qwen-Audio / Qwen3-ASR / Fun-ASR、Soniox、豆包、腾讯云，以及返回时间戳的 OpenAI 兼容接口。
- 图形任务：单文件与顺序批量转写、识别预设、转写后自动处理；后处理保留原始快照和阶段结果，可从失败步骤重试。
- 文稿与整理：本地文稿匹配、固定替换、LLM 校对/断句/翻译，以及可选的 AI 口播整理与待复核标记。
- 字幕编辑：多行波形定位、拆分合并与中缝联动、主/副/叠加字幕、说话人颜色、表情包、标记与区段、可撤销的空隙移除。
- 呈现与导出：ASS 样式与本机实际渲染帧预览，主字幕/副字幕/双语整合 SRT、ASS、TXT，以及按用途提供的 OTIO、FFconcat 等交换文件。
- 媒体工具：烧录字幕、提取指定音轨、生成绿幕字幕视频，以及按保留区间重组媒体。
- 实验性入口：Launcher 与 CLI 的本地模型、免 Key 的必剪 ASR。范围和运行环境见 [本地 ASR](docs/LOCAL_ASR.md)。

## 按任务查文档

| 你要做的事 | 文档 |
| --- | --- |
| 第一次安装并完成字幕 | [完整工作流](docs/WORKFLOW.md) |
| 配置模型、热词、预设或批量任务 | [Launcher 指南](docs/LAUNCHER_GUIDE.md) · [服务商配置](docs/PROVIDERS.md) |
| 校对、匹配文稿、翻译或处理媒体 | [工具箱](docs/TOOLBOX.md) · [自动处理](docs/POSTPROCESS_PIPELINE.md) |
| 编辑时间轴、保存和导出 | [编辑器指南](docs/EDITOR_GUIDE.md) · [ASS 样式](docs/ASS_STYLES.md) |
| 写批处理或接入自动化 | [CLI](docs/CLI.md) |
| 让自己的 Agent 查询字幕、提交修改或范围重听写 | [Agent 接口与 Skill](docs/AGENT_INTERFACE.md) |
| 已有准确文稿与录音，跳过 ASR 生成字幕 | [文稿驱动对齐（实验性）](docs/SCRIPT_DRIVEN_ALIGNMENT.md) |
| 开发与数据集成 | [开发概览](docs/DEVELOPMENT.md) · [工程格式](JSON_SCHEMA.md) · [ESM 迁移与上游交接](docs/dev/ESM_MIGRATION.md) |

全部专题、技术契约与历史记录见 [文档索引](docs/README.md)。

## 文件与数据

保留原始媒体和 `.mosp` 工程；工程内容是 UTF-8 JSON，旧 `.json` 工程继续支持。SRT / ASS 是交付格式，不能代替包含可用字词时间码、编辑状态、主副轨和标记等数据的工程。波形是可重建缓存，不是工程真源。本机 Server 支持多版本备份，恢复与媒体迁移见 [编辑器指南](docs/EDITOR_GUIDE.md)。

云端转写会将音频发送给你选择的服务商；LLM 后处理会发送字幕文字，AI 整理还会发送文稿文字。MAW 没有自己的云端转写服务器，编辑和保存默认在本机完成。API Key 在本机配置，费用和数据政策见 [服务商配置](docs/PROVIDERS.md)。

## Star History

<a href="https://www.star-history.com/?repos=Moyf%2Fmoys-asr-workflow&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&theme=dark&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
 </picture>
</a>

## 反馈与许可

问题和建议请提 [GitHub Issues](https://github.com/Moyf/moys-asr-workflow/issues)；交流可加入 [QQ 群 1079160201](https://qm.qq.com/q/4YtxZIpzxC)。反馈前请移除密钥与私人素材。

本项目采用 [AGPL-3.0-only](LICENSE)。贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。
