# CI 门禁纠偏独立审查

审查基线：main候选相对a1e88d1c。审查者未参与实现，只读源码并做受控验证，没有跑产品全量或真实浏览器/打包。初审发现如下问题，补修后已独立复审放行提交；不代表远端CI已经通过。

| 条目 | 级别 | 状态 | 发现与证据 | 处置要求 |
| --- | --- | --- | --- | --- |
| 1 | major | 已修复 | ci_acceptance聚合只验receipt metadata；运输阶段丢掉所有报告，公开gate CLI仍exit0。证据 `.artifacts/ci-gate-correction/review/checks/20261117T061958Z-a5b3f340/result.json`。 | 已重读运输报告、核对摘要/实际集合/结果及命令，公开CLI完整通过、报告丢失/伪造集合/坏命令均拒绝。 |
| 2 | major | 已修复 | 不可信/空diff的fallback强制preview=true，可能重新拉起完整Windows Python、E2E与打包；验证器还拒绝false。同上证据。 | 默认false；仅稳定检查兜底，反向强制预览计划拒绝。 |
| 3 | major | 已修复 | 普通docs规则先匹配，漏选同步器声明的6个实际官网输入；证据 `review/checks/20261117T062327Z-640cd6df/result.json`。 | 精确消费者先匹配，漂移测试核对真实同步清单；不扩大整个目录。 |
| 4 | minor | 已修复 | Node22.23.2下所谓无执行发现命令实际跑全部73准入测试，独立sentinel也执行；证据 `review/checks/20261117T062130Z-04bed152/result.json`、`20261117T062217Z-637db0bf/result.json`。 | 静态名称清单与一次JUnit；真实launcher与85项Node实跑通过，不依赖该过滤功能。 |

本轮54项Python契约与12项评论模拟通过，但不能抵扣上述真实finding。评论旧脚本在同一新回归中9失败3通过，负对照有效。

主会话已将全部finding反馈给main实现者，并提醒2.0dev适配不得复用已知缺陷。新增摘要/评论纯单测也须进入相应CI自身准入，而非只在完整巡检中发现。

静态撤回路径已确认：三主工作流候选已撤PR/main自动完整矩阵；Change acceptance不依赖辅助巡检/预览；正式release与完整环境action未改；实际base同步规范已在main候选修正。最终仍需处置finding、复审和远端候选验证。

## 修复后独立放行

main复审57项Python与12项Node通过，公开运输正反例重放成功，证据 `.artifacts/ci-gate-correction/review-final/`（主要 `064650Z-d46f8467`，运输 `064818Z-*` 至 `064820Z-*`）。上述四项关闭，无未处置blocker/major/minor。

非阻塞nit：两份官网副本包含旧副本与当前源正文的既有差异。已核对为真实同步器生成、对应本任务修改的DEVELOPMENT与INDEX输入；接受随对应源完整同步的差异，不手改生成副本，也未扩至另外五份无关页面。此取舍不代表新增产品行为。

同一独立审查者另对2.0dev工作树单独放行：17项Python、11项Node和公开CLI运输重放通过，日志在其 `.artifacts/ci-gate-correction-2dev/review-final/`。未增加完整矩阵/定时/平台，不将main实现强制覆盖该分支。仍需各自fetch并同步实际目标分支及实际远端验收。

## 同步实际main目标后的整合复审

目标更新至f6fd7e55，包含独立PR390固定缓存FFmpeg和PR395产品修复。预览保留上游windows-ffmpeg action但不恢复旧light条件；调试指南同时保留缓存说明与新分层语义；新缓存用例明确登记观察角色，不扩大本轮准入。产品、相关产品测试、正式release与FFmpeg action/helper相对合并目标无差异。

整合相关117项通过、评论12通过、actionlint通过及旧inline安装文本负对照真实失败，证据 `.artifacts/ci-gate-correction/merge-main/REPORT.md`。未参与实现的审查者再次复核合并delta，独立14项通过且无阻塞finding，允许完成merge commit；证据 `merge-main/review/20261117T070927Z-ccfb93ac/result.json`。未以单测替代真实Windows缓存或打包验证。
