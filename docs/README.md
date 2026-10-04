# 文档索引

第一次使用从 [WORKFLOW](WORKFLOW.md) 开始。本文按任务组织文档；日常使用说明与开发记录分开维护。

## 推荐阅读顺序

1. [工作流](WORKFLOW.md)：先完成一次安装、转写、保存与导出，无需先读全部参数。
2. [Launcher 指南](LAUNCHER_GUIDE.md) 与 [编辑器指南](EDITOR_GUIDE.md)：掌握日常识别与校对；遇到问题再查 [FAQ](FAQ.md)。
3. 按需阅读 [多重字幕](MULTI_SUBTITLE.md)、[ASS 样式](ASS_STYLES.md)、[工具箱](TOOLBOX.md) 和 [自动处理](POSTPROCESS_PIPELINE.md)；本地模型与 OCR 需要额外环境。
4. 自动化或开发时再查 [CLI](CLI.md)、[工程格式](../JSON_SCHEMA.md) 与 [开发概览](DEVELOPMENT.md)。

## 安装与转写

| 文档 | 内容 |
| --- | --- |
| [工作流](WORKFLOW.md) | 安装、第一次转写、打开工程和交付的最短路径。 |
| [Launcher 指南](LAUNCHER_GUIDE.md) | 识别设置、音轨、预设、批量队列、输出目录和通知。 |
| [服务商配置](PROVIDERS.md) | 各服务的配置字段、能力边界、费用与数据政策入口。 |
| [本地 ASR](LOCAL_ASR.md) | 实验性模型、独立运行环境、缓存、设备和时间码。 |
| [CLI](CLI.md) | 公开命令行参数、底层脚本区别、Server 管理和自动化。 |
| [FAQ](FAQ.md) | 启动、FFmpeg、API、媒体加载、保存与反馈。 |

## 编辑与处理

| 文档 | 内容 |
| --- | --- |
| [编辑器指南](EDITOR_GUIDE.md) | 字幕编辑、播放、时间调整、保存、备份和导出。 |
| [按键调整](KEYBOARD_ADJUSTMENT.md) | 时间微调与相邻字幕联动规则。 |
| [多重字幕](MULTI_SUBTITLE.md) | 主副轨、绑定、拆分、吸附与联动的完整说明。 |
| [ASS 样式](ASS_STYLES.md) | 样式库、预览、特殊文本与 ASS 导出。 |
| [工具箱](TOOLBOX.md) | 文稿匹配、AI 整理、LLM、固定替换和媒体处理。 |
| [转写后自动处理](POSTPROCESS_PIPELINE.md) | 固定处理链、连接预检、中间产物与失败重试。 |
| [OCR 字幕去重](OCR_SUBTITLE_DEDUP.md) | 可选 OCR 环境、识别范围与报告。 |
| [Server 启动说明](../server-editor/README.md) | 源码服务参数、端口、工程接管与本机设置。 |

## 契约与开发

| 文档 | 内容 |
| --- | --- |
| [工程格式](../JSON_SCHEMA.md) | `.mosp` / `.json` 的正式字段契约，整数毫秒时间码。 |
| [LLM 后处理协议](LLM_POSTPROCESS_PROTOCOL.md) | 模型输入输出、ID 校验、本地时间映射和 HTTP 契约。 |
| [空隙来源与恢复](GAP_PROVENANCE.md) | 空隙来源层、恢复语义与数据规则。 |
| [开发概览](DEVELOPMENT.md) | 代码地图、持久化边界、测试与发布检查。 |
| [MAW / MAWE / MOSE](MOSE.md) | Electron 桌面操作、平台包、工程关联和更新范围。 |
| [桌面开发](../desktop/README.md) | Electron 开发、三端后端布局、构建和验证边界。 |
| [官网文档同步](../website/docs/CONTENT_SYNC.md) | 从源文档生成官网页面的步骤。 |

## 历史记录与未完成方案

`TEST_FEEDBACK_*.md` 是某次反馈的处理与验证账本；其中的“已修复”只对应当时记录的验证范围。`dev/` 包含阶段计划、重构审计和进度记录，阅读时应区分计划与已实现状态。

[供应商调研](ASR_PROVIDER_RESEARCH.md)、[时间码比较计划](PLAN_TIMESTAMP_COMPARE.md)、[旧版本回顾](RELEASE_REVIEW_1.3.2_TO_1.4.0.md)、[PR #56 审查](PR56_REVIEW.md) 与 [旧 README](archived/README-2026-08-11.md) 保留为背景资料。当前能力以使用文档和实际代码为准；版本变化看 [CHANGELOG](../CHANGELOG.md)。

维护时将操作步骤写在使用文档、字段写在契约文档、验证证据写在任务账本。官网页面由源文档生成，不手工维护第二份正文。本次整理范围与验证见 [文档重构记录](dev/文档重构记录.md)。
