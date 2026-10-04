# MOSE — Electron 桌面编辑器

MOSE（Moy's Open Subtitle Editor）复用 `web/` 前端、`server-editor/serve.py` 和 `.mosp` 工程契约。Electron 提供原生文件选择、真实路径与窗口生命周期；后端负责媒体 Range、波形、绑定保存、最近工程和导出。

## 源码与运行布局

```text
web/                         编辑器唯一前端真源
server-editor/serve.py        MAW 与 MOSE 共用的本机服务
 desktop/src/main.cjs         原生窗口、对话框与受限 IPC
 desktop/src/preload.cjs      contextBridge 与 File 真实路径
 desktop/src/runtime_helpers.cjs  各平台后端定位
```

| 平台 | MOSE 后端位置 | 构建产物 |
| --- | --- | --- |
| Windows x64 | `MAW/MAW.exe`，编辑器在 `MAW/MOSE/MOSE.exe` | 共享套件 ZIP、MAW Installer |
| macOS arm64 | `MOSE.app/Contents/Resources/backend/MAW.app/Contents/MacOS/MAW` | DMG、ZIP |
| Linux x64 | `MOSE/resources/backend/MAW/MAW` | AppImage、DEB |

Windows 共用套件内唯一的 Python 与 FFmpeg，不能把 `MOSE/` 单独移走。macOS/Linux 的 MOSE 包携带对应系统与架构的 MAW 后端和 FFmpeg，可独立于 Launcher 运行；不携带本地 ASR 模型。实际已发布的平台以 Release 附件为准。

## 本地开发

先在仓库根目录准备 Python 环境与 FFmpeg / FFprobe，再执行：

```sh
uv sync
npm ci
npm ci --prefix desktop
npm run dev --prefix desktop
```

开发模式直接调用源码 Server。`MAW_MOSE_PYTHON` 可指定现有 Python 解释器，默认使用仓库 `.venv`。打开工程可传绝对路径，也接受相对当前目录的路径：

```sh
npm start --prefix desktop -- "/path/to/project.mosp"
```

改 `web/` 后刷新窗口即可看到 Server 渲染的新页面。日常不要生成 `blank-editor.html`；内联副本待发布前统一重生成。

## 构建

每个平台必须在对应系统、对应架构上构建原生 MAW 后端，再执行 `npm run build --prefix desktop`；`build:dir` 只输出未封装目录。构建脚本禁止自动发布，macOS/Linux 缺少后端或 FFmpeg / FFprobe 时会直接失败。

Windows 在仓库根目录执行：

```powershell
.\scripts\build-windows.ps1 -SkipTests
npm run build --prefix desktop
.\scripts\stage-mose-bundle.ps1
.\scripts\build-installer.ps1 -Version "1.8.0-beta.1"
```

Installer 需要 Inno Setup 6；staging 检查只有一套 MAW/Python/FFmpeg，并包含 `resources/app.asar` 与 MOSP 文档图标。安装测试只在隔离 CI 或明确允许的测试环境执行。

macOS 先以 `MAW.spec` 生成 `dist/MAW.app`，将对应架构 FFmpeg、FFprobe 与许可文件放入 `Contents/MacOS/ffmpeg/`。Linux 可使用 `scripts/build-appimage.sh` 准备 `dist/MAW` 及内置 FFmpeg。完整原生构建步骤与下载校验见 `.github/workflows/release.yml`，随后执行：

```sh
npm run build --prefix desktop
```

产物在 `desktop/dist/`。macOS 当前 CI 目标为 arm64，Linux 为 x64；架构变更需要同时重建后端与 Electron。配置尚未接入 macOS Developer ID / 公证，Windows 签名按发行环境配置执行。

## 原生工程操作

- 原生选择、文件拖入、命令行与系统打开事件都通过真实路径绑定工程，并加入最近工程。
- 新建与另存为使用原生保存对话框，可以跨目录；覆盖前保留 `.bak`，取消时保留当前编辑状态。保存完成后持续写回新文件，相对媒体引用会保留原来的媒体位置。
- 媒体移动后仍可打开和保存字幕，点击“加载媒体”重新定位。工程和媒体一起拖入时可直接覆盖旧媒体引用。
- 点击工程名复制路径，右键在文件管理器显示。媒体使用后端 Range 与相邻波形缓存；表情包根目录可通过原生文件夹对话框选择。
- 未保存关闭或退出时可取消返回编辑器。macOS/Linux 提供原生菜单与平台快捷键；退出只清理本次拥有的后端进程树。

## 系统打开方式与更新

Windows 安装版及完整便携套件向当前用户注册 `.mosp` 打开方式与文档图标；命令为 `MAW.exe --open-project "%1"`，经过 Launcher 更新检查再打开 MOSE。保留已有默认应用选择，不关联通用 `.json` 扩展名。安装版通过 Launcher 下载并校验新 Installer；便携版手动更新。

macOS 使用 MOSP UTI、文档图标和 `open-file` 事件。Linux DEB 安装 MIME 和桌面入口；AppImage 移到固定位置后，可使用 Tools → “添加工程打开方式…” 写入当前用户 XDG 目录，再从文件管理器选择 MOSE。菜单注册不会更换默认应用；移动 AppImage 后应重新注册。桌面缓存工具缺失时会提示，重新登录后再检查。

macOS/Linux MOSE 独立包当前手动下载更新，未实现应用内自动更新。系统关联与默认图标显示受安装方式和文件管理器缓存影响，需分别验收。

## 验证与安全

```sh
npm test --prefix desktop
npm run smoke --prefix desktop
node --test desktop/e2e/*.mjs
```

E2E 可设置 `MOSE_TEST_EXECUTABLE` 指向实际打包的编辑器，否则运行源码壳；原生对话框返回路径由测试替身提供，后续 IPC、Server、Chromium 和写盘使用产品实现。Windows 打包复核前要重新 staging。

窗口启用 `contextIsolation`、sandbox 并关闭 `nodeIntegration`；IPC 只接受当前编辑器主 frame 的精确 localhost origin。后端仅监听 `127.0.0.1`，令牌通过子进程环境与请求头传递，不放入命令行或日志。原生写入目标只取主进程保存对话框，HTTP 不提供任意路径写入。

当前 Windows 已进行源码与打包交互检查；macOS/Linux 原生 CI 已接线，尚未运行。Installer 安装/卸载及三端文件管理器双击仍需原生验收，详细证据见 [检查记录](../docs/TEST_FEEDBACK_ELECTRON_INTEGRATION.md)。

License: AGPL-3.0-only（与 MAW 主仓库一致）。
