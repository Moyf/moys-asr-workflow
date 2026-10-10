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

## 与工程文件格式的关系

MOSE 与 MAW/MAWE 共享同一份工程文件契约：内容是 UTF-8 JSON，推荐扩展名为 `.mosp`，同时兼容旧的 `.json`。`.workspace.json` 是独立的工作区迁移文件，不是字幕工程。

## 桌面文件操作

- 工程可从「打开工程」、最近工程、命令行/文件关联或 Explorer 拖入。可与媒体一起拖入；选定媒体优先于工程文件中原有的媒体引用。把工程拖入后选择副字幕导入时，当前工程保存目标不会改变。
- 新建、另存为、Ctrl+S、自动保存和版本备份都由 Server 按当前绑定的真实 `.mosp` / `.json` 路径处理。首次保存取消或失败时，工程仍只存在于当前窗口；另存为成功后旧文件不再被后续保存修改。
- 「加载媒体」和拖入媒体会通过 Server 读取源路径并复用媒体探测、播放转换与缓存。媒体被移动或删除时，字幕工程仍可打开和保存；重新关联成功后，只替换媒体字段与对应缓存，不覆盖字幕、标记或工作区。
- 表情包根目录可直接输入，或在 MOSE 中使用系统文件夹选择器；扫描失败/取消不会替换上一个有效目录。工程和媒体标题旁的操作菜单可打开所在位置或复制完整路径；设置中的备份路径也可打开或复制。
- 工程文件被外部改写或删除后，MOSE 暂停自动覆盖保存，并提供重新加载、另存为或保留当前编辑。关闭窗口/退出应用时会等待正在进行的保存，并提供保存并继续、不保存或取消；保存取消或失败会保留窗口。
- 文件导出使用一次原生保存对话框；取消不会提示失败，只有 Electron 确认下载完成且文件已落盘后才报告成功。成功导出可以从标题栏定位或复制路径。

普通 Server 与便携 HTML 继续使用现有浏览器文件流程，不要求存在 `MOSEDesktop` 桥接。

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

修改 `web/` 后先在仓库根目录重建共享编辑器 bundle 和元数据：

```powershell
npm run build:editor
npm run check:editor
```

日常开发不重生成根目录 `blank-editor.html`；发布前再统一重建并核对该便携产物。

## 工程打开、更新与安全

Installer 和完整便携套件为当前用户建立 `.mosp` 关联，命令指向
`MAW.exe --open-project "%1"`。双击工程会先进入 Launcher 完成更新检查，再自动
打开 MOSE；因此不会绕过更新提示。更新器会从公开 GitHub Release 下载并校验新版
Installer；如果当前构建没有匹配资产，则打开发布页供用户手动更新。

Electron 窗口启用 `contextIsolation`、sandbox 且关闭 `nodeIntegration`；只允许导航
到本次启动的精确 `127.0.0.1` 地址，外部链接交给系统浏览器。后端使用系统随机端口，
通过 `MAW_DESKTOP_TOKEN` 传递一次性令牌，令牌不会出现在命令行或日志中。

License: AGPL-3.0-only（与 MAW 主仓库一致）。
