---
layout: "../../layouts/DocLayout.astro"
title: "MOSE 独立编辑器"
description: "Electron 原生工程操作、三端打包、系统打开方式与更新范围。"
source: "docs/MOSE.md"
---

<!-- Generated from docs/MOSE.md. Run pnpm run sync:docs to refresh. -->

| 名称 | 当前定位 |
| --- | --- |
| MAW — Moy's ASR Workflow | 转写与处理工作流，包含 Launcher、公开 CLI 与本机服务。 |
| MAWE — Moy's ASR Workflow Editor | 共享的字幕编辑前端，支持本机 Server、便携 HTML 与在线浏览器入口。 |
| MOSE — Moy's Open Subtitle Editor | 本分支的 Electron 独立窗口，复用同一前端、Server 与工程契约，并提供原生文件能力。 |

本分支 `desktop/` 使用 Electron。Launcher 优先查找 MOSE，缺失或启动失败时回退到浏览器 Server。三者共享 `.mosp` / 兼容 `.json`；SRT、Resolve JSON、保留区域 JSON 和 `.workspace.json` 各有用途，不能代替字幕工程。格式见 [JSON_SCHEMA](../json-schema/)。

## 选择平台和启动方式

| 平台 | 包与启动方式 | 后端关系 | 工程打开方式 |
| --- | --- | --- | --- |
| Windows x64 | MAW + MOSE 套件 / Installer；启动 MAW 或 `MAW/MOSE/MOSE.exe` | 共用同套件的 `MAW.exe`、Python 与 FFmpeg | `.mosp` 经 Launcher 更新检查后打开 MOSE；独立文档图标 |
| macOS arm64 | MOSE DMG / ZIP，安装并启动 `MOSE.app` | 应用内含原生后端与 FFmpeg | MOSP UTI、文档图标、Finder 打开事件 |
| Linux x64 | MOSE AppImage / DEB，启动 AppImage 或 `mose` | 包内含原生后端与 FFmpeg | DEB 提供 MIME / 桌面入口；AppImage 可注册当前用户打开方式 |

Windows 必须保留 `MAW/MAW.exe` 与 `MAW/MOSE/MOSE.exe` 的相对布局；macOS/Linux 可单独安装 MOSE。此表描述分支的构建配置，实际可下载的平台以 Release 附件为准。当前 Windows 已本地检查；macOS/Linux 仍需原生 CI 和系统安装验收，详见 [验证账本](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/TEST_FEEDBACK_ELECTRON_INTEGRATION.md)。开发与打包步骤见 [desktop README](https://github.com/Moyf/moys-asr-workflow/blob/main/desktop/README.md)。

## 打开、新建和保存

“打开工程”、拖入工程、命令行路径及系统打开事件会使用真实路径，绑定到磁盘文件并加入最近工程。新建和另存为使用原生保存对话框；取消不改变当前工程，跨目录另存为仍保留原媒体的位置。后续 `Ctrl/Cmd+S` 与自动保存写回新目标，覆盖前保留相邻 `.bak`；已有 Server 多版本备份能力继续可用。

工程媒体已移动时仍可打开、修改和保存字幕。点击“加载媒体”重新选择，或同时拖入工程与媒体来覆盖失效引用；加载失败保留原工程。工程名左键复制完整路径，右键在文件管理器显示。

最近工程、工作区库、ASS 样式与引导状态复用 MAW 用户级设置。MOSE 的主题、语言、编辑选项、波形与浮窗偏好保存在 Electron 用户数据目录的 `editor-preferences.json`；重启后的随机 localhost 端口不会导致偏好丢失，原端口中可读取的旧偏好会在首次读取时迁入。普通浏览器仍使用 origin 隔离的 `localStorage`。

## 媒体与本机资源

原生 File 路径交给同一 Server，媒体采用 Range 请求播放，波形和频谱由 FFmpeg 与相邻 sidecar 提供；工程仍以 `segments` 为字幕真源。SRT / LRC 导入不会丢掉已选媒体的路径。表情包根目录支持原生文件夹选择，继续使用受令牌保护的扫描流程。

系统字体使用 Electron / Chromium 的本地字体能力。常用保存、打开、新建快捷键和 macOS/Linux 原生菜单已接入；自定义快捷键重映射属于另外的新功能，当前没有设置界面。

Chromium 的编解码支持、显存和大媒体内存开销仍由实际运行环境决定。Electron 不会自动增加 ASR 引擎或导出格式，具体能力以编辑器与后端现有实现为准。

## 系统关联和更新

Windows 安装版按当前用户安装到 `%LOCALAPPDATA%/Programs/MAW`。`.mosp` 命令指向 `MAW.exe --open-project "%1"`，双击也经过 Launcher 的更新检查；注册会保留已有默认应用选择，仅提供自己的“打开方式”。兼容旧 `.json` 工程，但不为通用 JSON 建立系统关联。

Windows 安装版通过 Launcher 下载、校验并安装官方 Installer；便携版打开 Release 页面手动更新。macOS/Linux 的 MOSE 独立包目前也需要手动下载更新，未提供独立的自动更新服务。

macOS 由应用声明 MOSP UTI 与文档图标。Linux DEB 安装后可从文件管理器选择 MOSE；AppImage 先放到固定位置，再点击 Tools → “添加工程打开方式…”。该菜单只向当前用户 XDG 目录注册，不更换默认应用；移动 AppImage 后应重新注册。图标与默认打开行为需要在相应系统检查。

## 窗口与退出

MOSE 保持单实例，再次打开工程会转交已有窗口；macOS 关闭窗口后可由 Dock 或文件事件重新打开。窗口标题同步工程名，macOS 还设置系统工程路径。关闭或退出时对未保存修改提供丢弃与取消选项，取消后仍可继续保存。

Electron 启用 `contextIsolation`、sandbox，关闭 `nodeIntegration`。只允许当前编辑器的主 frame 发起原生 IPC，并限制导航到本次后端的精确 `http://127.0.0.1:<port>`。后端令牌不进入命令行或日志；确认退出后只清理本次启动的进程树，避免后台 FFmpeg 残留。

License: AGPL-3.0-only（与 MAW 主仓库一致）。
