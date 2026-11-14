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

## 第六轮盲审（6d3f7ac1）

| 条目 | 状态 | 处理与证据 |
| --- | --- | --- |
| `Mod+C` 可保存为合并键，旧存储可能吞掉系统复制并合并字幕 | 已修复 | `Mod+C` 现被视为系统保留组合，设置保存前拒绝；旧存储按单项迁移丢弃该项、保留 `play=p`，并以静态原因和动态平台键名提示。Windows/Linux 与 macOS 的 `Mod` 展开及迁移由单测覆盖；浏览器实际 Ctrl/Meta+C 均未被阻止，字幕数量不变。当前浏览器为 Linux Chromium，Meta+C 的 macOS 原生复制动作未实测。 |
| ASS 定位拖拽捕获层仍用物理 Ctrl/Cmd+Z/Y | 已修复 | 捕获层改用 `resolveEvent` 投影后的键与修饰符。真实浏览器拖拽中旧 Ctrl+Z / Meta+Y 不再触发；自定义 Ctrl+U / Meta+Shift+U 分别按原撤销/重做语义取消拖拽。 |
| 保存改为 F2 后，模态内旧 Ctrl/Cmd+S 仍触发全局保存 | 已修复 | 若模态打开且旧保存组合已被改绑，全局保存监听器仅阻止默认页面保存并返回，不停止传播，因此模态仍收到按键。浏览器测试观察到 Ctrl/Meta+S 均没有 POST 保存请求、事件仍到达模态；另验证编辑态默认 Ctrl+S 仍保存未提交文本且保持编辑态。没有将 F2 扩展到编辑态普通快捷键。 |
| 英文存储迁移提示把动态键名先拼入译文导致中文回退 | 未复现 | 当前 `describeSavedBindingWarning` 已将标签、动态组合、静态原因分字段，UI 分别翻译再插值。真实浏览器已观察到完整英文 `split=q` 警告。旧草拟测试错误假设标签复数和固定 Ctrl 平台名，调整为动态平台键名后通过；未改动已有实现。 |

### 第六轮验证记录

- 修复前红测：快捷键 Node 单测 `21` 项中 `20` 通过、`1` 失败，失败证明 `validChord('Mod+c')` 为真（`.artifacts/checks/20261112T195216Z-952dfdc7/`）。真实浏览器红测复现旧 ASS Ctrl+Z 取消拖拽、Ctrl+C 被阻止、Mod+C 迁移无警告、以及模态内旧保存组合发出 POST（`.artifacts/checks/20261112T195629Z-7345ad92/`）；该轮英文用例的硬编码期望与实际英语文案/浏览器平台不匹配，不计为产品红测。
- 构建：`python scripts/run_check.py --timeout 180 -- node scripts/build-editor.mjs --write`，exit 0（`.artifacts/checks/20261112T195809Z-277d02e9/`）。
- 定向快捷键单测：`python scripts/run_check.py --timeout 180 -- node --test tests/test_editor_shortcuts.mjs`，21/21 通过、exit 0（`.artifacts/checks/20261112T195812Z-b8d894d1/`）。
- 定向真实浏览器回归 6/6 通过（`.artifacts/checks/20261112T200116Z-3d411a91/`）；补上平台对应的原生 Ctrl/Meta+C 派发一次 `copy` 事件断言后，该用例 1/1 通过（`.artifacts/checks/20261112T200704Z-cba95ef5/`）；两份受影响 spec 最终整文件 20/20 通过、exit 0（`.artifacts/checks/20261112T200731Z-d9b6450c/`）。一次沙箱尝试因 localhost `listen EPERM` 未启动；获准后使用现有浏览器/依赖完成测试，未安装或下载。
- 独立只读审查未发现 blocker / major；其建议补充的浏览器原生 `copy` 派发断言已增加并实测通过。系统平台原生行为的覆盖仍限当前自动化浏览器环境。
- 之前全量 Node/Python 及多字幕对照限制仍见前文，本轮未重跑全量。`.pnpm-store/` 保留为未跟踪目录且不提交。

## 第七轮盲审（6b387e86）

| 条目 | 状态 | 处理与证据 |
| --- | --- | --- |
| 模态中已改绑的全局旧键仍触发 J/K/L 播放操作 | 已修复 | `resolveEvent` 在模态期间只把已失效的旧全局组合投影为 `Unidentified`，不修改原始事件，也不把新绑定映射成模态键；拆分弹窗仍收到物理 J 与 Escape。真实浏览器检查 J 不再改变播放速度、J 仍抵达弹窗监听，Escape 仍关闭弹窗。监听审计确认可配置命令消费者使用 `resolveEvent`；例外保存监听有专门旧保存键保护，固定 M/Q 与输入、Escape、拆分弹窗本地按键保留各自物理语义。 |
| 边界贴合 Shift+ArrowLeft 改键后 Alt+Shift 旧组合未屏蔽，Alt+新键未派发 | 已修复 | snap-ArrowLeft/Right 与导航拖拽一样派生 Alt 变体，参与冲突校验及旧物理组合屏蔽。真实波形操作确认 Alt+Shift+ArrowLeft 不再贴边，而 Alt+E 将字幕起点贴到前字幕终点 8000ms。 |
| 精确迁移输入 `split=["Shift+e"], play=["p"]` 的英文冲突提示混入中文 | 已修复 | 先识别静态派生冲突原因，再以结构化 label/chord/reason 供 UI 分别翻译与插值；加载上述原始存储后英文提示包含 Split subtitle、Shift+E 和英文原因，不含中文，播放 P 保留。 |

### 第七轮验证记录

- 红测：旧实现快捷键单测 24 项中 21 通过、3 项失败（`.artifacts/checks/20261112T201810Z-59749c69/`）；旧实现真实浏览器三项分别复现 J 将播放速度从 1 降至 0.5、旧 Alt+Shift+ArrowLeft 将字幕起点从 50000 改至 8000、英文提示含中文（`.artifacts/checks/20261112T201908Z-6c658db0/`，3 项失败）。
- 修复后单测 24/24 通过（`.artifacts/checks/20261112T202250Z-2d2517b3/`）。三项真实浏览器回归 3/3 通过（`.artifacts/checks/20261112T202030Z-7e278712/`）；快捷键 Playwright spec 整文件 20/20 通过、exit 0（`.artifacts/checks/20261112T202309Z-a82a1de9/`，`result.json` 的 `cleanup_error` 为 null）。
- 完整 spec 的首次沙箱尝试在 localhost bind 阶段 EPERM，未执行用例（`.artifacts/checks/20261112T202250Z-e864f703/`）；获准沙箱外运行后完成整文件测试。日志显示测试服务进程组清理 EPERM 后退回 leader-only kill，但 `result.json` 记录测试 exit 0、cleanup_error null；随后进程名检查无 playwright/run_check/serve 进程输出。
- `node scripts/build-editor.mjs --check` 显示 bundle fresh（`.artifacts/checks/20261112T202250Z-1cc8993c/`）；`git diff --check` 与 `python scripts/check_personal_paths.py --diff-ref origin/2.0dev` 均 exit 0。快捷键单测外的全量 Node/Python 本轮未重跑，既有基线限制见前文。
- 没有安装或下载依赖；`.pnpm-store/` 保持未跟踪且不提交。

## 维护者决策后的验证

- 保存改绑 F2：字幕文字编辑保留 Ctrl/Cmd+S；非编辑态允许把旧键用于其他命令。单测覆盖主字幕、副字幕及字幕面板，真实浏览器覆盖待提交文字保存、编辑态 F2 不保存和旧键复用为合并命令。
- 快捷键及脚本单测 29/29；编辑器工具与波形单测 419/419；真实 Chromium 快捷键完整 spec 与英文保存 spec 共 41/41；editor bundle 重建及新鲜度检查通过。
- 浏览器测试中曾因等待请求而非响应导致下一次保存仍 in-flight；改为等待响应后通过。新增合并测试初版将合并结果写入共享工程影响后续用例，改为拦截该测试的保存响应并验证请求体后，整组通过。普通保存测试仍使用真实服务端。
- Node 22.23.1 低于本分支要求 `^22.23.4 || ^24.22.1 || >=26.12.1`；结果仅证明现有环境，非受支持版本验收。Playwright 的服务组清理曾报 EPERM 并回退 leader-only kill。

## 第八轮盲审（8f79366d）

| 条目 | 状态 | 处理与证据 |
| --- | --- | --- |
| 原生 `dialog[open]` 中 remapped F2/M/Q 仍触发背后的全局命令 | 已修复并浏览器复验 | 快捷键解析器将原生打开 dialog 视作模态上下文；全局可配置键只收到被抑制的投影，dialog 本身仍收到原始按键。raw 固定键和 Escape/编辑捕获也增加原生 dialog 守卫。独立审查又找到 export 与 project-media 的 4 个捕获层 Escape 监听；已补守卫并扩展浏览器用例，确认 F2/M/Q 均到达 dialog，字幕数未减少、M/Q 固定开关状态不变；Escape 只关闭原生 dialog，project-media/FCP7/Lottie/Ogra 背景 overlay 仍保持打开。修复前红测观察到选中字幕数量从 6 减为 5。 |
| `nav-a=Alt+Shift+e, play=p` 旧存储导致英文动态冲突原因混入中文 | 已修复并浏览器复验 | 迁移告警把 Alt 派生冲突前缀解析为独立原因字段，再由英文翻译后插入动态组合。真实浏览器检查显示完整英文 Alt+Shift+E 原因、不含中文，且播放 P 保留。 |
| 保存改绑 F2 后旧 Ctrl+S 与编辑态保存入口 | 已验证，策略待维护者决定 | 真实浏览器中改绑后，非编辑态旧 Ctrl+S 不产生保存请求，F2 正常保存；编辑态旧 Ctrl+S 也不保存，工具栏「保存工程」按钮仍能保存编辑文字。未将普通 F2 扩展到编辑态。是否将 Ctrl+S 保留为独立编辑态特例属于产品语义，暂不自行修改。默认绑定下编辑态 Ctrl+S 原有保存行为的回归仍通过。 |
| macOS `Mod+Space` 与 `Mod+Shift+3` 系统快捷键处理策略 | 仅调查，待维护者决定 | Apple 官方文档说明 Command-Space 打开 Spotlight、Shift-Command-3 截取全屏；用户可在 Keyboard Shortcuts 设置中自定义系统快捷键。MAW 当前校验允许这两个 chord，也无法读取用户的 macOS 系统设置或保证系统会把事件交给浏览器。是否采用平台特定拒绝、可配置保护或明确警告留待维护者决定；本轮未改策略。 |

### 第八轮验证记录

- 修复前红测：快捷键 Node 单测 26 项中 2 项失败（原生 dialog 未被识别为模态、Alt 派生动态提示未结构化），日志 `.artifacts/checks/20261112T203434Z-0d96ffde/`；真实浏览器复现 F2 删除背后字幕（数量 6→5）及英文警告混入中文，日志 `.artifacts/checks/20261112T203449Z-1e3aa419/`。
- 修复后快捷键单测：`python scripts/run_check.py --timeout 180 -- node --test tests/test_editor_shortcuts.mjs`，26/26 通过，exit 0，日志 `.artifacts/checks/20261112T205128Z-2ec8ca31/`。
- 修复后完整快捷键浏览器 spec：`python scripts/run_check.py --timeout 600 -- ./node_modules/.bin/playwright test tests/e2e/custom-shortcuts.spec.mjs --workers=1`，23/23 通过，exit 0，日志 `.artifacts/checks/20261112T205447Z-d676aee2/`。随后因独立审查建议扩大叠层覆盖，再跑含四类背景 overlay 的原生 dialog 用例 1/1 通过，exit 0，日志 `.artifacts/checks/20261112T205531Z-2f772470/`。保存改绑 E2E 1/1 通过，日志 `.artifacts/checks/20261112T205048Z-9806375e/`。一次转义错误的 `-g 'save remap disables stale Ctrl\\+S'` 过滤未匹配测试，exit 1、未执行用例（`.artifacts/checks/20261112T205030Z-14954ddc/`）；随后按标题字面前缀重跑通过。
- 最后扩展堆叠 overlay 用例后重建 bundle（`.artifacts/checks/20261112T205433Z-9f39156a/`）、快捷键单测 26/26（`.artifacts/checks/20261112T205433Z-4baeae35/`）、脚本语法/顺序测试 2/2（`.artifacts/checks/20261112T205433Z-5e2f393b/`）。`node scripts/build-editor.mjs --check` 在早先 E2E 扩展前 fresh（`.artifacts/checks/20261112T205128Z-13895bdf/`）；最后一次构建写入成功，尚未再次运行 `--check`。
- `git diff --check` 与 `python scripts/check_personal_paths.py --diff-ref origin/2.0dev` 通过。Checklist 格式检查 exit 0（`.artifacts/checks/20261112T205553Z-e031b694/`）。
- 独立只读复核初次指出四个 modal Escape 捕获器缺少原生 dialog guard；修复后复核确认守卫位置、堆叠 dialog 测试覆盖和全局快捷键审计均无遗漏，没有 blocker/major。
- 最终状态检查：bundle fresh（`.artifacts/checks/20261112T205627Z-33fa5809/`），checklist 格式检查通过（`.artifacts/checks/20261112T205627Z-93dbe586/`），`git diff --check` 与个人路径扫描通过。仍未提交，等待系统快捷键和编辑态 Ctrl+S 产品决策。
- Playwright 结果显示服务进程组清理遇到 EPERM 后退回 leader-only kill，但测试 exit 0。读取系统进程列表时 `ps` 返回 operation not permitted，故没有独立系统级进程清单；完整 spec 已结束并由 run_check 记录为 completed。
- 未安装或下载依赖；`.pnpm-store/` 保持未跟踪，未读取、修改或提交。当前更改尚未提交。全量 Node/Python 沿用之前记录的限制，本轮未运行。

## 纯文本弹窗保存快捷键（维护者决策，2026-11-13）

- 基线：`feat/custom-editor-shortcuts-2.0dev` / `8f79366d`，开始时 23 个 tracked 文件修改及调查测试、`.pnpm-store/` 均保留；预存 diff 与校验值留在本机 `.artifacts/modal-save-baseline/`。禁止安装、下载、删除、提交、push；仅复用已有依赖及 localhost。
- 决策：快捷键先应用再保存；应用无效、失败或字幕快照过期时阻止保存，提醒且保留草稿。应用成功后保存失败或取消保留内存修改与 dirty，提示「编辑已应用，但工程未保存」，不恢复草稿、不重复应用。原生另存为补足结果语义；下载回退无法确认最终落盘时如实提示。其余快捷键决策不变。

| 问题 | 状态 | 处理 / 验证 |
| --- | --- | --- |
| 纯文本弹窗保存未应用草稿或未截获保存键 | 已修复 | 保存与另存为快捷键复用应用入口，POST / 写入 Blob 均含新文字。物理 Ctrl/Cmd+S、Shift 另存为保留；自定义裸键沿用文本输入保护。 |
| 应用失败 / 过期仍保存或关闭草稿 | 已修复 | 无效报告、应用返回空、应用异常，以及文字/字词/样式快照过期均阻止保存并保留草稿。完整字幕快照比较排除 `_dirty` 会话标记。 |
| 保存失败 / 取消及 save-as 结果不明确 | 已修复 | 服务端失败、句柄取消、原生另存为失败/取消保留内存修改和 dirty，提示「编辑已应用，但工程未保存」，重试不重复应用；原生成功返回 true，失败/取消 false，下载回退保留无法确认的结果。 |
| 既有纯文本 spec 三项失败 | 仅说明 | 最终相关 57 项中 54 通过、3 失败；保留所有预存 WIP 的隔离源码快照中相同三个断言失败，本轮不扩展修改。后续单独维护旧 spec 的数据/保存契约。 |
| 原生系统保存对话框及普通下载最终落盘 | 仅说明 | 浏览器用例模拟 picker/句柄，验证写入 Blob 与取消结果；真实系统对话框留待人工清单。普通下载只能确认发起，不能证明最终保存或取消，保留 dirty 并明确提示。 |

- 环境检查：既有 editor bundle fresh，`.artifacts/checks/20261113T020435Z-4cd0b067/result.json`。首次浏览器运行因沙箱 `listen EPERM 127.0.0.1` 未进入用例（`.artifacts/checks/20261113T020436Z-1d1d20a3/result.json`），不能算行为红灯；改以允许 localhost 的执行环境重跑。每次使用新的输出目录并启用 trace，不清理测试产物。
- 实现前浏览器红灯：14/14 失败，exit 1，96.13s，`.artifacts/checks/20261113T020449Z-5b798837/result.json`；trace 与错误上下文在 `.artifacts/modal-save-red-2/`。默认保存没有发出 POST（预期 1 次，实际 0 次），失败/取消场景未应用且没有约定提示，四类应用失败未告警；尚未修改产品代码。后续以相同测试验证绿灯。
- 初次修复验证 6/14 通过、8 失败（`.artifacts/checks/20261113T020801Z-6d684fcd/`）：测试夹具错误地使用旧格式，触发强制另存为，服务端 POST 与新文件句柄场景均未按预期运行。夹具改用现有 `importProject(...).project` 生成规范 v2，并显式断言不要求迁移另存为；不修改迁移策略。修正后 14/14 通过（`.artifacts/checks/20261113T020937Z-f2971fd5/result.json`）。
- 追加快照边界红灯：只改字词时间码 / 样式时，旧字段比较无法识别过期，会覆盖并保存。先新增两条回归，2/2 失败，`.artifacts/checks/20261113T021314Z-0bdc88d0/result.json`；随后再扩大快照比较，排除 `_dirty` 会话标记。
- 追加输入保护红灯：实现者收尾发现裸改绑键可能抢占 textarea 输入；先加入真实 `save=p` 输入回归，1/1 失败（输入框因错误应用被关闭），`.artifacts/checks/20261113T022011Z-df585b54/result.json`。随后恢复既有规则：文本目标仅接受带 Ctrl/Meta 的自定义保存键，物理 Ctrl/Cmd+S 与 Shift 另存为保留；F2 改绑仅在焦点离开文本框后生效。
- 规范夹具旧逻辑对照：用 `HEAD` 的本机源码归档叠加开始时的完整 diff，逐文件 SHA256 确认 23 个预存 tracked WIP 完全一致，新增测试使用同一份规范 v2 夹具，直接复用原工作树依赖。16 项新增回归全部红灯，另加的 3 个既有失败同样失败，合计 19/19 失败、exit 1、114.04s；`.artifacts/checks/20261113T021804Z-a3f9d0a7/result.json`，产物 `.artifacts/modal-save-baseline-real/`。此前两次尝试在返回 HTML 内替换 bundle 的对照因模板注入 / JS 初始化失败，未进入行为断言，不作为红灯证据；相关产物全部保留。
- 既有完整相关 spec 复验：`custom-shortcuts.spec.mjs`、`timed-text-edit.spec.mjs`、`editor-i18n-save.spec.mjs` 共 57 项，54 通过、3 失败，exit 1；`.artifacts/checks/20261113T021844Z-e159da09/result.json`。失败均在 `timed-text-edit.spec.mjs`：撤销后的完整段对象断言（443 行）、旧格式直接服务器保存返回值（610 行）、空工程视图字段约定（647 行）。隔离旧源码快照出现相同位置和断言差异。未把本组报告为全绿。
- 相关 Node 单测及脚本语法/顺序 62/62 通过、exit 0，`.artifacts/checks/20261113T021805Z-a79af5c3/result.json`；editor bundle 已重建，新鲜度检查通过（`.artifacts/checks/20261113T021806Z-a360e9a8/`）。`git diff --check` 与个人路径检查通过（`.artifacts/checks/20261113T021815Z-336a0dc6/`）。清单格式与生成通过（`.artifacts/checks/20261113T021616Z-407b0d3b/`、`20261113T021616Z-9f6f1e69/`）。
- 本轮源码范围：纯文本模块/接线、保存模块/接线、i18n；测试新增专用保存 spec，helper 增加显式 `MAW_E2E_KEEP_ARTIFACTS=1` 保留开关；更新指南、CHANGELOG 既有快捷键条目与本主题账本/清单/审查记录。既有调查测试与其余快捷键预存修改保留，未动 `.pnpm-store/`，未安装、联网下载、删除、提交或推送。普通下载回退用例只生成并保留本机合成工程产物。
- 最终专用浏览器回归：17/17 通过、exit 0、10.44s，`.artifacts/checks/20261113T022055Z-17ab9e50/result.json`，产物 `.artifacts/modal-save-17-green/`。重建记录 `.artifacts/checks/20261113T022052Z-39f4d953/result.json`。覆盖逐条/整体视图实际 POST payload、保存/另存为写入 Blob、六类应用拦截、服务器失败、句柄取消、原生另存为成功/失败/取消、下载回退不确定性、重试不重复应用、普通字母输入保护、文本框 F2 不保存、按钮焦点 F2 保存、无变更保存、repeat 与 IME。英文告警截图已检查，草稿文字保持可见。

本轮命令（均从实际待测源码根目录执行，使用已有本地 Python 与 Node，不运行 `pnpm exec`；输出目录每次新建，保留开关为 `MAW_E2E_KEEP_ARTIFACTS=1`）：

```sh
python3 scripts/run_check.py --timeout 180 -- node scripts/build-editor.mjs --write
python3 scripts/run_check.py --timeout 180 -- node scripts/build-editor.mjs --check
python3 scripts/run_check.py --timeout 180 -- node --test tests/test_editor_shortcuts.mjs tests/test_project_save_state.mjs tests/test_tracks_project_save.mjs tests/test_timed_text_report.mjs tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs
python3 scripts/run_check.py --timeout 600 -- ./node_modules/.bin/playwright test --config=tests/config/playwright.config.mjs tests/e2e/timed-text-save-shortcuts.spec.mjs --workers=1 --output=.artifacts/modal-save-17-green --trace=on
python3 scripts/run_check.py --timeout 600 -- ./node_modules/.bin/playwright test --config=tests/config/playwright.config.mjs tests/e2e/custom-shortcuts.spec.mjs tests/e2e/timed-text-edit.spec.mjs tests/e2e/editor-i18n-save.spec.mjs --workers=1 --output=.artifacts/modal-save-existing-regressions-final --trace=on
```

如复跑须更换输出目录，避免 Playwright 清理同名旧产物。`MAW_E2E_PYTHON` 指向当前已安装解释器；隔离旧源码快照只读复用同一解释器与 Node 依赖。全量 Node/Python、真实系统对话框未验证；本轮无待处理或进行中的实现项，人工核验项保持 pending。

最终收尾：17 项专用 E2E 绿灯后，输入保护增量独立只读复审通过，无未处置 finding。再次检查 bundle fresh（`.artifacts/checks/20261113T022258Z-809d796c/`）、62/62 单测（`20261113T022258Z-b6670f84/`）、清单格式/生成（`20261113T022259Z-389eabaf/`、`20261113T022259Z-1642eddd/`）、diff 与个人路径（`20261113T022259Z-c1cd5a19/`）均通过。

生成的清单已在本地 Chromium 打开并保留截图（`.artifacts/checks/20261113T022449Z-0ea91096/`；截图在 `.artifacts/modal-save-verification-final/`）。首个检查脚本把隐藏分区当成首屏可见文字而误判（`20261113T022422Z-7b89c791/`），改为等待已渲染复选框并检查完整文本后通过，清单源码未因此修改。测试结束后系统级只读核对没有剩余 `server-editor/serve.py` Python 进程。

本轮实际修改文件（其余开始时的未提交工作保持原样）：

- `web/editor/cues/editor-timed-text-edit.js`
- `web/editor/cues/editor-wiring-text-tools.js`
- `web/editor/io/editor-project-save.js`
- `web/editor/io/editor-wiring-export-actions.js`
- `web/shared/editor-i18n.js`
- `tests/e2e/timed-text-save-shortcuts.spec.mjs`（新增）
- `tests/e2e/helpers.mjs`
- `docs/user/EDITOR_GUIDE.md`
- `CHANGELOG.md`
- 本目录 `TEST_FEEDBACK_自定义快捷键.md`、`REVIEW_FINDINGS.md`、`自定义快捷键.checklist.md`

## 纯文本保存再次盲审（2026-11-13）

| 条目 | 状态 | 处理与证据 |
| --- | --- | --- |
| 保存绑定 F3 与纯文本搜索捕获冲突 | 仅说明 | F3 / Shift+F3 是已有模态本地搜索键，捕获层优先；绑定 F3 后实测仍定位命中、不保存或应用草稿。输入框中 F2 和裸字母仍遵守输入保护，没有扩大全局键的编辑态响应。 |
| 其他模态默认 Ctrl/Cmd+S 未阻止浏览器保存 | 已修复 | 自定义模态与原生 dialog 均使用现有模态判定，物理保存及另存为组合阻止浏览器默认行为，同时保留事件传播，不触发工程保存。 |
| 真实事务提交后的界面刷新异常 | 已修复 | 事务发布历史后标记 committed；刷新等提交后副作用抛错时关闭草稿并提示修改已应用、界面刷新失败，快捷键保存仍使用已提交数据。真实事务回归检查保存内容、重试不重复应用及撤销恢复。提交前异常仍按原事务回滚。 |
| stale items/style 与裸字母抢输入 | 已修复 | 复核当前快照比对覆盖完整字幕元数据（忽略 `_dirty`）；浏览器回归确认 items/style 外部变更阻止应用和保存、保留草稿；裸字母输入不触发保存。 |

验证使用本机已有 Node 26.12.1、已有依赖与浏览器，`MAW_E2E_KEEP_ARTIFACTS=1`，每次使用独立新 `--output`；不安装、不下载。红测：自定义模态与提交后刷新异常分别在 `.artifacts/checks/20261113T022807Z-74d576f8/result.json` 失败，F3 本地语义通过；原生字幕时间偏移 dialog 在 `.artifacts/checks/20261113T023048Z-aa4f6105/result.json` 失败。初次沙箱运行因本地监听 EPERM 未进入行为断言；之后获准仅监听 127.0.0.1。此前失败和全部产物保留。

本轮未运行全量 Node / Python、真实系统保存对话框或其他操作系统浏览器；既有全量测试和人工验收限制见前文。`.pnpm-store/` 与全部既有未提交内容保留。

最终验证：Node 26.12.1 下 `timed-text-save-shortcuts.spec.mjs` 与 `custom-shortcuts.spec.mjs` 共 45/45 通过（`.artifacts/checks/20261113T023116Z-b0aa42f6/result.json`）；命令事务、快捷键及脚本语法/顺序 36/36 通过（`20261113T023110Z-ee64ba46/result.json`）；bundle 新鲜度、TypeScript 检查、个人路径扫描均通过（`20261113T023110Z-ad3eebf5/result.json`、`20261113T023125Z-af111ca7/result.json`、`20261113T023125Z-f0ff941a/result.json`）。浏览器服务退出时进程组清理报 EPERM 并回退到 leader-only 终止；随后系统进程检查未发现残留编辑器服务。清单格式校验和生成通过，并用本机 Chromium 打开、检查新增条目（`20261113T023215Z-4ca97465/result.json`、`20261113T023220Z-ec729c9b/result.json`、`20261113T023315Z-77bac809/result.json`）。


## 旧快照三项失败复诊（2026-11-14）

本轮从 `feat/custom-editor-shortcuts-2.0dev` / `8f79366d` 的现有未提交工作继续；未覆盖既有修改、未修改产品代码或旧测试。以本机已有 Node 22.23.1、Python venv、Playwright 和 Chromium 验证；该 Node 版本不满足 `package.json` 的 engines，结果限于此环境。所有 Playwright 使用单 worker、新输出目录及 `MAW_E2E_KEEP_ARTIFACTS=1`。

| 旧用例 | 复诊结果与证据 | 尚存缺口 |
| --- | --- | --- |
| 正则替换应用后撤销（`timed-text-edit.spec.mjs:443`） | 实际对象仅多出两条字幕的 `_dirty: true`；历史恢复显式保留当前会话的修改高亮（`editor-history.js` 的 `rememberSessionHighlights` / `restoreSessionHighlights`），指纹与写盘剥除该字段；用户指南亦规定保存后保留高亮。该断言把会话高亮等同于工程内容，和现行契约不一致。 | 失败发生在重做断言之前；本轮未实证该旧用例的重做及完整内容比较。应维护测试：分别断言持久化内容撤销/重做与高亮语义，不能简单删除内容断言。 |
| 视图偏好保存重开（第 610 行） | 夹具写入无 schema 的旧工程；`saveProjectToServer` 先检查 `requiresMigrationSaveAs` 并转入另存为，真实服务也拒绝覆盖旧格式。当前规范要求首次迁移另存为，测试直接期望服务器原位保存与契约冲突。 | 该用例在首次保存即停止，后续重开及切回 rows 未验证；需用带身份的规范 v2 夹具测试原位保存，并另测旧工程的迁移另存为。 |
| 空工程视图偏好（第 647 行） | `buildBlankProject()` 未设置 `timed_text_edit_view`；代码在字段缺失时使用 rows，schema 也规定缺失代表 rows 且默认值保存时省略。加载空工程后实际 `undefined` 与规范一致，旧断言期望字面 `rows` 已过时。 | 后续干净状态与导出省略断言因首个失败未执行；尚需更新测试并检查实际 UI 默认视图及两项后续断言。 |

- 原样复跑上述三项：`MAW_E2E_KEEP_ARTIFACTS=1 MAW_E2E_PYTHON="$PWD/.venv/bin/python" python3 scripts/run_check.py --timeout 600 -- ./node_modules/.bin/playwright test --config=tests/config/playwright.config.mjs tests/e2e/timed-text-edit.spec.mjs --workers=1 --output=.artifacts/shortcut-diagnosis-20261114 --trace=on -g 'regex replacement uses captures|timed-text view preference survives|unavailable single view'`；3/3 失败，exit 1，`.artifacts/checks/20261114T024827Z-be118f81/result.json`。本轮只诊断，不宣称整组通过，也未改写旧用例掩盖失败。
- 完整快捷键及纯文本保存专用浏览器测试：相同环境运行 `python3 scripts/run_check.py --timeout 600 -- ./node_modules/.bin/playwright test --config=tests/config/playwright.config.mjs tests/e2e/custom-shortcuts.spec.mjs tests/e2e/timed-text-save-shortcuts.spec.mjs --workers=1 --output=.artifacts/shortcut-full-20261114 --trace=on`；45/45 通过，exit 0，`.artifacts/checks/20261114T024906Z-a8b08961/result.json`。
- `python3 scripts/run_check.py --timeout 180 -- node --test tests/test_editor_shortcuts.mjs tests/test_editor_commands.mjs tests/test_editor_state.mjs tests/test_project_save_state.mjs tests/test_tracks_project_save.mjs tests/test_timed_text_report.mjs tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs`：83/83 通过，exit 0，`.artifacts/checks/20261114T024937Z-d06a3925/result.json`。
- `python3 scripts/run_check.py --timeout 180 -- node scripts/build-editor.mjs --check`：bundle fresh、exit 0，`.artifacts/checks/20261114T024808Z-682fa526/result.json`；`git diff --check` 通过。
- 仍未验证：真实操作系统保存对话框与实际下载落盘、其他系统浏览器、本轮全量 Node/Python、三项旧用例在更新断言后的完整行为。既有 WIP 和 `.pnpm-store/` 保留；未安装依赖、执行 setup hooks、删除、提交或推送。待 Hermes 基于本工作树独立盲审。
- `python3 scripts/run_check.py --timeout 180 -- ./node_modules/.bin/tsc -p web/tsconfig.typecheck.json` 与 `python3 scripts/run_check.py --timeout 180 -- python3 scripts/check_personal_paths.py` 均 exit 0；结果分别为 `.artifacts/checks/20261114T025030Z-07c3780b/result.json`、`.artifacts/checks/20261114T025034Z-cee7d390/result.json`。


## 独立盲审反馈与旧测试维护（2026-11-14）

| 问题 | 状态 | 处理 |
| --- | --- | --- |
| 模态中 Shift+J/K/L 穿透控制背景播放 | 已修复 | 原生 dialog 与拆分弹窗均复现三个按键改变背景速度；只在 J/K/L 播放监听器增加现有模态判断，原事件仍交给弹窗，关闭后 Shift+J 保持生效。 |
| 三项纯文本旧测试提前失败 | 已修复 | 以独立规范 v2 夹具验证保存/重开，单独验证旧格式迁移另存为和源文件不变；撤销/重做分别核对完整持久内容与会话高亮，默认视图检查实际界面。 |

使用已有 Node 26.12.1，不安装依赖；测试产物使用新目录并保留。

- Node 26.12.1 真实浏览器红测两项均失败，六个 Shift+J/K/L 背景速度断言均失败（`.artifacts/checks/20261114T025430Z-944a663c/result.json`）；重建 bundle 后同两项通过，并断言事件到达弹窗、关闭后 Shift+J 仍可调速（`.artifacts/checks/20261114T025530Z-b9085c11/result.json`）。第一次写源码的 Python 命令因本机 Python 的 `Path.write_text` 不支持 `newline` 抛错、没有修改源码；使用 `open(..., newline="\n")` 后成功修改并重新构建。

- 后续断言在规范 v2 夹具下揭示两个实际缺陷：切回 rows 后输出仍包含默认字段，以及新建空工程被误标记为已修复而保持脏态（`.artifacts/checks/20261114T025754Z-743c5a88/result.json`）。修复分别在持久化快照中省略 rows、用导入器预生成空工程完整默认字段；重建后四项定向浏览器用例全部通过（`.artifacts/checks/20261114T030017Z-3517b196/result.json`），Node 26.12.1 下相关单元与装配 84/84 通过（`.artifacts/checks/20261114T030026Z-6e952eb3/result.json`）。首次修复后测试尝试在空工程无字幕状态点击被禁用的纯文本入口，导致超时；调整为检查空工程数据及干净状态，再载入含字幕的默认视图工程检查 UI（`.artifacts/checks/20261114T025912Z-c36a55a1/result.json`）。
- 受影响浏览器整组（Node 26.12.1、已有 Chromium，六个 spec、单 worker）：`MAW_E2E_KEEP_ARTIFACTS=1 MAW_E2E_PYTHON="$PWD/.venv/bin/python" python3 scripts/run_check.py --timeout 600 -- node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs tests/e2e/custom-shortcuts.spec.mjs tests/e2e/timed-text-save-shortcuts.spec.mjs tests/e2e/timed-text-edit.spec.mjs tests/e2e/v2-migration-save.spec.mjs tests/e2e/editor-i18n-save.spec.mjs tests/e2e/editor-session-state.spec.mjs --workers=1 --output=.artifacts/shortcut-contract-full-20261114 --trace=on`：92 项中 84 通过、2 失败、6 未运行，exit 1（`.artifacts/checks/20261114T030108Z-8455aad0/result.json`）。`editor-session-state.spec.mjs` 的 beforeAll 使用已经改为 v2 tracks 的生成器后仍读取 `project.segments`，因此在行为断言前 TypeError，后续 6 项未运行；该 spec 还包含多处旧数据模型引用，本轮未擅自扩展迁移。另一个失败是纯文本 F2 保存断言等不到 POST，原因未确定。
- 只针对 F2 所在的整个 spec 单独复跑（同环境、同参数，目标为 `tests/e2e/timed-text-save-shortcuts.spec.mjs`、新输出目录 `.artifacts/timed-save-recheck-20261114`）：21/21 通过、exit 0（`.artifacts/checks/20261114T030301Z-1b167f28/result.json`）；该重跑不抹去整组原始失败，也不能单凭通过证明其成因。
- `node scripts/build-editor.mjs --check`、`node node_modules/typescript/bin/tsc -p web/tsconfig.typecheck.json`（均 Node 26.12.1）通过；`.venv/bin/python scripts/run_tests.py tests/test_editor_assets.py tests/test_project_contract.py` 75/75 通过。对应 `result.json` 分别为 `.artifacts/checks/20261114T030138Z-35b213e1/`、`20261114T030140Z-a9fa7de2/`、`20261114T030140Z-13e80dd1/`；以上均从 `python3 scripts/run_check.py --timeout 180 --` 启动。
- 更新人工核对清单，格式校验、生成、Chromium 载入及截图自查通过（`.artifacts/checks/20261114T030347Z-bdc0b9e0/`、`20261114T030355Z-3ceca418/`、`20261114T030411Z-cc3ba45c/`）。本工作树不存在根规则所列 `tools/TOOL_PAGE_GUIDE.md`，未修改工具模板或手写 HTML。
- 本轮修改：`web/editor/cues/editor-wiring-edit-shortcuts.js`、`web/editor/state/editor-state.js`、`web/editor/io/editor-project-load.js`、`tests/e2e/custom-shortcuts.spec.mjs`、`tests/e2e/timed-text-edit.spec.mjs`、`tests/test_editor_state.mjs`、`CHANGELOG.md` 与本目录账本和清单；保留全部先前 WIP。未下载、安装、执行 setup hooks、删除、提交、推送、建 PR 或合并。待 Hermes 独立复审，真实系统保存对话框及其他平台的原生按键仍未验证。


## 模态组合键全面复核与旧会话测试（2026-11-14）

| 问题 | 状态 | 处理 |
| --- | --- | --- |
| Shift+Delete / Backspace 模态穿透及其他修饰键 | 已修复 | 原生 dialog 与拆分弹窗四项红测均发生背景字幕删除；共享投影对模态内除 Escape 外的按键统一屏蔽背景消费者，不修改或阻止弹窗原始事件；额外保护字词选择、ASS 拖拽及行内编辑捕获层。 |
| 会话状态 spec 使用旧数据结构 | 已修复 | 使用 v2 主、副、叠加轨夹具和主轨访问；保留保存、未保存态、高亮、并发、导入修复等断言，7/7 通过。 |
| F2 偶发缺少 POST | 仅说明 | 同环境 10 次复现 3 次，失败截图显示文本框仍聚焦；打开弹窗的 50ms 自动聚焦可能与测试的按钮聚焦竞争，等待初始聚焦并断言实际 F2 目标后 10/10 通过，但不能断言唯一成因。 |

红测：`.artifacts/checks/20261114T031042Z-6118ef87/result.json`，4/4 失败，exit 1。

- 已逐项核对 `resolveEvent` 的所有消费者：播放 Space/J/K/L 接受 Shift，删除 Delete/Backspace 接受 Shift，A/D/W/S 与方向键有 Alt/Shift/Mod 派生，历史撤销与重做有 Ctrl/Meta、Shift 等组合；其余拆分、绑定、合并、选色、选区、定位、创建、工具、保存和预览通过同一全局投影接入。精确枚举已注册 chord 无法覆盖处理器接受的额外修饰键；现只对背景消费者的投影统一返回不可识别键，原始事件保留给弹窗，Escape 留给现有关闭逻辑。矩阵覆盖 29 个键各 16 个 Ctrl/Meta/Alt/Shift 组合，单测 `tests/test_editor_shortcuts.mjs` 28/28 通过（`.artifacts/checks/20261114T031311Z-fccffe9e/result.json`）；矩阵修复前失败（`.artifacts/checks/20261114T031221Z-0a04bdd3/result.json`）。
- 原生 dialog 和拆分弹窗 Shift+Delete / Shift+Backspace 四项真实红测均发生 6→5 条字幕；修复后四项与此前 J/K/L 两项共 6/6 通过，弹窗仍接收原事件，关闭后 Shift 删除仍生效（`.artifacts/checks/20261114T031318Z-baf2db72/result.json`）。字词选区捕获层单独回退对照时 C 未到达拆分弹窗，恢复后测试通过（红 `.artifacts/checks/20261114T031832Z-86bd36fb/`；绿 `.artifacts/checks/20261114T031756Z-4bfced4d/`）；字词选择、上下文菜单与父字幕保护相关 4/4 通过（`.artifacts/checks/20261114T031933Z-73df5ab1/`）。
- 旧会话用例最初旧字段导致服务器拒绝 v2 的 `preserve_punctuation`（`.artifacts/checks/20261114T031408Z-6df025ca/`）；后续六项通过，最后导入用例先因旧格式迁移本身为脏、再因报错路径从 `$.segments` 改为 `$.tracks[0].segments` 失败。将测试输入及断言改为规范 v2 后，完整 7/7 通过（`.artifacts/checks/20261114T031709Z-0e624710/`），没有省略原有保存、竞态、撤销、导入修复断言。
- F2 同环境连续 10 次：7 通过、3 失败（`.artifacts/checks/20261114T031441Z-ce544ed1/`）；失败 trace 最后一帧可见文本框聚焦，打开纯文本编辑器的源码还有 50ms 延迟自动聚焦。测试等待该初始聚焦、随后聚焦按钮并断言 F2 实际 target 和 activeElement 均为按钮，再次连续 10/10 通过（`.artifacts/checks/20261114T031701Z-db3b5408/`）。这是基于轨迹和时序的可能解释，首次 F2 失败的唯一成因仍未证实。
- 进一步对播放捕获层做真实回退对照：原生 dialog 中 Shift+Space 在旧精确匹配逻辑下未到达 dialog、调用一次播放器 play 且播放器不再暂停（`.artifacts/checks/20261114T032229Z-eee01dbb/result.json`）；恢复新投影并重建后，Shift+Space 与字词选区隔离共 2/2 通过（`.artifacts/checks/20261114T032305Z-be7dcf1b/result.json`）。不把此行为推及未在浏览器覆盖的全部键。
- 六份完整受影响 spec 以 Node 26.12.1、原有 Chromium、`MAW_E2E_KEEP_ARTIFACTS=1` 和单 worker 运行：`python3 scripts/run_check.py --timeout 600 -- node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs tests/e2e/custom-shortcuts.spec.mjs tests/e2e/timed-text-save-shortcuts.spec.mjs tests/e2e/timed-text-edit.spec.mjs tests/e2e/v2-migration-save.spec.mjs tests/e2e/editor-i18n-save.spec.mjs tests/e2e/editor-session-state.spec.mjs --workers=1 --output=.artifacts/shortcut-modal-full-20261114 --trace=on`，96/96 通过（`.artifacts/checks/20261114T031921Z-fc058b63/result.json`）；原 92 项失败记录保留，前次未运行的六项均已实际执行。
- 扩大审计运行 onboarding、ASS 拖拽和 keyboard-timing 受影响用例共 10 项：8 通过、2 失败（`.artifacts/checks/20261114T031950Z-16c9131c/result.json`）。一个测试仍尝试将合并设为 `Mod+C`，在此前明确的系统复制保留策略下遭拒而未进入复制断言；另一个在教程跳过/重开后对帮助页标签的七项旧列表断言失败，实际为 11 项。未修改这两个其他测试，也未将该组声称为全绿。
- 最终 Node 26.12.1 相关单元与装配 85/85（`.artifacts/checks/20261114T032329Z-22e3a087/`）、bundle fresh（`20261114T032320Z-c5a5f561/`）、TypeScript（`20261114T032330Z-50fea312/`）通过。清单格式、生成及浏览器截图检查通过（`20261114T032400Z-158d063b/`、`20261114T032408Z-8dbab8d1/`、`20261114T032418Z-cec962c9/`）。
- 本轮实际修改：`web/editor/cues/editor-shortcuts.js`、`web/editor/cues/editor-word-timing.js`、`web/editor/styles/editor-wiring-ass-cue-position.js`、`web/editor/media/editor-wiring-keyboard-guards.js`、`tests/e2e/custom-shortcuts.spec.mjs`、`tests/e2e/word-timing.spec.mjs`、`tests/e2e/editor-session-state.spec.mjs`、`tests/e2e/timed-text-save-shortcuts.spec.mjs`、`tests/test_editor_shortcuts.mjs` 与本目录账本和核对清单。旧会话 fixture 改为 v2，原有未提交更改和 `.pnpm-store/` 保留；未安装、下载、删除、提交或推送。
- 补记：`CHANGELOG.md` 的现有快捷键条目合并了弹窗不误操作背景的用户可感知结果。最终 Python 工程契约及编辑器资源测试 75/75（`.artifacts/checks/20261114T032522Z-a9c66ade/`）、个人路径检查（`20261114T032523Z-9a73dadb/`）和 `git diff --check` 通过。模态识别范围为现有 `dialog[open]`、`.modal-mask.show` 和上下文菜单；非模态浮窗、嵌套弹窗层叠及非 Chromium 系统浏览器的完整交互未逐项穷举，需保留人工核验边界。


## 第三轮独立复审与扩展测试（2026-11-14）

| 问题 | 状态 | 处理 |
| --- | --- | --- |
| 字幕文字编辑态自定义 Mod+E 保存 | 已修复 | 主字幕行内与字幕面板真实按键均会多发保存请求；字幕编辑上下文改绑保存/另存为不再投影为全局保存，原物理事件可供本地输入，物理 Mod+S 保留。普通文本输入框的既有改绑单测不变。 |
| 纯文本保存时工程忙碌无反馈 | 已修复 | 加载、保存、检查点三种状态均提示草稿未应用或保存并重试；真实挂起服务器保存期间验证草稿与请求隔离，先前请求结束后重试成功。 |
| Mod+C 与帮助页旧测试 | 已修复 | Mod+C 按系统复制保护拒绝，改以允许的 Mod+E 改绑后保留真实复制检查；帮助目录及批量处理文案按当前正文核对。 |

使用已有 Node 26.12.1 和现有依赖，保留全部既有工作及产物。

- 修复前浏览器 5/5 失败（`.artifacts/checks/20261114T033051Z-1e745a51/result.json`）：两种字幕编辑态各多发一次 POST，三个忙碌状态无提示。修复后首轮 3/6 通过，其余三项实际已出现英文警告但断言 `not saved` 与原文 `not applied or saved` 不连续（`.artifacts/checks/20261114T033352Z-a6d95232/`）；修正测试文本后 6/6 通过（`.artifacts/checks/20261114T033506Z-f5ea3560/`），含真实挂起的服务器保存和重试。快捷键单测 29/29 通过（`.artifacts/checks/20261114T033353Z-fdf94ac8/`），覆盖主/副字幕与面板及保存/另存为改绑，同时保留普通输入框旧契约。

- 副字幕行内真实浏览器对照：临时撤去本轮守卫并重建后多发保存，测试失败（`.artifacts/checks/20261114T034023Z-13e5b17d/`）；恢复并重建后通过（`.artifacts/checks/20261114T034059Z-e94c770a/`）。检查点文件选择器实际保持挂起期间显示提示，取消后重试保存成功（`.artifacts/checks/20261114T033615Z-76260ff3/`）；选择器由测试模拟。
- 两项旧扩展测试：原 Mod+C 改绑被既有系统复制保护拒绝；先断言拒绝，再改绑允许的 Mod+E，继续检验物理 Ctrl+C / Meta+C 原生复制及字幕不变。帮助页测试更新为现有目录和字幕处理文案，保留导航和内容断言；初次修正目录后仍暴露旧文案（`.artifacts/checks/20261114T033504Z-fe2d34c0/`），随后两项均通过（`.artifacts/checks/20261114T033617Z-a01e9347/`）。
- 使用已有 Node 26.12.1，全部测试通过 `python3 scripts/run_check.py --timeout 180 --` 包装（下列浏览器命令超时为 600 秒，设置 `MAW_E2E_KEEP_ARTIFACTS=1`、`MAW_E2E_PYTHON=$PWD/.venv/bin/python`）：
  - `node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs tests/e2e/{custom-shortcuts,timed-text-save-shortcuts,timed-text-edit,v2-migration-save,editor-i18n-save,editor-session-state}.spec.mjs --workers=1 --output=.artifacts/review3-full-20261114 --trace=on`：103/103，见 `.artifacts/checks/20261114T033733Z-181742c5/`；副字幕新增回归在该次全套后单独通过。
  - `node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs tests/e2e/onboarding.spec.mjs tests/e2e/keyboard-timing.spec.mjs --workers=1 --output=.artifacts/expanded-stale-tests-final-20261114 --trace=on -g 'quick start can be skipped and replayed|physical Ctrl.C and Meta.C preserve native copy'`：2/2，见 `.artifacts/checks/20261114T033617Z-a01e9347/`。
  - `node --test tests/test_editor_shortcuts.mjs tests/test_editor_commands.mjs tests/test_editor_state.mjs tests/test_project_save_state.mjs tests/test_tracks_project_save.mjs tests/test_timed_text_report.mjs tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs`：86/86，见 `.artifacts/checks/20261114T033806Z-8dc0a784/`。
  - `.venv/bin/python scripts/run_tests.py tests/test_editor_assets.py tests/test_project_contract.py`：75/75，见 `.artifacts/checks/20261114T033803Z-d6dc4c44/`；`node node_modules/typescript/bin/tsc -p web/tsconfig.typecheck.json` 通过，见 `.artifacts/checks/20261114T033805Z-e692ebcc/`。
  - 最终重建后 `node scripts/build-editor.mjs --check` 通过，见 `.artifacts/checks/20261114T034117Z-bcf73dd7/`；核对清单格式检查与本地 HTML 浏览器自查通过（`.artifacts/checks/20261114T033842Z-1aeef6a7/`、`.artifacts/checks/20261114T033900Z-ba8684a1/`）。
- 边界：仅 macOS Chromium 实测，系统文件选择器为模拟；加载繁忙由实际加载状态标志模拟，尚未验证真实加载成功并切换工程后的旧草稿行为。尚待维护者按核对清单人工验证；未下载安装、提交或推送。

## Shift 修饰键派生复审（2026-11-14）

| 项目 | 状态 | 处理 |
| --- | --- | --- |
| J/K/L 改绑后的 Shift 变体 | 已修复 | 原处理器明确接受大小写且仅排除 Ctrl、Alt、Meta；默认 Shift+J/K/L 的真实播放速率操作通过浏览器实证，历史实现没有明确写出该行为的产品设计说明。改绑时派生 Shift 组合到同一动作，旧物理键失效并参与冲突检查。 |
| Shift+Space 与 Shift+Delete/Backspace | 已修复 | 空格与删除消费者同样允许 Shift；派生组合随改绑迁移，参与冲突检查。带 Shift 的已有绑定与等效双别名保持有效，新增派生冲突的已保存配置提示并回退冲突项。 |
| 其他消费者修饰键盘点 | 仅说明 | 方向键的八类动作及贴合 Alt 派生、导航选择与 Alt 派生、拆分三种动作已有独立命令或派生；Home/End、上下轨道及多数字幕动作明确拒绝额外修饰键。撤销/重做消费者未排除 Alt，重做还接受 Mod+Shift+Y：这些未登记组合在改绑后不随之迁移，属于代码审计发现的潜在相同问题，尚未做浏览器实证或确定是设计语义；涉及系统组合的取舍待复审，不擅自扩展拦截。 |

- 浏览器修复前 `.artifacts/checks/20261114T034928Z-9972b0f5/`：默认 Shift+J/K/L 通过后，Shift+F2 未执行，另一用例未拒绝冲突；`.artifacts/checks/20261114T035025Z-8a7bf825/`：默认 Shift+Space 执行播放和暂停，改绑后的 Shift+F7 未播放。
- 修复后真实 Chromium 浏览器三个用例 3/3（`.artifacts/checks/20261114T035120Z-016f8b28/`），包括 J/K/L、空格和删除旧键停用、新键动作及派生冲突；Node 26 快捷键单测 32/32（`.artifacts/checks/20261114T035334Z-e72c7884/`）覆盖旧存储冲突恢复与等效别名。
- 系统修饰键行为和跨平台浏览器尚未实测；更早的播放与保存手工核对项仍待维护者确认。

- 最终构建完整快捷键浏览器套件：`node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs tests/e2e/custom-shortcuts.spec.mjs --workers=1 --output=.artifacts/shift-variants-final --trace=on` 经 `python3 scripts/run_check.py --timeout 600 --` 包装，Node 26 / 本地 Python、保留测试产物：36/36（`.artifacts/checks/20261114T035420Z-2fe13fca/`）；最终 `node scripts/build-editor.mjs --check` 和 `node node_modules/typescript/bin/tsc -p web/tsconfig.typecheck.json` 通过（`.artifacts/checks/20261114T035432Z-a012518a/`、`.artifacts/checks/20261114T035435Z-46f42fbd/`）。
- 扩展执行 custom-shortcuts、keyboard-timing、timed-text-save-shortcuts 三个 spec 合计 110 项：91 通过、19 失败（`.artifacts/checks/20261114T035145Z-9332778f/`）。运行中为修正旧配置等效别名重建过 bundle，该次不能作为单一构建的完整通过证据；其中一次 F2 保存请求计数失败在最终完整快捷键套件重跑通过，其余 18 项属于 keyboard-timing，涉及选择器多匹配、时序/位移断言、波形操作和 8 项帧偏移撤销后出现 `_dirty` 字段。
- 在最终构建无并行浏览器套件时定向重跑其中三项，三项仍失败（`.artifacts/checks/20261114T035519Z-7279251b/`）：WASD 播放时选中节点有两个，边界 A/D 的 currentTime 为 5 而非大于 24，帧偏移撤销后实际结构多 `_dirty: true`。尚未对照本次修复前的相同源码验证，不能声称已有失败或判定根因；其余失败也未逐一定位，需要后续独立排查。

## 时间轴失败对照与撤销重做修饰键（2026-11-14）

| 问题 | 状态 | 证据与处理 |
| --- | --- | --- |
| 上轮 18 项时间轴失败 | 已修复 | 使用相同 Node 26.12.1、本地 Python、依赖和夹具，仅临时移除上一轮 Shift 派生四处改动、重建 bundle 逐项对照，18/18 仍失败（`.artifacts/checks/20261114T040133Z-245b4d5d/`）；恢复原源码及 bundle 后，补齐无 ID 测试字幕的稳定 ID、修正 macOS 多选修饰键，并将撤销高亮与完整工程内容分开断言，18/18 通过（`.artifacts/checks/20261114T040555Z-c5479c5a/`）。这证明这些失败不以该轮 Shift 派生改动为必要条件，不代表它们在其他版本或不同环境下必然存在。 |
| 撤销/重做多余修饰键 | 已修复 | 浏览器先证实默认 Ctrl+Alt+Z、Ctrl+Shift+Y、Ctrl+Alt+Shift+Y 确实操作真实字幕历史，随后四种改绑组合全部失败（`.artifacts/checks/20261114T040311Z-f8425284/`）。将 Alt 撤销/重做以及 Shift/Alt+Shift 重做变体随改绑派生并参与冲突检查后，四种实际内容回归均通过（`.artifacts/checks/20261114T040417Z-05cb5bdb/`）；跳过系统保留派生组合，不增加对系统键的拦截。 |

18 项按名称逐项归类：

- 播放导航（3）：`WASD during playback follows the playhead instead of the last selected cue`、`A/D at the outer cue boundaries still seeks the boundary cue`、`I/O seeks the current cue boundaries and stays paused`；无 ID 时不同字幕都被标记为同一选择，补 ID 后通过。
- 时间偏移（2）：`selected arrow keys move cues, adjust boundaries, and honor the configured step` 因无 ID 选择对象错误；`advanced time offset moves selected cues atomically and rejects bounds or collisions` 的 macOS Ctrl 点击打开上下文菜单并遮挡下一次点击，按平台改用 Meta 多选后通过；保留偏移、碰撞与原子性断言。
- 帧偏移（8）：`advanced frame offset accepts positive/negative rounded touching boundaries at 30/29.97 FPS`，各含主字幕和绑定副字幕两种情形；时间、帧、字词、绑定与未改字幕的完整比较保留，撤销后的 `_dirty` 是按 ID 保留的会话高亮，另行明确断言受影响主/副字幕高亮。
- 波形和吸附（5）：`automatic adjacent snapping is on by default and Alt temporarily disables it`、`dual mode links both edges via the seam zone while side handles trim independently`、`selected cue group reflows fragments into the next waveform row while dragging`、`explicit Shift snapping remains available when automatic adjacent snapping is off`、`Shift+arrow keys snap selected subtitle boundaries to neighbors`；主夹具及重排夹具缺少 ID，补齐后真实拖动和吸附断言通过。

中间验证 `.artifacts/checks/20261114T040439Z-fe4c8588/` 为 8/18，尚有一个 macOS 多选、八个高亮比较和一个重排夹具失败，后续针对这些问题修正并通过，不将中间结果记作通过。Node 26 相关单元测试 91/91（`.artifacts/checks/20261114T040643Z-97512c4a/`），bundle 新鲜度与类型检查通过（`.artifacts/checks/20261114T040642Z-73ac6c20/`、`.artifacts/checks/20261114T040640Z-be627f9d/`）。

- 扩展三份浏览器套件的第一次完整复跑为 113/114（`.artifacts/checks/20261114T040643Z-6312bbfd/`）：补齐稳定 ID 后字词选区测试的先前“无选中字幕”期望变为实际选中第 2 条；更新该状态断言，保留修饰键投影、选中状态、字词选择及字幕未误合并的断言。

- 最终受影响浏览器套件 `node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs tests/e2e/custom-shortcuts.spec.mjs tests/e2e/keyboard-timing.spec.mjs tests/e2e/timed-text-save-shortcuts.spec.mjs --workers=1 --output=.artifacts/history-timing-final2 --trace=on`，经 `python3 scripts/run_check.py --timeout 600 --` 包装并使用 Node 26.12.1、本地 Python，114/114（`.artifacts/checks/20261114T040830Z-1aa910b4/`）。之后将八项帧偏移的高亮排除收窄为仅轨道和字幕的 `_dirty`，字词内部字段继续完整比较，单独重跑 8/8（`.artifacts/checks/20261114T041009Z-60fe3edb/`）。
- 保留系统组合的派生有意不接管：例如重做绑定 F4 时 Alt+F4 不派生，也不阻止原始事件；相应单测 34/34（`.artifacts/checks/20261114T040732Z-0b3ff39a/`）。平台限制：真实浏览器为 macOS Chromium，未实测其他系统及系统级组合本身；人工核对仍待维护者进行。

## 维护者决定：系统快捷键与非纯文本模态（2026-11-14）

以下决定覆盖本账本中此前关于系统保留键的历史结论。

| 条目 | 状态 | 事实、决定及处理 |
| --- | --- | --- |
| 可能被系统或浏览器使用的组合 | 已修复 | 维护者决定允许绑定；设置后明确提示事件可能被系统或浏览器截获，不能保证编辑器收到。Ctrl/Cmd+R、F5 等刷新组合还显示可能刷新页面，绑定重开后仍显示风险标记；编辑器内部真实冲突仍拒绝。原始移植 `f1be35d3` 已限制 Mod+R 和裸 F5，Mod+H 是 `87901225` 新增限制，不能笼统说三者皆源于最初移植；原决策对 Cmd+Space 和 Cmd+Shift+3 的允许不单独证明其他键应如何处理。 |
| 非纯文本弹窗 Ctrl/Cmd+S | 仅说明 | 维护者决定维持阻止浏览器页面保存和背景工程保存，保留模态事件传播；纯文本弹窗仍先应用再保存。此前移植前默认监听拦截浏览器并保存工程，HEAD 常规模态默认绑定仍会走保存监听，旧改绑键则阻止默认；当前其他模态既不发工程保存也阻止浏览器保存。 |
| 三项字词扩展测试旧断言 | 已修复 | 修订前 209 项中两项撤销后高亮字段与旧快照不符，另一项旧工程实际进入 v2 另存为而夹具只模拟旧句柄；明确断言高亮、保留其余所有字幕和字词字段的精确比较，并模拟空新文件的另存为选择器，校验 v2 主轨真实载荷和后续编辑态。三项重跑 3/3（`.artifacts/checks/20261114T042429Z-7b7ba010/`），不将原始 206/209 失败抹去。 |

- 真实浏览器红测 5/5 失败（`.artifacts/checks/20261114T041952Z-3b19d021/`）：Ctrl+H / Ctrl+R / F5 无法录入，Ctrl+Space / Ctrl+Shift+3 虽可录入但没有新约定的提示；修复后 5/5 通过（`.artifacts/checks/20261114T042125Z-7f2f7d5b/`）。模拟浏览器按键只证明事件到达页面后的行为，不能证明系统允许真实物理按键到达。
- 真实 Chromium 英文提示、刷新标记、内部冲突 1/1（`.artifacts/checks/20261114T042528Z-ad1275c3/`）；中文和英文均使用持久说明，页面相邻区块实测间距至少 8px，英文截图已自查。旧的 `Mod+H` / `F5` / `Mod+C` 和无关配置一起重载并在修改其他项后保留（`.artifacts/checks/20261114T042658Z-da2426a2/`）。
- 修改前扩大套件十份 spec 共 209 项，206 通过、3 失败（`.artifacts/checks/20261114T041440Z-a5ccd73a/`）；只读基线与未跟踪文件盘点见 `.artifacts/predecision-audit-20261114/REPORT.md`。`tests/e2e/timed-text-save-shortcuts.spec.mjs` 是实际保存回归候选，`tests/e2e/modal-save-investigation.spec.mjs` 为两项调查探针，`.pnpm-store/v11/index.db` 为本地索引；均保持未跟踪，待维护者决定纳入范围。
- Node 26.12.1 相关单元 91/91（`.artifacts/checks/20261114T042731Z-263a9013/`），编辑器资源及工程契约 74/74（`.artifacts/checks/20261114T042734Z-bc9fd244/`），TypeScript（`.artifacts/checks/20261114T042731Z-65e62b05/`）、bundle 新鲜度（`.artifacts/checks/20261114T042730Z-2c443f3b/`）、人工清单格式检查（`.artifacts/checks/20261114T042729Z-c7031363/`）均通过。未运行会删除临时文件的全量 Node/Python 项目；未下载、安装、提交或推送。

- 最终十份受影响 Chromium spec **215/215**（`.artifacts/checks/20261114T042727Z-f269545a/`），命令为 `node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs tests/e2e/custom-shortcuts.spec.mjs tests/e2e/keyboard-timing.spec.mjs tests/e2e/timed-text-save-shortcuts.spec.mjs tests/e2e/modal-save-investigation.spec.mjs tests/e2e/editor-session-state.spec.mjs tests/e2e/timed-text-edit.spec.mjs tests/e2e/v2-migration-save.spec.mjs tests/e2e/editor-i18n-save.spec.mjs tests/e2e/word-timing.spec.mjs tests/e2e/onboarding.spec.mjs --workers=1 --output=.artifacts/system-decision-final-20261114 --trace=on`，经 `python3 scripts/run_check.py --timeout 900 --` 包装、使用已有 Node 26 和 Python 并保留测试产物。
- 上述整组后将字词选区复制用例加强为合并实际绑定 `Mod+C`，确认 Ctrl/Meta+C 原事件未取消、当前平台原生 copy 派发且字幕不合并（1/1，`.artifacts/checks/20261114T043150Z-d9adeee9/`）；系统键补充 Ctrl 与 Meta 两类事件，9/9（`.artifacts/checks/20261114T043215Z-83e36063/`）。自动化在 macOS Chromium 发送的键盘事件不证明操作系统允许用户物理快捷键透传。
- 人工清单最终检查 `.artifacts/checks/20261114T043023Z-2f954d54/`、HTML 生成 `.artifacts/checks/20261114T043023Z-6cf04229/`、浏览器截图 `.artifacts/checks/20261114T043035Z-59acdf91/` 均通过并已自查；个人路径检查 `.artifacts/checks/20261114T043023Z-fe40ca80/` 和 `git diff --check` 通过。`blank-editor.html` 未重生成，内联副本待发布前统一重生成。


## 方向键冲突与维护者决定（2026-11-14）

| 条目 | 状态 | 事实与处理 |
| --- | --- | --- |
| 方向键分配与迁移 | 已修复 | Moy 决定方向键及组合保留给原有方向键操作，不得给其他命令；即使原绑定已清除，也拒绝录入。逐项检查加载的旧配置，忽略不符合规则的绑定并以中英文提示，保留其余有效配置。可自定义原方向键命令为非方向键，默认方向键及其既有派生组合不变。 |
| 预览及设置局部方向键 | 已修复 | ASS 字幕框／坐标面板、普通字幕／表情预览框和设置／帮助标签聚焦时，局部处理获得真实物理方向键，全局消费者不处理同一事件。普通输入、原生菜单及拆分弹窗已有相应输入或模态保护。 |

- 原始 Chromium 探针真实聚焦并选择字幕：删除绑定 ArrowUp 时，普通预览一次按键同时移动并删除字幕，设置标签一次按键同时切换标签并删除字幕；ASS 局部焦点下不同全局命令有不同捕获顺序，详见本地 `.artifacts/ass-shortcut-audit-20261114/REPORT.md`。新录入红测旧代码失败（`.artifacts/checks/20261114T050039Z-88260538/`）；修复后中英文录入及迁移、ASS／普通预览／设置焦点实测 3/3（`.artifacts/checks/20261114T050235Z-dfd88008/`）。暂时关闭焦点守卫后，普通预览方向键回归失败（`.artifacts/checks/20261114T050302Z-824b2fc6/`），随后已恢复守卫并重建 bundle。
- Chromium 仅证明当前环境和已覆盖焦点；未逐项人工验证其他系统、所有浮窗和实际系统级按键。既有工作树 WIP 与未跟踪文件保留，未下载、安装、删除、提交或推送；内联副本待发布前统一重生成。

- 补充迁移边界：旧值 `delete=["ArrowUp","F2"]` 初版整条丢弃（真实浏览器红测 `.artifacts/checks/20261114T050549Z-4b1a08e0/`）；最终只忽略非法方向键，保留 F2 并实证 F2 删除（四项定向 Chromium 4/4：`.artifacts/checks/20261114T050634Z-02623526/`）。
- 完整三份受影响 Chromium 套件 `custom-shortcuts`、`ass-cue-position`、`keyboard-timing` 在上述迁移边界细化之前 122/122（`.artifacts/checks/20261114T050346Z-e06be917/`）；最终代码完整快捷键套件 53/53（`.artifacts/checks/20261114T050654Z-1a2c9206/`）。Node 26 最终快捷键、状态、保存和装配测试 95/95（`.artifacts/checks/20261114T050639Z-64efb3e4/`）；最终类型检查（`.artifacts/checks/20261114T050635Z-21dd9397/`）及 bundle fresh（`.artifacts/checks/20261114T050635Z-08711b02/`）通过。清单格式（`.artifacts/checks/20261114T050443Z-2c38c6cf/`）与个人路径检查（`.artifacts/checks/20261114T050445Z-1c473686/`）通过；清单 HTML 未重新生成，因为其生成器会删除临时文件，本轮禁止删除。

## 独立盲审四项 minor（2026-11-14）

| 条目 | 状态 | 核实与处理 |
| --- | --- | --- |
| 旧系统保留键错误分支 | 已修复 | 当前校验不会产生两类系统保留冲突错误；浏览器存储只保存命令到按键数组，不保存错误文案。移除不可达错误解析及对应英文映射，保留已保存系统键的迁移覆盖。 |
| 无文本修改时保存失败提示 | 已修复 | `unchanged` 实际不会进入“编辑已应用”提示，但原逻辑在保存取消时也不提示失败；现提示工程未保存或无法确认下载，不称编辑已应用，并保留纯文本窗口。 |
| 快照过期时保护草稿 | 已修复 | 草稿仍保留，但旧提示直接要求关闭重开；新中英文提示先复制需要保留的草稿再关闭重开。 |
| 自定义模态 Escape 穿透 | 已修复 | 真实浏览器复现背景设置、导出菜单、帮助、空隙工具、右键菜单和波形强制拆分重试受影响；记录按键开始时模态状态，下一次 Escape 仍能正常关闭背景。 |

红测 `.artifacts/checks/20261114T053126Z-822c9939/`、`.artifacts/checks/20261114T053247Z-6abad9a5/`、`.artifacts/checks/20261114T053318Z-29e0428d/`；第一次修复后导出及右键菜单仍因同一事件内先关闭模态而失败（`.artifacts/checks/20261114T053424Z-db1217a6/`），记录事件开始时状态后定向 8/8 通过（`.artifacts/checks/20261114T053531Z-fef62019/`）。复现场景通过应用接口建立同时打开的页面状态，再用浏览器实际焦点与按键执行；不声称这些叠加状态均有普通鼠标入口。

旧全量 Node 对照日志的 17 个失败名称及顺序逐项比对一致，但都是不满足 engines 的 Node 22.23.1；失败涉及编译导入捕获、构建器未捕获导入及 watcher 构建失败退出，不能由此推断受支持 Node 26 的结果或一概判为本机环境问题。相关测试源码会执行 `rmSync`，受本轮禁止删除约束，未重跑。F2 旧复验 7/10 与等待初始聚焦后 10/10 的记录已回读，证据支持焦点竞争为可能解释，并不证明唯一根因。

扩展 Chromium 六份 spec 初次执行 144/149（`.artifacts/checks/20261114T053632Z-d2d96650/`）：ASS 导出 3 项未取到预期说话人标签，设置 2 项分别因 v2 工程携带旧 `split_mode` 拒绝及期待旧顶层字段失败。同一 Node 26、依赖、浏览器和测试文件的隔离 `0b9dd000` 快照中五项逐一均失败，分别落在相同的测试行和断言（基线运行 `20261114T054019Z-3dbad5cd`）；快照只为遵守禁止删除加入了与当前测试相同的保留临时目录开关，业务源码和五项测试未修改。此对照证明这些失败在该快照存在，不能单凭此证明根因或判定所有历史版本一致。

最终版本排除上述五项后，六份 Chromium spec 144/144（`.artifacts/checks/20261114T054112Z-6447998b/`）；这不是全部 149 项通过。无并行浏览器套件时 F2 保存用例再次重复 10/10（`.artifacts/checks/20261114T054338Z-4d39e5dd/`），旧失败仍不能确定唯一根因。最终 Node 26 快捷键、命令、状态、保存、焦点及脚本装配单测 98/98（`.artifacts/checks/20261114T054155Z-1f796f7d/`），类型检查、bundle 新鲜度、个人路径检查和人工清单格式均通过（依次 `.artifacts/checks/20261114T054202Z-3286b1a1/`、`.artifacts/checks/20261114T054154Z-7f3abbe6/`、`.artifacts/checks/20261114T054152Z-4dd11d6b/`、`.artifacts/checks/20261114T054228Z-37033279/`）。`modal-save-investigation.spec.mjs` 与 `timed-text-save-shortcuts.spec.mjs` 已单独暂存，`.pnpm-store/` 仍未跟踪；未提交、推送、下载安装或删除文件，待 Hermes 独立盲审。

## 字词选区与快捷键录入的键盘焦点（2026-11-14）

| 条目 | 状态 | 事实与处理 |
| --- | --- | --- |
| 字词捕获抢设置键盘操作 | 已修复 | 用户实际点击选中字词后，仅用 Tab 到全局设置；旧实现拦截 Enter 无法打开设置，Space 可进入后录入 B 又被拦截（Chromium 红测 `.artifacts/checks/20261114T055331Z-a4ab911e/`）。字词捕获先于设置录入监听器；现仅放行设置按钮的裸 Enter、设置标签方向键以及焦点位于正在录入/检索控件时的按键，活跃字词拖拽及非录入时的后台保护保持。 |

真实 Chromium 测试用 Tab/Enter/Space 进入设置，用方向键切换设置标签；验证 B 和 Enter 录入成功、Escape 取消录入、C 被按键检索而非合并，字词选区及内容保留；在尚未录入时 B 仍受字词保护。初步定向 3/3（`.artifacts/checks/20261114T055539Z-7712d790/`）；最终代码补充保留活跃字词拖拽保护后，完整回归结果见后续记录。

只读 `git ls-remote --heads origin refs/heads/2.0dev` 得到 `e358512e8fef890dd2e607c61ec5f522d13943a5`，与本地跟踪引用一致；当前 HEAD `8f79366dc152e7f7d834d9e7b25eec3ced1d0f78` 相对其前进 9 提交、落后 0，工作树另有未提交改动。两份新 E2E 测试仍仅已暂存，`.pnpm-store/` 未跟踪并保留；未提交、推送、下载、安装或删除。

补充边界：初版仅放行设置按钮的物理 Enter 时，若先将删除改绑 Enter，真实浏览器会删除背景字幕并阻止设置打开（红测 `.artifacts/checks/20261114T060044Z-83fde8ac/`）；随后在全局快捷键投影层对设置按钮的裸 Enter 抑制后台映射，按钮仍收到原事件。最终定向 4/4（`.artifacts/checks/20261114T060137Z-71804124/`），最终 Node 相关单测 130/130（`.artifacts/checks/20261114T060131Z-f673a2ba/`），类型检查和 bundle 新鲜度通过（`.artifacts/checks/20261114T060130Z-5a4ebe19/`、`.artifacts/checks/20261114T060128Z-46126418/`）。此前四份完整 Chromium spec 183/183（`.artifacts/checks/20261114T055647Z-1bb2a99f/`）是在设置按钮 Enter 投影补丁之前的结果，不能冒称最终代码全套通过。

字词与自定义快捷键完整 Chromium 107/107（`.artifacts/checks/20261114T060207Z-46bcc0a6/`）通过后进一步收窄字词监听器：只有正在录入/按键检索且无活跃字词拖拽时才让出事件；设置按钮 Enter 与标签方向键由全局局部按键投影保护。收窄后四项定向 Chromium 4/4（`.artifacts/checks/20261114T060517Z-8756850a/`）、Node 相关单测 130/130（`.artifacts/checks/20261114T060517Z-ad77a13b/`）、类型检查（`.artifacts/checks/20261114T060518Z-015e13e6/`）通过；完整浏览器最终结果另记。

最终收窄版本完整字词与自定义快捷键 Chromium 107/107（`.artifacts/checks/20261114T060559Z-30a4a85a/`）；最终 bundle 新鲜度、个人路径和清单检查通过（`.artifacts/checks/20261114T060854Z-714c8c86/`、`.artifacts/checks/20261114T060858Z-f8ea4313/`、`.artifacts/checks/20261114T060856Z-c4984203/`）。交付前再次只读确认远端 `2.0dev` 仍为 `e358512e`；两份新 E2E 文件暂存，其他未提交工作及 `.pnpm-store/` 保留。既有 5 项在隔离 `0b9dd000` 快照同样失败的扩展用例、Node 22 旧全量对照及本轮未运行的受支持 Node 全量限制见前一节，不能将定向通过表述成全部门禁通过；等待最终独立盲审和人工验收。

## 复制、粘贴与剪切保留键（2026-11-14）

| 条目 | 状态 | 事实与处理 |
| --- | --- | --- |
| 页面文字复制可能删除选中字幕 | 已修复 | 原可将删除绑定 `Mod+C`；Chromium 中文页面先选中字幕及文件名文字后，Ctrl+C 与 Meta+C 均取消默认行为并删除字幕（事件红测 `.artifacts/checks/20261114T061851Z-ea6f0ca1/`；数据红测 `.artifacts/checks/20261114T061916Z-ba22be1f/`）。Moy 随后明确更新决策：精确保留 Ctrl/Cmd+C、V、X 给原生操作，其余系统组合不额外禁用；该决策覆盖前述允许绑定这三组按键的记录。 |
| 录入、派生与旧配置迁移 | 已修复 | 录入时检查实际完整派生组合，中英文提示拒绝；旧配置逐项校验，丢弃无效项并提示，保留同命令有效备用键及其他命令。仅保留精确 `Mod+c/v/x`；`Mod+Shift+c`、`Mod+Alt+v` 等仍按既有冲突规则处理。撤销、重做和全选默认绑定不变。 |
| 字词拖拽中的剪贴板键 | 已修复 | 活跃字词拖拽中原 Ctrl/Meta+V、X 被捕获层 `preventDefault`（红测 `.artifacts/checks/20261114T062638Z-94f7b728/`）；现三组精确物理剪贴板键均保留默认行为和拖拽，同时继续阻止后台命令。 |

录入策略红测 `.artifacts/checks/20261114T062400Z-23b0a912/`；修复后定向真实 Chromium 9/9（`.artifacts/checks/20261114T063108Z-32a0e580/`）及鼠标拖选与额外旧配置迁移 2/2（`.artifacts/checks/20261114T063140Z-41c53560/`）。浏览器对 macOS 当前原生组合读取剪贴板确认页面选中文字，输入框真实剪切后粘贴恢复文本；另实测 Ctrl 和 Meta 的非折叠页面选区、无选区、字词选区与字词拖拽键盘事件。非当前系统的另一修饰键只检查事件和字幕状态，不能据此声称跨系统原生剪贴板测试。Node 26.12.1 定向测试 74/74（`.artifacts/checks/20261114T063104Z-9386658f/`），类型检查、bundle 新鲜度及清单检查通过；最终完整浏览器回归结果见后续记录。未下载、安装、删除、提交或推送，等待独立盲审和验收。

补充：旧配置的兄弟键还可能因其他命令的直接或派生冲突而被整条丢弃；单测红测 `.artifacts/checks/20261114T063422Z-a769b68a/`，现按冲突的实际来源逐项移除并保留兄弟键，Node 75/75（`.artifacts/checks/20261114T063453Z-136488a3/`）及 Chromium 真实迁移、后续保存和 F2 删除通过（`.artifacts/checks/20261114T063512Z-2476793e/` 的 10/10 定向组）。最终代码完整 `custom-shortcuts.spec.mjs` 65/65（`.artifacts/checks/20261114T063536Z-c36a5256/`）；此前完整快捷键与字词 113/113（`.artifacts/checks/20261114T063155Z-872a73d0/`）早于这次跨命令冲突细化，不能写成最终代码的两套完整通过。最终类型检查与 bundle 新鲜度分别为 `.artifacts/checks/20261114T063605Z-73f8e3ed/`、`.artifacts/checks/20261114T063552Z-63af4eff/`；人工核对清单格式检查 `.artifacts/checks/20261114T063253Z-1615b408/`。此前旧全量 Node 基线与扩展用例限制不因本轮定向回归而解除。

## 交付前完整门禁与英文界面旧断言（2026-11-14）

| 条目 | 状态 | 事实与处理 |
| --- | --- | --- |
| 英文界面测试沿用旧 Escape 假设 | 已修复 | 旧测试在右键菜单关闭后再次点击全局设置按钮，假定 Escape 也关闭背景设置；当前已明确修复为只关闭前景菜单，导致设置面板遮挡按钮。原测试在最终 Chromium 323 项中失败，同环境重复 5/5 失败；目标 `origin/2.0dev` 源码快照原测试通过。现保留英文菜单与语言切换断言，增加右键菜单真实打开、Escape 后菜单关闭及背景设置仍打开的断言，再使用现有 `openSettingsPage` 避免重复点击。 |
| 目标基线既有浏览器失败 | 仅说明 | 同一 Node 26.12.1、Chromium、Python 和现有依赖，`origin/2.0dev=e358512e` 源码快照上 5 项旧测试均在相同断言失败：ASS 导出 3 项及项目设置 2 项。不能将它们解释为本次全量通过，也不能仅凭同失败断定唯一根因。 |
| 禁止删除下的完整测试限制 | 阻塞 | 6 个 Node 文件及大量 Python 测试／测试运行器会删除临时文件；依照本轮禁止删除未执行这些删除路径。已运行无删除路径的 Node 全部文件及可安全筛出的构建测试，不能冒称完整 Node 或 Python 全通过。 |

14 份受影响 Chromium spec 初次运行 317/323，6 项失败，日志 `.artifacts/checks/20261114T064453Z-fd8b822e/`；同测试源码、同依赖的 `origin/2.0dev` 六项对照 5 失败、英文界面 1 通过（`.artifacts/delivery-origin-2.0dev-LwMQMyPn/.artifacts/checks/20261114T065130Z-08d92ce3/`）。快照仅为遵守禁止删除给测试 helper 加了保留临时目录开关；原业务源码及五项失败测试均为目标基线，测试文件与当前分支逐字节一致。英文界面旧测试当前分支重复 0/5（`.artifacts/checks/20261114T065157Z-177df685/`），更新测试后 5/5（`.artifacts/checks/20261114T065325Z-36ada772/`）且完整该 spec 17/17（`.artifacts/checks/20261114T065355Z-7d3c29f9/`）；将更新后的测试文件复制进旧源码快照后新增“背景设置仍打开”断言真实失败（`.artifacts/delivery-origin-2.0dev-LwMQMyPn/.artifacts/checks/20261114T065532Z-ba2728da/`），其前一次拷贝因路径错误未生效的对照不作为反向证据。

Node 26 无删除路径的 Node 文件 1412/1412（`.artifacts/checks/20261114T064410Z-483443ba/`），另外从含删除路径的文件选出的安全构建测试 23/23（`.artifacts/checks/20261114T065432Z-d569b5c8/`）；类型检查与 bundle fresh 分别通过（`.artifacts/checks/20261114T064533Z-99a43d29/`、`.artifacts/checks/20261114T064531Z-567ee417/`）。因盲审后新增测试代码修改，按维护者交付条件必须再次独立盲审；尚未提交、推送或创建 PR。
