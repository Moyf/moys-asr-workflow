# TEST_FEEDBACK 单行双语叠加轨回归

- 日期：2026-11-03
- 反馈人：Moy（实测）
- 分支：`fix/bilingual-singleline-overlay-regression`（base main @ f3f45273）
- 场景：单行（基础）波形模式 + 双语字幕启用 + 叠加轨启用（含字词码组合）

## 问题清单

| # | 状态 | 反馈 | 调查结论 |
| --- | --- | --- | --- |
| 1 | 已修复 | 叠加字幕又和主字幕 overlap，应放主字幕上方 | 波形侧：双语行把叠加块压到主字幕格上方 1px 处（贴住主块），主轨徽章（bottom = inset+2·lane+2）落进叠加块带内；双语关闭时叠加块浮在 50% 线、远离主块。ASS 导出/预览侧经 Node 复现验证双语开/关锚点一致，无回归 |
| 2 | 已修复 | 叠加字幕没有显示文字气泡（双语关时有） | 字词气泡（drawWordChips）遇到 `multi-subtitle-row` 直接 return；字词条带 full-lane 判定含 `!multiLane`，双语一开整行字词降级紧凑叠加，条带+气泡消失，字词块压在主字幕块上 |
| 3 | 已修复 | 叠加字幕单独在中间上方，双语一启用就「跑下去」（位置跳变） | `e9a4fa8e`（#218）给 `.multi-subtitle-row` 的叠加块统一下移到「inset+两格 lane+1px」，该规则为本为多行模式 192px 行高设计（主块顶越过 50% 线），但同样命中了行高数百 px 的单行模式，叠加块从 50% 线（约 350px）跳到 116px |

## 期望行为（Moy 原话语义）

单行模式下，即使双语启用，叠加字幕（以及字词显示样式）也沿用双语未启用时的那套显示；
双语开关只应影响主字幕的译文行（主块上移让位、底部新增译文格），不应改变叠加轨的定位/气泡/布局。

## 两层语义备忘（任务线索的「先理清」）

- ASS 侧（ass-canvas-layout.js `assCreateStackPlan`）：副字幕（extension）是**固定层**，
  位置完全跟随其样式预设（主字幕下方）；叠加字幕（overlay）参与堆叠链，**锚定在主字幕上方**。
  Node 复现（.artifacts/tmp/repro-overlay.mjs）：双语关/开 overlay 锚点同为 (960,810)，均高于主块，无回归，不需改。
- 波形侧同构：副字幕 = 底部固定格；叠加轨 = 独立上层（单行模式 50% 线）。
  回归在波形侧的双语分支 CSS/JS，不在 ASS 导出。

## 回归根因（提交）

- 位置跳变（#3）：`e9a4fa8e` feat: 完善字幕波形、工程设置与 AI 整理交互 (#218)
  —— waveform.css 新增 `.waveform-row.multi-subtitle-row .waveform-cue-block.waveform-overlay-block { bottom: calc(inset + lane*2 + 1px) }`，未区分单行/多行。
- 气泡消失（#2）：`fa5ae60c` fix(editor): 完成 1016 大核验反馈与合并前回归修复 (#251)
  —— 字词条带/气泡规则全部挂在 `:not(.multi-subtitle-row)` 下，且 JS 的
  `wordTimingFullLane` 含 `!multiLane`（cue-blocks.js:276、word-blocks.js:55、cue-blocks.js:550 三处内联重复）；
  更早的 word-blocks.js:346 也在 drawWordChips 入口挡掉双语行。
- 拥挤/overlap（#1）：上两条在同一组合（单行+双语）下的叠加后果；另 `.waveform-row.multi-subtitle-row .waveform-cue-badge`（inset+2·lane+2）在单行双语行落进叠加块带内。

## 修复方向

单行模式与双语解耦：`wordTimingFullLane` 判定收敛为 `visibility.js` 单一纯函数
（单行恒真；多行维持「非双语且行高 ≥96」），`drawWordChips` 放开单行双语行；
CSS 为单行双语行补「条带贴双语主块上方 / 徽章随条带 / 叠加块与叠加徽章保持 50% 线
（max 兜底保证仍在双语主块上方）」四组规则；多行模式行为全部不变。

## 阶段汇总

（2026-11-04 修复完成）

### 改动文件

- `web/editor/media/waveform/visibility.js`：新增共享判定 `wordTimingFullLane(wordTimingEnabled, mode, rowHeight, multiLane)`（单行恒真；多行维持「非双语且行高 ≥96」），加入 freeze 导出。
- `web/editor/media/waveform/cue-blocks.js`：appendCueBlocks / appendSharedBoundaryZones / relayoutCueBlocksInRow 三处内联分层条件全部换用共享判定（判定真源收敛，另修正 overlay cover-mode 注释说明单行由 CSS max 兜底）。
- `web/editor/media/waveform/word-blocks.js`：appendWordBlocks 换用共享判定；drawWordChips 删除 `multi-subtitle-row` 提前 return（单行双语行照画气泡，条带几何仍从 computed style 读取）。
- `web/editor/media/waveform.js`：helpers 解构与 `AsrWaveform.testing` 导出补 `wordTimingFullLane`、`drawWordChips`。
- `web/waveform.css`：新增单行双语行（`.waveform-basic … .multi-subtitle-row`）四组规则——字词条带 full 样式（bottom = inset+两格 lane+gap+2px、高 35px、flex/line-height）、组序号徽章随条带上移（+39px）、叠加块保持 50% 线（`max(50%, inset+两格 lane+1px)` 兜底，带 `:not(.overlay-cover-mode)` 防护）、叠加徽章同步 max 形式（+37px）；多行双语行贴格规则原样保留。

### 验证

- 新增 `tests/test_waveform_word_lane.mjs`（8 项）：判定全组合（单行×双语关/开均 full——回归核心；多行旧语义不回退）、drawWordChips 门（双语行放行到查询、多行/字词码关照旧拦住）、双语行气泡走到布局且条带几何来自 computed style（stripTopPx = 117+35）、waveform.css 四组契约（按规则块切片断言，保证判别力）、内联旧条件清除断言。
- `node --test tests/test_waveform_word_lane.mjs`：8/8 通过。
- 双向验证：`git stash push -- web/`（修复缺失）后 8/8 全红（恢复旧提前 return 时门测试按「查询未发生」断言路径失败，非 TypeError），pop 后全绿。
- 全量 `node --test tests/*.mjs`（Node v25.8.2，TMPDIR 指向 `.artifacts/tmp`）：两次运行均 1006/1006 通过（exit 0）。独立复核环境同批 bundler 基建用例（test_editor_bundle / launcher bundler）17 项环境性失败，经基线 f3f45273 树对照确认与本改动无关。
- e2e（独立复核在本地 worktree 补跑）：`tests/e2e/word-timing.spec.mjs` 41/41、`tests/e2e/multi-subtitle.spec.mjs` 90/90——多行双语行紧凑布局等既有断言无回退。
- `pnpm run check:editor`（重建后 bundle 新鲜）与 `pnpm run typecheck`：通过。
- 实机探针 `.artifacts/tmp/probe-overlay-wave.mjs`（Playwright + 真实 serve.py，699px 行高）：双语关 overlay 314.5..349.5（50% 线）、条带 582..617、wordFull=true；双语开（修复后）overlay 仍 314.5..349.5、条带 546..581 贴主块 583..637 上方 2px、wordFull=true——三条反馈全部消除。截图 `.artifacts/tmp/probe-bilingual-{off,on}.png`。
- ASS 导出/预览侧无回归（修复前已验证）：`.artifacts/tmp/repro-overlay.mjs` 双语关/开 overlay 锚点同为 (960,810)。

### 提交前自审

独立复核（未参与实现的后台 agent，2026-11-04）通读全部 diff 并独立重跑探针/单测/e2e：无未处置 blocker/major。F1–F3（账本环境注记、CSS 契约测试判别力、drawWordChips 门测试 mock 加固）已提交前处理；F4/F5 为记录接受的 nit。详见 [REVIEW_FINDINGS.md](REVIEW_FINDINGS.md)。

### 未验证边界 / 待人工确认

- 真实浏览器目视验收：单行 + 双语 + 字词码 + 叠加轨组合下条带 / 气泡 / 叠加块的观感（探针只验证了几何与绘制路径，截图为自动截取）。
- 短窗格兜底：单行窗口压得很矮（约 122–300px）且字词码开时，叠加块 `max()` 兜底位与字词条带精确重叠（同一区间，几何上必然）；非双语矮窗格本就存在同类重叠（既有行为），属兜底语义下的接受风险（复核 F4）。
- 组序号徽章（🎨/🦊）在单行双语 + 字词码下随条带上移后的观感（几何位置经 CSS 推算无误，探针工程无徽章数据，未实机目视）。
