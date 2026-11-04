# REVIEW_FINDINGS 单行双语叠加轨回归修复

- 日期：2026-11-04
- 审查者：独立后台 agent（未参与实现），提交前自审
- 范围：本工作树全部未提交改动（5 个源文件 + CHANGELOG + 账本 + 新测试 `tests/test_waveform_word_lane.mjs`）
- 结论：**无未处置 blocker / major**；F1–F3 提交前已处理，F4/F5 记录接受。

## 通过项（摘要）

- `wordTimingFullLane` 语义与三处旧内联条件逐一对照：除修复目标组合（basic×双语 false→true）外所有既有组合结果不变；旧内联版不含 `wordTiming?.enabled` 的差异经使用点核对无行为变化（appendWordBlocks 首行 early-return、appendSharedBoundaryZones 使用点本就以 enabled 短路）。
- CSS 特异性逐一计算：四组新规则均压过对应旧规则（7>3、7>3、6>4、5>4），且全部以 `.waveform-basic` 开头，多行/非双语行选择器层面不可能命中。
- 复核独立重跑：新测试 8/8、相关单测 375 项、typecheck、bundle 新鲜度、实机探针（双语开 overlay 314.5..349.5 = 50% 线、条带 546..581 贴主块、wordFull=true、气泡照画）、e2e word-timing 41/41 与 multi-subtitle 90/90。
- 变异验证：判定换回旧语义 → 回归核心用例失败；drawWordChips 恢复旧提前 return → 门测试失败（加固后走断言路径而非 TypeError）。

## Findings

| # | 严重度 | 发现 | 证据 | 处置 |
| --- | --- | --- | --- | --- |
| F1 | minor | 账本「全量 1006/1006」未注环境，复核环境同批 bundler 基建用例 17 项失败（test_editor_bundle / launcher bundler），经基线 f3f45273 树对照确认为环境性失败、与本 diff 无关 | 复核 `.artifacts/checks/20261104T033219Z-2ed558fc/output.log`；git archive 基线树对照 | 已处理：账本验证段注明 Node v25.8.2、两次运行均全绿，并如实记录复核环境的 17 项环境性失败与基线对照结论 |
| F2 | minor | CSS 契约测试两条断言（`height: 35px;` / `display: flex;`）切到文件尾后不具判别力（needle 在切点后各出现 6 处），删除对应声明测试仍会通过 | 复核用 node 脚本实测 needle 计数 | 已处理：改为按规则块切片（到下一个 `\n}`）逐规则断言（`rule()` helper），重跑红绿双向验证有效 |
| F3 | minor | drawWordChips 门测试的 mock 行缺 `classList`：旧代码失败于 TypeError 而非「查询未发生」断言，mock 若被后人补全会漏检 | 恢复旧提前 return 变异时的失败信息 | 已处理：mock 行补 `classList: { contains: () => true }`，旧代码失败于 `calls` 断言路径；两处 mock（门测试 + 气泡照画）同步加固 |
| F4 | nit | 矮窗格（basic 双语行约 122–300px）+ 字词码开时，叠加块 `max()` 兜底位与字词条带精确重叠（同一区间），账本原措辞「可能贴近」不准；非双语矮窗格本就存在同类重叠（既有行为） | 复核实测几何 | 接受：账本措辞改为「精确重叠」并标注接受风险（复核 F4） |
| F5 | nit | `appendWordBlocks` 向共享判定传 `wordTiming?.enabled` 与首行 early-return 冗余 | word-blocks.js:48 | 接受：与判定真源签名保持一致，显式优于省略，不改 |

## 未验证层

- Python 套件未跑（本 diff 无 Python 改动）。
- e2e 未跑全量 chromium 矩阵（按仓库纪律留给 CI）；拖动 / seek 等纯交互手感未人工验证。
- 组序号徽章在单行双语 + 字词码下的实机观感（几何经 CSS 推算无误，探针工程无徽章数据）。
- 维护者真人目视验收待做（见账本「未验证边界」）。
