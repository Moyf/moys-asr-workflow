# 新建工程与空白编辑器导入处理记录

本文记录“新建工程”、空白编辑器拖入文件和最近工程路径同步的审阅、实现与验证结果。工程路径涉及本机隐私与文件搬迁兼容性；是否写入 `.mosp` 以实际契约审阅结论为准，不把讨论中的方案直接视为既定实现。

## 处理清单

| 编号 | 范围 | 需求摘要 | 类型 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 编辑器 / 工程 | 左上角增加“新建工程”；先选择保存位置，再创建并自动加载工程 | 修改 | 已修复 |
| 2 | 工程契约 / 最近工程 | 审阅是否把工程原始路径写入 `.mosp`，并让 Server 及时更新最近工程 | 审阅后修改 | 已修复 |
| 3 | 编辑器 / 空白状态 | 未加载工程时提示可拖入 `.mosp`、媒体或 SRT 开始编辑 | 修改 | 已修复 |
| 4 | 编辑器 / 拖入导入 | 空白状态拖入媒体或 SRT 时先选择工程保存位置，创建后再加载编辑 | 修改 | 已修复 |
| 5 | Server / 仅字幕工程 | 已绑定但无媒体的工程页显示真实工程名，而不是“未加载工程” | 回归修复 | 已修复 |
| 6 | 编辑器 / 媒体导入 | 以真实 WAV 覆盖“创建检查点 → 修改编辑器 → 保存导入状态”的顺序 | 测试补强 | 已修复 |
| 7 | 编辑器 / 收尾验证 | 完成三档响应式浏览器检查、完整回归与原生对话框限制记录 | 验证 | 已修复 |

## 事实基线

- 开始时 `git status --short`、`git diff --stat` 与 `git diff` 均无输出，工作区干净。
- `web/` 是唯一编辑器前端源码；修改后必须通过 `uv run python edit.py --blank` 重新生成 `blank-editor.html`。
- 当前 `.mosp` 契约包含媒体路径，但没有工程文件自身路径；浏览器不能仅凭拖入的 `File` 对象读取其绝对路径。
- 当前审阅重点：区分“Server 实际打开/保存的工程路径”与“工程内容中可能陈旧的来源路径”，避免把不可信路径用于任意文件读取或写入。

## 处理结论

- 工程自身绝对路径不写入 `.mosp`。路径会随复制/移动失效，也会暴露本机目录；浏览器提供的路径同样不能作为任意写入授权。
- 【2026-08-18 方案调整】「新建工程」不再经过本机 helper 进程：服务器版与便携版统一使用浏览器 `showSaveFilePicker()`，页面持有 `FileSystemFileHandle`，后续「保存工程」、Ctrl(Cmd)+S 与自动保存都写回该句柄文件。`POST /api/project/create` 端点、`maw/project_save_dialog.py` 与 `--project-save-dialog` CLI 已整体移除。
- 浏览器新建的工程不进入服务器「最近工程」；服务器已绑定工程时新建会解除旧工程保存（`SERVER_CONFIG.canSave` 置 false），防止把新工程写进服务器旧文件。打开工程未被服务器接管时同样解除。
- 媒体/SRT 导入在未绑定工程时先创建检查点（同样走浏览器句柄）；SRT 先完成解析，创建成功后才修改字幕，随后立即保存导入状态。
- 空白和仅 SRT 工程重新打开时不再强制解析媒体，仍保持可保存状态。

## 验证记录

以下为 2026-08-18 方案 A（浏览器句柄保存）改造后的最终验证；helper 时代的记录随实现一并移除。

- `node --check web/editor.js`、`web/editor-i18n.js`、`web/waveform.js`、`web/editor-utils.js`、`web/editor-runtime.js`、`web/editor-onboarding.js`：通过。
- `uv run python -m unittest discover -s tests -p "test_*.py"`：619 项通过（移除 helper 套件后总数相应减少）。
- `node --test tests/test_editor_utils.mjs tests/test_waveform_js.mjs`：121 项通过。
- `uv run python edit.py --blank`：已重新生成 `blank-editor.html`，内联副本含句柄保存逻辑。
- `npx playwright test tests/e2e/new-project.spec.mjs --project=chromium`：7 项通过，覆盖便携版句柄绑定 + Ctrl+S 写回同一句柄、服务器绑定页新建后不再写旧工程（0 次服务器保存请求）、取消保留现状、英文确认文案、SRT/媒体先创建检查点再保存导入状态、工程文件绕过创建。
- 邻近 E2E：`editor-i18n-save` 6 项、`open-project-attach` 2 项通过——服务器绑定工程的 Ctrl+S / 另存为 / 自动保存 / 断连回退与接管流程无回归。
- `git diff --check`：通过；仓库无 `createUrl` / `project_save_dialog` / `--project-save-dialog` 残留（仅测试中的 `assertNotIn` 防回归守卫）。
- 浏览器响应式检查（375 / 768 / 1280 px）：沿用 helper 时代结果，本次改造未触及布局与样式。
- 未验证边界：真实浏览器（非 mock）的 `showSaveFilePicker` 系统窗口未做自动化 smoke test；该路径与既有「另存为…」和便携保存完全共享，风险低。
