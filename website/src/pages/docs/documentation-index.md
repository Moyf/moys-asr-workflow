---
layout: "../../layouts/DocLayout.astro"
title: "文档索引"
description: "按任务查找使用指南、工程契约与历史记录。"
source: "docs/README.md"
---

<!-- Generated from docs/README.md. Run pnpm run sync:docs to refresh. -->

第一次使用从 [WORKFLOW](../workflow/) 开始。本文按任务组织文档；日常使用说明与开发记录分开维护。

维护与 AI 按需阅读规则见 [AgentsMD](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/AgentsMD.md)；默认不批量读取历史归档。

## 推荐阅读顺序

1. [工作流](../workflow/)：先完成一次安装、转写、保存与导出，无需先读全部参数。
2. [Launcher 指南](../launcher/) 与 [编辑器指南](../editor-guide/)：掌握日常识别与校对；遇到问题再查 [FAQ](../faq/)。
3. 按需阅读 [多重字幕](../multi-subtitle/)、[ASS 样式](../ass-styles/)、[工具箱](../toolbox/) 和 [自动处理](../postprocess-pipeline/)；本地模型与 OCR 需要额外环境。
4. 自动化或开发时再查 [CLI](../cli/)、[工程格式](../json-schema/) 与 [开发概览](../development/)。

## 安装与转写

| 文档 | 内容 |
| --- | --- |
| [工作流](../workflow/) | 安装、第一次转写、打开工程和交付的最短路径。 |
| [Launcher 指南](../launcher/) | 识别设置、音轨、预设、批量队列、输出目录和通知。 |
| [服务商配置](../providers/) | 各服务的配置字段、能力边界、费用与数据政策入口。 |
| [本地 ASR](../local-asr/) | 实验性模型、独立运行环境、缓存、设备和时间码。 |
| [文稿驱动对齐](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/SCRIPT_DRIVEN_ALIGNMENT.md) | 准确文稿与录音直接生成字词时间码字幕，跳过 ASR；静音与人工锚点。 |
| [相近能力对比](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/ALIGNMENT_FEATURES.md) | 文稿生成、时间码修复、文稿匹配、口播对齐与 AI 整理的差异、选择和演进建议。 |
| [CLI](../cli/) | 公开命令行参数、底层脚本区别、Server 管理和自动化。 |
| [FAQ](../faq/) | 启动、FFmpeg、API、媒体加载、保存与反馈。 |

## 编辑与处理

| 文档 | 内容 |
| --- | --- |
| [编辑器指南](../editor-guide/) | 字幕编辑、播放、时间调整、保存、备份和导出。 |
| [按键调整](../keyboard-adjustment/) | 时间微调与相邻字幕联动规则。 |
| [多重字幕](../multi-subtitle/) | 主副轨、绑定、拆分、吸附与联动的完整说明。 |
| [ASS 样式](../ass-styles/) | 样式库、预览、特殊文本与 ASS 导出。 |
| [工具箱](../toolbox/) | 文稿匹配、AI 整理、LLM、固定替换和媒体处理。 |
| [转写后自动处理](../postprocess-pipeline/) | 固定处理链、连接预检、中间产物与失败重试。 |
| [OCR 字幕去重](../ocr-subtitle-dedup/) | 可选 OCR 环境、识别范围与报告。 |
| [Server 启动说明](https://github.com/Moyf/moys-asr-workflow/blob/main/server-editor/README.md) | 源码服务参数、端口、工程接管与本机设置。 |

## 契约与开发

| 文档 | 内容 |
| --- | --- |
| [工程格式](../json-schema/) | `.mosp` / `.json` 的正式字段契约，整数毫秒时间码。 |
| [LLM 后处理协议](../llm-postprocess/) | 模型输入输出、ID 校验、本地时间映射和 HTTP 契约。 |
| [空隙来源与恢复](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/GAP_PROVENANCE.md) | 空隙来源层、恢复语义与数据规则。 |
| [开发概览](../development/) | 代码地图、持久化边界、测试与发布检查。 |
| [e2e 挂起排查](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/E2E_SERVER_HANG.md) | Playwright 残留 serve.py 的诊断、清理与运行纪律。 |
| [MAW / MAWE / MOSE](../mose/) | 产品名称与桌面路线决策（Electron 发布路线，Tauri 实验已移除）。 |
| [桌面开发](https://github.com/Moyf/moys-asr-workflow/blob/main/desktop/README.md) | Electron 桌面壳的架构定位与 Tauri 移除决策记录。 |
| [官网文档同步](https://github.com/Moyf/moys-asr-workflow/blob/main/website/docs/CONTENT_SYNC.md) | 从源文档生成官网页面的步骤。 |

## 待办、方案与历史

尚需行动或验证的事项统一见 [OPEN_ITEMS](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/OPEN_ITEMS.md)；未实施方案放 `plans/`，不属于当前功能说明。

反馈、审查、实施台账、预演和发布核查过程统一放在 [历史分类目录](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/_archied/README.md)。归档不代表全部验收完成，日常无需批量阅读；当前版本变化看 [CHANGELOG](https://github.com/Moyf/moys-asr-workflow/blob/main/CHANGELOG.md)。维护规则见 [AgentsMD](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/AgentsMD.md)。
