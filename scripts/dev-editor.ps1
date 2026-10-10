param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ServerArguments
)

$ErrorActionPreference = "Stop"
$watcher = $null
Push-Location -LiteralPath (Join-Path $PSScriptRoot "..")
try {
    & node scripts/build-editor.mjs --write
    if ($LASTEXITCODE -ne 0) { throw "Editor build failed; check Node and run pnpm install first." }

    $watcher = Start-Process -FilePath node -ArgumentList "scripts/build-editor.mjs", "--watch" -NoNewWindow -PassThru
    if (-not $ServerArguments) { $ServerArguments = @("--blank") }
    Write-Host "JS watch enabled. Refresh the browser after edits; Ctrl+C stops the dev session."
    & uv run --no-sync python server-editor/serve.py @ServerArguments
    if ($LASTEXITCODE -ne 0) { throw "Editor server exited with code $LASTEXITCODE." }
} finally {
    if ($null -ne $watcher) {
        Stop-Process -Id $watcher.Id -ErrorAction SilentlyContinue
    }
    Pop-Location
}
