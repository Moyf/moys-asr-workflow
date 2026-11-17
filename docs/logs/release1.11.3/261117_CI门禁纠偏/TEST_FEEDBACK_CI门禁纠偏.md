# CI 门禁纠偏实施账本

- 请求：按已确认方案撤销374保守覆盖扩张，完成后检查整个仓库PR路径不再被无关完整测试阻塞。
- 开始基线：本地 `main@a1e88d1c`，跟踪分支领先本地1笔文档提交；原WIP仅本任务 `docs/INDEX.md` 与新方案 `docs/plans/CI_GATE_CORRECTION.md`，保留不覆盖。
- 授权范围：本地实施、验证与独立审查；维护者后续明确选择“提交并开PR”，允许独立分支commit/push/创建PR，未授权合并、取消远端任务或修改远端分支保护。不以PR创建声称main及其他PR已解除阻塞。
- 状态取值：待处理、进行中、已修复、仅说明、阻塞。

| 条目 | 任务 | 状态 | 处理与证据 |
| --- | --- | --- | --- |
| 1 | 撤销PR/main完整矩阵、旧Editor/Windows Preview重复覆盖，建立稳定检查准入与正确聚合 | 已修复 | 准入清单已归档ADMISSION.md，工作流和consumer同时迁移，不删除完整巡检覆盖或涂绿辅助失败；独立复审放行。 |
| 2 | 核验文档PR、代码PR、main、定时/手动路径与故障注入 | 已修复 | 本地公开文档事件前后对照、报告运输正例与8类反例通过，父会话125项契约通过，独立复审57/12通过；真实候选远端另列交付边界。 |
| 3 | 更新协作说明、人工清单、独立审查和最终全仓扫描 | 已修复 | 首次3major+1minor均关闭，无未处置重要finding；接受两份对应官网输入完整同步的非阻塞nit，保留正式发布政策。 |
| 4 | 创建独立交付PR及核对远端；main生效/现有PR边界 | 待处理 | 已授权提交并开PR，分支fix/ci-gate-correction；合并main仍需维护者操作，不擅自修改其他PR。 |
| 5 | PR提交前同步分支规则 | 已修复 | 维护者明确纠正：同步实际base而不是固定main；main候选AGENTS、DEVELOPMENT与CONTRIBUTING已修改，2.0dev适配同样要求，提交前分别核对base与最新远端。 |
| 6 | 2.0dev独立适配与交付 | 进行中 | 用户明确授权两分支分别开PR；独立工作树基于origin/2.0dev@76bb330a，保留本分支2.0入口和发布边界，不新增原本不存在的12单元矩阵。 |

## 阶段记录

- 已先记录事实与授权边界。方案获准实施；本次不追加新的常驻覆盖矩阵、不顺带修所有历史偶发失败。
- 维护者通过交付选择明确授权独立分支提交、推送并创建PR，未授权合并。已创建fix/ci-gate-correction，不直接在main提交。
- 全仓PR审计发现main与2.0dev均有活跃目标PR；维护者明确选择两分支分别开PR。2.0dev不含374新增完整矩阵，只收敛其既有重检查，不为了移植引入新的自动完整矩阵。
- 维护者纠正提交前同步规则：先合并当前PR的目标分支，不固定main。已同步AGENTS及开发指南；main交付同步origin/main，2.0dev交付同步origin/2.0dev，历史日志保留原事实。
- 独立只读全入口审计未发现三主workflow外的隐藏全量重跑链；已确认旧Editor/Preview必须一起收敛，ci_matrix非PRfull约束与评论/摘要语义也需迁移。已建立同目录COVERAGE_WITHDRAWAL_AUDIT.md逐项核对，不改写历史日志。
- 预览评论已按真实归档/上传结果区分跳过、取消、异常和成功，核对当前PR head及已有bot记录，保持workflow_run权限边界。原脚本离线负对照12项中9失败；修复12通过，证据 `.artifacts/ci-gate-correction/comment/before/20261117T055250Z-5f660e83/result.json`、`after/20261117T055250Z-3838cc4b/result.json`。父会话复验12通过（`.artifacts/checks/20261117T055359Z-d0d46988/result.json`），最终命名待与主工作流整合。
- 已同步候选开发/调试指南与AGENTS协作语义，不要求无关辅助全绿。人工源清单校验生成通过（`.artifacts/checks/20261117T055319Z-3e18a331/result.json`），不代维护者打勾。
- 摘要新增显式advisory角色，区分执行集合验收与合并结论，不改变测试退出码。当前20项通过（`.artifacts/ci-gate-correction/summary/after/20261117T055752Z-524a512d/result.json`），旧脚本对新回归3失败4错误（`before/20261117T055714Z-d7c24b1a/result.json`）；主工作流完成后还需整合调用参数。
- 候选文档检查通过及文档回归22通过（`.artifacts/checks/20261117T055708Z-0ba32559/result.json`、`20261117T055708Z-542c0838/result.json`）；摘要源文件Ruff通过（`20261117T060031Z-a28fc1e9/result.json`）。主调度与聚合仍在实现，未据此标记整体完成。
- 用户再次明确按实际base同步，贡献指南也已修正；已创建基于2.0dev的独立适配工作树，不把main合过去。候选正式release.yml及完整巡检环境action相对开始基线无改动（`git diff --exit-code`核对），主实现进入独立只读审查；main自动全矩阵触发和日常聚合的辅助依赖已从候选YAML撤掉，仍待完整故障注入/远端核实。
- 独立审查暂不放行，发现3major+1minor：报告运输丢失仍绿、不可信diff默认完整预览、6个官网输入漏选及Node所谓发现实际双跑。已逐条登记REVIEW_FINDINGS.md，并反馈main与2.0dev实现者，不能把部分54/12通过当作整体完成。
- 父会话用真实临时Git仓库调用旧/新公开选择器CLI，分别验证普通工程文档PR与main push：旧策略两者full，新策略两者light、checks仅docs、preview=false。证据 `.artifacts/checks/20261117T063204Z-4cf305d8/result.json` 与 `.artifacts/ci-gate-correction/doc-event-proof.json`，不是源码字符串断言或旧API缺失错误。
- main实现者已交接补修：运输后重读真实报告、未知diff不预览、精确官网输入及漂移测试、Node静态清单单次执行；证据 `.artifacts/ci-gate-correction/review-fixes/report.md`。准入表已归档ADMISSION.md；仅保留本任务对应两份生成网站副本。
- 父会话最终相关Python125项通过、评论Node12通过、Ruff通过（`.artifacts/checks/20261117T065016Z-17cbaa4b/result.json`、`20261117T065016Z-2070fe4a/result.json`、`20261117T065016Z-81909148/result.json`）；UTF8/LF检查通过（`20261117T065206Z-ec4c9667/result.json`）。独立复审尚未放行，不先提交。
- 2.0dev实现者已正式交接本地实现及99/73/22+27等重叠集合证据；父会话独立复跑其Python73、Node11通过（子工作树 `.artifacts/checks/20261117T065206Z-04190165/result.json`、`20261117T065206Z-085a2f03/result.json`）。该分支不新增完整矩阵，所有发布/产品边界保持；同一独立审查者分别复核两个分支，之后再按各自base同步交付。
- 最终两个分支均获独立审查放行：main四项finding全部关闭，2.0dev无新增finding；范围提示及证据归档REVIEW_FINDINGS.md。接下来分别同步目标分支和创建PR，不自动合并或声称已对其他PR生效。
