# E2E 残留服务进程与长命令挂起

Playwright 超时、Ctrl+C 或测试进程异常退出后，`serve.py` 或包装进程可能仍占用端口或输出管道。下一次运行前围绕本次证据排查。执行入口和日志位置见[有界输出与分层调试](DEBUG_WORKFLOW.md)。

## 运行与失败分诊

- 优先运行受影响的 spec，必要时用 `-g` 缩小范围。以显式超时保护本次命令，单个 spec 最多 10 分钟，完整 Chromium 最多 15 分钟。连续两轮同类失败先核对前置条件、日志和 trace。
- 并行会话的服务各用临时端口。CPU 竞争可能增加耗时，单凭变慢不足以判定回归。看见其他会话的进程时继续验证自己的范围。
- 2.0dev 的完整检查使用手动巡检入口，发布前按发布范围执行。浏览器自动化反复挂起时记录未测范围，交接受影响交互的人工验收。 [日常准入与手动辅助检查](DEVELOPMENT.md#日常变更准入与手动辅助检查20dev)

## 残留进程清理

1. 查本次 `result.json`、fixture 的服务输出和端口，确认退出、超时及运行器清理结果。还在运行的服务优先通过原终端或 fixture 正常停止。
2. 对残留进程，以本次记录的 PID、启动时间、父子关系和命令行中的工作树及 fixture 路径核对归属。Windows 可用 `Get-CimInstance Win32_Process` 查看。提权进程的 `CommandLine` 可能为空，归属不明时保留并报告。
3. 只终止明确属于本次运行的残留进程，再核对本次监听端口和输出管道已释放。进程名、端口或工作树路径本身都无法区分同机并行任务。

## 服务生命周期契约

通用 helpers 和 cue-scroll fixture 共用 `tests/e2e/server-process.mjs`。Windows 使用独立 Job，POSIX 使用独立进程组。包装进程先退出时仍须回收服务后代，正常停止须等待管道关闭。Windows supervisor 的 stdin 是 owner 生命周期信号，须保持管道。实际由外部启动或已脱离进程组的服务需另行核实归属。

修改进程层时先跑合成回归，再按影响验证真实 Server 的启动、停止与端口回收。合成回归同时确认旁观进程不受影响。受限沙箱若禁止终止进程或使用 Job，按环境阻塞记录。

```powershell
python scripts/run_check.py --timeout 60 -- node --test tests/test_e2e_output_tail.mjs tests/test_e2e_server_lifecycle.mjs
```

实际启动可用仓库已有的 `MAW_E2E_PYTHON` 指向已准备解释器。遇到真实浏览器挂起时，附本次工作树、阶段、端口和有界日志摘要。

## 历史记录

早期 Windows SIGTERM、控制台继承和并行工作树案例保留在[原排障记录](https://github.com/Moyf/moys-asr-workflow/blob/6589c283770d24f593fd66c4801d2f2c41db084f/docs/engineering/E2E_SERVER_HANG.md)。 [服务生命周期首次复现与验证边界](https://github.com/Moyf/moys-asr-workflow/blob/6589c283770d24f593fd66c4801d2f2c41db084f/docs/engineering/E2E_PROCESS_LIFECYCLE.md)
