# 纯文本编辑拆句字词码与搜索光标 · 实测反馈账本

- 来源：维护者实测（工程 `口播整理修复验证-20261020`，Bandicam 录制目录下 _maw 工程），附两张截图。
- 日期：2026-10-20（记录于 10-21）。
- 涉及分支：当前工作树（1.10.0-beta.1 之后开发）。

## 问题清单

| # | 状态 | 问题 | 结论 / 方案 |
|---|------|------|------------|
| 1 | 已修复 | 纯文本编辑里把 `lucide icon for example` 拆成两句，字词时间码没有复用，走「估算」，提示「有 2 条字幕缺少可复用的字词时间码」 | 根因：`timedTextItemLayout` 严格布局只校验 items 拼接长度（等长内容漂移还会静默错位），items 与 text 存在空白/标点漂移时布局失败 → 拆句/改写一律估算。修复：严格布局补内容校验；失败时走宽容对齐回退——按 LCS 把 items 重新切齐到真实文字（时间码不变，仅中性字符归属移动，未认领空隙吸收进相邻 item，匹配率 ≥0.6 且时间码有序才启用，重切结果用严格校验复核）；结构拆分 retime 对「切片与行文字只差空白/标点」增加漂移回退（`timedTextNeutralDriftItems`），覆盖「修改后移除字幕前后空格」、锚点吸附中性字符等场景。低相似度仍按原逻辑估算，不伪造精度 |
| 2 | 已修复 | 纯文本编辑搜索定位到命中后，目标文本框看不到光标闪烁 | `revealTimedTextEditSearchMatch` 原来定位后把焦点强制还给查找框。修复：显式导航（上一条/下一条、Enter、新增 F3 / Shift+F3）把焦点移入命中 textarea（选区落在命中上，caret 可见）；查找框输入时的预览定位保持焦点在查找框。逐条视图 textarea 提升到镜像层之上（z-index 2，与整体视图一致），否则不透明镜像背景盖住 caret。武装状态下 Enter 续跳命中；方向键/点击/输入后立即解除武装，Enter 恢复普通换行。查找框补 tooltip 说明按键 |

## 与 #1 相关的事实基线

- 实测工程 103 条中 13 条 items 拼接 ≠ text，漂移类型：双空格/单空格（#11、#24、#62）、词间缺空格（`youset`/`yourvault`，#21、#28）、items 多尾逗号（#23、#34、#58、#60）、text 含 `(be)` 而 items 没有（#18）。
- `.mosp.bak`（最早备份）即已存在同样漂移 → 来源是 ASR 导入/AI 整理管线，不是编辑器改坏的；编辑器侧做宽容匹配即可，不回写工程数据。
- 现有测试 `keeps later cues aligned when whitespace at a split boundary is removed`（test_editor_utils.mjs）覆盖的是「空白是独立 item」的情形，未覆盖 items 文本自身漂移。
- 顺带发现的既有缺陷：等长内容漂移（如 items `「 it's」` vs text `it's `）会让严格布局的 spans 整体错位却校验通过，本次内容校验一并修复。

## 验证记录

- 真实数据回放（临时脚本，验证后已删除）：加载实测工程，对 103 条带 items 字幕的 299 个空格拆点逐一构建报告；修复前 #11 估算 2 条（预览边界 38,810 与截图一致），修复后 299 拆点全部复用真实字词码（0 估算），含首尾空格被删的草稿变体。
- `node --test tests/test_editor_utils.mjs tests/test_waveform_js.mjs tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs`：414 通过。test_editor_utils 新增 7 个用例：前后空格漂移拆句（两种草稿）、词间缺空格、items 多尾逗号 / text 多插入词、低相似度仍估算、锚点模式等长改写与改写行估算、被删词残骸不拼凑时间（Greptile P1 回归）。
- e2e `tests/e2e/timed-text-edit.spec.mjs`：16/16 通过。新增「搜索导航聚焦命中 textarea + F3/Enter 续跳 + 方向键解除武装 + 打字后撤销回原位不复活跳转（Greptile P2 回归）+ Esc 收尾」用例。
- 既有用例 `search reveals filtered rows in the center…` 在本机出现过 3 次失败，失败点在 toBeHidden / toBeVisible / scrollTop 之间漂移；用还原 web/ 改动 + 保留新用例的方式复跑仍失败，且单独跑恒过——判定为既有的防抖时序脆弱，与本改动无确定关联。新用例收尾改为显式关闭弹窗（Esc + 接受确认）后，全文件连续两轮 16/16 稳定。
- `pnpm run check:editor`：bundle 重建后校验通过（模板 CSS/HTML 不进 bundle，i18n 改动已随重建验证）。
- Python 全量套件 `uv run --no-sync python scripts/run_tests.py`（run_check 包装）：2641 项，OK（skipped=17）。
- e2e 组跑 `timed-text-edit.spec.mjs + editor-text-tools.spec.mjs`：首次与 Python 套件并行执行时出现「Server did not respond within 30s」环境性失败（server 探活被 CPU 竞争拖死，24 项未运行）；环境空闲后重跑 41/41 全过。教训与既有规则一致：e2e 不与全量套件并行跑。

## Greptile 评审轮（PR #284）

- P1「Words inherit deleted words' times」：有效。文字删掉 items 里的词时，残骸碎片可能把被删词的时间拼给相邻词（`foo baz` + 残留 `bar` → `baz` 被拆成 `ba`/`z` 继承错误时间还报告已复用）。修复：`recutLayoutItemsOntoTokens` 增加完整性守门——有实义文字的 item 至少 3/4 非中性字符对齐，否则整组放弃走估算；新增回归用例断言估算插值（baz 从 629ms 起，而非被删词的 400ms）。
- P2「Enter unexpectedly resumes search」：有效。武装状态原本只靠选区比对被动失效，打字后撤销回原位置会复活跳转。修复：rows / 单视图 textarea 的 input 事件立即清空武装；e2e 补「打字替换命中 → 删掉 → 回到原位 → Enter 插入换行而非跳转」步骤。
- 修复后：Node 414 通过、e2e 16/16、bundle 重建，作为第二个提交推送并 re-trigger Greptile。

## 边界与未验证项

- 宽容对齐按字符 LCS 做，未验证极端长字幕（>2000 字符）下的性能；理论 O(n·m) 有既有 2,000,000 格上限保护，超限自动回退估算。
- items 携带 `id` 且重切后文字变化时会丢弃该 id（与切片路径同一规则）；`ai_cleanup.cleanup_scope` 的精确文字校验可能因此对漂移段保守失效，属可接受的保守行为。
- 搜索焦点行为未在中文 IME 组合态实测（Enter 武装跳转已排除 IME 组合键 keyCode 229）。
