# v1.9.0-beta.1 测试反馈与处理记录

维护者在实测 1.9.0-beta.1 期间反馈的问题清单。**流程约定（维护者 2026-10-15 指示）：
收到反馈先记录到本账本，再调查补充**，避免上下文压缩丢信息。核对结论与后续补充
直接更新对应条目；代码调整等这批反馈收尾后统一实施。

- 基线：分支 `main`，HEAD `1d961b90`（2026-10-15 建账时工作区干净）。
- 状态取值：`待处理`、`进行中`、`已修复`、`仅说明`、`阻塞`。
- 调查分工（2026-10-15 维护者指示）：主会话负责记录与核对；代码/文档调查优先派只读
  子代理，结论经主会话核对后写入本账本。
- 截图存档（2026-10-15 规则变更）：**不再保存图片**——原 `assets/` 已删除（回收站），图片不入 git；
  看到截图后把必要信息转为文字写入对应条目，后续 agent 无图也能实施；无必要信息则忽略。
  `assets/unknown-*.png` 为尚未确认归属的落盘图（见阶段汇总）。

## 问题清单

| # | 问题 | 状态 | 核实结论 / 方案 |
| --- | --- | --- | --- |
| 1 | 未勾选「保留中间文件」时不应删除核对文档（前后对比） | 待处理 | 根因已查明并核对（子代理报告 + 抽查，详见 `TEST_FEEDBACK_BETA1-investigation-comparison-deletion.md`）：**观感层**——各步对比页先写入后处理 run 目录（pipeline:754-766），完成后**复制**（`_copy_atomic` :1533-1545）到工程所在目录；retain 关闭时收尾 `rmtree(run_directory)`（:950-957）清掉 run 目录初始副本，幸存副本在转写输出目录且为 ASCII 名。**代码真缺陷**——翻译步骤对比页在包装函数（pipeline:1373-1380/:1420-1426/:1464-1470）未透传 `comparison_path` → 被真删。**维护者确认复现组合（2026-10-15）**：AI 校对 + 翻译 + 烧录字幕（无口播整理）；运行中两个对比页（proofread + translate），现存 `examples/仙术杯开场/_maw/仙术杯开场.qwen-audio.proofread-comparison.html`，缺失的正是 translate 的——与已确证的翻译包装缺陷完全吻合，根因闭环（此前账本误记「仙木杯开场 ai-cleanup 也缺失」系截图误读，已更正）。修复：① 三个包装透传 `comparison_path`；② retain 关闭时改移动 + 集中列出最终路径 + 打开按钮回退幸存目录；③ 补多步骤 + retain=False 存活性单测。结论已评论到 Issue #237 |
| 2 | 烧录默认画质 CRF 18 过高，应改更合理数值（提议 21） | 待处理 | 现状：`maw/postprocess_ffmpeg.py:31` `DEFAULT_BURN_CRF = 18`，同一数值映射 libx264 `-crf` / nvenc `-cq` / amf cqp / qsv `global_quality`（354–365 行）；提示文案「常用 16–23，默认 18」（`web/launcher/i18n/launcher-strings.js` 367/370 行）；`docs/user/TOOLBOX.md:139`；测试断言默认 18（`tests/test_postprocess.py:3090`）。调研（2026-10-15）：x264 默认 23、交付合理区间 18–28、±6 ≈ 体积减半/翻倍；HandBrake 官方推荐 1080p RF 20–24；视觉无损约 17–18（体积过大）。**建议默认 21**（与维护者提议一致：处于推荐区间中段，字幕文字边缘比普通画面更吃码率，21 相比 23 更稳，相比 18 显著省体积）。改动面 = 默认值 + 双语文案 + TOOLBOX.md + 测试断言。备注：CRF 数值直接映射硬件编码器 cq/qp，感知画质并不等价，本次不展开 |
| 3 | 「回填」默认应不勾选，核实当前默认 | 仅说明 | 已核实默认不勾选：计划层 `embedTranslations: False`（`maw/postprocess_pipeline.py:104`，normalize 165 行沿用已存值）；UI 两个勾选框 `autoTranslateBackfill`（index.html:437）/ `postprocessBackfill`（index.html:1031）均无 `checked` 属性；恢复逻辑 `web/launcher/postprocess.js:2023` 按已存计划回填。若维护者见到默认勾选，大概率是本机已保存的旧计划状态，请提供具体入口以便复查 |
| 4 | 回填应做语言检查：整篇都会被译文替换时属误操作，应跳过回填并日志提醒 | 待处理 | 方案草案：翻译步骤已有「目标语言预过滤」（已是目标语言的句子逐字节保留，`maw/postprocess_pipeline.py:1441` 附近）。建议启用回填时统计将被替换的句子占比，超阈值（拟 >50%，待维护者确认）即跳过回填、输出原翻译产物并在日志提示「疑似整篇翻译场景，请关闭回填」。涉及 `maw/postprocess.py:567–590` 回填实现与 pipeline 翻译步骤接线。**维护者拍板：阈值 >50%** |
| 5 | 单行模式下看不到字幕块 | 待处理 | 维护者已定位原因：有「视频画面」条时，字幕块被挤到可视区外。方案：有画面带的情况下压缩单行波形整体高度，保证画面带 + 波形 + 字幕块不超出可视范围。涉及波形行高布局（`web/editor/media/waveform/` 下 `thumbnails.js` / `cue-blocks.js`，总行高由波形高度 + 画面带统一计算，见 `docs/engineering/FILMSTRIP_EXPLORATION.md:40`） |
| 5b | 「视频画面」改名「视频缩略图」 | 待处理 | 编辑器界面用词统一替换；zh→en 映射源头 `web/shared/editor-i18n.js:13–15`（'视频画面': 'Video pictures' 等），实施时全量搜「视频画面」（含文档 docs/user/EDITOR_GUIDE.md 等），注意区分 OCR 去重文档里「视频画面」的普通名词用法 |
| 6.1 | 视频缩略图疑似没读取 `.mothumbs`，刚打开全空、全靠实时生成 | 进行中 | 实测（`.artifacts/feedback-261015/check_thumbnail_identity.py`，只读）：sidecar 健康（`base_complete=True`、`valid_count=23/23`、生成器 v3、2 秒档）；**身份完全匹配、`load_base` 命中**（`source_signature` 用 `st_mtime_ns`，真实 UTC；先前账本怀疑的「8 小时偏差」是核对脚本自身 PowerShell 时间计算错误，已排除并更正）。Python 读缓存链路对该媒体健康。剩余方向：① 打开时机——转写日志停在 `[thumbnails] 16/23`，若打开编辑器时基础档未完成，且编辑器可见需求会暂停 Launcher 全片生成（`maw/thumbnail_jobs.py:234` 优先级设计），观感即「全靠实时生成」，事后基础档补完（当前 23/23）；② 编辑器客户端（`web/editor/media/editor-thumbnails.js`）对已命中基础档的读取/显示是否正常；③ 是否与 6.2 同源（绑定层）。请维护者确认：现在重新打开该工程，画面带是否秒出 |
| 6.2 | 拖 mosp 进 Launcher → 点「打开编辑器」，工程打开后完全没有视频画面带 | 进行中 | 子代理调查完成并核对（报告 `TEST_FEEDBACK_BETA1-investigation-launcher-editor.md`）：两链路启动方式相同；「区域整个没有」仅三个条件——binding 空（基本排除：延迟加载后页面 reload 拿新鲜 binding）、`enabled=false`（localStorage `mawe-filmstrip-visible`，**per-origin**，两链路 origin 可能不同）、`available=false`（worker error/unavailable，`thumbnail_jobs.py:570-612`）。候选排序：① 子进程 worker error ② `start_server` 已运行复用分支复用端口上任意 200-499 旧实例且不带工程参数（`gui_web.py:2097-2104`；实测机器曾出现 8250 服务与两个 Launcher GUI 实例并存）③ origin 显示开关。已排除：HEVC 转码（仅 flv）、媒体路径未传入、FFmpeg 配置缺失。受控复现（8291 端口、Launcher 同款命令、只读探针）：工程加载正常（页面标题含媒体名），但 30 秒内页面未下发 `thumbnailBinding`——疑因延迟加载由页面 JS 触发、无浏览器不推进，暂无法判定 worker 状态；移交 Issue #237。请维护者下次复现时看波形设置「视频缩略图」开关旁状态文案：「视频画面已隐藏」=③、「画面缓存暂不可用」=①error、「当前媒体没有可用画面」=①unavailable。附带发现：`open_mawe` 孤儿 i18n key（实际用 `start_server_editor`/`open_editor`）；`check_server_media` 与 serve.py 媒体解析口径不一致（`gui_web.py:2339`） |
| 6.3 | （附带）转写日志出现 `[reapeaks] 解码失败：[hevc] SPS 0 does not exist`，问有影响吗 | 待处理 | 结论：**对结果无影响**，波形已通过回退正常生成；但这是误报——`maw/quapeaks.py:1082–1084` 只要 stderr 非空就判失败，而该次 ffmpeg 退出码为 0（日志无「退出码」前缀即走 1083 分支），stderr 里只是探测 HEVC 视频流时的非致命警告。后果：丢弃成功的解码结果、多跑一遍「派生 audio.wav」回退（慢 + 日志吓人）。优化方向：retcode=0 时 stderr 仅作警告记录，不触发回退（或区分警告/错误级别） |
| 7 | ASS 预览示例文本修改（`Aa 字幕预览 / 字幕样例` 横向溢出面板、右侧被裁切） | 待处理 | 位置：`web/editor/styles/editor-wiring-ass-manager.js:221` `renderSample(..., 'Aa 字幕预览 / 字幕样例')`。方案：换更短、不易溢出的示例文本（具体文案待维护者定，如「字幕预览 Aa」）；实施时检查画布宽度与 PlayRes 的关系，确认换文本后不出现横向滚动条。**维护者拍板：新文案「ASS 字幕预览 OwO」** |
| 8 | 「纯文本编辑」的修改前/后显示调整：① 从文本框下方移到文本框右侧；② 时间范围未变化时不显示「时间范围：A – B → A – B」这类无变化行 | 待处理 | 已核对（子代理报告 + 抽查，详见 `TEST_FEEDBACK_BETA1-investigation-timedtext.md`）：diff 行写入 `.timed-text-edit-row-diff`（`editor-timed-text-edit.js:115–142`，容器创建 :298–301）；`.timed-text-edit-row-main` 为 block（`editor.css:3494`），textarea `width:100%` 在上、diff 容器 `margin-top:5px` 在下 → 即「在下方」的原因。移右侧需：① JS 先把「修改前/后」与「时间范围/估算提示」拆成两个容器（现全 append 进同一容器，:120–141）；② `.timed-text-edit-row-main` 改两列并去掉 textarea `width:100%`；可复用 `.timed-text-edit-layout` 分栏（`editor.css:3447–3450`）。右侧修改清单 `renderTimedTextEditChangeList`（:201–229）为独立渲染路径，需单独决定是否对齐 |
| 9 | 纯文本编辑的搜索框加 clear 按钮，快速清空搜索内容 | 待处理 | 截图：搜索框有匹配计数（2/2）与 Aa / `.*` 开关，无清空按钮。已核对：搜索行 `.timed-text-edit-search-row`（`editor-template.html:2470`，输入框 `#timed-text-edit-find` :2473）；清空逻辑现成（重置路径 + `refreshTimedTextEditSearch({ resetIndex: true })`）；**项目已有同功能 clear 模式可复用**：字幕列表搜索 `.input-clear`/`.clear-x`（`editor-template.html:2120`、`editor-wiring-search-filter.js:81–86`、`editor.css:817–830`，`has-value` 才显示）。**维护者补充**：同款参考「工程设置搜索」的 X——其实现是原生 `type="search"` 的清除按钮（`editor-template.html:792` `#project-settings-search`，无自定义 CSS），timed-text find 输入框改 `type="search"` 即得同款；与 #11 合并实施 |
| 10 | 拆句后时间范围 diff 显示为「原范围 → 原范围」（A→A），看不出时间映射发生过 | 待处理 | 根因已确认（子代理报告 + 主会话抽查 `timed-text-edit.js:348–349` 原文吻合，详见调查报告）：**时间映射本身正确**（锚点 DP + 未匹配行字符占比插值，items 按原 item 时间复用，`timed-text-plans.js`）；错在展示口径——structural 行的 beforeStart/beforeEnd 取自该输出行自己的 items 切片，而输出行 start/end 恰由同一切片边界决定（`timed-text-plans.js:388–394`），故 before==after。修复：structural 行改用整条原字幕范围（`source[sourceIndexes[0]].start` / `source[sourceIndexes[last]].end`，`sourceIndexes` :306 已有）；文本 before 已有同类修正先例（`timed-text-edit.js:309–315`）。与 #8② 联动：修正后未变化的时间范围行不显示。维护者期望的 30,000→36,250 / 36,250→40,000 比例映射与实际数据一致。 |
| 11 | 纯文本编辑搜索框样式问题：① Tab 聚焦时按钮高亮为黑色外边框，样式不对；② 搜索框按钮组（Aa / `.*` / 上一条 / 下一条 / 匹配计数）与项目整体按钮样式不匹配，需要迭代 | 待处理 | 已核对：黑框是**浏览器默认 outline**（editor.css 无该按钮组 focus 规则）；对齐目标 = `.toolbar button`（`editor.css:845–850`，hover/active/focus-visible :862–866、`.active` 用色 :878–880）。现样式仅 `.timed-text-edit-search-row button`（:3380，只调尺寸）与 `.timed-text-edit-search-option`（:3382–3383）；上一条/下一条与替换按钮无 class（`editor-template.html:2477–2478/:2484–2485`），建议补语义 class。最小修复：补 `:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 1px }`（项目统一模式）；整体对齐：按钮组套 toolbar token、`aria-pressed` 用色与 `.toolbar button.active` 统一。与 #9 合并实施 |
| 12 | 拆分时「特殊文本样式符号」被拆开：符号应自动迁移到「成对」的那一边，`items` 一并处理 | 待处理 | 已核对（子代理报告 + 四处抽查，详见 `TEST_FEEDBACK_BETA1-investigation-split-markers.md`）：符号清单 `WRAP_CHAR_PRESETS`（`text-processing.js:436–448`：`**` `++` `--` `__` `~~` `>>…<<` `//`）；配对解析 `assMarkedRanges`（`ass-style.js:66–93`，**找不到成对就按字面保留**——孤儿符号按字面渲染正是截图现象）；开关 `assSpecialSymbolRule` 默认 `both`（`settings.js:151`）。现状：拆分**完全没有**成对检查/迁移，唯一文本处理是边缘修剪（`split-trim.js:81–85`，样式符号不在修剪集）；单词模式下 `+` 还是可断连接符（`word-split.js:9`），允许在 `++` 中间下刀。方案：迁移 helper 放 `web/shared/utils/`，复用 `assMarkedRanges` 配对语义并按识别开关 gate；挂载点仅两处——弹窗系 `buildSplitPair`（`editor-split-core.js:432–434`，迁移后修正 `offset`，items 对齐自动跟随）+ 光标路径 `splitAtCursor`（:1743–1744）；fade `>>…<<` 句级标记单独规则（待定）；`duplicate/progressive` 模式跳过。合并侧同样无符号处理（`joinSegmentTexts`，`editor-segment-ops.js:57–61`，可能产生 `++++`），可后续顺手清理、非本次必须。**维护者拍板 fade 规则：句级 `>>…<<` 拆分时，两侧新行各自补齐完整的 `>>…<<` 对**（两段都保留淡入淡出效果；与普通符号的「迁移」逻辑不同，fade 是「补齐」） |
| 13 | 纯文本编辑的「编辑视图」（逐条编辑/整体编辑）状态存进工程，打开时自动继承上次关闭时的选择 | 待处理 | 已核对（子代理报告 + 三处抽查，详见 `TEST_FEEDBACK_BETA1-investigation-view-state.md`）：现状 = 运行时草稿 `MaweDom.timedTextEditDraft.view`（默认硬编码 `rows`，`editor-timed-text-edit.js:757`；唯一写入点 `editor-wiring-text-tools.js:409`；single 不可用已有自动降级 :326），无任何持久化。方案：新顶层可选字段 `timed_text_edit_view`（`"rows"|"single"`），仿 `split_mode` 条件写出（默认 rows 不写字段、旧工程 diff 干净）；不塞 workspace（会被工作区库跨工程复用而泄漏）/preview（语义不符）。落点：写 `:409` 同步 DATA + `buildJson`（`editor-json-repair.js:46` 模式）；读 `editor-project-load.js` 归一化 + `loadTimedTextEditTrack:757` 取值；`CANONICAL_PROJECT_FIELDS` 加白名单；可选入 `projectSaveFingerprint`。需同步：`JSON_SCHEMA.md` 两处、`maw/project.py:416-427` 枚举校验、`tests/test_project_contract.py` round-trip、e2e `timed-text-edit.spec.mjs` 恢复断言、CHANGELOG |
| 14 | 纯文本编辑【替换为】展开时，find 文本框按 Tab 应直接跳到【替换】输入框 | 待处理 | 结构已知（timed-text 调查报告）：`.timed-text-edit-search-row`（`editor-template.html:2470`：替换开关 :2471 → find 输入框 :2473 → Aa :2474 → `.*` :2475 → 计数 :2476 → 上一条/下一条 :2477-2478），替换行 `#timed-text-edit-replace-row` 在其后（替换输入框与单个/全部按钮 :2483-2485）→ 自然 Tab 序 find→Aa→…→替换输入框，绕远了。方案草案（实施时定）：替换行展开时让 find 的下一焦点是替换输入框（调整 DOM 顺序或展开态动态 tabindex），收起时维持原序；与 #9/#11 搜索框改造同批实施 |
| 15 | 编辑器「批量处理-文本处理」预览：已「全部展开」时切换其他选项，行会重新收起，希望保持展开 | 待处理 | 根因已定位（主会话直接核对，`web/editor/cues/editor-text-process.js:170-235`）：每次选项变化都 `textProcessPreview.replaceChildren()` 重建全部 `<details>` 行（:174、:206-221，默认收起），「全部展开」按钮只对当前 DOM 生效（:227-231），无跨渲染状态。方案：保留跨渲染的展开标志（按钮切换、每次渲染后应用；行级 toggle 同步标志，手动全部收起时自然复位），或按行 key 记忆展开集合（可同时支持部分展开记忆）。改动集中在预览重建函数内，量小。**维护者补充**：「只处理选中字幕」等范围切换同样要保持展开——规则统一为「任何选项变化的重渲染都保持当前展开状态」 |
| 16 | 文本处理「ASS 特殊文本样式」按钮改为多选 toggle（可同时选中「强调+放大」等，叠加处理） | 待处理 | 现状（主会话核对，`web/editor/cues/editor-text-process.js`）：单选语义——状态为单个 `textProcessWrapPreset`（:60），options 只取一个预设的 left/right（:131-139），aria-pressed 按 `id === preset.id` 点亮（:242-244），打开/应用时置空（:321/:332）。方案草案：状态改按选择顺序记录的集合，aria-pressed 按成员判断；预览与处理按选择顺序叠加包裹（left 顺序拼接、right 逆序拼接以正确嵌套）；「自定义」选中时显示自定义左右字符字段（:131/:240 的 customWrap 判断改为集合包含）；重置点同步清集合。预设数据源 `WRAP_CHAR_PRESETS`（`text-processing.js:436-448`）。与 #15 同面板同批实施 |
| 17 | 核对清单工具（tools/verification-checklist）两个小调整：① 「重置勾选」需二次确认；② 「全勾选后自动收起」默认启用 | 待处理 | 维护者工具模板自身的改进（AGENTS.md：改模板本身让后续复用受益）。已定位：重置按钮 `templates/verification-checklist.html:256`、重置逻辑 :516-528（直接清除，无确认）；「全勾选后自动收起」缺省关（:320 `view.autoCollapseCompleted === true`），toggle 在 :545-547。改法：① 重置 handler 前加确认（复用项目内现成 confirm 模式或模板内简单 confirm）；② 缺省改 true（注意旧清单 localStorage 已显式存过 false 的行为：区分「未存过」与「存过 false」）。改动小，可并入本批或单独随手改 |
| 18 | 新增字幕被拒提示增强：「该位置已有字幕，无法新增字幕」在未开启「重叠」时追加「如果你需要重叠字幕，请先开启「重叠」功能。」 | 待处理 | 已定位：`web/editor/media/editor-waveform-init.js:174`（`reason === 'occupied'` 分支）；拖动创建的同类提示 `web/editor/cues/editor-add-cue.js:90`（「拖动范围包含已有字幕，无法新增字幕」）可考虑同样处理。i18n 映射在 `web/shared/editor-i18n.js:1048-1052`。实施要点：仅在「重叠」未开启时追加该句（调用点需能读到重叠开关状态），已开启则维持原文；en 文案同步 editor-i18n |
| 19 | 「双语波形高度」与「字词码波形高度/每行长度」：改名「自动适配高度/每行长度」，且启用时只增不减（当前值小于预设才切到预设，已更大则不动；关闭仍恢复原值） | 待处理 | 已定位机制：启用/关闭字词码时 `syncWordTimingWaveformSettings(enabled)`（`web/editor/ui/editor-display-settings.js:82-101`）——启用强制设为预设值（:87-88，先存原值 `secondsPerRowBeforeWordTiming`）、关闭恢复（:90-91）；行高走 `syncWaveformModeRowHeight('word', ...)`（:93），双语为 `syncMultiSubtitleWaveformRowHeight`（:116，实现紧邻，实施时读）。改法：① 启用分支改「仅当当前值 < 预设才设置」，无论是否设置都记录原值供恢复，双语同规则；② UI 文案「字词波形高度」→「自动适配高度」、「字词码每行长度」→「自动适配每行长度」、「双语波形高度」→「自动适配高度」，hint「启用字词时间码时自动切换到这些值，关闭后恢复…」同步改为只增不减描述，en i18n 同步（`web/shared/editor-i18n.js:18/26/557` 一带）；③ 设置存储键不变。动机：避免用户行高/长度过小显示差（QOL 下限），空间充足则不跳动 |
| 20 | 「字词拆成字幕」确认弹窗调整：删红色警告行、正文换新文案、摘要行加大字号 | 待处理 | 新正文（三句）：「此操作会使用字词时间码来生成拆碎后的字幕块，将完整的句子变成一个一个单词逐个显示。请确认你需要这个效果再使用。如果不满意可以撤销，或者多选字幕块后重新合并。」；删除红字「可通过撤销恢复；不提供反向转换工具。」（理由：可撤销也可多选合并，无需警告）。摘要行「将转换N句，生成M条新的字幕…」加大字号。位置：红字与正文在弹窗模板（editor-template.html，搜「可通过撤销恢复」）；摘要行 `#word-conversion-summary`（`editor-word-timing.js:172-175`），字号在 editor.css 为该元素加规则；zh 文案改动同步 editor-i18n 的 en 映射 |
| 21 | Shift+拖动主字幕到叠加字幕轨：前方主字幕往后拖时仍高频上下跳动闪烁 | 待处理 | 根因已查明并核对（子代理报告 + 抽查，详见 `TEST_FEEDBACK_BETA1-investigation-overlay-jitter.md`）：换轨**不按指针纵向位置**，按碰撞条件；旧修复（3cc689ca/PR #223，源 a06b76c8）只加「落点与主轨无重叠才保持主轨」守卫（`cue-drag-update.js:96-103`），**不看叠加轨占用**。抖动循环：换轨落点撞上叠加块 → 叠加轨同轨钳制强行左推（:253-260+:292）→ 被挤位置与主轨无重叠 → `fitsMain` 换回主轨（:128-134，convertedToOverlay 复位）→ 邻居区间重算后指针仍越界 → 再换轨……每 2-3 个 pointermove 帧往返一次，每次触发 `refreshCueOverlay` 全量重建。叠加块完全落在后方主字幕范围内时不闪（挤出位置仍压主轨）——与现象吻合。修复方向：① 主→叠守卫纳入叠加轨占用（推荐，最小改动）；② `fitsMain` 回轨加迟滞；③ 拖动期锁定 convertedToOverlay；④ Shift 拖动期间放开叠加轨钳制（允许叠加互叠，需产品确认）。e2e `overlay-track.spec.mjs:277-336` 未覆盖本场景，建议补测 |
| 22 | ①字词码两种显示状态的项目内称呼；②「叠在上面（紧凑叠加）」态恢复选中字幕块的描边（此前特意隐藏） | 待处理 | ① 已查明（按行高自动分级、无独立 UI 文案）：**`word-timing-full`（等高分层）** = 单行波形或行高 ≥96 的非双语行，上下两层等高；**`word-timing-compact` / `word-timing-background`（紧凑叠加）** = 行高不足或双语行，句块垫底 opacity 0.28。判定 `cue-blocks.js:276-278`，样式分级注释 `waveform.css:916-920`。② 选中描边此前被特意隐藏：`waveform.css:896-903`（selected 时 `outline-color: transparent; box-shadow: none`，仅以 opacity 0.45 作轻量选中提示，注释写明是为避免与字词块双层描边叠加）。改法：恢复 selected 描边（删/改该规则；实施时目测与字词块描边的叠加效果，必要时只留描边去辉光） |
| 23 | 工程设置：【双语字幕】开关从【字幕轨道】页移到专属「双语字幕」标签页 | 待处理 | 已定位：开关 `#multi-subtitle-toggle` 在 `editor-template.html:851-853`（label class `multi-subtitle-main-toggle project-track-toggle`，位于字幕轨道页）；「双语字幕」标签页已存在（nav `editor-settings-tab-multi-subtitle`）。改法：把该开关（连同所在 field/group）移入 multi-subtitle 页；确认 `updateMultiSubtitleUi`（editor-display-settings.js:122-126）等按 id 引用不受移动影响；提示文案（「开启后显示副字幕轨…」）随行 |
| 24 | 核对清单工具：导出范围第二项改「仅未确认和备注项」并设为默认；每个条目下加「复制」按钮快速复制条目文本 | 待处理 | 已定位（`tools/verification-checklist/templates/verification-checklist.html`）：导出范围 select :263-266（`all` 全部核对项 / `unconfirmed` 仅未确认项，当前默认 all）；导出过滤 :552-567（unconfirmed = 未勾选且未被忽略分组，备注随项带出 :564）。改法：① 第二项文案改「仅未确认和备注项」并设为默认（selected）；语义按「未确认项 ∪ 有备注项」实现（`!checked || note 非空`，仍排除被忽略分组——若维护者意图仅是改名请指出）；文件名后缀（:586 `-未确认`）与状态文案同步，README 导出说明更新。② 条目下加「复制」按钮（navigator.clipboard，复制条目文本），用容器事件委托避免数百按钮各挂 listener。遵守 tools/AGENTS.md：占位符原文只在真实替换点，改完用含长命令/宽表格/数百打勾项的压力实例实测 resize 与滚动。**维护者拍板：采用新语义**（未确认 ∪ 有备注项，含已确认但有备注的；仍排除被忽略分组） |
| 25 | 单点标记（waveform-marker-item point）宽度不用百分比，固定 8px | 待处理 | 已定位：point 标记宽度 = 百分比下限（`web/editor/media/waveform/markers.js:100-111`，`MARKER_POINT_MIN_VISIBLE_PERCENT` 与可见跨度取 max 后写 inline width），随缩放变化。改法：point 分支固定 `width: 8px`（region 保持百分比不动）；拖拽预览分支（:626-632）同步固定宽；检查 `MARKER_POINT_MIN_VISIBLE_PERCENT` 其他引用是否仍需要；命中区 `::after`（waveform.css:1242-1246，左右各扩 4px）机制不变 |
| 26 | 标记管理「定位试听」：区段标记（有时间范围）改为和字幕右键「试听」同逻辑，只播放该时间范围 | 待处理 | 现状：`locateMarker`（`web/editor/markers/editor-marker-editing.js:212-225`）跳到 `marker.start` 后无条件播放、不设停止点（play 分支 :219-222）；字幕右键「试听」用的是 `MaweMediaPlayback.auditionRange(start, end)`（`web/editor/ui/editor-context-menus.js:345-349`，到终点自动暂停，F 快捷键）。改法：区段标记（有 end）且 play=true 时改走 `auditionRange(marker.start, marker.end)`；单点标记维持「跳转+播放」。提示文案（editor-markers-panel.js:510「已定位到 … 并播放」）可随行为微调；单点/区段行为差异在 README 或提示中说明（实施者酌情） |
| 27 | ASS 字幕模式：进入/退出全屏时视频画面上的 ASS 预览瞬时变得非常扁，过一会儿才恢复（老问题） | 待处理 | 根因已查明并核对（子代理报告 + 两处抽查，详见 `TEST_FEEDBACK_BETA1-investigation-ass-fullscreen.md`）：预览 = PlayRes 原生分辨率 canvas 靠 CSS 拉伸进 overlayEl 盒（`editor.css:1963-1969`，非等比映射即压扁）；「扁窗口」两成因——① 暂停态唯一重画路径是 100ms 防抖 + rAF（`editor-wiring-keyboard-guards.js:126-151`），过渡期每次 RO/resize 都重置计时一再推迟；② 过渡中间态几何（宽已变高未变）两维 ≥48px 会绕过采样守卫被写进 `lastStableAssPreviewGeometry`（`editor-wiring-ass-preview.js:24, 37-53`）并画出。修复方向：① fullscreenchange 加不防抖的即时重绘路径（双 rAF 后调 `MawePlaybackLoop.refreshSubtitlePreview()`，`editor-playback-loop.js:140`）；② RO 改盯/加盯 video 元素（:153-156 现只盯 playerStage）；③ metrics 采样守卫加宽高比校验（接近 videoWidth/videoHeight 或连续两帧一致才更新缓存）。涉及 e2e `speaker-labels.spec.mjs:296-440` 的过渡期断言语义需同步复核 |
| 28 | 调色板黄色默认值改为 `#f9ca1f`；默认字幕颜色的黄色一并改为此值（全盘更新） | 待处理 | 清点完成并核对（四处源头锚点吻合，详见 `TEST_FEEDBACK_BETA1-investigation-yellow-defaults.md`）。黄分四组：**A 调色板黄 `#c4a019`**（源头 `maw/colors.py:16` + JS 镜像 settings.js:23 / ass-style.js:41 + 模板 :1247 + 文档两处）；**B 副字幕默认主色 `#eac953`**（`ass_styles.py:178` + ass-style.js:211 + editor-settings.js:270 + 模板 :1039 + CSS :723/:3156/:3199 + 文档）；**C 内置样式强调色 `#ffd34d`**（`ass_styles.py:134/:245` + ass-style.js:168/:295 + ograf.js/lottie.js 默认 + lottie_glyphs.py:563 RGB 三元组）；**D ASS 主/副强调色 `#ffaa00`（偏橙）**。A/B 确定改；**C/D 是否在「全盘」范围待维护者确认**（D 已偏橙）。不改：迁移判断 `ass_styles.py:401` 的历史旧默认比较、历史记录、语义色（选中琥珀/拆分闪黄/暖色提示/标记色板）。测试断言同步点已列（report 第 4 节）；收尾注意 bundle 重建与旧工程色值快照不动。**维护者拍板（2026-10-15）：只改 A+B**（调色板 + 副字幕默认主色），C/D 保持现值不动；**旧工程存储的色值快照不加迁移** |
| 29 | 【去空隙导出】重组后视频播放到中间会整段卡住好几秒；参考 LosslessCut 的重剪方案修复 | 待处理 | 根因已查明并核对（子代理报告 + 四处抽查，详见 `TEST_FEEDBACK_BETA1-investigation-gap-export.md`）：现状 = ffconcat 清单 + **纯 `-c copy`**（`serve.py:586-590`），切点直接用静音边界毫秒值、**零关键帧对齐**、零时间戳治理；concat demuxer 对非 intra 编码的 inpoint 会回退到前关键帧多出整段 GOP 的包，复制后拼接点时间戳重叠/倒退（FFmpeg 官方文档明示），卡顿时长 ≈ GOP 长度（2-10s）随切点累积，伴音画错位。**LosslessCut 不卡的根因 = 默认把切点对齐到前关键帧（Keyframe cut）；与维护者接受的 MergeCuts/关键帧延伸完全一致。修复推荐 ①：导出前 ffprobe packet 级关键帧扫描，把每个区间 inpoint 向前吸附到最近关键帧（outpoint 不动）——无损、改动仅限 `rebuild_gap_removed_video` + 清单函数；代价是每段头部含 ≤1 GOP 的被删空隙尾部（多为静音）。备选：② smart cut（切点小头重编码，官方标实验性）；③ 整段重编码（UI「兼容模式」）；④ 音视频分策略合 mux。不建议只加 muxer 参数（止痛不治本）。测试盲区：现有夹具全部 `-g 1` 全 intra，长 GOP 场景零覆盖——修复时补 `-g 250` 夹具断言输出时间戳单调 |
| 30 | 去空隙导出进度弹窗：按钮样式对齐项目整体（参考其他弹窗）；完成后显示「打开文件夹」和「关闭」按钮 | 待处理 | 已定位：进度面板动态创建（`web/editor/io/editor-wiring-export-actions.js:656-670`，`.gap-video-job` 追加到 body），样式裸奔（editor.css:4410-4425，按钮仅 padding、进度条原生样式，无主题 token）。改法：① 面板与按钮/进度条套项目样式（参考 `.toolbar button` token 或模态 actions 模式，editor.css:3023 一带，深浅主题都检查）；② 成功完成态显示「打开文件夹」+「关闭」：关闭 = 移除面板并清理任务状态（`window.__maweGapRemovedVideoTask`、pagehide 监听）；打开文件夹——编辑器（浏览器 server 模式）侧无既有通道（Launcher 桥的 `open_containing_folder`（gui_web.py:2085）用不上），需在 serve.py 新增受限端点（仅 127.0.0.1、仅打开导出目录）或退化方案显示输出路径，实施时定 |

## 阶段汇总

- 2026-10-15：建账，#1–#8 全部录入。#3 得出「仅说明」结论；#2 完成 CRF 调研并建议 21；
  #6.3 判定 reapeaks「解码失败」为误报、无结果影响。尚无代码改动。
- 2026-10-15 续：#6.1 身份验证完成——身份匹配、`load_base` 命中、Python 读缓存链路健康；
  早前「8 小时偏差」记录系核对脚本自身 PowerShell 计算错误，已更正排除。6.1 转入
  打开时机 / 客户端显示 / 与 6.2 同源 三个方向。#8 定位到 timed-text-edit 相关代码。
- 2026-10-15 续 2：#1 单测 `test_comparison_survives_discarding_intermediate_artifacts` 通过（1/1 OK），
  流水线确实保留对比页，待维护者提供复现路径后定「仅说明」。#6.2 入口线索：i18n `open_mawe:
  "打开编辑器"`（launcher-strings.js:118）。#9/#10 录入。
- 2026-10-15 续 3：#11、#12 录入。确认截图落盘目录
  `~/.paseo/desktop-attachments`（用户主目录），#5/#7/#8/#9/#10/#11/#12 相关截图已复制到
  本目录 `assets/` 并在条目引用。三个子代理在后台调查：#6.2 启动链路、#8/#9/#10/#11
  timed-text 模块、#12 拆分符号迁移。
- 2026-10-15 续 4：timed-text 子代理报告返回，三处关键 file:line 抽查全部吻合
  （`timed-text-edit.js:348–349`、`.input-clear` 复用模式、search-row button `editor.css:3380`）；
  #8/#9/#10/#11 根因与修复点落定，报告原文存 `TEST_FEEDBACK_BETA1-investigation-timedtext.md`。
  #10 改「待处理」（映射正确、仅展示口径错）。#13 录入并派子代理调查。
- 2026-10-15 续 5：拆分符号子代理报告返回，四处抽查全部吻合（`WRAP_CHAR_PRESETS`、修剪集、
  `buildSplitPair` 挂载点、`assMarkedRanges`）；#12 根因与两处挂载点方案落定，报告原文存
  `TEST_FEEDBACK_BETA1-investigation-split-markers.md`。剩余未回：#6.2、#13 两个子代理。
- 2026-10-15 续 6：#13 子代理报告返回、三处抽查吻合（`:757` 硬编码、`:409` 唯一写入点、
  `editor-json-repair.js:46` 条件写出模式），方案落定（新顶层字段 `timed_text_edit_view`），
  报告存 `TEST_FEEDBACK_BETA1-investigation-view-state.md`。调查全部完成，仅剩 #6.2 子代理未回。
- 2026-10-15 续 7：维护者提供 #1 复现（多 AI 步骤 + 对比页 → 完成后中间步骤对比页在后处理文件夹
  被删，多步骤特有），派子代理追查根因。#6.2 受控复现结果入账（干净 serve 工程加载正常、
  30 秒未下发 thumbnailBinding、疑需页面 JS 触发延迟加载，worker 状态待真实浏览器会话判定）。
  **汇总已发布 GitHub Issue #237**（Moyf/moys-asr-workflow），作为后续 agent 接手实施的交接文档；
  本账本与调查报告、assets 截图仍为本地未提交状态。
- 2026-10-15 续 8：#1 子代理报告返回，两处抽查吻合（三个翻译包装均未透传 `comparison_path`，
  全仓 grep 证实；`_copy_atomic` 为真复制）。根因落定：观感层 = 幸存副本目录错位（转写输出目录/
  `_maw/`，ASCII 名）+ run 目录整体清理；真缺陷 = translate 对比页被丢且 manifest 无记录。
  报告存 `TEST_FEEDBACK_BETA1-investigation-comparison-deletion.md`，结论已评论到 Issue #237。
  #1 改「待处理」。**至此 13 项全部调查完毕、方案就绪，交接完成，等后续 agent 按 Issue 实施。**
- 2026-10-15 续 9：维护者确认 #1 步骤组合 = AI 校对 + 翻译 + 烧录字幕（无口播整理），缺失的
  html 正是 translate 对比页 → 与已确证的翻译包装缺陷完全吻合，E 项闭环（此前「仙木杯」误读
  已更正：截图即 `examples/仙术杯开场/_maw`）。确认评论已发 Issue #237。
- 2026-10-15 续 10：#14 录入（替换展开时 Tab 焦点顺序），结构已由 timed-text 调查报告覆盖，
  无需另派子代理；已同步进 Issue #237 正文（A 组第 6 项）。
- 2026-10-15 续 11：**规则变更（维护者指示）**：不再保存截图、图片不入 git——`assets/` 已删除
  （回收站），条目内「参考：assets/…」引用全部移除、必要信息已在条目文字中，unknown-*.png
  未决关闭。#15 录入并当场定位根因（`editor-text-process.js` 预览重建无跨渲染展开状态），
  方案就绪；已同步 Issue #237（新增 F 组，标题改 15 项）。
- 2026-10-15 续 12：#16 录入（文本处理样式按钮改多选 toggle，状态/aria-pressed/叠加包裹/
  自定义字段方案草案齐备）；#17 录入并定位（核对清单工具：重置二次确认 + 全勾选自动收起
  默认开，模板锚点已找到）；#15 补充规则——任何选项变化（含「只处理选中字幕」）都保持展开。
  三者已同步 Issue #237（E 项改闭环、新增 F/G 组，标题 17 项）。
- 2026-10-15 续 13：#18 录入（新增字幕被拒提示按「重叠」开关补充引导文案），出处已定位；
  已同步 Issue #237（新增 H 组，标题 18 项）。
- 2026-10-15 续 14：#19 录入（双语/字词码波形高度与每行长度改名「自动适配」+ 启用只增不减），
  机制锚点已核对（`editor-display-settings.js:82-101/:93/:116`）；已同步 Issue #237（新增 I 组，
  标题 19 项）。
- 2026-10-15 续 15：#20 录入（字词拆分确认弹窗：删红字、换三句正文、摘要行加大字号），
  摘要行锚点 `editor-word-timing.js:172-175`；已同步 Issue #237（H 组改「提示与对话框文案」
  并入 #20，标题 20 项）。
- 2026-10-15 续 16：#21 录入（Shift+拖动主字幕切叠加轨的后续抖动问题），派子代理追查
  切轨与既有防跳优化实现；已同步 Issue #237（新增 J 组，标题 21 项）。
- 2026-10-15 续 17：#22 闭环（两种状态 = `word-timing-full` 等高分层 / `word-timing-compact·background`
  紧凑叠加；描边恢复锚点 `waveform.css:896-903`）；#9 补充（clear 对齐工程设置搜索原生
  type=search X）；#23 录入（双语字幕开关移入专属标签页）。已同步 Issue #237（K/L 组，标题 23 项）。
- 2026-10-15 续 18：#24 录入（checklist 导出范围改名+默认、条目复制按钮），实现点已定位
  （导出过滤 :552-567，语义按「未确认 ∪ 有备注」理解待确认）；已同步 Issue #237（G 组并入
  #24，标题 24 项）。#21 子代理第二次调查进行中（首次空回复，已重派）。
- 2026-10-15 续 19：#25 录入（单点标记固定 8px 宽），实现点已定位（`markers.js:100-111` 百分比
  下限 + 拖拽预览 :626-632）；已同步 Issue #237（新增 M 组，标题 25 项）。
- 2026-10-15 续 20：#26 录入（区段标记「定位试听」改走 auditionRange 只播该范围），两侧锚点
  已核对（`editor-marker-editing.js:212-225` / `editor-context-menus.js:345-349`）；已同步
  Issue #237（M 组并入 #26，标题 26 项）。
- 2026-10-15 续 21：#27 录入（老问题：全屏切换时 ASS 预览压扁后延迟恢复），派子代理查预览
  渲染链路与全屏事件处理；已同步 Issue #237（新增 N 组，标题 27 项）。
- 2026-10-15 续 22：#27 子代理报告返回、两处抽查吻合（防抖 :130/:150、48px 守卫 :37-43），
  根因落定（「等稳定再画」策略 + 过渡几何被采进稳定缓存），修复方向三条就绪；报告存
  `TEST_FEEDBACK_BETA1-investigation-ass-fullscreen.md`，N 组改闭环。#21 重派子代理仍在跑。
- 2026-10-15 续 23：#21 重派子代理报告返回、两处抽查吻合（守卫注释 :96-103、`fitsMain`
  :132-135、修复来源 3cc689ca）；根因落定（旧守卫不看叠加轨占用 + 叠加轨钳制把落点挤出 +
  `fitsMain` 回轨，每 2-3 帧往返），修复方向四条就绪；报告存
  `TEST_FEEDBACK_BETA1-investigation-overlay-jitter.md`，J 组改闭环，建议补 e2e。
- 2026-10-15 续 24：#28/#29 录入（调色板黄改 #f9ca1f 全盘更新；去空隙导出卡顿参考
  LosslessCut 修复），并行派两个子代理；已同步 Issue #237（O/P 组，标题 29 项）。
- 2026-10-15 续 25：#30 录入（去空隙导出弹窗样式对齐 + 完成后打开文件夹/关闭按钮），实现点
  已定位（`.gap-video-job` editor.css:4410-4425；编辑器侧无打开文件夹通道，需 serve.py 新增
  受限端点）；已同步 Issue #237（P 组拆 P-1/P-2，标题 30 项）。
- 2026-10-15 续 26（收口）：#28/#29 两个子代理仍在途，报告到达后由本会话核对入账并更新
  Issue；若本会话结束仍未到达，接手 agent 需重跑调查（#28 问题清单见 O 组、#29 见 P 组，
  含 MergeCuts 参照与「不得卡顿」硬性要求）。流程已沉淀为项目级 skill
  `.opencode/skills/feedback-issue-triage/SKILL.md`（经维护者同意）。**最终状态：30 项中
  28 项闭环（待处理 25 / 仅说明 1 / 已核实无需改动并入其他项），#28/#29 调查在途；
  Issue #237 为完整交接文档。**
- 2026-10-15 续 27：#28 清点报告返回、四处源头锚点吻合，A/B/C/D 四组改动清单 + 测试同步点
  就绪（报告存 `TEST_FEEDBACK_BETA1-investigation-yellow-defaults.md`），#28 改「待处理」，
  C/D 组是否纳入待维护者确认。#29 调查仍在途。
- 2026-10-15 续 28：#29 调查报告返回、四处抽查吻合（`-c copy` 命令、ffconcat 清单、导出链路
  零关键帧处理、测试夹具 `-g 1`），根因落定（concat inpoint 非关键帧 + 纯流复制 → 拼接点
  时间戳重叠/倒退，FFmpeg 官方文档背书）；推荐修复 = inpoint 关键帧吸附（与维护者接受的
  MergeCuts/关键帧延伸一致）。报告存 `TEST_FEEDBACK_BETA1-investigation-gap-export.md`，
  P-1 改闭环。**至此 30 项全部调查完毕，批次彻底收口；Issue #237 为完整交接文档。**
- 2026-10-15 续 29：维护者逐项拍板五项：#28 只改 A+B（C/D 保持现值）；#4 阈值 >50%；
  #7 新文案「ASS 字幕预览 OwO」；#24 采用新语义（未确认 ∪ 有备注）；#12 fade 拆分时两侧
  新行各自补齐完整 `>>…<<` 对。全部回填账本与 Issue #237。**全部条目达到可实施状态，
  等维护者开实施 agent。**
- 待办顺序：收 #1 子代理报告 → 核对入账并补进 Issue #237 → 后续 agent 按 Issue 实施；维护者
  拍板项见 Issue「待维护者决策」一节。
- 未决（已收敛）：原 `assets/unknown-*.png` 三张未归属截图随 `assets/` 一并删除
  （2026-10-15 规则变更，图片不入 git）；维护者未再提及，视为无必要信息。
