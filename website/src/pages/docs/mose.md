---
layout: "../../layouts/DocLayout.astro"
title: "MOSE 独立编辑器"
description: "MAW、MAWE 与 Windows Electron MOSE 之间的定位、套件布局与工程格式边界。"
source: "docs/MOSE.md"
---

<!-- Generated from docs/MOSE.md. Run npm run sync:docs to refresh. -->

# MOSE 独立编辑器

MOSE（Moy's Open Subtitle Editor）是 MAW 的 Windows x64 Electron 壳。它复用
`server-editor/serve.py`、`web/` 前端和 `.mosp` 工程契约，因此保存、备份、媒体
Range seek、波形、最近工程和导出能力与 MAWE Server 保持一致，不维护第二套编辑器
源码或工程 schema。

## 分发方式

源码和打包脚本公开；默认 GitHub Release 只放公开的 MAW / MAW-lite 便携包，不包含
MOSE 或 Installer。官方 Windows Installer 作为单独的下载链接分发，Installer 本身
不做 License Key 或联网授权校验，用户拿到安装包后可按 AGPL-3.0-only 条款使用、备份
和再分发。官方链接之外的镜像、分享和自行打包不由项目负责更新与支持。

Installer 安装的是同一个统一套件：

```text
%LOCALAPPDATA%\Programs\MAW\
├── MAW.exe
├── MOSE\
│   ├── MOSE.exe
│   └── resources\…
└── ffmpeg\…
```

`MOSE\` 不能脱离同套件的 `MAW.exe` 运行；不要只复制 `MOSE.exe`。Launcher 主按钮
优先启动 `MAW\MOSE\MOSE.exe`，缺失或启动失败时回退到 Server 编辑器。

## 启动与工程关联

- Installer 和完整便携套件只在当前用户范围建立 `.mosp` 关联，不需要管理员权限，
  不覆盖 Windows 已有的 `UserChoice`。
- `.mosp` 双击先进入 `MAW.exe --open-project <path>`，Launcher 完成更新检查后再
  自动打开 MOSE；因此直接双击工程也不会绕过更新提示。旧 `.json` 仍可手动打开，
  但不会建立系统关联。
- MOSE 支持命令行传入 `.mosp` / `.json`。第二次启动会通过 Electron 单实例锁把
  工程路径转发给现有窗口，并沿用编辑器的 dirty-state 确认。

## 本地构建与测试

在仓库根目录执行：

```powershell
uv sync
.\scripts\build-windows.ps1 -SkipTests
cd desktop
npm ci
npm test
npm run build
npm run smoke
cd ..
.\scripts\stage-mose-bundle.ps1
.\scripts\build-installer.ps1 -Version "1.5.3"
```

`build-installer.ps1` 需要 Inno Setup 6 的 `ISCC.exe`；脚本默认读取
`build\release\mose\MAW`，会拒绝只含 `dist\MAW` 的旧目录，避免生成缺少 MOSE 的
“半套 Installer”。安装测试会修改当前用户的安装目录，只有明确执行
`-AllowDestructive`（或在 CI 中设置 `CI=true`）才会运行；执行前还会拒绝覆盖已有
`%LOCALAPPDATA%\Programs\MAW`、`.env` 或卸载项。

## 自动更新与签名

Launcher 每天最多自动检查一次，也可在「配置 → 软件更新」手动检查。更新清单和下载
包使用 SHA-256 校验；当前公开 Release 不放 Installer，所以没有可自动下载的官方
安装包时会打开发布页，用户通过官方 Installer 链接手动更新。以后若把 Installer
放到独立的官方更新源，只需让清单提供同样的 Installer 资产，不需要引入 License Key。

Release workflow 支持通过 `MAW_SIGN_CERTIFICATE_BASE64` 与
`MAW_SIGN_CERTIFICATE_PASSWORD` secrets 调用 `scripts/sign-installer.ps1`。未配置证书
时会明确产出 unsigned Installer，并在首次启动时可能触发 Windows SmartScreen；这不是
签名成功的假象，发布者应在商品页同时提供 SHA-256 和官方来源说明。

## 安全边界

Electron 窗口启用 `contextIsolation`、sandbox 并关闭 `nodeIntegration`。导航只允许
本次启动产生的精确 `http://127.0.0.1:<port>` origin，其他网页交给系统浏览器。后端
令牌只放在子进程环境变量与 Electron 请求头中，不进入命令行或日志；退出时先请求
同一后端正常关闭，超时只清理本次 Electron 启动并核对过的子进程树。

License: AGPL-3.0-only（与 MAW 主仓库一致）。
