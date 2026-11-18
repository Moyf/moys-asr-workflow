# 2.0dev CI 纠偏审查记录

下表保留实现者证据与交接；协调会话已另请未参与实现的审查者独立复审放行，见文末。该结论不是远端CI或完整产品验收通过。

| 编号 | 发现与证据 | 处置 |
| --- | --- | --- |
| R1 | `test_v2_migration_save.py:42` 页面构建读取 bundle；首轮实际准入失败，不能整文件宣称纯单测 | 缩到同文件两个无页面构建 ID，实跑通过；Node v2 保存测试仍完整纳入 |
| R2 | website sync curated map 包含 DEVELOPMENT/JSON_SCHEMA/INDEX 和一份日志；按文件夹机械轻量会漏消费者 | 直接读取 map，测试覆盖源文档；网站同步后增加 tracked diff 检查 |
| R3 | 原重门禁报告验证有价值，不能删掉完整能力或将失败 continue-on-error 涂绿 | 原 Editor/Windows jobs 保留独立手动 workflow，旧浏览器/缓存契约改查对应手动入口 |
| R4 | auxiliary job 不属于汇总依赖；错 SHA、漏 receipt、取消或 selected skip 不得绿灯 | exact needs、receipt 数量/身份/hash 验证及报告反例覆盖 |
| R5 | 预览评论不能仅靠整个 run success 判断有包，过期 run 不能覆盖新头 | 兼容旧/新名称、实际归档与上传、PR head 二次检查、Bot 所有权及 run/attempt 顺序测试 |
| R6 | 首版 gate 只验 receipt metadata，报告在运输后丢失或篡改仍可能放行 | receipt 绑定完整证据摘要与 manifest；gate 重读 Python/Node 报告、准确集合及命令 result；公开 CLI 的真实运输正反例和重绑坏结果注入均覆盖 |
| R7 | 不可信 diff 首版 preview=true 会意外触发完整 Windows 包 | 默认 false，仅真实相关路径或 workflow_dispatch 可预览，坏 PR/push diff 反例覆盖 |
| R8 | Node 的 `--test-name-pattern=^$` 在本机并未实现无执行发现 | 撤掉过滤与第二次执行；显式静态 names 清单+单次 JUnit，真实 Node 写计数器仅一次；漏项、重复、失败与 skip 均拒绝 |
| R9 | 零依赖假设被 python -S 打破，Server 导入需要已有 Send2Trash | 为直接保存相关组及重新发现 ID 的 gate 显式准备一个哈希锁定核心包；隔离依赖路径复验，不同步共享应用环境 |

接受边界：有限清单尚无长期首次失败统计；未测真实浏览器/媒体/完整 HTTP 安全链路、打包及远端保护。release 工作流固定哈希契约守住本轮边界，未来明确发布改动时需有意识审查更新，不将它误作永远冻结发布功能。

## 独立审查放行

未参与实现的审查者通读本分支候选，复验17项Python与11项Node，公开gate完整运输退出0、删Python及改Node报告退出1，无新增blocker/major/minor。证据 `.artifacts/ci-gate-correction-2dev/review-final/20261117T065005Z-3adebf51/result.json`、`20261117T065005Z-740e0154/result.json`、`20261117T065029Z-10f57e33/result.json`、`20261117T065029Z-79c77e16/result.json`、`20261117T065030Z-f9ae2d55/result.json`。

协调会话另复验相关Python73、Node11通过（`.artifacts/checks/20261117T065206Z-04190165/result.json`、`20261117T065206Z-085a2f03/result.json`）。允许按已获授权提交交付，提交前仍只同步实际目标origin/2.0dev，不合并main。

PR398首次冷环境暴露acorn准备缺口后，已补editor的锁定依赖安装、双reporter诊断及CI-only不自动预览规则；独立审查者快审这5个源/测试文件允许提交，无blocking finding。19项CI契约与59 editor正向准入通过，冷依赖失败反例真实可见；远端新head另验。
