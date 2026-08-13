---
layout: "../../layouts/DocLayout.astro"
title: "与 MOSE 的关系"
description: "MAW、MAWE 和未来 MOSE 之间的定位与工程格式边界。"
source: "docs/MOSE.md"
---

<!-- Generated from docs/MOSE.md. Run npm run sync:docs to refresh. -->

# 与 MOSE 的关系

Moy's ASR Workflow（**MAW**）是一个小而直白的命令行工作流：用户自己提供阿里云百炼 Key，在自己的电脑上运行脚本和编辑器。

未来的 **Moy's Open Subtitle Editor（MOSE）** 计划提供三种共享工程格式的入口：网页版本、Tauri 桌面版本和便携 HTML 版本。网页版本的设计目标是让原始媒体保持在用户本机，只将需要识别的音频直接发送给用户选择的 ASR 服务。

本仓库不是 MOSE 的临时分支，也不承诺自动升级或固定时间表。它的价值是现在就能独立使用，并作为工程文件契约、波形编辑和导出流程的稳定参考。当前工程文件以 `.mosp` 为推荐扩展名，内容仍是普通 UTF-8 JSON；MAW/MAWE 会继续兼容旧的 `.json` 工程。

若未来迁移工具可用，优先保留 `.mosp` / `.json` 工程文件和原始媒体；不要把 `.workspace.json`、Resolve JSON 或 SRT 当作工程真源。SRT 只能保留字幕文本与时间，不能保留字级时间戳、编辑器工作区、波形缓存或空隙移除决定。
