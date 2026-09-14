# 后台跑 Playwright：立即返回，输出与 JSON 报告落 %TEMP%，之后用 poll-e2e.ps1 轮询。
# 用法: .\run-e2e-bg.ps1 [-TestPathFilter "cue-scroll-stability"] [-Tag "merge3"]
param(
  [string]$TestPathFilter = "",
  [string]$Tag = "run"
)
$report = Join-Path $env:TEMP "e2e-$Tag.json"
$log = Join-Path $env:TEMP "e2e-$Tag.log"
$pidFile = Join-Path $env:TEMP "e2e-$Tag.pid"
Remove-Item $report, $log, $pidFile -ErrorAction SilentlyContinue
$env:PLAYWRIGHT_JSON_OUTPUT_NAME = $report
$filter = if ($TestPathFilter) { "npx playwright test $TestPathFilter --project=chromium --reporter=json" } else { "npx playwright test --project=chromium --reporter=json" }
$env:PLAYWRIGHT_JSON_OUTPUT_NAME = $report
$p = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "$filter > `"$log`" 2>&1" -PassThru -WindowStyle Hidden
$p.Id | Set-Content $pidFile
Write-Output "后台启动 PID=$($p.Id) 报告=$report 日志=$log"
