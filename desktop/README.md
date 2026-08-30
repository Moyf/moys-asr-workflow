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

发布套件固定为：

```text
MAW-MOSE-Windows-x64-<version>.zip
└── MAW/
    ├── MAW.exe
    └── MOSE/
        ├── MOSE.exe
        └── resources/…
```

`MOSE` 目录不能脱离同一套件的 `MAW.exe` 单独运行。MAW Launcher 会优先检测
`MAW\MOSE\MOSE.exe`，并在 Windows 当前用户范围内更新 `.mosp` 的打开命令和
MOSE 图标；不会写入管理员范围的注册表，也不会修改 Windows 已有的 `UserChoice`。

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

安全边界：窗口启用 `contextIsolation`、sandbox 且关闭 `nodeIntegration`；只允许
导航到本次启动的精确 `127.0.0.1` 地址，外部链接交给系统浏览器。后端使用系统
随机端口，并通过 `MAW_DESKTOP_TOKEN` 环境变量传递一次性令牌，令牌不会出现在
命令行或日志中。

## 验证与构建

```powershell
npm test
npm run build       # Windows x64 win-unpacked
npm run smoke       # 启动后端、加载页面、正常退出
```

修改 `web/` 后先在仓库根目录重新生成便携页面：

```powershell
..\.venv\Scripts\python.exe edit.py --blank
```

Installer、卸载清理、开始菜单快捷方式、代码签名、自动更新以及 macOS/Linux
Electron 版本不在当前范围内；本轮只发布 Windows x64 套件 ZIP。

License: AGPL-3.0-only（与 MAW 主仓库一致）。
