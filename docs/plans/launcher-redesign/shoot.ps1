$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$base = 'file:///' + ((Join-Path $dir 'prototype.html') -replace '\\', '/')
$shots = [ordered]@{
  '01-transcribe-empty-light'  = '?state=empty&collapsed=1&help=1'
  '02-transcribe-ready-dark'   = '?state=ready&theme=dark'
  '03-sheet-proofread-light'   = '?state=ready&sheet=proofread'
  '04-sheet-replace-dark'      = '?state=ready&sheet=replace&theme=dark'
  '05-running-light'           = '?state=running&collapsed=1'
  '06-done-dark'               = '?state=done&collapsed=1&theme=dark'
  '07-batch-light'             = '?page=batch'
  '08-toolbox-proofread-dark'  = '?page=toolbox&tool=proofread&theme=dark'
  '09-projects-light'          = '?page=projects'
  '10-settings-general-light'  = '?page=settings'
  '11-settings-llm-dark'       = '?page=settings&set=llm&theme=dark'
  '12-settings-runtime-light'  = '?page=settings&set=runtime'
  '13-prov-soniox-light'       = '?state=ready&prov=soniox'
  '14-prov-openai-dark'        = '?state=ready&prov=openai&theme=dark'
  '15-prov-local-light'        = '?state=ready&prov=local'
  '16-prov-tencent-light'      = '?state=ready&prov=tencent'
  '17-toolbox-translate-light' = '?page=toolbox&tool=translate'
}
# 截图默认写到仓库根 .artifacts（Git 忽略）；入库的 shots/*.webp 是挑选后的参考图
$out = Join-Path $dir '..\..\..\.artifacts\launcher-redesign\shots'
New-Item -ItemType Directory -Force -Path $out | Out-Null
foreach ($k in $shots.Keys) {
  $png = Join-Path $out "$k.png"
  $p = Start-Process -FilePath $edge -ArgumentList @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=940,960', "--screenshot=$png", "$base$($shots[$k])") -PassThru -WindowStyle Hidden
  $p.WaitForExit(20000) | Out-Null
  Write-Output "$k $(Test-Path $png)"
}
