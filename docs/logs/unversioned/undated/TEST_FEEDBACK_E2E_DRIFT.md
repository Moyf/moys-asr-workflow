# 干净 HEAD 复现的 e2e 失败清单（triage 与修复）

来源：上一个 agent 移交的失败清单。已按其对照实验方法确认：全部在干净 HEAD `d129dd47` 检出上复现，非并行任务引入。本任务只处理 multi-subtitle（4 个）与 waveform-history（6 个）；layout-feedback 的 1 个在 Launcher 域，由正在改该区域的 agent 处理，此处仅登记。

运行方式（同 beta7 既有结论）：

```powershell
$env:MAW_E2E_PYTHON='.venv\Scripts\python.exe'
npx playwright test tests/e2e/multi-subtitle.spec.mjs tests/e2e/waveform-history.spec.mjs --grep "<用例名>" --project=chromium
```

## 处理清单

| 编号 | 位置 | 现象 | 定性 | 决定 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | multi-subtitle.spec.mjs:117 | 拆分提示断言「会自动按可用时间码拆分」，模板实际是「自动按可用时间码拆分；关闭后将打开拆分弹窗，手动拆分。」 | 测试漂移：`web/editor-template.html:1073` 与 `blank-editor.html` 一致，i18n 新旧映射并存 | 更新测试断言为新文案 | 已修复 |
| 2 | multi-subtitle.spec.mjs:339 | `.multi-cue-column.main` paddingLeft 期望 3px 实际 8px | 测试漂移：`c14a9981`「双轨主列 dirty 兜底加宽」刻意 3px→8px（`web/editor.css:2354`） | 更新测试为 8px；保留「文字不压 3px 琥珀条」的几何断言 | 已修复 |
| 3 | multi-subtitle.spec.mjs:861 | 文本处理后找不到首行 `.multi-cue-column.main .text` | 测试定位错误（既有）：未绑定副字幕夹具本就渲染 2 行，第 1 行是副字幕行（主列为空占位 `—`）；探针证实处理结果正确（主 `main cue`、副 `X extension cue`） | 改为过滤「主列有 .text 的行」断言主列，副列断言保留在原行 | 已修复 |
| 4 | multi-subtitle.spec.mjs:3670 | 联动拆分 meta 断言 00:03.200，实际 00:02.800 | 测试漂移：beta7 任务 42 方案 B（用户确认）「默认吸附从 next.start 翻转为 prev.end」，词间空隙默认切点=前词尾 2800 | 更新测试为 00:02.800 | 已修复 |
| 5 | waveform-history.spec.mjs:159 | 右键添加空隙长度期望 500 实际 400 | 测试漂移（非帧量化）：`409f0c65` 重整静音空隙后，无 `gap_remove` 状态时默认 `minimum_ms` 回退 400（`web/gap-remove-core.js:795`） | 更新测试为 400 | 已修复 |
| 6 | waveform-history.spec.mjs:425 | 收缩后 gap 深比较失败：多出 `origins`/`source`，`removed:false` 空隙不再收缩 | 测试漂移：收缩改为 provenance 重建，只收缩 audio_gate 来源，保留 manual 恢复/移动覆盖（`web/editor.js:3695` shrinkExistingGaps 有注释说明设计） | 更新预期：gap1 收缩并带 `audio_gate` 标记；gap2 保持原样带 `manual` 标记；提示文案段数 2→1；undo 预期同步 | 已修复 |
| 7 | waveform-history.spec.mjs:649 | 撤销后 `DATA.segments[0]` 多出 `start_frame`/`end_frame` | 测试漂移：`33c6d8cc` 帧时间基准在毫秒模式也双写帧字段（内存与保存均写）；本测试用 `JSON.stringify` 全量对比 | 对比时剥离 `start_frame`/`end_frame`（毫秒字段是语义真源，帧字段为派生数据）；JSON_SCHEMA.md 措辞见说明项 | 已修复 |
| 8 | waveform-history.spec.mjs:1853 | C 合并期望 `BravoCharlie` 实际 `Bravo Charlie` | 测试漂移：合并文本经 `joinSegmentTexts`+`mergeJoinSeparatorForMode`（word 模式插空格） | 更新测试为 `Bravo Charlie` | 已修复 |
| 9 | waveform-history.spec.mjs:2176 | 文件名期望 `project_gap-removed_red.srt` 实际 `project_去空隙_red.srt` | 测试漂移：导出后缀走 i18n `exportTag('gap-removed')`，中文界面为「去空隙」（`web/editor.js:12012`） | 更新测试为中文文件名 | 已修复 |
| 10 | waveform-history.spec.mjs:2216 | :2304 深比较缺 `Video` 映射 | 测试漂移：`7dea6e94` 多音轨 OTIO 起，AUDIO 播放器（synthetic.wav）不生成视频轨；相邻用例 ：2312 已显式契约化该行为 | 删除预期中的 Video 映射条目 | 已修复 |
| 11 | layout-feedback.spec.mjs:101 | OCR hint 文案「OCR 模型已安装…」vs「OCR 支持已就绪」 | Launcher 域，另一 agent 正在改 | 移交，不在本任务处理 | 移交 |

## 说明项

- **JSON_SCHEMA.md 措辞与行为的张力（项 7）**：`JSON_SCHEMA.md:73` 写「帧模式额外保存成对的 `start_frame`/`end_frame` 字段」，未提毫秒模式；而 `33c6d8cc` 起毫秒模式保存也会写入派生帧字段（`buildJson` 无条件输出、`syncTimeRangeObjectTimebase` ms 分支回填）。帧字段是毫秒的确定性派生数据，第三方工具不受影响，故本次不改代码、不动 schema 文档；是否要把文档措辞放宽为「保存时可能携带派生帧字段」留给维护者决定。
- 项 6 的新语义下，「按预留量收缩」只作用于 audio_gate 来源；手工恢复的区段（`removed:false`）不再被收缩。这是带注释的设计决定，非回归。
- 全部 10 项均为测试侧修改，未改 `web/` 源码，因此**不触发** `blank-editor.html` 重生成约定。

## 验证记录

| 阶段 | 命令 | 结果 |
| --- | --- | --- |
| 复现 | `npx playwright test multi-subtitle.spec.mjs waveform-history.spec.mjs --grep <10 条>` | 10/10 失败（与移交清单一致） |
| 修复后 | 同上定向复跑 10 条 | 10/10 通过（项 6 首轮 undo 断言矫枉过正：收缩前快照无 `source`/`origins` 装饰字段，已改回原始形态） |
| 完整回归 | `npx playwright test multi-subtitle.spec.mjs waveform-history.spec.mjs --project=chromium` | 137 条：136 通过 + 1 个清单外同族漏网（`waveform-history.spec.mjs:812` 合并预览断言 `AlphaBravo`，与项 8 同根因，已一并改为 `Alpha Bravo` 并复跑通过）→ **137/137 通过** |
| 语法 | `node --check tests\e2e\multi-subtitle.spec.mjs`、`node --check tests\e2e\waveform-history.spec.mjs` | 通过 |
| 工作区 | `git diff --check` | 通过 |

## 收尾汇总

- **已修复（测试侧，共 11 处断言/定位修改 + 1 处清单外同族修复）**：项 1–10 + 项 8 的同族用例 `:812`；无产品代码改动，未重新生成 `blank-editor.html`。
- **移交**：项 11（layout-feedback OCR hint）留给出 Launcher 域的 agent。
- **说明项**：JSON_SCHEMA.md:73 与毫秒模式派生帧字段的措辞张力（见上），待维护者决定是否放宽措辞；项 6「收缩只作用于 audio_gate 来源」为带注释的设计语义，已按现状固化。
- 未验证边界：仅覆盖本清单涉及的两个 spec；其余 e2e spec（layout-feedback 等）未在本任务范围。
