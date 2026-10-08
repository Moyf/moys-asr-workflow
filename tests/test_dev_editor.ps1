# Runnable lifecycle check without Node, uv, a browser, or Pester.
$ErrorActionPreference = "Stop"
$devScript = Join-Path $PSScriptRoot "../scripts/dev-editor.ps1"
$originalLocation = (Get-Location).Path
$global:BuildExit = 0
$global:ServerExit = 0
$global:WatchStarted = $false
$global:WatchStopped = $false
$global:ServerCall = @()

function node {
    if (($args -join "|") -ne "scripts/build-editor.mjs|--write") { throw "Unexpected build command" }
    $global:LASTEXITCODE = $global:BuildExit
}
function Start-Process {
    param($FilePath, $ArgumentList, [switch]$NoNewWindow, [switch]$PassThru)
    if ($FilePath -ne "node" -or ($ArgumentList -join "|") -ne "scripts/build-editor.mjs|--watch") { throw "Unexpected watcher" }
    $global:WatchStarted = $true
    return [pscustomobject]@{ Id = 12345 }
}
function uv {
    $global:ServerCall = @($args)
    $global:LASTEXITCODE = $global:ServerExit
}
function Stop-Process {
    param($Id, $ErrorAction)
    if ($Id -ne 12345) { throw "Stopped an unrelated process" }
    $global:WatchStopped = $true
}

& $devScript
if (($global:ServerCall -join "|") -ne "run|--no-sync|python|server-editor/serve.py|--blank") { throw "Wrong default server arguments" }
if (-not $global:WatchStarted -or -not $global:WatchStopped) { throw "Watcher was not started/cleaned up" }

& $devScript "project with spaces.mosp" --port 8251 --no-open
if (($global:ServerCall -join "|") -ne "run|--no-sync|python|server-editor/serve.py|project with spaces.mosp|--port|8251|--no-open") { throw "Server arguments were not forwarded" }

$global:WatchStopped = $false
$global:ServerExit = 7
try { & $devScript; throw "Server failure was ignored" } catch {
    if ($_.Exception.Message -notlike "Editor server exited*") { throw }
}
if (-not $global:WatchStopped) { throw "Server failure leaked its watcher" }

$global:WatchStarted = $false
$global:ServerCall = @()
$global:BuildExit = 7
try { & $devScript; throw "Build failure was ignored" } catch {
    if ($_.Exception.Message -notlike "Editor build failed*") { throw }
}
if ($global:WatchStarted -or $global:ServerCall.Count) { throw "Failed build started a child" }
if ((Get-Location).Path -ne $originalLocation) { throw "Working directory was not restored" }
Write-Host "dev-editor lifecycle checks passed"
