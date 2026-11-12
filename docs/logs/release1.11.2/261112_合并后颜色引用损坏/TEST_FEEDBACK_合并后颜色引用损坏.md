# TEST_FEEDBACK 合并后副轨颜色引用损坏（保存失败）

- 基线：`release1.11.2` 之后（log-release-baseline: 1.11.2）
- 分支 / HEAD：`fix/双语颜色字幕合并报错` @ `12daf4d2`
- 来源：维护者实测反馈（2026-11-12），工程文件 `digest直播（1）.后处理.mosp`（用户目录，不入库）
- 状态取值：`待处理` / `进行中` / `已修复` / `仅说明` / `阻塞`

## 问题清单

| # | 问题 | 状态 | 核实结论/方案 |
| --- | --- | --- | --- |
| 1 | 合并字幕 16（`好  饰演宇宙刑事卡邦无限/弩城怜慈`）与 17（`弩城怜慈一角  呃  然后`）后保存报错：`$.multi_subtitle.tracks[0].segments[20].color_ref.headIdx: must point to an earlier head segment`（另涉及 segments[22]/[23]/[24]/[26]/[27]/[29]/[30]，两类报错交替） | 已修复 | 副轨合并 / 删除 / 插入 / 整理均维护颜色引用；独立自审 F1/F2 已修复、双向验证和复审通过。4 条真实 localhost 保存及服务器停启重开回归通过，用户原工程人工验收另见清单。 |

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
