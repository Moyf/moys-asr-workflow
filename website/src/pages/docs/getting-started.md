---
layout: "../../layouts/DocLayout.astro"
title: "开始使用 MAW"
description: "MAW 的产品简介、安装方式和第一次转写的完整入口。"
source: "README.md"
---

<!-- Generated from README.md. Run npm run sync:docs to refresh. -->

[![English README](https://img.shields.io/badge/README-English-2563eb?style=flat-square)](https://github.com/Moyf/moys-asr-workflow/blob/main/README-en.md)
[![GitHub Release](https://img.shields.io/github/v/release/Moyf/moys-asr-workflow?display_name=tag&sort=semver)](https://github.com/Moyf/moys-asr-workflow/releases/latest)
[![GitHub Downloads](https://img.shields.io/github/downloads/Moyf/moys-asr-workflow/total?label=downloads)](https://github.com/Moyf/moys-asr-workflow/releases)
[![GitHub Stars](https://img.shields.io/github/stars/Moyf/moys-asr-workflow)](https://github.com/Moyf/moys-asr-workflow/stargazers)
[![License](https://img.shields.io/github/license/Moyf/moys-asr-workflow)](https://github.com/Moyf/moys-asr-workflow/blob/main/LICENSE)

> 本地媒体 → ASR 转写 → SRT + `.mosp` 工程 → MAWE 编辑 → 导出。

MAW 是以云端 API 转写为主的字幕生成与编辑工作流，提供图形 Launcher、命令行和本机浏览器编辑器。你可以生成字幕、检查字词时间码、调整波形时间轴，再交付字幕或剪辑交换文件。

[官网](https://moyf.github.io/moys-asr-workflow/) · [在线编辑器](https://moyf.github.io/moys-asr-workflow/editor/) · [3 分钟视频速览](https://www.bilibili.com/video/BV1hXum6yELT)

<img src="../../docs-assets/docs/assets/1.6.0/overlay-track.webp" alt="MAWE 编辑器：左侧视频与字幕列表，右侧多行波形和叠加字幕" loading="lazy" decoding="async" />

*编辑器界面示例（1.6.0）：左侧校对文字与预览，右侧结合波形调整字幕时间。布局可按工作区修改。*

## 开始使用

最新测试版：[v1.8.0-beta.1](https://github.com/Moyf/moys-asr-workflow/releases/tag/v1.8.0-beta.1)。下方 Releases 入口提供稳定版。

1. 从 [Releases](https://github.com/Moyf/moys-asr-workflow/releases/latest) 选择与你的系统和架构对应的包。完整版 `MAW` 包含 FFmpeg / FFprobe；`MAW-lite` 需要自行安装这两个工具。实际可下载平台以该版本附件为准。
2. 解压完整目录，启动 Windows 的 `MAW.exe` 或 macOS 的 `MAW.app`。
3. 在 Launcher 选择服务商、配置自己的 API Key，选择媒体并生成字幕。首次配置可先用 `2m` 做短片验证。
4. 打开 MAWE 检查文字和时间，保存 `.mosp` 工程，再导出 SRT 或 ASS。

源码安装、命令行起步和媒体迁移见 [从零完成一次字幕工程](../workflow/)；遇到启动或转写问题看 [常见问题](../faq/)。

本分支提供 [MOSE Electron 桌面编辑器](../mose/)：Windows 使用 MAW + MOSE 套件或 Installer，macOS/Linux 配置独立 DMG/ZIP 与 AppImage/DEB。原生打开、拖入和另存为会绑定真实文件路径并记录最近工程；Windows Installer 的更新入口保留在 Launcher。实际可下载平台以 Release 附件为准，当前平台验证范围见 [检查记录](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/TEST_FEEDBACK_ELECTRON_INTEGRATION.md)。

## 可以做什么

- 云端转写：Qwen-Audio / Qwen3-ASR / Fun-ASR、Soniox、豆包、腾讯云，以及返回时间戳的 OpenAI 兼容接口。
- 图形任务：单文件与顺序批量转写、识别预设、转写后自动处理，以及字幕和媒体工具箱。
- 字幕编辑：波形定位、拆分合并、多重字幕（可直接新建空副轨）、颜色与表情包、标记与区段、可撤销的空隙移除。
- 桌面编辑：MOSE 复用同一 Server 和工程格式，提供原生保存、媒体重定位、系统工程打开方式与文档图标；Launcher 未找到 MOSE 时回退到浏览器 Server。
- 导出：SRT、ASS、TXT，以及按用途提供的 OTIO、FFconcat 等交换文件。
- 实验性入口：Launcher 与 CLI 的本地模型、免 Key 的必剪 ASR。范围和运行环境见 [本地 ASR](../local-asr/)。

## 按任务查文档

| 你要做的事 | 文档 |
| --- | --- |
| 第一次安装并完成字幕 | [完整工作流](../workflow/) |
| 配置模型、热词、预设或批量任务 | [Launcher 指南](../launcher/) · [服务商配置](../providers/) |
| 校对、匹配文稿、翻译或处理媒体 | [工具箱](../toolbox/) · [自动处理](../postprocess-pipeline/) |
| 编辑时间轴、保存和导出 | [编辑器指南](../editor-guide/) · [ASS 样式](../ass-styles/) |
| 写批处理或接入自动化 | [CLI](../cli/) |
| 开发与数据集成 | [开发概览](../development/) · [工程格式](../json-schema/) |

全部专题、技术契约与历史记录见 [文档索引](../documentation-index/)。

## 文件与数据

保留原始媒体和 `.mosp` 工程；工程内容是 UTF-8 JSON，旧 `.json` 工程继续支持。SRT / ASS 是交付格式，不能代替包含字词时间码、编辑状态与其他数据的工程。波形是可重建缓存。

云端转写会将音频发送给你选择的服务商；LLM 后处理会发送字幕文字，AI 整理还会发送文稿文字。MAW 没有自己的云端转写服务器，编辑和保存默认在本机完成。API Key 在本机配置，费用和数据政策见 [服务商配置](../providers/)。

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

本项目采用 [AGPL-3.0-only](https://github.com/Moyf/moys-asr-workflow/blob/main/LICENSE)。贡献要求见 [CONTRIBUTING.md](https://github.com/Moyf/moys-asr-workflow/blob/main/CONTRIBUTING.md)。
