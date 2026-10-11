# TEST_FEEDBACK_MARKERS_UX

任务：Marker / Region 功能第一轮 UX 调整（用户实机试用后反馈，共 10 项）。本文件是持久化进度账本。

状态约定：`待处理` / `进行中` / `已修复` / `仅说明` / `阻塞`。

## 事实基线

- 本地 main：`83876c6`（= origin/main `41d5ff7` + 本地时间码 tab commit），markers 功能已就位。
- 工作区另有用户 WIP（5 文件：字体提示文案 + CHANGELOG），与本任务文件无重叠；`tests/test_editor_utils.mjs`、`CHANGELOG.md` 需要共编辑，只加自己的行，不动用户行。
- `blank-editor.html` 按约定不重生成。

## 任务清单

| # | 事项 | 状态 | 备注 |
|---|---|---|---|
| 1 | 待复核闪烁样式改为「无 border / 有 border」硬切换（steps），去掉渐进扩散 | 已修复 | `web/waveform.css`：`marker-review-blink` steps(1) 硬切换 amber border 有/无 |
| 2 | 列表点击只定位（不展开编辑框）；每项新增「编辑」按钮，点击才展开编辑卡片 | 已修复 | `editor-markers-panel.js`：main click 只选中+定位；新增 `.markers-item-edit` 按钮 + `editingMarkerId` 状态；编辑卡片按 `editingMarkerId` 展开（含过滤失效清理） |
| 3 | 单点 marker 显示名称文本（在标记旁边） | 已修复 | `waveform/markers.js` 有 name 即渲染 label；`.point .waveform-marker-label` 定位旗标右侧 |
| 4 | 去掉单点 marker 的圆形圆点（`::before`） | 已修复 | 删除 `.waveform-marker-item.point::before` |
| 5 | track / marker / region 整体增高，label 文字放大到 10px | 已修复 | track 16px、point 16px、region 12px(top 2px)；label 10px |
| 6 | `waveform-row-time` 位置下移，避免被标记轨道遮挡 | 已修复 | top 5px → 22px（轨道 16px + 6px 间隔） |
| 7 | 波形上双击 marker 弹出小型编辑浮层（名称/颜色/复核），点击其他处或 Esc 关闭 | 已修复 | `waveform/markers.js`：`openMarkerQuickEdit`/`syncMarkerQuickEdit`/`positionMarkerQuickEdit`/`closeMarkerQuickEdit`；挂载于滚动内容层、随内容滚动；数据经 `options.onMarkerQuickEditFields`（editor-waveform-init 接线到 updateMarkerFields）；样式 `.waveform-marker-quick-edit` |
| 9 | 颜色筛选下拉与色板 title：预设颜色显示中文名称；默认色板对齐达芬奇 marker 颜色，保持 8 个、区分度高 | 已修复 | 官方 16 色序前 8：蓝#3e63dd/青#00a2c7/绿#46a758/黄#f5d90a/红#e5484d/粉#ef5da8/紫#8e4ec6/品红#d6409f（默认色=Resolve Blue）；`MARKER_PRESET_COLOR_LABELS` + `markerPresetColorLabel()`；筛选下拉 option 与 swatch title 均显示名称 |
| 10 | review 是唯一特殊字段、可撤销、两值（已确认）。改为编辑框左下角三态 toggle：无 → 待复核 → 已确认 → 无，替换「确认复核」按钮 | 已修复 | 回答：review 确实是唯一特殊字段且一直可撤销（走 markers 历史）；原实现是 pending/confirmed 两值。现 `updateMarkerFields` 支持 `review: 'pending'\|'confirmed'\|null`（保留 reason）；`nextMarkerReviewStatus`/`markerReviewStatusLabel` 工具函数；编辑卡左下角 `.markers-review-toggle`（pending 琥珀、confirmed 绿）；`confirmReview` 已删除 |
| 11 | 编辑框时间行增加「时长 ms」，与终点双向联动（终点 = 起点 + 时长） | 已修复 | `.markers-time-row` 3 列；时长 change → `end = start + round(duration)`；终点/起点变化经重渲染联动；留空时长 = 退化为单点 |

## 第二轮（用户实机后追加）

| # | 事项 | 状态 | 备注 |
|---|---|---|---|
| R1 | 小弹窗：复核按钮移到左下角 + 状态背景色与编辑窗一致；去掉「复核：」前缀（两个编辑窗）；右下角加【删除】 | 已修复 | popup 底行复用 `.markers-item-actions`（toggle margin-right:auto 居左 + danger 删除居右）；新增 `options.onMarkerQuickEditDelete`；两处 toggle 文案均为纯状态名 |
| R2 | 待复核闪烁动画去掉：左侧黄色问号；已确认勾换绿色；已确认的标记轨道上隐藏名称 label | 已修复 | 删除 blink keyframes；`::before` "?"（amber，item 左外侧）；`::after` "✓" 换 `var(--green)`；`appendMarkerElement` label 条件排除 confirmed |
| R3 | 「定位试听」= 跳转并播放 | 已修复 | `locateMarker(markerId, { play })`；按钮传 `play: true` 并提示「已定位到 … 并播放」；列表项点击 / 波形点击保持只跳转 |
| R4 | 确认 marker&region 是否已包含在 OTIO 导出 → 已按需求实现 | 已修复 | 结论原为「未包含」（marker 全部来自字幕）。现实现：`buildMarkerFieldMarkers` 把工程 markers/regions 写入同一 clip（名称→name、备注→comment、色板 hex→OTIO 命名色 1:1 映射 + 天蓝→BLUE/可可→ORANGE 就近归并、单点 1 帧、区间裁剪与坐标系同字幕标记）；字幕标记备注标注「MAW 字幕」（名称=字幕文本不变）；新开关 `otioExportIncludeMarkerRegions` 默认开，两个 OTIO 子菜单各加「将标记与区段写入」复选框（`data-otio-export-option="markerRegions"`） |
| R5 | 摘要与搜索框整合成一行（摘要左、搜索右），位于「在播放头添加标记」下方；过滤后摘要显示过滤结果 | 已修复 | `editor-template.html` 结构调整（搜索并入 `markers-summary-row`，原「搜索」caption 移除、input 加 aria-label）；`renderSummary(markers, visible)` 按 filter 生效显示「共 N 项…」/「过滤 N 项…」/「没有符合当前过滤条件的标记。」 |
| R6 | 预设色板 +2 | 已修复 | 查证：OTIO 官方 Marker 色集 11 色（PINK RED ORANGE YELLOW GREEN CYAN BLUE PURPLE MAGENTA BLACK WHITE），与达芬奇 16 色的名称级交集 = 蓝/青/绿/黄/红/粉/紫 + 品红（Fuchsia≈Magenta），即原 8 色已用尽交集；新增达芬奇扩展色板中区分度最高的**天蓝 #45a3f5 / 可可 #a06e3b**（导出 OTIO 按最近色相归并）；面板与浮层色板均为 10 色 |
| R7 | waveform-row-time 下移改为按行智能判断 | 已修复 | `appendMarkerTrack` 按行检测 `markerVisibleRange` 有交集才 toggle `.waveform-row-has-markers`；CSS 基础 top 回 5px，仅命中行 22px |
| R8 | 列表项双击 = 展开 / 收起编辑框 | 已修复 | `.markers-item-main` dblclick toggle `editingMarkerId` + render |

### 第二轮实测验收（server-editor + Paseo browser evaluate）

- Node 359 项全过（新增 OTIO marker 导出功能测试：颜色映射/名称备注/单点 1 帧/区间裁剪/缺省读工程/字幕「MAW 字幕」备注）· Python 1741 项通过（8 跳过）· `git diff --check` 干净。
- OTIO 端到端（浏览器 stub 媒体 30s 实测 `buildSourceOtio`）：clip.markers 共 3 个 = 字幕「大家好」（备注「MAW 字幕」）+ 「开场标记/重点强调/RED/1 帧」+ 区段（备注「音乐区段」/ORANGE/360 帧）；关闭 `otioExportIncludeMarkerRegions` 后仅剩字幕标记，重开恢复。
- R7：行 A（0–30s，含标记）row-time top 实测 22px；行 B（30–80s，无标记）top 5px；行类名 toggle 正确。
- R2：pending `?` content "?"（amber）、`animation: none`（闪烁已除）；confirmed `✓` 绿色（--green）；confirmed label 不渲染；普通 / 待复核 label 保留。
- R1：popup 3 块结构；toggle 文案「待复核」无前缀、pending 琥珀背景实测 rgb(212,154,74)；toggle 居左对齐浮层左缘、删除居右；点删除 → marker 移除 + 浮层关闭。
- R3：stub player 实测——无 play 参数只跳转（currentTime=3，未播放）；`{play:true}` 跳转后播放。
- R5：摘要与搜索同排（top 相差 <8px）、摘要左搜索右（间距 8px）、位于添加按钮下方；「共 2 项：标记 1 · 区段 1」→ 搜索「开场」→「过滤 1 项：标记 1 · 区段 0」→ 无命中提示 → 清空恢复。
- R6：面板 / 浮层色板均 10 色，末两位 title「天蓝」「可可」。
- R8：双击展开 → 再双击收起。
- 未覆盖：真实媒体加载下的波形渲染（同前，假行替代）；跨行指针拖动（同前）。

## 阶段汇总

- （开始）基线确认：主工作区 markers 功能为 #160 合并版；用户 WIP 在场需保留。
- （完成 2026-09-30）10 项全部落地：utils（色板/标签/三态循环）→ waveform.css（高度/圆点/label/闪烁/row-time/快速浮层）→ waveform/markers.js（point label + 双击浮层）→ editor-marker-editing.js（review 三态字段）→ panel（点击仅定位/编辑按钮/颜色名/时长列/复核 toggle）→ editor.css（grid 布局/编辑按钮/toggle 样式）。
- （实测验收 2026-09-30，server-editor + Paseo browser evaluate）
  - Node 358 项全过（新增 2 项：三态循环 / 中文色名）；Python 全量 1741 项通过（8 跳过）；`git diff --check` 干净。
  - 波形轨：track/point 实测 15.99px（=16px，页面缩放舍入）、region 11.99px（top 2px）；point `::before` content "none"（圆点已除）；point label 10px、位于旗标右侧（left≈6px），region label 10px 白字；row-time top 实测 22px。
  - 待复核闪烁：animation `marker-review-blink 1.1s steps(1)`，CSSOM 实测 keyframes 为「0–55% amber border / 56–100% none」硬切换。
  - 双击浮层：gap 8px / padding 9px / 宽 208px / z-index 30；块间垂直间距实测 8px；8 色板 title 全为中文名（蓝/青/绿/黄/红/粉/紫/品红）、active 态正确；复核 toggle 循环「待复核→已确认」并写盘；点击外部关闭 ✓、Esc 关闭 ✓、真实 dblclick 事件路径 ✓、名称 change 提交 ✓；浮层在滚动内容层内不越界。
  - 管理窗：点击列表项只定位+高亮（编辑框不再展开）；「编辑」按钮展开（main→edit 间距 4px 属同行内边距，编辑卡内部块间距实测 8px）；时间行 3 列（起点/终点/时长，各 130px）；时长 8000 → 终点 28000 联动 ✓、改回 6000 → 26000 ✓；复核 toggle 在操作行左下角（left 与行首对齐），循环 待复核→已确认→无→待复核 ✓，badge 同步 ✓。
  - 未覆盖：真实媒体加载下的波形渲染（上传桥接 500，用 dataset 假行替代验证；marker 轨道是纯 DOM 层，样式与交互不受影响）；跨行指针拖动仍无浏览器模拟（同前次验收边界）。
- （备注）用户在验收期间自行提交了字体文案 WIP（ef0b654），工作区现仅含本任务改动；`blank-editor.html` 按约定未重生成。
