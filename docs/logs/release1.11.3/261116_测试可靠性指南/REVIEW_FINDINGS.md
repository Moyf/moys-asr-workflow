# 测试可靠性指南复审

基线：`main@a1e88d1c`。仅增加维护者指南和文档入口，不修改测试、产品或 CI。

## 独立审查

- 无 blocker / major。审查核对 #384 两份核验记录、服务探活 helper 与请求实现。
- 已修正：启动失败可能来自产品或探测器，不能直接归为环境失败；启动超时先列为证据不足。
- 已修正：明确待开发的是 CI 对齐发行包版本、校验和缓存，不暗示发行包未固定 FFmpeg。
- #389 日志已有 GET 200，但 Node 探活未完成的具体原因仍未知。不宣称 CI 已修完。

## 验证

- `python scripts/check_docs.py`：通过。仅现有历史日志未登记警告。
- `python scripts/run_tests.py tests/test_docs_check.py`：22 项通过。
- `git diff --check`：通过。
- 本次只有文档改动，未重新运行业务测试。外链为已知 PR / 运行证据，文档检查只验证仓库内链接。
