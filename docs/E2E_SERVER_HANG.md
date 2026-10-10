# 长命令与进程管理

适用于 Agent 执行 Python、Playwright、构建任务和本地服务。此页是现行操作规则；事故经过仅在 `docs/_archied/incidents/` 按需追溯。

## 执行前

- 环境由开发者准备；Agent 使用 `uv run --no-sync`，或明确指定已安装的解释器。缺依赖要记录，不把同步环境混入验证命令。
- 新 worktree 可明确复用主仓库 Python 环境；E2E 用 `MAW_E2E_PYTHON` 指定解释器。Node 测试所需 acorn / Playwright 必须实际可用，跳过不算通过。
- 优先验证受影响范围。长任务设置明确期限：单 E2E spec 最多 10 分钟、全量 Chromium 最多 15 分钟；Python / 构建按范围设置足够期限。命令工具单次等待上限不等于整个任务期限。
- 有会话式任务工具时启动后分次读取进度；否则使用独立终端或可追踪的后台任务，不要求所有长命令一律后台化。记录 worktree、启动时间、PID、日志和最终退出码。

## 输出与后台服务

- 测试日志写文件，读取退出码、失败名称、首个错误与必要尾部；不要向上下文倾倒整页 HTML 或全部断言内容。页面断言使用 `tests/compact_assertions.py` 的压缩断言。
- 日志增长和 PID 存活只能说明任务可能在运行，不能证明成功。停止输出也不等于死锁；结合期限、日志和进程状态判断。
- 常驻服务优先在可独立关闭的终端启动（环境提供 paseo 时使用其独立终端），仅监听 `127.0.0.1`，用完关闭。不要用 shell 后台 `&` / `nohup` 留下继承会话管道的服务。
- Windows 确需 `Start-Process` 时用 `-WindowStyle Hidden`，不用 `-NoNewWindow`；避免子进程继承工具管道。隐藏窗口本身不能保证管道已断开，需核对启动是否返回、日志是否落盘。
- 已有 `scripts/refactor-tools/run-e2e-bg.ps1` / `poll-e2e.ps1` 可用于 E2E；记录启动时返回的运行目录，查询时显式传 `-RunDir`，不要依赖多 worktree 共享的 latest 指针。脚本不替代总超时与残留清理。
- Windows PowerShell 5.1 的重定向 / 编码与新版本不同；不要假定管道实时输出。复杂引号或超过几行的逻辑写脚本文件；仓库文本用显式 UTF-8（无 BOM）与 LF，JSON 不经命令行传入大段正文。

## 中断、失败与清理

E2E 的 Server 在中断时可能无法执行 teardown；进程持有管道或端口，会使后续命令等待。正常测试完成后也需确认本次服务已退出。

1. 先读本次日志，确认测试是否仍在有效运行；连续两次失败先分析，不循环全量重跑。
2. 优先通过本次终端 / 任务句柄停止任务，并检查其已记录的子进程。
3. 必须手动诊断时，在本次 worktree 根目录运行以下**只读**查询：

```powershell
$taskRoot = (Get-Location).ProviderPath.TrimEnd('\') + '\'
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and
    $_.CommandLine.IndexOf($taskRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
} | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine
```

4. 路径匹配只是候选列表。结合启动时间、完整命令行、fixture 路径和父子关系，确认具体 PID 属于本次任务；先正常退出，必要时才对逐个确认的 PID 执行 `Stop-Process -Id <已核实的PID>`。执行前重新核对，防止 PID 已被复用。
5. 命令行没有绝对 worktree 路径时，查启动记录与父子关系，不扩大为进程名匹配。禁止按 node / chrome / python 名称批量终止，也不能仅靠排除 Program Files 或 IDE 路径判断归属。
6. 确认目标端口与本次残留已释放后才重跑。不要关闭其他 worktree、Agent 守护进程或用户浏览器。

## 验证边界与后续

语法 / 单测不能代替拖动、播放、Seek 和布局验收。涉及交互时应做相关浏览器检查；工具反复失败则如实记为未验证并交付人工验收，不宣称通过，也不无限重试。

cue-scroll fixture 生命周期的历史缺口见 [未完成事项](OPEN_ITEMS.md#测试与运行环境)。这次整理只统一文档规则，未执行进程清理，也未证明生命周期问题已修复。
