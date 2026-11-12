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

## 第四轮盲审（12ed4856）

| 条目 | 状态 | 处理与证据 |
| --- | --- | --- |
| 合法快捷键交换加载时被尚未迁移的默认键误判冲突 | 已修复 | 先独立筛除格式/系统保留错误，再将所有候选覆盖作为完整集合校验；只有确有冲突才逐个剔除覆盖，并保留其余项。`play=j, reverse=p` 在真实刷新后两者均保留，J 映射 Space、P 映射 J，单测与浏览器均通过。对 `play=j` 单独存储时回退默认 Space，并明确警告其与倒放冲突。 |
| 字词选区捕获按原始按键漏掉已改绑父命令、并拦截失效旧键 | 已修复 | 字词选择的固定物理 C/Shift+C/F 优先处理；其它父命令保护使用 `MaweShortcuts.resolveEvent(event)` 的有效映射。真实浏览器确认 Delete 改绑 E 被捕获、Split 改绑 E 被捕获、旧 B 不再被错误阻止；Merge 改绑 E 与 color-9 改绑 U 均被阻止触发父字幕操作，物理 C/Shift+C/F 仍执行字词操作，Ctrl+C 仍未被误拦截。 |
| 捕获层与按键上下文审计 | 已复核 | 主字幕操作相关的可配置快捷键接线先调用 `resolveEvent`；字词时间码捕获层是唯一在该选区上下文直接决定父字幕快捷键是否继续传播的层，本次按有效映射识别 Delete、Split、Merge 与颜色 0–9。内联编辑 Enter/Escape、拆分弹窗 B/Enter/Space/WASD/方向键、媒体/导出/文本弹窗 Escape 与输入控件保持其明确的局部物理键语义，不参加全局命令映射。固定 M/Q 与字词 C/Shift+C/F 仍在其上下文生效；Ctrl+C 保持原生复制语义。 |

### 第四轮验证记录

- 红测：旧迁移算法下新增的 J/P 完整交换单测失败（`tests/test_editor_shortcuts.mjs`，`.artifacts/checks/20261112T184915Z-6f309d9e/`）；真实浏览器保存 J/P 后刷新回归失败（`.artifacts/checks/20261112T184940Z-d91b703c/`）。旧捕获逻辑真实浏览器回归证实 E 已解析为 Delete 但捕获未阻止（`.artifacts/checks/20261112T185148Z-fd9f8d0e/`）。同一红测在 E 断言处停止，旧 B 的独立红测未单独取得结果；修复后的浏览器回归直接确认旧 B 不被拦截。
- 修复后快捷键 Node 定向套件 19/19 通过（`.artifacts/checks/20261112T185504Z-7b77535a/`），最终新增迁移自定义冲突用例后 20/20 通过（`.artifacts/checks/20261112T190701Z-c4e999b7/`）。此前真实浏览器定向 5/5 通过（`.artifacts/checks/20261112T185728Z-f1e3dab6/`）；补充覆盖父级 Merge、color-9 与 Ctrl+C 后，三份相关 spec 定向运行 6/6 通过（`.artifacts/checks/20261112T190714Z-1b3a34ae/`，exit 0）。
- 浏览器使用已有 Playwright、浏览器、Node 与依赖；一次未提权尝试因 localhost `listen EPERM` 失败，获准后测试运行，无安装或下载。
- 本轮 `.pnpm-store/` 保持未跟踪状态，排除提交。

## 第五轮盲审（0db4526）

| 条目 | 状态 | 处理与证据 |
| --- | --- | --- |
| 字词选区捕获混用物理修饰键与映射键；改绑边界/相邻合并可漏拦父字幕命令 | 已修复 | 捕获层统一用 `resolveEvent(event)` 返回的有效键与修饰键判断父命令；真实浏览器覆盖 Ctrl+E→trim-start、E→merge-prev。修复后波形时间和父字幕文本保持不变。旧逻辑下 Ctrl+E 边界 E2E 实际把下一条 start 从 10000 改为 13500（`.artifacts/checks/20261112T191935Z-684935a7/`）；相邻合并旧逻辑红测曾因夹具未建立稳定 cue id、在按键前断言失败，故不作为有效旧逻辑红证据。 |
| Merge 改绑 Mod+C 时字词选区的物理复制被应用快捷键吞掉 | 已修复 | 字词选区/拖拽上下文中的物理 Ctrl/Cmd+C 只停止编辑器快捷键传播，不阻止默认复制；有效事件后续不再触发父级 Merge。旧逻辑浏览器结果显示 Ctrl+C 与 Meta+C keydown 均 `defaultPrevented=true`（`.artifacts/checks/20261112T192730Z-b9f994b3/`）；修复后同用例两个 keydown 均未阻止，字幕数保持 3。 |
| 拖拽期间播放改绑 P 被物理键白名单吞掉 | 已修复 | 活跃字词拖拽使用有效映射键判断控制操作；P 映射为空格后仍冒泡到播放处理器。新增真实 Playwright 拖拽中 P 播放断言，当前通过；此前对照因测试放错 spec、引用不存在的 `word()` helper 失败，不能称为旧逻辑红测。 |
| 字词固定操作及平台边界 | 已验证 / 部分未验证 | 已有真实浏览器用例确认物理 C、Shift+C、F 字词操作不变，父级改绑不双触发；Linux Chromium 下 Ctrl+C 触发一次原生 `copy`，Meta+C keydown 未被阻止，但该环境不生成 Meta+C 原生复制事件，macOS 原生复制行为未实测。 |

### 第五轮验证记录

- 修复后定向真实浏览器：`python scripts/run_check.py --timeout 600 -- ./node_modules/.bin/playwright test tests/e2e/keyboard-timing.spec.mjs tests/e2e/word-timing.spec.mjs --workers=1 -g 'word-selection capture uses projected|physical Ctrl\\+C and Meta\\+C|remapped play key remains available|word-selection capture protects effective remapped|word-selection physical C, Shift\\+C and F'`，6/6 通过，exit 0，日志 `.artifacts/checks/20261112T193505Z-bfbe4366/`。一次未提权尝试因 `listen EPERM: 127.0.0.1` 未启动用例（`.artifacts/checks/20261112T193445Z-a5551bb5/`）；获准本地监听后重跑通过。
- 定向 Node：`python scripts/run_check.py --timeout 180 -- node --test tests/test_editor_shortcuts.mjs tests/test_editor_word_timing.mjs`，20/20 通过，exit 0，日志 `.artifacts/checks/20261112T193533Z-5fcf882d/`。
- 产物检查：`python scripts/run_check.py --timeout 180 -- node scripts/build-editor.mjs --check`，exit 0，bundle fresh，日志 `.artifacts/checks/20261112T193535Z-4f43caa6/`。`git diff --check` 通过。
- 独立只读自审未发现 blocker / major；指出 Linux Chromium 不足以证明 macOS 原生 Meta+C 复制行为。
- 本轮未重跑全量测试；此前已知全量 Node/Python 与多字幕用例限制见上文。本轮没有安装/下载依赖；`.pnpm-store/` 保留、未查看内容且不纳入提交。
- 收尾核验：再次 `git fetch origin 2.0dev` 后 FETCH_HEAD 与 origin/2.0dev 均为 `e358512e8fef890dd2e607c61ec5f522d13943a5`，仍是 HEAD 的祖先。Checklist 格式检查与相对该基线的个人路径扫描均 exit 0（`.artifacts/checks/20261112T193836Z-33dd4eca/`、`.artifacts/checks/20261112T193836Z-25bb0003/`）；`git diff --check` 通过。
