# 子代理调查报告：Shift+拖动切叠加轨高频抖动（#21）

只读子代理调查（2026-10-15，第二次；首次空回复已重派），主会话抽查核对
（`landsOnMainOverlap` 守卫与「疯狂上下闪烁」注释 cue-drag-update.js:96-103、`fitsMain` :132-135、
修复来源提交 3cc689ca/PR #223）吻合后并入账本。file:line 以核对时 HEAD `1d961b90` 为准。

涉及文件（短名）：`cue-drag.js` = web/editor/media/waveform/cue-drag.js；
`cue-drag-update.js` = web/editor/media/waveform/cue-drag-update.js；
`overlay-transfer.js` = web/editor/cues/editor-wiring-overlay-transfer.js；
`multi-subtitle.js` = web/shared/utils/multi-subtitle.js。

## 1. Shift+拖动切轨的完整实现

**入口/状态**：`beginCueDrag`（cue-drag.js:10）。Shift+move 拖动不改动选区，注释明确
「邻居挡路时由 applyMoveDrag 动态换轨」（cue-drag.js:76-79）；drag 状态记 `shiftOverlay`
（:147-148）与 `convertedToOverlay: false`（:150）。

**重要澄清**：拖动进行中的切轨**不是按指针纵向位置**判定的，而是按「碰撞条件」判定。
纵向位置只在两处起作用：按下时选轨（`trackAtPoint`，input.js:186-215）与中缝拖动找行
（cue-drag-update.js:19-26）。Shift+拖动的 move 路径不读 clientY。

**移动帧**：`moveCueDrag`（cue-drag-update.js:10）计算 `deltaTime`（:29），Shift+拖动全程
`disableSnap`（:53，只关吸附不关钳制），进入 `applyMoveDrag`（:55 → :67）。

**主→叠（cue-drag-update.js:74-123）**，条件 `drag.shiftOverlay && indices.length===1`（:74）
且 `track==='main' && !drag.convertedToOverlay`（:76）：
- 用**当前**邻居位置算允许区间：`neighborMinDelta = 前一条.end − original.start`、
  `neighborMaxDelta = 后一条.start − original.end`（:81-88）；
- 触发：`requestedDelta > neighborMaxDelta || < neighborMinDelta`（:89-90）；
- 上次修复加的守卫 `landsOnMainOverlap`：模拟落点与**主轨**任一其他字幕重叠才换（:98-102）；
- 通过则先把段移到指针位置（:105-114）→ `convertCueToOverlay`（:115）→
  `rebaseCueDragToTrack(drag,'overlay',…,rawDelta)`（:117；cue-drag.js:460-478：改 track/index、
  `convertedToOverlay = track==='overlay'`（:467）、平移 `startPointerTime`（:474）、
  全量重建 `refreshCueOverlay`（:475））→ return；失败则 `restoreTiming` 留主轨（:120）。

**叠→主（cue-drag-update.js:124-143）**：`fitsMain` = 叠加段**当前位置**与主轨所有字幕都无重叠
（:128-134）→ `convertOverlayCueToMainDrag`（:136）→ rebase（:138）。注意 rebase 会把
`convertedToOverlay` 复位为 false（cue-drag.js:467），所以主→叠→主→叠可无限往返。

**迁移本体不挪位置**：`convertMainCueToOverlayForDrag`（overlay-transfer.js:200-221）/
`convertOverlayCueToMainForDrag`（:226-255）只做 splice，插入顺序按 start 升序、同 start 插在后
（`insertSegmentByStart`，multi-subtitle.js:55-65；`moveSegmentBetweenTracks` :68-76）。

**同轨邻居钳制（关键）**：换轨判定之后，通用移动路径 `moveDragDelta`（cue-drag-update.js:227）
按**当前轨道**的左右邻居算 `minDelta/maxDelta`（:253-260），最终 `clamp(delta, minDelta, maxDelta)`
（:292）。`disableSnap` 只跳过吸附候选（:264），**钳制无条件生效**——Shift+拖到叠加轨上
也会被叠加轨邻居推挤。

## 2. 此前「防来回跳动」优化的机制

- 提交 `a06b76c8`「fix(editor): 修复 Shift 拖动换轨闪烁」（2026-10-11；内容并入 PR #223 的
  3cc689ca/a32d5b1a）。查找命令：`git log --oneline -S"landsOnMainOverlap" -- web/`。
- 机制：**换轨前模拟落点与主轨的重叠检测**（`landsOnMainOverlap`，:98-102），不是迟滞带
  也不是锁定。注释写明动机：「指针目标落点若与主轨并无重叠——典型是目标处已有另一条叠加
  字幕把上方占住，转上去也站不稳——下一帧就会满足回轨条件……疯狂上下闪烁；此时保持原轨
  不做任何事」（:93-97）。
- 即：旧修复只处理「落点与主轨无重叠」的闪烁；**落点与主轨有重叠、但换上去后被叠加轨
  邻居挤出的场景未覆盖**。

## 3. 维护者场景逐帧推演（翻转点）

设主轨 A=[1000,2000]（被拖，idx0）、B=[5000,6000]（后方主字幕，idx1）；叠加轨 O=[4800,5500]
（早于 B、可与 B 交叠；「在前」变体 O.end≤B.start 同理）。Shift 向右拖 A：

- **F1 主→叠**：A 在主轨被钳在 [4000,5000]（:257-259），指针继续右移 →
  `requestedDelta > neighborMaxDelta`（:90）；模拟落点与 B 重叠 → `landsOnMainOverlap` 通过
  （:100-102）→ 换轨落到指针处，落点 start < O.start → 按 start 升序插到 **O 左侧**
  （multi-subtitle.js:57-63）。
- **F2 叠加轨钳制挤出**：先查 `fitsMain`（:128-134）落点仍压 B → 不回轨；随后 `moveDragDelta`
  对叠加轨邻居 O 算 `maxDelta = O.start − 落点.end < 0`（:257-259）→ 末尾 clamp（:292）把 A
  **强行左推**到 end=O.start。
- **F3 叠→主**：帧首 `fitsMain` 用被挤后的位置判定：A.end=O.start ≤ B.start → 与主轨无重叠
  → 换回主轨（:135-141），`convertedToOverlay` 复位 false（cue-drag.js:467）。
- **F4+ 循环**：回主轨后 rebase 基准=被挤位置，`neighborMaxDelta` 随之缩小，指针持续右移很快
  再次越过（:90）→ 模拟落点仍与 B 重叠（:100-102 通过）→ 再次换轨 → 落点又撞上 O →
  又被挤出 → 又回主轨……**每 2-3 个 pointermove 帧完成一次主↔叠往返**。每次换轨都触发
  `refreshCueOverlay` 全量重建（cue-drag.js:475），视觉即高频上下闪烁。

**翻转点**：正向判定 :90+100-102（换上去），反向判定 :128-134（挤出去后换回来），真正把位置
推出「与主轨重叠」区的是 :257-259+:292 的叠加轨同轨钳制。两个谓词（`landsOnMainOverlap` 与
`fitsMain`）互为补集、无迟滞，且主→叠判定**完全不看叠加轨占用**——这是根因。
当 O.start ≥ B.start（O 完全落在 B 时间范围内）时挤出位置仍压 B、不会闪——与「仅当叠加块
早于后方主字幕时闪烁」的现象吻合。

## 4. 修复方向建议

1. **把「叠加轨占用」纳入主→叠守卫（推荐，最小改动）**：在 :100-102 处同时取
   `this.options.getSegments('overlay')`，若模拟落点会与任一叠加块重叠（可进一步模拟 :257-259
   的挤出结果），则不换轨、维持「停在主轨边界」的既有语义——与 a06b76c8 的哲学及 e2e 期望
   一致。改动函数：`applyMoveDrag` 主→叠分支。
2. **回轨判定加迟滞**：`fitsMain`（:132-134）要求留出余量（如清出主轨 ≥ snapThreshold/若干 ms）
   才回轨，使「被挤出」的落点落在迟滞带内不再翻转。改动函数：`applyMoveDrag` 叠→主分支。
3. **拖动期锁定**：`convertedToOverlay`（cue-drag.js:467）改为一次换轨后本次拖动内不自动回轨
   （或配合 `lastPointerPosition`（cue-drag-update.js:15）按纵向带离开才复位）。
   注意现实现没有按 Y 切轨的逻辑，若要「按指针纵向位置切轨」是更大的重设计。
4. **Shift 拖动期间放开叠加轨同轨钳制**：`moveDragDelta` :253-260 对 `drag.shiftOverlay` 的
   叠加轨跳过邻居钳制（叠加轨本就允许压主轨），落点站得稳、`fitsMain` 恒假、不闪；
   代价是允许叠加块互叠，需产品确认。

## 5. 既有测试覆盖

- 单元层：无。`tests/*.mjs` 中 grep `applyMoveDrag|moveCueDrag|rebaseCueDragToTrack` 零命中。
- e2e：`tests/e2e/overlay-track.spec.mjs`
  - :220-275「Shift+drag converts to overlay on overlap and returns to the main track when clear」
    ——基本换/回轨；
  - :277-336「Shift+drag toward a spot already blocked by an overlay cue stays on the main track」
    ——上一次修复的回归，但阻挡叠加块在 [0,2000]，落点与主轨无重叠，**未覆盖维护者场景**
    （叠加块位于前后主字幕之间/与后方主块交叠，落点与主轨有重叠却被叠加轨邻居挤出）；
  - :338 起为换轨后选区/颜色保持（:390、:442）。
- 建议补测：在 overlay-track.spec.mjs 增加「anchor + 后方主字幕 + 位于两者之间/叠住后方主块
  起点的叠加块，Shift 分步拖入交叠区，断言帧间不交替换轨、终态稳定」。
