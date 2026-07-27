param(
    [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SpecPath = Join-Path $RepoRoot 'MAW.spec'
$EntryPoint = Join-Path $RepoRoot 'maw_gui.py'
$ExePath = Join-Path $RepoRoot 'dist\MAW\MAW.exe'

if (-not (Test-Path -LiteralPath $EntryPoint -PathType Leaf)) {
    throw "Missing GUI entry point: $EntryPoint. Add maw_gui.py before building MAW.exe."
}

Push-Location -LiteralPath $RepoRoot
try {
    uv sync --group build --frozen

    if (-not $SkipTests) {
        uv run python -m unittest tests.test_packaging_contract
    }

    uv run --group build pyinstaller --noconfirm --clean $SpecPath

    if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
        throw "PyInstaller completed but did not create dist\MAW\MAW.exe."
    }

    Write-Host "Built $ExePath"
}
finally {
    Pop-Location
}
