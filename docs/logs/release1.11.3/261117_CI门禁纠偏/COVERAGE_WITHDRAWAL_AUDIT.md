# 自动覆盖扩张撤回核对

基线：`a1e88d1c`。本表核对的是本次候选策略，不把历史374日志改写为“从未追加覆盖”。

## 基线发现

| 入口 | 原行为 | 必须达到的收敛结果 | 当前证据 |
| --- | --- | --- | --- |
| test-matrix.yml | PR/main/tag/定时/手动追加12个完整测试单元 | 普通PR/main/tag不追加全矩阵；每周/手动保留完整巡检与真实失败 | 候选YAML已仅保留schedule/dispatch，独立审查确认；最终契约/远端待验 |
| editor-checks.yml | 非light跑全部Node、装配/专项Python、真实FFmpeg与两组E2E | 只跑明确准入稳定检查和实际文档消费者，不残留广泛Node/E2E/媒体准备 | 待候选源码与契约验证 |
| pr-release-windows.yml | 非light PR完整Python、专项E2E、媒体与打包 | 仅打包/启动/运行时相关或手动预览；无关PR不启动Windows构建runner | 待候选源码与契约验证 |
| ci_impact/ci_matrix | 两处共同要求非PRfull；未知/混合几乎全full | 日常与巡检分离，main文档轻量、未知代码稳定检查兜底，计划/版本/回执一致 | 待候选源码与契约验证 |
| 聚合与摘要 | 全部选中矩阵失败传播required结论 | Change acceptance只聚合所选阻塞检查；辅助红仍保留，不传播/涂绿 | needs已仅selection/checks；独立审查发现运输报告缺失误绿，修复前不放行。摘要20项通过待role调用整合 |
| 预览评论 | 固定job名、skip只解释为文档、可能整体红误报无包 | 准确报告scope skip/取消/上传结果，过期head不覆盖当前结果 | 12项离线VM验证及旧脚本9失败负对照，独立审查通过；远端callback尚未生效 |
| 协作说明 | “全量留给CI”、非PRfull、旧门禁不缩水 | 日常不要求无关完整检查全绿；相关风险与发布原政策保留 | 已更新候选文档，待最终一致性核对 |

三主workflow之外：Ruff不启动全套测试；官网Pages构建不启动完整Python/Node/E2E/Windows包；预览评论只读jobs更新评论，无dispatch/rerun；package postinstall只构建，不自动测试。未发现隐藏的整套自动重跑链。正式release保持原范围与策略。

## 远端事实与交付边界

只读核对main传统保护返回Branch not protected，适用ruleset只有deletion和non_fast_forward，无required_status_checks。不能把名称带required等同GitHub必需状态。历史红灯与全绿协作要求仍可形成事实阻塞，本次一并纠正。

维护者授权main与2.0dev分别独立分支提交、推送并开PR，未授权合并。候选CI通过只能证明候选PR采用新策略；目标分支和其他PR不会因为创建该PR自动解除旧策略。旧run重新运行也不保证采用新workflow/原事件基线；不擅自改其他PR分支或批量取消任务。

2.0dev基线76bb330a没有374新增完整矩阵，只有旧Editor/Preview等入口，不能为了同步反而给它增加12单元矩阵。该分支单独适配与验收。提交前分别fetch并同步各自PR实际目标：main→origin/main，2.0dev→origin/2.0dev，不固定合并main。

## 最终核验（持续回填，尚未放行）

普通工程文档PR与main push已有公开CLI正反对照：旧a1e88d1c两者full，候选两者light、仅docs、preview=false。真实临时Git差异，证据 `.artifacts/checks/20261117T063204Z-4cf305d8/result.json`；本地模拟事件不替代远端main实际运行。

候选自身验收：PR399和398均为策略/契约/说明变更；自动preview不因workflow策略文件本身而启动，改变真实打包payload或明确manual才选预览。首次398的冷editor依赖准备错误已修，保留首败；新head必须实际确认editor通过、预览未选中、无自动完整矩阵，不以“辅助所以可以忽略”代替撤掉无谓运行。

- 计划与main/PR/定时路径测试。
- 阻塞失败/漏报告/错SHA/意外skip拒绝，辅助失败不传播的真实负对照。
- 独立源码审查、发布工作流未改及全仓消费者扫描。
- 最新候选head的实际远端checks/jobs与未运行的重型验证边界。
