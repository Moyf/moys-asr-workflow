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
    # 生成托管 Runtime 的 frozen requirements txt（MAW.spec datas 条件追加打包）；
    # 主清单（local/ocr 走 uv export，moss 走 uv pip compile）与 CPU 变体
    # （从声明源剥离 GPU 参数后原生冻结）统一由 freezer 模块执行，与
    # build-appimage.sh / release.yml / 源码模式自动补齐完全同源。
    New-Item -ItemType Directory -Path 'build' -Force | Out-Null
    uv run python -m maw.runtimes.freezer freeze

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

    $BootstrapDirectory = Join-Path (Split-Path -Parent $ExePath) 'bootstrap'
    New-Item -ItemType Directory -Path $BootstrapDirectory -Force | Out-Null
    $EmbedZip = Join-Path $RepoRoot 'build' 'python-3.11.9-embed-amd64.zip'
    $GetPip = Join-Path $RepoRoot 'build' 'get-pip.py'
    foreach ($Asset in @($EmbedZip, $GetPip)) {
        if (-not (Test-Path -LiteralPath $Asset -PathType Leaf)) {
            throw "Missing bootstrap asset: $Asset"
        }
        Copy-Item -LiteralPath $Asset -Destination (Join-Path $BootstrapDirectory (Split-Path -Leaf $Asset)) -Force
    }

    Write-Host "Built $ExePath"
}
finally {
    Pop-Location
}
