# 表情包烧录 · 两种显示方案研究报告

任务：对比「方案一：固定位置（preview.sticker 几何）」与「方案二：显示在字幕第一个字左侧」在
FFmpeg 烧录管线下的几何换算、时间维度、管线整合、去空隙收缩、预览一致性、工作量与风险。
纯研究，未修改任何代码。配套基础管线账本见同目录 `TASK.md`。

---

## 1. 结论摘要

**方案一（固定位置）——可行，推荐本期实现。**
几何是纯静态换算：`preview.sticker` 归一化矩形 × PlayRes → 像素矩形，每个表情包文件一个
overlay 节点、一个静态 `enable='between+between+…'` 窗口并集；链插在 `ass` 滤镜之前。
去空隙只需前端用 `mapGapRemovedTime` 收缩区间（服务端还要减 seek 原点，见 §4.4）。
不依赖任何文字测量，无 libass/预览偏差问题；与现有 `burn_ass_video()`（server-editor/serve.py:757）
的整合面最小。多图同屏堆叠语义与预览 CSS 有已知近似（TASK.md 已记录为边界）。

**方案二（字幕首字左侧）——可行但成本高一档，推荐作为二期。**
技术核心不是 FFmpeg（overlay 的 `x/y/enable` 逐句化没有障碍），而是**拿到每句字幕的精确行盒**。
`buildAssPayload` 的 `onAssPlan` 排版计划（web/shared/utils/ass-export.js:394-396）已经携带每句
预折行 runs、锚点与偏移，配合 `assStackFrame` + `assCanvasLayoutLines` 可在前端推导出
「首行左缘 / 首行垂直中心」的 PlayRes 像素坐标，且与 Canvas 非遗留（non-legacy）预览共享同一份
换行结果（导出事件带 `\q2` + 显式 `\N`，见 §5.1），精度风险集中在 canvas↔libass 度量差与
legacy 长句自动折行两处。实现选项推荐「选项 A：每 (PNG, 句) 一个 overlay 节点」；
「选项 B 挪字幕」可作可选模式但侵入 ASS 排版（legacy 需注入 `\pos`、与方案移动 `\move` 冲突）；
「选项 C 表达式取值」可行但表达式长度随句数线性膨胀，维护性差。

---

## 2. 共享基础设施（现有可直接复用的契约）

### 2.1 排版计划：buildAssPayload + assCreateStackPlan + onAssPlan

- `buildAssPayload(segments, options)`（web/shared/utils/ass-export.js:137）。ASS 模式（`profile` 启用，
  烧录入口本身要求 ASS 模式，web/editor/io/editor-wiring-burn-video.js:397-405）下：
  - 每条主/副/叠加字幕 `addStackItem()`（:195-203）进入 `stackItems`，时间已换算为毫秒
    （`:201` `start: start * 10`，start 为厘秒）。
  - `assCreateStackPlan({ items, profile, width, height, measure: options.measureAssRun })`（:394-395）。
    `measureAssRun` 即 `window.MaweAssCanvas?.measureRun`（web/editor/io/editor-export-srt.js:286）。
  - 计划经 `options.onAssPlan({ ...plan, profile })` 回调（:396）——**预览已在用同一条链**：
    `applyAssSubtitlePreview` 用 `buildAss({ preview: true, onAssPlan })` 缓存计划
    （web/editor/styles/editor-wiring-ass-preview.js:262-266），逐帧 `assStackFrame(plan, tMs)` 取锚点
    （:267）。烧录请求构建可同样传 `onAssPlan`（`buildAss` 已透传，editor-export-srt.js:318）。
  - 计划有诊断时（组过大、负字距等）`buildAssPayload` 抛错（:397-398）；烧录入口的
    `buildRequest()` 已有 try/catch 提示（editor-wiring-burn-video.js:73-80），方案二可直接复用该失败路径。

### 2.2 计划条目里有什么（方案二的原料）

`plan.slices[]`（web/shared/utils/ass-canvas-layout.js:317 `assCreateStackPlan`）：

- `slice.legacy`：单主字幕切片走 legacy（:372-378），导出事件**无 `\pos`**（样式对齐+边距定位）；
  非 legacy 切片每条 cue 发 `\an{n}\q2\pos/\move`（ass-export.js:489-497）。
- `slice.items[]`：每条 cue 携带
  - `runs`：**预折行 runs**（`assStackWrappedRuns`，:178-203；手动定位句 :358-362、legacy 震动/cueScale≠1
    句 :376-377 同样预折行）。折行用与绘制同一 measurer，导出时 `escapeAssText` 把 run 内 `\n` 写成
    `\N`（web/shared/utils/ass-style.js:702-709），事件再带 `\q2`（禁止自动折行）→
    **非 legacy 句的换行结果 = 计划 = 导出 = Canvas 预览，四方一致**。
  - `alignment`（发射用对齐，非根/固定层被改写为顶层 7-9，:403-404）、`offset {x,y}`（相对组根）、
    `rect {left,top,right,bottom}`（相对锚点、含描边/阴影 padding 的整块墨盒，`assStackCueBounds`
    :205-264，padding 公式在 :233）、`absolute`（固定副字幕）、`manual`（逐句定位覆盖）、
    `fontSize`、`style`（含 `outline/shadow/spacing`）。
- `slice.pieces[]`：组根的运动分片（`assStackMotionPieces`，:284-314），每片
  `{start, end, from, to, instant}`（PlayRes 坐标）。震动句按片冻结采样（ass-export.js:443-477）——
  方案二若遇组移动可沿用同一「逐片冻结」策略。
- `assStackFrame(plan, timeMs)`（:480-499）：按时刻给出每条 cue 的最终 `anchor {x,y}`（组根 + offset×scale）、
  `scale`（整组缩放×1）、`shakeOffset`。**非 legacy 句的 anchor 直接可用；legacy 非 manual 句不带
  anchor**（:489-490 仅 manual 附带），预览侧由 drawTrack 用 `assCanvasAnchorPoint(样式对齐, 边距)` 兜底
  （web/editor/styles/editor-wiring-ass-canvas.js:417-425）——方案二推导函数需同样兜底。

### 2.3 几何与测量原语（全部已在 `window.AsrEditorUtils` 导出，web/shared/editor-utils.js:589-599）

- `assCanvasAlignmentGrid`（:43-45）：an1-9 → column(0左/1中/2右) × row(0上/1中/2下)。
- `assCanvasAnchorPoint`（:61-75）：对齐+边距+PlayRes → 锚点；有 `\move` 时直接取移动坐标。
- `assCanvasLineOffsetX`（:80-83）：行内相对锚点的 x 偏移（中列 `-lineWidth/2`）。
- `assCanvasBlockTopY`（:87-90）：块顶相对锚点的 y 偏移。
- `assCanvasLayoutLines(runs, measurer)`（:123-164）：预折行 runs → 行数组（每行 `width/ascent/descent`
  与 run 内条目 x 偏移）+ 块宽高。**首行行盒即 `lines[0]`**。
- `MaweAssCanvas.measureRun(style, nativeFontSize, run, text)`（editor-wiring-ass-canvas.js:608-616）：
  canvas 度量入口；`fontBoxRatio`（:84-103）把 ASS「字形 ascent+descent」字号语义换算到 canvas em；
  measurer 与光栅化共用同一测量（:149-171 注释明确「measurer 与 rasterize 不漂移」）。
- 注意：`assMeasureStackRun`（run 级字号/强调缩放后测量，ass-canvas-layout.js:169-176）**未导出**，
  方案二推导函数需要内联复制这 8 行（或顺手导出）。

### 2.4 表情包区间收集与几何

- `rebuildStickerIntervals()`（web/editor/media/editor-sticker-overlay.js:55-87）：主轨+叠加轨、
  ref→head 解析、head 禁用过滤、`{start, end, source, key, track}` 列表 + 有序边界；
  `MaweStickerOverlay.stickerIntervals` 已在门面暴露（:172）——烧录请求的区间来源。
  每条 interval 恰好对应一个「持有/引用表情包的句子」，与计划条目可通过 segment 对上（§5.2）。
- `preview.sticker` 归一化几何：默认右上角 `{0.73, 0.04, 0.24, 0.30}`
  （web/shared/utils/preview-geometry.js:19-21 `DEFAULT_STICKER_GEOMETRY`）；钳制/换算
  `clampPreviewGeometry` / `previewGeometryToCss`（:44-62）。JSON_SCHEMA.md:434-474 明确几何存的是
  播放区归一化分数、缺省回默认。
- 预览层挂载在 `playerStage`（web/editor/media/editor-wiring-sticker-preview.js:19），手势测量也用
  stage 矩形（web/editor/media/editor-preview-geometry.js:109-111）→ 归一化分数 × PlayRes 即视频像素。
  残余分歧：stage 盒与视频显示区在异常布局下可能 letterbox（ASS 画布有 offsetX/Y 防御，
  editor-wiring-ass-preview.js:25-76；表情包层没有）——见 §8 风险 10。
- 预览 CSS 语义（web/editor.css:803-831）：层内 flex 纵向堆叠、`gap: 6px`；单图 `:only-child`
  `max-height:100%`（contain 不溢出）；多图每张 `max-height:50%`、不收缩原高向下延伸；
  叠加轨表情包激活时内容区临时加高到 200%（`.has-overlay-sticker`，:814-818）。
- z-order：字幕 Canvas 层（`.subtitle-overlay`，`z-index: 10`，editor.css:716）> 表情包层
  `z-index: 9`（:806）→
  烧录链 overlay 在 `ass` 之前，与预览一致（TASK.md 已确认）。

### 2.5 时间收缩与烧录管线

- `mapGapRemovedTime(sourceMs, gaps)`（web/shared/gap-remove-core.js:1383-1392）：落在被移除区间内的
  时刻被钳到区间起点（映射后 start==end → 该显示窗口消失，应丢弃节点）。
- ASS 侧契约：`buildGapRemovedAss` 用 `mapTime: mapGapRemovedTime`（web/editor/io/editor-export-srt.js:381+
  与 :370），即**请求里的时间已是收缩后时间轴**——方案一/二的 enable 区间遵循同一契约（TASK.md 已定）。
- 服务端 `burn_ass_video()`（server-editor/serve.py:757）：
  - 完整烧录：`-vf ass=filename='burn.ass'`（:819），滤镜只带文件名、cwd 指向输出目录。
  - 去空隙烧录：`_burn_interval_filter()`（:720-754）生成 `select+setpts+ass` 图，**写入 `.filters` 文件、
    经 `-/filter_complex <path>` 传入**（:806-811；FFmpeg 9 无该选项语法时回退
    `-filter_complex_script`，:866-869）→ filter 图长度不构成命令行风险；`select/setpts` 把保留帧
    重映射到收缩时间轴，**overlay 链必须挂在 `setpts` 之后**，enable 秒原样使用
    `mapGapRemovedTime(S)`（§4.4；不要按 seek 原点再换算）。
- 表情包文件与尺寸：`_sticker_rel_path()`（serve.py:2023-2042）防穿越解析（拒绝反斜杠/绝对/`..`，
  限 `STICKER_IMAGE_EXTENSIONS` :128）；`edit.scan_stickers`（edit.py:147-190）扫描时已带
  `width/height`（`image_dimensions`，:178；读不出尺寸的保留条目但无尺寸字段），工程
  `ServerProject.stickers` 里就有每张图的原始像素尺寸——方案一多图精确堆叠/方案二按纵横比定宽
  都有现成数据源（TASK.md 的「不需要读尺寸」结论仅对单图 contain 成立，见 §3.3）。
- 缺字防御：libass 缺字形直接中止烧录（serve.py:843-853、:881-887）——字体回退导致的宽度漂移
  不会以方框形式混进方案二的测量假设里（先炸先报）。

---

## 3. 方案一详解：固定位置

### 3.1 几何换算

```
pxRect = { x: geo.x * PlayResX, y: geo.y * PlayResY,
           w: geo.width * PlayResX, h: geo.height * PlayResY }   // 取整到偶数可选
```

单图 contain 交给 FFmpeg（与 TASK.md 结论一致，前后端都不读图片尺寸）：

```
[N:v]scale=w=W:h=H:force_original_aspect_ratio=decrease[sN];
[base][sN]overlay=x='X+(W-w)/2':y='Y+(H-h)/2':enable='<窗口并集>'[base']
```

`overlay` 的 x/y 支持引用 `w/h`（缩放后主图尺寸），contain+居中零计算。

### 3.2 时间维度

与句子无关。每张图一个节点，`enable='between(t,S1,E1)+between(t,S2,E2)+…'` 窗口并集。
同一 PNG 的多个显示段（head + 多个 ref、主/叠加轨同文件）合并进同一节点，等价于预览
`activeStickersAt` 的按文件去重（editor-sticker-overlay.js:100-103）。

### 3.3 与预览的语义差异（已接受/可收敛）

| 预览行为（editor.css:803-831） | 烧录现状（TASK.md 边界） | 收敛成本 |
| --- | --- | --- |
| 单图 contain 于整层 | 相同 | — |
| 多图每张 contain 到层高 50%，纵向堆叠、`gap:6px` | 每张独立 contain 到整层居中叠放 | 中：需要每张图纵横比（`ServerProject.stickers` 已有）逐张算 contained 高度再叠放；gap 建议 `round(0.006×PlayResY)`（预览的 6px 是窗口相关 CSS px，本就不可换算） |
| 叠加轨激活时内容区加高 200%（向下延伸） | 未复刻 | 低-中：多图时把堆叠中心下移 0.5×层高即可近似 |

多图同屏是边缘场景，先按 TASK.md 记录差异；要收敛时数据（图片尺寸）已在服务端，无新依赖。

### 3.4 管线整合

- 输入：`-i <png>` 每个去重文件一次。**无需 `-loop 1`**：overlay 默认 `eof_action=repeat`
  （次输入 EOF 后重复末帧），单帧图片输入即可覆盖全片；若实测个别构建行为不符，再退回
  `-loop 1 -framerate 2 -t <输出时长>`（framerate 压低可把 25fps 的 PNG 解码开销降一个量级）。
- 节点数 = 去重表情包文件数（典型 ≤20），每帧每节点一次 enable 判断 + 命中时一次 alpha blend。
- filter 图写 `.filters` 文件（现成机制），命令行长度风险只剩 `-i` 参数：每条约 100-200 字符，
  数百个输入才会逼近 Windows ~32K 上限（见 §8 风险 7 的缓解）。
- z-order：`[0:v]→overlay×N→ass`。

### 3.5 去空隙

前端把区间经 `mapGapRemovedTime` 收缩后随请求发送（最终时间轴毫秒）；服务端在 `select/setpts`
之后的收缩时间轴上组装 enable，**原样使用这些毫秒值**（不做 seek 原点换算，见 §4.4）。
映射后 start==end 的窗口直接丢弃。链位置：`select,setpts → overlay×N → ass`。

---

## 4. 方案二详解：显示在字幕第一个字左侧

### 4.1 目标几何定义（建议）

对每条「显示表情包的句子 i」：

```
锚点 anchor、行盒 lines[0] 来自排版计划（PlayRes 像素，已含 slice.scale×cueScale）
stickerRight = anchor.x + lineOffsetX(column, lines[0].width) - gap
stickerCenterY = anchor.y + blockTopY(row, blockHeight) + (lines[0].ascent + lines[0].descent) / 2
```

- `gap` 建议取 `ceil(outline + shadow + max(2, 0.08×fontSize))` —— 即 `assStackCueBounds` 的
  墨盒 padding（ass-canvas-layout.js:233），再加 2-6px 视觉余量。该公式已同时覆盖描边与阴影的
  外扩，低于它必压字。实际推荐再乘安全系数（见 §8 风险 1 的校准实验）。
- 表情包尺寸建议走「目标框 + contain」而不是按图片纵横比推宽：目标框高 = `1.4-1.6×fontSize`
  （与行盒同量级）、宽 = 默认 `4×fontSize`（可后续做成样式项）；FFmpeg
  `scale=…:force_original_aspect_ratio=decrease` 后右对齐 `overlay=x='R-w':y='CY-h/2'`。
  这样**完全不需要图片原始尺寸**，与方案一同一套 overlay 语法，且窄图/宽图都不会失真。

### 4.2 字幕位置怎么知道：三条候选路径

| | P1：onAssPlan 计划推导 | P2：canvas measureText 独立补测 | P3：libass 实测 |
| --- | --- | --- | --- |
| 来源 | `buildAss(onAssPlan)` 缓存的 plan（与预览同一份） | 对每句文本直接调 `MaweAssCanvas.measureRun` + 自行模拟折行/锚点 | 渲染单帧 PNG 检测墨迹边界（libass 无查询 API） |
| 换行一致性 | 非 legacy：**精确**（预折行 runs + `\q2`+`\N`，四方一致）；legacy：近似（见下） | 与 P1 同源（同一 measurer），但要重实现 wrap/锚点 = 复制 `assCreateStackPlan` 一部分 | 理论精确 |
| 与预览一致性 | 高：预览消费同一 plan（`MaweAssPreview.stackPlan`，editor-wiring-ass-preview.js:340） | 中：测量同源但堆叠/缩放状态易脱节 | 与预览脱节 |
| 自动化可行性 | 高（纯函数，Node 可测） | 中 | 低（每句一次 FFmpeg 进程，只能做一次性人工校准） |
| 结论 | **推荐** | 仅作为 P1 的退化备份 | 不进管线 |

P1 的遗留近似点：

1. **legacy 句**（切片内只有一条主字幕，ass-canvas-layout.js:372-378）：预折行 runs 通常不存在
   （仅震动/cueScale≠1 才预折行，:376-377），导出文本无显式 `\N`、无 `\q2`，libass 按
   `WrapStyle: 0`（ass-export.js:512）smart-wrap 自行折行，而 `assCanvasLayoutLines` 只按作者 `\n`
   断行（:134）——超宽 legacy 句的实际首行可能比测量短（居中对齐时左缘右移）。缓解：a) legacy 句
   回退方案一位置；b) 对 legacy 句也调用 `assStackWrappedRuns` 预折行（导出侧同步带上 `\q2`+\N，
   侵入 `emitEvent` 的 `originalText` 捷径，ass-export.js:438）；c) 接受近似 + gap 加大。
2. **手动定位句**（`item.manual`，assOverride.pos）：anchor=保存的 `{x,y}`（:358-362），可同样推导，
   语义自洽（贴着这句话的左侧），无需特判。
3. **组移动（方案移动 `\move`）**：piece 的 from→to 期间首字位置连续变化，固定 x/y 会漂移。
   与震动同策略：**按 motion pieces 冻结采样**——表情包窗口按 piece 边界切分，每片用
   `piece.from`（即 `assStackPieceRootAt(piece, piece.start)`）作为冻结锚点；预览用同一采样保持一致。
   或者更简单：方案二启用时对含表情包的句子禁用组移动（需产品决策）。

### 4.3 坐标如何进 FFmpeg：实现选项对比

| | A：每 (PNG, 句) 一个 overlay 节点 | B：挪字幕（ASS 前置占位） | C：单 overlay + x/y 表达式 |
| --- | --- | --- | --- |
| 做法 | 每个显示窗口一个节点：`[N:v]split=k` 或同一文件多次 `-i`，各自静态 `overlay=x=X:y=Y:enable='between(t,S,E)'` | ASS 导出时把 cue 的定位标签整体右移 Δx（= 表情包目标框宽 + gap），表情包放固定槽位（x 固定、y 逐句），enable 逐句 | 每文件一个节点，`x='if(between(t,a1,b1),X1,if(between(t,a2,b2),X2,…))'`，y 同理 |
| 输入数 | D（split）或 Σ窗口数（多次 `-i`） | D | D |
| 节点/复杂度 | 节点数=Σ(PNG×窗口)，典型几十；链长线性、逻辑 O(1) | 节点数=D，最少 | 节点数=D 最少，但表达式长度 O(句数)、嵌套深度无文档上限 |
| 预览一致性 | 好：位置来自同一计划 | 好（若 shift 在 plan 层做）：plan 已含位移，预览与导出同源 | 好 |
| 主要风险 | 节点多时的逐帧链开销（enable 未命中只是跳过 blend，成本低）；filter 文件体积 | **侵入 ASS 排版**（见下）；字幕不再水平居中，观感变化需产品确认 | 生成器复杂；表达式极长时 FFmpeg 解析耗时/可读性差；调试困难 |
| 结论 | **推荐** | 可选二期模式 | 备选（窗口数极大时再考虑） |

**选项 B 的侵入面明细**（若做，改这些点）：

- 非 legacy：位移加进发射的 `\pos/\move` 坐标（ass-export.js:490-497）。`\q2`+预折行 `\N` 不变 →
  **不会引起重折行**（位移用 `\pos` 而非改边距，折行宽度照旧）。但整组包围盒 `slice.box`
  （ass-canvas-layout.js:445-449）与防出画钳制/整组缩放（:280-282、:454-455）必须计入 Δx，
  否则右移后的组会被错误钳制或缩放——需要在 plan 生成期注入「sticker 位移」而不是发射期补丁。
- legacy：事件无定位标签，需注入 `\pos(anchor.x+Δx, anchor.y)`（anchor 由 `assCanvasAnchorPoint`
  算出）。两个连锁：a) `emitEvent` 对 legacy 主字幕默认携带 `\move` 动画标签
  （ass-export.js:424-428 `includeMove`），与注入 `\pos` 冲突（ASS 一事件一个定位标签），必须
  `includeMove:false` 或把 Δx 烘进 `\move` 坐标生成器（`assAnimationOverrideTags` /
  `assAnimationSliceTags`，牵动共享动画模块）；b) 注入 `\pos` 后该句退出 libass 的样式边距定位语义，
  行为与未注入句并存时的碰撞避免（libass 对 positioned 事件不避让）需验证。
- 表情包位置从同一计划导出（原左缘 = 平移后左缘 − Δx），「两者永不重叠」由构造保证——
  这是 B 相对 A 的真正收益：**不依赖文字测量精度**。代价是排版侵入与观感变化。

### 4.4 去空隙下的收缩

- 时间：与方案一同一条契约——前端 `mapGapRemovedTime` 收缩窗口，服务端**原样使用**，**不得**
  再减 `seek_start`：`mapGapRemovedTime` 的输出已经是「从收缩后视频 0 点起算」的时间轴，
  而 overlay 链挂在 `select/setpts` 之后（serve.py `_burn_interval_filter`），enable 求值的 `t`
  正是这条收缩轴——两端天然对齐。若误按早期报告版本的建议在服务端再减一次 `seek_start`
  （输入 seeking 的时钟原点），表情包会整体提前一个「首个保留区间起点」的时长（时钟混淆；
  Greptile 复审曾指出此文档自相矛盾，已修正表述）。
- 坐标：收缩只影响时间，不影响几何；句子换行在收缩前后一致（文本未变），行盒坐标复用完整时间轴
  的计划即可。注意去空隙导出的 ASS 本身就是收缩时间轴上的计划（`buildGapRemovedAss` 内部
  `mapTime`），方案二应在**同一份** `buildAssPayload` 输出上做计划回调，天然一致。
- 跨被移除区间的表情包窗口：`mapGapRemovedTime` 钳合（start==end → 丢弃）；部分重叠的窗口
  映射后仍连续显示，与字幕 cue 行为一致（同一 mapTime 契约）。
- 首句 `exportStartAtZero` 对齐（ass-export.js:213、editor-export-srt.js:322 只把首条 cue 拉到 0）：
  承载首句表情包的窗口建议应用同一对齐，否则表情包与首句错位 ≤ 首句原起点（通常几十 ms，可接受，
  记录为已知偏差即可）。

### 4.5 编辑器预览一致性

可以做到**共享同一个计算**：

1. 新增纯函数模块（建议 `web/editor/media/editor-sticker-placement.js` 或 shared/utils）：
   `computeStickerPlacements({ plan, stickerIntervals, mode, fontSize/目标框, gapPolicy })`
   → `[{ rel, startMs, endMs, x, y, w, h }]`（PlayRes 像素、最终时间轴）。内部只用
   §2.2/§2.3 的导出原语（`assStackFrame` / `assCanvasLayoutLines` / `assCanvasAlignmentGrid` /
   `assCanvasBlockTopY` / `assCanvasLineOffsetX` + `measureRun` 包装），Node 侧用假 measurer 可测。
2. 烧录请求：`buildRequest()` 里 `MaweStickerOverlay.rebuildStickerIntervals()` +
   `buildAss({ onAssPlan })` → placements 随请求发送（`rel` 经 `_sticker_rel_path` 服务端校验）。
3. 预览：`applyAssSubtitlePreview` 已持有 `cachedAssStackPlan`（editor-wiring-ass-preview.js:262-266），
   同一函数按当前时刻取 placements，用 `assPreviewMetrics` 的 `scaleX/scaleY/offsetX/offsetY`
   （:25-76）换算成 stage CSS 像素驱动 DOM 层——与 Canvas 字幕同一定位路径。
4. 偏差来源收敛后仅剩：a) canvas↔libass 度量差（kerning/hinting/分数步进，量级通常 <1-2% 行宽，
   用 gap 下限吸收；缺字直接中止烧录，见 §2.5）；b) legacy 折行近似（§4.2）；c) 组移动冻结采样
   两侧必须同实现（§4.2 第 3 点）。

### 4.6 管线整合上界

- 节点数上界 = Σ(表情包 × 覆盖句×运动片)。重表情包工程（如 10 个表情包 × 各 20 句）≈ 200 节点：
  filter 图 ~40KB（写文件，无压力）；每帧 200 次 enable 判断 + 命中 blend，CPU 可感但可接受；
  超过 ~500 节点建议合并同图相邻句（相邻句若位置接近可共享一个窗口±容差）或转选项 C。
- 输入数 = 去重 PNG 数（split 模式），不受句数影响——这是选 A+split 而非多次 `-i` 的理由。

---

## 5. 两方案对比表

| 维度 | 方案一：固定位置 | 方案二：字幕首字左侧 |
| --- | --- | --- |
| 几何复杂度 | 低：静态矩形×分辨率 | 中-高：逐句行盒推导（anchor+lines[0]+缩放），legacy/移动/手动定位各有特例 |
| 时间维度 | 每图一个窗口并集 | 逐句窗口；组移动需按 motion piece 冻结采样 |
| 文字测量依赖 | 无 | 有（measureRun）；libass 度量差需 gap 余量吸收；legacy 折行近似 |
| FFmpeg 侧 | 每图 1 节点 + 静态 enable | 选项 A：每(PNG,句)1 节点（推荐）；B/C 备选 |
| 与 ass 滤镜 z-order | 相同（overlay 在前） | 相同 |
| 去空隙收缩 | 区间 mapTime + 减 seek 原点 | 同左；坐标不受影响 |
| 预览一致性 | 高（同一几何契约；多图堆叠有已记录近似） | 可做到共享同一计算（plan→placements 纯函数）；残余度量差 |
| 侵入面 | serve.py 烧录函数 + 请求载荷 + 前端计划收集（TASK.md 条目 1-3） | 方案一全部 + 新 placement 模块 + 烧录请求扩展 + 预览接线；选项 B 另侵入 ass-export/ass-canvas-layout |
| 实现工作量（估） | 小（管线已在 TASK.md 推进） | 中-大（约为方案一的 2-3 倍，主要在几何与预览接线） |
| 主要风险 | 多图堆叠语义近似 | 压字（测量差/legacy 折行/gap 不足）；组移动漂移；节点数失控 |
| 用户价值 | 与预览右上角所见即所得 | 表情包参与叙事（贴着字幕），是新表现力 |

---

## 6. 推荐与分阶段建议

1. **本期：方案一**（即 TASK.md 条目 1-5），按 §3 实现。其中两个建议：
   - 图片输入用单帧 + overlay 默认 `repeatlast`，不必 `-loop 1`（少一条参数，解码一次）；
     冒烟验证若发现个别构建不重复末帧，再退 `-loop 1 -framerate 2`。
   - 去空隙 enable 时间：前端 `mapGapRemovedTime` 收缩后的值即最终时间轴（§4.4），
     服务端原样使用，不要再做 seek 原点换算。（早期版本的「服务端统一减 `seek_start`」
     建议有误，已废弃——实测验证 overlay 挂在 `setpts` 后与前端收缩轴天然对齐。）
2. **下一期前置：placement 纯函数模块 + libass 宽度校准**。先做 §4.5 的共享模块（带假 measurer
   的 Node 测试）和 §8 实验 2 的宽度校准，用数据决定 gap 公式——这一步不依赖方案二上线，
   也能反哺方案一的多图堆叠收敛（同一尺寸数据）。
3. **二期：方案二（选项 A）**。顺序：placement 模块 → 烧录请求 `mode:'cue-left'` 载荷 →
   服务端 overlay 链生成（与方案一同一个生成器，多一个参数化矩形来源）→ 预览 DOM 接线。
4. **选项 B（挪字幕）不进首期**；若用户实测方案二有压字反馈，B 作为「保底不压字」的可选模式
   再评估，届时按 §4.3 的侵入面清单立项。
5. 方案一与方案二共用一个「表情包烧录计划」载荷结构（`mode` + `placements[]`），服务端生成器
   只消费 placements，避免两套命令组装逻辑。

---

## 7. 最小验证实验（均为一次性小命令，未执行）

1. **overlay contain + enable + z-order 语法**（lavfi 假源，秒级）：
   ```
   ffmpeg -y -f lavfi -i color=c=black:s=1280x720:d=4 -i s.png \
     -filter_complex "[1:v]scale=w=300:h=220:force_original_aspect_ratio=decrease[s];\
   [0:v][s]overlay=x='860+(300-w)/2':y='40+(220-h)/2':enable='between(t,1,2.5)'[st];\
   [st]ass=filename='burn.ass'[out]" -map "[out]" -frames:v 100 out.mp4
   ```
   期望：1.0-2.5s 出现居中于目标框的表情包，字幕覆盖其上。
2. **libass ↔ canvas 宽度校准**：导出一条已知 `\pos`、字号、文本的单事件 ASS →
   `ffmpeg -i src -vf ass=… -frames:v 1 frame.png` → 量文字墨迹宽度；同文本同样式跑
   `MaweAssCanvas.measureRun`。偏差率 → 定 §4.1 gap 公式的安全系数。
   （顺带验证 `repeatlast`：把 `-i s.png` 的图片输入窗口拉长到超过 enable 区间，确认图不消失。）
3. **方案二几何回归（Node，无浏览器）**：假 measurer 下构造两条不同宽度句 + 1 表情包，
   断言 `placement.x + placement.w == line0Left - gap`、`placement.y+h/2 == line0 中心`。
4. **去空隙时钟**：构造 1 个 removed gap，断言 enable 秒 == `mapGapRemovedTime(S)`（收缩时间轴，
   服务端原样使用、不再减 seek_start，见 §4.4），且跨 gap 窗口被丢弃。

---

## 8. 风险与待验证清单

1. **canvas↔libass 度量差**（方案二核心）：kerning、hinting、分数 advances、`\fsp` 应用方式差异
   → 压字。缓解：gap 下限（§4.1）+ 实验 2 校准；缺字有硬中止兜底（serve.py:843-853）。
2. **legacy 长句折行差异**：libass `WrapStyle:0` smart-wrap vs 计划不折行 → 首行更短、左缘右移。
   缓解：legacy 句回退方案一位置（最小）或 legacy 也预折行（侵入 emitEvent，ass-export.js:438）。
3. **组移动期间漂移**：`\move` 让首字连续移动，表情包静态 → 按 piece 冻结采样（与震动同策略）或
   方案二对含表情包句禁用组移动（产品决策）。预览与烧录必须用同一采样实现。
4. **手动定位句**：可推导（anchor=assOverride.pos）但与组排布脱节，方案二按各自 anchor 贴左即可；
   需要一条预览/烧录一致用例。
5. **表情包自定义 start/end 跨句**（JSON_SCHEMA.md:751）：窗口中点落进哪条 cue 就用哪条的行盒；
   找不到承载 cue（如落在无字幕区）回退方案一固定几何。
6. **多图同屏 + 方案二**：同一句主+叠加轨各有表情包 → 左侧列垂直堆叠（预览 `gap:6px`、多图 50%
   语义的对应物）；是方案二里最糙的边角，可先限制「方案二每句最多一张，其余回退方案一」。
7. **输入数/命令行长度**：D 个 `-i` 在 Windows ~32K 限制内可容纳数百个；超过后改用单个 ffconcat
   输入（concat demuxer 列出各 PNG）+ `split`。filter 图本体已走 `.filters` 文件（serve.py:806-811）。
8. **GIF/动图**：TASK.md 定为「原样输入自然循环」。待验证：动图 GIF 的帧时钟与 enable 窗口起点
   是否对齐（overlay 以次输入自身 PTS 播放，循环周期不整除窗口时会跳帧/掐头）。静态化兜底：
   输入侧 `-frames:v 1`（或等价）取首帧。
9. **overlay 单帧输入的 `repeatlast` 行为**：默认应重复末帧（eof_action=repeat），待实验 2 顺手
   验证；不符则 `-loop 1 -framerate 2 -t <时长>`。
10. **preview.sticker 的基准盒**：几何手势/层都挂在 `playerStage`（editor-wiring-sticker-preview.js:19、
    editor-preview-geometry.js:109-111），与视频显示区在异常布局（极小窗口/过渡态）下可能出现
    letterbox 分歧（ASS 画布有 offsetX/Y 防御、表情包层没有）。烧录以视频像素为准，预览已按
    stage≈video 设计；记录为既有近似，不在本特性内修。
11. **时间量化差**：ASS 厘秒量化 vs enable 毫秒精度，表情包窗口可±10ms；首句 `exportStartAtZero`
    对齐只作用于字幕（§4.4）。均为可接受偏差，写进验收说明。
12. **载荷安全**：`rel` 全部过 `_sticker_rel_path()`；请求体积上限沿用
    `MAX_ASS_FRAME_TEXT_BYTES*2`（serve.py:2951），placements 数量上限需在服务端设一个
    拒绝阈值（建议 1000，防构造超长 filter 图）。
