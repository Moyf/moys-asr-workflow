# 子代理调查报告：拆分样式符号与 items 分配（#12）

只读子代理调查（2026-10-15），主会话抽查核对（`WRAP_CHAR_PRESETS` text-processing.js:436、
`applySplitEdgeTrim` split-trim.js:81 与默认修剪集、`buildSplitPair` splitSubtitleText :434 →
`parts.offset` → `splitItemsAtChar` :437–439、`assMarkedRanges` ass-style.js:66 与 `assSpecialSymbolRule`
默认 both）全部吻合后并入账本。file:line 以核对时 HEAD `1d961b90` 为准。

## 1. 特殊文本样式符号：定义与配对规则

**预设表（符号的唯一权威清单）**：`WRAP_CHAR_PRESETS`，`web/shared/utils/text-processing.js:436-448`
- `**…**` 强调（emphasis）、`++…++` 放大（large）、`--…--` 缩小（small）、`__…__` 下划线、
  `~~…~~` 删除线、`>>…<<` 淡入淡出（行首/行尾**非对称**对）、`//…//` 注释（以上 ass:true，
  仅 ASS 模式展示）；`♪…♪`、`♬…♬`、`[…]` 为纯插入符号（无样式语义）。

**识别/配对规则（解析层）**：`assMarkedRanges`，`web/shared/utils/ass-style.js:66-93`；
runs 装配 `assMarkedRuns`，`ass-style.js:95-144`
- 配对规则：从某位置找到 marker 后用 `indexOf(marker, cursor+width)` 找**下一个相同 marker**
  作为闭端（ass-style.js:78）；找不到成对、或前后紧贴同类单字符时放弃，符号按字面保留
  （ass-style.js:83-88）——孤儿符号的语义后果就在这。
- 宽度由设置决定：`assSpecialSymbolRule` — `none` 不识别 / `double` 仅双符号 `[2]` /
  `both` 单双皆可 `[1,2]`（ass-style.js:98-99；设置默认 `both`，`web/shared/utils/settings.js:67,148-151`）。
- `*` 仅当 `assEmphasisSyntax ∈ {single,double,both}`（ass-style.js:106）；`_` `~` `-` `+`
  各有独立开关（ass-style.js:108-111）；`//` 固定双符号不随规则（ass-style.js:113-118）。
- 句级 fade `>>`/`<<` 的解析独立于上面：`parseSentenceFadeMarkers`，`web/shared/utils/text-processing.js:414-431`
  （`>>` 必须行首、`<<` 必须行尾）。
- 消费方（渲染/导出）：ASS 导出 `web/shared/utils/ass-export.js:63,101-105,199`；
  预览 `web/editor/styles/editor-wiring-ass-preview.js:211`；canvas `web/editor/styles/editor-wiring-ass-canvas.js:109`。
  i18n 帮助文案佐证符号集：`web/shared/editor-i18n.js:731-735`。

## 2. 拆分/切分代码路径

**核心公共函数**（所有入口收敛到这里）：
- `buildSplitPair`：`web/editor/cues/editor-split-core.js:418-473` —— 拆文本用
  `MULTI_SUBTITLE_UTILS.splitSubtitleText(text, safeOffset, mode)`（:434），用返回的 `parts.offset`
  调 `splitItemsAtChar`（:437-446），组装新对（:460）。
- `splitItemsAtChar`：`editor-split-core.js:129-367`；`createSplitSegments`：:373-401；
  `replaceSegmentWithSplit`：:406-415；`cleanSplitItems`：:71-85。
- 文本切分与合法断点：`splitSubtitleText` / `subtitleSplitOffsets` / `nearestSubtitleSplitOffset`，
  `web/shared/utils/word-split.js:46-133`；真正切片+边缘修剪：`cleanSplitTextParts`，
  `web/shared/utils/split-trim.js:88-96`。

**五条提交路径**：
1. **字幕列表光标拆分 / B 键 / 编辑区 Enter**：`splitAtCursor`，`editor-split-core.js:1697-1891`
   （文本 :1743-1744 直接 `applySplitEdgeTrim` 切片；items :1767 `splitItemsAtChar` → :1833-1834
   `cleanSplitItems` → :1840 `createSplitSegments` → :1867 `replaceSegmentWithSplit`）。
   入口 `MaweSplitContext.splitFromContextMenu`，`web/editor/cues/editor-split-context.js:10-80`。
2. **波形时间拆分弹窗（主轨）**：`commitMainWaveformSplit`，`editor-split-core.js:1368-1437`
   （`buildSplitPair` :1393 → `replaceSegmentWithSplit` :1416）。
3. **副字幕拆分**：`commitExtensionSplit`，`editor-split-core.js:1470-1544`（:1489 → :1515）。
4. **主副联动拆分弹窗**：`confirmLinkedSplit`，`editor-split-core.js:1548-1693`
   （主 :1618、副 :1627 各一次 `buildSplitPair` → :1649-1650）。
5. **叠加字幕拆分**：`commitOverlaySplit`，`web/editor/cues/editor-wiring-overlay-split-merge.js:244-300`
   （`MaweSplitCore.buildSplitPair` :267 → :288）。

**剃刀工具**：`web/editor/media/waveform/cue-drag.js:23-35`（razor 点击 → `splitCueAtTime`/
`splitOverlayCueAtTime`）→ `web/editor/media/editor-waveform-init.js:178-183` →
`MaweSplitContext.splitFromContextMenu(idx,0,0,timeMs)`：有可用词级时间码时走 `splitAtCursor`
（split-context.js:50-67），否则 `openMainWaveformSplitModal`（split-context.js:44-49）进路径 2；
overlay 走路径 5。另有一个独立实现 `splitSegmentAtTime`（纯按 item 时间切，
`web/editor/media/waveform/timing.js:424-484`），当前仅被导出（`web/editor/media/waveform.js:64,245`），未接交互。

**AI/批量重新断句**：整轨定时文本编辑走 `web/shared/utils/timed-text-edit.js`（结构化计划
`buildTimedTextStructurePlan`，items 切片 `timedTextItemsSlice` 在 `web/shared/utils/timed-text-core.js:258`），
编辑器侧 `web/editor/cues/editor-timed-text-edit.js`、接线 `web/editor/cues/editor-wiring-text-tools.js:71-73`
（`result.items` 回写）。Launcher 的重新断句是纯文本管线（不携带 items）。

## 3. 拆分时对样式符号的处理与 items 算法

**样式符号：完全没有成对检查/迁移逻辑。** 拆分对文本符号做的唯一处理是「边缘修剪」：
- `applySplitEdgeTrim`：`web/shared/utils/split-trim.js:81-85`，修剪空白 + 用户配置符号
  （默认 `，。、！？,.`，`splitTrimSymbols` 设置 `settings.js:64`；主符号表 `split-trim.js:9-15`）。
  `++`/`**` 等样式符号**不在默认修剪集**，也不会被搬移——所以「解说++」留在左段尾部、
  「号角哥++」留在右段（`++` 未闭合时 `assMarkedRanges` 匹配失败，按字面渲染）。
- 加剧因素：单词模式下 `+` 属于可断连接符（`WORD_SPLIT_CONNECTOR_RE` 含 `\p{Sm}`，`word-split.js:9`，
  connector gap 逻辑 `editor-split-core.js:976-1011`），即允许在 `++` 中间下刀；连续模式任意字符间可拆。

**items 分配算法**（`splitItemsAtChar`，`editor-split-core.js:129-367`）：
1. `alignItemsToText(text, items)`（`web/shared/utils/split-alignment.js:92-164`）：顺序保持最优匹配 DP，
   把每个 item 文本对齐到原文 `textStart/textEnd`（超阈值直接放弃对齐 :110-114）。
2. 切点落在词内：item 文本按字符切成两半，时间按**字符占比在 item 时间区间内线性插值**
   （`editor-split-core.js:262-287`，插值公式 :269-270）。
3. 切点在词间：吸附左词 end/右词 start；两词间有真实静音空隙时非对称边界 `leftEndMs/rightStartMs`（:241-254）。
4. 失配 item（人工改写词）：按相邻对齐锚点的「文字空位」与刀点相对位置定侧 + 时间就近 +
   边界扩展（:156-164、:303-343；`placeUnalignedSplitItems`，split-alignment.js:176-231）。
5. 无 items 回退：按字符占比对段时长线性插值（`splitTimeForTextTextOffset`→ :15-22；
   时间反推字符 `splitCharOffsetAtTime`，split-alignment.js:51-83）。

即：**文本按 offset 切 + trim；items 按「文本对齐 → 词内字符占比插值 → 词外时间归侧」**，与样式符号无关。

## 4. 合并路径的先例

- `MaweSegmentOps.mergeSegments`：`web/editor/cues/editor-segment-ops.js:51-70` —— 文本
  `joinSegmentTexts`（纯拼接，`web/shared/utils/text-metrics.js:30-32`）+
  `items: segs.flatMap(s => s.items || [])`（:61）；副字幕 :74-90；叠加字幕 `mergeOverlaySegments`，
  `editor-wiring-overlay-split-merge.js:337-373`（items flatMap :373）。**同样没有样式符号处理**
  （合并甚至可能产生 `…++++…`，目前无人处理）。
- 可复用的「跨行引用成对迁移」先例：sticker/color 组引用 —— 拆分时 `replaceSegmentWithSplit`
  重映射 `headIdx`（`editor-split-core.js:406-415`）、合并时 `resolveMergedGroupInheritance` +
  `splitGroupsAtCutPoints` + `remapRef`（`editor-segment-ops.js:41-46, 95-103, 123-140`）。
  这是代码库中最接近「符号/归属跨行迁移」的机制。
- 「文本改动后同步 items 文字」先例：`syncTextChange` → `planWordTimingTextSync`
  （`web/editor/cues/editor-word-timing.js:79-101`，等长替换）。
- 「行首/行尾锚定符号」解析先例：`parseSentenceFadeMarkers`（text-processing.js:414-431）。

## 5. 挂载点建议（符号随配对侧迁移 + items 同步）

所有入口的文本拆分收敛到**两个点**，在这里做即可覆盖 main/extension/linked/overlay/剃刀/列表
全部路径，无需在 5 个 commit 函数里重复：

1. **弹窗系路径**：在 `buildSplitPair`（`editor-split-core.js:418-473`）消费 `splitSubtitleText`
   的返回处（:432-434）。更底层的单点是 `cleanSplitTextParts`（`web/shared/utils/split-trim.js:88-96`）/
   `splitSubtitleText`（`word-split.js:110-120`）返回的 `{left, right, offset}` 之后追加一步
   「成对符号迁移」纯函数：若 left 以未闭合 opener（`++`/`**`/`--`/`__`/`~~`/`//`）结尾，
   把它挪到 right 头部（得到「我是今天的解说」+「++号角哥++」）。**迁移必须同步修正返回的
   `offset`**（left 变短），这样 `splitItemsAtChar`（:437-442 用 `parts.offset`）的文本对齐自动把
   「++」归到右段词前——items 一般不含符号字符，对齐是 `indexOf(item.text)`，无需新算法；
   建议加一条防御：刀点落在符号上时 `inside` 词内插值不应把符号字符算进词文本占比
   （`editor-split-core.js:188-190, 262-287`）。
2. **光标路径**：`splitAtCursor` 不经过 `splitSubtitleText`，在 `editor-split-core.js:1743-1744`
   （`applySplitEdgeTrim` 两个 slice 处）调用同一个迁移 helper，并用迁移后的 offset 重算
   `splitItemsAtChar`（:1767）。
3. 迁移 helper 建议放 `web/shared/utils/`（split-trim.js 同层或 text-processing.js），复用
   `assMarkedRanges` 的配对语义（ass-style.js:66-93）；并按 `assSpecialSymbolRule`/各 `ass*Enabled`
   开关 gate（settings.js:67,148-151）——`none` 时不动符号，与识别规则保持一致。fade `>>…<<`
   是句级标记需单独规则（`>>` 归首行行首、`<<` 归末行行尾，或产品决策为不迁移）；
   `duplicateText`/`progressive` 模式两侧含全文，本身无孤儿问题，应跳过迁移。
4. **不建议**：在每个 `commit*Split`（5 处）里实现（重复）；也不建议用 `splitTrimSymbols` 加符号
   来解决（那是删除不是迁移）；merge 侧（`joinSegmentTexts`）单点集中，如需清理重复符号可后续在
   `editor-segment-ops.js:57-61` 一处加，但非本次必须。
