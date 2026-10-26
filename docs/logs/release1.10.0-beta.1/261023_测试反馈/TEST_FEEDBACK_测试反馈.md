# 测试反馈账本(261023)

- 分支: `main` @ `ed52f7a7`(建账时工作区干净)
- 流程约定: 每条反馈先入账(状态 `待处理`)再调查;调查结论随时回填。
- 状态取值: `待处理` / `进行中` / `已修复` / `仅说明` / `阻塞`

## 问题清单

| # | 问题 | 状态 | 核实结论/方案 |
| --- | --- | --- | --- |
| 1 | Launcher「处理文件」区: 报错红字(如「这里只接受 .mosp / json / .srt 字幕或工程文件。」)在清空文件或拖入新文件后不会清理掉,一直残留 | 已修复 | `syncPaths()` 自动跟随赋值改为「值变化才赋值并同步清错误」;已抽查 diff 与复跑测试 |
| 2 | 编辑器: 字幕量特别大时,切换字词时间码会直接什么都不显示,持续几秒钟才显示出来 | 已修复 | c1+c2 落地(回声抑制快照 + 锚点瞬时还原);主会话抽查 diff 与复跑测试通过 |
| 3 | 编辑器: 字词量巨大时,「纯文本编辑」的「逐句修改」里每改一个字就卡顿 | 已修复 | A+B+C 落地(报告逐行复用/children 索引/canUseSingleView 缓存);抽查 diff 与复跑测试通过,基准 130ms→10ms |
| 4 | 编辑器: 显示字词码时,字幕中间缝隙没法直接拖动(调整相邻字幕边界),需要加回来 | 已修复 | 恢复创建 + compact 布局贴缝词块手柄加宽让位;抽查 diff 与复跑测试通过 |
| 5 | 编辑器: 有时播放到空隙后,播放头停在那里不动了(间歇性);表现是播放头停在空隙结尾,按两次空格才能继续 | 已修复 | seek 不打断 + 同 gap 单次守卫(rAF 与事件双路径);抽查 diff 与复跑测试通过 |
| 6 | 编辑器: 在少于 100ms 的字幕上按 B,会自动激活「字幕列表」的编辑框;期望指向「字幕编辑区」(波形区操作的指向) | 已修复 | 波形 B 改显式切点直调拆分核心(不再激活行内编辑),armed 外置;抽查 diff 与复跑测试通过 |
| 7 | 编辑器: 跳过空隙前后的时机与波形有偏差——波形已完全覆盖(移除)gap,播放仍能听到一点 gap 开头的音频才跳过 | 进行中 | 与条目 5 同链路;条目 5 已修,待实测改善程度再定预判提前量 |
| 8 | 编辑器: 撤销颜色分配时,画面预览不会及时更新;补充: 撤销操作整体都不会更新预览画面(含 SRT overlay 预览) | 已修复 | undo 恢复后补 overlay 刷新 + ASS 帧数据变化通知(invalidate 挂载 + 防抖/key 比对);抽查 diff 与复跑测试通过 |

## 核实结论

### 条目 1: 处理文件红字不随内容更新清理

红字元素为 `#toolboxInputPathError`(field-error),设置点两处:

- 拖入非法文件: `web/launcher/server/launcher-media-server.js:42`(主 bundle `setError`)
- 运行时校验失败: `web/launcher/postprocess.js:1498`(`setFieldError` + `setResult`)

会清红字的路径(已核实,均存在):

- 手动编辑输入框文本: `postprocess.js:3082`(input 事件)
- 拖入合法文件(dropTarget 正常): `setDroppedPath` → `launcher-media-form.js:109` + dispatch input
- 「选择」按钮: `postprocess.js:3017`

**不清红字的路径(根因候选)**:

1. **程序性自动跟随不清错误**: `postprocess.js:719-720` `syncPaths()` 中 `if (!inputManual) $("toolboxInputPath").value = autoSourcePath()` 直接赋值,不 dispatch input、不清错误。触发源多: 主页媒体变化(`launcher-media-form.js:102` → `onMediaPathChanged` → `postprocess.js:3316`)、`postprocess.js` 内 858/1699/2694/2806/2859/2903/3090/3249/3316 等多处调用。
2. **dropTarget 丢失时合法文件走默认路由**: `launcher-media-server.js:102-115`,`.mosp/.json` 落到主页 `setJsonPath`(错误没人清);随后工具箱输入框经 `syncPaths()` 自动跟随显示新文件——用户视角即「拖入了新文件、输入框也更新了,但红字还在」。
3. **程序性清空**: 主页工程/媒体路径变化引发 `syncPaths()` 把输入框清空/回填,同样不清错误。

**待实机确认**: 用户所述「清空」若指手动删除输入框文本,按代码应触发 input 事件清错误;若指主页路径变化引发的跟随清空,则与根因 3 吻合。不影响修复方向。

**修复方向**(待维护者确认后实施): 输入框值发生任何变化(用户输入、拖入、程序性跟随/清空)时统一清掉 `#toolboxInputPathError`。最小侵入: `syncPaths()` 对 toolboxInputPath 赋值前后比较,值变化即清错误;更系统的做法是抽统一的 `setToolboxInputValue()` 入口。

## 阶段汇总

- 续 1: 收到条目 1,已入账,待调查。
- 续 2: 条目 1 调查闭环。三条不清红字的代码路径已定位(见核实结论),修复方向明确,待维护者确认后实施。
- 续 3: 条目 1 实施完成(维护者指示「先修复」)。实现子代理修改 `web/launcher/postprocess.js` `syncPaths()`: 自动跟随赋值前先比较,值变化才赋值并 `setFieldError("toolboxInputPath", "")`(不 dispatch input,避免副作用链)。主会话抽查: `git diff` 仅此一个 hunk、仅此一个文件;复跑 `node --test tests/test_launcher_feedback_ui.mjs tests/test_resegment_stream_ui.mjs` 全绿。子代理另跑 `pnpm run check:launcher`(bundle fresh)与 `uv run --no-sync python scripts/run_tests.py tests/test_gui_web.py`(335 OK)。其余程序性赋值点(line 1555/3015)已自带清理,无需改。
  - 未验证边界: 「红字随自动跟随清除」的真实浏览器交互路径无自动化覆盖,待维护者实测;拖放 dropTarget 丢失场景(根因 2)由同一清理点覆盖,同样待实测确认。
- 续 4: 收到条目 2(切换字词时间码大字幕量下白屏数秒),已入账,开始调查。
- 续 5: 条目 2 调查闭环(explore 报告经主会话抽查吻合)。根因: 切换同时改写波形行几何预设(每行 5s/行高 168),同一同步任务内对所有可视行做整组重建(逐词 DOM + 逐行 canvas 重绘 + 每行强制布局),再被 ResizeObserver 回声触发第二次完整 render、被锚点恢复的 smooth scroll 连续触发增量重建——「同步全量重建 ×2~N 次放大」。不是数万词全量扫描(波形侧本就有行级虚拟化)。报告原文见同目录 investigation 文件。修复方案(见 investigation 第 6 节)待维护者拍板: 推荐 c1+c2(消回声 render + smooth 改瞬时,小改动),观察效果再决定是否 a/b。
- 续 6: 维护者拍板条目 2 做 c1+c2,实施派子代理;同轮收到条目 3(纯文本编辑「逐句修改」逐字输入卡顿),已入账。
- 续 7: 条目 3 调查闭环(主会话直接查)。用户所指「逐句修改」= 纯文本编辑面板「逐条编辑」视图。每键链路: input 委托(`editor-wiring-text-tools.js:386-398`)更新草稿 → 160ms debounce(`editor-dom.js:486`)→ `updateTimedTextEditReport()` 全量重算。重算大头: ① `buildTimedTextEditReportFixed`(`shared/utils/timed-text-edit.js:205-273`)对**每一行**无条件跑 diff + `reconcileTimedTextItems` 逐词重对齐 + coverage/reuse,未修改的行也不短路,总成本 O(总词数); ② `updateTimedTextEditReport` 两轮逐行 `querySelector([data-index])`(`editor-timed-text-edit.js:868、877`)= O(N²) DOM 查询; ③ 每键同步路径 `renderTimedTextEditView()` 里 `timedTextEditCanUseSingleView()` 对全部 sourceSegments 做全量扫描(`editor-timed-text-edit.js:391-394`,结果会话内恒定可缓存)+ `texts.join('\n')` 全量拼接。
  - 修复方向(无行为变化): A. 报告构建按行缓存/短路,只重算被编辑的行; B. 逐行循环改 `children[index]` 直接索引; C. canUseSingleView 缓存到 draft。待维护者拍板后实施(须等条目 2 实施完成,避免 bundle 重建竞态)。
- 续 8: 维护者拍板条目 3 做 A+B+C。因条目 2 实施子代理仍在后台(两者都要重建 editor bundle),条目 3 待条目 2 完成核对后派发。
- 续 9: 收到条目 4(字词码模式下字幕缝隙拖动失效,需恢复),已入账,开始调查。
- 续 10: 条目 4 调查闭环(主会话直接查)。字幕中间缝隙的直接拖动 = 共享边界拖动区(`.waveform-cue-boundary`,title「拖动调整贴合边界(两侧一起移动)」,相邻字幕贴合时出现在接缝处,中间 8px 命中)。`cue-blocks.js:383` 在字词时间码模式下**显式跳过创建**(main 轨;extension 轨 line 524 无此条件),该条件来自 #177(b931b181,2026-10-09 字词时间码功能引入时)。gap 空隙块无此条件,不受影响。
  - 冲突点: 贴合 seam 处同时存在左句末词/右句首词的字词手柄,zone 恢复后须保证 zone 居中 8px 命中优先(高于词块手柄 z 层),词块手柄保留两侧命中;需核对 `.waveform-cue-boundary` 与词块/手柄的 z-index 及 `has-shared-boundary-left/right` 在字词模式下的副作用(word-timing-full 与 compact 两种布局都要验证)。
  - 修复方向: 去掉 line 383 字词条件恢复创建 + CSS 层级核对调整。实施排在条目 2、3 之后(同模块,避免 bundle 重建竞态)。
- 续 11: 条目 2 实施完成并核对通过。实现子代理落地: ① render.js 新增 `_snapshotRenderedPaneSize()` 在全部三个 render 完成出口记录 pane 盒尺寸,`_onResize`(`waveform.js`)实时尺寸与快照一致(变化完全可由刚完成的 render 解释)时跳过冗余 scheduleRender——非时间窗方案,同帧到达的真实 resize 不会被误吞; ② `revealTime` 增加 `options.behavior`(默认 'smooth' 不变),`restoreWaveformViewportAfterGeometryChange` 传 'auto' 瞬时定位,消除 smooth 动画期间逐帧增量重建,其余 11 处 revealTime 调用方行为不变。主会话抽查全部 diff 吻合、复跑 `node --test tests/test_waveform_display_presets.mjs tests/test_waveform_js.mjs` 81/81 绿;子代理另过 typecheck、check:editor、相关 Node/Python 套件(104+50)全绿,断言零修改。边界: 浏览器 e2e 未跑,待维护者实测或 CI。
- 续 12: 条目 3 实施子代理已派发(后台,A+B+C)。
- 续 13: 收到条目 5(播放到空隙后播放头有时停住不动),已入账,开始调查。
- 续 14: 条目 5 调查闭环(主会话直接查)。补充现象: 播放头停在空隙结尾,按两次空格(暂停→播放)才能继续。机制: 「跳过空隙播放」开启时,播放 rAF 循环(`editor-media-playback.js:182-197` 每帧调 `updatePlaybackFrame`)每帧检查 `getGapPlaybackSkip`(`gap-remove-core.js:1373-1381`,判定 `time >= gap.start && time < gap.end` 左闭右开),命中即 `player.currentTime = gap.end/1000` 并 return(`editor-playback-loop.js:126-129`)。**该 seek 是 level-triggered**: HTMLMediaElement 的 seek 是异步的,seek pending 期间/落点经视频帧量化回落(gap.end 来自静音检测,与视频帧不对齐)时,下一帧 tMs 仍在 gap 内 → 再次赋值 currentTime → **重启并打断上一次 seek**,僵持成「播放头钉在 gap.end、播放停滞」。按空格暂停使 isPlaying=false 跳出循环(getGapPlaybackSkip 1378 行守卫),再播放即恢复——与现象完全吻合。「有的时候」= seek 快速落定时不复现,seek 慢或落点回落时触发。
  - 修复方向: seek 改为不打断进行中 seek——skippedGap 分支赋值前若 `player.seeking === true` 则直接 return;并记录「已为同一 gap seek 过」守卫(lastGapSkip,离开该 gap/用户手动 seek/预览时清除),同一 gap 只 seek 一次。无行为变化(跳过语义不变,只去重复打断)。待维护者拍板;实施排在条目 3、4 之后(播放模块与条目 4 同区,仍需串行 bundle 重建)。
- 续 15: 维护者拍板条目 5 修复,并要求全部修复完毕后发布 PR。新增条目 6: 少于 100ms 的字幕上按 B 自动激活「字幕列表」编辑框,期望指向「字幕编辑区」(波形区操作统一指向字幕编辑区)。已入账,开始调查;PR 要求记入收口清单。
- 续 16: 收到条目 7(跳过空隙时机与波形偏差,能听到一点 gap 开头)与 PR 分合授权(由 agent 判断);已入账。
- 续 17: 条目 3 实施完成并核对通过。实现子代理落地 A(report 逐行复用,边界行强制重算)+ B(children[index] 替代逐行 querySelector)+ C(canUseSingleView 缓存);主会话抽查两文件 diff 吻合、复跑 test_timed_text_report/test_editor_utils 全绿;子代理另过 386+50 单测、typecheck、bundle、两组 e2e(41 例),基准 3000 行报告重算 130ms→10ms。
- 续 18: 条目 4 实施子代理已派发(后台)。
- 续 19: 条目 6 调查闭环。机制: 波形按 B → `splitFromContextMenu`(`editor-split-context.js:44-68`)先算出切点文字偏移,再 `MaweInlineEdit.startEdit(el, idx)`(**el 是字幕列表的 .cue 行,列表行内编辑是拆分流程的载具**,`splitAtCursor` 从编辑 DOM 读光标与全文,`editor-split-core.js:2033-2048`)→ 定位光标 → 立即拆分。正常字幕一次拆完无感;<100ms 字幕必产生 <100ms 一侧 → `armForcedSplit`(`editor-split-core.js:378-388`)首次拒绝并置 `forceSplitArmed`(提示再次按 B 强制拆分),**编辑态必须存活到第二次 B**,故列表编辑框停留可见。修复约束: 「字幕编辑区」cuePanelText 是 `<textarea>`(`editor-template.html:2132`),textarea 中 B 是普通字符输入,无法承载「再次按 B 强制拆分」。建议方案: 波形来源拆分不再激活任何行内编辑——用已算出的显式切点直接调拆分核心(造无编辑态入口),100ms 拒绝只提示 + 模块级 armed(波形路径专用),第二次 B 强制拆分;列表来源保持现状。
- 续 20: 条目 7 分析闭环(与条目 5 同链路)。「听到一点 gap 开头」两个成分: ① rAF 检测粒度(约 16ms/帧)+ seek 异步生效延迟(几十 ms),播放位置越过多半帧才检测、seek 生效前音频继续播 gap 开头——固有物理延迟; ② 条目 5 的「每帧重复 seek 重启」把生效延迟进一步拉长,加重可闻残留。修复: 条目 5 修复(不打断进行中 seek)直接削减成分 ②;成分 ① 可选「预判提前」(tMs 距 gap.start 不足提前量且播放中时提前 seek,会截掉 gap 前等量音频,取舍需拍板)。先落条目 5 实测条目 7 改善程度再决定是否加预判。
- 续 21: 条目 4 实施完成并核对通过。实现子代理: ① 去掉 `cue-blocks.js:383` 字词条件,恢复中缝拖动区创建; ② compact 叠加布局下贴缝词块手柄经 `getWordTimingEntries` 校验真正贴合后加 `has-shared-boundary-*` 并在 waveform.css 加宽到 `min(11px, 25%)`(与句块手柄同款),保留「手柄—中缝—手柄」各约 7px 命中; ③ full 分层中缝区与词条带不同层零重叠,无需适配; ④ 拖动链路无字词拦截(原禁用仅在创建处)。主会话抽查 diff 吻合、复跑 test_waveform_js 66/66 绿;子代理另过 72 node 单测、typecheck、bundle、50 Python 契约。待维护者实测: full/compact/双语三种布局下中缝拖动与词块手柄命中。
- 续 22: 条目 5 实施子代理已派发(后台,seek 不打断 + 同 gap 单次守卫)。
- 续 23: 条目 5 实施完成并核对通过。实现子代理在 `editor-playback-loop.js` 新增模块私有 `gapSkipGuard` 与 `applyGapPlaybackSkip`: seeking 时不重复赋值、同一 gap 只发起一次;位置离开/暂停/进入预览时清除(seek 进行中不清,防量化回落 ping-pong),切 gap 覆盖,手动 seek 回 gap 内可重触发。**超出字面但必要的发现**: `update`(timeupdate/seeked/pause 事件路径)与 `updatePlaybackFrame`(rAF)原有完全相同的重复赋值分支,只守卫 rAF 会在事件路径复活僵持,两处已共用同一守卫。主会话抽查 diff 吻合、复跑 test_editor_audition 4/4 绿;子代理另过 356 单测、typecheck、bundle。待实测: 开「跳过空隙播放」跨越空隙不再僵持;暂停/恢复、手动拖回空隙内仍正常跳过。条目 7(可闻 gap 开头残留)按续 20 计划待此项实测后评估。
- 续 24: 维护者拍板条目 6「先不激活」方案(波形按 B 不再激活任何行内编辑),实施子代理已派发(后台)。
- 续 25: 条目 8 调查闭环(主会话直接查),两类预览、两个缺口: ① **SRT overlay 预览**(播放器上字幕文本): 正向颜色操作都有显式 MawePlaybackLoop.refreshSubtitlePreview()(editor-color-filter.js:268/285、editor-colors.js:120),而撤销 applyHistoryRecord(editor-history.js:242-306)只 renderAll(列表+波形),暂停状态下 overlay 停留旧内容直到播放/seek——用户报告的直接根因; ② **ASS 实际画面预览**(FFmpeg 渲染窗口/暂停叠加): 自动重渲染只由播放器事件驱动(play/pause/seeking/seeked/loadedmetadata/emptied,editor-wiring-ass-frame.js:466-473),字幕数据变化(正向编辑与撤销 alike)均无触发,只有打开窗口/手动渲染时才重新比对 snapshot key。修复方案: (a) applyHistoryRecord 的 segments 恢复分支末尾补 preview: refresh 级 invalidate(覆盖 SRT overlay 与 undo/redo); (b) ass-frame 模块新增数据变化通知入口(复用既有 timer/pending 防抖与 snapshot key 比对),挂 MaweViewUpdates.invalidate(覆盖全部正向命令)与 undo/redo 路径,autoRender 关闭时维持现有 stale 陈旧提示、不自动渲染。待条目 6 完成后派实施(bundle 重建竞态)。
- 续 26: 条目 6 实施完成并核对通过。实现子代理选方案 a(splitAtCursor 增加显式光标模式,拆分主体 200 余行零改动复用): 波形 B 不再激活行内编辑,全文以工程数据为准;armed 外置为 split-context 模块私有 waveformForcedSplit{idx,segment,cutMs},segment 引用惰性失效(撤销/合并后不误强制),pointerdown/Escape 清除,提示文案不变;列表来源与多字幕绑定分支零改动,wiring B 分发零改动。主会话抽查两文件 diff 吻合、复跑 test_split_style_markers/test_mass_markers 34/34 绿;子代理另过 51 单测、16 例拆分 e2e、typecheck、bundle。待实测: 波形 B 二按强制拆分与 Esc 清除(无既有 e2e 覆盖)。
- 续 27: 条目 8 实施子代理已派发(后台,a+b+c 三处挂载)。
- 续 28: 条目 8 实施完成并核对通过。实现子代理: (a) applyHistoryRecord segments 分支末尾补 MaweViewUpdates.invalidate({preview: refresh}) + window.MaweAssFrame?.notifyProjectChanged?.(); (b) ass-frame 模块新增 notifyProjectChanged(复用 timer 200ms 防抖与 snapshot key 比对,previewNeeded 为假直接返回,autoRender 关闭时仅 syncStaleOverlay); (c) editor-view-updates.js invalidate 末尾挂通知(覆盖全部正向命令); 附带 editor-globals.d.ts 补 MaweAssFrame 类型声明(typecheck 硬性要求)。主会话抽查 diff 吻合、复跑 test_editor_commands/test_ass_cue_position 24/24 绿;子代理另过 33 单测、typecheck、bundle。待实测: 暂停后 Ctrl+Z 观察 SRT overlay、ASS 窗口、舞台叠加三类预览。
- 续 29: 全部实施项完成(条目 1-6、8 已修复;条目 7 并入条目 5 实测观察)。进入收口: 整体验证 → 人工核对清单 → 分组提交与 PR(Launcher 一组;编辑器性能一组;编辑器交互修复一组)。
- 续 30: 收口完成。分组提交与 PR: PR 304(fix/launcher-red-text-clear, 条目 1)、PR 305(perf/editor-word-timing-text-edit, 条目 2+3)、PR 306(fix/editor-interaction-refresh, 条目 4+5+6+8 + 本账本与核对清单/investigation)。收口前整体验证: typecheck、check:editor、check:launcher、test_editor_script_syntax/order/test_launcher_feedback_ui(56)全绿,git diff --check 干净,check_personal_paths --diff-ref main 无命中。人工核对清单: 261023测试反馈.checklist.md(已过 build.py --check,HTML 生成于 .artifacts/261023-test-feedback/,不入库)。条目 7 待实测评估;各条目人工核验项以清单为准。
- 续 31: Greptile 评审处理完毕(4 条,304 无评审): ① 305 CHANGELOG 缺条目——属实,未发布区【✨ 提升】补「大工程编辑性能」(fb513c02),回帖 resolve; ② 306 词块手柄加宽规则 CSS 特异性——误判,基础规则 (0,3,0)(waveform.css:976)低于新增 (0,4,0)(1017-1018),且无其他 width 竞争,规则必胜,回帖特异性证据后 resolve; ③ 306 强制拆分提示含 Enter——属实,波形路径无编辑态 Enter 确实不触发;forcedSplitRetryHint 参数化,波形路径改「请再次按 B 强制拆分」并补英文翻译(3d0fbec2),列表路径保留原文案,回帖 resolve; ④ 306 CHANGELOG 缺条目——属实,【🐛 修复】补「波形与预览交互修复」,回帖 resolve。CHANGELOG 另为 304 补【🐛 修复】「启动器处理文件红字」条目。
