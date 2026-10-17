# 1016 大核验 — 测试反馈与处理记录

维护者实测期间反馈的问题清单。**流程约定：收到反馈先记录到本账本，再调查补充**，
避免上下文压缩丢信息。核对结论与后续补充直接更新对应条目；代码调整等这批反馈
收尾后统一实施（由维护者统一安排）。

- 日期：2026-10-16；基线：release1.9.0-beta.2（`docs/logs/INDEX.md` 顶部 `log-release-baseline`）。
- 分支 / HEAD：`melodic-cat`（worktree）@ `2cc67041`，建账时 `git status --short` 干净。
- 状态取值：`待处理`、`进行中`、`已修复`、`仅说明`、`阻塞`。
- 截图：**图片不入 git、不存仓库**——截图里的必要信息（界面位置、数值、文案、报错原文）
  转成文字写入对应条目；没有额外信息量的图直接忽略。
- 调查分工：主会话负责记录与核对；小项当场查，复杂项派只读子代理；**小规模实施项派实现
  子代理（2026-10-16 维护者指示，见 skill `feedback-issue-triage`）**，结论与 diff 经主会话
  抽查核实后写入本账本。
- 收口：维护者说「发 Issue / 收口」时，用 `gh` 开单个 tracking issue 作为交接文档；
  正文按功能模块分组，「条目 N」与本账本 `#N` 一一对应（GitHub 文本不用 `#数字` 作序号）。

## 问题清单

| # | 问题 | 状态 | 核实结论 / 方案 |
| --- | --- | --- | --- |


| 1 | 缩略图现在加载完显示出来时是直接出现的，希望加一个短的 fade in 动画避免突兀（不透明度变化就可以） | 已修复 | 维护者分类：**简单类，直接开发**，收口时在 Issue 上标「已完成」。已实现并验证：`web/editor/media/waveform/thumbnails.js` 绘制层逐格淡入——每个画面身份（strip=`picture.actual`，marks=`requested_ms`）首次绘制起 200ms alpha 0→1，淡入期间垫占位格底色、rAF 持续重绘该行，完成后稳定全不透明（重绘/滚回不重放）；`waveform-types.d.ts` 同步类型。验证：bundle 重建 fresh、`build-editor.mjs --check` 通过、editor 脚本语法/顺序 node 测试通过、tsc typecheck 通过（`--listFiles` 确认 thumbnails.js 在检查范围内）。浏览器观感待维护者实测 |
| 2 | 纯文本编辑「修改前/后」的时间范围行调整（截图：`时间范围：00:00:16,400 – 00:00:19,280 → 00:00:16,400 – 00:00:18,433` + 下行 `时间范围为自动估算（按原字幕范围＆文字长度分配）`）：① 改 diff 式显示，start 未变时收成 `00:00:16,400 → ~~00:00:19,280~~ – 00:00:18,433`；② 每个时间用独立胶囊样式，未变=原文本色、变化前=红色（+删除线）、变化后=绿色；③ 「时间范围为自动估算」独立行改为「时间范围」行尾 `[估算]` badge，hover tooltip「缺少可靠时间码，新时间范围基于字数估算。」 | 已修复 | 实施子代理完成，主会话抽查通过：共享 helper `appendTimedTextEditTimingChange`（`editor-timed-text-edit.js:133-176`）三情形着色与拍板规则逐条吻合（两端变 :140-149、start 变 :150-157、end 变 :158-165），badge 挂行尾 :167、timing 未变但 estimated 时 badge-only 兜底行 :171-175；旧估算 div 与死 i18n 映射已删净（rg 无残留）；pill/badge CSS `editor.css:3570-3582`（红绿复用 diff 的 `--red-hover`/`--green-hover` token，badge 间距实测 8px）；i18n `editor-i18n.js:1114` + EN_ATTR tooltip（title 属性经 MutationObserver 自动翻译，无需手动赋值）；行内 diff 与「查看修改内容」两处共用 helper → #8① 一并覆盖。验证：bundle fresh、check:editor、语法/顺序测试、tsc、git diff --check 全过。待维护者浏览器实测；EN 文案（Est. / Time range: / tooltip 长句）可调。已知微调：结构行 timing 恒变但值相同且非估算时不再渲染 `S – E → S – E` 冗余行（原则的自然结果） |
| 3 | 「过滤字幕」的清空按钮样式与「设置搜索」「纯文本编辑」搜索框不匹配（截图：现为独立圆形 X 按钮带「清空」tooltip，浮在输入框右侧）；要求改用 X 直接放在输入框结尾，与另两处一致 | 已修复 | 实施子代理完成，主会话抽查通过：采用首选方案（原生 `type="search"`，wrapper 一并移除——`.input-clear` 全仓无其他使用者已核实）：模板 :2136 裸输入框（rg 确认）；CSS `.input-clear`/`.clear-x`/`.has-value` 整块删除、flex 规则移交 `#search`；JS `searchWrap`/`refreshSearchClearVisibility` 及 `editor-wiring-search-filter.js`/`editor-server-save.js` 调用点全删（rg 无残留）；原生 × 触发 `input` → 防抖 `applySearch('')` 链路确认。验证同 #2。注意：× 是 Chromium 原生渲染（无 tooltip；Esc 清空原生触发同样走 applySearch）——符合「X 直接放输入框结尾」规格；tests/ 无相关引用已核实 |
| 4 | 新内部术语：**MASS（Markdown-ASS）** = `**强调**`、`!!震动!!`、`>>淡入淡出<<` 这类给 ASS 用的标记语法；写进工程相关文档统一称呼 | 已修复 | 文档子代理完成，主会话抽查通过：`docs/user/ASS_STYLES.md:62`「特殊文本格式」章节引入总述句、`docs/user/EDITOR_GUIDE.md:59` 文本处理总述句末追加，原文与报告一致；`git status` 确认仅这两个 docs 文件被该子代理改动；纯文档改动无需 bundle。举例刻意避开非 MASS 项（♪ ♬ []）与 UI「强调色」混淆点 |
| 5 | 「修改文字自动同步到时间码」对 MASS 符号的分配需要改进。现状：符号散落到前后字词（「我是今天的*解说*」→ items「我是」「今天的*」「解说*」，截图证实）。期望（同 item 已拍板）：符号对加在**同一 item 两侧**→「我是」「今天的」「*解说*」。跨 item 情形两方案待分析拍板：方案 1 = 同步时给每个涉及的 item 补全符号对；方案 2 = item 内保持原样散落、拆分时给拆分后字幕/字词补齐符号对（「今天*的」+「解说*」拆分后→「今天*的*」/「*解说*」）。维护者：两种哪种好，帮我想想 | 已修复 | **维护者拍板方案 2（2026-10-16）**，实施子代理已派（后台）。实施四步：① 同 item 归位——wordCharRanges 系加 assMarkedRanges 配对感知，符号对完整落在单 item audible 范围 → 两符号移入该 item（移动守恒，跨 item 保持散落）；② 拆分补齐——buildSplitPair/splitAtCursor + cleanSplitItems，文本与 items 两层同时补全跨拆分点的对（含已拍板 fade `>>…<<` 两侧补齐规则），**顺带闭环 beta1 #12**；③ 合并折叠——joinSegmentTexts 后相邻「闭+开」同符号对折叠，防拼出 `**` 被误解析为强调，items 层同步守恒（主/副/overlay 三处合并路径）；④ 显示重分配与同步复验用同一规则（wordTextsFromSource/partialWordTextsFromSource 与 wordCharRanges 一致，否则复验打架）。**已修复（子代理实施+抽查）**：四任务落地——归位（massPairCharOwners/wordCharRanges 三处同规则+码点换算，setMassSymbolRule 与设置同源）、拆分补齐（completeSplitMassPairs 含 fade 外壳与复验回退；buildSplitPair/splitAtCursor 接入，items 层 appendMassMarkersToLastItem 等同步守恒）、合并折叠（foldMassPairJunction + joinSegmentTextsMassFold，主/副/独立/overlay 四路径）、stripMassMarkers 导出剥离（srtSentenceText 复合链：句级 fade→shake→成对 MASS；TXT 从不剥改为同语义）。测试：新建 test_mass_markers + test_word_timing 新增 6 项（41/41）；Python 全量 2347 过；3 处既有测试断言随新语义更新 |
| 6 | 用户填写 MASS 后，导出 SRT/TXT 这类纯文本时先做符号剥离（理由：MASS 目前没有外部工具能利用上） | 已修复 | **已修复（随 #5 同批，抽查通过）**：stripMassMarkers 接入 srtSentenceText 复合链（句级 fade→shake→成对 MASS，顺序防重复剥），TXT 从不剥改为与 SRT 同语义，动态字幕/Resolve/OTIO/FCP7 经 subtitleExportText/export-plan 生效，ASS 不剥（测试断言字面保留） |
| 7 | 纯文本编辑「逐条编辑」里清空的字幕行，有时不显示「整句删除（时间码已转移到其他字幕）」提示（截图：第 12 条清空后下方无任何提示行），有时又能看到——疑似疏漏 | 已修复 | 主会话直接查。report 语义（`web/shared/utils/timed-text-edit.js`）：rows 模式 `changed: before !== after`、`deleted: before非空且after空`（:233-234 附近）→ 纯清空理论上 changed=true、容器不该隐藏——与截图矛盾。调用方已定位：`updateTimedTextEditReport()`（editor-timed-text-edit.js :667 起）逐行取 rowReport 渲染。**注意：在途子代理正在重构此文件，行号已偏移（:684 已变为别的内容），精确根因核实与修复放在追加批次（子代理自带重构上下文）**。候选根因保留：hidden 判定漏 deleted / rowReport 取值路径在结构模式下错位。**已修复（子代理实施+抽查）**：真根因=结构模式行报告配对用位置化队列，**本来就为空的来源行**错误消耗 deleted 行配额，真正清空的行拿到 null 不渲染；改为按 `sourceOutputIndexes` 空缺配对（`timedTextEditDraftRowReports`，当前 :656/:670），hidden 守卫补 deleted 防御 |
| 8 | 「查看修改内容」（整体编辑右侧）补充要求：① 时间范围的 diff 式/胶囊/估算 badge 修改要同步覆盖该面板；② 该面板**默认展开** | 已修复 | ① 已在 #2 子代理任务范围（共享 helper 两处调用，`renderTimedTextEditChangeList` :178），抽查时重点确认；② 新增：现逻辑仅筛选时强制展开（`editor-timed-text-edit.js:179` wasOpen、:198 `open = Boolean(filter && filter !== 'unchanged')`），默认态需查模板 details 初始 open 与 draft 状态。与 #7 同批追加给在途子代理（同文件避免并行冲突）。**已修复**：draft.changeListTouched 区分「初始默认」与「手动开合」（summary click 落旗）；有内容且未手动碰过 → 强制展开，碰过 → 保留 wasOpen（手动收起不被击键弹开）；筛选态仍强制展开 |
| 9 | 纯文本编辑**左下角**新增 checkbox（默认不勾选）：「修改后移除字幕前后空格」——应用修改时去掉字幕文本首尾空格（截图：整体编辑文本框多行有明显前导空格） | 已修复 | 排期：与 #7/#8 同批追加给在途子代理完成后继续（同文件 `editor-timed-text-edit.js` + 模板）。实现要点：勾选状态存 timedTextEditDraft（参照现有字段模式，含恢复逻辑）；作用于应用/提交步骤对修改行 `trim()`；zh 文案 + `editor-i18n.js` en 映射；checkbox 与相邻元素间距按 UI 约定；改动后跑语法/顺序测试 + bundle 重建。**已修复**：draft.trimWhitespace 默认 false，trim 实现为 effective texts 层（**预览=应用一致**、先于时间码映射）；模板 :2530-2531、editor-dom :477、i18n EN+title。**维护者确认（2026-10-16）：接受**——trim 作用于全部行（含未编辑行），维持现状 |
| 10 | 「逐条编辑」搜索时目前只高亮命中字幕行；希望在此基础上给**文本框中命中的词**加背景高亮（类似「整体编辑」已有的效果） | 已修复 | 排期：与 #7/#8/#9 同批追加。机制已查：「整体编辑」用镜像层高亮——`#timed-text-edit-search-mirror`（模板 :2510）、`renderTimedTextEditSearchMirror(matches)`（:425）、滚动同步 :1128-1130，绑定单一 `timedTextEditSingleTextarea`；逐条行是多个纯 textarea（无镜像），需每行配 backdrop 镜像（字体/边距与 textarea 严格一致）+ 滚动同步 + 当前命中项定位联动（:501-508 现用镜像定位当前条）。兼容 Aa/正则两模式。**已修复**：每行 backdrop 镜像、仅命中行渲染（无命中零成本），行 textarea 高亮态文字透明化+caret 保留，滚动委托同步，当前命中琥珀高亮；CSS :3521-3548；已知限制=极端软换行像素偏差（与整体编辑镜像同款） |
| 11 | 「修改影响」统计面板里 **0 条的项目默认不显示**，只显示数量 >0 的（截图：修改后完整映射/部分保留/边界移动/时间码丢失/原本没有字词码 均 0 条仍占行） | 已修复 | 排期：与 #7/#8/#9/#10 同批追加（同文件）。锚点：`updateTimedTextEditReport()` 渲染 mapping 区（`editor-timed-text-edit.js` :695-710 一带，`appendTimedTextEditStat(MaweDom.timedTextEditReportMapping, …)` 逐项 + :696 divider）；实现：每项 count>0 才 append，全 0 时 divider/区块整体隐藏；顶部「字幕行/修改内容/字符变化」汇总行不受影响。**已修复**：声明式条目表 count>0 才渲染、全 0 连分隔线整体隐藏（当前 :771-787，抽查吻合） |
| 12 | 工程「未保存」状态没有体现在 UI 上：希望右上角工程名在未保存时斜体+前加圆点，或换颜色（维护者让主会话判断哪种方便效果好） | 已修复 | 排期：追加批次。主会话判断：**圆点方案**——工程名前加 ●（accent/警示色）+ `title` tooltip「有未保存的修改」，保存后消失；不用斜体（中文斜体是伪斜体、观感差且字宽微变引起布局抖动），颜色只作圆点辅助。脏状态源现成：`MaweServerSave.hasUnsavedProjectChanges()`（`editor-server-save.js:371`，导出 :586；现有消费 `editor-startup.js:105` beforeunload、`editor-drag-drop.js:45`、`editor-wiring-media-inputs.js:13`、`editor-wiring-project-inputs.js:100/:106`、自动保存 :331/:387/:397）。工程名显示元素未定位（头部在模板 :89 导出字幕按钮一带、名字由 JS 填充），实施时定位并接线；注意保存/自动保存成功后刷新指示器的时机。**已修复**：`h1 .json-name.dirty::before` 琥珀 ●（CSS :595；伪元素不进 textContent，复制文件名与 e2e 断言不受影响）；title 脏时「有未保存的修改；点击复制工程文件名：…」并手动翻译；刷新=保存钩子（markProjectSaved）+ 工程加载 + **1s 轻量轮询兜底**（干净态经保存钩子即时）。**维护者确认接受**（2026-10-16）：轮询经核实为 O(字幕数) 布尔标志检查（hasProjectChanges，editor-state.js:104-111，无 JSON 指纹/DOM），每秒一次开销微秒级，可接受 |
| 13 | 当前存在选中字幕时，打开纯文本编辑自动滚动到选中字幕的位置（多选取第一个） | 已修复 | 排期：追加批次（同文件 `editor-timed-text-edit.js`）。实现要点：打开/视图初始化处读当前选中状态源 → 命中行 scrollIntoView；逐条/整体两视图分别处理（整体视图滚 textarea 至对应行）；无选中维持现状；注意行渲染是异步/分批时先渲染再滚动。**已修复**：openTimedTextEdit 行同步渲染完成后 scrollIntoView 居中（覆盖 focus 回顶）；多选取**最小序号**（**维护者确认接受**，2026-10-16）；选中项不在草稿（隐藏行）维持现状 |
| 14 | 只选中一个**叠加字幕**时按 B 拆分，拆的不是这个叠加字幕（截图：叠加轨「好啊」块选中黄框，按 B 未拆它）——热键目标解析疑似只认主轨 | 已修复 | 主会话直接查。已读 `editor-wiring-edit-shortcuts.js` B 处理（:690-810+）：三分支（列表悬停 :773-779 / 指针 :781-797 / 播放头 :799-810+）有主轨+extension 处理，**overlay 未见于已读部分**；extension 有专门例外分支（:716-759，selectedExtensionIdxs 单选 + activeCuePanel 判定）。继续读完 handler 确认 overlay 是否完全缺失，修复排期视文件冲突定（split-core 在 #5/#6 辖区）。**根因已确认**：B 三分支只解析主轨+extension，overlay 完全缺失（handler 止于 :816）；overlay 拆分管线现成（`openOverlaySplitModal`/`commitOverlaySplit`，split-core 已有 kind==='overlay'），修复=edit-shortcuts 加 overlay 例外分支（镜像 extension 模式 :716-759）；只改 `editor-wiring-edit-shortcuts.js`，与在途批次无冲突，已派修复子代理 |
| 15 | 选中**无时间码（未绑定）的副字幕**想拆分，报「当前断点无法把副字幕文本各拆成两段」无法拆分；问：不能按字数估算映射拆分吗 🤔 | 实施中（追加批在途） | 主会话直接查：定位该报错与副字幕拆分的前置条件（大概率要求字词时间码绑定），评估「按字数估算拆分」可行性（纯文本编辑已有字数估算先例）；涉及估时/无码拆分的产物形态需要设计，属于需求合理性评估后给方案。**定性**：代码原文是「当前断点无法把**主副**字幕文本各拆成两段」（split-core :1571，截图文案疑为速记/同族）；已定位 linked-split 的 `!state.textValid` 守卫族，未绑定无字词码时的确切失配点待深查；评估方向=无码副字幕按字数比例估切点（工程内有字数估算先例）。**排队**：需改 split-core（#5/#6 子代理辖区），等其完成后实施 |
| 16 | 「左右添加字符」右键菜单 + 【文本处理】批量面板调整：① 菜单**上移一层**（现嵌在「高级操作」内），放「高级操作」上方，叠加轨迁移留在高级操作；② MASS 项与常驻部分（音符/双音符/中括号/自定义）之间加分隔线；③ 右键菜单排序：强调、放大、弱化、缩小、删除线、下划线 ／ 分隔线 ／ 淡出淡入 [整句]、原地震动 [整句]（badge 胶囊缀在标签后）；④ 批量面板同步新排序：整句两项放**第二行**、**行首**加 [整句] badge；⑤ **处理顺序规则修复**：多选叠加现按点击顺序向内加（截图 `**++--__~~>>[]!!文!!][]<<~~__--++**`），**整句符号（>>…<<、!!…!!）必须恒在最外层**，否则句级样式失效；⑥ 「注释文本」改名「弱化文本」 | 已修复 | 锚点：菜单构建 `editor-context-menus.js:277-317`（visibleWrapCharPresets → WRAP_CHAR_PRESETS）、单选调用点 :382（advancedList）；面板模板 :2365-2390；预设源 `text-processing.js:489-502`；applyWrapChars 同文件；改名同步 i18n + ASS_STYLES/EDITOR_GUIDE。**已修复（子代理实施+抽查）**：调用移出 advancedList（:407/:437 裸调用）、sentenceLevel 分组+分隔线+badge、面板两行、句级恒最外规则（含截图复现守恒单测）、改名 0 残留；EN 'Subdued text'/'Sentence' 可调；验证全绿；面板胶囊间距待实测、e2e 改未跑、bundle 红=预期待统一重建 |
| 17 | 「过滤字幕」placeholder 的省略号去除 | 已修复 | 「过滤字幕…」4 处全改（模板 placeholder + i18n zh/en + e2e 断言×2），rg 0 残留 |
| 18 | 「去除 md 格式符号」与 MASS 互相打架：MASS 就是 markdown 符号，md 清理会移除已添加的 `**__` 等 | 已修复 | 拍板方案 B：维持现状 + hint 工作流约定。**微批次已实施（抽查通过）**：hint 改为「移除常见 Markdown 标记；含特殊文本样式（MASS）符号时会一并移除，建议先清理再加样式」（模板 :2362，i18n :1149 zh/en 同步）。方案 A（MASS 感知剥除）暂不做，记录在案 |
| 19 | 拆分 × MASS 三个联动精修：① 嵌套句级对补齐缺失——`>>!!这样的|文字!!<<` 拆分后只补了 >><<，内层 !!…!! 没补（预期两侧都补齐 → `>>!!这样的!!<<` / `>>!!文字!!<<`）；② 规则决策（维护者问）：要不要定死「>><< 套在 !!…!! 外面」的规范顺序；③ 「修剪前后空白」应**穿透两侧格式字符**：「!! 前面有空格!!」修剪后应为「!!前面有空格」（现在不动），>><< 同理 | 实施中（追加批在途） | ② 主会话判断：**不定死**——补齐按原文本嵌套逆序闭合即确定正确（crossing 不会发生，assMarkedRanges 对两种嵌套都解析）；定死顺序反而多一层规范化且与 #16「新句级最外」的包裹规则叠加后无用户可见收益；把「逆序闭合 + 修剪穿透符号壳（可叠多层）」写成单测固定即可。①③ 与 #5 任务 2/拆分修剪同文件同批，等在途子代理报告落地后随会话追加 |
| 20 | 部分字幕轨道设置切换会改变波形行高/每行长度（如字词码开关、双语字幕），改完视口跑偏找不到原位置；希望改变后把画面滚动回播放头所在位置 | 已修复 | 主会话定位后派实施。已知锚点：行高联动 `syncWordTimingWaveformSettings`（editor-display-settings.js:82-101，beta1 #19 一带）、双语 `syncMultiSubtitleWaveformRowHeight`（:116 一带）；现成滚动 API：`revealTime`（scale-controls 模块）、`centerBasicOnCurrentTime`（media.js）。实施要点：枚举真正改变波形几何的轨道设置，变更应用后统一 revealTime(播放头)；仅几何真变时触发（值未变不滚）。**已修复（子代理实施+抽查）**：`revealPlayheadAfterWaveformGeometryChange`（editor-display-settings.js:50，isMultiMode 门控）挂两处——applyWaveformModeRowHeight 值真变分支（:70）、syncWordTimingWaveformSettings 的 render 后（:121）；覆盖字词码开关、双语开关、双语/字词码行高预设输入；时序依据 render() 同步无 rAF；basic 不覆盖（控件禁用、helper 门控防跳动）。**遗留一项**：字词码「每行长度」预设输入直调 setSecondsPerRow——**已补（微批次，抽查通过）**：editor-wiring-settings-init.js（实际路径 ui/ 非 cues/）before 比较后 setSecondsPerRow + revealPlayheadAfterWaveformGeometryChange（facade 补导出 :344），值未变不滚动。**维护者复测（2026-10-16）：Q 路径仍有问题——锚点模型修正**：Q（editor-word-timing.js:227-239 → setEnabled）已过挂钩，但 reveal 播放头 ≠「正在看的位置」——播放头在屏外时切换完直接跳到播放头，正是维护者说的「跑到不知道哪里去」。修正：几何变更前捕获**视口中心时间**（timeMsAtPoint），渲染后还原该时间到画面内（第一性原理：保留正在看的字幕）；播放头恰好可见时效果等价。**已落地（末批，抽查通过）**：captureWaveformViewportCenterTimeMs/restoreWaveformViewportAfterGeometryChange 替换原 helper（editor-display-settings.js:57-90），三个几何入口捕获在写前、还原在 render 后（basic=窗口中点算术、multi=垂直中点命中行内中点）；Q 路径 rg 清点无遗漏（工具栏 select 与滚轮行高两个非 Q 入口未挂钩，留维护者定夺）。**终态验证：全量 test:unit 790/790** |
| 21 | Edge Case：对 `__really fun__` 使用「字词拆成字幕」，生成的两条新字幕没补齐 MASS 符号（`__really` / ` fun__` 断裂）。维护者提议：**把补齐逻辑提取为共享 helper，用于各种拆分路径**——B 拆分、字词拆字幕、纯文本编辑的结构拆分等，避免各处遗漏、修改不用到处改 | 实施中（追加批在途） | 与方案 2 架构一致，采纳：共享 helper 放 web/shared/utils，所有拆分出口接线。涉及 `editor-word-timing.js`（字词拆字幕）、`editor-split-core.js`（B 拆分两条路径）、`timed-text-plans.js`（纯文本编辑结构拆分）+ #19①嵌套补齐、#19③修剪穿透。等在途 #5/#6 报告落地后按其实现收敛成单一工具 |
| 22 | 单行波形在显示范围=2 秒（最大放大）时，滚轮滚动（前后平移）有明显卡顿；5 秒/10 秒档感知好很多。维护者猜测：分段加载太密集？（但 2 秒显示内容应更少）/ 刷新范围没对齐（一滚刷新前后一大片）？原因未知，要求调查并给改善方案 | 实施中（追加批在途） | explore 报告+主会话抽查 4 处吻合。**根因**：① 每帧三份全量工作×持续饱和——整行 canvas 全量重绘（包络缓存按窗口 key，平移每帧必失效重建）+ 覆盖层 DOM 每帧全拆全建（render.js:161-165，含监听器重挂+强制布局）+ 画面带整条重绘（renderKey 含 start/end 每帧必失效）；每档滚轮固定推进窗口 12%（input.js:613），2 秒档=240ms/档，同样距离要 5-10 倍输入 → 管线全程饱和，5/10 秒档有喘息帧所以感知好。② 2 秒档独有细网格 20-60 条独立 stroke（canvas.js:77-91）。③ 画面带 2 秒档格距 250ms + setView 每帧 bump view 使在途取图作废。变波无独立开关=同一绘制路径，非额外开销。**改善分层**：批次 1（便宜）=细网格合并 stroke+computeGroupBadges 移出热路径（render.js:142 每帧全量）+picture() 去掉每格 spread+画面带 setView 节流 ~150ms；批次 2（核心）=平移期位图平移+按绝对时间锚定的列缓存包络+停止后精绘；批次 3（重构，最后）=覆盖层 DOM 增量 diff。维护者猜测的「分段加载太密集」部分成立（③），「刷新范围没对齐」实情=范围没超但单位太大。**维护者拍板（2026-10-16）：实施批次 1+2，批次 3（DOM diff）暂不做**；#23 子代理正在改同区波形文件，其实施排 #23 完成后立即派发（禁并行） |
| 23 | 单行（basic）波形显示字词码改进，**语义已与维护者两轮对齐定案**：① 几何模型——波形 canvas 保持**全行高**不因字词码改变；字幕块**不再被压窄**；字词块条带 Y 轴紧贴字幕块上方（两者不重叠），字幕/字词块整体 Z 轴浮在波形背景上（现状=字词码开启时字幕块变窄+波形让高，全部改掉）；② 窄块可读性——维护者方案：**tooltip 式文字预览气泡**，在字词块 Y 轴上方浮出全文 chip，仅单行模式生效；密度控制=同屏 chip 数硬上限（约 24）+ 最多叠 3 行，超限按优先级丢弃（当前播放字 > 距播放头/视口中心近 > 行序稳定，防滚动闪烁） | 实施中（子代理在途） | 主会话设计补充：气泡只给**文本溢出的块**（测量驱动，非全部块）；实现建议并入字词块 canvas 绘制层（同 pass 画 chip，pointer-events:none 不挡交互）；原生 title 保留兜底；A（当前字展开）/B（自适应字号）暂不做，看气泡实机效果再议。**已修复（子代理实施+抽查）**：几何=waveform.css basic 专属覆盖（删除压窄 35px 规则；条带 bottom=9px+块厚+2px，与块 y 不相交；multi 不变）；气泡=canvas 同 pass 绘制（drawWordChips/computeWordChipLayout：24 上限/3 行/播放字优先，截断测量驱动）；e2e word-timing 40/40（几何断言随新模型更新） |
| 24 | 新增/变更：字词时间码启用时**允许拖动字幕块**（现状禁止拖动）。维护者忘了当初禁用的原因——要求先查清历史原因再评估放开方式（拖动时字词码 items 如何跟随/是否失效重映射） | 实施中（追加批在途） | **历史原因（PR #177 `b931b181`，代码注释 cue-blocks.js:333-335）**：紧凑叠加模式下整句块「退为背景」，禁拖是为了**避免与字词块抢指针**；补偿=选中句保留两端手柄可拖边界（:336-350）；等高分层 full 模式（行高≥96）拖动一直可用（:359 条件）。**放开可行性已确认**：拖拽提交层本就重映射 items（cue-drag-update.js:165-166 move 平移、:372/:403 boundary 比例 remap），手柄路径已在用同一机制，拖动不会弄坏字词码。**方案**：紧凑模式背景块 pointerdown 改走 beginCueDrag（与 full 一致），点击选中/右键/双击拦截/字词块交互全部保留。**排 #23 落地后实施**（同波形模块文件） |
| 25 | 右键添加 MASS 后（`// 文本//` 带空格形式），弹「字词时间码未同步：[...] 不是等长替换」警告，但字词块看起来又显示了——维护者困惑实际状态 | 实施中（追加批在途） | 机制（源自 #5 调查）：加 MASS 改变文本长度 → `planWordTimingTextSync` 等长门槛（word-timing.js:260）不过 → 非等长路径公共前后缀区域跨 item → 警告且 items 不动；字词块仍显示是**显示层重分配**（getWordTimingEntries 用旧 items + 新文本模糊匹配），并非真同步。**修复方向**：等长约束升级为「发音序列不变」——仅增删中性/MASS 字符（含空白）时 items 原样保留、静默成功不警告（items 本就不需要变）；与 #5 任务 1 同函数同批实施。真变长编辑的字数估算归 #15 一并考虑 |
| 26 | 右键新增「清理文本样式」：对含特殊文本样式（MASS）的字幕，移除所有 MASS 字符；显示位置在「左右添加字符」子菜单行下方 | 实施中（追加批在途） | **复用 #6 的共享 `stripMassMarkers()`**（同函数服务导出剥离与右键清理，只剥成对、孤儿保留字面）；显示条件=任一目标字幕含成对 MASS 符号（检测用配对扫描），点击对全部目标执行、无符号者跳过；走标准命令/撤销路径（与 applyWrapChars 同管道，Ctrl+Z 可回退）；与 #25 协同——清理后长度变化，配合「发音序列不变静默同步」不弹警告；i18n EN 映射（子代理拟词）。依赖 #5/#6 落地，随追加批派发 |
| 27 | 启动编辑器时控制台反复刷「Editor: 63 ESM factories / 191 sources」与 `[http] thumbnails/demand、startup-status` 请求日志——问是否都必要（尤其 ESM 行） | 已修复 | 主会话调查：ESM 行来自 build-editor.mjs 构建输出，反复出现说明 serve.py 在重复触发重建或每次新鲜度检查都打印；[http] 行是请求日志，thumbnails/demand 与 startup-status 是轮询端点，天然高频。修复方向：ESM 行仅在真正重建时打印一次；轮询端点请求日志降噪（debug 级或跳过）。涉及 scripts/build-editor.mjs + server-editor/serve.py（当前无辖区冲突）。**调查结论**：① ESM 行 = `build-editor.mjs:192` 每次构建打印一行；serve.py 自动重建路径**捕获**子进程输出（web_build.py `_run_build` capture_output），正常启动不打印——当前刷屏是因为 `pnpm run dev` 的 esbuild watch（stdio inherit）在**两个实施子代理高频改源码**，每次变更重建一行，属本轮反馈期的暂时现象，批落地后静止。② [http] 行 = serve.py `log_message`（:3257）每请求一条；`/api/startup-status` 与 `/api/thumbnails/demand` 是轮询端点 → 持续噪音。**修复**：log_message 对这两个轮询路径的 200 响应静默（非 200 仍打印）；ESM 行保留（watch 模式的重建信号）。文件空闲可随时派微批。**已修复（末批，行为探针 11/11 + Python 契约测试 98/98）**：log_message 对 /api/startup-status 与 /api/thumbnails/demand 的 **200 响应静默**（非 200 与其他端点照常打印；_QUIET_HTTP_LOG_PATHS 常量 + rsplit 解析状态码，serve.py:3577-3597）；ESM 行 = dev watch 的重建信号，保留不动 |
| 28 | 画面带模式 select 下方的状态 hint 文字冗余（tooltip 已有同内容），去掉可见行、保留 tooltip | 已修复 | **入账滞后说明**：本条反馈时遗漏入账（仅在会话内处理），末批实施时补齐锚点并落地——元素保留（挂 aria-live + 两处 aria-describedby，删元素损 a11y）但视觉隐藏（sr-only 模式，waveform.css :1392-1396；display:none 会让 aria-live 失效）；JS 零改动（updateThumbnailStatus 继续写 textContent 与父级 title；e2e toHaveText 读 textContent 不要求可见）。实测：select 下方无 hint 行、hover 仍有 tooltip、读屏仍收播报 |
| 29 | 字词气泡微调（#23 验收反馈）：① 候选**不再按文本截断过滤**——显示就都显示（密度仍受同屏上限/3 行/优先级约束）；② 最底层气泡行与字词条带之间加间距（现在紧贴） | 进行中（排 #23 会话追加） | 改 word-blocks.js `drawWordChips`/`computeWordChipLayout`：候选=全部可见字词块、移除截断测量；底行与条带间留间距；上限/优先级/行堆叠逻辑保持；随 #24 同会话追加（#22/#24 落地后派）。**上限评估（维护者问 24 是否保守）**：canvas 同 pass 绘制下 24 个 chip <0.5ms/帧、64 个 ~1-2ms、100+ ~2-5ms——相对整行重绘+DOM 重建的主瓶颈是零头，24 明显保守；**建议 24→64 或去掉数字上限**（「3 行+水平不重叠」自限 ≈3×每行可容数，留 96 保险丝防病态）；布局的 measureText 加 (text,font)→宽 Map 缓存。密度控制交给 3 行规则 |
| 30 | MASS 配对语义问询：成组应「一对单/一对双」；例 `>>** //The *editing* //process**<<` 解析为 ** ⊃ // ⊃ *editing* 三层、最内层优先；问现状分组与复杂度 | 仅说明（现状已符合） | 沙箱实测（assMarkedRanges 原函数，`.artifacts/1016大核验/mass-pairing-probe.mjs`）：例子当前即解析 **[2,30) ⊃ //[5,21) ⊃ *[11,19)；`**a *b* c**` 双对外/单对内；`*a**b*` 单对外/`**` 字面。现行机制=按（符号×宽度）分道扫描+宽度边界守卫（ass-style.js:66-93），事实即「一对单/一对双」；fade 非对称走句级外壳解析器。**不重写分词器**；增值=例子写成回归测试+规则入 ASS_STYLES 文档（随追加批） |
| 31 | 右键菜单微调：「左右添加字符」与「高级操作」放一组，**不加分隔线**（现两行之间有 sep） | 进行中（排追加批） | editor-context-menus.js 顶层两行间去 sep（组前分隔线保留）；随 #26/#15 追加批 |


| 32 | 「字幕列表」左上角「字幕」标签：空间不足时直接隐藏，避免竖排（截图：字/幕被挤成竖排） | 进行中（方案降级：B 拍板） | **维护者拍板方案 B（2026-10-16）：纯 CSS**——`white-space: nowrap + overflow: hidden`（空间不足横向裁剪，不竖排也不做隐藏/恢复），**撤掉 ResizeObserver 实现**。收口批（session B 在途）报告回来后替换。旁证：容器查询路线被否（设置弹层在工具栏子树内，container-type 会劫持 fixed 定位）；本条为「小需求先问值不值」SOP 规则的触发案例（ResizeObserver+迟滞 vs 一行 nowrap） |
| 33 | 纯文本编辑「整体编辑」加左侧行号（gutter）——维护者问好加吗 | 进行中（排 #23 会话追加） | **好加，基建现成**：整体编辑已有搜索镜像层（`#timed-text-edit-search-mirror` + 滚动同步 :1128-1130 + 逐行偏移计算），行号层=镜像基建的变体：绝对定位数字列 + scrollTop 同步，行号按**字幕行**编号（与逐条编辑「第 N 条」一致；软换行下对齐到每条首行，偏移计算复用搜索镜像的既有逻辑）。要点：textarea 左侧让位（或 gutter 落在现有内边距区）、字体度量严格一致、与搜索高亮共存。同文件 editor-timed-text-edit.js（现无辖区冲突）+ editor.css，随 #29/#32 同批派发 |
| 34 | Greptile 对 PR #251 的 6 条评审（P1×3/P2×3），逐条验证后修复：P1-1 editor.css:3576 行搜索镜像遮挡文本？P1-2 foldMassPairJunction 双符号折叠残留 `**甲**乙**`？P1-3 completeConvertedOutputMassPairs 波及未选中字幕？P2-1 relayoutBasicOverlays 漏 extension 块与边界手柄？P2-2 连续平移期间画面带永不取新图？P2-3 整体编辑打开时滚动错挂隐藏元素？ | 进行中（两路验证+修复派发） | 分工：session A（ses_ebcc11217）= P1-2/P1-3/P2-3/P1-1（text-processing、word-timing、timed-text-edit 区）；session B（ses_ebc8ab1d）= P2-1/P2-2（waveform render/thumbnails）。纪律：**先验证再修**——Greptile 可能误读（P1-1 疑似误读：#10 设计为仅命中行挂镜像），验证不成立的在报告与账本注明「不成立+依据」；成立的修复+回归测试。**thread ID 映射（处理完须 resolve，GraphQL resolveReviewThread）**：P1-1=PRRT_kwDOTkFWNc6tImgJ、P1-2=ImgQ、P1-3=ImgY、P2-1=Imgc、P2-2=Imgk、P2-3=Imgt（均为 unresolved）。**B 组完成（session B，已回帖+resolve ✓✓）**：P2-1 成立——relayoutBasicOverlays 漏副字幕块与共享边界区，已修（extension 块原位重排 + appendExtensionHandle 提取 + refreshBoundaryZones 接入，探针 0.83px→0、renderBasicCalls=0）；P2-2 成立且**两层饥饿**——panBasicByMs 从不调 setView + applySetView 的 200ms 去抖与 150ms 节流叠用，已修（平移每档经节流 setView + 去抖删除，探针 8 档 demand POST 4 次持续推进）；e2e 53/53。**A 组完成（session A，已回帖+resolve ✓✓✓✓）**：4 条全部成立——P1-2 折叠残留属实但归因修正（非宽度问题，是 batch-1「保留前段闭」语义在双符号/往返下的孤儿缺陷），改为**整体折叠**（junction 两侧符号一并移除、复验重 union 成一个对；`**甲**`+`**乙**`→`**甲乙**`；`今天*的*`+`*解说*`→`今天*的解说*`，经宽度守卫验证 batch-1 示例目标 `今天*的*解说*` 实际会把解说渲染成字面+孤儿——**新语义更正确，行为变更待维护者复核**）；P1-3 属实（补齐扫描全量输出数组），已加 outputSources 同源守卫锁到转换源行；P2-3 属实（single 视图滚错容器），改 caret 预置+focus 滚动；P1-1 成立且根因更准（镜像每行无条件挂载+不透明底），改默认 visibility:hidden 仅命中行 visible。测试 380/0；items 层修复随本批交付（split-core styledClosures 链路） |
| 35 | Greptile 第二轮 4 条（11:47，均在追加批新代码上，GitHub 侧已被标 resolved 但问题待修）：G-1 foldMassPairJunction 的 items 裁剪在边界 item 恰为纯文本时整项被删（丢失字词时间码）；G-2 编辑器从未向 buildTimedTextStructurePlan 传 options.rule——结构拆分补齐实际是死代码（C-2 出口失效）；G-3 completeConvertedOutputMassPairs 只查相邻两行，跨 3+ 行的样式（`__one two three__` 拆三段）永远补不上；G-4 「字幕」标签隐藏后重现条件数学上不可能成立（scrollWidth ≥ clientWidth 恒真）——隐藏后永不恢复 | 进行中（两路派发） | 分工：session A = G-1/G-2/G-3（其 MASS 代码，验证→修复→测试）；session B = G-4（#32 的重现逻辑）+ **#20 追加**（维护者拍板「要」：工具栏 select 与滚轮行高两个非 Q 入口挂钩视口锚定）。修完回帖附 commit，thread 已 resolved 则保持 |

## 阶段汇总
- 建账（2026-10-16）：账本建立，等待第一批反馈。
- 续 1（2026-10-16）：① #1 已修复——缩略图逐格 200ms 淡入（`thumbnails.js` 绘制层 + d.ts 类型），
  bundle 重建、check:editor、语法/顺序 node 测试、tsc typecheck 全部通过，观感待维护者实测；
  期间踩坑：ESM 工厂模块体必须只有单个函数声明（build-editor.mjs 校验），模块级常量要放进工厂内。
  ② SOP 更新：skill `feedback-issue-triage` 写入「小规模实施派子代理、主会话不亲自实施、
  Issue 标已完成」规则。③ #2/#3 已派实现子代理（后台，合并一个子代理顺序做，避免 bundle 竞态），
  完成后主会话抽查。④ 事故：#3 入账时误覆盖 #2 行，当场恢复，无信息丢失。
  ⑤ 待维护者拍板：#2 的推广规则（end 未变 / 两端都变的布局）。
- 续 2（2026-10-16）：① #2 推广规则维护者全部拍板；确认删除线 = CSS line-through 非字符。
  ② SOP 增补：调查后发现功能有误/需求不合理要及时向维护者反馈，不当真理（入 skill）。
  ③ 新术语 MASS（Markdown-ASS）拍板；#4 文档子代理已派（ses_ebce39c1cffeHpQlQcJ4Ksl6HQ）。
  ④ #5 派只读 explore 子代理调查同步管线与两方案影响面（ses_ebce4ab95ffeG1hsvWt25YoUiC）；
  #6 待其产出后实施。⑤ #7 根因候选已锁定（hidden 判定漏 deleted / rowReport 路径错位），
  精确核实在途文件被重构、随追加批次做。⑥ #8（查看修改内容默认展开+覆盖确认）、#9（trim checkbox）、
  #10（逐条行命中高亮，mirror 方案）排队，#2/#3 子代理完成后同批追加。⑦ 事故：#10 入账时
  插错行序，当场更正。⑧ #11（修改影响 0 条行隐藏）入账排队——追加批次现为
  #7、#8②、#9、#10、#11，统一由 #2/#3 子代理会话继续做。
- 续 3（2026-10-16）：① #4 已修复入账（ASS_STYLES.md:62 / EDITOR_GUIDE.md:59 术语插入，抽查一致）。
  ② #12 入账：主会话拍板圆点方案（脏状态源 `hasUnsavedProjectChanges` 现成）；#13 入账（打开滚动到选中）。
  ③ #2/#3 实施子代理完成，主会话抽查通过入账（helper 三情形、CSS、i18n、模板裸 search 全部吻合，
  旧类/死映射 rg 无残留）；「查看修改内容」两处共用 helper → #8① 覆盖。
  ④ 追加批次扩为 #7、#8②、#9、#10、#11、#12、#13，已派回同一子代理会话（ses_ebcecdeb2ffe326JifY0isEUZK，后台）。
- 续 4（2026-10-16）：① #5 explore 报告抽查 6 处吻合入账（根因=中性字符挂靠前一发音 item；
  cue.text 是唯一真源；拼接契约 JSON_SCHEMA.md:683；等长判定不受符号移动影响；beta1 #12 未实施）。
  ② **维护者拍板方案 2**；#5+#6 合并派实施子代理（ses_ebcc11217ffeLcHQKC91jw5y6U，后台）：
  同 item 归位（移动守恒）/拆分补齐（闭环 beta1 #12）/合并折叠（防 `**` 误解析）/stripMassMarkers 导出剥离。
  ③ 并行约束：#5/#6 子代理禁改 #7-#13 批次辖区文件、禁跑 bundle 重建，bundle 由主会话在两批次
  完成后统一重建验证。
- 续 5（2026-10-16）：① #7-#13 追加批次完成（8 文件），统一验证 bundle/--check/tsc/语法顺序
  测试/git diff --check 全过；主会话抽查 4 处（#7 队列修复、#9 trim、#11 声明式条目表、#12 圆点）
  均验证存在，报告行号有漂移（基于编辑中途快照），账本行号已按当前文件校正。
  ② #14 根因确认（B 无 overlay 分支、overlay 拆分管线现成）+ 修复子代理已派（只改
  edit-shortcuts，ses_ebcb7ab4）；#15 定性（split-core :1571 守卫族，无码按字数估切点方向），
  需改 split-core 排队等 #5/#6 完成。
  ③ 待维护者确认：#9 trim 作用于全部行（非仅编辑行）、#13 多选取最小序号、#12 圆点琥珀色
  （可换变量）与轮询 ≤1s 出现延迟。
- 续 6（2026-10-16）：① #14 修复完成抽查入账（edit-shortcuts +34 行 overlay 分支，
  openOverlaySplitModal :799；遗留取舍：指针在重叠主字幕上时 B 仍拆所选 overlay）。
  ② #16 扩容（批量面板两行 [整句]、applyWrapChars 句级恒最外层规则、改名弱化文本）并派实施
  （ses_ebcadb188ffec1I2m9sZ64g1Ym）；#17（去省略号）并入同批。③ #18 调查：单次运行内顺序
  已正确（applyTextProcessing :361-381），真冲突是跨次运行、同字符集不可排序区分——
  **待维护者拍板 A（MASS 感知剥除）/ B（现状+工作流 hint）**，倾向 A。④ #19 入账（嵌套句级
  补齐缺失 / 是否定死 >><< 外层顺序——主会话判断不定死 / 修剪穿透格式字符），排 #5/#6 会话追加。
  ⑤ #20 入账并派实施（几何自动变更后 revealTime 回播放头，ses 见后台列表）。
- 续 7（2026-10-16）：① #18 维护者拍板**方案 B**（维持现状 + hint 文案工作流约定），排 #16 会话追加。
  ② #21 入账：`__really fun__` 字词拆字幕不补齐 MASS；维护者提议**共享补齐 helper 用于一切拆分路径**
  （B 拆分/字词拆字幕/纯文本编辑结构拆分）——与方案 2 架构一致，采纳；与 #19 一起排 #5/#6 会话
  完成后追加，按其实现收敛为单一工具并接线所有出口。
- 续 8（2026-10-16，整体对账）：① 全表 23 行核对完毕：行序修整为 1-23 递增（脚本按编号去重+排序，
  LF/无 BOM 保持）；**清除重复的旧 #18 行**（进行中状态的陈旧副本，新行保留）；9 个状态格对齐结论
  （#7/8/9/10/11/12/13/14/20 结论已是已修复但状态格滞留进行中/待处理）。② bundle 校验=stale
  （多批次源码编辑晚于上次重建，预期内），统一重建等 #5/#6 + #23 落地后执行。③ 工作树 41 文件
  +1159/-179，新增 tests/test_mass_markers.mjs（#5/#6 的测试）；5 个文件改动待 #5/#6 报告核对
  归属：editor-wiring-initial-config.js、styles/editor-speaker-labels.js、styles/editor-wiring-ass-manager.js、
  editor-dynamic-exports.js、export-plan.js。④ 在途：#5/#6、#23；排队：#22 批次 1+2（等 #23）、
  #18-B hint+每行长度 reveal（微批，可随时派）、#19+#21+#15（#5/#6 会话追加）。
  ⑤ 已修复 15 项全部待维护者实测；三项小确认仍开放（#9 trim 全行 / #13 多选最小序号 / #12 圆点色）。
  ⑥ 事故：对账脚本第一版漏写去重跳重（24 行含重复 #18），核验行序时发现并二次修正——最终账本为准。
- 续 9（2026-10-16，收口）：① #5/#6 实施完成抽查入账（四任务：归位/拆分补齐/合并折叠/stripMassMarkers，
  新建 test_mass_markers，Python 全量 2347 过）；#23 实施完成抽查入账（waveform.css basic 几何 +
  canvas 气泡层，e2e word-timing 40/40）。② 追加两批派发：#19/#21/#25/#26/#15 → #5/#6 会话；
  #22 批次 1+2 + #24 → #23 会话。③ 微批次（#18-B hint + #20 遗留 reveal）完成抽查入账。
  ④ #17 的「批量操作…」确认为 CSS 截断误判，条目收敛为过滤字幕省略号。⑤ **收口 Issue 创建：
  https://github.com/Moyf/moys-asr-workflow/issues/250**（26 项：19 已完成 / 7 实施中；标题
  「1016 大核验反馈跟踪」**不含项数**——数量只写正文快照，维护者指示避免每次变更改名；正文
  `.artifacts/1016大核验/issue-body.md`，活文档随实施回写）。⑥ 待维护者：15+ 项实测、
  三项小确认（#9 trim 全行 / #13 多选序 / #12 圆点色）；全部批次落地后统一重建 bundle + 全量验证。
- 续 10（2026-10-16，阶段性提交 + 合并 + PR）：① 三项小确认已拍板（trim 全行 / 最小序号 /
  琥珀圆点+轮询——轮询实测为 O(字幕数) 布尔检查，开销微秒级）。② 检查点提交 `768f2852`
  （55 文件 +2519/-305；注意：当时工作区已被切到分支 `feat/record-test-feedback-issue`，
  与 melodic-cat 同 HEAD 无独有提交，分支名与本批工作吻合故就地提交）。③ 合并 origin/main
  （PR #243，42 提交）→ 7 文件 9 处冲突全解，合并提交 `1c6459e6`。**体系拍板**：拆分出口
  = main 的 splitStyledTextParts（刀点吸附，实测不落文本闭符号）+ 本分支 completeSplitMassPairs
  分层补齐与 items 同步（session A 的「main 已覆盖」推演被实测推翻，两者互补非重复）。
  已知红：test_mass_markers 2 例集成断言（items 层同步与 main placed 链路交互，追加批修复）。
  ④ **PR 创建：https://github.com/Moyf/moys-asr-workflow/pull/251**（base main，
  阶段性落地 19 项，实施中 7 项随后并入；呼应 Issue #250）。⑤ 追加两批派发：
  #19/#21/#25/#26/#15 + items 调试 → session A（ses_ebcc11217）；#22 批次 1+2 + #24 →
  session B（ses_ebc8ab1d，已完成）。⑥ #23 微调与 #30/#31/#32/#33 排队（气泡全显示+间距、
  菜单分组、字幕标签隐藏、整体编辑行号）。
- 续 14（2026-10-16，收口完成）：① 末批（#20 锚定修正/#27 日志降噪/#28 hint 隐藏）落地，
  全量 test:unit **802/802**。② markProjectDirty 事件化重构落地（事件层 + changes 访问器
  收口 + 18 处接入 + O(1) 轮询自愈，22/22 专项测试；接入点清单见 session 报告）。
  ③ Greptile 二轮 G-1/G-2/G-3 修复落地（G-1 取会话实现、G-3 取 main 体系的
  completeMassTextRows——两套实现的取舍见 merge 提交）。④ main 再同步（#241 等 4 提交，
  零冲突）。⑤ **后续 PR 创建：https://github.com/Moyf/moys-asr-workflow/pull/254**
  （base main，含本账本全部条目实施；CHANGELOG 与核对清单 v2 已随批落地）。⑥ 账本
  阶段汇总经脚本去重排序（1-13 顺序，LF 保持）。⑦ 事故两起：#28 漏入账（末批补齐）、
  阶段汇总重复/乱序（脚本收口）。
- 续 11（2026-10-16，Greptile 收线 + 检查点提交）：① **Greptile 6 条全部处置完毕并 resolve**
  （每条回帖附修复证据）：B 组 2 条（P2-1 漂移/P2-2 取图饥饿）+ A 组 4 条（P1-1 镜像遮挡/
  P1-2 折叠残留/P1-3 转换波及/P2-3 滚动错挂）**全部成立全部修复**。② ⚠️ **折叠语义行为变更
  待维护者复核**：合并折叠从「保留前段闭」改为「整体折叠」——`今天*的**解说*` 类合并的产物
  从 `今天*的*解说*`（宽度守卫下解说说会变字面+孤儿，batch-1 示例的隐性缺陷）变为
  `今天*的解说*`（单一完整对，两侧均保留样式）。③ session A 交付 items 层修复（styledClosures
  链路）、#26 清理菜单、#15 估切、静默同步；测试 380/0。④ 检查点提交 + 推送（PR #251 随之
  更新，CI 的 setInterval 崩溃已另行 hotfix 054ff4c9）。
- 续 12（2026-10-16，收口）：① CHANGELOG `[未发布]` 三处追加（提升 5 条/修复 1 条/变更 2 条，
  与 main 已有条目去重）。② **人工核对清单（v2）落地**：`1016大核验.checklist.md`（29 个核对项
  分 A 波形/MASS/纯文本编辑/杂项四区；`build.py --check` 通过、HTML 已生成不入库；
  merge-fold 条目按 v2 契约去字面 `**` 改文字描述）。③ 全量验证：`node --test tests/*.mjs`
  **790/790**（launcher bundle 一并重建后）；两个 bundle 均已重建。④ **CI 收口**：PR #251 的
  9 例红全部修复推送（7 例 setInterval/document 裸全局→浏览器守卫 hotfix 054ff4c9；
  5 例 split-style 断言→session A a9f383c6；1 例 lease/debounce→session B 8fa6d14f；
  Preview Python 单例 RUNNER~1 短路径→3a16d13b resolve() 规范化，并 PR 留言提一嘴）。
  ⑤ Issue #250 与 PR #251 正文均已回写终态（26 项全 ✅ + 追加批 + 待复核项）。
- 续 13（2026-10-16，性能自审——维护者要求按第一性原理审「不重要但额外开销」）：
  **本批新增逐项核成本**：① 气泡/字词块重绘只发生在 render 事件（滚动/编辑/精绘），
  播放帧零开销（已核实 renderBasic 仅在跟随回中时触发，playback.js:50-60）；字词拖动期
  每帧 ~1-2ms（64 chip 上限 + measure 缓存）可接受。② 行搜索镜像：每行常驻一个隐藏
  div（DOM 翻倍），空镜像 visibility:hidden 无绘制成本——可接受。③ 未保存圆点轮询：
  维护者已确认（微秒级）。④ 平移期 demand 4-7 次/秒（P2-2 修复引入）：仅平移进行时、
  有去重与合并——取新范围是需求本意，可接受。⑤ 行号 gutter：input 时 O(行数) 扫描 +
  scroll 时一次 style 写——无浪费。**既有代码一处残余浪费，按新原则报告不修**：
  marks 模式每次重绘 O(K) 全量扫描关键帧（editor-thumbnails.js keyframesInRange）——
  可选模式、典型 K 数百 ≈ 0.1ms，收益低于改动风险。**原则固化**：热路径（render/scroll/
  playback/pan）上的新功能默认报「每帧/每事件成本预估」，先分清层级再动手。

## 合并前复核补记（2026-10-16）

本节更新此前「CI 收口」的结论：受检远端头 `fbc96fc6` 的 Windows 预览运行
`38895045753` 失败，2484 项测试有 5 个错误，打包与上传均跳过；文档更新不能视为构建恢复。

- **烧录兼容已修复**：本机同样复现 5 个烧录精度错误，FFmpeg 拒绝旧的
  `-filter_complex_script` 参数；改用 `-/filter_complex` 读取文件（仍规避命令长度限制），
  仅当旧版明确拒绝新参数时回退旧语法。真实裁剪、音轨偏移、字幕收缩时钟与无音轨用例通过，
  不跳过或削弱精度断言。FFmpeg 官方迁移说明：
  <https://ffmpeg.org/pipermail/ffmpeg-cvslog/2024-January/140522.html>。
- **第二轮评审的 4 条问题均成立，已修复待远端复验**：合并只在 items 实际含有待移除符号时裁剪，
  spoken-only items 的文字、时间与说话人保持；纯文本编辑的预览与应用都传入当前符号规则；
  同源拆分以完整剩余文本补齐跨三个以上字词的样式，不跨未选中字幕；字幕标签每次测量真实布局，
  拉宽后恢复。新增定向测试先复现 3 条 MASS 问题，再验证修复；标签与编辑器接线有浏览器回归。
- **本次本地验证**：Python 2485 项、31 跳过、0 错误；烧录专项 18/18；类型检查、Ruff、
  bundle freshness 与 diff 检查通过。完整 Node 为 791/793，两个环境问题分别为随机禁用端口、
  未指定 E2E 解释器触发 uv 重建；固定解释器后的相关 4 项定向复验全部通过，不把该复验写成一次全量全绿。
  浏览器三个文件 58/58，另用长合成音频验证 Q 在播放头屏外时保留正在看的时间范围 1/1。
- **验收边界**：上面是自动化证据；人工清单仍为 pending，整体折叠语义仍待维护者复核。
  工具栏 select / 滚轮行高两个入口及深层嵌套边缘未在本轮扩展范围。
  最新提交的 Windows 预览包与 CI 必须重新成功后再判断能否合并。
  内联副本待发布前统一重生成。
