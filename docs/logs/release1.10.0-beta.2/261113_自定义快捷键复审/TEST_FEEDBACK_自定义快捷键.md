# 自定义快捷键二轮盲审反馈与处理

记录基线：`origin/2.0dev=e358512e8fef890dd2e607c61ec5f522d13943a5`。处理分支：`feat/custom-editor-shortcuts-2.0dev`，修复前 HEAD：`8790122587f750b8673f2f2b5e8fd0799fe2a300`。

## 反馈处理

| 条目 | 状态 | 处理与证据 |
| --- | --- | --- |
| A/D/W/S 改键后 Alt 反转联动微调仍映射原方向；旧方向不应再触发，派生键参与冲突检测 | 已修复 | `editor-shortcuts.js` 为导航及追加选择命令派生 Alt 组合，并将映射目标投影到原默认组合；旧物理键按完整组合屏蔽。单测覆盖四方向和冲突；真实浏览器拖拽覆盖 A→E、D→Q 与原有 Alt+Shift 追加选择修饰语义。 |
| 强制拆分提示显示自定义键，但打开的拆分对话框只接受 B 或 Enter | 已修复 | 对话框打开时提示固定显示可用的 B/Enter；模板先翻译再插值。波形回归通过真实浏览器提示与按 B 重试断言。 |
| 已保存 `split=q` 与 `play=p` 时，无效拆分项不应使其他有效配置回退或在下次保存丢失 | 已修复 | 配置逐命令校验，丢弃无效拆分项并显示含冲突组合/原因的提示，保留 `play=p`；单测与真实浏览器存储写回用例通过。`origin/2.0dev` 当前源文件未包含该存储格式；本地分支/tag refs 未显示该格式已落入这些 refs，不能据此断言它从未在其他发布渠道出现。 |
| 多字幕整文件 E2E 的 8 个失败是否由本分支改动引入 | 已复核 | 在独立 `origin/2.0dev` 源码快照中，8 个精确用例再次全部失败，错误与原分支记录一致；因此确认这些用例在本次改动前的基线也失败。 |
| 全量 Node 与 Python 失败原因及基线归属 | 仅说明 | 当前分支全量 Python 日志显示 3039 项中 2 failures、1 error、19 skipped，集中在 `test_editor_entry_retirement` 与 `test_editor_entry_review`：打包快照缺 `blank-editor.html`、MAW.spec 因 `launcher-mock-api.js` bundle stale 提前退出，测试期望另一个同步错误提示；其中 1 error 是同一打包测试对 1.9.0 子例抛出的 stale bundle `SystemExit`。全量 Node 当前分支日志没有 `result.json`，曾记录 1432 项、1385 通过、25 失败、22 取消，但不能完整核实退出码。基线 `origin/2.0dev` Node 全量结果为 1419 项、1402 通过、17 失败、0 取消；17 项集中在 editor/launcher bundle 静态导入捕获、manifest/watcher 测试。Python 基线输出完整至 `Ran 3039 tests in 101.533s`、`OK (skipped=19)`，原测试 PID 已退出；运行器未生成 `result.json`，故没有可核实的外层退出码。 |

## 验证记录

- 修复前对照：旧快照 `87901225` 的真实浏览器 Alt 映射回归在 `handleHeldCueKey` 结果断言处失败；修复后同用例通过。
- 修复后焦点 Chromium：存储迁移、A/D 与 Alt 派生拖拽、拆分对话框 B/Enter 提示共 3 项通过。
- Node 快捷键/脚本语法/顺序测试共 17 项通过；`check:editor`、`git diff --check`、个人路径扫描通过。
- 整文件 e2e 尝试执行 109 项后人工中断，`run_check.py` 退出码 130，日志停在第 49 项；多项失败已记录，但整组结果未知。
- 全量 Python 当前分支结果来自已有日志；独立 `origin/2.0dev` 基线 Python 输出显示 3039 项、19 skipped 且 unittest 汇总为 `OK`，但外层 `result.json` 缺失，退出码未知。全量 Node 当前分支没有可核实的 `result.json`，不能标记通过；独立基线 Node 全量有退出码 1，1419 项中 17 失败、0 取消，失败集中在 editor/launcher bundle 静态导入捕获及 watcher 测试。8 项多字幕基线对照使用 `origin/2.0dev` 快照与相同已安装浏览器、Node 依赖、Python venv；不下载依赖。

## 本地证据位置

- 修复分支日志：`.artifacts/checks/20261112T175402Z-399f921c/`、`.artifacts/checks/20261112T175812Z-cc724652/`、`.artifacts/checks/20261112T175826Z-700f66c3/`、`.artifacts/checks/20261112T175826Z-04733898/`。
- 基线快照日志：`$HOME/.hermes/cache/scratch/maw-shortcut-base-e358512e-review-20261113/.artifacts/checks/20261112T175604Z-c642026e/`（8 项 E2E）；`.artifacts/checks/20261112T180249Z-ba650f2d/`（Node 全量，exit 1）；`.artifacts/checks/20261112T180351Z-a3bfbbe9/output.log`（Python 基线，完整 unittest 汇总但缺 `result.json`）。
- 旧逻辑 red 对照：`$HOME/.hermes/cache/scratch/maw-shortcut-prepatch-87901225/.artifacts/checks/20261112T175343Z-5b34ca12/`。

这些日志保存在本机忽略目录，提交中不包含生成的测试输出。
