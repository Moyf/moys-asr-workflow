# 查询后台 E2E（run-e2e-bg.ps1 启动）的状态并汇总结果。
# 每次调用都是秒级命令，适合每 2-4 分钟轮询一次；任何一次超时/中止后，
# 先清孤儿 node/chromium 进程再重跑（见 docs/AGENT_LONG_COMMAND_GUIDE.md）。
[CmdletBinding()]
param(
    # 缺省时读取 latest.txt 指向的最近一次运行目录。
    [string] $RunDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$runRoot = Join-Path ([System.IO.Path]::GetTempPath()) "maw-e2e-bg"
if (-not $RunDir) {
    $latest = Join-Path $runRoot "latest.txt"
    if (-not (Test-Path -LiteralPath $latest)) {
        throw "没有找到后台运行记录（$latest）。先用 run-e2e-bg.ps1 启动。"
    }
    $RunDir = (Get-Content -LiteralPath $latest -Raw).Trim()
}

$metaPath = Join-Path $RunDir "meta.json"
$logPath = Join-Path $RunDir "e2e-run.log"
$reportPath = Join-Path $RunDir "e2e-report.json"
if (-not (Test-Path -LiteralPath $metaPath)) {
    throw "运行目录缺少 meta.json：$RunDir"
}
$meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json

$alive = [bool](Get-Process -Id $meta.pid -ErrorAction SilentlyContinue)

if (Test-Path -LiteralPath $logPath) {
    Write-Output "--- 日志尾部 ---"
    Get-Content -LiteralPath $logPath -Tail 3 -ErrorAction SilentlyContinue | ForEach-Object { Write-Output $_ }
}

if ($alive) {
    Write-Output ("状态: 运行中 (PID {0})" -f $meta.pid)
    exit 0
}

Write-Output "状态: 已结束"
if (-not (Test-Path -LiteralPath $reportPath)) {
    Write-Output "未找到 JSON 报告，进程可能异常退出。完整日志: $logPath"
    exit 1
}
# 报告可能远超 PS 5.1 ConvertFrom-Json 的体积上限：交给 node 读文件路径汇总，
# 绝不把报告内容塞进 argv（会撞 32K 命令行长度上限）。
node (Join-Path $PSScriptRoot "summarize-e2e-report.mjs") $reportPath
exit $LASTEXITCODE
