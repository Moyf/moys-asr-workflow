# MAW 2.0dev Playwright 全量收集修复台账

## 基线与任务来源

- 基线：`origin/2.0dev` @ `4fd058e0`（fix(v2): 新建空白工程后可继续保存到同一文件 (#397)），独立 worktree，不合并 main，不改 PR #410。
- 任务来源：交接简报（MAW 2.0dev：恢复 Playwright 全量收集并修复基线测试）。
- 环境：Node v22.23.2（engine 要求 ^22.23.4，pnpm 仅警告，可运行）；`pnpm install --frozen-lockfile` 完成，postinstall 已构建 editor/launcher bundle 与工具文档。

## 第一批：恢复 Chromium 全量测试收集

### 问题复现（2026-11-20）

命令（run_check.py 执行，日志 `.artifacts/checks/20261120T055027Z-fb90557c/output.log`）：

```
node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs --project=chromium --list
```

结果：exit=1，`SyntaxError: The requested module './helpers.mjs' does not provide an export named 'buildPortableBlankEditor'`，Total: 0 tests in 0 files。

根因：helpers.mjs 已将旧 `buildPortableBlankEditor`（调用 `edit.py --blank` 生成便携产物）更名为 `buildBrowserEditorFixture`（经 `tests/helpers/render-editor-fixture.py` 渲染浏览器契约夹具，不产生应用发布产物）。两个 spec 仍导入旧名：

- `tests/e2e/cue-list-action-buttons-layout.spec.mjs`
- `tests/e2e/editor-menu-focus.spec.mjs`

ESM 命名导出缺失使整个收集阶段失败，全量 0 项，任何选择器都跑不起来。

### 处理决定

| 状态 | 事项 | 决定 / 说明 |
| --- | --- | --- |
| 已修复 | cue-list-action-buttons-layout.spec.mjs 收集失败 | 纯 UI 布局断言（cue-list 工具栏按钮省略号），与入口无关，仍适用于本地编辑器。迁到 `buildBrowserEditorFixture` + `startStaticServer`（与 editor-feedback-layout / marker-editing-gate 等既有范式一致），复用 makeTempDir / cleanupTempDir。 |
| 已修复 | editor-menu-focus.spec.mjs 收集失败 | 键盘焦点 / 菜单间距断言，与入口无关。同样迁到 `buildBrowserEditorFixture` + `startStaticServer`（与 speaker-experience-keyboard 一致）；fixture 从 `.artifacts` 硬编码目录改用 makeTempDir + 清理机制。 |
| 已修复 | 全量 `--list` 验收 | 不指定 spec、不用 grep 的全量 Chromium `--list` 退出 0 且列出非零测试（exit=0，1261 项 / 133 文件，见验证证据）。 |
| 已修复 | 变更 spec 定向运行 | 两个 spec 实际运行并记录旧失败 / 新通过证据（见验证证据）。 |
| 待处理 | 第二批：39 项已知失败样本分诊 | 依赖全量发现恢复；另建分账，不混入本批。 |

### 验证计划

1. 全量 `--project=chromium --list`（不指定 spec、无 grep）退出 0、非零测试数。
2. `cue-list-action-buttons-layout.spec.mjs` 定向运行。
3. `editor-menu-focus.spec.mjs` 定向运行（约 22 项，含媒体加载路径，预计 ≤ 10 分钟，显式超时）。

## 第一批执行记录

- 2026-11-20：复现收集失败（见上）。迁移两个 spec 至浏览器契约夹具 + 静态服务模式（`buildBrowserEditorFixture` + `startStaticServer`，复用 `makeTempDir` / `cleanupTempDir` / `findFreePort`），断言本身未改动。

## 验证证据

### 1. 全量 Chromium 收集（验收项：不指定 spec、无 grep）

- 命令：`node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs --project=chromium --list`（run_check.py 执行）
- 修复前（2026-11-20T055027Z-fb90557c）：exit=1，`SyntaxError: ... does not provide an export named 'buildPortableBlankEditor'`，Total: 0 tests in 0 files。
- 修复后（2026-11-20T055248Z-f654d4f9）：**exit=0，Total: 1261 tests in 133 files**，2.06s。

### 2. cue-list-action-buttons-layout.spec.mjs 定向运行

- 命令：`node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs --project=chromium tests/e2e/cue-list-action-buttons-layout.spec.mjs`
- 结果（20261120T055257Z-7f9e8d27）：**exit=0，1 passed**（495ms）。断言（省略号 / nowrap / 高度 < 32px）全部保持。

### 3. editor-menu-focus.spec.mjs 定向运行

- 命令：`node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs --project=chromium tests/e2e/editor-menu-focus.spec.mjs`
- 结果（20261120T055321Z-426f8819）：**exit=0，14 passed**（16.6s），含 4 项菜单间距（zh/en × 2 菜单）、8 项 Escape 焦点释放、OTIO 键盘导航、Space 激活。
- 旧失败形态：收集阶段即报 `SyntaxError`（同上），0 项可运行。

### 收尾检查

- 进程清理：`Get-CimInstance Win32_Process` 按 worktree 路径过滤，无残留 python/uv 进程（两个 spec 均用进程内静态 http 服务，无外部 serve.py）。
- `git status --short`：仅 `tests/e2e/cue-list-action-buttons-layout.spec.mjs`、`tests/e2e/editor-menu-focus.spec.mjs` 与本账本目录，无意外改动。
- 环境说明：`uv run --no-sync python`（helpers 默认 Python 入口）首次执行时在 worktree 内创建空 `.venv`（已忽略，不入库）；`render-editor-fixture.py` 导入链无第三方依赖，验证可跑。后续第二批涉及 `startServer` / `startBlankServer`（serve.py）的 spec 需要完整依赖时，按 AGENTS.md 以 `MAW_E2E_PYTHON` 指向锁文件一致的主仓库 venv 或先 `uv sync`。

## 第一批结论

全量收集阻塞已解除，两个退役入口遗留 spec 完成迁移并定向通过。尚待解决：第二批 39 项已知失败样本（audio-processing、cue-scroll-stability、editor-session-state、pr239-view-save-integration、project-boundary 等主题）的分诊与修复，见分账。
