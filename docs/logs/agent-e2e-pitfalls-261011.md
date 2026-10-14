# Agent 长周期修复的踩坑记录：e2e 像素验证体系与语义撤回（2026-10-11）

背景：PR #225 撤回 PR #205 中「副字幕锚定主字幕上方」的错误语义。撤回本身概念上很简单，
但落在 #207 建立的「Canvas / ASS 导出 / libass 实际画面三方像素级对照验证体系」上后，
变成了体系级适配。本篇记录反复踩到的坑与规避方法，供后续 Agent 的同类任务参考。

## 时间线概要

- 语义撤回 + 排布固定层：代码主体半天内完成，Node 322 / Python 1961 全绿。
- 之后约 2/3 的时间花在：e2e 像素断言的逐个适配（30+ 个断言建立在旧语义上）、
  修复脚本自身反复出错（见下）、以及每轮修改后的全量验证成本（单轮 e2e 1.5-9 分钟）。
- 复审 Agent 用 Node 直接调 `buildAssPayload` / `assStackFrame` 实证出 4 个
  单元测试没覆盖的场景缺陷（副字幕单独成片时 `\pos(0,0)`、双副字幕飞顶、
  无主时叠加重叠、`\t` 动画字号不一致），又一轮修复。

## 坑与规避

### 1. bash heredoc 会折叠反斜杠（本环境反复踩，最高优先级）

`bash -c <<'PYEOF'` heredoc 中的 Python 源码里，`\\n` 会折叠成 `\n`、`\\\\` 折叠成
`\\`，导致写入文件的 JS 代码丢失反斜杠：`\n` 变成真实换行（语法错误）、ASS 标签
`\\fs` 变成 `\fs` 被运行时吞掉（静默错误，更难发现）。同一脚本可能部分行正常部分行
损坏，非常迷惑。

规避：**凡是要写入含反斜杠内容的代码（正则、ASS 标签、转义序列），一律用 write
工具写独立补丁脚本（.mjs）再 `node` 执行**，不要用 bash heredoc 内联 python。
必须用 python 时，反斜杠全部用 `chr(92)` 动态拼接，字面量中不出现任何反斜杠字符。

### 2. patch 脚本的替换边界：自带闭合 + 保留原闭合 = 双闭合

用「标记行定位 + splice 替换」改代码时，若被替换范围以某层的最后一行结尾
（如循环体的最后一行），而新块末尾又自带该层的闭合 `}`，就会产生**双闭合**——
语法平衡（acorn PARSE OK），但函数提前结束，后续语句漂移到外层作用域
（本次表现为 `sharedStackCue` 标记段跑到模块顶层，运行时 `slices is not defined`）。

规避：splice 替换前先数清楚旧范围的「层数账」；更可靠的是替换后立刻用
`acorn.parse` 验证目标函数的 body 是否仍包含预期的末尾语句
（本次用 `node.body.end` 处的文本检查发现了漂移）。

### 3. 修改前先 `git diff` 核对基点：共享仓库的 main 会持续推进

worktree 基于 fetch 时的 origin/main 创建，长任务期间 main 又推进了 13 个提交
（含一个重建了同文件的大 PR）。直接 `git diff origin/main` 会把「别人新增的内容」
显示成「你删除的内容」，基线对照实验也会跑在错误的基线上。

规避：开工时记录基点 commit；收尾前 `git fetch` 并确认 `HEAD..origin/main`
的落后量，必要时 merge/rebase 后重跑受影响验证。基线对照实验（「这问题是不是
我引入的」）必须在**与被测分支相同的 commit** 上跑。

### 4. 语义撤回类任务：先清点「建立在旧语义上的验证资产」

撤回一个错误语义时，最大的工作量往往不是撤回本身，而是**后续 PR 在错误前提上
建立的验证体系**：#207 的像素级 oracle（Canvas vs libass 逐边对照、出画像素、
层叠顺序）全部以「副字幕在主上方」为前提。每改一处排布逻辑，就有 3-5 个像素断言
需要按新契约重写。

规避：动手前 `rg` 一遍验证目录里与该语义相关的断言数量，向维护者如实给出
「撤回 = 语义修复 + N 处验证适配」的工作量预估，并确认适配方向
（本次确认：像素精度类断言放宽容差即可，不追求与 libass 完全一致）。

### 5. 修复轮的失败要用行号精确定位，不要凭错误信息猜

本轮多次凭错误信息猜测失败原因（如「endsWith 失败疑似行尾 \r」），实际行号指向
的是**另一个断言**（Overlay 样式行的旧链式值 268 未更新）。Playwright JSON
reporter + 从 stack 提取 `spec.mjs:行号` 是准确定位的可靠手段。

### 6. git worktree 跑测试需要独立安装依赖

worktree 不共享主检出（untracked）的 `node_modules`，Playwright/acorn 等会
直接报 MODULE_NOT_FOUND。worktree 内 `pnpm install --frozen-lockfile` 一次即可；
Python 侧可只读复用主仓库 venv（`主仓/.venv/Scripts/python.exe` 直接指向
worktree 内的 scripts/run_tests.py 运行）。

## 结果

- 语义：副字幕固定在主字幕下方、位置跟随样式预设（排布计划固定层，
  不参与堆叠/组缩放/移动跟随）；叠加字幕固定锚定主字幕上方。
- 验证：test_editor_utils 322、syntax/order/waveform 64、Python 1961、
  stacking 33/33、multi-subtitle/ass-export/word-timing 全绿；
  存量失败 1 个（「uses the main cue-row layout」，origin/main 基线同样失败，另案）。
