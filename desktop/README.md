# MOSE — Electron 桌面编辑器

MOSE（Moy's Open Subtitle Editor）是 MAW 的 Windows x64 Electron 壳。它不复制
编辑器前端，也不另实现一套工程存储：Electron 启动同一套件中的 `MAW.exe`，由
`server-editor/serve.py` 提供受令牌保护的 localhost 页面和全部保存、波形、媒体、
最近工程与导出能力。

## 目录关系

```text
moys-asr-workflow/
├── web/                     # 编辑器唯一前端真源
├── server-editor/serve.py   # MAW 与 MOSE 共用的 Server
├── desktop/src/main.cjs     # Electron 主进程
├── desktop/src/preload.cjs  # 最小化 contextBridge
└── desktop/src/runtime_helpers.cjs
```

统一套件固定为：

```text
MAW + MOSE Windows x64 Installer
└── MAW/
    ├── MAW.exe
    ├── MOSE/
    │   ├── MOSE.exe
    │   └── resources/…
    └── ffmpeg/…
```

GitHub Release 会公开上传包含 MOSE 的 Windows x64 Installer；源码、构建脚本和测试也
公开，Installer 不包含 License Key 或联网授权校验。
`MOSE` 目录不能脱离同一套件的 `MAW.exe` 单独运行。

## 本地开发

```powershell
cd desktop
npm ci
npm run dev
```

开发模式会调用仓库根目录的 `server-editor/serve.py`。如需指定 Python，可设置
`MAW_MOSE_PYTHON`。打开工程时把 `.mosp` 或旧 `.json` 路径作为参数传给 Electron：

```powershell
npm start -- "D:\Projects\clip.mosp"
```

## 构建统一套件与 Installer

在仓库根目录先构建 MAW 和 MOSE，再进行统一 staging：

```powershell
.\scripts\build-windows.ps1 -SkipTests
cd desktop
npm run build
cd ..
.\scripts\stage-mose-bundle.ps1
.\scripts\build-installer.ps1 -Version "1.5.3"
```

`build-installer.ps1` 默认只接受 `build\release\mose\MAW`，会检查 `MAW.exe`、
`MOSE\MOSE.exe`、FFmpeg 和 Electron `resources\app.asar`。需要 Inno Setup 6 的
`ISCC.exe`；安装测试请显式加 `-AllowDestructive`，或只在隔离 CI（`CI=true`）运行。

## 验证

```powershell
npm test
npm run build       # Windows x64 win-unpacked
npm run smoke       # 启动后端、加载页面、正常退出
```

修改 `web/` 后先在仓库根目录重新生成便携页面：

```powershell
uv run python edit.py --blank
```

## 工程打开、更新与安全

Installer 和完整便携套件为当前用户建立 `.mosp` 关联，命令指向
`MAW.exe --open-project "%1"`。双击工程会先进入 Launcher 完成更新检查，再自动
打开 MOSE；因此不会绕过更新提示。更新器会从公开 GitHub Release 下载并校验新版
Installer；如果当前构建没有匹配资产，则打开发布页供用户手动更新。

Electron 窗口启用 `contextIsolation`、sandbox 且关闭 `nodeIntegration`；只允许导航
到本次启动的精确 `127.0.0.1` 地址，外部链接交给系统浏览器。后端使用系统随机端口，
通过 `MAW_DESKTOP_TOKEN` 传递一次性令牌，令牌不会出现在命令行或日志中。

License: AGPL-3.0-only（与 MAW 主仓库一致）。
