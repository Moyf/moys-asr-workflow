# ASS KTV（卡拉 OK）字幕样式支持方案

## 实现状态

已实现并验证（2026-11-19，本分支）：`\k` 整词跳变全链路——样式库数据契约（JS/Python 双端）、导出注入与分片重定基、Canvas 即时预览双色切换、方案/样式 UI（含次色解封）、用户文档与 CHANGELOG。libass `\k` 语义经像素 oracle 实证（翻转在音节窗口起点等六项，见「分片与重定基」），分片重定基经真实导出 ASS 的 libass 实帧验证（红像素 3:2:1:0 精确衰减）。测试：`tests/test_ass_karaoke.mjs`（11 例）、`tests/test_ass_styles.py` 扩展；全量 Python 3313 例中仅 `test_runtime_winsecurity` 2 例环境性失败（主仓库同样失败，与本改动无关）。探针与 E2E 脚本在 `.artifacts/ktv-semantics/`（本地不入库）。未验证边界：真实浏览器中的播放预览与烧录成片待维护者人工验收。

## 结论：好做，中小规模

在现有 ASS 模式上加 KTV 字幕（逐字词按时间码从次色跳变到主色）**可行，且大部分地基已就位**。首期只实现 `\k`（整词跳变），`\kf`（扫过）/`\ko`（描边）留作后续扩展：

- 字词时间码基础设施完备：`web/shared/utils/word-timing.js` 已解决最难的「文本 ↔ items 对齐」问题（标点/空白归属、MASS 成对符号归位、部分覆盖校验、文本编辑后的保守回退）。
- `buildAssPayload`（`web/shared/utils/ass-export.js`）是 ASS 导出的唯一出口：下载 ASS、烧录、帧预览、Canvas 排布计划、PNG/动态导出全部经它。**改一处，全链路生效**。
- `fad` / `pop` / `shake` 提供了完整先例：动画组的数据契约（JS + Python 双端归一化）、样式库 UI、单句标记、分片时钟重定基、像素 oracle 验证，均有模板可抄。
- 样式的 `secondaryColor`（次色）字段在数据模型和 `Style:` 行序列化中已存在，只差解封 UI 与消费逻辑。

唯一的真正难点是**排布分片 / 震动拆分时的 `\k` 时钟重定基**（机制本身，见下）。`\k`-only 基线下它没有边角伪影：整词切换只有「唱了/没唱」两态，重定基是精确解，Canvas 预览也随之退化成逐词双色选择（不再需要扫过裁剪绘制）。

预估总规模 **4–5 个工作日**（含测试、文档与自审）；纯导出（不含预览）约 3 天。将来扩展 `\kf` 时再补扫过的预览裁剪与分片中途伪影说明，属纯增量（导出端只差标签名）。

## 用户明确要求

1. 像 `fad` 一样，为 ASS 字幕模式增加 KTV 字幕样式支持。
2. 带字词时间码的字幕：利用字词时间生成逐字/词填充。
3. 没有字词时间码的字幕：忽略 KTV 样式，保持默认输出（不报错、不写 `\k`）。
4. 维护者已确认（2026-11-19）：首期只做 `\k` 整词跳变；`\kf`/`\ko` 留作后续扩展。

## 现状调查

### 数据面：字词时间码

- 工程契约：`segments[*].items[*] = {text, start, end}`，整数毫秒（帧模式另带成对 `*_frame` 字段）；见 `docs/engineering/JSON_SCHEMA.md` 第三节。
- `getWordTimingEntries(segment, timing)`：过滤无发音内容的 item，校验时间合法、有序、不重叠、落在段范围内，返回可用条目。
- `wordTextsFromSource` / `partialWordTextsFromSource`：把句内标点、空白、MASS 成对符号按既定规则重新分配给相邻字词，只有「可听序列完全匹配」（或最早/最晚匹配一致）时才产出，否则返回 null——这正是 KTV 需要的保守回落条件。
- 两个 helper 都挂在 `window.AsrEditorUtils`（`web/shared/editor-utils.js` 导出 `wordTimingHelpers`），`buildAssPayload` 可直接调用。
- AI 口播整理的局部移除投影（`cleanupMainSegments`）会同步投影 `items` 与 `text`，KTV 基于投影后的段生成即可自然跟随清理结果。

### 导出管线

- `buildAssPayload`（`web/shared/utils/ass-export.js`）：
  - 主轨循环里已完成 `assSentenceAnimationTags`（剥 `>>…<<`、`{{…}}`）与 `parseSentenceShakeMarkers`（剥 `!!…!!`）——KTV 应在这些剥离**之后**的文本上对齐 items。
  - 文本最终由 `assEmphasizedText` 把 inline runs（强调/注释/字体/字号/斜体等）序列化为 `{起始标签}文字{恢复标签}`；说话人前缀 run 插在最前。
  - ASS 模式下事件最终由堆叠排布计划（`assCreateStackPlan`）重新发射：每条字幕可能被拆成多个时间片（`emitEvent(start, end, …)`），fad/pop/`\t` 经 `assAnimationSliceTags` 用负相对时钟跨片连续；震动句按 60ms 强制拆片。
  - legacy 快路径：未切片且 `cueScale === 1` 时直接复用 `item.originalText`（预生成的完整标签串）。
- `editor-export-srt.js` 的 `buildAss()` / `buildGapRemovedAss()` 是编辑器侧唯一调用方；烧录（`editor-wiring-burn-video.js`）与完整 ASS 下载都走它们。`mapTime`（去空隙压缩）只映射绝对时间。

### 动画配置面（fad 先例）

- 样式库 JSON（`moy.asr.ass_styles.v1`，用户级，Launcher 与编辑器共享）：`assProfiles[*].animations = {fad, pop, fade, move, t}`。
- 双端归一化必须同步：`web/shared/utils/ass-style.js` 的 `normalizeAssAnimations` 与 `maw/ass_styles.py` 的 `_normalize_animation`；旧库缺组时归一化补默认值（`pop` 后加的先例），**无需 bump schema version**。
- UI：样式库窗口「ASS 输出方案」表单，`data-ass-animation="组.字段"` 驱动；`fad`/`pop` 的数值参数不随 enabled 联动禁用（单句标记复用），`fade`/`move`/`t` 联动（`editor-wiring-ass-manager.js:328`）。
- 测试基线：`tests/test_ass_styles.py`（Python 归一化）、`tests/test_editor_assets.py`（耦合断言）、`tests/test_ass_animation.mjs`（标签生成）、`tests/test_ass_canvas_layout.mjs`、`tests/test_ass_shake.mjs`、像素 oracle（`tests/helpers/ass-stacking-pixel-oracle.py` + `test_ass_stacking_pixel_oracle.py`，真实 FFmpeg/libass 帧校验）。

### 次色现状

- `Style:` 行序列化（JS `assStyleLine`、Python `ass_style_line`）已输出 SecondaryColour，取自 `style.secondaryColor`。
- UI 字段已存在但隐藏：`web/editor-template.html:1957`，title 为「次色仅在 \k 卡拉 OK 标签中使用，当前未支持」；i18n 表 `web/shared/editor-i18n.js:949` 有对应英文。
- **陷阱**：`assStyleVariant`（ass-export.js）在 text 颜色模式下把 `secondaryColor` 同步成调色板色（因次色此前无消费方）；KTV 开启后必须停止该同步，否则未唱色被破坏。Python 侧 `_inline_style_line` 同步次色=主色，但只在非 ASS 分支（KTV 不涉及）。

### 周边消费者

- `maw/fcp7_png.py`：`_dynamic_windows` 已对 `\k`/`\kf`/`\ko`/`\kt` 做保守采样（整个事件时长），FCP7 PNG 导出天然安全，无需改动。
- 工具箱烧录的 `maw/project_ass_export.py`：刻意只复刻「非 ASS 模式」分支（无动画），KTV 不在该链路范围，维持既有能力差异说明。
- 单帧实际画面预览（`ass-frame.js` → serve.py libass 渲染）：无需改动，自动呈现 KTV 真实效果，是验收利器。

## 设计方案

### 配置与数据契约

`assProfiles[*].animations` 新增 `karaoke` 组：

```json
"karaoke": { "enabled": false }
```

| 字段 | 规则 |
| --- | --- |
| `enabled` | 全局开关，默认 `false`；只控制「有字词时间码的字幕」是否应用，不改变无时间码字幕的输出 |

- 未唱色 = 该字幕生效样式的 `secondaryColor`（样式编辑器解封次色字段后可调）；已唱色 = 主色（`primaryColor`，含颜色字幕/强调 run 的既有覆盖）。
- 与 fad/pop 一样：数值归一化在 JS 与 Python 双端同步补齐；旧库归一化自动补默认组，不 bump 版本。将来扩展 `\kf`/`\ko` 时再加 `mode` 字段（归一化补默认值即可，先例同 `pop` 后加）。
- 单句 MASS 标记（如 `>>…<<`）首期**不**为 KTV 设计对应标记——KTV 的驱动是数据（items），不是文本标记。

### 生效规则（何时 KTV / 何时回落）

对每条主轨字幕独立判断，逐句回落，不整体失败：

1. `profile.animations.karaoke.enabled === true` 且 ASS 模式，才进入 KTV 分支；
2. `getWordTimingEntries(segment, msClock)` 非空，且 `wordTextsFromSource`（或 partial 版）成功把剥离动画标记后的文本分配到各字词——两者都成立才注入 `\k`；
3. 任一条件不成立（无 items、items 与文本不匹配、用户手改文本后失配、帧模式字段缺失等）：该句按现状输出纯文本，**静默回落**；方案预览摘要（`assProfilePreviewSummary`）与文档说明该行为。

首期只处理**主字幕轨**。副字幕、叠加轨与 SRT/非 ASS 模式不消费 KTV（与「原地震动仅解析主字幕」同一取舍）。

### 导出：`\k` 标签注入

1. 在主轨循环内、剥除 `>>…<<` / `{{…}}` / `!!…!!` 之后的 `shakeText` 上计算字词条目与文本分配。
2. 时间换算：字词绝对时间经与字幕相同的 `mapTime` 映射（去空隙导出时同步压缩），再转为相对句首的厘秒翻转时刻；duration = 相邻翻转时刻差（先取整再作差，避免累计漂移），负值钳 0。
3. 注入点在 run 序列化处（`assEmphasizedText`）：给 run 携带字词窗口信息，按字符游标在字词边界插入 `{\kNN}` 类标签；run 的既有覆盖标签（`\1c`/`\fs`/`\fn` 等）与 `\k` 在同一事件中并存——已唱色吃 run 覆盖，未唱色统一为次色，语义正确。
4. 说话人前缀 run 位于首个 `\k` 之前，libass 中不属任何音节，恒为主色，天然不受影响。
5. 句首静默（首个 item 晚于句起点）：在首词前发射一个空引导 `{\kNN}` 推进时钟即可，无需拆 run。
6. `assStyleVariant` 在 karaoke 启用时不再同步 `secondaryColor`，次色保持样式原值。

### 分片与重定基（核心难点）

**为什么一句字幕会被拆成多条 Dialogue**：ASS 模式下同屏字幕自动避碰，新句出现 / 旧句消失会引起位置变化，而一条事件只能有一个 `\pos`，排布引擎只能按「布局是否变化」把一句字幕切成连续时间片（见 `docs/user/ASS_STYLES.md`「排布分片」）；震动句按 60ms 固定拆片。时间片无缝拼接，多数单句在屏的场景不拆片。

**问题**：`\k` 时长从每条事件开头累计。分片后各片时钟从 0 重启，原样复制标签会让卡拉 OK 从头重播（已唱字词退回次色）。fad 用负数时间戳（`\fade(255,0,255,-700,…)`）表达「该相位在事件开始前已发生」，libass 认负数；`\k` 的参数是非负时长，累计时钟无法表达「本事件开始前已翻过」。

**重定基**：按片起点偏移 O 重算每个字词的时长——已翻转的字词发射 `\k0`（片起点即已唱色），未翻转字词按「绝对翻转时刻 − O」重算差值。例：`{\k50}你{\k50}好{\k100}世界`（翻转时刻 0.5 / 1.0 / 2.0s）在句内 0.7s 处被布局变化切分，片 2 发射 `{\k0}你{\k0}好{\k130}世界`。

- 发射某片时已知片起点相对句首的偏移 O。对每个字词：翻转时刻 ≤ O 的发射 `\k0`；窗口包含 O 的当前跨片字词同样发射 `\k0`——`\k` 只有「唱了/没唱」两态，片起点已唱就是正确状态，**这是精确解，无任何伪影**（将来扩展 `\kf` 时此处才出现「扫过中途进度无法恢复」的固有限制）。
- KTV 字幕**不走 `originalText` 快路径**，统一经 runs 路径按片重算标签（fad 的 `assAnimationSliceTags` 同一模式的 karaoke 版本）；「未拆分与拆分前逐字节一致」的性质仅对 KTV 句放弃。
- 震动句（60ms 拆片）与 KTV 叠加同样走精确重定基，无需观感豁免或禁用组合。
- **libass `\k` 语义已用像素 oracle 实证钉死（2026-11-19，探针：`.artifacts/ktv-semantics/probe.py`）**：① 翻转发生在音节**窗口起点**——词 i 的翻转时刻 = 其前所有 `\k` 时长之和，故 duration 挂在当前词上、承载「到下一词翻转的间隔」；② `\k0` = 立即已唱；③ 连续 `\k` 块（空引导）正常推进时钟，句首静默用 `{\kNN}` 空引导实现；④ 首个 `\k` 之前的文本（说话人前缀）恒为主色且不推进时钟；⑤ 未唱字形渲染 SecondaryColour，**run 的 `\1c` 覆盖无效**；已唱字形吃当前 `\1c` 覆盖（含强调色）；⑥ 非 `\k` 的覆盖块不切割音节（同词跨 run 时仅在词首发一次 `\k`）。
- **实施遗留的已知边界（已于 PR #411 外审跟进修复）**：`items` 与文本的可听序列完全失配且子序列匹配存在歧义（如文本 `aba` 对单个 item `a`）时，word-timing 的两种分配都失败、条目保留原始 item 文本。初版实现的贪心映射会取最早出现的同形字（重复字 + 部分时间码同样触发），与「失配回落」的承诺不符；外审（PR #411 评论）复现后，`getWordTimingEntries` 以 `allocated` 标记投影是否唯一成功，卡拉 OK 规划见未标记条目即整句回落普通输出，唯一部分覆盖行为保持不变。

### 即时预览

- `addStackItem` 的 runs 已带字词窗口 → 排布计划与 Canvas 预览共用同一数据。
- 逐帧绘制：按「翻转时刻 ≤ 当前时间」逐词选择主色/次色即可——两态切换与 libass 的 `\k` 行为一致，无需近似（扫过裁剪绘制是将来 `\kf` 扩展才需要的工作）。
- 暂停时的「实际画面渲染」（libass 单帧）不受影响，用于精确核对；Canvas 预览与导出可做到逐帧同节奏。

### UI 变化

- 方案表单新增「卡拉 OK」组：启用开关。
- 样式表单解封「次色」字段（去掉 `hidden` 与「当前未支持」title），仅在 karaoke 启用或用户展开时显示，更新 i18n 文案。
- 方案预览摘要追加 KTV 状态提示（例如「卡拉 OK：整词切换（仅有字词时间码的字幕生效）」）。

## 不做什么（首期边界）

- **只实现 `\k` 整词跳变**；`\kf`（扫过）/`\ko`（描边）留作后续扩展——导出架构完全复用（只差标签名），届时需补扫过的 Canvas 裁剪绘制与分片中途伪影说明。
- 副字幕、叠加轨、SRT 输出、非 ASS 模式不参与。
- 不引入逐句 KTV 文本标记（`>>…<<` 之类）；不引入 `kt`/非整数字词的微调。
- 工具箱 mosp/json 烧录（`project_ass_export.py`）不实现 KTV，维持能力差异说明。
- 不改动 JSON 工程契约（`items` 已有；无需 schema 变更）。

## 实施步骤

1. **语义钉死**：写最小 `.ass` 样本（`\k`、`\k0`、空引导、次色），用像素 oracle 渲染真实帧，确认翻转语义（窗口起点 vs 终点）与 `\k0`/空引导行为；结论写进本方案。
2. **数据契约**：JS `normalizeAssAnimations` + `ASS_DEFAULT_ANIMATIONS`、Python `_animation_defaults` + `_normalize_animation` 加 `karaoke` 组（仅 `enabled`）；`tests/test_ass_styles.py`、`tests/test_editor_assets.py` 补归一化/耦合断言。
3. **导出核心**：主轨循环接 `getWordTimingEntries` + 文本分配；runs 携带字词窗口；`assEmphasizedText` 注入标签；`assStyleVariant` 次色同步豁免。新增 `tests/test_ass_karaoke.mjs`（对齐 `test_ass_shake.mjs` 风格）：注入格式、回落条件、说话人前缀、MASS 混排、去空隙映射。
4. **分片重定基**：发射路径按片偏移重算 duration；KTV 句绕开 originalText 快路径；补切片单测 + 像素 oracle 用例（含震动叠加一例）。
5. **预览**：排布计划透传窗口；Canvas 逐帧双色切换（精确）；`tests/test_ass_canvas_layout.mjs` 断言。
6. **UI + 文档**：样式库表单、次色解封、i18n；`docs/user/ASS_STYLES.md` 新增小节（生效条件、回落行为、`\k` 整词跳变形态）；CHANGELOG 条目。
7. **验证收尾**：`pnpm run build:editor` + `check:editor`、`node --test` 相关 spec、`uv run --no-sync python scripts/run_tests.py`；手动 serve.py 起编辑器，用带字词时间码的工程核对播放预览 ↔ 暂停实际帧 ↔ 导出烧录一致；按仓库惯例提交前自审。

## 测试与验证分层

| 层 | 内容 |
| --- | --- |
| 单元（JS） | 归一化、标签注入、回落、分片重定基、去空隙映射 |
| 单元（Python） | 样式库双端归一化一致 |
| 像素 oracle | `\k` 翻转语义钉死、`\k0`/空引导、分片边界、震动叠加 |
| 浏览器手动 | 播放预览节奏、暂停实际帧、样式库 UI、无时间码工程回落 |
| 烧录抽查 | 一段带 items 的真实工程烧录，核对导出 ASS 与成片 |

## 待维护者确认的决策点

填充方式已确认 `\k` only（2026-11-19）。仍开放：

1. 首期仅主字幕轨是否可接受（副字幕轨按 schema 也可带 items，扩展成本低，但预览/测试面翻倍）。
2. 无字词时间码时的回落是否需要提示（当前建议静默回落 + 方案摘要说明，不打扰普通工程）。
