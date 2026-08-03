# MOSE — Tauri 桌面应用开发目录

本目录是 **MOSE（Moy's Open Subtitle Editor）** 的 Tauri 桌面应用开发目录，属于 MAW 仓库的一部分。

## 架构定位

```
moys-asr-workflow/           (MAW，本仓库)
├── web/                     ← 编辑器源码（真源，被 desktop/ 引用）
├── desktop/                 ← 本目录，Tauri 项目
│   └── src-tauri/           ← Rust 后端 + Tauri 配置
├── server-editor/serve.py   ← localhost 编辑器（保留，作为 MAW fallback）
└── edit.py                  ← 便携 HTML 生成器（继续支持）

moys-open-subtitle-editor/   (MOSE 发布仓库，独立)
└── 仅放 release 快照 + issue 跟踪
```

## 开发流程

```powershell
# 前提：Rust 工具链已装（https://rustup.rs/），且当前终端的 PATH 里有 cargo
cargo --version   # 能出版本号 = OK

# 进入 desktop/ 开发
cd D:\Codes\moys-asr-workflow\desktop
npm install       # 首次：安装 @tauri-apps/cli（package.json 里已声明）
npx tauri dev     # 启动开发模式（编译 Rust + 从 web/ 渲染 index.html + 开 webview 窗口）
npx tauri build   # 当前用于验证打包配置；正式安装包发布另行安排
```

启动后：
- Rust 侧自动从 `../web/` 渲染 `desktop/src/index.html`（等价 `edit.py --blank`）
- webview 加载该文件，显示完整 MAWE 编辑器界面
- 改 `web/` 源码后需要重启 `npx tauri dev`（暂无 watch 热重载）

### 关于 PATH

如果终端报 `cargo not found`，说明终端是在装 Rust 之前开的。**开一个新的 PowerShell 窗口**即可（不需要重启电脑）。

## 与 web/ 的关系

`desktop/` 的 Tauri 应用启动时读取 `../web/editor-template.html`，在 Rust 侧做 `__DATA_JSON__` 等 token 替换（与 `edit.py:render_editor_page` 等价），然后注入 webview。

**web/ 永远是编辑器真源。desktop/ 不复制 web/，只引用。**

## 与工程文件格式的关系

MOSE 与 MAW/MAWE 共享同一份工程文件契约：内容是 UTF-8 JSON，推荐扩展名为 `.mosp`，同时兼容旧的 `.json`。`.workspace.json` 是独立的工作区迁移文件，不是字幕工程。

## 同步到 MOSE 发布仓库

每次 MOSE release 时，将 `desktop/` + `../web/` 快照同步到 `moys-open-subtitle-editor` 仓库：

```powershell
# 同步脚本尚未纳入当前 MAW 开发流程
.\scripts\sync-to-mose-release.ps1
```

## 当前状态

这是 MOSE 的开发目录，不是 MAW 的稳定发布入口。目前已完成并在主线保留：

- Tauri 项目骨架，以及从 `web/` 渲染 MAWE 页面；
- 工程打开、保存、最近工程和本机工作区设置 IPC；
- 媒体自动加载、表情包目录扫描和 FFmpeg 波形 sidecar；
- `.mosp` 文件关联配置，以及 MAW Launcher 检测已安装 MOSE 后优先打开工程的集成。

当前仍未承诺：公开 MOSE 安装包、独立发布仓库同步脚本和稳定版发布周期。MAW 的 localhost 服务器与便携 HTML 仍是正式支持的 fallback 入口。

License: AGPL-3.0-only（与 MAW 主仓库一致）。
