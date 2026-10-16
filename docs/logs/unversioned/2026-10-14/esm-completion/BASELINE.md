# 真 ESM 收口实施账本

接续 [PR3 bootstrap 摘除计划](../../../../plans/PR3_BOOTSTRAP_PEEL_PLAN.md)
与 [编辑器真 ESM 收口计划](../../../../plans/EDITOR_ESM_COMPLETION_PLAN.md)。
本账本只记本任务批次的证据；PR3 历史事实见
[PR3-STATUS](../../2026-10-13/esm-migration/PR3-STATUS.md)，不改写。

## 第 0 步：基线（10-14）

HEAD：4b737ee9（feat/editor-esm-pr3-explicit-assembly）。
工作区 WIP：AGENTS.md、docs/INDEX.md 修订 + 新计划
EDITOR_ESM_COMPLETION_PLAN.md（保留并入本任务，不覆盖）。

登记表：61 工厂 / 8 桥 / bootstrap=[] / deferred=127。

| 命令 | 结果 |
| --- | --- |
| pnpm run check:editor | 新鲜 |
| pnpm run check:launcher | 新鲜 |
| node --test tests/test_assembly_contracts.mjs tests/test_editor_bundle.mjs | 7/7 |
| node --test tests/*.mjs | 608/608 |
| uv run --no-sync python scripts/run_tests.py | 2134 全绿（skip 21） |
| pnpm run typecheck | 110 基线 0 新增 |
| e2e assembly-order（chromium） | 6/6 |
| 真页面探针（page-probe） | bridge=true / trace=188 / cueRows=2 / errors=[] |

基线红灯：waveform-history 的 contextual help links /
grouped icon controls 两条在分支基点 e107c636 即失败
（PR3 账本已实证既有，与本迁移无关）。
