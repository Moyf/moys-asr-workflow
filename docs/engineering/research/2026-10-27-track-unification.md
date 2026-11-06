# MAW 字幕轨道统一设计调研

> 面向 Moy。结论：先统一“轨道访问、字幕身份、编辑命令和输出计划”，再统一落盘格式；新增拓展字幕应当是 overlay 的注册变体，不再复制一套选择、时间操作和导出分支。

- 调研日期：2026-10-27。
- 代码基线：本目录当前分支 `feat/website-redesign`，HEAD `fbd4b73f`。这不是对其他开发分支或远端最新状态的判断。
- 方法：静态阅读当前源码、工程规范和既有测试断言；没有运行构建、测试、服务、浏览器或 FFmpeg，没有生成便携 HTML。本文不能作为运行结果或视觉一致性验收。
- 操作边界：仓库只读。开始时仅有未跟踪文件 `docs/logs/release1.10.0-beta.1/release-1.9.0-to-main.checklist.md`，没有已跟踪文件的 diff；不接触该文件。不 commit、不 push。
- 证据记法：`仓库相对路径:起始行–结束行`，均针对上述工作树；“提案”“估算”“待决”不是现有实现。指定输出目录在本环境原先不存在，交付时只创建该输出目录及本报告。

## 1. 结论与设计边界

建议把当前三种字幕统一为 `SubtitleTrack`：同样持有稳定 ID、元数据、segments、启用状态、样式引用和呈现策略。主/副/叠加的区别由受约束的 role 与策略描述，绑定独立成为跨轨关系。未来“注释字幕”等拓展能力使用 `role=overlay, variant=annotation`；只增加一个可枚举的内置描述，不再增加第四套容器和全局选择集合。

**统一数据模型不等于统一所有行为。** 当前主字幕带动副字幕，副字幕自行调整不反向带动主字幕；叠加轨独立；ASS 副字幕是固定位置层，叠加轨参加主轨的自动堆叠；逐句位置/缩放只在主字幕上生效。这些已有语义应先显式表达、原样迁移，再由 Moy 决定是否修改。证据：`web/editor/cues/editor-bound-drag.js:112–153`、`web/shared/utils/ass-canvas-layout.js:323–326,353–366,399–442`。

建议分两层落地：

1. **近期：v1 文件格式不动，运行时统一 TrackStore/TrackView。** 三套旧容器经同一适配层枚举；字幕对象仍只保留一份，避免编辑出现双真源。
2. **后续：确认语义并覆盖生产者后，发布 project.v2。** 顶层 `tracks` 成为字幕真源；v1 导入/导出只在边界适配。不要在仍标成 v1 的工程里同时保存两个可编辑的字幕真源。

理由很具体：当前顶层 `segments` 必填，未知 schema 被拒绝；JS 保存按三类字段白名单重建数据，Python 序列化还会强制写当前 schema。单独加个顶层 tracks 字段并不能完成安全迁移。证据：`maw/project.py:225–258`、`web/editor/io/editor-project-load.js:293–328`、`web/editor/io/editor-json-repair.js:17–44,61–128`、`maw/project_io.py:135–162`。

## 2. 当前真实数据模型

### 2.1 三种容器及字段

| 维度 | 主字幕 | 双语副字幕 | 叠加字幕 |
|---|---|---|---|
| 真源位置 | 顶层 `segments[]` | `multi_subtitle.tracks[i].segments[]` | `overlay_track.segments[]` |
| 轨道元数据 | 没有轨道对象；language/split_mode/model 等放工程顶层 | `id, role="extension", name, language, split_mode, source_name, segments` | 仅 `enabled, segments`；没有轨道 ID、name、language |
| 开关/视图 | 主轨没有独立 enabled；字幕可 disabled；主预览 checkbox 独立 | multi 全局 enabled；列表 display_mode 为 main/extension/both；副预览 checkbox 独立 | overlay.enabled 控制文字参与；轨道有内容才算 visible |
| 稳定 ID | 缺失时补 main-001 等 | track 有 ID；cue 缺失补 `<track-id>-segment-001` | cue 缺失补 overlay-001 等 |
| cue 共同字段 | `id,start,end,text,items?,disabled?,start_frame?,end_frame?,speaker?,assOverride?` | 同类字段，items 可选 | 同类字段，保存时 items 默认 [] |
| 颜色/表情 | `color/color_ref,sticker/sticker_ref` | 保存 color/color_ref；当前副轨保存器不写 sticker/sticker_ref | 两组均保存 |
| 引用归属 | ref.headIdx 是主数组下标 | color_ref.headIdx 是所属副轨数组下标 | 两种 headIdx 均是叠加数组内下标 |
| 绑定 | 作为 main_segment_ids 端点 | 作为 track_id + extension_segment_ids 端点 | 不与主/副绑定 |
| 轨内约束 | 按时间排序、不重叠 | 服务端同样要求有序且不重叠 | 有序、不重叠；允许与主轨任意交叠 |
| 当前可管理数量 | 一条 | schema 是数组，UI 默认首条 | 一条 |
| 普通 SRT | 作为主输出，与 enabled overlay 合并 | 独立副字幕 SRT；或显式双语 SRT | 合入普通主 SRT |
| ASS | Layer 0；主样式 | 完整 ASS 模式下 Layer 1；副样式 | Layer 2；继承主样式参与排布 |

字段/约束依据：`docs/engineering/JSON_SCHEMA.md:477–581,642–671,731–786`；实际写出字段依据：`web/editor/io/editor-json-repair.js:25–44,62–128`。服务端不是只检查主轨：`maw/project.py:263–301,540–585`。

注意两处不能从“字段相同”推导出的能力：

- 副轨和叠加轨可以保存 assOverride，**当前布局器只消费 role=main 的 assOverride**。副轨留存此字段主要支持主副交换后恢复定位；已有专门测试。证据：`web/shared/utils/multi-subtitle.js:19–34,89–105,175–184`、`web/shared/utils/ass-canvas-layout.js:323–326`、`tests/test_ass_cue_position.mjs:170–181`。
- JS normalize 对 cue 做 spread，但最终 buildJson 对 cue/track 白名单重新构建；“内存暂时保留未知字段”不等于“保存无损”。未知顶层字段有单独保留机制，嵌套轨道未知字段没有同等保证。证据：`web/editor/io/editor-project-load.js:90–92`、`web/shared/utils/multi-subtitle.js:85–116`、`web/editor/io/editor-json-repair.js:17–44,68–93,105–126`。

### 2.2 主字幕加载与保存

Server 读取工程先 normalize，edit.py 生成页面也 normalize；浏览器载入时将 data.segments 原地写入 DATA.segments，再分别规范化 multi_subtitle 和 overlay_track。主数组的原地更新是既有引用关系的一部分，不能贸然把全局数组替换为另一份副本。证据：`server-editor/serve.py:1344,1410`、`edit.py:404,424`、`web/editor/io/editor-project-load.js:135–139`。

保存链：

```text
当前编辑内容
  → MaweJsonRepair.buildJson（同步帧/毫秒、修复、分别序列化三类字幕）
  → browser file handle / Server 保存
  → Server normalize_project
  → 原子写出工程与备份
```

入口证据：`web/editor/io/editor-json-repair.js:10–16,25–128`、`web/editor/io/editor-project-save.js:103–108,163–193`、`server-editor/serve.py:2355,2847–2865,3048–3064`。当前 schema 常量还影响 `maw/project_io.py:157–162`；v2 不能只改前端 JSON。

时间基准为项目级。无论帧模式还是毫秒模式，持久化 start/end 仍为整数毫秒；帧模式有成对帧字段。同步函数分别遍历主、副、叠加轨并重建 binding offsets。证据：`docs/engineering/JSON_SCHEMA.md:80–84`、`web/editor/cues/editor-timeline.js:66–107,207–228`。轨道统一不能借机把时间改成秒或浮点帧，也不能从显示文字重新猜测字词时间。

### 2.3 双语副字幕的导入、绑定与行映射

自动导入调用 matchSubtitleSegments：

- 开始/结束差值都不超过 300ms，并要求时间区间接触或交叠。
- 候选按总差值、开始差值、原下标排序，贪心选一对一；并不是全局最优匹配算法。
- 未匹配 cue 保留；只为匹配项写绑定，轨道放在 tracks 首位并 enabled=true。
- 当前 Python 一对一约束的 used_main 是整个 multi 级别，因此同一主 cue 不能同时绑定多个副轨；不能仅把 UI 做成多轨就声称支持多语言绑定。

证据：`web/shared/utils/multi-subtitle.js:395–435`、`web/editor/io/editor-multi-import.js:134–190`、`maw/project.py:602–645`。JS 的重建 offset/查绑定主要读取端点数组第一项；服务端严格要求数组长度为 1。证据：`web/shared/utils/multi-subtitle.js:215–227`、`maw/project.py:674–686`。

绑定形态为：

```json
{
  "id": "binding-001",
  "track_id": "translation",
  "main_segment_ids": ["main-001"],
  "extension_segment_ids": ["translation-segment-001"],
  "start_offset_ms": 100,
  "end_offset_ms": -100
}
```

这里 offset 是现有 cue 时间的差值；normalize 会重算，不是另一份独立时间真源。证据：`web/shared/utils/multi-subtitle.js:201–227`、`maw/project.py:647–671`。

双语列表不是按数组下标强行配对：buildMultiDisplayRows 用稳定 ID 找绑定，把未绑定副 cue 插入独立行。列表在 both 模式拼成双列；main/extension 模式只显示对应一侧。叠加行再按 start 插入，同起点落在主/副行之后。证据：`web/shared/utils/multi-subtitle.js:439–466`、`web/editor/cues/editor-cue-panel.js:37–64`。

双语存在两个不同输出语义，迁移时要区分：

1. **编辑器双语 SRT**：按所有主/副 cue 的实际起止边界做时间扫描，组合当前有效文字；不依赖 bindings，也不是逐行 zip。主输入还可能已经合入 overlay。证据：`web/editor/io/editor-export-srt.js:343–353`、`web/shared/utils/srt.js:163–211`。
2. **后处理“合并双语为单字幕”**：校验源/译文 ID、范围一一对应，把双语文本写为一个主 cue 的换行文本，删除 items 和 multi_subtitle。这是有意生成的单轨结果，不能在迁移时按换行重新拆回两轨。证据：`maw/postprocess.py:580–621`。

翻译生产者另有明确“固定首副轨”行为：attach_translation_project 复用 tracks[0] 的身份，整体替换译文，跳过与原文相同的译文，再重建绑定；不是每次 append 新轨。证据：`maw/postprocess_translation.py:11–34,56–98,100–135`、`maw/postprocess_pipeline.py:1293–1326`。

### 2.4 叠加轨的来源与编辑

SRT 导入采用两条不重叠轨的分配规则：cue 先尝试主轨，再尝试 overlay；第三层不能放入就报错。前端把第二层放在返回数组的**非枚举 overlaySegments 属性**上，由调用者取出；后端直接生成 overlay_track。普通 SRT 替换主轨会清掉旧 overlay 和 multi 数据，避免残留。证据：`web/editor/io/editor-project-load.js:346–377,382–410`、`maw/postprocess_io.py:60–107`。

当前叠加编辑已具备：

- 列表选中、独立 panel target、上下文菜单、颜色、禁用、拆分/合并与撤销。
- 波形空白区右键“创建叠加字幕”；主轨占用时仍可创建，检查的是 overlay 自己的占用。
- Ctrl/Cmd 拖动可改道创建 overlay；Shift 拖动允许主↔overlay 转移。
- 转移中重排源轨索引、物化颜色/表情快照；这些不是简单 splice 就能安全完成的操作。

证据：`web/editor/ui/editor-context-menus.js:48–73`、`web/editor/cues/editor-wiring-overlay-actions.js:103–125,128–155,189–240`、`web/editor/media/editor-waveform-init.js:73–93,166–176`、`web/editor/cues/editor-wiring-overlay-transfer.js:18–43,159–195`。对应既有 e2e 入口：`tests/e2e/overlay-track.spec.mjs:117,167,220,390,650,694,1275,1334`。

**Z/X 线索与当前 HEAD 有差异。** 本分支底层 setCueBoundaryToTime 已接受 track 参数，但快捷键上层只收集主/副选择，命中时把目标映射为 extension 或 main，没有 overlay 分支；对应 Z/X 测试也是主/副。不能把“底层能传 overlay”当作“快捷键已接通”。这是静态发现，未做运行复现；可能是其他分支的迭代尚未进入本 HEAD。

证据：`web/editor/cues/editor-nav-preview.js:154–194,208–236`、`web/editor/media/waveform/cue-commands.js:83–145`、`tests/e2e/keyboard-timing.spec.mjs:1324`、`tests/e2e/multi-subtitle.spec.mjs:4197`。

## 3. 编辑、渲染与输出链路的差异

### 3.1 选中与命令：共同基础上仍有三套身份

MaweState 已是共享状态所有者，但选择集合写死为 main/extension/overlay，内容仍是数组下标；panel 保存 kind/index/trackId，副轨选择并不按每个 trackId 分桶。字幕列表和波形 DOM 则分别依赖 data-idx、data-ext-idx、data-overlay-idx。证据：`web/editor/state/editor-state.js:1–62,70–76`、`web/editor/cues/editor-selection.js:47–50,108–123,167–193`、`web/editor/media/waveform/cue-blocks.js:344,415–417,490`。

撤销并不是只存主轨：历史恢复同时恢复 segments/multi_subtitle/overlay_track，按 ID 恢复选中，但保留对旧快照形状的兼容，并原地重填主数组。新模型必须同时替换历史和保存 fingerprint，否则会出现“显示对了，撤销/保存漏了一轨”。证据：`web/editor/state/editor-history.js:39–61,181–195,264–297`、`web/editor/state/editor-state.js:118–149`、`web/editor/io/editor-project-save.js:10–12`。

| 操作 | 主轨 | 副轨 | overlay |
|---|---|---|---|
| 联动选择 | 可按设置选中绑定副 cue | 可补充绑定主 cue，不强行切换编辑焦点 | 独立集合 |
| 普通时间拖动 | 驱动绑定副 cue | 仅修改自身并刷新 offsets | 仅受本轨邻居约束 |
| 主驱动副轨碰撞 | 主范围优先；副轨可能被裁剪、删除并解绑 | 作为 follower 被处理 | 不应继承该副作用 |
| 拆分 | 可使用可靠 items；有绑定时走双语处理 | 语言模式辅助近似拆分/弹窗；items 留存不代表完全对等主轨能力 | 独立 overlay 拆分/合并入口 |
| 跨轨移动 | 可移入 overlay | 当前主要是主副交换 | 可移回主轨可用区间 |
| 逐句 ASS pos/scale | 应用 | 保留但不应用 | 保留但不应用 |
| 禁用 | 可影响绑定副字幕 | 独立编辑入口 | 必须不误用同下标的主副绑定 |

联动与碰撞证据：`web/editor/cues/editor-selection.js:174–193`、`web/editor/cues/editor-bound-drag.js:112–153`、`web/editor/state/editor-multi-subtitle-core.js:450–538,574–603`。禁用独立性现有回归：`tests/e2e/overlay-track.spec.mjs:910`。

这里最危险的迁移不是数组换名，而是把“副轨 follower 冲突处理”泛化成“所有轨道都自动裁剪”。建议把原行为命名为 legacy-follower-reconcile 策略，通用时间命令只在显式绑定策略要求时调用。

### 3.2 波形基础可以复用，lane 和命中仍需统一

waveform.js 用 MAWE.resolve 装配 constants/layout/timing/visibility 等 helper，再向类安装 canvas、cue-blocks、input、cue-drag、cue-commands 等方法。Canvas 负责媒体峰值/波形，字幕块覆盖层主要是 DOM；并不是每一条字幕轨都需要一张独立媒体 canvas。证据：`web/editor/media/waveform.js:5–22,201–218`、`web/editor/media/waveform/canvas.js:9–58`、`web/editor/media/waveform/render.js:176–205`。

可复用点：时间与帧适配、边界约束、波形峰值缓存、可见时间窗口、已有命令事务/刷新。

需要改造的点：

- editor-waveform-init 的 getSegments/getSelection、cross-track snap、各类 activate/select/context-menu 回调都是三路分支。证据：`web/editor/media/editor-waveform-init.js:23–57,61–130`。
- cue-blocks 分开构造主、副、overlay；overlay 有独立 lane/cover 模式，双语模式行高阈值又不同。单轨不足 84px 时 cover，双语用 50+2×laneHeight；不能假设新增一轨只增加一行 CSS。证据：`web/editor/media/waveform/cue-blocks.js:387–425,478–524`。
- trackAtPoint 识别副轨块或下半 lane，其余默认 main；没有通用按 trackId 命中。证据：`web/editor/media/waveform/input.js:186–215`。
- TS Track 类型也是固定字面量联合。证据：`web/editor/media/waveform/waveform-types.d.ts:27`。

方案应增加 LaneLayout（由可见 TrackView 生成矩形和 hit-test），继续共享媒体画布；显示顺序、ASS 叠放顺序、时间列表排序分别表达。

### 3.3 CSS、Canvas ASS、真实 libass 是三条不同呈现链

**CSS 播放预览**：主 cue 按时间找，副 cue 先尝试绑定的主 cue 对应项，再回退本轨时间命中；overlay 自己找活动 cue。主/副预览 checkbox 独立，overlay 启用即参与文字预览。证据：`web/editor/media/editor-playback-loop.js:50–66,140–163`。

**ASS Canvas 预览**：applyAssSubtitlePreview 针对主/副/overlay 三个输入做 revision 缓存，调用 buildAss 获取同一份 stack plan，再 assStackFrame，最后把 frame.items 交给 MaweAssCanvas；ASS 模式隐藏旧 DOM 文本。证据：`web/editor/styles/editor-wiring-ass-preview.js:223–289,292–318`。这已经是统一输出计划的良好基础，建议扩展其 item 来源，不另起一套布局引擎。

**Server 实际画面**：前端 buildAss({preview:true}) 生成完整 ASS，POST ass/timeMs/greenScreen；后端核验当前绑定媒体与 libass 能力，渲染 PNG。该端点当前没有接收表情包 placements，因此不能据文字 ASS 单帧认定表情包视频合成已验收。证据：`web/editor/styles/editor-wiring-ass-frame.js:76–88,205–218`、`server-editor/serve.py:3747–3783`。

### 3.4 样式与层叠：Layer 不等于上下位置

当前 CSS 主样式与副样式在 preview.subtitle / preview.extension_subtitle；副字幕没有自己的几何框。ASS 样式来自本机库，主字幕选 export profile → style，副字幕选 assExtensionStyleId；overlay 无独立 style assignment。证据：`docs/engineering/JSON_SCHEMA.md:428–474`、`web/editor/io/editor-export-srt.js:270–297`、`web/shared/utils/ass-style.js:407–415,488–502`、`maw/ass_styles.py:353–369,448–462`。

当前 ASS 具体语义：

- 输出绘制层固定 main=0、extension=1、overlay=2。证据：`web/shared/utils/ass-export.js:441`。
- overlay 的字形、对齐与左右边距来自主样式，基础 MarginV=主 MarginV+round(1.2×主导出字号)；非 ASS 分支从 80 起算。源码前一条英文注释仍提到 extension 水平样式，但实际变量和中文注释都指向 baseStyle；应以实现与测试为准。证据：`web/shared/utils/ass-export.js:319–347`、`tests/test_editor_utils.mjs:5654–5679`。
- ASS 排版器按 role 排序，但 secondary 是 fixed 层，保持自己的 style anchor，不跟主/overlay 的移动和整组 fit；overlay 参与自动向上排布。证据：`web/shared/utils/ass-canvas-layout.js:353–366,399–442`。
- 部分测试名称仍叫“overlay 在 extension 之上链式锚定”，断言已明确“有无副字幕 overlay 都锚主样式”；不能仅引用测试标题当现状。证据：`tests/test_editor_utils.mjs:5622–5651`。
- 几何无法证明、空间不足等会返回诊断并拒绝正式 ASS 导出，预览可以显示诊断；迁移不能静默夹紧重叠或裁字。证据：`web/shared/utils/ass-canvas-layout.js:334–348,405–432`、`web/shared/utils/ass-export.js:393–398`。

### 3.5 表情包并不是第四条字幕轨

数据仍挂在主/overlay cue 的 sticker/sticker_ref 上；预览收集两类轨道的时间窗口，按文件名去重，叠加归属用于切换 has-overlay-sticker class。当前收集函数直接取 overlay.segments，**没有在收集处按 overlay.enabled 过滤**；总开关另在 renderStickerOverlay 中检查。不要假定“关 overlay 文字”必然同步隐藏其表情。证据：`web/editor/media/editor-sticker-overlay.js:55–78,100–110,131–151`。这是应保留/澄清的现状，尚未运行复现，不在本任务修复。

烧录复用预览区间收集，按 fixed/cue-left 生成图片 placements；cue-left 位置从与 ASS 同源的排版计划推导。Server 将图片 overlay 接在 ASS filter 之前。证据：`web/editor/io/editor-sticker-burn-plan.js:22–51,68–91`、`server-editor/serve.py:861–908`。

推荐本轮仍把 sticker 视为 cue 附件，通过统一轨道枚举收集；独立贴图/视频轨属于另一个产品范围，不为此次字幕统一引入。

### 3.6 导出矩阵与 ASS“解析”的实际边界

| 出口 | 当前取数/行为 | 统一时的注意点 |
|---|---|---|
| 工程 JSON | 三套容器分别序列化 | 统一 serializer/validator，不能只改页面模型 |
| 普通 SRT、颜色 SRT | 主+启用 overlay 按 start 归并；颜色 head 在原轨数组解析 | 合并后不能用新数组下标解释旧 headIdx |
| 副 SRT | 当前副轨自身 segments | 显式 trackId；不把 UI 当前轨默认为所有副轨 |
| 双语 SRT | 主+overlay 作为第一组，副为第二组；时间扫描组合文字 | 与绑定解耦；文案/行序须可配置，保留旧预设 |
| 浏览器 ASS | 主0、副1、叠加2；完整模式共用 stack plan | 扩成 TrackRenderInput[]，保留动画源时钟 |
| 去空隙 ASS/烧录 | 同三类轨统一 mapGapRemovedTime，丢弃完全被移除的 cue | 保持源时间真源，时间变换仅存在导出投影 |
| Python 工程→ASS | 基础样式主+overlay；明确不复刻完整双语/动画/逐句定位 | 共用选轨与基础编译协议，但不能承诺完整前端排版等价 |
| OTIO | 主字幕 marker；overlay 独立字幕 marker 轨与表情视频轨 | 当前构建处没有同等副字幕轨分支，须列入适配矩阵 |
| FCP7、Lottie、OGraf | FCP7 有几种主/副/overlay 选项；Lottie/OGraf 仍主要 main/extension 二选一 | 每个格式声明支持的轨与降级策略，禁止静默漏轨 |

依据：`web/editor/io/editor-wiring-export-context.js:15–29,128–145`、`web/editor/io/editor-export-srt.js:25–39,302–353,393–420`、`web/shared/utils/srt.js:163–211`、`maw/postprocess_io.py:177–221`、`maw/project_ass_export.py:1–13,245–270`、`web/editor/io/editor-export-timeline.js:436–459`、`web/editor/io/editor-dynamic-exports.js:20–31,151–171,273–293`。

本轮未发现“任意 ASS Dialogue/Style → MOSP 三类轨道”的通用反解析器。编辑器导入路由处理 mosp/json、srt、lrc；maw/ass_styles.py 是样式库规范化和 ASS 样式行写出；postprocess_ffmpeg 的 SRT→ASS 借助 FFmpeg，工程→ASS 调用基础 renderer。不要把 ASS 参数解析、样式库导入或 FFmpeg 转换称为“ASS 轨道无损导入”。

证据：`web/editor/io/editor-drag-drop.js:14–26`、`web/editor/io/editor-multi-import.js:233–242`、`maw/ass_styles.py:373–464,534–568`、`maw/postprocess_ffmpeg.py:840–861,898–919`。若未来要求 ASS round-trip，应单立解析、原始标签保留与损失说明设计；不是 track 容器统一的前置条件。

## 4. 提案：统一 Track、Binding、RenderInput

### 4.1 受约束的类型与变体

以下名称是建议，尚未实现：

```ts
type TrackRole = 'main' | 'secondary' | 'overlay';
type TrackVariant = 'plain' | 'translation' | 'annotation'; // 从内置 registry 生成
type CueRef = { track_id: string; segment_id: string };

interface SubtitleTrack {
  id: string;
  role: TrackRole;
  variant: TrackVariant;
  name: string;
  language: string;
  split_mode: 'continuous' | 'word';
  source_name?: string;
  enabled: boolean;
  segments: SubtitleSegment[];
  presentation: {
    z_order: number;
    layout: 'primary' | 'fixed' | 'stack-above';
    anchor_track_id?: string;
    stack_order: number;
  };
  style: {
    inherit_track_id?: string;
    style_id?: string;
    overrides?: Partial<SubtitleStyle>;
  };
  export: { enabled: boolean };
}
```

共同 SubtitleSegment 继续使用 id/start/end/text、可选 items 与成对帧字段、disabled、speaker、assOverride、颜色和表情字段。role 不决定“有没有 items”，是否允许字词编辑由真实时间码和受约束能力决定。初期保留“只有主轨启用逐句定位”的兼容策略，不因同结构就自动扩大能力。

类型职责：

| role / variant | 默认关系与布局 | 是否新核心类型 |
|---|---|---|
| main / plain | 唯一主轨；primary；作为 ASR/AI 默认处理对象 | 是，基础 role |
| secondary / translation（或 plain） | fixed 样式；可以绑定主轨，未绑定也能存在 | 是，基础 role；旧 extension 映射至此 |
| overlay / plain | 独立时间轴；stack-above 主轨；继承主字形 | 是，基础 role |
| overlay / annotation | 与 overlay 同行为，差异由名称、默认样式、导出预设表达 | 否，只加 registry variant |

registry 建议由一份受版本管理的 JSON 描述，在 Python 直接读取、构建器打入 JS；描述允许的 role、label key、默认布局/样式/导出能力。运行时不依赖 Node，不执行工程提供的脚本。不引入任意动态插件系统。

variant 采用稳定字符串枚举，不使用 UI 显示文本作为 key。未知 variant 应保留原始数据并显示“不支持”；不能静默改写成 plain；新编辑命令、受影响导出应返回明确诊断。未知 role 属于核心不兼容结构，应拒绝作为可编辑工程加载。

### 4.2 运行时先用同一访问协议

```text
v1 工程（segments / multi_subtitle / overlay_track）
           ↕ LegacyProjectAdapter
TrackStore + TrackIndex
  ├─ tracks(), getTrack(trackId), getSegments(trackId)
  ├─ resolve(CueRef), selectedRefs(), activeRef
  ├─ commands: move/resize/split/merge/disable/transfer
  └─ projections: list rows / waveform lanes / preview / export
```

约束：

- adapter 暴露原有 cue/数组引用，不复制成第二个可编辑 tracks 数据树。旧 API 暂时是明确兼容门面；每次历史恢复/工程切换后刷新适配视图。
- 选择与面板统一为 CueRef；索引只作 DOM 和算法的短期定位，不作持久身份。命令操作前把 CueRef 解析为当前对象，删除/转轨/撤销后重新解析。
- UI row/lane 使用 data-track-id + data-segment-id；缓存按 trackId/cueId/revision，而不是只有 role 或固定长度三元组。
- 所有变更仍进入 MaweCommands 的同一个事务；一次跨轨动作包含 cue、引用、绑定、selection、dirty、history 和视图失效。取消拖动必须恢复完整事务。
- 统一“遍历全部轨道”与“挑选本操作轨道”为不同接口：ASR 校对默认只主轨；保存要所有轨道；预览/导出按开关和格式能力筛选。不能把原先的 DATA.segments 全部机械替换成 flatten(allTracks)。

### 4.3 绑定模型：关系独立，方向与碰撞策略明确

建议用具名双端点：

```json
{
  "id": "binding-001",
  "kind": "subtitle-pair",
  "source": {"track_id": "main", "segment_id": "main-001"},
  "target": {"track_id": "translation", "segment_id": "translation-segment-001"},
  "timing_policy": "follow-source-delta",
  "conflict_policy": "legacy-follower-reconcile",
  "start_offset_ms": 100,
  "end_offset_ms": -100
}
```

初期只支持主→副一对一，不改多对多。source 编辑带动 target；target 编辑只更新自身和 offsets；是否联动选中是 view 设置。offsets 为派生差值，导入和保存时校验/重算；不与 cue 时间竞争真源。

多语言多副轨必须单独决定“一主可对应每条副轨一个 cue”是否成立。若批准，唯一约束改为 `(source CueRef, target trackId)`，target 仍只被一个 source 绑定；同时查绑定 API 从 find 返回单条改为 list。此处是语义扩展，不能藏在容器重构里。

ID 采用轨内唯一 cueId + 全局唯一 trackId，所有跨轨引用都用完整 CueRef。这样旧文件同 ID 出现在不同数组时不需无故重编号；转轨若目标已有同 cueId，在同一事务中分配新 ID 并重写关联引用。

color_ref/sticker_ref 的 headIdx 初期由 adapter 按所属轨解释；后续独立步骤换成轨内 head_id，再由 v1 serializer 转回 headIdx。重排序、过滤、删段、主副交换都不应再依赖原下标。避免一次迁移同时重写所有附件模型。

### 4.4 层叠、布局、样式继承分别表达

**三个排序维度独立：**

1. `view.track_order` 决定波形 lane 与轨道面板显示顺序。
2. `presentation.z_order` 决定绘制遮挡先后；编译为确定的 ASS Layer。旧三轨保持 0/1/2；新增 overlay 取下一序位；同序位用稳定 trackId 打破平局。
3. `layout + anchor_track_id + stack_order` 决定几何排布；main primary，secondary fixed，overlay stack-above。不要用 Layer 大小推断 y 坐标。

统一 RenderInput 至少带 `CueRef, role, sourceStart/sourceEnd, outputStart/outputEnd, style, layout, zOrder, stackOrder, text/runs`。stack plan 用这些声明参数替换 role 写死映射，继续保留人工定位、fixed 层隔离、空间诊断和源动画时钟。去空隙映射只改 output 范围；不能让切片重新从 0 开始 fade/transform/shake。

**样式解析顺序建议：**

```text
内置默认
 → 工程携带的 style snapshot / style_id
 → 显式 inherit_track_id 的排版字形属性
 → 当前 track overrides
 → cue 允许的 assOverride / MASS 文本样式
 → 自动布局产生的位置与 fit 变换
```

这里是合并规则描述，不是把位置算出来后永久写回 cue：手动 pos 必须绕开自动定位，按既有主轨语义处理。overlay 默认只继承主轨字体、颜色策略等明确白名单，不继承 enabled、绑定、语言；位置由 stack-above 决定。secondary 默认使用独立样式，不自动继承主轨位置。

样式继承应无环，且 anchor/继承目标删除有确定回退（默认回到主轨并给诊断）。CSS 的归一化预览盒和 ASS PlayRes 样式坐标分开保存。当前 ASS 主、副库选择是本机配置；建议 v2 携带所用样式/方案快照，导入时不被同名本地库覆盖。本机库继续是“应用预设”入口。**这会改变跨工程样式联动，需 Moy 决定。**

### 4.5 JSON 与 ASS 兼容策略

**v1 阶段**：旧磁盘形状继续唯一；TrackView 只是运行时门面。只允许旧格式可表达的 1 主+1 活动副+1 overlay。可以隐藏开发验证的新 registry，但不能对用户开放保存不了的 N 轨。

**v2 阶段**：顶层 `schema="moy.asr.project.v2"`，字幕真源为 tracks，main_track_id 指向唯一 main，bindings 使用 CueRef。media/timebase/gap_remove/markers/workspace 等沿用原语义。

简化有效示例（样式与绑定可选）：

```json
{
  "schema": "moy.asr.project.v2",
  "main_track_id": "main",
  "timebase": {"unit": "milliseconds", "fps": 30},
  "tracks": [
    {
      "id": "main", "role": "main", "variant": "plain", "name": "主字幕",
      "language": "zh", "split_mode": "continuous", "enabled": true,
      "presentation": {"z_order": 0, "layout": "primary", "stack_order": 0},
      "style": {"style_id": "main-style"},
      "export": {"enabled": true},
      "segments": [{"id": "main-001", "start": 1000, "end": 3000, "text": "主字幕"}]
    },
    {
      "id": "notes", "role": "overlay", "variant": "annotation", "name": "画面注释",
      "language": "zh", "split_mode": "continuous", "enabled": true,
      "presentation": {"z_order": 2, "layout": "stack-above", "anchor_track_id": "main", "stack_order": 1},
      "style": {"inherit_track_id": "main"},
      "export": {"enabled": true},
      "segments": [{"id": "note-001", "start": 1500, "end": 2500, "text": "补充说明"}]
    }
  ],
  "styles": [{"id": "main-style", "fontName": "Arial", "fontSize": 72, "alignment": 2, "marginV": 80}],
  "bindings": []
}
```

v1→v2 适配主、副、overlay 三种来源；保留 disabled、可选 items、帧字段、speaker、assOverride、颜色/表情、扩展 metadata，保留原文与换行。不能把 main.items 当作译文字词时间，不能推断翻译的对应时间点。

旧程序已拒绝未知顶层 schema，v2 能避免旧编辑器悄悄写坏。新版另存 v1 只在轨道数/策略/样式可表达时允许；不能表达时拒绝，或由用户显式选择有损合并/只导出某轨。**默认不生成“tracks 与 segments 两边都可编辑”的混合工程。**

ASS 保持输出格式：轨道被编译为样式与事件，不把轨道内部结构硬塞到 Dialogue。轨道/样式名做稳定、无冲突映射；Layer 只负责绘制次序。ASS 不是 MOSP 的无损备份；绑定、原词时间、附件不会因输出 ASS 自动保存。若未来加入 ASS 导入，原始 Layer/Style 只作为来源信息，不能据此可靠推断“这是翻译轨”。

Python 基础 ASS 近期只统一“枚举/选轨、格式能力诊断、基础 style/event 编译”的协议。完整 Canvas 测量/动画排版仍由前端计划生成；是否让工具箱消费同一离线渲染计划，或扩充 Python 完整排版，单独决策。

## 5. 拓展性与成本量化

### 5.1 当前耦合规模：静态计数，不是改动承诺

在当前 HEAD 用 rg -l 扫源码得到：

| 查询范围与模式 | 命中文件数 |
|---|---:|
| web/editor + web/shared：`overlay_track\|overlayTrack\|OverlayTrack\|selectedOverlay\|data-overlay-idx` | 38 |
| 同范围：`multi_subtitle\|multiSubtitle\|getActiveExtensionTrack\|selectedExtensionIdxs` | 64 |
| maw + server-editor + edit.py：`overlay_track` | 5 |
| tests：`overlay_track\|overlayTrack\|overlay track\|overlay-track` | 28 |
| tests：`multi_subtitle\|multi-subtitle\|bilingual\|Bilingual` | 58 |

两组有重叠；匹配模式并不穷尽所有语义依赖，**不能相加当作实际需改文件数**。后端五个 overlay 命中文件为 project.py、project_ass_export.py、postprocess_io.py、script_recording_workflow.py、timestamp_alignment.py。其中对齐遍历和录制审查单轨限制都是容易漏掉的边界：`maw/timestamp_alignment.py:864–876`、`maw/script_recording_workflow.py:62–71`。

如果今天复制一套“拓展轨”并接齐独立选中、编辑、预览、保存、普通/ASS 导出，预计会触及 **15–25 个生产文件/约 8–10 条链路**，加 **6–10 组测试**；这是根据下表列出的入口人工估算，不是已经实施的 diff。

### 5.2 一次性统一会改哪些边界

| 链路 | 当前关键文件（代表，不是穷尽） | 统一后归属 |
|---|---|---|
| schema/校验/生产者 | maw/project.py、project_io.py、postprocess_io.py、postprocess_translation.py、postprocess_pipeline.py | Python TrackAdapter/serializer；生产者显式指定轨道 |
| 前端规范化/IO | shared/utils/multi-subtitle.js、io/editor-project-load.js、editor-multi-import.js、editor-json-repair.js、editor-project-save.js | 单一 TrackStore 和导入/保存边界 |
| 选择/面板/历史 | state/editor-state.js、editor-history.js、cues/editor-selection.js、editor-cue-panel.js | CueRef 与统一轨道选择/活动目标 |
| 命令/键盘/菜单 | cues/editor-wiring-overlay-*.js、editor-nav-preview.js、editor-bound-drag.js、ui/editor-context-menus.js | 按能力派发，无新 role 特判 |
| 波形 | media/editor-waveform-init.js、waveform/cue-blocks.js、input.js、cue-drag*.js、cue-commands.js、waveform-types.d.ts | TrackProvider、LaneLayout、通用命中 |
| 样式/预览 | shared/utils/ass-style.js、ass-canvas-layout.js、styles/editor-wiring-ass-preview.js、media/editor-playback-loop.js | TrackRenderInput[] 与统一样式解析 |
| 导出 | shared/utils/ass-export.js、srt.js、io/editor-export-srt.js、editor-export-timeline.js、editor-dynamic-exports.js、maw/project_ass_export.py | 统一选轨→投影→格式 adapter |
| 表情/烧录 | media/editor-sticker-overlay.js、io/editor-sticker-burn-plan.js、server-editor/serve.py | 附件随 CueRef 枚举；统一开关策略 |
| 装配/类型 | shared/editor-utils.js、editor-scripts.txt、editor-modules.json | 新 helper 通过 MAWE.resolve 接线 |

装配依据：`web/shared/editor-utils.js:9–35`、`web/editor-scripts.txt:33–40,54–85,157,171,192`、`web/editor-modules.json:110–111,135–136,190–226`。新增工厂必须登记清单/模块表、构建 bundle，不能只放一个源文件期待自动执行。

### 5.3 统一完成后新增 annotation 的目标成本

假设只要“独立文本+不同默认样式/名称”，不增加网络来源、新素材类型、独立坐标编辑或多对多绑定：

1. **1 条 registry 记录**：variant=annotation，base=overlay，设置名称 key、默认颜色/样式、支持输出。
2. **1 处默认样式资产**（也可以直接复用主轨）。
3. **1 处文案资源**：按项目既有中英文键组织。
4. **1 个 fixture + 2–3 组参数化用例**：保存/重开、编辑/撤销、预览/ASS/SRT 轨道筛选。

目标为 **2–4 个生产文件 + 2–4 个测试/夹具文件，零个通用核心文件修改**；约 **0.5–1.5 人日**，包含有限人工验证。若全链路仍需编辑 selection、waveform、ass-export、Python validator，说明注册点尚未收口。

若新增“独立顶部固定位置”但复用 fixed 布局，预计 **3–5 个生产文件、1–2 人日**；若新布局算法/新的富媒体类型，预计 **5–10+ 个文件、3–5+ 人日**，已超出“普通 overlay 变体”的低成本承诺。这些是设计估算，未做实现验证。

复杂度目标不是“所有事情一个枚举值”：可复用的变体只组合已知能力；新行为必须增加明确策略并测试，不能让 descriptor 变成可执行脚本或任意参数包。

## 6. 分期迁移：每步可独立合并

本节是后续实施建议；本次没有建立分支或修改文件。人日估算含局部验证和审查修订，不含等待 CI、跨平台字体安装和 Moy 决策。阶段可拆分，不建议用一个大 PR 完成。

| 阶段 | 可独立合并的结果 | 文件兼容与合并门槛 | 估算 |
|---|---|---|---:|
| P0 基线夹具/契约 | 建三轨组合、未绑定副轨、颜色/表情组、帧模式、手动 ASS、旧工程的 golden fixtures；记录现有输出 | 不改行为；确定 Z/X 与 sticker 开关的预期；夹具脱敏 | 1–2 人日 |
| P1 统一读取 | JS/Python 加 track 枚举与 CueRef resolver；旧 API 代理同一对象 | v1 落盘不变；所有生产者仍可运行；round-trip 保留字段 | 2–3 人日 |
| P2 统一选中/历史/保存边界 | 用 trackId+cueId 维护选择、active target、快照和 dirty；统一 cue serializer | 对 v1 输出语义相同；覆盖输入未提交、撤销切工程、转轨 ID 冲突 | 3–5 人日 |
| P3 统一时间/结构命令 | move/resize/split/merge/disable/transfer 统一目标协议；保留原主→副策略；Z/X 同一路派发 | 迁移行为与新增修复分开；受影响键盘/拖动/撤销用例过 | 4–6 人日 |
| P4 波形/列表泛化 | TrackProvider 与 LaneLayout；双语成对行仍是显式 list projection | 保留共享波形 canvas、虚拟行与缓存；84px/双语阈值与实测几何验收 | 3–5 人日 |
| P5 样式/渲染/输出统一 | 三路 ASS 输入改成 RenderInput[]；CSS/Canvas/ASS/附件枚举同源；输出格式声明能力 | 保留 legacy ASS 样式/层号和动画时钟；Python 基础出口单列能力；每个格式选轨测试 | 4–6 人日 |
| P6 v2 读写与端到端生产者 | v2 canonical tracks/bindings、v1 adapter、明确降级检查；CLI/Launcher/后处理/Server 同步 | 全部写出入口不能强制盖回 v1；未知 schema 安全拒绝；旧文件不在打开时自动覆写 | 3–5 人日 |
| P7 拓展轨开放与清理 | 开放 N overlay + annotation；按需将 headIdx 换为 head_id；移除不再使用的旧分支 | 增一种变体零改核心的验收；v1 不可表达时阻止无提示降级 | 2–4 人日 |

**总量约 22–36 人日**，是全链路迁移的粗估，不能与“新增一个变体 0.5–1.5 日”混淆。P1–P3 可先取得统一访问和编辑协议收益；P7 中 head_id 也可单独拆 PR，不必与开放变体同次完成。

每阶段保持同一组 golden fixtures 的行为证据；只重跑源码受影响的验证层。前端变化按仓库规则构建 editor bundle、check:editor、typecheck 和对应 Node/e2e；源码日常迁移不生成 blank-editor.html，发布前统一生成。不要为了迁移复用工程而改变媒体、gap_remove 或缓存的真源归属。

## 7. 会碰到的测试与建议验收

以下是**阅读到的断言/用例入口，不是本次通过结果**。

| 测试边界 | 现有证据 | 迁移中必须保留 |
|---|---|---|
| schema 与稳定身份 | tests/test_project_contract.py:57–81,115–183,365–392 | 无 schema 旧工程、未知版本拒绝、稳定 ID、可选 items、offset |
| 轨内约束/引用 | 同文件:591–637,702–737 | 跨轨重叠允许；轨内重叠拒绝；color_ref 指向本轨 |
| JS normalize/行映射/转轨 | tests/test_editor_utils.mjs:6356–6450,6512,6661 | overlay 不偷偷创建双语；转轨次序、快照包含全部轨；主副交换 |
| SRT | tests/test_editor_utils.mjs:6861–6878；tests/test_editor_export_srt.mjs:32–71；tests/test_postprocess.py:1050,1078 | 双语按真实边界合成；原轨颜色上下文；去空隙与零起点 |
| ASS 样式与层 | tests/test_editor_utils.mjs:5394–5432,5622–5694；tests/test_project_ass_export.py:40–59,154–177 | legacy 0/1/2、主样式继承、基本 Python 出口 |
| 布局与动画 | tests/test_ass_canvas_layout.mjs:22–250 | fixed 副轨不跟组缩放/移动；超范围诊断；切片保留原时钟 |
| 人工 pos/scale | tests/test_ass_cue_position.mjs:14–27,65–181 | 未定位旧输出字节兼容；非主轨暂不应用 override；换回主轨恢复 |
| 叠加交互 | tests/e2e/overlay-track.spec.mjs:117,220,390,650,694,751,871,910,1019,1181,1202,1275,1385 | 编辑撤销、转轨标记、表情层、窄 lane、第三层拒绝、拖动性能 |
| 双语绑定/元数据 | tests/e2e/multi-subtitle.spec.mjs:1266,1365,1713,1822,2481,2864,2926,4197,4518；multi-subtitle-metadata.spec.mjs:40,87 | 主副方向性、失败拆分解绑、禁用/颜色保留、三轨去空隙 ASS |
| 像素证据 | tests/e2e/ass-stacking-boundaries.spec.mjs:385,433,445,464,700,717 | 所有活动字幕真有像素、固定副轨稳定、溢出不静默、动画时钟 |
| 翻译生产者 | tests/test_translation_tracks.py:28,75,119,149,173 | 翻译覆盖原固定副轨；失败/取消不破坏旧轨 |
| Server 保存 | tests/test_local_editor_server.py:2909–2970 | 规范化后可保存；副轨真正重叠仍返回 400 |

建议新增的有价值验收：

- 一份含主轨、2 个 overlay 变体的工程：选择一个轨道同 ID 的 cue，不误编辑另一个；重排/删除/转轨后 selection 和 ref 仍正确。
- 一次跨轨拖动或边界操作产生一个 undo；取消/undo 恢复全部 cue、binding、附件、样式/dirty 和焦点。
- v1→运行时→v1 语义等价；v1→v2→读取保留所有支持字段；不可表达的 v2→v1 明确失败。
- registry 枚举全部变体，逐一覆盖默认样式、serialize、预览/ASS 选轨、禁用与未知类型；新增 annotation 不改核心。
- 29.97/59.94 等非整数 FPS、刚好相邻/1ms 圆整边界、去空隙切片、manual main + fixed secondary + 多 overlay 同时存在。
- 新样式继承环、缺失 anchor/style、重复 track ID、悬空 CueRef、转轨目标 ID 碰撞必须可诊断。
- sticker 文字开关与附件开关的决定覆盖预览、单帧、视频烧录；不能只验 ASS 文本。
- 浏览器长工程验证不因轨道枚举每帧 O(全部 cue) 扫描，保留 revision 和可见窗口缓存；涉及 lane 布局须测实际像素间距和截图。

因为本次要求仓库零写入，没有执行会落 .artifacts、bundle、浏览器 trace 或缓存的测试。上述测试存在、断言内容已阅读；是否当前全部通过、FFmpeg/字体跨平台像素是否一致仍未知。

## 8. 风险、未知与需要 Moy 拍板的事项

| 事项 | 代码事实/风险 | 建议默认 | 需要决定的内容 |
|---|---|---|---|
| 拓展轨语义 | 现有 extension 意为双语副轨；新需求指 overlay 变体，容易混名 | 新 role 名 secondary；拓展用 overlay.variant | UI 是否区分“副字幕/翻译”和“拓展字幕” |
| 主轨地位 | ASR/AI、字词、校对、gap provenance 深度依赖主轨；单轨录制证据另有限制 | 保留唯一 main；通用存储不扩大 AI 处理范围 | 是否允许将任意轨提升为主轨；绑定/附件如何随提升变化 |
| 多副轨绑定 | 全 multi 的 used_main 当前只允许绑定一次 | 本轮维持一主一副绑定；多 overlay 先行 | 是否开放“一主对多个不同语言轨”；是否另开需求 |
| follower 碰撞 | 当前可裁剪/删除其他副 cue；并非普通无损移动 | 保留具名 legacy 策略；新 overlay 默认拒绝/钳制本轨冲突 | 是否继续该行为；是否增加用户可见提示 |
| 叠加 Z/X | 当前 HEAD 上层没有 overlay 分派 | 单独记录缺口；统一命令阶段补齐须有回归 | 目标落“当前选中轨”还是“指针最上层命中轨” |
| 样式可携带性 | ASS 库与 assignments 主要是本机配置 | v2 嵌入所用样式快照；库作为显式应用预设 | 要跨工程自动同步，还是工程保存所见即所得 |
| 副/overlay 逐句定位 | 保存字段但布局只消费 main | 初期保留原行为，避免位置突变 | 是否让所有文本轨支持 manual pos/scale，如何碰撞 |
| 开关与附件 | overlay 文字受 enabled 控制，sticker 收集处未过滤该开关 | 明确 enabled、preview_visible、export.enabled 与附件策略 | 关文字轨是否也关表情；预览开关是否影响烧录 |
| 默认导出集合 | 普通 SRT 合主+overlay，副要另选；其他格式能力不同 | 用命名预设保留旧语义，显式 track IDs | 新 annotation 默认是否进入主 SRT、是否单独导出 |
| 兼容旧版 | 旧客户端拒绝 v2；v1 无法表达任意 N overlay | 新版读旧版；受限显式导出 v1；不自动丢轨 | v2 默认写出时机，支持旧版的期限 |
| SRT 第三层 | 当前拒绝；统一后技术上可分配更多 overlay | 先保留拒绝；开放多轨时再改导入策略 | 自动开轨还是询问；是否限制最大轨道数 |
| ASS 导入/后端渲染 | 没有通用轨道反解析，Python renderer 能力较窄 | 本轮不做 ASS 无损导入/完整 Python 排版 | 是否另立项目；工具箱是否消费前端导出计划 |

额外未知：

- 当前分支名指向网站重构，不能据此判断最新 overlay 迭代是否全已合入；本报告不会将用户给出的迭代线索当作当前代码已经实现的事实。
- 既有 schema 文档对副轨保存 sticker 等能力与实际 serializer 并非完全对称；迁移需以 round-trip 夹具确立应保留的字段，不能只复制文档表格。
- 当前布局单测可构造同一副轨多个重叠 cue，而服务端工程契约不允许轨内重叠；这表示 renderer 的输入能力强于 project 合法性，不能用 renderer 测试推导编辑器已支持任意叠层。
- 本报告未评估所有第三方消费者、历史外部工程或远端 CI；无法证明升级 v2 的生态兼容成本。
- 人日与文件数为粗估；P0 语义冻结、P1 适配器原型后应再评估 P3–P6。

## 9. 建议实施顺序与完成定义

优先批准 P0/P1 的方向：**统一轨道访问但维持 v1 唯一真源**，先证明与旧输出等价；Moy 对第 8 节关键语义拍板后再迁移命令和格式。

最终完成应同时满足：

1. 内部所有字幕都能从 TrackStore 枚举，选中/面板/历史使用 CueRef；没有新增 variant 专属的全局数组/选择集合。
2. JS 与 Python 对轨道字段、整数毫秒、帧字段、引用与绑定使用同一契约夹具，保存与重新加载无支持字段损失。
3. CSS、ASS Canvas、浏览器 ASS 导出共用输入与样式解析，真实 libass/视频烧录的能力边界有明确证据；不能用单测替代人工像素/交互层。
4. 新增 annotation 只动登记、默认样式/文案与参数化验收，核心编辑与输出链零修改。
5. v1/v2 边界清晰，旧版本无法静默覆盖新工程，不可表达的降级有明确反馈。

这份调研没有实现上述方案，也没有修复静态发现；它给出当前代码证据、建议契约、迁移边界与待决事项，供后续独立任务使用。
