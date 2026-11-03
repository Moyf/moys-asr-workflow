---
layout: "../../layouts/DocLayout.astro"
title: "文档索引"
description: "按任务查找使用指南、工程契约与历史记录。"
source: "docs/INDEX.md"
---

<!-- Generated from docs/INDEX.md. Run pnpm run sync:docs to refresh. -->

按任务找到正文。主题 ID 是通用引用入口；正文路径可以迁移，ID 保持稳定。分类与维护见[文档约定](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/README.md#doc-policy)。

## 用户指南

<a name="user-alignment-features"></a>
### 文稿、时间码与口播工具：当前差异和演进建议

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/user/ALIGNMENT_FEATURES.md)

<a name="user-ass"></a>
### ASS 样式、预览与导出

[打开正文](../ass-styles/)

<a name="user-cli"></a>
### MAW 命令行与自动化

[打开正文](../cli/)

<a name="user-editor"></a>
### MAWE 编辑器指南

[打开正文](../editor-guide/)

<a name="user-faq"></a>
### 常见问题

[打开正文](../faq/)

[随发布包附带的离线 FAQ](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/user/FAQ-常见问题.txt)

<a name="user-keyboard"></a>
### MAWE 字幕按键调整

[打开正文](../keyboard-adjustment/)

<a name="user-launcher"></a>
### Launcher 指南

[打开正文](../launcher/)

<a name="user-local-asr"></a>
### 实验性本地 ASR 与时间码对齐

[打开正文](../local-asr/)

<a name="user-multi-subtitle"></a>
### 双语字幕规范

[打开正文](../multi-subtitle/)

<a name="user-ocr"></a>
### OCR 字幕去重

[打开正文](../ocr-subtitle-dedup/)

<a name="user-postprocess"></a>
### 转写后自动处理

[打开正文](../postprocess-pipeline/)

<a name="user-providers"></a>
### ASR 服务与配置

[打开正文](../providers/)

<a name="user-script-alignment"></a>
### 文稿驱动对齐（实验性）

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/user/SCRIPT_DRIVEN_ALIGNMENT.md)

<a name="user-toolbox"></a>
### Launcher 工具箱

[打开正文](../toolbox/)

<a name="user-workflow"></a>
### 从零完成一次字幕工程

[打开正文](../workflow/)

## 工程说明

<a name="engineering-long-commands"></a>
### Agent 长命令防卡死指南（Windows / PowerShell 5.1）

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/engineering/AGENT_LONG_COMMAND_GUIDE.md)

<a name="engineering-development"></a>
### MAW 开发概览

[打开正文](../development/)

<a name="engineering-e2e-lifecycle"></a>
### E2E 服务进程生命周期

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/engineering/E2E_PROCESS_LIFECYCLE.md)

<a name="engineering-e2e-hang"></a>
### E2E 残留服务进程与长命令挂起：排查与预防

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/engineering/E2E_SERVER_HANG.md)

<a name="engineering-editor-settings"></a>
### 编辑器设置结构与范围

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/engineering/EDITOR_SETTINGS_REVIEW.md)

<a name="engineering-gap"></a>
### Gap 来源与可重建规范

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/engineering/GAP_PROVENANCE.md)

<a name="engineering-llm"></a>
### LLM 字幕后处理协议

[打开正文](../llm-postprocess/)

<a name="engineering-mose"></a>
### MAW、MAWE 与 MOSE

[打开正文](../mose/)

<a name="engineering-design-system"></a>
### MAWE 编辑器界面设计契约

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/engineering/DESIGN.md)

<a name="engineering-project-format"></a>
### 工程文件格式

[字段契约](../json-schema/)

<a name="engineering-debug"></a>
### 有界输出与分层调试

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/engineering/DEBUG_WORKFLOW.md)

<a name="engineering-prproj"></a>
### PRPROJ capability gate

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/engineering/PRPROJ_CAPABILITY.md)

<a name="engineering-filmstrip-exploration"></a>
### 视频画面轨道与缓存（#229）

[正式实现、缓存契约、验证与实验历史](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/engineering/FILMSTRIP_EXPLORATION.md)

<a name="engineering-track-unification"></a>
### 字幕轨道统一设计调研（2026-10-27）

[当前三容器数据模型证据、统一 Track/Binding 契约提案与 v1→v1.5→v2 分期迁移边界](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/engineering/research/2026-10-27-track-unification.md)

## 共享计划

<a name="plans-speaker-core"></a>
### 说话人核心与后续依赖

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/plans/SPEAKER_IDENTITY_CORE_PLAN.md)

<a name="plans-unified-tracks"></a>
### 统一字幕轨道实施方案

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/plans/UNIFIED_TRACKS_PLAN.md)

[v2 整合与验证](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/logs/release1.10.0-beta.2/261030_轨道v2整合/整合记录.md) · [人工核验](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/logs/release1.10.0-beta.2/261030_轨道v2整合/轨道v2.checklist.md)

<a name="plan-release-pipeline"></a>
### 正式版本归档、官网与更新检测管线

[架构、内容来源、资源复用与实施阶段](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/plans/RELEASE_PIPELINE.md)

<a name="plan-ass-cue-scale"></a>
### 主字幕单句缩放开发方案

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/plans/ASS_CUE_SCALE.md)

这些阶段方案保留原始基线与状态；是否继续实施以本分支代码、后续记录和维护者确认为准。编辑器设置方案已有实施记录，旧前端方案不代表当前代码布局。

<a name="plan-ai-processing-review"></a>
### AI 核对页与通用工程备注

[打开方案](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/plans/AI_PROCESSING_REVIEW.md)

<a name="plan-editor-settings"></a>
### 编辑器设置整理实施计划

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/plans/EDITOR_SETTINGS_PLAN.md)

<a name="plan-launcher-redesign"></a>
### Launcher 现代化改版设计方案

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/plans/LAUNCHER_REDESIGN.md)

<a name="plan-launcher-redesign-prototype"></a>
### Launcher 改版原型（静态参考）

[打开说明](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/plans/launcher-redesign/README.md)

<a name="plan-editor-modules"></a>
### MAWE 前端渐进式重构企划案

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/plans/MAWE%20%E5%89%8D%E7%AB%AF%E6%B8%90%E8%BF%9B%E5%BC%8F%E9%87%8D%E6%9E%84%E4%BC%81%E5%88%92%E6%A1%88.md)

<a name="plan-editor-wiring"></a>
### MAWE 接线拆分与目录分层计划

[打开正文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/plans/MAWE%20%E6%8E%A5%E7%BA%BF%E6%8B%86%E5%88%86%E4%B8%8E%E7%9B%AE%E5%BD%95%E5%88%86%E5%B1%82%E8%AE%A1%E5%88%92.md)

<a name="engineering-server"></a>
### 源码服务与桌面开发

[Editor Server](https://github.com/Moyf/moys-asr-workflow/blob/main/server-editor/README.md) · [对齐 Server](https://github.com/Moyf/moys-asr-workflow/blob/main/server-align/README.md) · [桌面开发](https://github.com/Moyf/moys-asr-workflow/blob/main/desktop/README.md)

<a name="engineering-website"></a>
### 官网源文档同步

[同步与构建](https://github.com/Moyf/moys-asr-workflow/blob/main/website/docs/CONTENT_SYNC.md)

<a name="engineering-releases"></a>
### 版本更新文档与发布管线

[生成、校验与发布](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/releases/README.md)

<a name="logs"></a>
## 日志与历史

[保留日志索引](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/logs/INDEX.md) · [当前相关参考与未决事项](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/logs/CURRENT.md) · [2026-08-11 README 原文](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/archived/README-2026-08-11.md)

当前安全记录：[2026-10 证书与工具链安全修复](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/logs/release1.10.0-beta.1/261022_证书与工具链安全/SECURITY.md)。

当前功能记录：[单句放大出现设计账本](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/logs/release1.9.0-beta.3/261020_每句放大出现/SENTENCE_POP_IN.md) · [主字幕单句缩放进度账本](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/logs/release1.9.0-beta.2/ASS_CUE_SCALE.md) · [人工核对清单](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/logs/release1.9.0-beta.2/ASS_CUE_SCALE.checklist.md)

反馈账本中的“已修复”只对应其记录的版本和验证范围。发布变化见 [CHANGELOG](https://github.com/Moyf/moys-asr-workflow/blob/main/CHANGELOG.md)。

### v1 轨道只读访问协议

[TrackStore 与 CueRef（P1）](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/engineering/TRACK_ACCESS.md)：旧容器引用、运行时身份与兼容 getter；不改变 v1 落盘。
<a name="log-media-required-reports"></a>
### 媒体分层与可信报告

[打开记录](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/logs/release1.10.0-beta.1/261023_媒体分层与可信报告/验证记录.md)
