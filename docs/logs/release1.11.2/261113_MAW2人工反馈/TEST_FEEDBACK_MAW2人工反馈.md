# MAW 2.0 P1 人工反馈

## 基线与处理规则

- 实现分支：`integration/main-to-2dev-20261112`；HEAD `e358512e`，未提交合并来源 `961e5949`。
- 接收反馈时存在 437 个暂存整合文件、27 个未暂存补修文件及未跟踪计划/台账；保留全部既有工作，不重复合并。
- 状态仅使用：待处理、进行中、已修复、仅说明、阻塞。先记录后调查；自动化不代替维护者人工验收。

## 问题清单

| 编号 | 问题（维护者反馈） | 状态 | 核实结论 / 方案 |
| --- | --- | --- | --- |
| 1 | 说话人勾选拓展9色之后，为什么还是能一直添加一直添加，超出到10几种？ | 仅说明 | 既定 v2 契约是身份独立于颜色，九色不是九人上限；管理器新增人物不按 palette_size 限制。超过九人仍保留不同身份，ASR 可循环颜色。未擅自新增人数限制；如要改为限制需明确新的产品决策。 |
| 2 | main 最新合并过来的应该已经是「双击字幕块（cue）」弹出编辑小弹窗了，为什么现在这边的版本还是聚焦到字幕编辑区？ | 仅说明 | 现场运行的是原 dev/v2.0 工作树，而非整合工作树：进程命令行明确使用原树 maw_gui.py / server-editor/serve.py，Server 端口8250。原树 cue-blocks.js:367–378 仍调用 enterCueEditor；整合树 :372–379 已调用 openCueQuickEdit，副轨与叠加轨同样接入。未发现此反馈证明整合代码遗漏；需在正确整合入口重新人工验证。 |
| 3 | 右键菜单太大，恢复 1.0 的五个小颜色圆形；九色扩展时第二行放四个错开的颜色圆形，排列为第一行 1–5，第二行居中 6–9。 | 已修复 | `editor-context-menus.js`、`editor-wiring-context-menus.js` 与 `editor.css` 复用22px圆点，CSS grid五加四错位；移除名称卡片，悬浮保留名字。浏览器实测圆点尺寸、第二行圆心错位通过，已查看菜单截图。 |
| 4 | 不要常态显示「未分配」，只在有说话人的时候显示说话人 label。 | 已修复 | `editor-cue-elements.js` 隐藏无身份 badge，`editor.css` 显式处理 hidden 避免旧 display 覆盖；属性面板和右键分配入口保留。中英文切换、真实人物名及过滤／分配浏览器回归通过。 |
| 5 | 波形主字幕与双语副字幕需要间隔，避免 outline 互相遮挡；叠加字幕与主字幕同理。补充：6px 又太开，只缩窄缝隙，不改描边画法。 | 已修复 | 最终为3px盒间距，原1px／选中2px outline与offset不变。主会话提出的2px＋向内加粗已被维护者否决并移除。`waveform.css` 与 `cue-blocks.js` 同步分层/cover阈值并修正编号中心；单多行、深浅主题实测3px，选中主块2px、副块1px且offset=0，外缘相接。64/96/120/144/192px与字词矩阵无新增裁切；低行高保留既有同位覆盖边界，不宣称三轨分层。 |
| 6 | 波形设置「悬浮时显示完整文本」改为「悬浮显示完整字幕文本」，默认不启用；两个 checkbox 靠近，去掉 waveform-cue-tooltip-setting 上下 margin；新增「双语副字幕显示颜色」checkbox，默认不勾选，勾选后副字幕块按字幕颜色着色。 | 已修复 | 模板、i18n、waveform设置／控件／渲染同步；两项默认false，显式偏好刷新保留；副轨复用字幕颜色解析，关闭保持中性。浏览器实测tooltip项上下margin均0，中英文checkbox距上一项17px（原额外margin已去）；勾选副轨着色、取消和刷新记忆通过。 |
| 7 | 相同说话人的两句绿色字幕无法合并，提示「不同说话人的字幕不能合并，请先统一归属」。最新方向：以主轨为主，主轨一致就合并，连带副轨更新；副轨不得阻塞，Toast提示即可。 | 已修复 | `editor-segment-ops.js` 仅检查主轨来源身份，副轨按主轨身份统一（主轨未分配则清除副轨身份），实际改变时Toast说明，中英文完整翻译。主轨跨人及独立副轨／叠加跨人仍拒绝。副轨收集保留绑定或至少500ms重叠规则。已验证真实用户拓扑的合成主同人／副跨人合并、自动拼合、撤销重做、Server保存重开；原工程不改。 |
| 8 | 副轨在主轨分配颜色／说话人时是否联动？最新明确要求：需要绑定分配。 | 已修复 | `speaker-identity.js` 单向扩展显式绑定CueRef，身份分配／清除及快捷槽共用；`editor-sticker-picker.js` 分类颜色分配／清除同步副轨独立组，避免副轨反向改主轨。隐藏已绑定副轨也同步，未绑定重叠项不跟随普通赋值。支持一次撤销、重做、磁盘保存重开；多选同组同色重复赋值不新建历史，但副轨异色仍能修正。 |

## 阶段汇总

- 续 2（2026-11-13）：收到四项补充修改并获准本地提交；基线分支 `integration/main-to-2dev-20261112`、HEAD `0c2fcebb`，工作区干净。已登记为条目 3–6；颜色第二行明确为四个错位圆形（6–9），不是色块或文字行。实施、验证与独立自审后仅提交本任务文件，不推送。
- 续 3：首次浏览器命令 `uv run --no-sync python scripts/run_check.py --timeout 180 -- pnpm.cmd exec playwright test --config=tests/config/playwright.config.mjs tests/e2e/editor-feedback-layout.spec.mjs --project=chromium --workers=1` 为 2 项失败，记录 `.artifacts/checks/20261113T104605Z-752349c0/result.json`。条目4为真实 CSS 覆盖问题；另一项为新测试 addInitScript 每次刷新重置存储，已改为仅初始化不存在的偏好。此前不带 `.cmd` 的 pnpm 启动失败只属 Windows 命令入口问题（`20261113T104550Z-a7373c21`），不算测试执行。首次单行/多行、深/浅主题波形与设置截图已目视自查，不将中途断言通过记为整组通过。

- 收到两项 P1 人工反馈，均先登记；尚未判断为缺陷或修复。
- 续 1：两项核对完成，均归为仅说明，不修改生产代码。条目1依据 `docs/user/EDITOR_GUIDE.md:226–230`、`docs/plans/SPEAKER_IDENTITY_CORE_PLAN.md:13` 与 `web/editor/styles/editor-speaker-manager.js:97–115`。条目2依据两棵树的 `web/editor/media/waveform/cue-blocks.js` 及本机只读进程检查（只记录源码归属，不保留个人路径或媒体文件名）。没有停止用户服务、关闭窗口或操作其工程。
- 后续：维护者保存当前编辑后，从 `maw20-main-integration` 整合工作树启动并复验双击；P1人工清单仍未通过。原会话交接没有让运行入口足够明确，不能把原树的体验当作整合版本验收。已有69/69浏览器记录仅为历史自动化证据，本轮没有重跑浏览器。

- 续 4：初版浏览器三文件共9项，8通过1失败（`20261113T105011Z-9347cbc4`）：新改测试误断言原生 title，但共享 tooltip 已转存 data-title，修正测试后9/9通过（`20261113T105154Z-893e698a`）。独立自审发现120px新增裁切与编号偏移，已补修；低行高既有覆盖契约作为显式边界接受，详见 [独立审查](REVIEW_FINDINGS.md)。维护者随后否决6px及2px＋向内描边提案，最终只缩为3px并保持原描边，所有最终证据均按此版本复验。
- 续 5：条目3–6均已修复；条目1–2仍为历史仅说明。没有代码实施阻塞或待处理项；人工验收未勾选，全量CI、打包与发布未运行。维护者另通过协调说明授权完成后新建目标 `2.0dev` 的PR，但必须先等待协调会话提交进度文档并明确放行；不得合并新的main、强推、合并PR或发布。

## 最终分层验证（基线 HEAD `0c2fcebb`，本次待提交源码）

命令统一使用 `uv run --no-sync python scripts/run_check.py --timeout N -- <命令>`；结果路径均为 `.artifacts/checks/<目录>/result.json`。本轮待提交文件见本次提交本身；不含 bundle、截图、临时HTML或媒体。

| 层 | 实际命令 / 结果 | 结果目录 |
| --- | --- | --- |
| Node 单元与反向验证 | `node --test tests/test_editor_feedback_ui.mjs tests/test_waveform_js.mjs`：74通过；含旧默认、隐藏守卫、常驻卡片、旧覆盖阈值、编号公式、零间距、固定副轨中性色的变异失败对照 | `20261113T110047Z-28a068b4`；独立复验 `20261113T110239Z-ee136a8c` |
| Python 波形 / JS语法顺序 | `uv run --no-sync python scripts/run_tests.py tests/test_waveform.py`：26通过；`node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs`：2通过 | `20261113T105851Z-e2fe6341`；`20261113T104811Z-cbbaa707` |
| 构建与类型 | `pnpm.cmd run typecheck`、`node scripts/build-editor.mjs --write`、`pnpm.cmd run check:editor` 均通过 | `20261113T110047Z-14916f11`、`20261113T110047Z-145eb81f`、`20261113T110057Z-6b6d0664` |
| 浏览器交互与几何 | `pnpm.cmd exec playwright test --config=tests/config/playwright.config.mjs tests/e2e/editor-feedback-layout.spec.mjs tests/e2e/speaker-identity-surfaces.spec.mjs tests/e2e/waveform-display-settings.spec.mjs --project=chromium --workers=1 --output=.artifacts/editor-display-feedback/browser`：10通过；`tests/e2e/word-timing.spec.mjs` 以 `-g 'bilingual compact\|full word layout\|bilingual overlays keep'` 定向：4通过，含拖动、撤销与cover契约 | `20261113T110119Z-f3f5e24f`；`20261113T110212Z-0efa6c78` |
| 文档与工具页 | `scripts/check_docs.py` 通过（仅历史日志导航warning）；核对清单生成和浏览器375/1280px检查通过，根横向溢出0、可见文字最小12px；最终文档和提交前检查见后续记录 | `20261113T105748Z-f05aeea7`、`20261113T105858Z-21e0d33f` |

最终截图与几何JSON位于 `.artifacts/editor-display-feedback/browser/`（菜单、设置、波形的深浅主题及高度矩阵），主会话已目视检查菜单、波形和设置；图片不入库。未测：完整e2e、CI、打包、真实长媒体连续播放。低行高叠加覆盖保留，不冒充已解决。人工核验源见 [显示反馈清单](编辑器显示反馈.checklist.md)，生成页为 `.artifacts/editor-display-feedback/verification.html`。

收尾复验：最终文档检查 `20261113T110440Z-f4748215` 通过（仅原有六条日志导航warning）；最新JS语法顺序 `20261113T110440Z-9d8b4127` 为2/2通过；最终人工清单重新生成 `20261113T110440Z-a8dbfd05` 通过。所有记录均对应同一基线与本任务待提交文件；不包含维护者后续人工确认。

提交前暂存区个人路径扫描 `20261113T110532Z-ecd11c1d` 与 `git diff --cached --check` 的 `20261113T110532Z-6d1a8447` 均通过；仅暂存本任务24个文件，无其他任务暂存内容。

## 新增反馈（条目7）

接收基线为 `integration/main-to-2dev-20261112`、HEAD `2db41954`，工作区干净。条目3–6已完成提交；条目7为新增调查，不将前次验收结论扩展到本项。用户工程仅只读检查，媒体、工程和原始内容不入库；待确认实际身份与合并路径后回填结论。

条目7调查结论：现有 `tests/test_speaker_merge_guards.mjs` 已覆盖主轨同人、副轨不同人的拒绝及零副作用；`docs/user/MULTI_SUBTITLE.md:243–252` 规定已绑定或未绑定且重叠至少500ms的副轨联动合并。维护者通过选择确认保持该契约，仅区分冲突来自主轨还是联动副轨。最初按所有时间重叠推断三句副轨冲突有误，已扣除不足500ms的第一句，实际纳入两句。实施需覆盖手动合并、自动拼合以及直接副轨合并提示，不把未绑定误说成不参与。

方向更新（覆盖上段决定）：维护者随后明确“需要绑定分配”，且“以主轨为主，如果主轨一致，那就合并，并连带副轨一起更新，不再因为副轨阻塞，Toast提一嘴”。先前“副轨冲突仍拒绝，仅改提示”作废，不作为最终验收；已要求实施代理暂停旧方案。条目7改为主轨身份优先合并，条目8由仅说明转为授权实施；需要同步原先严格拒绝的测试／指南／核心计划，避免用旧契约拦新行为。不会直接修改用户提供的工程。

最终规则登记在 [说话人核心计划](../../../plans/SPEAKER_IDENTITY_CORE_PLAN.md) 的2026-11-13补充；用户指南与官网副本已同步。官网命令经 run_check 执行：`pnpm.cmd --dir website run sync:docs`（`20261113T112255Z-224f0483`）、`pnpm.cmd --dir website run check`（`20261113T112304Z-ef13ec5d`，0错误／警告／提示）、`pnpm.cmd --dir website run build`（`20261113T112322Z-29cb0fdf`，44页）均通过；仅sync命令提示本机Node22.23.2略低于engines要求22.23.4，不影响本次实际结果。业务实现、最新定向与浏览器验证仍待完成，不沿用旧拒绝提示方案的75项通过记录作为新规则证据。

实施与首轮复验：新规则定向108/108通过（`20261113T112713Z-06c60a4e`），回退旧实现31项真实失败（`20261113T112725Z-9292736b`）后恢复。首次全量Node为1641通过／1失败（`20261113T112915Z-4c2eb0c3`）：仅上一批3px波形改动漏同步的旧1px字符串断言，已保留单行max和多行贴格语义更新测试，随后1642/1642通过（`20261113T113226Z-2b250ae2`）。首次新浏览器3项为2通过／1失败（`20261113T112915Z-d8648c01`）：主会话误要求未纳入合并的前一副字幕时间不变；既有自动时长同步会把其尾部重叠从1520裁至1240，身份和文本不变。已显式设定该偏好并断言原有整理，3/3通过（`20261113T113202Z-ad3c3de6`），不是修改生产逻辑迎合测试。

独立自审无blocker／major，发现多选重复同组同色仍新增历史的P2；修复前2项真实失败（`20261113T113419Z-23ce4f73`），修复后相关64/64通过（`20261113T113440Z-5c03aa43`），独立复核确认闭环。再次全量Node1645/1645通过（`20261113T113536Z-4e93fd6b`），浏览器三文件13/13通过（`20261113T113536Z-9554bdb5`），含真实Server的身份与分类颜色保存／重开，以及撤销重做。截图自查另发现新复合英文Toast中旧“裁剪N条其他副字幕”片段未翻译，最后仅补该组合提示的英文回归，业务逻辑已固定；待补修后登记最终证据。

### 条目7–8最终验证与收尾

全部命令经 `uv run --no-sync python scripts/run_check.py --timeout N -- ...` 执行；路径为 `.artifacts/checks/<ID>/result.json`，未沿用旧拒绝契约测试宣称新行为通过。

| 层 | 命令 / 实际结果 | ID |
| --- | --- | --- |
| 全量Node | `pnpm.cmd run test:unit`：1646通过、0失败、0跳过 | `20261113T113948Z-bdf6ffe7` |
| 最新真实浏览器 | `pnpm.cmd exec playwright test --config=tests/config/playwright.config.mjs tests/e2e/editor-feedback-layout.spec.mjs --project=chromium --workers=1 --output=.artifacts/main-led-speakers/final-toasts -g 'main merge\|main assignments\|main-led merge'`：3通过，含中英Toast无残留中文、单向赋值与真实Server磁盘保存重开；前轮三文件完整13通过 | `20261113T113948Z-ca82b966`；`20261113T113536Z-9554bdb5` |
| 最后翻译反向验证 | 旧翻译真实失败1项，恢复后 `test_v2_i18n_merge.mjs` 与合并守卫定向29通过；完整手动／自动拼合提示包含裁剪、删除和解绑说明 | `20261113T113838Z-a751e33c`；`20261113T113904Z-18187df6` |
| 构建与类型 | `node scripts/build-editor.mjs --write`、`pnpm.cmd run typecheck`、`pnpm.cmd run check:editor` 均通过 | `20261113T113904Z-aecbb38b`、`20261113T113904Z-bac382de`、`20261113T113914Z-6d3ccb55` |
| 文档与清单 | 文档检查通过（仅6条历史日志索引warning）；清单生成通过，375/1280px浏览器根溢出0、最小可见字号12px | `20261113T113226Z-e3db82e2`、`20261113T113936Z-b875e82d`、`20261113T113948Z-c8db11c8` |

条目7–8均已修复，无待处理／进行中／实施阻塞项。独立审查的P2已修复并复核，未处置blocker／major为0。用户提供工程始终只读，未复制原始工程或媒体入库。最新Toast与完整浏览器截图位于 `.artifacts/main-led-speakers/final-toasts/`、`final-browser/`，不入库；最终英文提示截图和人工清单已自查。

未验证边界：完整e2e、远端CI、打包、真实长媒体持续播放及维护者人工勾选未完成；低行高cover仍为既有接受边界。协调会话将在本次提交交接后更新整合计划的数据不变量表述，并单独提交P0/P1进度文档；取得明确放行前不push／不开PR。

提交前全部20个任务文本文件检查为LF；暂存区个人路径检查（`20261113T114326Z-584ac6fa`）、空白检查（`20261113T114326Z-46cb7819`）、最终文档检查（`20261113T114326Z-10b6565a`，仅历史warning）与最终清单生成（`20261113T114326Z-776c0e04`）通过。官网目录被忽略导致git add提示exit1，但回读确认20项均已准确暂存、无未暂存改动，不使用强制添加带入其他生成物。末次i18n补修经独立只读复核无新增blocker／major。
