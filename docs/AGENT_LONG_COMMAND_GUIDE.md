# Agent 长命令防卡死指南（Windows / PowerShell 5.1）

> 适用场景：在本仓库（或同构环境）用 agent 工具链执行 Playwright、Python 全量
> 测试、codemod 等长命令。所有结论来自实际踩坑（2026-09，MAW 编辑器拆分期间），
> 根因与修复均可复现。

## 症状

- 命令"卡住"数分钟无输出，agent 或用户误判死循环后中止；
- 工具报 `Tool execution aborted`，但底层进程仍在跑；
- 之后**所有**命令越来越慢，直到连 `git status` 都卡。

## 已确认的根因（按危害排序）

1. **孤儿进程堆积（头号杀手）**。命令超时被中止后，playwright 的 node worker 与
   chromium 实例**不会随之退出**。实测一次排障后残留 50 个进程，CPU/内存被吃光，
   后续一切命令变慢直到"假死"。
2. **PS 5.1 管道全量缓冲**。`长命令 | Select-String ...`、`长命令 | Out-File`
   会在整个命令结束后才产生第一行输出——8 分钟的测试在 UI 上零输出，必然被
   误判为卡死。
3. **PS 5.1 对原生命令的 `2>$null` 重定向可能死锁**（stderr 管道缓冲问题），
   是否触发与输出量相关，属偶发。
4. **PS 重定向的编码陷阱**：`>` 与 `| Out-File` 默认写 **UTF-16LE**；
   `Set-Content -Encoding utf8` 写 **带 BOM 的 UTF-8 + CRLF**。前者让 node 读到
   乱码（静默产出空结果），后者违反仓库 LF/无 BOM 约定且能让 JSON.parse 失败。
5. **Windows 命令行长度上限**（约 32K）。把大段文本（如整个 JSON 报告）作为
   argv 传给 `node -e` 会直接报 `The filename or extension is too long`。
6. 本身就慢的命令：全量 Playwright（约 10 分钟）、`uv sync`、首次 npm install。

## 解决方案

### 1. 长任务 = 后台进程 + 轮询，绝不在前台等

```powershell
# 启动（立即返回）
$p = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npx playwright test --project=chromium --reporter=json > `"$env:TEMP\e2e-run.log`" 2>&1" -PassThru -WindowStyle Hidden
$p.Id | Set-Content "$env:TEMP\e2e-run.pid"

# 轮询（每 2-4 分钟一次，每次都是秒级命令）
$alive = [bool](Get-Process -Id (Get-Content "$env:TEMP\e2e-run.pid") -ErrorAction SilentlyContinue)
Get-Content "$env:TEMP\e2e-run.log" -Tail 1   # 看进度
```

本仓已封装：`scripts/refactor-tools/run-e2e-bg.ps1`（启动，用
`PLAYWRIGHT_JSON_OUTPUT_NAME` 让 playwright 直接写 JSON 文件，不经管道）与
`poll-e2e.ps1`（查状态/汇总）。**注意：poll 里给 node 传数据用文件路径，不要
把报告内容塞进 argv（会撞长度上限）。**

### 2. 每次超时/中止后，先清孤儿再继续

```powershell
Get-Process -Name node,chrome,chromium,msedge -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path -notlike '*Paseo*' -and $_.Path -notlike '*Program Files*' } |
  Stop-Process -Force
```

排除路径是为了保护 IDE 与系统浏览器。**养成固定动作：命令超时 → 杀孤儿 →
重跑**，否则会陷入"越跑越慢 → 更容易超时"的死循环。

### 3. 字节保真的文件写出

- 需要 node 消费的文件：让 node 自己写（`fs.writeFileSync`），或用 `cmd /c "... > file"`；
- 仓库源码（LF/无 BOM 敏感）：用编辑工具写；万一被 PS 污染，用 node 规范化：
  `s=s.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n')` 后回写；
- 校验方法：Python 侧 `open(path,'rb')` 检查 `\xef\xbb\xbf` 与 `\r\n`。

### 4. 判定"真卡"还是"在跑"

- 看日志文件是否仍在增长 / `Get-Process` 里对应 PID 是否存活；
- playwright 日志尾部形如 `[95/380]`，数字在涨就是活的；
- 给每条命令设显式 timeout（短命令 60s，测试类 5-10 分钟），超时后执行第 2 条。

### 5. 其他 PS 5.1 注意事项（同族问题）

- `git show ref:path` 的内容要用 `cmd /c "... > file"` 落盘；
- `node -e "..."` 内联脚本极易被引号转义毁掉——**超过 3 行的逻辑一律落盘成
  .mjs 再执行**；
- 多行 `@( ... )` 数组传参会丢参，改用单行或脚本文件。

## 一句话流程

> 超过 2 分钟的命令：后台启动 → 轮询日志 → 完成后读报告；任何一次超时/中止后：
> 先杀孤儿进程，再谈下一步。
