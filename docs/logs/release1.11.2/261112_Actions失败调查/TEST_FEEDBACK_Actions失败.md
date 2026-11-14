# Actions 失败调查

- 基线：`main`，HEAD `ad950863`；工作区已有工程规范文档改动。
- 状态取值：待处理、进行中、已修复、仅说明、阻塞。
- 范围：修复测试环境隔离并调查缩略图连接中止；不修改远端。

| # | 问题 | 状态 | 核实结论/方案 |
| --- | --- | --- | --- |
| 1 | [Actions 任务失败](https://github.com/Moyf/moys-asr-workflow/actions/runs/43217494664/job/131180456029#step:17:35)，帮忙查看原因。 | 仅说明 | Windows Python 缩略图测试中客户端读取响应时遇到 `WinError 10053`。本地原测试 50 次、原始 socket 三组各 200 次均未重现；另一次历史失败发生在同一测试的其他请求。额外确认 HTTP/1.1 keep-alive 下非法 Host 被立即拒绝但请求体未被读取，剩余内容被当成下一条请求，出现后续解析错误；这是真实协议问题，但与 CI 中断是否同因仍未证实。本次需求仅要求专项复现，未改服务端。 |
| 2 | 同步 main 后本地全量测试失败。 | 已修复 | `tests/test_launcher_batch.py` 改用含模拟设置的临时配置并恢复进程环境；`tests/test_moss_runtime.py` 在默认路径用例中隔离两个覆盖变量，三个继承场景覆盖该行为，同时 mock ASCII 路径转换以避免平台回退影响。修复前负对照命中，修复后相关测试 80 项执行、75 项通过、5 项跳过。本机全量测试中原 MOSS 错误未再出现，但另有条目 4 的失败，全量未通过。 |
| 3 | 近期线上打包环节有时失败，核对其他案例。 | 仅说明 | 最近 40 次 Windows 预览快照：30 成功、8 失败、2 取消。样本非随机，失败包括真实测试/版本问题，不能全部算 flaky。[42943990568](https://github.com/Moyf/moys-asr-workflow/actions/runs/42943990568) 与 [42943966578](https://github.com/Moyf/moys-asr-workflow/actions/runs/42943966578) 为 Windows 路径别名相关断言，当前已有 OCR 路径回归修复记录；[42964557782](https://github.com/Moyf/moys-asr-workflow/actions/runs/42964557782) 为 Launcher 版本不一致；[42826159992](https://github.com/Moyf/moys-asr-workflow/actions/runs/42826159992) 为 pnpm 最低发布年龄策略拒绝新依赖；[42974412606](https://github.com/Moyf/moys-asr-workflow/actions/runs/42974412606) 为英文页面检查发现“重新连接”，需专项核实是否测试时序或真实漏翻译；Ubuntu [43059193404](https://github.com/Moyf/moys-asr-workflow/actions/runs/43059193404) 为 apt DNS 故障，当前 workflow 已有 Playwright 安装重试。上述记录不证明当前版本仍有相同问题。 |
| 4 | 修复隔离后本地全量测试的新失败。 | 仅说明 | 3142 项中 `test_gap_removed_media_jobs.MediaJobsHttpTests.test_failed_job_diagnostics_are_logged_and_redacted` 读取到空日志，原 MOSS 失败未复现。`maw/media_jobs.py` 先暴露 failed 状态，再在锁外写诊断，测试只等待 failed 就读日志；受控探针证实状态可见时写入尚未完成。该用例单跑通过；此次未获授权修改其他测试或日志契约，建议另行修复等待条件并重新全量验证。 |

## 阶段汇总

- 已核对 CI 的完整 Python 测试日志：3141 项测试中 1 项 error、22 项 skipped；报错是连接中止，并非摘要中的字体错误。
- 本地执行 `uv run --no-sync python scripts/run_check.py --timeout 180 -- uv run --no-sync python scripts/run_tests.py tests.test_thumbnail_server.ThumbnailServerTests.test_token_host_origin_paths_and_bounds`，1 项通过；结果见 `.artifacts/checks/20261112T125126Z-870f1f76/result.json`。本地单次通过不能替代 CI 复验。
- 前一版本的同分支 Windows 预览成功；这支持偶发问题的可能性，但不是根因证明。尚未重跑 CI、未改代码；建议先重跑失败任务，若再次失败则专项调查 HTTP 连接关闭与请求体处理。
- 续 1：已提交规范变更 `fd37811a` 并合并 `origin/main` 的 `34107516`，调查基线为本地合并提交 `961e5949`；未推送。`scripts/check_docs.py` 通过，含日志未索引警告；`git diff --check` 通过。
- 同步后 Windows 定向重复测试 50/50 通过（`.artifacts/checks/20261112T125652Z-1d76db98/result.json`）。首次重复脚本因导入路径错误未运行测试，修正后运行；该脚本和报告均留 `.artifacts/`。
- 同步后全量执行 `uv run --no-sync python scripts/run_check.py --timeout 600 -- uv run --no-sync python scripts/run_tests.py --report .artifacts/actions-investigation-python.json`：3141 执行、1 failure、26 skipped，失败为 MOSS 默认路径而非缩略图，记录 `.artifacts/checks/20261112T125830Z-b84cfdb3/result.json`。单项通过 `.artifacts/checks/20261112T130349Z-5da9607c/result.json`；模拟覆盖变量触发该项失败的负对照 `.artifacts/checks/20261112T130535Z-332bbdc5/result.json`；`test_gui_web.py` 与 `test_moss_runtime.py` 共 360 项通过（1 skip），不足以证明完整套件中污染源。未读取或记录个人配置内容。
- 近期失败已分类；没有将全部失败认定为网络或偶发问题。未修改测试 / 产品代码，未重跑远端 CI；进一步定位缩略图连接关闭和英文文案案例仍需独立复现。
- 续 2：规范提交与合并提交已按维护者确认推送 `origin/main`，远端基线为 `961e5949`；本任务继续保留未提交账本。用户要求修复测试隔离、专项复现缩略图连接中止。
- 缩略图原始 socket 探针（Windows、HTTP/1.1、`Connection: close`）：非法 Host、伪造超长且发送短 body、超长且发送完整 body 三组各 200 次均获得预期 403/400 且无 socket 错误，结果 `.artifacts/checks/20261112T135713Z-2901d299/result.json`；未复现 CI 10053。
- keep-alive 独立探针发送非法 Host 请求及请求体，观察到 403 后服务器将未消费的请求体作为下一请求并输出解析错误，结果 `.artifacts/checks/20261112T135734Z-7ee7cc5a/result.json`。这是确定的协议边界问题，不得当作 CI 10053 的已证实根因，也不能根据本机 600 次成功推断 CI 稳定。
- 隔离修复后全量测试 3142 执行、1 failure、26 skipped；原 MOSS 默认路径失败未再出现，新失败为 media-job 日志空内容。完整结果 `.artifacts/checks/20261112T135840Z-c4c3f3cd/result.json`，不能报告全量通过。独立审查指出新增隔离回归复用的默认路径断言受 Windows 非 ASCII 路径 fallback 影响，需要在此测试中隔离路径转换策略。
- 日志用例单跑 1 项通过（`.artifacts/checks/20261112T140519Z-a095ec7d/result.json`）；受控延迟日志写入时，任务已可见 `failed` 且日志尚未写完，复现潜在竞态（`.artifacts/checks/20261112T140551Z-bfc4bfed/result.json`）。此 probe 验证时序窗口，不能代替原用例失败时的线程现场。
- 续 3：测试隔离修复并经独立审查；按 finding 1 在默认路径测试中隔离 ASCII 转换，复审通过，见 `REVIEW_FINDINGS.md`。最终执行 `uv run --no-sync python scripts/run_check.py --timeout 180 -- uv run --no-sync python scripts/run_tests.py tests/test_launcher_batch.py tests/test_moss_runtime.py tests/test_runtime_pathwin.py`，80 执行、75 通过、5 skip：`.artifacts/checks/20261112T140713Z-bd12da7a/result.json`。该复审修改后未重跑全量；之前全量中条目 4 失败仍未解决。
