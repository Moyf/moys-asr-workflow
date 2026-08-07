param(
    [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SpecPath = Join-Path $RepoRoot 'MAW.spec'
$EntryPoint = Join-Path $RepoRoot 'maw_gui.py'
$ExePath = Join-Path $RepoRoot 'dist\MAW\MAW.exe'
$MoseRoot = Join-Path $RepoRoot 'desktop'
$MoseExePath = Join-Path $RepoRoot 'desktop\src-tauri\target\release\mose.exe'
$MoseBundlePath = Join-Path $RepoRoot 'dist\MAW\MOSE.exe'

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

    Push-Location -LiteralPath $MoseRoot
    try {
        npm ci
        # Tauri validates frontendDist before it invokes Cargo's build script.
        # Run the build script once up front so desktop\src\index.html exists.
        cargo check --manifest-path (Join-Path $MoseRoot 'src-tauri\Cargo.toml')
        npm run tauri -- build
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath $MoseExePath -PathType Leaf)) {
        throw "MOSE build completed but did not create desktop\src-tauri\target\release\mose.exe."
    }
    Copy-Item -LiteralPath $MoseExePath -Destination $MoseBundlePath -Force

    Write-Host "Built $ExePath"
    Write-Host "Bundled $MoseBundlePath"
}
finally {
    Pop-Location
}
