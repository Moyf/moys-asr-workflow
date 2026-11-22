# MAW 2.0dev Playwright 基线测试失败分诊账本（第二批）

来源：PR #410 辅助作业 run 44672323147 / job 136076017193（Targeted auxiliary tests，2026-11-20 04:13Z）证据包 `targeted-auxiliary-results`（artifact 14600259601）中 `auxiliary-browser/failures.json`：**45 条记录 = 39 项失败 + 6 项 editor-session-state 连带 skip**（handoff 所称 39 项即失败口径）。仅作已知样本，不是全量失败清单。

本地基线：worktree `2.0dev-Playwright-test-repair` @ `4fd058e0`（含第一批修复：两个 spec 迁移到浏览器契约夹具）。全量收集已恢复（1261 项 / 133 文件）。

**当前进度：45 条中 32 条已修复（26 失败 + 6 skip），13 条待处理（multi-subtitle 11 + waveform-history 2）。** 全量回归：waveform-history 54/56、settings-structure 34/34、gap-removed-audio-export 21/21、editor-session-state 7/7、project-boundary 3/3、pr239 6/6、audio-processing 4/4、cue-scroll-stability 6/6。产品代码变更 1 处（有证据回归修复）。

样本分布：multi-subtitle 13、waveform-history 13、pr239-view-save-integration 6、editor-session-state 1 失败 + 6 skip、audio-processing 1、cue-scroll-stability 2、gap-removed-audio-export 1、project-boundary 2、settings-structure 3。

## 分诊原则（handoff 指定）

1. 优先修确定的旧契约：日常编辑/保存/重开改用规范 v2 工程与 tracks 中的主轨；迁移用例继续用 v1/v1.5 验证显式另存、原件不变，不恢复静默覆盖；副轨合并测试验证首段 ID 保留而不是变更。
2. 修正环境和 fixture 后再分开复测真正的光标/焦点、菜单行为、默认 rows 落盘及修复报告明细。
3. 没有证据不改产品代码，不弱化有价值的断言。可按批运行，完整运行依照仓库辅助巡检纪律和预算。

## 状态清单

状态取值：待处理、进行中、已修复、仅说明、阻塞。

| # | 状态 | spec / 用例 | 远端失败摘要 | 初步分诊 |
| --- | --- | --- | --- | --- |
| 1 | 已修复 | audio-processing::save/reload retains canonical gain | L107 `saveCurrentProject({silent:true})` 返回 false | v1 fixture 触发迁移另存；beforeAll 改 importer 转规范 v2。4/4 通过 |
| 2 | 已修复 | cue-scroll-stability::near-end extension editing anchored | L51 `merged.id).not.toBe(original.id)` 失败（合并后 ID 未变） | 2.0 契约：副轨合并保留首段 ID；断言翻转为 `toBe` 并注释；split 左段同理。6/6 通过 |
| 3 | 已修复 | cue-scroll-stability::save in flight retains newer edits | L155 `releaseSave` poll 超时 | fixture 迁 v2 后恢复（v1 工程不会发出保存 POST）。6/6 通过 |
| 4 | 已修复 | editor-session-state::file save rebases media | beforeAll L16 `project.segments.forEach` undefined | fixture 迁 v2 + 全部主轨读取；test 7 重铸为 v2 语义。7/7 通过（含 6 项连带 skip 恢复） |
| 5 | 已修复 | gap-removed-audio-export::detach clears capabilities | L202 `MaweProjectLoad.detachServerProjectSaving is not a function` | editor-project-load.js 已 ESM 化，整文件 classic 注入失效；改为函数体切片注入 + 模块绑定包装。spec 全量 21/21 |
| 6 | 待处理 | multi-subtitle::keeps the quick-import prompt | L273 `#multi-subtitle-empty-hint` hidden | 待复现 |
| 7 | 待处理 | multi-subtitle::saves an empty secondary track | L328 `#cue-panel-text` not focused | 光标/焦点类：fixture 修好后单独复测 |
| 8 | 待处理 | multi-subtitle::waveform extension cue double-click | L504 同上焦点失败 | 同 #7 |
| 9 | 待处理 | multi-subtitle::light theme colors | L548 期望 `rgb(31,37,48)` 实收 `rgb(29,29,32)` | 主题令牌断言：需查令牌是否变更，无证据不改断言也不改产品 |
| 10 | 待处理 | multi-subtitle::reserves space for dirty marker | L759 主列无 dirty class | 待复现（可能与 #4 的 _dirty 语义变化同源） |
| 11 | 待处理 | multi-subtitle::auto-binds earliest unbound | L1959 `#multi-subtitle-auto-sync-duration` disabled 无法 uncheck | 待复现：控件禁用条件是否变更 |
| 12 | 待处理 | multi-subtitle::merging bound main cues keeps ext color refs | L2536 `invalid` 含 `[3,"earlier",3]` | 副轨合并类：handoff 指定验证首段 ID 保留；invalid 引用语义待查 |
| 13 | 待处理 | multi-subtitle::merging and deleting extension cues | L2559 同 #12 | 同 #12 |
| 14 | 待处理 | multi-subtitle::ignores tiny unbound overlap at merge boundary | L2739 期望 `extension-001-merged` 实收 `extension-001` | 副轨合并类：与「首段 ID 保留」新契约方向一致，断言需更新 |
| 15 | 待处理 | multi-subtitle::ASS mode previews/exports extension style | L4592 期望 `,10,10,36,1` 实收 `,10,10,100,1` | 待复现：字号/样式默认值变化？ |
| 16 | 待处理 | multi-subtitle::ASS mode swaps controls | L4718 提示文案不匹配 | 文案断言：查现文案与意图 |
| 17 | 已修复 | pr239-view-save-integration::view-only edits return to saved default | L35 初始即 dirty | fixture 迁 v2；发现并修复产品回归（`timed_text_edit_view:'rows'` 省略丢失）。6/6 通过 |
| 18 | 已修复 | pr239::a view switch reaches real autosave | L67 等 `/api/project` POST 超时 | 随 v2 fixture 恢复 |
| 19 | 已修复 | pr239::an in-flight view save confirms | 60s 超时 | 随 v2 fixture 恢复 |
| 20 | 已修复 | pr239::invalid view import is atomic | L111 `Cannot read properties of undefined (reading '0')` | 主轨读取迁移 |
| 21 | 已修复 | pr239::backup-only writes preserve preference | L133 `saveProjectToServer({backupOnly:true})` 返回 false | v1 工程 backupOnly 被迁移另存拒绝；v2 fixture 恢复 |
| 22 | 已修复 | pr239::style-aware splitting keeps stable group membership | L151 同 #20 undefined '0' | 主轨读取迁移 |
| 23 | 已修复 | project-boundary::legal zero-width punctuation | L39 `Cannot read properties of undefined (reading 'map')` | `semantic()` 改读主轨。3/3 通过 |
| 24 | 已修复 | project-boundary::Server startup exposes real repairs | L64 `Cannot read properties of undefined (reading '0')` | fixture 改规范 v2 + 注入 end 0；报告路径 `$.tracks[0].segments[0].end` |
| 25 | 已修复 | settings-structure::word timing help concise | L120 期望 3 段实收 10 | 帮助重构：字词时间码内容在独立 word-timing 面板（2 subgroup / 8 条）。断言对准新面板。spec 全量 34/34 |
| 26 | 已修复 | settings-structure::project ASS and speaker exports undoable | L635 `ProjectTracksError: $.split_mode: legacy field is not allowed in v2` | 注入顶层 legacy split_mode 改为删除主轨 split_mode_override |
| 27 | 已修复 | settings-structure::project timing and language restore | L786 `saved.split_mode` undefined | 漏改断言：split_mode 是轨道级，改 `getMainTrack(saved).split_mode` |
| 28 | 已修复 | waveform-history::N creates subtitle focuses cue | L509 焦点失败 | 产品交互变更：新建字幕自动打开快速编辑气泡（editNewCue）。断言改气泡聚焦 |
| 29 | 已修复 | waveform-history::Ctrl+dragging blank waveform | L552 同焦点失败 | 同 #28 |
| 30 | 已修复 | waveform-history::manual text split restores with undo | L737 期望无 `_dirty` 实收带 `_dirty:true` | ① undo 重新应用会话高亮（有意语义），比较剥 _dirty；② restore 段无 id 被 v2 保存校验拒绝，补 id |
| 31 | 已修复 | waveform-history::C merge keeps subtitle list position | L886 合并后文本 `Cue 312` 而非 `Cue 31 Cue 32` | 假段无 id → 2.0 选择按 id 锚定 → 选中失败合并未发生（'2' 是 charcount 徽章）。假段补 id |
| 32 | 已修复 | waveform-history::help reflects selected split key | L1711 帮助面板文案 | 双语操作说明迁入独立「双语字幕」面板 + 新文案；断言切 tab 验证 |
| 33 | 已修复 | waveform-history::contextual help links | L1748 `#gap-remove-panel` 仍 show | 产品有意：「帮助非模态，弹窗并存」（产品注释）。三处断言翻转 |
| 34 | 已修复 | waveform-history::waveform toolbar icon controls | L1855 `[data-waveform-tool="select"]` 无 title 属性 | 共享 tooltip 启动时 title → data-title 转存。断言改 data-title |
| 35 | 已修复 | waveform-history::extends selected subtitles | L1911 undo 后 segments 带 `_dirty:true` | 同 #30：比较剥 _dirty |
| 36 | 待处理 | waveform-history::nested export menus keyboard focus | L2096 焦点失败 | 本地复现。同型用例在 editor-menu-focus（静态页+媒体）通过，差异待查 |
| 37 | 待处理 | waveform-history::nested export menus pointer corridor | L2135 子菜单 visible 超时 100ms | 本地复现，时序敏感，与 #36 同主题 |
| 38 | 已修复 | waveform-history::sticker Resolve/OTIO schema | L2182 期望 resolve.v1 实收 resolve.v2 | v1 sticker 导入即成组，分组导出走 v2 schema（含 disabled 成员的组区间为有意设计）。断言重铸组语义 |
| 39 | 已修复 | waveform-history::server media absolute path | L2310 期望绝对路径实收 `synthetic.wav` | 2.0 分层：DATA.media 保持工程名，绝对路径在 SERVER_CONFIG.autoLoadedMediaPath。断言改分层验证 |

## 执行日志

- 2026-11-20：从证据包提取 39 项失败清单并完成初步分诊。worktree `uv sync` 完成（20 包），可跑 serve.py 类用例。开始第一批次：确定旧契约组（#4、#23、#24、#26、#27、#17–#22、#1、#3）。
- 2026-11-20 批次 A（确定旧契约：v1/v1.5 工程 fixture + 顶层 segments 读取）完成：
  - **#4 editor-session-state**（7/7 通过，20261120T061050Z-7503f7a8）：beforeAll 迁移 v2（主轨 id/_dirty、secondary/overlay 为 v2 track、`preserve_punctuation` 移主轨、`bilingual.active_track_id='e'`）；全部 `MaweBoot.DATA.segments` → `AsrEditorUtils.getMainTrack(...)`；保存文件读取走 helpers `getMainTrack`。test 7 语义重铸：v2 输入验证 `_dirty` 标志忽略（clean），v2 + 非法 timing 验证修复报告 `$.tracks[0].segments[0].end`（v1 导入的修复已合并进 `$.tracks` 结构迁移 diff，不再有独立 `$.segments[0].end` 条目；v1 迁移报告由 project-boundary 语料覆盖）。6 项连带 skip 全部恢复。
  - **#23/#24 project-boundary**（3/3 通过，20261120T060947Z-921b903b）：zero-width 用例 `semantic()` 读主轨；Server startup 用例 fixture 改规范 v2 + 手工注入 end 0（保留启动修复场景），silent 保存恢复写回，报告路径实测为 `$.tracks[0].segments[0].end`。
  - **#17–#22 pr239-view-save-integration**（6/6 通过，20261120T061512Z-b6c2681e）：fixture 迁 v2（v1 输入经共享 importer 转换，sticker 组/overlay/fps_source 全保留）；断言改 v2（schema v2、主轨 sticker_group_id）；所有 DATA/saved segments 读取走主轨。v1.5 迁移旅程由 v2-migration-save 既有覆盖，主用例标题同步改为 v2 语义。
  - **#1 audio-processing**（4/4 通过，20261120T061108Z-1de67dd1）：beforeAll 工程经 importer 转规范 v2（v1 fixture 会触发 requiresMigrationSaveAs，silent 保存被 2.0 正确拒绝）。
  - **#2/#3 cue-scroll-stability**（6/6 通过，20261120T061735Z-16c1c0f7）：`cue-scroll-fixture.mjs` 的 syntheticScrollProject 输出经 importer 转 v2（段 ID / 轨道模式 / paired bindings 全保留，server-lifecycle-smoke 与 e2e-lifecycle-driver 仅依赖启停不受影响）；#3 save-in-flight 随 v2 fixture 自然恢复；#2 副轨合并断言按 2.0 契约翻转：合并保留首段 ID（`merged.id === original.id`），split 左段保留原段 ID，均加注释说明。
  - **产品回归修复（有证据）**：`web/editor/io/editor-json-repair.js` `projectSnapshot()` 恢复 1.x（f3dfb60a L76-77）的 `timed_text_edit_view === 'rows'` 默认值省略。v2 序列化改造丢失该归一，导致「切到 single 再切回 rows」后工程虚脏并把 `timed_text_edit_view: "rows"` 写进文件。调试证据：临时 spec 实测 fingerprint 差异仅此一字段（.artifacts/checks/20261120T061406Z-3603e72e）。修复后 pr239 主用例通过；bundle 已重建（`node scripts/build-editor.mjs --write`，120 ESM factories / 156 sources）。
- 2026-11-20 批次 B（#5 旧 API + settings-structure + waveform-history 行为类）完成：
  - **#5 gap-removed-audio-export::detach**（通过，20261120T062200Z-06b2527d）：`editor-project-load.js` 已 ESM 化，整文件 classic 注入失效（stub MaweProjectLoad 未被替换）。改为从源码切片 `detachServerProjectSaving` 函数体注入（与该 spec 既有 handler 切片风格一致），包装提供模块绑定（projectBindingEpoch / MaweCoreState stub）。spec 全量 21/21 通过（20261120T065938Z-ca4887d7）。
  - **#25 settings-structure::word timing help**（通过，20261120T062808Z-0dcc713c）：帮助面板已重构，字词时间码内容在独立 `#help-tab-panel-word-timing`（2 个 subgroup、8 条内容 span）。断言对准新面板，保留「精简 + 双语翻译」主张。
  - **#26/#27 settings-structure::split_mode**（通过，20261120T062552Z-b204fcce）：#26 注入顶层 legacy `split_mode` 改为删除主轨 `split_mode_override`；#27 `saved.split_mode` 漏改断言改 `getMainTrack(saved).split_mode`。spec 全量 34/34 通过。
  - **#28/#29 waveform-history::创建字幕焦点**（通过）：产品交互已改为新建字幕自动打开波形快速编辑气泡（`editNewCue`，editor-add-cue.js L145-146），断言改为气泡 `.waveform-cue-quick-edit-text` 可见且聚焦。
  - **#30 waveform-history::manual text split**（通过，20261120T065137Z-61ac7af1）：两个根因——① undo 后段的 `_dirty` 是会话高亮有意重新应用（editor-session-state test 3 验证的语义），比较剥离该标志；② restore 用 `testSegments()`（无 id）直接注入主轨，v2 保存校验要求段 id 必填 → Ctrl+s 校验失败不发 POST。restore 段补 `restore-cue-N` id。
  - **#31 waveform-history::C merge 列表位置**（通过）：40 条假段无 id，2.0 选择状态按段 id 锚定 → 点击选中失败（hint「请选择至少两个」）。假段补 `merge-cue-N` id 后合并/位置断言全过。DOM 里 '2' 是 charcount 徽章（曾误读为合并文本）。
  - **#35 waveform-history::extends selected subtitles**（通过）：undo 比较剥 `_dirty`（同 #30）。
  - **#38 waveform-history::sticker Resolve schema**（通过，20261120T063728Z-cf763f74）：v1 `sticker` 字段导入即迁移为 subtitle group，导出走 v2 schema（分组区间含 disabled 成员、`enabled`=组内有非 disabled 成员，subtitle-groups.js L17-33 有意设计）。断言重铸为组区间语义（`stickers:[[1000,6000,...]]`、成员组 id、dangling 无组、OTIO 片段区间 1000–6000 ms），测试名同步更新。
  - **#39 waveform-history::server media 绝对路径**（通过）：2.0 分层契约——`DATA.media` 保持工程名，绝对路径在 `SERVER_CONFIG.autoLoadedMediaPath`（serve.py L1760），保存/导出时 rebase（json-repair L46-48）。断言改分层验证；OTIO file:/// URL 走 boundMedia 不变。
  - **#32 waveform-history::help reflects split key**（通过，20261120T065249Z-925b04af）：双语操作说明迁入独立「双语字幕」面板 + 新文案（G/Shift+G/H 键）。断言切到该 tab 并按新文案验证。
  - **#33 waveform-history::contextual help links**（通过，20261120T065616Z-48cde697）：产品有意行为「帮助是非模态浮窗：从设置弹窗打开帮助时保持弹窗，两者并存」（wiring-settings-help.js 注释）。三处「面板应关闭」断言翻转为「面板保持打开」，测试自身补工具窗关闭步骤。
  - **#34 waveform-history::waveform toolbar title**（通过）：共享 tooltip（shared/tooltip.js）启动时把原生 title 转存 `data-title` 并从 DOM 移除。断言改 `data-title`。
  - waveform-history 全量回归：**54/56 通过**（20261120T065739Z-9d5dd61f，1.8m），仅剩 #36/#37 两项（见下）。

## 剩余待处理（下一批次输入）

**multi-subtitle 11 项（#6–#16）**：全部本地复现（20261120T062251Z-a5d3317b，11 failed / 1 passed）。该 spec 用静态契约页 fixture（buildBrowserEditorFixture + startStaticServer），非 v1 工程问题；失败为真实行为/焦点/样式/文案类，逐项需产品侧判定。已确认的线索：
- #7/#8 焦点失败与 #28/#29 同型（快速编辑气泡 vs cue-panel-text 焦点），大概率是同一交互变更，参照 #28 修法。
- #10 dirty marker：与 `_dirty` 会话高亮语义相关。
- #14 副轨合并 ID（extension-001-merged → extension-001）与 #2 同契约：首段 ID 保留，断言翻转。
- #15 ASS 样式 `,10,10,36,1` → `,10,10,100,1`：第 22 字段差异，查 ASS 样式库默认值变更。
- #16 文案断言：实收「先分配说话人，并勾选「导出带上说话人」」，查 i18n 现文案。
- #11 控件 disabled（auto-sync-duration uncheck 超时）、#9 主题令牌 rgb(31,37,48) vs rgb(29,29,32)、#6 empty-hint hidden、#12/#13 color ref invalid：待逐项分诊。

**waveform-history 2 项（#36/#37）**：本地复现。#36 键盘导航（ArrowDown → fcp7 聚焦失败）——注意 editor-menu-fix 的同型用例（静态页 + 加载媒体）通过，差异在 click 打开 dropdown 与页面类型；#37 aim corridor 100ms 时序敏感。两项建议与 multi-subtitle 焦点类一起按主题复测。

**范围外补充（自审发现，不在 45 条样本内）**：`timed-text-edit.spec.mjs` 实跑 16 项中 3 项 HEAD 既有失败，均与本批改动无关（该 spec 未被本批 diff 触及），但失败模式与本批同类，下一批次应一并处理：
- L417：undo 后整段比较未剥 `_dirty` 会话高亮（同 #30/#35 语义）；
- L603/L610：fixture（L29-53）仍是 v1 工程，`saveProjectToServer()` 触发迁移另存门返回 undefined（同 #1/#21 模式）；「rows is omitted」契约现由 pr239 L47/L66 守护，无覆盖真空；
- L626/L647：期望 blank 工程继承 `'rows'`，当前 `applyCanonicalProject`/`buildBlankProject` 不继承。
处理顺序建议：先照 #1/#21 模式迁 fixture，再按实测决定 rows 继承断言方向。
