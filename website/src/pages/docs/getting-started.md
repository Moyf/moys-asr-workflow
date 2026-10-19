---
layout: "../../layouts/DocLayout.astro"
title: "开始使用 MAW"
description: "MAW 的产品简介、安装方式和第一次转写的完整入口。"
source: "README.md"
---

<!-- Generated from README.md. Run pnpm run sync:docs to refresh. -->

[![English README](https://img.shields.io/badge/README-English-2563eb?style=flat-square)](https://github.com/Moyf/moys-asr-workflow/blob/main/README-en.md)
[![GitHub Release](https://img.shields.io/github/v/release/Moyf/moys-asr-workflow?display_name=tag&sort=semver)](https://github.com/Moyf/moys-asr-workflow/releases/latest)
[![GitHub Downloads](https://img.shields.io/github/downloads/Moyf/moys-asr-workflow/total?label=downloads)](https://github.com/Moyf/moys-asr-workflow/releases)
[![GitHub Stars](https://img.shields.io/github/stars/Moyf/moys-asr-workflow)](https://github.com/Moyf/moys-asr-workflow/stargazers)
[![License](https://img.shields.io/github/license/Moyf/moys-asr-workflow)](https://github.com/Moyf/moys-asr-workflow/blob/main/LICENSE)

> 为口播、访谈和课程生成并精修字幕。

MAW 把语音转写、波形校对、文稿整理和字幕导出接成一条工作流。在启动器中选择媒体并生成字幕，再到浏览器编辑器 MAWE 中修文字、调时间，保存工程后可以继续修改。

默认通过云端 API 转写，需要准备服务商的 **API Key**，费用由服务商收取；编辑与工程保存在本机完成。实验性本地模型入口见[本地 ASR](../documentation-index/#user-local-asr)。

[下载正式版](https://github.com/Moyf/moys-asr-workflow/releases/latest) · [官网](https://moyf.github.io/moys-asr-workflow/) · [在线编辑器](https://moyf.github.io/moys-asr-workflow/editor/) · [更新记录](https://moyf.github.io/moys-asr-workflow/releases/) · [3 分钟视频速览](https://www.bilibili.com/video/BV1hXum6yELT)

<img src="../../docs-assets/docs/assets/1.6.0/overlay-track.webp" alt="MAWE 编辑器：左侧视频与字幕列表，右侧多行波形和叠加字幕" loading="lazy" decoding="async" />

*编辑器界面示例（1.6.0）：左侧校对文字与预览，右侧结合波形调整字幕时间。布局可按工作区修改。*

## 为什么用 MAW

- **沿着波形校对文字和时间**：对照声音定位、拆分和调整字幕边界，保留服务商提供的字词时间码。只有句级时间码时仍需试听，不会自动变成逐词精度。
- **用文稿和 AI 减少重复整理**：已有文稿可在本地辅助修正文字；可选的 AI 口播整理帮助找出重复录制和废话，留下待复核标记与对比结果。配合可恢复的空隙移除，先试听，再决定保留哪些内容。
- **从一份工程交付多种字幕**：管理主副字幕、叠加字幕和说话人，调整 ASS 样式，导出 SRT / ASS 或烧录视频；需要继续剪辑时，也可导出 OTIO 等交换文件。
- **让下一次修改接着做**：`.mosp` 工程保留时间码、轨道、标记和编辑状态；识别预设、批量转写与自动后处理帮助复用常用流程，阶段结果可以检查和重试。

本文按当前 **1.9 测试版**介绍功能；正式版可用能力以[对应更新记录](https://moyf.github.io/moys-asr-workflow/releases/)为准。MAW 不替代完整剪辑软件，转写和 AI 整理的结果仍需人工检查。

## 开始使用

先选版本：[正式版](https://github.com/Moyf/moys-asr-workflow/releases/latest)适合日常使用；想体验当前的新功能，可选测试版 [v1.9.0-beta.3](https://github.com/Moyf/moys-asr-workflow/releases/tag/v1.9.0-beta.3)，并保留工程备份。

1. **下载安装包**：在所选版本的附件中选择对应系统和架构。完整版 `MAW` 包含 FFmpeg / FFprobe；已安装这两个工具时可选 `MAW-lite`。实际可下载平台以该版本附件为准。
2. **打开启动器**：Windows 解压完整目录后运行 `MAW.exe`；macOS 打开 `MAW.app`；Linux 为 `.AppImage` 授予执行权限后启动。启动问题见[常见问题](../documentation-index/#user-faq)。
3. **先生成一小段字幕**：选择服务商、配置 API Key，导入一两分钟的短素材，确认转写成功后再处理完整录音。
4. **校对、保存、导出**：点击「打开编辑器」，检查文字和时间；先保存 `.mosp` 工程，再导出 SRT 或 ASS。下次修改时重新打开工程即可。

源码安装、命令行起步和媒体迁移见 [从零完成一次字幕工程](../documentation-index/#user-workflow)；遇到启动或转写问题看 [常见问题](../documentation-index/#user-faq)。

## 版本与更新

- [官网更新记录](https://moyf.github.io/moys-asr-workflow/releases/)：查看历代正式版的图文介绍与可用安装包。
- [全部 GitHub Releases](https://github.com/Moyf/moys-asr-workflow/releases)：下载正式版和测试版。
- [CHANGELOG](https://github.com/Moyf/moys-asr-workflow/blob/main/CHANGELOG.md)：查看未发布变化与 beta 历史；正式版正文也保存在仓库的[版本归档](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/releases/)中。

## 按任务查文档

| 你要做的事 | 文档 |
| --- | --- |
| 第一次安装并完成字幕 | [完整工作流](../documentation-index/#user-workflow) |
| 配置模型、热词、预设或批量任务 | [Launcher 指南](../documentation-index/#user-launcher) · [服务商配置](../documentation-index/#user-providers) |
| 校对、匹配文稿、翻译或处理媒体 | [工具箱](../documentation-index/#user-toolbox) · [自动处理](../documentation-index/#user-postprocess) |
| 编辑时间轴、保存和导出 | [编辑器指南](../documentation-index/#user-editor) · [ASS 样式](../documentation-index/#user-ass) |
| 写批处理或接入自动化 | [CLI](../documentation-index/#user-cli) |
| 已有准确文稿与录音，跳过 ASR 生成字幕 | [文稿驱动对齐（实验性）](../documentation-index/#user-script-alignment) |
| 开发与数据集成 | [开发概览](../documentation-index/#engineering-development) · [工程格式](../json-schema/) |

全部专题、技术契约与历史记录见 [文档索引](../documentation-index/)。

## 数据、费用与隐私

保留原始媒体和 `.mosp` 工程；工程内容是 UTF-8 JSON，旧 `.json` 工程继续支持。SRT / ASS 是交付格式，不能代替包含可用字词时间码、编辑状态、主副轨和标记等数据的工程。波形是可重建缓存，不是工程真源。本机 Server 支持多版本备份，恢复与媒体迁移见 [编辑器指南](../documentation-index/#user-editor)。

云端转写会将音频发送给你选择的服务商；LLM 后处理会发送字幕文字，AI 整理还会发送文稿文字。MAW 没有自己的云端转写服务器，编辑和保存默认在本机完成。API Key 在本机配置，费用和数据政策见 [服务商配置](../documentation-index/#user-providers)。

## 反馈与许可

问题和建议请提 [GitHub Issues](https://github.com/Moyf/moys-asr-workflow/issues)；交流可加入 [QQ 群 1079160201](https://qm.qq.com/q/4YtxZIpzxC)。反馈前请移除密钥与私人素材。

本项目采用 [AGPL-3.0-only](https://github.com/Moyf/moys-asr-workflow/blob/main/LICENSE)。贡献要求见 [CONTRIBUTING.md](https://github.com/Moyf/moys-asr-workflow/blob/main/CONTRIBUTING.md)。

<details>
<summary>Star History</summary>

<a href="https://www.star-history.com/?repos=Moyf%2Fmoys-asr-workflow&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&theme=dark&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
 </picture>
</a>

</details>
