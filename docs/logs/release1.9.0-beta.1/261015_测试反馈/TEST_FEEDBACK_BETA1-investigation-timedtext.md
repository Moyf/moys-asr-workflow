# 子代理调查报告：纯文本编辑模块（#8/#9/#10/#11）

只读子代理调查（2026-10-15），主会话抽查核对后并入账本
`TEST_FEEDBACK_BETA1.md`。报告原文保留如下；file:line 以核对时 HEAD `1d961b90` 为准。

## A — 拆句后时间范围 diff 显示错误（#10）

**结论：时间映射本身正确，是 `beforeStart/beforeEnd` 取值口径错误 —— structural 输出行的
「before」时间取自该输出行自己的 items 切片，而不是整条原字幕的范围。**

展示链路（每行 diff 的「时间范围」）：
- 逐行视图：`renderTimedTextEditRowDiff` 在 `web/editor/cues/editor-timed-text-edit.js:124-128` 拼出
  `时间范围：{beforeStart} – {beforeEnd} → {afterStart} – {afterEnd}`；右侧修改清单同款在
  `renderTimedTextEditChangeList`，`web/editor/cues/editor-timed-text-edit.js:210-215`。
- 拆句（structure valid）时行报告来自 outputRows：`timedTextEditDraftRowReports` 按 `draftIndex`
  映射（`web/editor/cues/editor-timed-text-edit.js:536-554`），`displayRows` 优先 outputRows（`:187-189`）。

「before 时间范围」的计算位置（根因）：
- `web/shared/utils/timed-text-edit.js:348-349`：
  ```js
  beforeStart: sourceSlice.items[0]?.start ?? Number(output?.start),
  beforeEnd: sourceSlice.items[sourceSlice.items.length - 1]?.end ?? Number(output?.end),
  ```
- `sourceSlice = timedTextStructureSourceSlice(source, meta.range)`（`:305`；函数定义 `:276-299`）
  只切出**该输出行覆盖的那段**原 items。
- 而输出行自己的 start/end 在 `buildTimedTextStructurePlan` 里恰好由同一切片边界决定：
  `web/shared/utils/timed-text-plans.js:388-394`（`start = firstLocal===0 ? source[first].start : items[0].start`、
  `end = lastLocal===sourceTokens[last].length ? source[last].end : items[last].end`）。
  于是 before==after==新行自己的范围。维护者案例 #24 显示 `33,870–35,150 → 33,870–35,150`、#25 同理，与此吻合。
- 文本的 before 已修过同类问题：`web/shared/utils/timed-text-edit.js:309-315`（注释明确说
  structural 行的 before 应展示整条原字幕），但时间字段没同步改。**修复位置就是 `:348-349`**：
  structural 行应改用整条原字幕的 `Number(source[sourceIndexes[0]]?.start)` /
  `Number(source[sourceIndexes[last]]?.end)`（`sourceIndexes` 在 `:306` 已有）。
  非 structural 行 `timingChanged: structural`（`:352`）为 false，不受影响。

拆句时间映射算法（验证映射正确）：
- 精确模式：逐行在原文 token 流顺序匹配 `findTimedTextTokenSequence`（`web/shared/utils/timed-text-plans.js:250-261`）。
- 锚点模式：`selectTimedTextAnchors` 全局 DP 选锚（`timed-text-plans.js:187-228`、调用 `:287`），
  未匹配行按字符占比线性插值 `start = previousSourceEnd + Math.round(sourceLength * targetOffset / targetLength)`（`:314-323`）。
- items 级复用：`retimeTimedTextSlice`（`timed-text-plans.js:35-53`）按原 item 字符长度重排文字并
  **原样保留 item 时间**；复用失败才走段级估算 `timedTextSegmentBoundary`（`:70-76`，同为线性占比）
  并标 `timingEstimated`（`:381-386`、`:396-412`）。
- 维护者案例的拆分点落在原 item 边界，两行时间来自真实 item 切片 → 映射正确，仅展示错误。

## B — 搜索框加 clear 按钮（#9）

**DOM 结构**（`web/editor-template.html`）：
- 容器 `.timed-text-edit-search`（`:2469`）→ 第一行 `.timed-text-edit-search-row`（`:2470`）：
  replace-toggle（`:2471`）、find 输入框 `#timed-text-edit-find`（`:2473`）、Aa `#timed-text-edit-case`（`:2474`）、
  `.*` `#timed-text-edit-regex`（`:2475`）、计数 `#timed-text-edit-search-count`（`:2476`）、
  上一条（`:2477`）、下一条（`:2478`）。注意 id 是 `timed-text-edit-find-*` 而非 `timed-text-edit-search-*`
  （计数/错误才是 search-count/search-error，`:2476/:2480`）。

**现有清空/重置路径**（`web/editor/cues/editor-timed-text-edit.js`）：
- 打开时全量重置：`openTimedTextEdit` `:1007-1011`（find/replace value=''、Aa/.* aria-pressed=false、
  `timedTextEditSearchIndex = -1`）。
- `refreshTimedTextEditSearch` `:390-416`：重算 matches、更新计数文本（`:404-407`）、经
  `renderTimedTextEditSearchMirror` 清空/重绘高亮（`:411`；无匹配时 `mirror.replaceChildren()` 即清空，`:370`）、
  移除行 `.search-current`（`:412-414`）。
- **加按钮的位置**：挂在 `:2470` 的 `.timed-text-edit-search-row` 内（flex 行，`web/editor.css:3373`），
  建议放 count 附近或紧贴输入框；handler 与现有 toggle 按钮接法一致（`editor-timed-text-edit.js:1050-1056`）：
  `timedTextEditFindInput.value = ''` → `refreshTimedTextEditSearch({ resetIndex: true })`，可选 `focus()` 回输入框。
- **现成参照**：主界面字幕列表搜索已有同功能 `.input-clear`/`.clear-x` 模式 —— 模板
  `web/editor-template.html:2120-2122`、接线 `web/editor/cues/editor-wiring-search-filter.js:81-86`、
  CSS `web/editor.css:817-830`（absolute 定位 × 覆盖输入框内，`has-value` 才显示）。
  若要视觉一致可直接复用这套 class 并按 `.timed-text-edit-search-row` 作用域补 CSS。

## C — 修改前/后移动到文本框右侧（#8）

**构建与插入**（`web/editor/cues/editor-timed-text-edit.js`）：
- diff 行构建：`appendTimedTextEditDiffLine` `:96-111`（`.timed-text-edit-diff-line` + `.timed-text-edit-diff-label`）。
- 注入：`renderTimedTextEditRowDiff` `:115-142`，写入 `rowElement.querySelector('.timed-text-edit-row-diff')`（`:116`），
  「修改前/修改后」在 `:121-122`，时间范围行 `:124-128`。
- diff 容器创建：`renderTimedTextEditRows` `:298-301` —— `main.append(textarea, diff)`，
  `main` 是 `.timed-text-edit-row-main`（`:291`）。

**布局结构**（`web/editor.css`）：
- `.timed-text-edit-row` 是 grid 两列：`grid-template-columns: minmax(92px,108px) minmax(100px,1fr)`（`:3464-3469`），
  col1=meta、col2=main。
- `.timed-text-edit-row-main`（`:3494`）是普通 block：textarea（`:3495-3501`，`width:100%`）在上，
  `.timed-text-edit-row-diff`（`:3533-3536`，`display:grid; gap:3px; margin-top:5px`）在下
  → 这就是「diff 行出现在文本框下方」的原因。

**移到右侧需要改哪里**：
- 前提：目前「修改前/修改后」「时间范围」「估算提示」「删除标签」全部追加进同一个
  `.timed-text-edit-row-diff`（`editor-timed-text-edit.js:120-141`）。需求只移修改前/后、时间范围另行处理
  → **需先在 JS 把 diff 行与 timing 行拆成两个容器**（如 `.timed-text-edit-row-diff` 与新的 timing
  容器分别 append 到 main）。
- 布局：把 `.timed-text-edit-row-main`（`editor.css:3494`）改为 flex/grid 两列（textarea + diff 并排），
  同时去掉 textarea 的 `width:100%`（`:3496`）改 flex-basis，并把 `.timed-text-edit-row-diff` 的
  `margin-top:5px`（`:3533`）换成列间距。
- 可复用的现成分栏样式：`.timed-text-edit-layout`（`:3447-3450`，`grid-template-columns: minmax(0,1fr) minmax(280px,340px)`）
  与 `.timed-text-edit-row` 自身的 grid（`:3464-3469`）；窄屏注意 `@media (max-width:900px)`（`:3442-3446`）
  目前只处理了 search-row。
- 右侧清单里的 `renderTimedTextEditChangeList`（`editor-timed-text-edit.js:201-229`）是独立渲染路径，
  若也要对齐需单独处理。

## D — 搜索框按钮样式不匹配（#11）

**模板位置与 class**（`web/editor-template.html`）：
- `.timed-text-edit-search-expand`（replace-toggle，`:2471`）、`.timed-text-edit-search-option`（Aa/.*，`:2474-2475`）；
  **上一条/下一条（`:2477-2478`）与单个/全量替换（`:2484-2485`）没有任何 class**，
  只被 `.timed-text-edit-search-row button` 命中。

**现有样式**（`web/editor.css`）：
- `:3380` `.timed-text-edit-search-row button { min-height:28px; padding:4px 8px; white-space:nowrap; font-size:11px }`
  —— 只调尺寸。
- `:3381` `.timed-text-edit-search-expand`；`:3382-3383` `.timed-text-edit-search-option`
  （含 `[aria-pressed="true"]` 的 accent 高亮）。

**黑色外边框来源**：是**浏览器默认 outline**。editor.css 中没有任何全局 `button` 元素样式/reset，
也没有 `.timed-text-edit-search-row button` 的 `:focus`/`:focus-visible` 规则 → Tab 聚焦落回 UA 默认焦点框，
深色主题下表现为黑色突兀外框。对照：项目其他按钮组都显式写了 focus 态，模式统一为
`outline: 2px solid var(--accent-line); outline-offset: 1px` —— `.toolbar button:focus-visible`（`:864`）、
`.media-controls button:focus-visible`（`:632-634`）、`.modal .actions button:focus-visible`（`:3023`）、
本面板内 `.timed-text-edit-view-switch button:focus-visible`（`:3423`）、settings 面板（`:1036`、`:1124`）。

**标准工具栏按钮的通用样式（应对齐的目标）**：`.toolbar button`（`web/editor.css:845-850`）：
`background: var(--btn-bg); color: var(--btn-text); border: 1px solid var(--btn-border); border-radius: var(--radius-sm)`；
hover `:862`、active `:863`、focus-visible `:864`、disabled `:865-866`；激活/按压态用色
`.toolbar button.active`（`:878-880`，`--accent-tint-strong` + `--accent-line`）。

**对齐建议的具体位置**：
- 最小修复（焦点突兀）：在 `web/editor.css:3380` 附近新增
  `.timed-text-edit-search-row button:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 1px; }`。
- 整体对齐：给 `.timed-text-edit-search-row button`（`:3380`）补 `.toolbar button` 同套 token
  （bg/border/radius/hover/active/disabled）；`.timed-text-edit-search-option[aria-pressed="true"]`（`:3383`）
  的用色可与 `.toolbar button.active`（`:878`）统一；建议同时给 `:2477-2478/:2484-2485` 的无 class
  按钮补上语义 class，避免只靠容器选择器。
