# 轮询后台 e2e：输出存活状态 / 完成后的 pass-fail 摘要与新增失败清单。
# 用法: .\poll-e2e.ps1 -Tag "merge3" [-Baseline]
param(
  [string]$Tag = "run",
  [switch]$Baseline
)
$report = Join-Path $env:TEMP "e2e-$Tag.json"
$log = Join-Path $env:TEMP "e2e-$Tag.log"
$pidFile = Join-Path $env:TEMP "e2e-$Tag.pid"
$procId = (Get-Content $pidFile -ErrorAction SilentlyContinue)
$alive = $false
if ($procId) { $alive = [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue) }
if ($alive) {
  $tail = (Get-Content $log -Tail 1 -ErrorAction SilentlyContinue)
  Write-Output "RUNNING pid=$procId 日志尾: $tail"
  exit 0
}
if (-not (Test-Path $report) -or (Get-Item $report).Length -lt 10) {
  Write-Output "已结束但报告缺失；日志尾部:"
  Get-Content $log -Tail 10 -ErrorAction SilentlyContinue
  exit 1
}
$jsonPath = $report
$summary = node -e "const r=require(process.argv[1]); const fails=[]; let total=0; for(const s of r.suites){const walk=(x)=>{if(!x)return; if(x.specs)for(const sp of x.specs){total++; if(sp.ok===false)fails.push(sp.title)} (x.suites||[]).forEach(walk)}; walk(s)}; let base=[]; if(process.argv[2]==='1'){const b=require(process.env.TEMP+'/baseline-e2e.json'); for(const s of b.suites){const walk=(x)=>{if(!x)return; if(x.specs)for(const sp of x.specs){if(sp.ok===false)base.push(sp.title)} (x.suites||[]).forEach(walk)}; walk(s)}}; const newF=fails.filter(f=>!base.includes(f)); console.log('总数 '+total+' 失败 '+fails.length+' 基线 '+base.length+' 新增 '+newF.length); newF.slice(0,20).forEach(f=>console.log(' - '+f)); if(newF.length>20)console.log(' ...共 '+newF.length)" $jsonPath $(if ($Baseline) { '1' } else { '0' }) 2>&1
Write-Output "完成。$summary"
