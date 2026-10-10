# MOSE — Electron 桌面壳（发布路线决策）

MOSE（Moy's Open Subtitle Editor）是 MAW 的 Windows x64 独立编辑器。仓库已经确定
**以 Electron 作为桌面壳的发布路线**：Electron 只负责窗口、单实例、文件关联、
下载对话框与它启动的 `MAW.exe` 生命周期；编辑器前端继续唯一来自 `web/`，后端继续
唯一来自 `server-editor/serve.py`，不为桌面版维护第二套实现。

## 决策记录（2026-10-08）

- 本目录曾保留 Tauri 2.x 实验工程（2026-07-30 引入，`desktop/src-tauri/`）。
  经评估后移除：Tauri 方案在 Rust 侧重复实现了 Server 契约（工程保存、媒体、
  波形等），需要同时维护 Python 与 Rust 两套后端并引入 Rust 工具链；而 Electron
  套件（MAW + MOSE 统一套件、Inno Setup Installer、软件内更新器、`.mosp` 关联）
  已完整实现并实测可用。
- Tauri 实验的历史代码见 git 历史（`a8c2669b` 至移除前）；实验结论以本页为准。
- 完整的 Electron MOSE 套件代码当前位于 `merge/starlit-main` 集成分支
  （`desktop/src/main.cjs`、`preload.cjs` 等），后续合回 main 后本目录即为其
  唯一开发目录。

## 套件结构（Electron 路线）

```text
MAW/
├── MAW.exe                # PyInstaller 主程序（Launcher / Server）
├── MOSE/
│   ├── MOSE.exe           # Electron 壳，启动同套件 MAW.exe
│   └── resources/…
└── ffmpeg/…
```

MOSE 不能脱离同套件的 `MAW.exe` 单独运行；`.mosp` 关联指向
`MAW.exe --open-project`，双击工程先经过 Launcher 更新检查再打开 MOSE。

**web/ 永远是编辑器真源；`server-editor/serve.py` 永远是后端唯一真源。**

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

## 与工程文件格式的关系

MOSE 与 MAW/MAWE 共享同一份工程文件契约：内容是 UTF-8 JSON，推荐扩展名为 `.mosp`，同时兼容旧的 `.json`。`.workspace.json` 是独立的工作区迁移文件，不是字幕工程。

## 构建统一套件与 Installer

在仓库根目录先构建 MAW 和 MOSE，再进行统一 staging：

```powershell
.\scripts\build-windows.ps1 -SkipTests
cd desktop
npm run build
cd ..
.\scripts\stage-mose-bundle.ps1
.\scripts\build-installer.ps1 -Version "1.6.0-beta.1"
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
