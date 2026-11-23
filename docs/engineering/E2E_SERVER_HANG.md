# E2E 残留服务进程与长命令挂起：排查与预防

适用范围：MAW 仓库的 Playwright e2e（`tests/e2e/`，`pnpm test`）。事件记录见文末。

## 症状

- 一条 shell 命令长时间显示「运行中」（分钟级到小时级），无新输出、无报错。
- 常见触发：`pnpm test` 全量跑、`Start-Process` 后台启动长任务。
- e2e 反复中断后重跑，可能出现端口被占、测试变慢或假失败。

## 根因（本仓库实测三类）

### 1. e2e 残留的 serve.py 进程（主因）

`tests/e2e/helpers.mjs` 的 `startServer`（以及 `cue-scroll-fixture.mjs` 的共享
fixture）会为每个 spec 文件启动真实的 `server-editor/serve.py`。正常结束由
`afterAll` 收尾；但**运行被中断（Ctrl+C / agent 会话被 abort / 崩溃）时
afterAll 不会执行**，serve.py 以父子两个 python 进程的形式残留。已知注意点：

- cue-scroll 的共享 fixture server 在**正常跑完的全量 run 后也可能残留**
  （2026-10-08 实测：486 项全过后仍残留 12 个 python 进程）。
- 残留进程持有 stdout 管道与端口：shell 工具等待管道关闭 → 命令「永不结束」；
  端口被占则后续 e2e 行为异常。

### 2. Windows 上 SIGTERM 杀不掉 serve.py 的真实进程（2026-10-08 修复，现行契约见下文）

本地 e2e 经 `uv run python` 启动 serve.py，进程链是
`uv.exe → .venv\Scripts\python.exe（转发器）→ uv cpython\python.exe（真身）`。
Node 的 `child.kill('SIGTERM')` 在 Windows 上只终止直接子进程（转发器），
真身被**重新父化**后继续存活——cue-scroll fixture 旧实现每个用例泄漏一组，
正常结束也无法幸免。2026-10-08 已修复：fixture 的 `stop()` 与 exit 钩子改用
`taskkill /F /T /PID` 进程树终止（`helpers.mjs` 的
`terminateProcessTreeSync`，已导出复用）。验证：单个 fixture 启停后残留 0。
遗留边界：若整个测试进程被 `taskkill`（不带 /T）或断电级强杀，任何钩子都
不会执行，残留仍会发生——只能事后清理。现行实现已改用 Job Object / 独立进程组
统一管理所有权，`taskkill` 只作为其中一条回收路径，见下文「进程所有权与回收契约」。

### 3. `Start-Process -NoNewWindow` 占住控制台（显示层假象）

用 `Start-Process -NoNewWindow` 把长任务挂后台时，子进程继承当前控制台，
shell 工具的终端在子进程退出前持续显示「运行中」。任务本身秒回、结果正常，
纯属显示层占位。**后台化一律用 `-WindowStyle Hidden`**（新进程组，不占当前
控制台），不要用 `-NoNewWindow`。

补充：即使命令的 timeout 到点触发，被终止的也只是 shell 与主进程——上面
两类残留后代仍占着终端/管道，表现为「限时不管用」。所以关键是**不让残留
发生**（根因 1/2）与**后台化规范**（根因 3），而不是依赖超时兜底。

## 进程所有权与回收契约

`tests/e2e/helpers.mjs` 与 `cue-scroll-fixture.mjs` 共用 `server-process.mjs`，只管理本次启动的服务；不按进程名、浏览器名或模糊路径扫描清理。

- **Windows**：独立 PowerShell supervisor 加入未命名 Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，不开放 breakaway，不向子进程继承 Job handle）。包装进程提前退出、supervisor 被结束或其所有者关闭 stdin 时，内核回收该 Job 的成员；Job 设置失败会阻止服务启动。记录的是 supervisor PID。
- **POSIX**：服务启动为独立进程组；正常停止、包装进程退出和可处理的退出路径向整组发送 `SIGKILL`，与当前测试 runner、其他工作树隔离。
- **停止语义**：`stop()` 可重复、可并发调用；等待 `close`（含输出管道），5 秒内未关闭则拒绝，不把超时当作成功，注册项在 close 前保留。启动期每次 HTTP 请求的连接与响应正文都限时，初始化期间也检测进程退出。
- **验证入口**：`node --test tests/test_e2e_server_process.mjs tests/test_e2e_process_lifecycle.mjs` 跑标准库合成矩阵（约 2 分钟，需 Node 与 Python 3，`MAW_E2E_PYTHON` 可指定解释器）；真实服务冒烟用 `MAW_E2E_PYTHON=<已有 venv 的 python> node tests/e2e/server-lifecycle-smoke.mjs`（90 秒，不启动浏览器）。
- **边界**：可处理信号用 `process.emit` 走真实 JS handler，不等于验证原生 Ctrl+C / Ctrl+Break 投递；Windows `process.kill('SIGTERM')` 是强制终止，不能证明 SIGTERM handler 收到系统信号。被强杀的 runner、主动脱离组的后代、由外部服务或 WMI 创建的进程不在回收保证内；受限沙箱可能禁止 Job 或终止进程，不能把该环境的权限错误当本机复现结果。
- Windows Job 语义参考：[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。

## 诊断

```powershell
# 列出残留的 e2e serve.py（注意只认本仓库路径；其他 worktree / 不认识的 python 不要动）
Get-CimInstance Win32_Process -Filter "Name='python.exe'"
  | Where-Object { $_.CommandLine -match '<本仓库路径>.*playwright' }
  | Select-Object ProcessId, CommandLine
```

特征：CommandLine 指向 `output\playwright\<fixture>\synthetic.mosp` 且带
`--no-open --no-waveform --port <随机端口>`；每个 fixture 一对父子进程。

## 清理

```powershell
Get-CimInstance Win32_Process -Filter "Name='python.exe'"
  | Where-Object { $_.CommandLine -match 'curly-camel.*playwright' }
  | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

只按「本仓库路径 + playwright fixture」过滤。禁止按进程名批量杀
node.exe / chrome.exe / python.exe——会误杀 agent 守护进程、其他 worktree
任务和用户自己的浏览器。

## 预防（agent / 开发者运行纪律）

1. **长命令必须显式限时**：Chromium e2e 耗时随集合、分片、环境而变；本地全量 ≤ 15 分钟，单 spec ≤ 10 分钟。
   超时先按上面流程清残留，不要原地重试。
2. **优先跑受影响的 spec**，完整集合留给每周/手动辅助巡检、维护者明确要求或发布验收，不默认每个 PR 都执行；连续两轮同类失败
   时先停下分析，不要循环重跑。
3. **e2e 中断或失败后，重跑前先查残留进程**（诊断命令），清干净再跑。
4. 后台任务一律 `Start-Process -WindowStyle Hidden`，不用 `-NoNewWindow`；
   输出重定向到文件，事后查文件而不是等管道。
5. 纯逻辑改动优先用单测与语法检查；交互和布局改动按根 [AGENTS 的浏览器验证](../../AGENTS.md#浏览器验证)执行。
   环境受限或反复卡住时，标为「未验证」，说明原因并给出人工复核的操作和预期。
6. cue-scroll fixture 与 helpers 共用进程所有权管理：Windows 使用独立 Job，
   POSIX 使用独立进程组；停止等待管道关闭并显式报告超时。它也覆盖包装进程
   先退出的情况，见上文「进程所有权与回收契约」。

## 多 agent 并行运行（2026-10-15 起成为常态）

同一仓库的多个 agent 会在各自的 worktree 同时跑 e2e（本机已实测出现：一个
paseo worktree 会话在跑全量 playwright + serve.py 时，另一个会话同时验证）。

- **端口不会冲突**：helpers 为每个 fixture 找 127.0.0.1 上的临时空闲端口
  （`createServer` 探测，无硬编码），并行运行互不抢占。真正的代价是 CPU
  竞争拖慢用例——60 条 spec 平时 3.7 分钟，竞争下可能明显更久。
- **清理必须先核对归属**：诊断与清理命令按「本 worktree 路径 + playwright」
  过滤 CommandLine；直接按进程名、端口或「看起来像 serve.py」清理会误杀
  并行 agent 的进程树，让对方误判为残留泄漏。
- **遇到其他 worktree 的进程：不杀、不等、不慌**。缩小自己的运行范围
  （单 spec + `-g` 过滤）、给 run_check/命令超时留富余；不要把「比平时慢」
  或一次偶发超时当成回归去循环重跑。
- 自身的进程树交给 run_check 超时回收即可（它会按 PID 杀整棵树）；手工
  Start-Process 启动的服务用完必须自己收尾。

## 事件记录

- 2026-10-15，#240 合并后验证轮：本会话全量 e2e 被 run_check 超时回收后，发现
  另一 agent worktree 正在并行跑全量 e2e（含 serve.py 父子进程）。按 CommandLine
  核对归属确认非本会话残留，未动外部进程；随后单 spec 重跑（`-g` 过滤）3.7 分钟
  正常完成。期间确认 helpers 的临时端口机制让两边互不干扰，CPU 竞争只影响耗时。

- 2026-10-08，PR #180 修复轮：全量 e2e 被中断后残留 12 个 serve.py（6 组），
  一条后台命令在 UI 上显示运行 10 小时+；按上述流程清理后重跑正常。同日第二
  次全量（正常跑完 486/486，6.5 分钟）后再次残留 12 个进程，确认「正常结束
  也会泄漏」，清理命令有效。
- 2026-10-08，根因 #2 定位与修复：cue-scroll fixture 的 `SIGTERM` 只杀
  uv→venv 转发器、serve.py 真身重新父化存活；改为 `taskkill /F /T` 树杀后
  单 fixture 启停残留归零。同日另发现「改了 web/ 源码但页面无变化」——根因
  是编辑器页面加载 esbuild 产物 `editor-bundle.js`，需先
  `node scripts/build-editor.mjs --write`（已写入 AGENTS.md）。
