---
layout: "../../layouts/DocLayout.astro"
title: "MOSE 独立编辑器"
description: "MAW、MAWE 与 Windows Electron MOSE 之间的定位、套件布局与工程格式边界。"
source: "docs/MOSE.md"
---

<!-- Generated from docs/MOSE.md. Run npm run sync:docs to refresh. -->

# MOSE 独立编辑器

MOSE（Moy's Open Subtitle Editor）是 MAW 的 Windows x64 Electron 独立编辑器。它
复用 MAW 的 server-editor/serve.py、web/ 前端和 .mosp 工程契约，因此保存、备份、
媒体 Range seek、波形、最近工程、表情包以及现有导出能力与 MAWE Server 保持一致，
不维护第二套编辑器源码或工程 schema。

## 发布套件

Windows Release 额外提供：

    MAW-MOSE-Windows-x64-<version>.zip
    └── MAW/
        ├── MAW.exe
        └── MOSE/
            ├── MOSE.exe
            └── resources/

MOSE 不重复携带 Python Runtime、模型或 FFmpeg；它启动同套件中的 MAW.exe，以
127.0.0.1 系统随机端口提供受一次性 MAW_DESKTOP_TOKEN 保护的内部 Server。
因此 MOSE/ 目录不能脱离同套件的 MAW.exe 单独运行，也不能只复制 MOSE.exe 到其他目录。

本轮只发布 Windows x64 Electron 套件 ZIP。Installer、卸载清理、开始菜单快捷方式、
代码签名、自动更新和 macOS/Linux Electron 版本留待套件稳定后另行规划。

## 启动与文件关联

- Launcher 主按钮优先打开套件内 MAW\MOSE\MOSE.exe；MOSE 缺失或创建进程失败时
  自动回退到现有 Server 编辑器，并显示本地化说明。
- split button 下拉菜单始终提供“启动 Server 版字幕编辑器”，Server 停止入口继续可用。
- Electron 支持命令行中的 .mosp 和兼容旧 .json；只有 .mosp 在 Windows 当前用户
  范围建立关联。Launcher 会在移动解压目录后更新命令和图标，但尊重已有 UserChoice，
  不要求管理员权限。
- 第二次双击工程通过 Electron 单实例锁转发到现有窗口；若当前工程有未保存修改，
  复用编辑器 dirty-state 确认后再通过桌面专用接口切换工程。

## 安全边界

Electron 窗口启用 contextIsolation、sandbox 并关闭 nodeIntegration。导航只允许
本次启动产生的精确 http://127.0.0.1:<port> origin，其他网页交给系统浏览器。
后端令牌只放在子进程环境变量与 Electron 请求头中，不进入命令行或日志；退出时先
请求同一后端正常关闭，超时只清理本次 Electron 启动并核对过的子进程树。

## 本地开发

    cd desktop
    npm ci
    npm run dev
    npm test
    npm run build
    npm run smoke

开发模式调用仓库根目录的 Server；可用 MAW_MOSE_PYTHON 指定 Python。修改 web/
后，在仓库根目录运行 uv run python edit.py --blank 重新生成便携编辑器。
