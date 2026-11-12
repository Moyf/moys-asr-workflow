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

## 第三轮盲审（0b9dd000）

| 条目 | 状态 | 处理与证据 |
| --- | --- | --- |
| `split=q, merge=b, play=p` 导致回退并丢失无关 `play=p` | 已修复 | 已存配置逐命令试加，并对当时接受的绑定做冲突校验。`split=q` 因 Ctrl/Cmd+Shift+Q 系统保留组合被拒；`merge=b` 因与默认拆分 B 冲突被拒；`play=p` 保留。提示分别呈现系统保留原因与冲突对象。单测及真实浏览器刷新、再保存回归通过。 |
| 固定标记键 M 可与自定义拆分同时触发 | 已修复 | 固定上下文键 M（标记编辑）、Q（字词时间码）、C/Shift+C（字词选区合并）、F（字词选区试听）纳入可配置绑定冲突检测；既有操作仍可使用其 C/Shift+C、F。单测和真实浏览器验证非法 `split=m` 被丢弃，按 M 仅切换标记编辑且字幕数不变。 |
| 全量 Node/Python 基线对照 | 已复核 / 部分未验证 | Node 在同一现存 Node 22.23.1、依赖和 fresh bundle 下，基线 `0b9dd000` 为 1434 项、1417 通过、17 失败、0 取消、exit 1；修复分支为 1436 项、1419 通过、17 失败、0 取消、exit 1，17 个失败名称相同，新增两项通过。该 Node 版本不满足项目 engines。基线 Python 快照没有测试日志或 `result.json`；只读进程检查未发现活动测试进程，不能将其计为通过或失败。 |
| pnpm 执行时意外创建 `.pnpm-store/` | 仅说明 | 一次 `pnpm exec playwright ...` 触发自动依赖预检；全局 store 无法 hard-link 后，pnpm 在仓库创建 `.pnpm-store/v11/index.db`，并因无 TTY 报 `[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY]`，中止移除/重建 `node_modules`。Playwright 随后启动，但沙箱 localhost bind 报 `EPERM`。未观察到锁文件、依赖清单或 `node_modules` 变更；不推断未发送网络请求。目录保留且排除提交。 |

### 第三轮验证记录

- 红测：修复前快捷键单测 17 项中 2 项失败（存储配置隔离、M 冲突）；修复前真实浏览器迁移/M 回归失败。修复后快捷键单测 `17/17` 通过；定向 Chromium 迁移/M 为 `2/2`、Alt 拖拽派生分发为 `1/1`，均 exit 0。
- 全量 Node：同环境快照比较如上。基线 `$HOME/.hermes/cache/scratch/maw-shortcut-review-base-0b9dd000-20261113/.artifacts/checks/20261112T183659Z-69d79082/`；分支 `.artifacts/checks/20261112T182925Z-8a5cb284/`。Node 22.23.1 不满足 `^22.23.4 || ^24.22.1 || >=26.12.1`，故不能称为受支持环境结果。
- 分支全量 Python 既有结果：3039 项、19 skipped、exit 0（`.artifacts/checks/20261112T183004Z-365c7376/`）。本次基线快照无 Python 输出/result 文件；核查时没有相关存活进程，未重复运行，基线结果未知。
- 构建与浏览器回归复用已有 Node 22.23.1、`node_modules`、浏览器和 Python venv，未下载或安装依赖。此前沙箱 localhost 权限失败不与获准后对照混为一谈。
- `.pnpm-store/` 是未跟踪目录；显式提交文件清单将排除该目录。
