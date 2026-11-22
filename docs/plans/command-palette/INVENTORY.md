# 命令面板盘点底稿

MAWE 编辑器现有命令入口与键盘绑定的完整盘点，作为 [实施计划](../COMMAND_PALETTE_PLAN.md) 的命令清单底稿。

- 基线：sparkles-命令面板 worktree，2026-11-18；行号以该工作树为准。
- 口径：固定可点击入口出自 `web/editor-template.html`（构建时注入页面）；右键菜单与部分列表为 JS 动态生成；`boot/editor-bundle.js` 为构建产物不计入。
- 「触发」列给出已核实的门面函数或接线文件；标注「id 接线」表示经 `editor-dom.js` 元素引用 + 领域模块 addEventListener。

## 分类映射与分期归属

| 面板分类 | 覆盖区域 | 约数 | 分期 |
|---|---|---|---|
| 文件与工程 | A 主体按钮、导入/保存菜单 | 10 | P1 |
| 导入导出 | A 各导出菜单与子菜单、补充区导出入口 | 45 | P2 |
| 播放与导航 | H 媒体控制，快捷键包括 Space、J/K/L、左右方向键、Home、End、F、I 和 O | 15 | P1（J/K/L 除外，P2） |
| 字幕编辑 | M2/M3/M6 右键、快捷键 B/C/Delete/T/数字/Enter、I 面板动作 | 35 | P2 |
| 双语与绑定 | M4 右键、G/Shift+G/H、设置区导入/交换 | 10 | P2 |
| 视图与工具 | B 工作区栏、J 波形工具栏、V/R/Q/M | 20 | P1 |
| 工具面板 | C/D/E/F/G 浮动面板动作 | 15 | P1（面板开关）/ P2（面板内动作） |
| 批量与文本 | K 字幕列表工具栏 | 8 | P1 |
| 设置跳转 | 设置窗口各页与定位按钮 | 20 | P1（入口）/ P2（逐页） |
| 帮助跳转 | 帮助各 tab、快速上手 | 13 | P1 |

## 一、固定按钮与菜单入口（194 项）

### A. 顶部主工具栏（50 项）

主体按钮（13）：

| 文字 | id | 触发 |
|---|---|---|
| 新建工程 | `#new-project` | io/editor-wiring-project-inputs.js:99 |
| 打开工程 | `#open-project` | 同上:105 |
| 导入 ▾ | `#import-btn` | 下拉容器 |
| 最近工程（hidden） | `#recent-projects-toggle` | io/editor-server-save.js configureRecentProjects |
| 保存工程（hidden） | `#save-project` | id 接线；快捷键 Ctrl+S → MaweProjectSave.saveCurrentProject |
| 保存 ▾ | `#save-project-menu-btn` | 下拉容器 |
| ↶ 撤销 | `#undo-btn` | MaweHistory.performUndo（Ctrl+Z） |
| ↷ 重做 | `#redo-btn` | MaweHistory.performRedo（Ctrl+Shift+Z） |
| 导出字幕 ▾ | `#subtitle-export-btn` | 下拉容器 |
| 导出工程 | `#download-json` | io/editor-wiring-export-actions.js:327 |
| 烧录视频（hidden） | `#burn-video-export-btn` | io/editor-wiring-burn-video.js:398 |
| 去空隙导出 ▾（hidden） | `#gap-removed-export-btn` | 下拉容器 |
| 更多导出 ▾ | `#extra-export-btn` | 下拉容器 |

导入菜单：`#load-media`（媒体）、`#load-srt`（字幕）、`#load-lrc`（歌词，均 media/editor-wiring-media-inputs.js）。

保存菜单：`#save-project-as`（另存为；Ctrl+Shift+S → saveProjectAsToFile）。

导出字幕菜单（5）：`#download-full-srt`、`#download-multi-srt`（副轨 SRT，hidden）、`#download-bilingual-srt`（双语合并，hidden）、`#download-color-srt`（按颜色拆分，hidden；`MaweExportSrt.downloadColorSrts`）、`#download-full-ass`。

去空隙导出菜单（14）：`#download-gap-removed-srt`、`#download-gap-removed-color-srt`（hidden）、`#download-gap-removed-ass`、`#download-gap-removed-video`、`#download-gap-removed-burn-video`（hidden）；OTIO 子菜单 `#download-gap-removed-otio` / `-otioz` / `-sticker-otio` / `-sticker-otioz` + OTIO 选项跳设置；数据子菜单 `#download-gap-removed-ffconcat` / `-regions-json`。

更多导出菜单（14）：`#download-green-screen-video`（hidden）、`#download-fcp7-export`（`MaweDynamicExports.openFcp7ExportModal`）；OTIO 子菜单 `#download-otio` / `#download-otioz` / `#download-sticker-otio` / `#download-sticker-otioz` + 选项跳设置；动态图形子菜单 `#download-lottie` / `#download-ograf`（各开导出弹窗）；数据子菜单 `#download-plain-text` / `#download-resolve-json`。

### B. 工作区/工具主栏（14 项）

`[data-waveform-tool=select]`（V）、`[data-waveform-tool=razor]`（R）、`#workspace-preset`（工作区选择）、`#layout-edit-toggle`（编辑布局）、`#layout-reset`（重置，hidden）、`#workspace-save` / `#workspace-save-as` / `#workspace-delete`（hidden）、`#workspace-transfer-btn`（配置 ▾，hidden）→ `#workspace-export` / `#workspace-import`、`#project-settings-toggle`、`#editor-settings-toggle`、`#help-toggle`。

### C–G. 浮动工具面板（22 项）

| 面板 | 按钮（id） |
|---|---|
| 静音空隙 | `#gap-remove-help`（跳帮助）、`#gap-remove-advanced-toggle`、`#gap-remove-shrink`（进一步收缩）、`#gap-remove-disable-toggle`、`#gap-remove-disable-button`（禁用字幕）、`#gap-remove-scan`（扫描静音，MaweGapRemoveUi.scanAndRemoveGaps）、`#gap-remove-clear-all`（全部清理，danger） |
| 工程音量 | `#audio-gain-down` / `#audio-gain-up`（±1dB）、`#audio-measure`（重新测量）、`#audio-normalize`（匹配响度，normalizeToTarget）、`#audio-gain-reset` |
| 标记与区段 | `#markers-add-current`（在播放头添加标记）、`#markers-help`、`#markers-batch-select`、`#markers-select-all`、`#markers-delete-selected`（danger） |
| 拼合字幕 | `#auto-merge-user-save`、`#auto-merge-project-save`、`#auto-merge-project-reset`、`#auto-merge-run`（MaweSegmentOps.autoMergeSegments） |
| 延长字幕 | `#subtitle-extend-run`（MaweSegmentOps.extendSubtitleRanges） |

### H. 媒体控制条（6 项）

`#media-play-toggle`（togglePlayback）、`#media-step-back` / `#media-step-forward`（±1000ms）、`#audio-processing-toggle`、`#media-playback-rate`（select，0.5×–2×）、`#media-fullscreen`。

### I. 当前字幕面板（8 项）

`#cue-editor-settings-toggle`、`#cue-panel-prev` / `#cue-panel-next`（navigateCuePanel ∓/±1）、`#cue-panel-split`（splitCuePanelAtCursor）、`#ass-cue-scale-reset` / `#ass-cue-reset`（hidden 区）、`#cue-panel-add-sticker` / `#cue-panel-sticker`（openStickerPicker；后者右键删除）。

### J. 波形工具栏（21 项）

`#ass-frame-quick-open`（hidden）、`#ass-style-quick-open`（hidden）、`#ass-mode-quick-toggle`（ASS 模式开关）、`#waveform-settings-toggle`、`#waveform-settings-help`、`#waveform-scale-down` / `-up`（振幅）、`#waveform-scale-fit`（响度适配）、`#waveform-zoom-out` / `-in`（时间轴）、`[data-waveform-mode=multi]` / `[data-waveform-mode=basic]`、`#multi-subtitle-quick-toggle`（双语）、`#overlay-quick-toggle`（重叠）、`#word-timing-quick-toggle`（Q）、`#markers-quick-toggle`（M）、`#markers-manage`（hidden）、`#gap-remove-manage`、`#auto-merge-manage`、`#subtitle-extend-manage`、`#multi-subtitle-align`（hidden，批量对齐）。

### K. 字幕列表工具栏（6 项 + 动态菜单）

`#cue-list-follow`（跟随中）、`#cue-list-settings-toggle`、`#color-filter-btn`（hidden）、`#timed-text-edit-btn`（MaweTimedTextEdit.openTimedTextEdit）、`#text-process-btn`（openTextProcessModal）、`#filter-over`（仅看超长）。动态：`#color-filter-menu` 由 editor-color-filter.js renderColorFilterMenu 生成（说话人 checkbox、清除过滤、各颜色、全选过滤结果）。

### L. 顶部标题（2 项）

`#media-name` / `#json-name` 点击复制（MaweExportTimeline.copyText）。

## 二、右键菜单（65 项，全部 JS 动态生成）

### M1. 波形空白右键（7）— editor-context-menus.js showWaveformBlankMenu

创建字幕（N）、创建副字幕（N）、创建叠加字幕、按音频位置拆分主/副字幕（B）、添加空隙、填充区间空隙。

### M2. 主字幕右键·单选（20）— showContextMenu

按文字/音频位置拆分（B；Shift+B 渐进、Ctrl+Shift+B 复制拆分）、跳转并播放（select-only 模式）、试听（F）、分配表情包（T）、删除表情包、标记颜色/说话人槽位（色板 1~N）、清除颜色（0）、分配说话人 ▸（动态列表）、选择此人全部字幕、移出颜色组、禁用/启用此条（Alt+点击）、删除字幕、解绑（Shift+G）、左右添加字符 ▸（预设 + 自定义）、高级操作 ▸（字词拆成字幕、转为叠加字幕、调整时间…）。

### M3. 主字幕右键·多选（12）

合并 N 条（C）、替换选中字幕…、延长表情包、分配表情包（T）、色板、分配说话人 ▸、启用/禁用选中、删除 N 条、取消选择（Ctrl+D）、左右添加字符 ▸、高级操作 ▸。

### M4. 副字幕右键（10）— showExtensionContextMenu

在鼠标位置拆分（B）、分配说话人 ▸、合并副字幕块（C）、启用/禁用、删除副字幕、对齐主字幕时间范围（H）、解绑（Shift+G）、与选中主字幕绑定（G）、绑定到主字幕（G）。

### M5. 空隙右键（2）— showGapContextMenu

移除/恢复区段（toggleGapRemoved）、清理空隙（clearGap）。

### M6. 叠加字幕右键（12）— editor-wiring-context-menus.js

编辑文本、跳转并播放、试听、拆分此叠加字幕、转为主字幕、分配表情包、删除表情包、分配说话人 ▸、色板、清除颜色、启用/禁用、删除。

### M7. 其他（2 + 浮窗）

字词块右键：试听（F，auditionWords）、合并选中字词（C）— editor-word-timing.js showMenu；波形标记右键/双击开快编浮窗 — markers.js openMarkerQuickEdit。

## 三、键盘绑定（约 130 条）

### 全局·主文件 editor-wiring-edit-shortcuts.js

| 按键 | 行为 | 门面 | 生效条件 |
|---|---|---|---|
| Space | 播放/暂停（捕获） | MaweMediaPlayback.togglePlayback | 非编辑态、模态/右键关闭、无修饰键 |
| J / K / L | 倍速减/重置/加（旧）或倒放/停止/正放（新） | MaweJklPlayback.* | 非编辑态、非输入焦点 |
| A/D/W/S（±Shift） | 跳上/下一条字幕句首并单选（Shift 追加选择） | MaweSelection.*、revealTime | 非编辑态、无 Ctrl/Meta |
| Ctrl+Shift+A / Ctrl+Shift+D | 与前/后一条粘合 | MaweMergeAdjacent.mergeAdjacentSubtitle(∓/±1) | 非编辑态 |
| Ctrl+A / Ctrl+D | 全选 / 清空选择 | MaweSelection.selectAll / clearSelection | 非编辑态 |
| T | 分配表情包 | MaweStickerPicker.openStickerPicker | 有选中 |
| 0–9 | 颜色槽位（0=清除），overlay/extension/main 分发 | assignOverlayColor / assignTrackColor | 有对应轨选中 |
| Enter | 快速编辑气泡（光标句尾） | openCueQuickEditAtIndex / focusCuePanelText | 裸 Enter、非编辑态 |
| C | 合并（overlay→extension→main 分发） | mergeOverlayCues / mergeExtensionSegments / mergeSegments | 非编辑态 |
| Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | 撤销 / 重做 | MaweHistory.performUndo / performRedo | !historyGuarded() |
| Delete / Backspace | 删除选中（副/叠加/主分发） | deleteExtensionSegments / deleteSegments / deleteOverlayCues | 非输入焦点 |
| V / R | 选择 / 剃刀工具 | waveformEditor.setTool | 波形编辑器存在 |
| Esc | 取消拖动；剃刀时切回选择 | cancelCueDrag / setTool | 无更高优先级处理器时 |
| F | 试听选中（到终点自动停） | MaweMediaPlayback.auditionRange | 有选中 |
| I / O | 跳当前字幕句首/句尾（保持暂停） | MaweNavPreview.seekCurrentCueBoundary | 非编辑态 |
| N | 从键盘时间基准新建字幕（弹快速编辑） | MaweAddCue.addCueAtWaveformTime | 非编辑态 |
| G / Shift+G | 绑定 / 解绑副字幕 | MaweBindingAlign.* | 多重字幕可见 |
| H | 选中副字幕批量对齐主字幕 | alignSelectedExtensionSubtitleRanges | 有副字幕选中 |
| B / Shift+B / Ctrl+Shift+B | 拆分 / 渐进拆分 / 复制拆分（按区域分发） | MaweSplitContext.splitFromContextMenu、openExtensionSplitModal、openOverlaySplitModal | 非编辑态（编辑态内另有分支） |

### 全局·其他文件

| 按键 | 行为 | 位置 |
|---|---|---|
| ←/→（无选中） | 媒体快退/快进（可变步长） | editor-wiring-media-controls.js:53 |
| ←/→（有选中，±Ctrl/Shift） | 微调移动/左边界/右边界/边界贴合 | 同上:77-90 → waveformEditor.adjust*ByKeyboard |
| Home/End | 列表首/末条（最近导航时）或媒体头/尾 | 同上:112 |
| ↑/↓ | 多重字幕切换当前操作轨道 | 同上:156 → switchMultiSubtitleTrack |
| Z / X | 选中（或指针）字幕起点/终点定位到键盘时间基准 | editor-wiring-list-navigation.js:129 |
| Q | 切换字词时间码 | editor-word-timing.js:240 |
| M | 切换标记编辑模式 | editor-wiring-markers.js:13 |
| Ctrl+S / Ctrl+Shift+S | 保存工程 / 另存为（有意覆盖浏览器） | editor-wiring-export-actions.js:337 |
| Ctrl+F / Ctrl+H / F3 | 纯文本编辑弹窗内查找/替换/跳命中（唯一 Ctrl+F） | editor-timed-text-edit.js:1280-1317 |

字词模式捕获层（editor-word-timing.js:259-296，在字幕快捷键之前）：Ctrl+A 全选字词、F 试听字词、C 合并字词、Esc 清空字词选择；其余字幕键对字词选择仅 preventDefault 防误触。

### 编辑态内（约 27 条，命令面板按「编辑态豁免」处理）

内联编辑 Enter/Esc（editor-wiring-keyboard-guards.js，按 configuredEnterAction 分派拆分/保存）；字幕面板文本框 Enter/Esc（editor-wiring-cue-panel.js:122-136）；快速编辑气泡 Enter/Tab/Esc（waveform/cue-quick-edit.js:173-231）；双语拆分弹窗 Tab/Enter/Space/WASD（editor-wiring-media-inputs.js:130-177）；「左右添加字符」Enter（editor-wiring-text-tools.js:21）；设置搜索 ↑↓/Enter（editor-wiring-settings-help.js:183-206）；设置/帮助标签页方向键（同上:258-394）；预览几何与 ASS 定位方向键（editor-preview-geometry.js、editor-wiring-ass-cue-position.js）；输入框步进/FPS/字体组合框（editor-wiring-display-behavior.js、editor-wiring-font-geometry.js）。

### 各模态/浮窗 Esc（分层关闭，右键菜单→浮窗栈顶→各面板）

editor-wiring-context-menus.js:153、editor-floating-panel.js:223、editor-wiring-settings-help.js:308、editor-wiring-gap-panel.js:162、editor-text-process.js:662、editor-wiring-text-tools.js:17、editor-wiring-media-inputs.js:107-121、editor-wiring-export-actions.js:145-249、editor-wiring-project-inputs.js:28、waveform/markers.js:281、editor-onboarding.js:610、editor-split-context.js:33。

## 四、动态入口（Phase 3 惰性 provider）

最近工程列表（editor-server-save.js configureRecentProjects，含失效置灰态）；说话人子菜单（editor-context-menus.js addSpeakerSubmenu）；颜色筛选菜单（editor-color-filter.js renderColorFilterMenu）；左右添加字符预设（WRAP_CHAR_PRESETS）。

## 五、补充：设置窗口动作类按钮（约 32 项，Phase 2 选择性收录）

`#multi-subtitle-import` / `#multi-subtitle-swap`；`#ass-style-manager-open` / `#ass-frame-preview-open`；`#subtitle-font-family-scan` / `#ass-style-local-font-scan`；`#main-ass-style-edit` / `#extension-ass-style-edit`；`[data-settings-tool=gap]`；`[data-settings-export=*]`（绿幕/Lottie/OGraf/FCP7 参数入口）；`#language-toggle`；`#subtitle-color-palette-reset`；`#project-backup-open`；`#sticker-root-read` / `#project-sticker-root-read`；`#split-trim-symbols-reset`；`#merge-join-mode-switch`；ASS 样式库窗口 `#ass-style-new / -duplicate / -delete / -reset / -save` 与方案 `#ass-profile-new`；ASS 预览窗 `#ass-frame-render / -size / -style-edit`。
