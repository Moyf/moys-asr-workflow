# E2E 残留服务进程与长命令挂起：排查与预防

适用范围：MAW 仓库的 Playwright e2e（`tests/e2e/`，`npm test`）。事件记录见文末。

## 症状

- 一条 shell 命令长时间显示「运行中」（分钟级到小时级），无新输出、无报错。
- 常见触发：`npx playwright test` 全量跑、`Start-Process` 后台启动长任务。
- e2e 反复中断后重跑，可能出现端口被占、测试变慢或假失败。

## 根因（本仓库实测两类）

### 1. e2e 残留的 serve.py 进程（主因）

`tests/e2e/helpers.mjs` 的 `startServer`（以及 `cue-scroll-fixture.mjs` 的共享
fixture）会为每个 spec 文件启动真实的 `server-editor/serve.py`。正常结束由
`afterAll` 收尾；但**运行被中断（Ctrl+C / agent 会话被 abort / 崩溃）时
afterAll 不会执行**，serve.py 以父子两个 python 进程的形式残留。已知注意点：

- cue-scroll 的共享 fixture server 在**正常跑完的全量 run 后也可能残留**
  （2026-10-08 实测：486 项全过后仍残留 12 个 python 进程）。
- 残留进程持有 stdout 管道与端口：shell 工具等待管道关闭 → 命令「永不结束」；
  端口被占则后续 e2e 行为异常。

### 2. `Start-Process -NoNewWindow` 占住控制台（显示层假象）

用 `Start-Process -NoNewWindow` 把长任务挂后台时，子进程继承当前控制台，
shell 工具的终端在子进程退出前持续显示「运行中」。任务本身秒回、结果正常，
纯属显示层占位。**后台化一律用 `-WindowStyle Hidden`**（新进程组，不占当前
控制台），不要用 `-NoNewWindow`。

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

1. **长命令必须显式限时**：全量 chromium e2e 正常耗时 6–7 分钟，timeout
   设 15 分钟封顶；单 spec ≤ 10 分钟。超时先按上面流程清残留，不要原地重试。
2. **优先跑受影响的 spec**，全量留给 CI 或发布前一次性跑；连续两轮全量不过
   时先停下分析，不要循环重跑。
3. **e2e 中断或失败后，重跑前先查残留进程**（诊断命令），清干净再跑。
4. 后台任务一律 `Start-Process -WindowStyle Hidden`，不用 `-NoNewWindow`；
   输出重定向到文件，事后查文件而不是等管道。
5. UI/浏览器验证是可选项：逻辑验证优先单测与语法检查；浏览器验证反复卡住时
   降级为「交付人工验收」，不要阻塞整个流程。
6. 治本方向（待办）：修复 cue-scroll 共享 fixture 的 server 生命周期，使
   afterAll / 进程退出时可靠回收 serve.py。

## 事件记录

- 2026-10-08，PR #180 修复轮：全量 e2e 被中断后残留 12 个 serve.py（6 组），
  一条后台命令在 UI 上显示运行 10 小时+；按上述流程清理后重跑正常。同日第二
  次全量（正常跑完 486/486，6.5 分钟）后再次残留 12 个进程，确认「正常结束
  也会泄漏」，清理命令有效。
