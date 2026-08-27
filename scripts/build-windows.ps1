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
    uv run python scripts\prepare_runtime_bootstrap.py --platform windows-x86_64
    uv run python scripts\smoke_runtime_bootstrap.py --platform windows-x86_64
    # 生成托管 Runtime 的 frozen requirements txt（MAW.spec datas 条件追加打包）。
    New-Item -ItemType Directory -Path 'build' -Force | Out-Null
    uv export --frozen --extra local --no-dev --format requirements-txt -o build/requirements-local.txt
    uv export --frozen --extra ocr --no-dev --format requirements-txt -o build/requirements-ocr.txt
    # moss 依赖与 local（qwen-asr/Transformers 4.x）互斥，独立声明、独立冻结。
    uv pip compile moss-requirements.in -p 3.11 --extra-index-url https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match -o build/requirements-moss.txt
    # 生成 CPU 版清单（去除 +cuXXX），供无 NVIDIA GPU 的机器首装时直接使用。
    uv run python scripts\freeze_cpu_requirements.py

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

    Write-Host "Built $ExePath"
}
finally {
    Pop-Location
}
