# MOSE 桌面文件与路径开发进度账本

以 `docs/PLAN_MOSE_DESKTOP_IO.md` 为验收源。恢复工作前重新检查本文件、`git status --short` 和实际 diff。本任务逐项推进；测试、构建、桌面手测分别记录，不用一项代替另一项。

## 当前基线

- Branch：`merge/starlit-main`
- 起始 HEAD：`45432ce114c8424d93e9a341bea43b72fea081ee`
- 起始状态：工作区干净（2026-10-09）。后续以实测状态为准。

## 处理清单

| 编号 | 范围 | 内容 | 状态 |
| --- | --- | --- | --- |
| 1 | Desktop bridge / 工程路径 | 文件引用、按钮/拖放/关联统一打开、最近工程只记录成功打开 | 已修复 |
| 2 | 表情包 | 原生目录选择、沿用扫描验证、失败与取消回滚 | 已修复 |
| 3 | 新建/保存/另存为 | 桌面路径绑定、自动保存、备份与素材能力保留 | 已修复 |
| 4 | 媒体 | 源路径持久化、失效工程可开、重新定位与 sidecar | 已修复 |
| 5 | 生命周期/导出 | 关闭确认、外部改写检测、导出结果和路径动作 | 已修复 |
| 6 | 浏览器兼容与发布准备 | 原模式回归、bundle、CHANGELOG、完整套件和验收记录 | 进行中 |

## 验证记录

| 阶段 | 命令/场景 | 结果 | 未验证边界 |
| --- | --- | --- | --- |
| 基线 | 只读检查工作区与代码 | 已确认起始 HEAD、桌面桥接、Server API 和编辑器入口；本任务改动尚无测试 | 无 |
| 阶段一 | `npm run build:editor`、`npm run check:editor`、`npm run typecheck`、`node --test tests/test_editor_host.mjs tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs` | bundle 已重建且一致；类型检查通过；编辑器 Host 6 项与脚本语法/顺序 2 项通过；首次检查发现清单遗漏和测试 async 标记，已修复后复跑 | 无真实 Explorer 拖放/原生选择器验收；安排阶段五 |
| 阶段一 | `npm test --prefix desktop` | 19 项通过；新增文件引用类型、失效会话、目录/扩展名拒绝及有界注册测试 | 未启动实际 Electron 窗口 |
| 阶段一 | `uv run --no-sync python -m unittest tests.test_local_editor_server` | 91 项通过；新增双密钥桌面命令/status/新建绑定测试通过；公共 Server 仍不暴露桌面接口 | 媒体真实播放/外部文件拖放仍待阶段三/五 |
| 阶段二 | `uv run --no-sync python -m unittest tests.test_local_editor_server.LocalEditorServerTests.test_desktop_save_as_switches_binding_only_after_write_and_keeps_old_file tests.test_local_editor_server.LocalEditorServerTests.test_desktop_save_rejects_same_size_same_timestamp_external_edit` | 2 项通过；跨目录另存为切换到新路径、旧文件逐字节不变；后续保存只改新文件；相同大小与 mtime 的外部内容改写被拒绝 | 真实 Windows 保存对话框与只读/文件锁场景待 Electron 验收 |
| 阶段三 | `uv run --no-sync python -m unittest tests.test_local_editor_server.LocalEditorServerTests.test_desktop_project_load_keeps_subtitles_available_when_media_is_missing tests.test_local_editor_server.LocalEditorServerTests.test_desktop_media_reassociation_preserves_project_content_and_invalidates_cache` | 2 项通过；普通 Server 对缺失媒体仍严格报错，桌面模式保留字幕；重新关联媒体保留字幕/标记/工作区并清除旧媒体缓存、递增工程代次 | 浏览器实际播放、真实路径拖放及后台缓存文件需补 Electron 回归 |
| 阶段三 | 源码检查 | `desktop_source_media_path()` 用于状态和路径定位；媒体身份/音轨变化清除缓存，异步波形按工程代次丢弃过期任务 | 编辑器可继续打开缺失媒体工程；普通 Server 严格语义未变 | 真实 Explorer 拖放和播放仍待 Electron/套件手测 |
| 阶段四 | `node --check desktop\src\main.cjs`、`node --check desktop\src\preload.cjs`、`node --test tests\test_editor_host.mjs`、`npm test --prefix desktop`、2 项 Server 定向测试 | Host 7 项、Electron 19 项和 Server 2 项通过；覆盖下载等到对应 DownloadItem 完成才释放 Blob URL、取消/成功可区分、备份路径限制与创建、外部内容强制摘要刷新 | 真实保存对话框、完成/取消/失败下载、Explorer 关闭握手与外部编辑 UI 尚未手测 |
| 阶段四 | Electron 主进程/页面契约审查 | 新增受信任的主 frame IPC、保存/切换/关闭确认、2 秒状态轮询、冲突时暂停自动保存；路径动作仅用工程/媒体/表情包/备份/导出引用，不收 renderer 任意路径 | 源码与 Server 命令有双令牌校验；冲突覆盖前重新计算 SHA-256 | 需要用运行中的 MOSE 对照真实文件系统操作 |
| 阶段四 | UI 与翻译核查 | 在 Chromium 可控桌面 Host 下切到暗色并截图；表情包选择行垂直间距实测 8px、按钮间距实测 8px，路径菜单项间距实测 8px。测量发现弹窗通用规则把按钮间距覆盖为 6px，已提高选择器优先级并重建 bundle；改后截图通过目测 | `test-results/mose-desktop-path-actions-dark.png`、`test-results/mose-desktop-project-menu-dark.png` | 这是 renderer UI + 桌面 Host 替身，不是 Explorer / 原生对话框的人工验收 |
| 阶段五 | `npm run build:editor`、`npm run check:editor`、`npm run typecheck`、`git diff --check` | bundle 60 ESM factories / 181 sources；bundle 新鲜；类型检查和 diff 检查通过 | 无 |
| 阶段五 | `npx playwright test tests/e2e/new-project.spec.mjs tests/e2e/editor-i18n-save.spec.mjs tests/e2e/open-project-drop.spec.mjs tests/e2e/open-project-attach.spec.mjs --project=chromium --reporter=line` | 32 项通过。另修复浏览器拖入工程+媒体后媒体未加载、已保存工程拖入时未确认的兼容回归；测试夹具改为注入当前 minify bundle 的公开 `MaweBoot.SERVER_CONFIG` 属性 | 该组 E2E 测的是普通 Server/浏览器 File 流程，不证明 Electron 真实路径读取 |
| 阶段五 | `uv run --no-sync python -m unittest tests.test_local_editor_server tests.test_project_backups tests.test_media tests.test_media_cache tests.test_packaging_contract` | 164 项通过；覆盖桌面命令双密钥、保存/冲突、最近工程、媒体丢失/重新关联、缓存和打包契约 | 无 |
| 阶段五 | `npm test --prefix desktop`、`node --test tests\test_editor_host.mjs tests\test_editor_script_syntax.mjs tests\test_editor_script_order.mjs` | Electron 19 项、Host/脚本检查 9 项通过 | Electron Host 单测不模拟 Windows Explorer 路径 |
| 阶段五 | Electron / MAW 构建与 staging | 源码 `npm run smoke --prefix desktop` 通过；Electron-builder x64 unpacked 构建通过；当前源码 MAW.exe 以隔离 `build/staging-mose-desktop-io` 目录构建通过；`stage-mose-bundle.ps1` 组套成功；staging 中 `MOSE.exe --mose-smoke` 通过 | smoke 不创建可交互窗口；输出没有覆盖原有 `dist` 或旧 `build/release/mose` | 
| 阶段五 | `uv run --no-sync python -m unittest discover -s tests -p 'test_*.py'` | 1891 项通过，23 项跳过。首轮发现的 2 条旧编辑器/Electron 契约断言已更新；ModelScope 缓存用例已隔离宿主机 Hugging Face 缓存。最终全量复跑通过 | 此自动化结果不替代真实 Electron 窗口和原生文件对话框验收 |
| 追加反馈 | MOSE 窗口不可见但 Launcher 报告已启动 | 当前 MOSE 主进程及 renderer 在运行，但 Windows 无可见主窗口句柄；Launcher 的 `open_mose()` 把用于隐藏控制台进程的 `STARTUPINFO(SW_HIDE)` 与 `CREATE_NO_WINDOW` 用在 GUI Electron 进程上。已移除这两个标志，并在 `ready-to-show` 和第二实例事件中显式显示、恢复、聚焦窗口 | 新建的 `build/staging-mose-window-fix` 套件正常启动；隔离配置下 MOSE 主窗口句柄非零且进程 Responding；smoke exit code 0；Electron 21 项与 Launcher 定向测试 2 项通过 | 原有旧版本隐藏进程仍在默认单实例配置下运行且未被结束；未能用当前不可用的原生 UI 控制入口实际点击新 MAW Launcher 按钮 |
| 追加反馈 | 关闭确认提示 `MaweI18n is not defined` | 桌面关闭、工程切换、保存、新建和媒体/目录选择原先调用不存在的 `MaweI18n`；全部改用实际导出的 `window.MAWE_I18N?.language`，并增加源码契约回归测试 | `npm run build:editor`、`npm run check:editor`、`npm run typecheck` 通过；契约测试 1 项通过；Host/脚本检查 9 项通过；`git diff --check` 通过；独立 staging 套件 `MOSE.exe --mose-smoke` 退出码 0 | 尚未在真实可交互窗口中点击关闭并确认保存/不保存/取消；smoke 仅验证套件启动与后端页面请求 |
| 追加反馈 | 标题栏媒体/工程操作菜单样式不统一且左侧展开时被视口裁切；要求盘点新增 UI | 这两处是在阶段四“文件定位”中加入的。将媒体、工程、最近导出三处 `<details>` 自绘菜单改为共用 `.dropdown-menu / .dropdown-item` 结构和 `MaweExportMenus` 交互，并加入视口边缘定位；新增 `docs/MOSE_DESKTOP_UI_CHECKLIST.html` 逐项列出本轮新增与改造的可见 UI | `npm run build:editor`、`npm run check:editor`、`npm run typecheck`、`git diff --check` 通过；编辑器资源契约 25 项、Host/脚本检查 9 项、菜单 E2E 1 项通过；E2E 核对菜单项可见、视口内完整显示、与“保存工程”菜单的背景/边框/圆角/阴影/项目文字与间距样式一致，方向键与 Esc 行为通过；截图 `test-results/desktop-path-menus-desktop-7b682-yling-and-keyboard-behavior-chromium/desktop-path-menu-shared-style.png` | 当前截图来自 Chromium + 桌面 Host 可控替身，仍需在实际 MOSE 窗口复核 |

## 尚待实机验收

状态：进行中。实现、自动化回归、完整本地套件与隔离配置下的 MOSE 可见窗口启动均已验证；以下项目仍需要在可交互的 Windows 桌面环境中由维护者实测，不能由 Chromium Host 替身或 headless smoke 代替：

- 用 Explorer 实际拖入 `.mosp` 与媒体；确认真实路径登记、同名不同目录及同时拖放行为。
- 使用原生文件/目录保存对话框完成新建、跨目录另存为、表情包目录选择和取消回滚。
- 在 MOSE 窗口中执行保存并继续/不保存/取消，实际编辑工程文件制造外部改写与删除，确认提示及自动保存暂停。
- 通过原生下载窗口分别测试成功、取消、失败，确认完成后可定位文件。
- 真实暗/亮主题切换后检查桌面菜单与路径弹窗；当前截图仅证明页面 CSS、翻译和实测间距。
- 在重启/结束旧隐藏 MOSE 进程后，通过新构建的 MAW Launcher 点击“在 MOSE 中打开”，验证无 profile 参数的完整启动链和第二实例恢复行为。

