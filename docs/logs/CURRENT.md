# 2.0dev 当前交接

复核基线为上游 `2.0dev@393dbd5c`（2026-11-22）。接手时先核对当前 Git 引用。有新合入或核验证据时更新对应条目。原始记录在[日志索引](INDEX.md)。

| 主题 | 当前状态与证据 | 接手时核对 |
| --- | --- | --- |
| 2.0 整合 | [P1](release1.10.0-beta.2/261112_MAW2整合/P1整合记录.md#p1-closeout) 随 #373 合入。P2 Launcher 改版按[总计划](../INDEX.md#plans-maw20-integration)等待安排。 | 按总计划核对新基线、人工操作与跨平台范围。 |
| v2 工程 | 保存使用 `tracks`，旧工程经导入边界迁移。#397 修复新空白工程首次写入后继续保存到同一文件。 [工程契约](../engineering/JSON_SCHEMA.md) · [#397](https://github.com/Moyf/moys-asr-workflow/pull/397) | 涉及保存和导出时检查旧工程另存、原件保护、写回与重开。 |
| 日常测试与准入 | #398、#401、#402 已合入。#398 的 [Actions 与工件](https://github.com/Moyf/moys-asr-workflow/actions/runs/44070885519)可查。本地按依赖选测，独立检查继续执行并汇总失败。 [调试入口](../engineering/DEBUG_WORKFLOW.md#本地按影响选测) | `Change acceptance` 对应所选准入范围，完整 Editor / Windows 巡检走手动入口。分支保护设置由维护者另行确认。 |
| Chromium 收集与定向回归 | #412 随 `6589c283` 合入，恢复全量收集并修复旧夹具及实际交互回归。最终 PR head `fae66d91` 的 [Actions](https://github.com/Moyf/moys-asr-workflow/actions/runs/44908434204) 中，准入与两片辅助浏览器任务均成功。 [分诊台账](release1.11.2/261121_PR412辅助失败/TEST_FEEDBACK_PR412辅助失败.md) | 收集结果、定向运行和 CI 所选范围分别记录。尚需实测的操作见[人工核验清单](release1.11.2/261121_PR412辅助失败/辅助失败修复.checklist.md)。 |
| 共享浏览器回归 | [#424](https://github.com/Moyf/moys-asr-workflow/pull/424) 修复移出颜色组后的时间范围，20 条定向 Chromium 用例有[实跑记录](release1.11.2/261122_共享浏览器回归/验证记录.md)。 | 颜色组实测按[人工核验清单](release1.11.2/261122_共享浏览器回归/颜色组.checklist.md)。 |
| 编辑器 ESM | #404 迁移标记领域，#415 迁移播放、媒体导入和导出接线。当前装配以[源码清单与开发概览](../engineering/DEVELOPMENT.md#编辑器源码地图)为准。 [#415 实施](release1.11.2/261120_G16接线迁移/IMPLEMENTATION.md) | 使用[人工核验清单](release1.11.2/261120_G16接线迁移/G16_BGD.checklist.md)追踪实际交互。 |
| 官网文档 | 2.0dev 仍按[本分支的同步流程](../../website/docs/CONTENT_SYNC.md)提交源文档和生成副本。main 的 [#419](https://github.com/Moyf/moys-asr-workflow/pull/419) 已改为构建时从当前工作树生成。 | 跨分支同步时先核对相应构建流程。 |

早期 AI 文稿、ASS、视频画面轨道与其他专题的证据见[历史主题表](https://github.com/Moyf/moys-asr-workflow/blob/6589c283770d24f593fd66c4801d2f2c41db084f/docs/logs/CURRENT.md)和[日志索引](INDEX.md)。历史验收状态对应记录里的版本与实测范围。
