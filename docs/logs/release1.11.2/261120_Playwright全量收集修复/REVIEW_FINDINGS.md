# 提交前独立自审记录：2.0dev Playwright 测试修复批次

- 日期：2026-11-20
- 范围：本批全部未提交改动（10 个 spec / fixture + 1 处产品修复 + 台账与 CHANGELOG），基线 `origin/2.0dev` @ `4fd058e0`。
- 方式：未参与实现的独立审查者（后台 subagent）通读全部 diff，对照产品源码核实每条契约断言，并实跑全部 10 个被修改 spec、相关 Node 单测、typecheck 与 bundle 新鲜度。
- 结论：**无 blocker、无 major；6 条 nit**，处置见下表。正向验证要点：产品修复经 1.x 源码（f3dfb60a）、服务端对称契约（`tests/test_project_contract.py` 同样省略该字段）与 pr239 三处断言三重印证；fixture 迁移经直接转换验证段 ID/轨道模式/绑定全保留；全量 `--list` exit=0（1261/133），waveform-history 仅剩台账已声明的 2 项既有失败，无新增回归。

| 编号 | 级别 | 位置 | 问题 | 处置 |
| --- | --- | --- | --- | --- |
| N1 | nit | tests/e2e/gap-removed-audio-export.spec.mjs | stub 门面的 `projectBindingEpoch` 是静态值，丢失真实模块的活 getter 语义，「detach 使在途导出绑定失效」半边契约不可观察 | **已修**：改为 `get projectBindingEpoch() { return projectBindingEpoch; }` 并新增断言 detach 后值为 2，复验通过 |
| N2 | nit | docs/logs/.../TEST_FEEDBACK_基线失败分诊.md | 台账两处 spec 计数与实跑不符（settings-structure 应 34/34、gap-removed-audio-export 应 21/21） | **已修**：进度摘要与 #5/#25/#26 行共 4 处计数更正 |
| N3 | nit | docs/logs/.../TEST_FEEDBACK_Playwright全量收集.md | 决策表「全量 --list 验收」「变更 spec 定向运行」状态滞后（进行中/待处理），与同文件已给出的完成证据不符 | **已修**：两行改「已修复」并附结果摘要 |
| N4 | nit | 范围外：tests/e2e/timed-text-edit.spec.mjs | 未入 45 条样本的既有失败 3 项（v1 fixture 迁移另存门、undo 比较未剥 `_dirty`、blank 工程 rows 继承期望），与本批已修模式同类 | **已记入台账**「剩余待处理·范围外补充」，列为下一批次输入（含处理顺序建议）；不在本批顺手修，避免扩大 diff |
| N5 | nit | tests/e2e/editor-session-state.spec.mjs | `JSON.parse(fingerprint) && ...` 守卫无实际保护作用且重复 parse 两次，可读性差 | **已修**：先 `const snapshot = JSON.parse(...)` 再取主轨，复验通过 |
| N6 | nit | tests/e2e/settings-structure.spec.mjs | `multi_subtitle: undefined` 在 v2 语境下是 no-op 死代码（importProject 的 JSON clone 丢弃 undefined 键），误导后来者 | **已修**：删除该键（`preview: undefined` 语义仍成立，保留），复验通过 |

审查者另附范围外观察（不计 finding、未处置）：`tests/e2e/helpers.mjs:523` 报错文案 "Failed to build portable blank editor" 是 `buildBrowserEditorFixture` 更名前的遗留，属既有代码、本批未触及，可随下一批次顺手更正。
