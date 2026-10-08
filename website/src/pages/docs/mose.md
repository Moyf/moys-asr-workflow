---
layout: "../../layouts/DocLayout.astro"
title: "与 MOSE 的关系"
description: "MAW、MAWE 与当前实验桌面目录的定位和工程格式边界。"
source: "docs/MOSE.md"
---

<!-- Generated from docs/MOSE.md. Run npm run sync:docs to refresh. -->

| 名称 | 当前定位 |
| --- | --- |
| MAW — Moy's ASR Workflow | 当前可用的转写与处理工作流，包含 Launcher、公开 CLI 与本机服务。 |
| MAWE — Moy's ASR Workflow Editor | MAW 的浏览器字幕编辑器；Server 为日常入口，HTML 为兼容入口。 |
| MOSE — Moy's Open Subtitle Editor | MAW 的 Windows x64 Electron 独立编辑器，以 MAW + MOSE 统一套件发布。 |

桌面壳路线已于 2026-10-08 确定为 **Electron**：Electron 复用 `web/` 前端与
`server-editor/serve.py` 后端，不维护第二套实现；配套的 Installer、软件内更新器与
`.mosp` 关联随统一套件发布。早期保留的 Tauri 实验目录已移除，决策记录见
[desktop README](https://github.com/Moyf/moys-asr-workflow/blob/main/desktop/README.md)；完整的桌面套件代码当前位于
`merge/starlit-main` 集成分支，合回 main 后以 main 为准。

三者共享 `.mosp` / 兼容 `.json` 工程契约。

保留原始媒体与工程最利于后续迁移。SRT、Resolve JSON、保留区域 JSON 和 `.workspace.json` 分别是交付、交换或配置文件，不能代替字幕工程。契约见 [JSON_SCHEMA](../json-schema/)。
