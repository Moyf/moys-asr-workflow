# TEST_FEEDBACK 合并后副轨颜色引用损坏（保存失败）

- 基线：`release1.11.2` 之后（log-release-baseline: 1.11.2）
- 分支 / HEAD：`fix/双语颜色字幕合并报错` @ `12daf4d2`
- 来源：维护者实测反馈（2026-11-12），工程文件 `digest直播（1）.后处理.mosp`（用户目录，不入库）
- 状态取值：`待处理` / `进行中` / `已修复` / `仅说明` / `阻塞`

## 问题清单

| # | 问题 | 状态 | 核实结论/方案 |
| --- | --- | --- | --- |
| 1 | 合并字幕 16（`好  饰演宇宙刑事卡邦无限/弩城怜慈`）与 17（`弩城怜慈一角  呃  然后`）后保存报错：`$.multi_subtitle.tracks[0].segments[20].color_ref.headIdx: must point to an earlier head segment`（另涉及 segments[22]/[23]/[24]/[26]/[27]/[29]/[30]，两类报错交替） | 已修复 | 副轨合并 / 删除 / 插入 / 整理均维护颜色引用；独立自审 F1/F2 已修复、双向验证和复审通过。4 条真实 localhost 保存及服务器停启重开回归通过，用户原工程人工验收另见清单。 |
| 2 | 保存失败修复提交后，原工程字幕 16/17 均为红色，合并却丢失颜色；维护者怀疑与中文由副字幕交换为主字幕有关 | 已修复 | 基线 `aef7f8cf`；四类合并入口跨组同色保色且维护外部组与撤销，原工程实际合并后完整契约 0 错误，519 条相关 Node 与 6 条保存回归通过，独立自审无 blocker/major，人工验收仍 pending。 |
| 3 | 补充提交前核对现有 PR 369：editor CI 失败，三条 Node 用例报告新增领域依赖未定义 | 已修复 | 两份 VM 夹具装配真实字幕领域依赖，保留原行为断言；本地旧 35 通过 / 3 失败，新 38/38 通过，待补充推送后确认 CI。 |

## 核实结论（#1）

- 原始工程 `validate_project` 通过（0 错误）：副轨 654 段，多个颜色组（yellow/green/red），报错下标处均为合法 `head + ref` 链。
- 主轨 16/17（1-based，下标 15/16）分别绑定副轨下标 14/15（binding-015/016）；两段副轨均为红色组成员（`ref-> 13`）。
- 复现推演（与报错逐条吻合）：`mergeContiguousIndices`（`web/editor/cues/editor-segment-ops.js`）主轨合并时把绑定的副轨段 splice 成 1 条，副轨其后所有段下标 -1，但没有任何代码平移幸存段的 `color_ref.headIdx`，也没有继承/拆分被合并段的颜色组：
  - 旧 head@20（green）→ 新位置 19，ref（旧 21 → 新 20）headIdx 仍 20 → 自指 → `must point to an earlier head segment`（segments[20]）；
  - 旧 head@22（yellow）同上（segments[22]）；其后成员（新 23/24）指向 22，但 22 现在是 ref → `must point to a color head`（segments[23]/[24]）；
  - red 组 head@26、yellow 组 head@29 同理（segments[26]/[27]/[29]/[30]）。
- 同族缺陷（同一次排查发现，同根因：轨道数组手术不维护组引用）：
  - `mergeExtensionSegments`（右键「合并副字幕块」）：splice 副轨，既丢被合并段颜色也不平移幸存 ref；
  - `mergeOverlaySegments`（`web/editor/cues/overlay-track.js`，叠加轨合并）：注释声称「与主轨合并语义一致」，但缺少主轨的 `splitGroupsAtCutPoints`（混合组）与 splice 后 headIdx 平移两步，head 落在合并窗口内/之后时同样悬空；
  - `deleteExtensionSegments`（未绑定副轨段删除）：splice 不平移幸存 ref；
  - `reconcileExtensionTrack` / `sortExtensionTrackSegments`（`web/editor/state/editor-multi-subtitle-core.js`，合并开启「时长自动同步」时在合并路径内被调用，其它对齐/拖动路径共用）：可删除/重排副轨段，同样不维护引用。
- 修复方案：抽共享纯函数（继承已有 `resolveMergedGroupInheritance`；新增 splice 后按下标集合平移/改指的 `remapGroupRefsAfterMergeSplice`），三个合并路径补齐「同组继承 → 混合组拆分 → splice 后平移」三步；删除与 reconcile/sort 的数组手术补引用维护。用 Python 契约校验器对修复前后数据做行为对照，JS 侧补单测。

## 阶段汇总

### 续 1（2026-11-12）

- #1 调查闭环：根因确认（见上），报错清单逐条复现吻合，非工程数据本身损坏。
- 实施修复中：`mergeContiguousIndices` 副轨分支 / `mergeExtensionSegments` / `mergeOverlaySegments` / `deleteExtensionSegments` / `reconcileExtensionTrack` / `sortExtensionTrackSegments` + 共享 helper + 测试。

### 续 2（2026-11-12）修复完成与验证

实施（8 个源码文件）：

- `web/shared/utils/multi-subtitle.js`：新增共享纯函数 `remapGroupRefsAfterMergeSplice`（合并 splice 后按被移除下标集合平移/改指组引用，支持非连续下标），经 `web/shared/editor-utils.js` 转发。
- `web/editor/cues/editor-segment-ops.js`：
  - `mergeContiguousIndices` 副轨分支：`resolveMergedGroupInheritance` 继承颜色组 → 混合组 `splitGroupsAtCutPoints` 拆组（合并前下标）→ splice 后 remap（用户报错路径）；
  - `mergeExtensionSegments`：同上三步，副轨直接合并不再丢颜色标记；
  - `deleteSegments` 成对删除副轨段：拆组 + 兜底清残余 ref + splice 后平移；
  - `deleteExtensionSegments` 未绑定分支：同上。
- `web/editor/cues/overlay-track.js`：`mergeOverlaySegments` 补齐拆组 + remap（原实现有继承但无拆组/平移）；`addOverlayRangeFromWaveform` 插入后 `shiftGroupReferenceIndices`。
- `web/editor/cues/editor-add-cue.js`：两处副轨插入后 `shiftGroupReferenceIndices`。
- `web/editor/cues/editor-timed-text-edit.js`：成对删除副轨段补拆组 + 平移。
- `web/editor/state/editor-multi-subtitle-core.js`：`reconcileExtensionTrack` 删除段时平移 ref、被删 head 的成员物化自持颜色；`sortExtensionTrackSegments` 重排后按对象身份回指（head 排到成员后时物化）。
- `web/editor/cues/editor-text-cleanup.js`：`syncTimelineGroupRanges` 纳入活动副轨的颜色 head 范围归位。

验证（分层）：

- 数据层红控（用户原工程）：`.artifacts/verify_merge_fix/` 用真实 shared helpers 复刻副轨合并手术——旧实现经 `maw.project.validate_project` 复现 435 条 `color_ref` 错误，前 8 条与用户报错逐字一致；新实现 0 条颜色引用错误。该模拟未完整重建主轨与绑定，脚本只统计颜色引用错误，不代表完整工程保存成功。
- 单测：`tests/test_editor_utils.mjs` 新增 4 条（连续/非连续/head 在合并集/边界输入），361/361 通过。
- e2e：`tests/e2e/multi-subtitle.spec.mjs` 新增 2 条（主轨合并联动副轨含撤销、副轨直接合并 + 数据层删除晋升 head）；修复前红控（stash 源码重跑）2 条真实失败，修复后通过。timed-text-edit 全量 16 条、overlay-track / waveform-deletion 全量通过。
- Python 全量：`uv run --no-sync python scripts/run_tests.py` 共运行 3129 条，结果 OK（31 skip，3098 通过）。
- `node --test` 语法/顺序 + `pnpm run typecheck` + `build-editor --check` 均通过。

已知基线失败：multi-subtitle / cue-color-filter 两个 spec 有 7 条用例在干净 HEAD（12daf4d2）上同样失败（首轮将源码及测试改动临时移出后复跑确认）。本次未定位其根因，不能确定为环境问题。timed-text-edit「search reveals filtered rows」在批量运行中失败一次、单独整组复跑通过；CPU 争用仅是猜测。

文档：`docs/user/MULTI_SUBTITLE.md` §8.1/§8.3 补合并颜色继承规则；CHANGELOG【未发布 → 🐛 修复】新增条目。

边界：主轨自身的组维护（既有）未动；`editor-word-timing.js` 的整轨重建按计划逻辑另行处理，未纳入本次范围。

### 续 3（2026-11-12）会话续接与事实核对

- 当前分支 / HEAD 仍为 `fix/双语颜色字幕合并报错` @ `12daf4d2`。续接开始有 13 个已跟踪文件修改及本账本，无已暂存内容；旧会话与快照只读，未恢复旧 provider 会话。
- 旧会话最后发现的空副轨访问已在当前 `mergeContiguousIndices` 中加条件保护，bundle 新鲜度检查通过。首轮自审没有可用最终报告；本轮重新发起只读独立自审，完成前将条目 1 改回 `进行中`。
- 核对首轮记录，修正了源码文件数量、Python 通过/跳过数量，以及数据模拟仅校验颜色引用的边界。原工程文件未改写。
- 本轮验证：Node utils + 脚本语法/顺序 363/363 通过（`.artifacts/checks/20261112T043841Z-d0258657/result.json`）；类型检查通过（`20261112T043928Z-7d87ce0e/result.json`）；bundle 新鲜度通过（`20261112T043828Z-819e8f19/result.json`）。
- 对已有模拟产物复核，旧 435 / 新 0 条颜色引用错误（`.artifacts/checks/20261112T043928Z-67f6014b/result.json`）。新增真实 localhost 回归在途：合并 → 撤销/重做 → 服务端保存 → 从磁盘重新打开，以及双字幕关闭时主轨合并保护。

#### 首轮基线失败清单（历史验证，未在本轮重复）

原始大组结果为 147 通过 / 8 失败；同一 HEAD 的无修复对照为 1 通过 / 7 失败。下表 7 条均在对照中失败，未在本任务修复；不将未知根因归类为环境故障。

| spec | 用例 |
| --- | --- |
| `cue-color-filter` | `colored subtitle indexes remain readable against tinted rows` |
| `multi-subtitle` | `creates an empty secondary track on enable and imports subtitles optionally` |
| `multi-subtitle` | `keeps the quick-import prompt when enabling an empty secondary track` |
| `multi-subtitle` | `saves an empty secondary track and supports manual creation, edits, undo and reopen`（空轨提示不可见，失败发生在本修复的插入路径之前） |
| `multi-subtitle` | `waveform extension cue double-click focuses the extension editor` |
| `multi-subtitle` | `light theme keeps the main waveform subtitle white and secondary subtitle lightly gray` |
| `multi-subtitle` | `ASS mode previews and exports extension cues with the shared extension style` |

另一个 `timed-text-edit` 搜索用例在大组中失败、无修复对照通过；恢复修复后整个 spec 16/16 通过。以上证据来自只读交接快照与首轮记录，首轮未按现行运行器保存 result.json，不伪造本轮日志。

本轮补人工清单源文件 `颜色引用修复.checklist.md`，生成物位于 `.artifacts/color-refs/verification.html`。沿用现有模板，未修改工具能力或目录。14 组深/浅主题与视口检查（320/375/414/768/959/961/1280px）通过：可见文字最小 12px、页面无横向溢出、5 项可勾选且刷新保留状态；截图与探针只留本地。生成与页面验证记录见 `.artifacts/checks/20261112T044110Z-ba686c7b/result.json`、`20261112T044117Z-27b85634/result.json`、`20261112T044302Z-88b8ec57/result.json`。这仅验证核验页，不代表原工程人工验收。

### 续 4（2026-11-12）保存回归通过，自审发现待修

- 新增 `tests/e2e/multi-subtitle-color-save.spec.mjs`：真实 UI 合并、撤销/重做、点击保存（`#save-project`）、200 响应、磁盘内容及 reload 一致性；双字幕关闭时保留隐藏副轨。Chromium 2/2 通过（`.artifacts/checks/20261112T044252Z-3296d948/result.json`）。只测试合成工程，未改写用户文件。
- 独立自审发现 F1「较大合并窗口漏算旧下标」与 F2「绑定拖动预览快照未恢复新增颜色变更」，主会话抽查代码和执行证据确认两项均为 Major，记录在 `REVIEW_FINDINGS.md`；条目 1 仍为 `进行中`，先修复后复验。
- 本地新增保存测试的旧逻辑变异验证第一次未成功注入 bundle，失败在测试路由而非产品行为，**不算有效红控**（`.artifacts/checks/20261112T044637Z-fea5827b/result.json`）。生产源码和当前 bundle 未回退或改写，待修复完成后修正探针。
- 已修正隔离变异探针：在内存构建旧合并源码 / 去掉空副轨保护的 bundle，经 AST 提取服务端注入数据填充，不改生产源码或实际 bundle。4 项对照中，旧合并代码对应双字幕用例失败（颜色丢失及 headIdx 仍为 4），去空保护对应关闭双字幕用例失败（`Cannot read properties of null`）；两条相反场景通过。有效红控记录：`.artifacts/checks/20261112T045109Z-fbc4373d/result.json`。中间另一次失败为未填充服务端注入 token（`20261112T044957Z-2881a729/result.json`），同样不计产品红控。
- 本轮追加状态 / 事务单测 19/19（`.artifacts/checks/20261112T045226Z-79a306e5/result.json`）和 Python 工程契约 50/50（`20261112T045226Z-7c781c0a/result.json`）通过。文档检查与其 22 条回归通过；已有其他主题的索引告警未处理。

### 续 5（2026-11-12）修复收尾

- F1 / F2 已顺序修复，永久新增测试在修复前确实失败；旧红 / 新绿记录和独立内存变异复验详见 `REVIEW_FINDINGS.md`。新增 `tests/test_editor_color_refs.mjs` 17 条，utils 再增 6 条边界回归；9 个生产源码文件变更，schema 无改动。
- Node 颜色域 / utils / commands / 语法顺序 / waveform 共 **459/459** 通过（`.artifacts/checks/20261112T045504Z-0cced630/result.json`）；类型检查通过（`20261112T045441Z-24636fc9/result.json`）。独立复审无剩余 blocker / major。
- localhost 保存回归最初 4/4 通过（`20261112T045629Z-60c40e6d/result.json`），随后增强为服务器停启后重新解析磁盘 `.mosp`，再次 **4/4** 通过（`20261112T045712Z-bcb3e814/result.json`）。覆盖两句 / 四句合并、关闭双字幕及绑定挤压预览往返；最后一项是领域预览而非鼠标事件。
- 受影响旧浏览器回归选跑 6 条，**5 通过 / 1 Chromium 启动超时**（`20261112T045842Z-c1b8537d/result.json`），未进入失败用例正文；清理归属核对后单独复跑叠加轨 split/merge **1/1** 通过（`20261112T050215Z-b0e71fff/result.json`）。没有重复跑整组，也不将初次整组写成全绿。
- 用当前 helper 再核对用户工程副轨模拟：旧 435 / 新 0 条颜色引用错误，前 8 条与反馈一致（`20261112T050309Z-840e9598/result.json`）；原文件未改写。模拟仅颜色层，完整保存证据来自合成 localhost 回归。
- 原工程人工验收清单仍为 pending（7 项），源码修复不冒充人工通过。现有 7 条浏览器基线失败、其他平台、打包与 CI 不在本轮闭环范围。保留所有未提交改动，未创建 commit / tag / PR、未 push；根 `blank-editor.html` 未重生成。
- 最终门禁：bundle 新鲜度、文档检查、UTF-8 / LF / 个人路径与 `git diff --check` 全部通过；记录分别为 `.artifacts/checks/20261112T050503Z-dc46a648/result.json`、`20261112T050503Z-15f6fc72/result.json`、`20261112T050503Z-39643613/result.json`。文档检查仅余其他主题的既有漏索引告警。本机 Node 为 v22.23.2，低于 package.json 声明的 22.x 下限；当前检查实际通过，但未据此宣称受支持 Node / CI 环境已验证。
- 核验页最终源文件检查、生成与 14 组浏览器探针通过，7 项全部保持人工未勾选：`.artifacts/checks/20261112T050503Z-9f301c5b/result.json`、`20261112T050512Z-27c10481/result.json`、`20261112T050519Z-d5e58636/result.json`。本工作树无测试服务器 / Playwright 残留进程。

### 续 6（2026-11-12）提交与 PR 授权

- 维护者明确要求「完成后提交 PR」。当前分支仍为 `fix/双语颜色字幕合并报错`，提交前核对没有额外无关改动、暂存区为空，仅以本任务路径清单提交。
- 复用已通过且对应当前行为源码的验证，不重复全量套件；提交前再次检查 bundle 新鲜度、文档、文本卫生和差异格式。独立复审已放行，人工清单仍为 pending。
- 本次授权范围为提交、推送与创建 PR，不包含合并、tag 或发布。PR 正文列出首轮既有失败、浏览器启动超时及未测边界；内联副本待发布前统一重生成。
- 修复提交 `a4c8ed7e` 已推送，创建 [PR 369](https://github.com/Moyf/moys-asr-workflow/pull/369)，正文已回读核对。GitHub 初始报告冲突，但本地 `merge-tree` 与实际合并预演均无冲突；同步最新 `main` 的 OCR 测试提交 `149f9fe7`，只共享日志索引并保留双方条目，不重写已推送历史。
- 同步主线后颜色域 / utils 384/384、文档与 bundle 新鲜度通过，记录为 `.artifacts/checks/20261112T051059Z-011a4ac0/result.json`、`20261112T051059Z-e10c006f/result.json`、`20261112T051059Z-fc1c0d50/result.json`。此同步是 PR 分支合并主线，不是将 PR 合入 main；CI 状态另以 GitHub 为准。

### 续 7（2026-11-12）同色合并丢色反馈续接

- 条目 2 补录：上一会话已修改主轨、联动副轨、独立副轨与叠加轨的颜色继承，Node 测试自报通过；没有浏览器新增回归、反向对照与本条记录，不能直接标记完成。
- 当前基线 `aef7f8cf`，开始时 6 个已跟踪文件修改，暂存区为空；保留上一会话的 WIP，旧会话和交接快照只读。之前提交及 PR 属于条目 1，本轮不新增提交或远端操作。
- 本轮先核对实际源码与用户工程，再补跨组同色的浏览器保存/撤销/重开回归、反向验证及独立自审；原工程只读，生成物和原始输出仅存 `.artifacts/`，不重生成 `blank-editor.html`。
- 当前用户文件已经是两句尚未合并的状态（649 条主字幕），不同于旧会话读取到的合并后版本。原字幕 16/17 各持独立 `color` head，均为 `red` / `#f07f6f`，范围分别为 `28650..31650` 与 `31650..34370`；工程校验 0 错误。这直接证实严格同组条件会把两条红字幕视为混合组，不必再假设或重建合并前状态。只读检查结果：`.artifacts/checks/20261112T080429Z-07d12e05/result.json`，原文件检查前后字节一致。
- 主副交换按源颜色组映射到目标组，保留不同组边界；两次标记颜色也能形成同样结构。没有证据说明交换本身损坏工程，本次修复颜色合并语义，不改交换流程或 schema。
- 使用当前用户工程真实两段调用旧严格组 helper 与新颜色 helper 对照：旧返回空 head/ref，新保留 `red` / `#f07f6f` 与合并范围 `28650..34370`，工程内存和原文件均未变。该证据只覆盖颜色决策，不冒充完整保存：`.artifacts/checks/20261112T080531Z-a142e6d5/result.json`。
- 维护者确认应修复，并明确授权「补充提交到 PR 上」。本轮收尾后只向现有 PR 369 分支补充提交和推送，更新 PR 说明；不合并 PR、不创建 tag、不发布。
- 补充前远端 `editor` CI 已失败；日志从 run `43159787896` / job `130988042974` 取回至 `.artifacts/checks/20261112T081217Z-4a391ba8/output.log`。三条失败位于测试 VM 夹具，报缺条目 1 引入的领域依赖；新增条目 3 单独闭环，不把现有 CI 写成通过。

### 续 8（2026-11-12）既有 CI 夹具修复

- 条目 3 实施完成：`tests/test_ass_cue_position.mjs` 装配真实 segment-ops，overlay 合并调用真实拆组辅助；`tests/test_sticker_placement.mjs` 注入真实 utils 并装配多字幕核心。未用空操作替代被测业务，原断言保留，未改产品功能。
- 修复前复现与修复后使用同一命令：`python scripts/run_check.py --timeout 180 -- node --test tests/test_ass_cue_position.mjs tests/test_sticker_placement.mjs`。旧 35 通过 / 3 失败（`.artifacts/checks/20261112T081338Z-ccfe128e/result.json`），新 38/38 通过（`20261112T081503Z-1ffff8d9/result.json`）；本地差异格式检查通过（`20261112T081535Z-349b9b73/result.json`）。主会话抽查两处依赖装配与日志确认结论。
- 用户指南变更已同步网站副本 `website/src/pages/docs/multi-subtitle.md`；同步器同时发现其他主题的既有副本过期，本轮只保留双字幕页面，撤回了本轮同步产生的无关改动，不覆盖其他工作。同步记录：`.artifacts/checks/20261112T081459Z-52d48a56/result.json`。网站专用依赖未安装，网站 check/build 未验证，留给 CI。
- 人工清单新增跨组同色保色项，8 项保持 pending；源检查与生成通过（`.artifacts/checks/20261112T081048Z-03b8d11c/result.json`、`20261112T081104Z-b773312f/result.json`），14 组深浅主题/视口探针通过，计算最小字号 12px、无页面横向溢出、新项刷新持久化通过（`20261112T081126Z-7e291996/result.json`），截图仅本地。此层仅验证核验页，不代表原工程人工通过。
- 补充真实工程数据层验证：使用当前用户文件的完整工程副本，调用实际 `mergeContiguousIndices([15,16])`，合并结果保留 `red` / `#f07f6f` 和完整文字，再由 Python `validate_project` 校验完整工程为 0 错误（`.artifacts/checks/20261112T081904Z-6f17782e/result.json`、`20261112T081913Z-e1aba39e/result.json`）。输出仅在忽略的本地临时区，原文件本次读取前后字节一致；两次只读探针之间用户文件版本已变化，因此不宣称原文件在整个会话期间未变。此层仍不是浏览器保存或人工验收。

### 续 9（2026-11-12）保色实现与双向验证

- 颜色 helper 复用实际预览/导出的有效颜色名解析，补空参数与非法下标防御；同组仍沿用 head/ref，跨组同色返回独立 head，主轨/联动副轨/独立副轨/叠加轨在 splice 前拆开源组，保持幸存成员颜色与撤销快照。表情包仍严格同组，schema 与交换流程未改。
- 新增领域与 helper 回归覆盖四类入口、ref/head 边界、色值与时间范围、外部组、混色/未标记、深拷贝和表情包；合并 CI 夹具后相关 8 个 Node 文件 **519/519** 通过（`.artifacts/checks/20261112T082100Z-bc5d2f80/result.json`）。类型检查通过（`20261112T082015Z-e9a48dce/result.json`），bundle 新鲜度通过（`20261112T082116Z-a4b40a57/result.json`）。
- 红控不回退生产 WIP：用 HEAD 的临时镜像领域模块和内存 bundle 路由，4 类 Node 回归均实际因 `color: null` 失败（`20261112T081409Z-18057e9f/result.json`）；新增两条浏览器回归也均实际因丢色失败（`20261112T081410Z-eba8f219/result.json`）。恢复新逻辑后新增浏览器 2/2 通过（`20261112T081711Z-f90436dd/result.json`）。
- 首轮完整保存 spec 为 5 通过 / 1 失败（`20261112T081512Z-03a620dc/result.json`）：交换后的中文重开时默认清理标点，夹具却要求原文逐字一致；颜色断言此前已通过。仅在新增夹具设置 `preserve_punctuation: true`，没有放宽颜色或保存断言。随后当前完整保存 spec **6/6** 通过（`20261112T082116Z-b2e18273/result.json`）：均检查真实 UI、撤销/重做（相关项）、POST 200、磁盘内容、reload 与服务器停启重开；交换后的主轨实际预览仍红。叠加轨本轮为 Node 层覆盖。
- 文档检查及其 22 条回归通过，UTF-8/LF/个人路径检查通过；详见 `20261112T081819Z-452f5dd9/result.json`、`20261112T081104Z-70eae067/result.json`、`20261112T081819Z-cd6fe936/result.json`。日志索引告警均为其他既有主题。本轮独立只读自审在途，完成前条目 2 保持 `进行中`，未提前提交。
- 扩大全部根目录 Node 套件：**1163 通过 / 1 失败 / 0 跳过**（`20261112T082325Z-6ce3365b/result.json`）。唯一失败为未修改的 `test_refactor_layout_tools.mjs` 历史 CLI 防误写测试：`fix-e2e-globals.mjs` 使用 URL pathname 未解码，中文 worktree 路径中的百分号编码导致读取清单 ENOENT，没到预期的 unsliced 守卫；源码锚点为 `scripts/refactor-tools/fix-e2e-globals.mjs:12`。本次不修改退役重构工具，不能把全量 Node 写成全绿；该运行与补充保色相关 519 条全部通过分别记录。
- 补充 Python 工程契约 50/50 通过（`20261112T082749Z-161e9721/result.json`），不代替全量。末轮文档、文本与 diff 检查通过（`20261112T082643Z-e290a942/result.json`、`20261112T082707Z-75728fe5/result.json`、`20261112T082707Z-ef925bcb/result.json`）；检查只保留已知既有日志索引告警。测试自有服务器已结束，现有两个 blank 编辑器服务非本轮测试进程，均保留。

### 续 10（2026-11-12）独立自审放行与补充提交

- 独立只读审查通读全部 16 文件，**无 blocker / major / minor**；唯一 N1 为两处旧规则注释，已修正。独立复验 519 条相关用例、4 条旧逻辑红控、11,200 次实际领域探针及旧镜像断言一致性通过，结果和边界见 `REVIEW_FINDINGS.md`。
- 条目 2 标记 `已修复`，条目 3 本地回归已通过；人工清单仍 8 项 pending。维护者已授权补充提交到现有 PR 369，仅提交当前任务路径，不合并或发布；实际提交与远端结果随后回填。
- 补充实现提交 **`d7513690`** 已推送到 PR 369 原分支，16 个任务文件；署名仅维护者，无机器尾注。PR 标题与正文已更新为保存/保色整体结果，经回读校验正文及远端 head 与本地提交一致。工作区提交后干净，未合并或发布。
- 首次新提交 check-runs 查询尚未返回运行项，不能报告 CI 通过；远端状态以 GitHub 后续运行结果为准。全量 Node 的历史 CLI 中文路径失败、网站构建/其他平台未测及人工清单 pending 均已写入 PR 边界。
- N1 注释修正后重建与新鲜度通过（`.artifacts/checks/20261112T083034Z-17b91cb7/result.json`、`20261112T083053Z-c6c31729/result.json`）；最终文档、UTF-8/LF/个人路径、差异检查通过（`20261112T083034Z-45d03a2a/result.json`、`20261112T083034Z-1f1efa80/result.json`、`20261112T083034Z-0e0e4e18/result.json`）。以上对应补充提交前的当前文件；仅注释变化，未重复行为层测试。
