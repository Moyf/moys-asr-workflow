# E2E 服务进程生命周期

`tests/e2e/helpers.mjs` 与 `cue-scroll-fixture.mjs` 共用
`server-process.mjs`。只管理本次启动的服务；不按进程名、浏览器名或模糊路径扫描清理。

## 复现与修复

2026-10-10，在 `3a10baf1` 上使用独立临时目录中的合成 Python 包装进程，
由它启动监听 `127.0.0.1` 的后代服务。原 scroll fixture 的 `stop()` 返回后，
包装进程结束而后代仍存活；回归按记录的两个 PID 核验，测试兜底随后清理。
这是当前代码的合成复现，不把旧事故日志当作本次真实浏览器运行的证据。

旧 scroll fixture 只调用直接子进程的 `kill()`；通用 helper 在包装进程退出后
删除 PID，POSIX 路径也只杀直接子进程。只等待父进程 `exit` 或超时后 resolve
不能证明后代、继承的输出管道和监听端口都已经回收。

- Windows：先让独立 PowerShell supervisor 加入未命名 Job Object，再启动指定
  uv / Python / 程序命令。Job 使用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，
  不开放 breakaway，也不向子进程继承 Job handle。包装进程提前退出、supervisor
  被结束或其所有者关闭 stdin 时，内核回收该 Job 的成员。Job 设置失败会阻止服务启动。
  `proc.pid` / scroll `runtime.json` 的 `pid` 因此是 supervisor PID。
- POSIX：服务启动为独立进程组；正常停止、包装进程退出和可处理的退出路径向
  整个组发送 SIGKILL。进程组与当前测试 runner、其他工作树分开。
- `stop()` 可重复和并发调用，等待 `close`（包括输出管道），5 秒内未关闭则拒绝，
  不将超时当作成功。注册项在 close 前保留。
- 每次启动 HTTP 请求的连接和响应正文都限时；原来的总启动期限仍保留。
  通用 helper 在项目初始化期间也检测进程退出，避免等到整段期限结束。

Windows Job 语义参考：[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。
实现依赖 Windows PowerShell、Add-Type 和支持嵌套 Job 的现代 Windows。
受限沙箱可能禁止终止进程或使用 Job；不能把该环境的权限错误当作本机复现结果。

## 验证命令

标准库合成矩阵无需 Playwright 和应用 Python 依赖；需要 Node 和 Python 3。
`MAW_E2E_PYTHON` 可指向已有解释器，未设置时回归使用 PATH 中的 `python`。

```powershell
node --test tests/test_e2e_server_process.mjs tests/test_e2e_process_lifecycle.mjs
```

矩阵有意经过 45 秒 / 30 秒启动超时，总计约 2 分钟。每个驱动有独立限时，
合成后代另有 60 秒兜底。覆盖两套 fixture 的正常/重复/并发停止、启动报错、
包装进程先退出、缺失命令、连接后不响应、正常 exit、未捕获异常及信号处理分支。
每项分别检查记录的服务后代不再运行、端口可重新绑定、调用及时返回，
同时验证另一个不相关的 HTTP 进程仍可响应。另测参数中的空格、Unicode、引号、
空串、反斜杠和 shell 字符，以及返回响应头后正文一直不结束的请求。

真实源码服务的可选冒烟：

```powershell
$env:MAW_E2E_PYTHON = '<已有项目 venv 的 Python 绝对路径>'
node tests/e2e/server-lifecycle-smoke.mjs
```

90 秒限时，启动真实空白编辑器和单条合成字幕工程，核验 ready、重复停止、端口回收。
不启动浏览器、不同步环境、不重生成 `blank-editor.html`；scroll 证据留在已有
`output/playwright/cue-scroll` 目录，标准库用例留在本次临时目录。

PR #198 集成此管理层，并增加 ASS 样例缩放与旋转的画布边界回归。
运行结果以 PR 核验记录为准，不提交机器相关运行产物。

## 验证边界

- 本次 Windows 实测覆盖 Job 清理，包括单独强制终止测试驱动后由 stdin EOF 触发
  supervisor 清理。可处理信号用 `process.emit` 走真实 JS handler；没有宣称验证过
  原生控制台 Ctrl+C / Ctrl+Break 事件投递。Windows `process.kill(SIGTERM)` 是强制
  终止，不能用来证明 SIGTERM handler 收到操作系统信号。
- POSIX 的正常进程组路径包含回归代码；本次机器未有可直接复用的 Linux Node，
  没有 Linux/macOS 实跑结果。POSIX 测试驱动使用真实 SIGTERM 测试可处理的外部中断。
  SIGKILL、机器崩溃等不能由被终止 runner 自己清理；主动脱离组的后代也超出保证。
  Linux 已退出但尚未由 PID 1 回收的僵尸不算运行中进程，仍独立检查监听端口。
- 本次 PR 集成验证包含真实源码浏览器 ASS 与滚动用例；未对发行版可执行文件做验收。
  uv / 指定 Python / 打包程序的命令选择保留，共用同一管理层；参数传递有独立回归。
  不宣称可以清理由外部服务、WMI 或其他非继承方式另行创建的进程。
