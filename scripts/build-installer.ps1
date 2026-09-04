[CmdletBinding()]
param(
    [string]$SourceDir = "build\release\mose\MAW",
    [string]$Version = "",
    [string]$OutputDir = "build\installer",
    [string]$IsccPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ResolvedSource = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $SourceDir))
$ResolvedOutput = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $OutputDir))
$IssPath = Join-Path $RepoRoot 'installer\maw.iss'

if (-not $Version) {
    $PyprojectPath = Join-Path $RepoRoot 'pyproject.toml'
    $VersionMatch = Select-String -LiteralPath $PyprojectPath -Pattern '^version = "([^"]+)"$' | Select-Object -First 1
    if (-not $VersionMatch) {
        throw "Unable to read project version from $PyprojectPath."
    }
    $Version = $VersionMatch.Matches[0].Groups[1].Value
}

# Release jobs pass the tag (for example v1.5.0); Inno Setup's AppVersion and
# output naming use the project version without the tag prefix.
$Version = $Version -replace '^v', ''

if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "Invalid MAW version: $Version"
}
if (-not (Test-Path -LiteralPath (Join-Path $ResolvedSource 'MAW.exe') -PathType Leaf)) {
    throw "Missing MAW.exe in $ResolvedSource. Stage the unified MAW + MOSE suite first."
}
if (-not (Test-Path -LiteralPath (Join-Path $ResolvedSource 'MOSE\MOSE.exe') -PathType Leaf)) {
    throw "Missing MOSE\MOSE.exe in $ResolvedSource. Stage the unified MAW + MOSE suite first."
}
foreach ($RelativePath in @('ffmpeg\bin\ffmpeg.exe', 'ffmpeg\bin\ffprobe.exe', '_internal\assets\maw.ico')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ResolvedSource $RelativePath) -PathType Leaf)) {
        throw "Missing standard bundle asset: $RelativePath"
    }
}
if (-not (Test-Path -LiteralPath $IssPath -PathType Leaf)) {
    throw "Missing Inno Setup definition: $IssPath"
}

if (-not $IsccPath) {
    $Candidates = @(
        (Get-Command ISCC.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    )
    $IsccPath = $Candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}
if (-not $IsccPath -or -not (Test-Path -LiteralPath $IsccPath -PathType Leaf)) {
    throw 'Inno Setup compiler ISCC.exe was not found. Install Inno Setup 6 or pass -IsccPath.'
}

New-Item -ItemType Directory -Path $ResolvedOutput -Force | Out-Null
$env:MAW_VERSION = $Version
$env:MAW_SOURCE_DIR = $ResolvedSource
Push-Location -LiteralPath $RepoRoot
try {
    & $IsccPath "/O$ResolvedOutput" $IssPath
    if ($LASTEXITCODE -ne 0) {
        throw "Inno Setup failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$Expected = Join-Path $ResolvedOutput "MAW-Setup-Windows-x64-v$Version.exe"
if (-not (Test-Path -LiteralPath $Expected -PathType Leaf)) {
    throw "Inno Setup completed but did not create $Expected."
}
Write-Host "Built $Expected"
