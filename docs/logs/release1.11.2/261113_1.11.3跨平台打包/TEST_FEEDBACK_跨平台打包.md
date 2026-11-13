# 1.11.3 跨平台打包反馈

基线：main，a356ec01；状态：待处理 / 进行中 / 已修复 / 仅说明 / 阻塞。

| 编号 | 问题 | 状态 | 核实结论 / 方案 |
| --- | --- | --- | --- |
| 1 | 1.11.3 有两个平台打包失败，检查并修复 | 阻塞 | Linux 的 MOSS 根目录测试已改用当前平台实际根目录，Windows 单测通过；本机无 Linux 环境，Linux CI 尚待验证。macOS 任务未分配 runner、无步骤与日志，尚无法判断构建结果；需在有 runner 的环境重新构建。原 tag 的源码不会因本次工作区修复而改变。 |

## 阶段汇总

- 2026-11-13：建立账本；不擅自重发 Release 或移动 tag。
- 2026-11-13：Linux 根因定位到 `tests/test_moss_runtime.py` 的跨平台测试输入；计划使用当前平台实际根目录测试相同行为。macOS 没有分配 runner，原因无法从任务日志进一步确认。
- 2026-11-13：Windows 上 `tests/test_moss_runtime.py` 21 项通过，结果见 `.artifacts/checks/20261113T061143Z-5c6f1336/result.json`；本机无 WSL 发行版及 Docker，无法验证 Linux 或 macOS 实际构建。当前 main 比 origin/main 超前 1、落后 3；未合并、推送或触碰 tag / Release。后续需将修复整合到发布基线并在两平台 CI 验证，发布 1.11.3 附件需维护者另行授权操作。
- 2026-11-13：合并 origin/main 为 `6203b444`，已恢复其他任务的日志索引修改；修复后的 MOSS 测试在 Windows 21 项通过（`.artifacts/checks/20261113T062113Z-be3330c3/result.json`）。精简 CL 与 1.11.3 归档不一致会阻塞发布文档检查，因此按 CL 重生成归档；全部 21 份归档校验通过（`.artifacts/checks/20261113T062149Z-874912fe/result.json`），发布文档测试 17 项通过（`.artifacts/checks/20261113T062149Z-3f403651/result.json`）。Linux / macOS 构建尚未验证；修复及归档尚未提交或推送，未触碰现有 Release、tag 或官网。官网未来部署会读取更新后的归档。
- 2026-11-13：提交并推送 `c5c654b1` 后手动构建 43378449519：Linux 与 Windows 成功；macOS runner 已启动，但诊断日志测试失败。测试在看到 failed 状态后立即检查日志，而任务线程在发布状态和释放锁之后才写日志，存在竞态；准备等待工作线程完成后断言，不调整生产日志语义。
