# 官网发布收尾独立复核

日期：2026-11-11。审查基线：`main@67fd9033` + 本任务待提交改动。

## 审查状态

独立审查发现两条需修复问题和一条参数改进，均已修复并独立复验放行；没有剩余 blocker / major。审查者未改实现，主会话已抽查探针原文与实际输出。

## Findings 与处置

| 条目 | 证据 | 处置 |
| --- | --- | --- |
| R1 HTTP 传输异常分类遗漏 | 首轮 `scripts/verify_release_site.py:37–43,139–145`：真实 HTTPResponse 声明 100 字节但只返回 2 字节，IncompleteRead 未捕获；BadStatusLine 同样绕过重试。独立探针 `20261111T081834Z-9a83d48e/output.log:1–4`，只有 1 次请求/无睡眠。 | 已修复：`:159–160` 明确捕获 HTTPException；真实截断/坏状态行下一轮恢复，持续截断预算到期仍 exit=1，保留最后错误。 |
| R2 最终放行缺 deadline 核对 | 首轮 `scripts/verify_release_site.py:146–148`：第六次请求 post-response 检查后模拟调度推进到预算 5s 之外，仍 exit=0。探针同日志 `:5–6`。 | 已修复：`:155–158` 成功决策前再次检查；最终调度跨界 exit=1，无额外睡眠和 verified 输出。 |
| R3 无效 expected-tag 浪费预算 | 首轮 `scripts/verify_release_site.py:66–68,175–176`：beta 预期版本在稳定索引下睡满预算，日志 `:7–8`。自动 Release 调用已过滤，主要影响手动 CLI。 | 已修复：`:99,109–117,146` 验证 tag；独立 6 种非法 CLI tag 全部立即失败，无网络/睡眠，空值保留 latest。 |
| R4 真实 CI 未测 | workflow 条件与 summary/日志接线无明确缺陷；文本回归不能证明 Actions 真实执行。 | 接受边界：仅提交，不推送；清单保留下一次 CI 核验。 |

## 已确认验证与未测边界

- 主会话抽查旧红新绿证据：59 项受影响测试通过，空白正文用例在隔离基线旧逻辑上真实失败；记录见任务账本。
- 真实官网成功路径通过；不存在的预期版本在 2 秒预算后拒绝，输出实际最新版本和最后错误，未改变站点状态。
- 未运行真实新 CI、失败 summary/artifact 上传或部署传播故障模拟；只有静态 workflow 接线回归，actionlint 本机未安装。
- 外层进程限时兜底 socket 读取可能超过内部总预算的情况；等待与缓存防护不承诺解决全部 Pages 故障。
- 独立重跑原 59 项通过：`20261111T081541Z-6e9cdd6c/result.json`；独立探针 `20261111T081834Z-9a83d48e/result.json` exit=0 仅表示观测完成，不是上述缺陷通过。
- 修复前新增回归旧红 `20261111T082127Z-21183abf/result.json`，实施新绿 65 项 `20261111T082153Z-73f721f9/result.json`；独立二次 65 项通过 `20261111T082349Z-d9d189b7/result.json`，闭环探针带结果断言通过 `20261111T082349Z-0203d78b/result.json`。
- 二次探针适配非法 tag 的 stdout 空值，改从 stderr 读诊断；这是审查脚本适配，不是新增实现缺陷。真实 CI 失败 summary / artifact 仍待授权推送后验证。
