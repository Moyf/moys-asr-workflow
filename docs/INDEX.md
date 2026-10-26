# 文档索引

按任务找到正文。主题 ID 是通用引用入口；正文路径可以迁移，ID 保持稳定。分类与维护见[文档约定](README.md#doc-policy)。

## 用户指南

<a name="user-alignment-features"></a>
### 文稿、时间码与口播工具：当前差异和演进建议

[打开正文](user/ALIGNMENT_FEATURES.md)

<a name="user-ass"></a>
### ASS 样式、预览与导出

[打开正文](user/ASS_STYLES.md)

<a name="user-cli"></a>
### MAW 命令行与自动化

[打开正文](user/CLI.md)

<a name="user-editor"></a>
### MAWE 编辑器指南

[打开正文](user/EDITOR_GUIDE.md)

<a name="user-faq"></a>
### 常见问题

[打开正文](user/FAQ.md)

[随发布包附带的离线 FAQ](user/FAQ-常见问题.txt)

<a name="user-keyboard"></a>
### MAWE 字幕按键调整

[打开正文](user/KEYBOARD_ADJUSTMENT.md)

<a name="user-launcher"></a>
### Launcher 指南

[打开正文](user/LAUNCHER_GUIDE.md)

<a name="user-local-asr"></a>
### 实验性本地 ASR 与时间码对齐

[打开正文](user/LOCAL_ASR.md)

<a name="user-multi-subtitle"></a>
### 双语字幕规范

[打开正文](user/MULTI_SUBTITLE.md)

<a name="user-ocr"></a>
### OCR 字幕去重

[打开正文](user/OCR_SUBTITLE_DEDUP.md)

<a name="user-postprocess"></a>
### 转写后自动处理

[打开正文](user/POSTPROCESS_PIPELINE.md)

<a name="user-providers"></a>
### ASR 服务与配置

[打开正文](user/PROVIDERS.md)

<a name="user-script-alignment"></a>
### 文稿驱动对齐（实验性）

[打开正文](user/SCRIPT_DRIVEN_ALIGNMENT.md)

<a name="user-toolbox"></a>
### Launcher 工具箱

[打开正文](user/TOOLBOX.md)

<a name="user-workflow"></a>
### 从零完成一次字幕工程

[打开正文](user/WORKFLOW.md)

## 工程说明

<a name="engineering-long-commands"></a>
### Agent 长命令防卡死指南（Windows / PowerShell 5.1）

[打开正文](engineering/AGENT_LONG_COMMAND_GUIDE.md)

<a name="engineering-development"></a>
### MAW 开发概览

[打开正文](engineering/DEVELOPMENT.md)

<a name="engineering-e2e-lifecycle"></a>
### E2E 服务进程生命周期

[打开正文](engineering/E2E_PROCESS_LIFECYCLE.md)

<a name="engineering-e2e-hang"></a>
### E2E 残留服务进程与长命令挂起：排查与预防

[打开正文](engineering/E2E_SERVER_HANG.md)

<a name="engineering-editor-settings"></a>
### 编辑器设置结构与范围

[打开正文](engineering/EDITOR_SETTINGS_REVIEW.md)

<a name="engineering-gap"></a>
### Gap 来源与可重建规范

[打开正文](engineering/GAP_PROVENANCE.md)

<a name="engineering-llm"></a>
### LLM 字幕后处理协议

[打开正文](engineering/LLM_POSTPROCESS_PROTOCOL.md)

<a name="engineering-mose"></a>
### MAW、MAWE 与 MOSE

[打开正文](engineering/MOSE.md)

<a name="engineering-design-system"></a>
### MAWE 编辑器界面设计契约

[打开正文](engineering/DESIGN.md)

<a name="engineering-project-format"></a>
### 工程文件格式

[字段契约](engineering/JSON_SCHEMA.md)

<a name="engineering-debug"></a>
### 有界输出与分层调试

[打开正文](engineering/DEBUG_WORKFLOW.md)

<a name="engineering-prproj"></a>
### PRPROJ capability gate

[打开正文](engineering/PRPROJ_CAPABILITY.md)

<a name="engineering-filmstrip-exploration"></a>
### 视频画面轨道与缓存（#229）

[正式实现、缓存契约、验证与实验历史](engineering/FILMSTRIP_EXPLORATION.md)

## 共享计划

<a name="plan-release-pipeline"></a>
### 正式版本归档、官网与更新检测管线

[架构、内容来源、资源复用与实施阶段](plans/RELEASE_PIPELINE.md)

<a name="plan-ass-cue-scale"></a>
### 主字幕单句缩放开发方案

[打开正文](plans/ASS_CUE_SCALE.md)

这些阶段方案保留原始基线与状态；是否继续实施以本分支代码、后续记录和维护者确认为准。编辑器设置方案已有实施记录，旧前端方案不代表当前代码布局。

<a name="plan-ai-processing-review"></a>
### AI 核对页与通用工程备注

[打开方案](plans/AI_PROCESSING_REVIEW.md)

<a name="plan-editor-settings"></a>
### 编辑器设置整理实施计划

[打开正文](plans/EDITOR_SETTINGS_PLAN.md)

<a name="plan-launcher-redesign"></a>
### Launcher 现代化改版设计方案

[打开正文](plans/LAUNCHER_REDESIGN.md)

<a name="plan-launcher-redesign-prototype"></a>
### Launcher 改版原型（静态参考）

[打开说明](plans/launcher-redesign/README.md)

<a name="plan-editor-modules"></a>
### MAWE 前端渐进式重构企划案

[打开正文](plans/MAWE%20%E5%89%8D%E7%AB%AF%E6%B8%90%E8%BF%9B%E5%BC%8F%E9%87%8D%E6%9E%84%E4%BC%81%E5%88%92%E6%A1%88.md)

<a name="plan-editor-wiring"></a>
### MAWE 接线拆分与目录分层计划

[打开正文](plans/MAWE%20%E6%8E%A5%E7%BA%BF%E6%8B%86%E5%88%86%E4%B8%8E%E7%9B%AE%E5%BD%95%E5%88%86%E5%B1%82%E8%AE%A1%E5%88%92.md)

<a name="engineering-server"></a>
### 源码服务与桌面开发

[Editor Server](../server-editor/README.md) · [对齐 Server](../server-align/README.md) · [桌面开发](../desktop/README.md)

<a name="engineering-website"></a>
### 官网源文档同步

[同步与构建](../website/docs/CONTENT_SYNC.md)

<a name="engineering-releases"></a>
### 版本更新文档与发布管线

[生成、校验与发布](releases/README.md)

<a name="logs"></a>
## 日志与历史

[保留日志索引](logs/INDEX.md) · [当前相关参考与未决事项](logs/CURRENT.md) · [2026-08-11 README 原文](archived/README-2026-08-11.md)

当前安全记录：[2026-10 证书与工具链安全修复](logs/release1.10.0-beta.1/261022_证书与工具链安全/SECURITY.md)。

当前功能记录：[单句放大出现设计账本](logs/release1.9.0-beta.3/261020_每句放大出现/SENTENCE_POP_IN.md) · [主字幕单句缩放进度账本](logs/release1.9.0-beta.2/ASS_CUE_SCALE.md) · [人工核对清单](logs/release1.9.0-beta.2/ASS_CUE_SCALE.checklist.md)

反馈账本中的“已修复”只对应其记录的版本和验证范围。发布变化见 [CHANGELOG](../CHANGELOG.md)。

<a name="log-media-required-reports"></a>
### 媒体分层与可信报告

[打开记录](logs/release1.10.0-beta.1/261023_媒体分层与可信报告/验证记录.md)
