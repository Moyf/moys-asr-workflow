# 调查报告: 大字幕量下切换「显示字词时间码」白屏数秒

- 条目: 账本 `TEST_FEEDBACK_测试反馈.md` 条目 2
- 调查方式: explore 只读子代理,主会话抽查关键 file:line 与源码吻合(2026-10-24)
- 现象: 字幕量特别大时切换字词时间码(波形工具栏「字词」/ Q / 工程设置),界面空白数秒后恢复

---

## 1. 切换开关后的完整同步调用链

三个入口全部收敛到 `MaweWordTiming.setEnabled`:

- 工具栏按钮:`web/editor/cues/editor-word-timing.js:228`(`#word-timing-quick-toggle` click → `setEnabled(!enabled)`)
- 快捷键 Q:`web/editor/cues/editor-word-timing.js:230-242`(document keydown → `setEnabled(!enabled)`)
- 工程设置 checkbox:`web/editor/cues/editor-wiring-word-timing.js:3-5`(`#project-word-timing-toggle` change → `setEnabled(event.target.checked)`)

`setEnabled(value)`(`web/editor/cues/editor-word-timing.js:21-32`)依次:

1. `cancelWordDrag()`(editor-word-timing.js:22 → `web/editor/media/waveform/word-blocks.js:329-336`,非拖动态为 no-op)
2. 写 `enabled`、`clearSelection()`(23-24;10-15)
3. 同步 `#word-timing-toggle`(25-26,该元素当前模板中已不存在,`?.` 兜底)与 `syncQuickToggle()`(27;34-42,镜像工具栏按钮 aria 态与工程设置 checkbox)
4. `pane.classList.toggle('word-timing-mode', enabled)`(28)——样式失效从波形面板子树开始,联级 CSS 分级见 `web/waveform.css:916-961`
5. `MaweDisplaySettings.syncWordTimingWaveformSettings(enabled)`(30 → `web/editor/ui/editor-display-settings.js:141-172`):
   - `captureWaveformViewportCenterTimeMs(editor)`(148;57-85,multi 模式对每个已渲染行 `getBoundingClientRect` 取视口中心时间锚点)
   - `editor.setSecondsPerRow(Math.min(当前, wordTimingSecondsPerRow=5), {render:false})`(149-152;实现 `web/editor/media/waveform/workspace.js:272-282`:写设置、`saveSettings` 同步写 localStorage(278)、`multiRange=[-1,-1]`(279))
   - `syncWaveformModeRowHeight('word', …, {render:false})`(157 → `editor-display-settings.js:116-129` → `applyWaveformModeRowHeight` 93-112)→ `editor.setRowHeight(max(…, wordTimingRowHeight=168), {render:false})`(workspace.js:292-314,内含响度振幅重拟合 306-308);预设值在 `web/editor/state/editor-settings.js:132-133`
   - **multi 模式**:`editor.render()`(160-161)→ `web/editor/media/waveform/render.js:79-100`:
     - `_readWaveColors()`(81)、`invalidateGroupBadges()`(83 → render.js:145-147 推进徽章缓存纪元)
     - `applyLayout()`(84 → `web/editor/media/waveform/workspace.js:135-166`,workspace class、控件态)
     - `renderMulti()`(99 → render.js:321-328):按新几何写 `content.style.height = rowCount×stride`,`multiRange=[-1,-1]`
     - `renderMultiVisible(true)`(327 → render.js:332-378):**force 全量重建路径**(347-358):`content.replaceChildren()`(349)→ 逐行 `createMultiRow`→`createRow`(351-352;`web/editor/media/waveform/cue-blocks.js:10-177`,内含 `appendGapBlocks` 49、`appendCueBlocks` 50)→ `appendCueBlocks` 对每个重叠字幕调 `appendWordBlocks`(cue-blocks.js:381 → word-blocks.js:47-107,逐词建 DOM)→ `appendTimelineRow`(352;`web/editor/media/waveform/thumbnails.js:137-153`,缩略图壳)→ 全部行建完后逐行 `drawRow`(355;`web/editor/media/waveform/canvas.js:66-93` → `paintWaveRow` 102-239 + `drawWordChips` 238/343-418)→ `syncThumbnailView`(356)→ `updatePlayback(false)`(357;`web/editor/media/waveform/playback.js:10-101`)
   - 几何确实变化时恢复视口锚点(165-168 → `restoreWaveformViewportAfterGeometryChange` 87-90 → `revealTime`,`web/editor/media/waveform/scale-controls.js:161-204`):multi 模式可能发起 **smooth scroll**(194)并 `scheduleMultiVisible()`(200-202)
   - 返回 `true`
6. `rendered === true` → 跳过 `refresh()`(31)

**basic(单行)模式变体**:第 5 步的 `editor.isMultiMode()` 守卫(editor-display-settings.js:160)不成立 → 返回 `false` → 第 6 步执行 `refresh()`(editor-word-timing.js:6)= `refreshCueOverlay()`(`web/editor/media/waveform/cue-blocks.js:837-873`):对每个已渲染行先移除全部字幕/徽章/中缝/字词块(848-849)再 `appendCueBlocks` 重建(850-855,内部含逐词 `appendWordBlocks`),`updatePlayback`(869)、`refreshWordChips`(872 → word-blocks.js:498-503 → 整行 canvas 重绘)。

**任务结束之后(同一次交互的连锁)**:pane 上的 `ResizeObserver`(构造于 `web/editor/media/waveform.js:214-216`,`_onResize` 208 → `scheduleRender` render.js:10-13)因滚动条/尺寸变化触发 → **下一帧再一次完整 render**;`revealTime` 的 smooth scroll 触发 scroll 事件(`web/editor/media/waveform/controls.js:115-128`)→ `scheduleMultiVisible`(render.js:17-24)→ 动画期间每帧增量 `renderMultiVisible()`(render.js:360-377,新进入行再走 `createMultiRow`+`drawRow`)。

**字幕列表完全不在此链路上**:`setEnabled` 全程不调用 `MaweViewUpdates.invalidate`/`renderAll`(`web/editor/state/editor-view-updates.js:6-13`、`web/editor/cues/editor-cue-panel.js:11`),列表 DOM 不重建。

## 2. 阻塞主线程的具体工作量在哪

**是否全量重建所有字幕块/字词块 DOM?** — 波形侧是「已渲染行的全量重建」,不是全工程量:

- multi:`renderMultiVisible(true)` 无条件 `content.replaceChildren()`(render.js:349)后重建 `first..last` 行(351-352)。`first/last` 由 `scrollTop/clientHeight` 决定(render.js:337-338),行数 ≈ 视口行数 + 2×`MULTI_ROW_BUFFER`(=2,`web/editor/media/waveform/constants.js:34`),通常 6-9 行。
- basic:`refreshCueOverlay` 重建唯一一行的整个覆盖层(cue-blocks.js:848-855);滚动平移期另有原位重排路径(render.js:216-307)。

**字词时间码开启时每个词是否创建独立元素?** — 是,但仅限行窗口内的词:`appendWordBlocks`(word-blocks.js:47-107)对每个与行时间范围相交的 entry(word-blocks.js:60 过滤)创建 1 个 `div.waveform-word-block` + 1 个 `span.waveform-word-label`(61-75)+ 最多 2 个 `span.waveform-cue-handle`(76-81、110-118),dual 模式再加中缝 `span.waveform-word-boundary`(92-106)。**≈ 每词 2-4 个节点**。复杂度是 O(可视行数 × 行内字幕数 × 每句词数),**不是 O(总词数)**。量级示例:7 行 × 每行(5 秒窗)约 20 词 ≈ 数百节点——「数万词→数万节点全量建 DOM」的假设不成立(5000 条工程下波形 DOM 恒为 ~48 块的实测见 `docs/logs/unversioned/2026-10-07/PERF_CUE_DRAG_RESEARCH.md:28-29`)。

**波形是否全量重画?** — 是,所有已渲染行 canvas 重绘:multi 的 force 循环 `for (const row of rows) this.drawRow(row)`(render.js:355);basic 的 `refreshWordChips` → `drawRow`(word-blocks.js:498-503)。`drawRow` 默认 `measure:true` → 每行 `getBoundingClientRect()` 强制同步布局(canvas.js:72-76)——**每行一次 layout thrash**;`paintWaveRow` 逐像素描边循环(canvas.js:174-235),峰值聚合有列包络缓存摊销(canvas.js:18-62);basic 模式还有全文气泡层(每帧 ≤64 chip,word-blocks.js:8、343-418)。

**字幕列表呢?** — 不重渲染(见第 1 节末)。列表本身非虚拟化、靠 `content-visibility: auto` 兜底(`web/editor.css:2863-2866`),`renderAll` 全量重建在 5000 条时 295-608ms(PERF_CUE_DRAG_RESEARCH.md:21-22、125),但它不在本切换路径上。

**与总量成正比的零星部分**(单次、非热点):`computeGroupBadges` O(N)(render.js:83 → `web/editor/media/waveform/visibility.js:41-67`);`firstCueIndexOverlapping` 二分 O(log N)(visibility.js:108-119);每个可视句一次 `getWordTimingEntries`(O(句内 items),含每词 `cloneJsonValue` 深拷贝与文本归属匹配,`web/shared/utils/word-timing.js:24-41`、88-105)。

## 3. 「什么都不显示几秒」更像哪种

代码结构判断:**同步 JS 长任务 + 其后的整块布局/绘制巨帧,两者叠加**,且被放大为「一次交互内多轮重建」:

- 整条链在**同一个事件处理任务内**同步完成(点击 → setEnabled → render()/refreshCueOverlay,中途无 rAF 让位;对比:频谱色开关刻意用「先让浏览器画一帧再重绘」的模式,`scale-controls.js:261-285`)。`content.replaceChildren()`(render.js:349)先清空、同任务内重建——任务结束前浏览器无法绘制任何新状态。
- 任务结束后要一次性完成:pane 子树样式重算(`word-timing-mode` class + 全部块的 `word-timing-full/compact/background` 分级类)、数百个绝对定位词块的 layout、多块 canvas 尺寸变更与位图重绘。本仓库已有同量级的「巨帧 paint」记录:5000 条工程选区变更后首帧 `RunPaintLifecyclePhase` 曾达 2.5s(PERF_CUE_DRAG_RESEARCH.md:55-62)。
- 再叠加 ResizeObserver 回声导致的**第二次完整 render**(下一帧)与 smooth scroll 引发的**每帧增量重建**,主线程在切换后的一段持续时间内都处于高负载——主观上即「白屏几秒后恢复」。

定性:更像「同步长任务 + 巨帧布局/绘制」组合,而不是「一次性插入超大 DOM」(DOM 量被行虚拟化钳制);但纯 JS 阻塞无法解释「白屏」(阻塞期间应残留旧帧),白屏更符合重建后巨帧布局/绘制阶段。精确归因(JS vs style/layout/paint)需实机 profile,建议探针点:`renderMultiVisible`、`createRow`、`appendWordBlocks`、`drawRow` 各包一层 `performance.now()`。

## 4. 已有虚拟化机制及为何没挡住

已存在的机制:

- multi 行级虚拟化:只建可视区 ±2 行(render.js:332-378;增量路径只增删进出行、保留行 canvas,360-377)
- 字词块只建行窗口内的(word-blocks.js:60)
- basic 滚轮平移:位图平移+窄条补绘+块层原位重排(render.js:216-307;`relayoutWordBlocksInRow` word-blocks.js:511-589)
- 各类缓存:列包络(canvas.js:18-62)、组徽章(render.js:144-161)、chip 测宽(word-blocks.js:17-32)、缩略图 renderKey(thumbnails.js:173-174)
- 列表侧 content-visibility(editor.css:2863-2866)

为什么没挡住:**切换路径主动绕过了所有增量机制**。行几何预设(每行秒数 10→5、行高 120→168)使每行的 `top/height/width`、lane 分级类全部失效——行内 lane 布局与 cover 回退是 `createRow` 时按当时行高定死的,注释明确「行几何变化必须走完整重渲染」(workspace.js:309-311)——于是 `render()` 走 force 全量重建(render.js:347-358),虚拟化只是把「全量」的范围钳到可视行,并没有把这次交互变增量;随后还有回声 render 与滚动增量重建连续补刀。basic 模式则因 `updateSelection`/手柄存在性依赖整层重建(cue-blocks.js:1035-1041 的注释解释了字词模式下选中集变化就必须整层重建),`refreshCueOverlay` 必然整层拆建。

## 5. 字词时间码的布局分级在切换时做了什么

- 分级规则(CSS 注释 `web/waveform.css:916-924`):单行波形或行高 ≥96 的非双语行 → `word-timing-full`(字词条带独立一层、句块保持全功能);行高不足或双语行 → `word-timing-compact/background`(句块垫底变暗垫高到 44px,词块叠上)。JS 判定在同文件 appendCueBlocks:cue-blocks.js:276-278、336-349;word-blocks.js:55-57。波形 canvas 高度不随开关变化(waveform.css:919-921)。
- 切换时(editor-display-settings.js:141-172):multi 模式把**两个几何预设一起落地**(每行秒数 `min(当前,5)`、行高 `max(当前,168)`,159 行注释「两个预设一起落地后只绘制一次」)然后**整组 render 一次**;分级类是 createRow/appendCueBlocks 时烙进行内 DOM 的,所以行高变了就必须重建所有行——这正是切换必然走全量重建的原因。
- 与字幕量的关系:分级判定本身每块 O(1);放大的机制是 (a) 每次开关都触发全量行重建(第 2/4 节);(b) 每行秒数收紧到 5s 后,同密度下行内词块更密、行数更多,后续滚动/播放的每帧重建成本整体抬升——「开启后持续更卡」与「切换瞬间白屏」是同一根因的两个表现。

## 6. 修复方向评估(不实施)

**a. 切换渲染拆成异步分片(每帧一批)**
- 改动面:`renderMultiVisible(true)`(render.js:332-378)按行分片——首帧只建可视中心行,±buffer 行放后续 rAF;`refreshCueOverlay`(cue-blocks.js:837-873)同理按行分片。调用入口 `syncWordTimingWaveformSettings`(editor-display-settings.js:161)与 `setEnabled`(editor-word-timing.js:31)需改为「发起分片」语义。
- 风险:分片中途 `multiRange/renderedRows` 处于中间态,滚动/播放头/字词拖动路径(word-blocks.js:244-336)可能读到半建行;撤销重做与 e2e 假设同步完成(`tests/test_waveform_display_presets.mjs` 断言 render 次数;Chromium word-timing 套件)。成本:中。**更便宜的同型方案**已有仓库先例——把整次重建推迟一帧、先让开关态上屏(`scheduleSpectralColorRender` 的 rAF+setTimeout 模式,scale-controls.js:261-285),低风险但不减少总耗时。

**b. 只渲染可视区、滚动补渲染** — 架构条件**已具备**:multi 行虚拟化+增量补行(render.js:360-377)、词块窗口过滤(word-blocks.js:60)、原位重排原语(relayoutWordBlocksInRow)都在。真正缺的是三点:(i) 消掉回声二连 render(ResizeObserver 回调里识别「几何驱动的 render 刚做过」即跳过,waveform.js:208/214-216);(ii) buffer 行延后到 idle 再建;(iii) 几何未变的重复开合直接复用行(renderKey 先例:render.js:172-176、thumbnails.js:173-174)。注意 geometry 变了行必须重建(第 5 节),「原位重排」不适用于本次开关。

**c. 可先消掉的冗余全量重算**
1. **每次开关的双重 render**(直接 render + observer 回声)——最大头,乘 2。
2. **`revealTime` 的 smooth scroll**(scale-controls.js:194):几何切换后改为瞬时定位(直接设 `scrollTop` 或 `behavior:'auto'`),避免随后数百毫秒内逐帧增量重建词密行。
3. `getWordTimingEntries` 每(行,句)重算且逐词 `cloneJsonValue`(shared/utils/word-timing.js:35):按「segment 引用 + items 引用 + 纪元」做记忆化,appendWordBlocks/refreshCueOverlay 全部受益。
4. 开→关→开来回切时数据与几何都没变却全拆全建:给行 DOM 挂 renderKey(几何+数据纪元),相同则跳过重建,只切 pane class 与少量类名。

## 根因结论

**切换字词时间码会同时改写波形行几何预设(每行 5 秒/行高 168),迫使代码在同一次同步任务里对所有可视行做 `replaceChildren` 式整组重建(逐词 DOM 块 + 逐行 canvas 重绘 + 每行强制布局),随后又被 ResizeObserver 回声触发第二次完整渲染、并被锚点恢复的 smooth scroll 连续触发增量重建——卡顿/白屏来自「同步全量重建被放大 2~N 次」,而不是对全部数万词的一次性扫描(波形侧本就按可视行虚拟化,不存在数万节点全量重建)。**
