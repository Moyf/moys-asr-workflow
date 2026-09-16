# 后台启动 E2E：立即返回，避免前台长命令被超时中止后留下孤儿进程。
# 进度走 list reporter 输出到日志文件；结果走 JSON reporter 直接写文件
# （PLAYWRIGHT_JSON_OUTPUT_NAME），全程不经 PowerShell 管道缓冲。
# 配套轮询脚本：poll-e2e.ps1。
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $PlaywrightArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location -LiteralPath $repoRoot

$runRoot = Join-Path ([System.IO.Path]::GetTempPath()) "maw-e2e-bg"
$runDir = Join-Path $runRoot ("run-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$logPath = Join-Path $runDir "e2e-run.log"
$reportPath = Join-Path $runDir "e2e-report.json"

$env:PLAYWRIGHT_JSON_OUTPUT_NAME = $reportPath
$innerScript = Join-Path $repoRoot "scripts\run-e2e.ps1"
# 把内层命令写进 .cmd 文件再启动：直接拼进 cmd /c 时引号会被多层解析吃掉
# （实测 --grep "batch merge via C key" 被降级成 --grep batch）；文件内
# 逐参数加引号则行为确定。含空格的参数单独加引号，重定向放在 cmd 层——
# Start-Process -RedirectStandardOutput 会牵住调用方的输出句柄（agent 工具
# 里表现为「启动后不返回」），cmd 层 "> log 2>&1" 实测立即返回。
$quotedArgs = @('--reporter=list,json') + @($PlaywrightArguments) | ForEach-Object {
    $text = [string]$_
    if ($text -match '\s') { '"' + $text + '"' } else { $text }
}
$innerCmdPath = Join-Path $runDir "inner.cmd"
$innerLine = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $innerScript + '" ' `
    + ($quotedArgs -join ' ') + ' > "' + $logPath + '" 2>&1'
# ANSI 编码：cmd 按 ANSI 解析 .cmd 文件（本机 GBK），中文 grep 模式也能透传。
Set-Content -Encoding Default -LiteralPath $innerCmdPath -Value $innerLine
$process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$innerCmdPath`"" -PassThru -WindowStyle Hidden

[ordered]@{
    pid       = $process.Id
    runDir    = $runDir
    log       = $logPath
    report    = $reportPath
    startedAt = (Get-Date).ToString("s")
    arguments = (@($PlaywrightArguments) -join " ").Trim()
} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $runDir "meta.json")
Set-Content -Encoding utf8 (Join-Path $runRoot "latest.txt") -Value $runDir

Write-Output ("E2E 后台已启动 PID={0}" -f $process.Id)
Write-Output ("运行目录: {0}" -f $runDir)
Write-Output "查状态: scripts\refactor-tools\poll-e2e.ps1"
