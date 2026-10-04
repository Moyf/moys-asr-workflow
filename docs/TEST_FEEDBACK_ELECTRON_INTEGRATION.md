# Electron 桌面集成检查记录

日期：2026-10-04。范围来自维护者本轮请求：同步 main、检查 Windows/macOS/Linux 打包与工程关联，并完善真实路径、工程打开、最近工程、保存和相邻资源流程。参考笔记中的历史状态仅作线索；商业计划不属于本轮范围。

## 事实基线

- 初始工作区干净，HEAD 为 main 的 `d9f2e9be`，没有本地 `starlit-main`。
- 远端不存在同名 `starlit-main`；现有 Electron 集成分支是 `origin/merge/starlit-main`（`11b7ed21`），另有较早的 `origin/starlit`。
- 本地 `starlit-main` 跟踪 `origin/merge/starlit-main`。已 fetch 最新 main，合并前 main 独有 107 个提交，集成分支独有 22 个。
- 现有 `desktop/package.json` 仅配置 Windows x64；不能据此宣称三端可用。
- 旧反馈 `docs/TEST_FEEDBACK_STARLIT.md` 留有实际 Windows 启动、任务栏图标及 Python 依赖未验证项，本轮重新核对。

## 清单

| 编号 | 范围 | 处理项 | 类型 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 分支集成 | 合入最新 main，解决旧单体前端与模块拆分、Launcher、Server 冲突 | 修改 | 已修复 |
| 2 | 工程打开 | 原生选择、文件关联、命令行、拖拽统一真实路径并更新最近工程 | 修改 | 已修复 |
| 3 | 工程保存 | 原生新建/另存为，持续保存绑定、相对媒体路径和取消恢复 | 修改 | 已修复 |
| 4 | 媒体与相邻资源 | 媒体/字幕拖拽、路径识别、重定位、sidecar、目录选择 | 修改 | 已修复 |
| 5 | 三端打包 | Windows/macOS/Linux 后端布局、Electron 产物、关联与工程图标 | 修改 | 已修复 |
| 6 | 桌面生命周期 | 安全 IPC、单实例、未保存确认、窗口标题、后端清理与平台菜单 | 修改 | 已修复 |
| 7 | 文档与变更说明 | 实际使用方式、平台矩阵、已知验证边界和 CHANGELOG | 修改 | 已修复 |
| 8 | 验证 | 单元/服务器/交互/本地打包检查，分别记录实测与未验证项 | 修改 | 阻塞 |
| 9 | 浏览器本质限制 | Chromium 解码内存、新增 ASR/导出格式不由 Electron 自动解决 | 说明 | 仅说明 |

## 处理记录

### 1. 分支集成

- 桌面实现已提交为 `24c09742`。收尾 fetch 时 main 又新增 `10db8968`（使用指南与官网阅读导航重构），已按新版阅读结构解决文档冲突并整合实际 Electron 能力；功能代码没有新增冲突。
- 解决 README、Launcher、Server、测试、新手引导与旧单体脚本冲突；弃用脚本移入回收站，打开工程逻辑迁移到 `editor-server-save.js` 与接线模块。
- 保留 main 的 ASS 样式接口、工程比较语义、模型与预设能力，保留集成分支的更新器与桌面工程切换保护；恢复 main 的断线重启不重复开页行为。
- Electron、Launcher、GUI 与 lockfile 版本统一为 `1.8.0-beta.1`。
- `blank-editor.html` 使用 main 已有产物，没有重新生成；内联副本待发布前统一重生成。
- 初次 Python 定向检查 463 项出现两处旧契约问题（已删除 `web/editor.js` 路径和硬编码旧版本）；修复后这两项重测通过。前端语法/工具/波形检查 368 通过、1 跳过；安装 acorn 后顺序检查另行通过，无跳过。桌面辅助测试 17/17。

### 2. 工程打开

- 原生选择、input 和拖拽工程都使用 Electron `webUtils.getPathForFile` 提供的真实路径；与媒体一起拖入时把媒体覆盖路径一次传入，保留“作为副字幕”的原有选择。
- 桌面模式允许打开媒体已移动的工程并绑定保存、记录最近工程；普通 Server 的缺媒体错误契约保持原样。补齐 macOS `open-file` 与关闭后重新激活窗口入口，平台关联产物在第 5 项验收。
- `tests.test_desktop_editor` 4/4：缺媒体可编辑可保存及最近记录、公开加载契约、损坏文件不替换当前工程、桌面状态接口鉴权与公开模式 404。
- 实际 Windows Electron 交互 1/1：原生按钮（对话框返回路径由测试替身提供）、真实 file input 的路径识别、两项最近记录、绑定保存与缺媒体提示，未出现页面 JS 错误。首次启动失败因 Electron 44 的 npm 包延迟下载二进制；完成下载后 smoke 与交互测试通过。
- 未验证边界：Explorer/Finder/桌面环境中的安装后双击、原生对话框人工选择与 macOS/Linux 运行需分别验证。

### 阶段汇总（1–2）

最新 main 已合入，真实工程打开链路已恢复并通过 Server 与 Windows Electron 检查；下一步实现原生新建/另存为和媒体重定位。三端系统集成仍未验收。

### 3. 工程保存

- 原生 Save Dialog 返回的目标只在 Electron 主进程写入；Renderer 没有任意路径写入 IPC，Server 新接口只校验载荷、不写任意路径。
- 新建/另存为原子写入 UTF-8/LF，覆盖前保留 `.bak`；随后通过现有打开契约绑定新文件并更新最近记录。相对媒体按旧工程目录解析，另存到其他目录仍指向原媒体。取消不修改绑定和脏状态。
- 保留请求在途的新编辑；如果磁盘写入成功但重新绑定失败，明确提示并停用旧工程写回。
- Node 桌面辅助测试 19/19，桌面 Server 测试 5/5；Windows Electron 交互扩展覆盖取消另存为、跨目录另存为、原文件保留、持续保存新文件和原生新建，全部通过。原生对话框返回值由测试替身选择，实际保存/绑定/文件写入由产品代码完成。

### 4. 媒体与相邻资源

- 原生媒体选择与真实 File 路径通过 Server 生成 metadata、波形与相邻缓存，字幕导入保留所选媒体的绝对路径；不再使用 Blob 解码来处理桌面本地媒体。
- 媒体先暂存、播放器 metadata 成功后再接管；损坏媒体失败时保留当前工程及绑定，过期 ticket 不能替换后来打开的工程。公开 Server 不开放这些路径接口。
- 表情包目录支持原生文件夹选择，继续使用既有授权扫描；新按钮行的 gap 和上方间距实测均至少 8px，已截图自查。
- `tests.test_desktop_editor` 6/6；Windows `desktop/e2e/project-flow.mjs` 1/1 综合流程通过，涵盖 WAV 加载、波形、SRT 后保存、损坏媒体回滚、目录选择和间距；页面无 JS 错误。前端语法/顺序与 `git diff --check` 通过。
- 未验证边界：操作系统原生对话框由测试替身提供选择结果；macOS/Linux 运行与安装后关联尚未实测。

### 阶段汇总（3–4）

原生新建、另存为、持续保存和本地媒体/目录流程已通过 Windows Electron 交互及 Server 契约检查。接下来完善跨平台后端布局、工程文件图标与系统关联。

### 5. 三端打包与工程关联

- Windows 保持单套 MAW/Python/FFmpeg 的套件布局；macOS/Linux 增加随应用携带原生后端的 DMG/ZIP、AppImage/DEB，按原生系统和架构构建，不能拿 Windows 二进制跨平台运行。
- 新增可重现的 MOSP 文档 PNG/ICO/ICNS；Windows Installer 与便携注册使用该图标并添加 OpenWithProgids，尊重已有默认应用。macOS 声明 MOSP UTI 与文档图标；Linux DEB 安装 MIME，AppImage 提供“添加工程打开方式”菜单，仅写当前用户 XDG 数据，不改默认应用。
- Linux 保留 electron-builder 原有 sandbox/AppArmor 安装处理，滤除后端里会污染 Mesa 的旧运行库。Launcher 补充 Linux MOSE 查找。
- Release workflow 增加原生构建、打包后 smoke、Electron 交互与独立 MOSE 产物；修复合并后重复下载步骤和 Python heredoc 缩进。没有触发远端工作流或发布。
- `npm test --prefix desktop` 22/22、MOSP 三格式检查、Ruff 与 workflow YAML 解析通过；Windows Electron build、当前源码 PyInstaller build、staging 和打包后 backend/page/exit smoke 通过。此前错误的 Release notes 测试模块名已识别，收尾使用实际 `tests.test_release_notes`。
- 未验证边界：Windows 安装后 Explorer 双击尚未实测（本机无 Inno Setup）；macOS/Linux 原生产物与 OS 关联必须在相应系统/CI 验收，不能由配置与单元检查替代。本地打包检查使用开发者已有 FFmpeg，仅作为测试产物，不是发行包。

### 6. 桌面生命周期

- IPC 限于当前编辑器的主 frame 和精确后端 origin；窗口禁用 Node API，原生写入目标只取主进程 Save Dialog。标题、macOS represented filename、系统最近文档与工程真实路径同步，Windows 使用固定 AppUserModelId。
- 关闭/退出先处理未保存确认，取消时继续保留后端。macOS 关闭后可重新激活，文件关联事件也会重建窗口；macOS/Linux 提供原生文件菜单与平台快捷键。
- 确认退出后在根进程仍存活时停止整个已拥有的进程树，避免 daemon 缓存线程的 FFmpeg 成为孤儿。Windows 使用精确 PID 的 taskkill /T；POSIX 使用本次 detached backend 的进程组并在必要时升级信号，不按端口或名称发现进程。
- Windows 交互 2/2 综合流程通过：取消关闭与退出仍可保存、第二次真实启动在原窗口打开工程、最近列表、确认丢弃后端端口关闭；Node 24/24，包含真实 Windows 根进程与后代的清理检查。当前 Electron 能读取系统字体，交互测试验证字体目录非空，没有新增另一套字体扫描器。
- 未验证边界：macOS 菜单/Dock/Finder、POSIX 原生进程组回收仍需对应系统实测。

### 阶段汇总（5–6）

原生三端构建/系统关联契约已补齐，Windows 打包启动与生命周期检查通过。全量 Python 初跑 1852 项有 1 个旧源码字符串断言失败（媒体逻辑新增桌面分支后前缀变化），已更新该契约，保留浏览器缓存条件并由 Electron 流程覆盖 native 波形；等待收尾复测。前端完整 Node 检查与 typecheck 通过。

### 8. 验证边界

- 本机没有 Inno Setup，不能验证 Installer 安装/卸载及 Explorer 双击；macOS 无对应系统可运行。WSL Ubuntu-26.04 仅有 Python，缺 Node、uv、FFmpeg、Xvfb；Linux 安装脚本已通过 WSL shell 语法检查，完整应用需原生 CI/测试机验收。
- 这些平台与安装验收记录为 `阻塞`，并明确下一步是原生 CI 打包/交互及安装双击检查。不会把静态配置、源模式测试或 Windows smoke 作为三端实测结论。

### 7. 文档与变更说明

- README 中英文、WORKFLOW、EDITOR_GUIDE、FAQ、MOSE、desktop README、开发与 Server 说明已对齐 Electron 的原生路径、新建/另存为、缺媒体处理、最近工程、三端布局、工程图标和系统关联。
- 保留 main 新的专题指南、配图与分组导航；通过 `npm run sync:docs --prefix website` 生成 20 篇官网文档，未手改生成副本。`npm run check --prefix website` 无错误/警告，`npm run build --prefix website` 成功生成 22 页。
- THIRD_PARTY_NOTICES 更新为 Windows 共用后端、macOS/Linux 独立包内置原生后端和 FFmpeg；LICENSE 保持原样。Windows 更新沿用 Launcher，macOS/Linux 独立包手动更新，未承诺已发布或已验收的三端能力。
- CHANGELOG 按完整 MOSE 特性归为一条；未生成 `blank-editor.html`，内联副本待发布前统一重生成。参考笔记未修改，商业计划及自定义快捷键重映射不在本轮实现范围。

### 最终本地验证（文档集成后）

- 完整 Python：`python -m unittest discover -s tests -p "test_*.py"`，1852 项通过、27 跳过。旧波形字符串契约已修正，完整复测没有失败；Ruff 发现的三处既有冗余变量/字符串前缀已移除，相关 42 项补测通过。
- 根目录全部 `tests/*.mjs`、`npm run typecheck` 和桌面 `npm test --prefix desktop` 通过；桌面 24/24 包含实际 Windows 子进程树清理。相关 Python Ruff、Release YAML 解析通过。
- 图标 PNG/ICO/ICNS 验证通过；开发者 Python 未安装 Pillow，使用预装工具 Python 执行检查，CI 已在 build 依赖组包含 Pillow。
- 重新构建 Windows Electron 并 staging 后，实际打包程序的 `desktop/e2e/*.mjs` 2/2 通过：原生打开、真实 File 路径、最近列表、取消另存为、跨目录持续保存、新建、媒体/字幕、坏媒体回滚、目录选择、系统字体、未保存取消、单实例与确认退出。对话框选值由替身提供，IPC/Server/写盘/Chromium 为真实产品代码。
- 最终 packaged `--mose-smoke` 启动/页面/退出检查通过，退出码 0。首次 PowerShell Start-Process 测试因继承的 Electron Node 模式环境失败，改用明确清除该变量的子进程环境后通过；这不是编辑器启动失败。
- 新增目录选择行实测 gap 和上方距离均至少 8px；已查看最终打包流程截图，无布局问题。原生三端安装/关联验收仍按第 8 项保留为 `阻塞`。

## 验证账本

| 层级 | 命令或方法 | 实际结果 | 未验证边界 |
| --- | --- | --- | --- |
| Git | fetch、status、分支与提交对比，diff check | 初始无 WIP，main 两次文档/代码冲突已解决，桌面实现已本地提交 | 无推送 |
| 语法/单元 | 根目录全部 Node tests、desktop tests、typecheck、Ruff | 全部通过；desktop 24/24 | 不等同于桌面交互 |
| Server/契约 | 完整 Python unittest discover，相关契约补测 | 1852 项通过、27 跳过；清理 Ruff 后 42 项补测通过 | 既有可选依赖跳过；不等同于打包产物 |
| 桌面/浏览器交互 | 打包程序执行 `node --test desktop/e2e/*.mjs` | Windows 2/2 综合流程通过，实测间距并截图 | 原生对话框选值由测试替身提供；macOS/Linux 需对应系统 |
| 打包/系统关联 | 当前源码 Windows PyInstaller/Electron build、staging、packaged smoke；图标/配置契约 | 本地 Windows 实际包交互、启动与退出通过 | 无 Inno Setup，安装后双击未实测；macOS/Linux 须对应系统验收 |
| 官网文档 | sync:docs、Astro check、build | 20 篇同步、0 错误/警告、22 页构建通过 | 本地构建，未发布 |
| CI/外部服务 | 无发布或 push 授权 | 未触发远端 CI | 不创建 tag、Release 或远端推送 |
