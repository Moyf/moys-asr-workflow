# 子代理调查报告：全屏切换 ASS 预览压扁（#27）

只读子代理调查（2026-10-15），主会话抽查核对（防抖 :130/:150、48px 采样守卫 :37-43）吻合后
并入账本。file:line 以核对时 HEAD `1d961b90` 为准。

## 1. 渲染结构

**覆盖层是 Canvas，套在绝对定位的 `#overlay` 里：**

- Canvas 由 `ensureCanvas()` 动态创建（`className='ass-preview-canvas'`）并 `host.prepend()`
  挂进 `MaweDom.overlayEl`（`#overlay.subtitle-overlay`）——`web/editor/styles/editor-wiring-ass-canvas.js:31-41`；
  绘制入口 `render(payload)` 在同文件 ：499-522，门面导出 `global.MaweAssCanvas` 在 ：597-605。
- `#overlay` 是 `.player-stage` 内的绝对定位层：模板 `web/editor-template.html:1876-1881`；
  CSS `.subtitle-overlay { position:absolute; …; z-index:10 }`（`web/editor.css:683-688`）。
- Canvas 自身 CSS：`position:absolute; inset:0; width:100%; height:100%`，即 **backing store 恒为
  PlayRes 原生分辨率（如 1920×1080），靠 CSS 拉伸到 overlayEl 盒子**；注释明说「宽高比不一致时
  等效 libass 的非等比 PlayRes 映射」——这正是被纵向压扁的机制（`web/editor.css:1963-1969`）。
- ASS 模式下 `applyAssSubtitlePreview()` 每次把 overlayEl 的 inline `left/top/width/height` 写成
  metrics 的值：`web/editor/styles/editor-wiring-ass-preview.js:278-283`，最后调
  `MaweAssCanvas.render(...)` :316。

**尺寸来源：** `assPreviewMetrics()`（`editor-wiring-ass-preview.js:24-76`）
- 盒子取 `MaweDom.playerStage.getBoundingClientRect()`（:28-30）；
- 宽高比取 `player.videoWidth/videoHeight`（:32-33）；
- `stageWidth/stageHeight` = 按 aspect-fit 塞进 stage 盒（:35-36），
  `scaleX/scaleY = stage / resolution`（:73-74）——scaleX 与 scaleY 不等时文字即非等比变形。
- 纯布局计算 `web/shared/utils/ass-canvas-layout.js`（`assCreateStackPlan` :281、`assStackFrame` :424）
  只吃 PlayRes 坐标，与屏幕尺寸无关；屏幕适配全在 overlayEl 盒子这一层。

## 2. 现有尺寸变化响应与「扁窗口」成因

**调度器** `scheduleAssSubtitlePreviewRefresh()`：`web/editor/media/editor-wiring-keyboard-guards.js:126-151`
- **100ms 防抖** setTimeout（:138-150）+ 下一帧 rAF 后才调 `MawePlaybackLoop.refreshSubtitlePreview()`；
  注释明说「fullscreenchange 可能早于浏览器完成舞台缩放，等尺寸稳定再画」(:135-137)。
- 触发源：
  - `document.addEventListener('fullscreenchange', MaweMediaPlayback.syncMediaControls)` —
    `web/editor/media/editor-wiring-media-controls.js:47`；
  - `syncMediaControls` 里检测到 fullscreen-preview 类切换 → 调度刷新 —
    `web/editor/media/editor-media-playback.js:124-128`；
  - `ResizeObserver` 盯 `MaweDom.playerStage` — `editor-wiring-keyboard-guards.js:153-156`
    （另有第二个 RO 在 `web/editor/styles/editor-wiring-font-geometry.js:362-368`）；
  - `window resize` — `editor-wiring-keyboard-guards.js:157`。
- 播放中每帧路径：rAF 循环 `updatePlaybackFrame`（`editor-media-playback.js:180-196`）→
  `refreshSubtitlePreview`（`web/editor/media/editor-playback-loop.js:111-136, 140`）→
  `applyAssSubtitlePreview` → 每帧重新量 `assPreviewMetrics()`；暂停时只剩 `update()`
  （timeupdate/seeked，`editor-playback-loop.js:360, 382`）。

**扁窗口的两个成因：**
1. **防抖窗口**：暂停状态下无逐帧重算，唯一路径是 100ms 防抖 + rAF；过渡期间每次 RO/resize
   事件都会 `clearTimeout` 重置 100ms 计时（:130），连续布局抖动会一再推迟绘制。
2. **过渡几何被当成稳定值捕获**：`lastStableAssPreviewGeometry`
   （`editor-wiring-ass-preview.js:24, 37-53`）只在盒子 **<48px** 时才拒绝采样并保留旧几何；
   全屏过渡中「宽度已长、高度滞后」的中间态矩形两维都 ≥48px，会被照单全收（:37-43），
   得到 scaleY≪scaleX 的压扁几何并写进 overlayEl。注释自述恢复依赖「ResizeObserver 的
   settled refresh」(:45-47)。恢复要等布局稳定后 RO 再触发一轮「防抖 100ms + rAF」的重画。

## 3. 视频全屏实现

- **原生 Fullscreen API，作用在 `.player-wrap` 容器**：按钮处理器 `MaweDom.mediaFullscreen` click →
  `document.exitFullscreen()` / `MaweDom.playerWrap.requestFullscreen()`
  （`web/editor/media/editor-wiring-media-controls.js:38-46`）。
- 无任何 `:fullscreen` CSS 规则；`fullscreen-preview` 类只用于非 ASS 模式 DOM 预览的字号翻倍
  （`web/editor.css:715-718`）。舞台变大纯靠布局链：`.player-wrap` 为纵向 flex（`editor.css:595-598`、
  `web/waveform.css:98-105`），`.player-stage { flex:1 1 auto; width:100% }`（`editor.css:599-601`），
  video `width:100%; object-fit:contain`（`waveform.css:106-110`）。
- **预览层自动跟随全屏**：`#overlay` 是 playerWrap 的后代（模板 ：1876-1881），
  fullscreenElement=playerWrap 天然包含它，无需 DOM 迁移；其几何全靠 inline style 每次刷新重写。

## 4. 修复方向建议

核心矛盾：现有路径「等稳定再画」，且过渡态矩形可能被捕获。可做的组合：

1. **fullscreenchange 当下即时重排**：在 `editor-wiring-media-controls.js:47` 的 fullscreenchange
   （或 `editor-media-playback.js:128` 类切换分支）里加一条**不防抖**的路径：
   `requestAnimationFrame` 双帧后直接调 `MawePlaybackLoop.refreshSubtitlePreview()`
   （现成可复用入口，`editor-playback-loop.js:140`，门面导出 ：417），随后仍保留 RO 的
   settled refresh 收尾；或把防抖对 fullscreen 触发源改为「立即 rAF + 100ms 后再兜底一次」。
2. **盯视频元素而非 stage**：`editor-wiring-keyboard-guards.js:153-156` 的 RO 目前只观察
   `playerStage`；过渡期 stage 与 video 的盒子可能先后变化（video 是实际尺寸源），
   对 `MaweCoreState.player`（video 元素）再挂一个 RO（或改观察 video）能让触发更准。
3. **加固过渡态采样守卫**：`assPreviewMetrics()`（`editor-wiring-ass-preview.js:35-43`）对
   48px 阈值之外再校验采样矩形的宽高比是否接近 `videoWidth/videoHeight`（或连续两帧一致
   才更新 `lastStableAssPreviewGeometry`），避免把「宽已变高未变」的中间态画出去。
4. **应改动文件**：`web/editor/media/editor-wiring-keyboard-guards.js`（schedule 函数与 RO 目标）、
   `web/editor/media/editor-media-playback.js`（syncMediaControls 的 fullscreen 分支）、
   `web/editor/styles/editor-wiring-ass-preview.js`（metrics 守卫）。

## 5. 相关既有测试

- **`tests/e2e/speaker-labels.spec.mjs:296-440`**（最直接）：「keeps ASS speaker labels in the
  same style across preview resizing and fullscreen」——mock `document.fullscreenElement` +
  派发 `fullscreenchange`（:359-370 进全屏、:408-419 退出），断言过渡期 overlay 高度保持旧值
  不被压扁（:381, :429）、稳定后 overlay 高度跟随新舞台（:400-401, :438），并在过渡后 40ms
  才把 stage 调到目标尺寸模拟浏览器慢布局（:374-378）。若改即时重绘策略，此 spec 的
  「transient 保持旧值」断言语义需要同步复核。
- `tests/test_waveform.py:1058-1066`：静态断言 fullscreen-preview 类切换接线与
  `scheduleAssSubtitlePreviewRefresh` 函数存在于源码。
- 纯布局/光栅层：`tests/test_ass_canvas_layout.mjs`、`tests/test_ass_canvas_raster.mjs`（不涉 resize）。
- 其它 ASS 预览 e2e：`tests/e2e/ass-frame-preview.spec.mjs`、`tests/e2e/ass-export.spec.mjs`、
  `tests/e2e/ass-stacking-boundaries.spec.mjs`；全屏按钮可见性（非预览）在
  `tests/e2e/media-controls-layout.spec.mjs:12-41`。
