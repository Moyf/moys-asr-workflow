param(
    [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SpecPath = Join-Path $RepoRoot 'MAW.spec'
$EntryPoint = Join-Path $RepoRoot 'maw_gui.py'
$ExePath = Join-Path $RepoRoot 'dist\MAW\MAW.exe'
$FaqSource = Join-Path $RepoRoot 'FAQ-常见问题.txt'
$FaqBundlePath = Join-Path $RepoRoot 'dist\MAW\FAQ-常见问题.txt'

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

    # PyInstaller 6 places datas under _internal in an onedir bundle. Keep the
    # user-facing FAQ beside MAW.exe as well, so it is easy to find in the ZIP.
    Copy-Item -LiteralPath $FaqSource -Destination $FaqBundlePath -Force
    if (-not (Test-Path -LiteralPath $FaqBundlePath -PathType Leaf)) {
        throw "Build completed but did not copy FAQ-常见问题.txt beside MAW.exe."
    }

    $UvCommand = Get-Command uv -ErrorAction Stop
    $BootstrapDirectory = Join-Path (Split-Path -Parent $ExePath) 'bootstrap'
    New-Item -ItemType Directory -Path $BootstrapDirectory -Force | Out-Null
    Copy-Item -LiteralPath $UvCommand.Source -Destination (Join-Path $BootstrapDirectory 'uv.exe') -Force

    Write-Host "Built $ExePath"
}
finally {
    Pop-Location
}
