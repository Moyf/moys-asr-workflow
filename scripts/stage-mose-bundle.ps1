[CmdletBinding()]
param(
    [string]$MawSourceDir = "dist\MAW",
    [string]$MoseSourceDir = "desktop\dist\win-unpacked",
    [string]$OutputDir = "build\release\mose\MAW"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
function Resolve-RepoPath([string]$PathValue) {
    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return [System.IO.Path]::GetFullPath($PathValue)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $PathValue))
}

$ResolvedMawSource = Resolve-RepoPath $MawSourceDir
$ResolvedMoseSource = Resolve-RepoPath $MoseSourceDir
$ResolvedOutput = Resolve-RepoPath $OutputDir
$ResolvedMawOutput = $ResolvedOutput
$ResolvedMoseOutput = Join-Path $ResolvedOutput 'MOSE'

foreach ($Required in @(
    (Join-Path $ResolvedMawSource 'MAW.exe'),
    (Join-Path $ResolvedMawSource 'ffmpeg\bin\ffmpeg.exe'),
    (Join-Path $ResolvedMawSource 'ffmpeg\bin\ffprobe.exe'),
    (Join-Path $ResolvedMoseSource 'MOSE.exe'),
    (Join-Path $ResolvedMoseSource 'resources\app.asar')
)) {
    if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) {
        throw "Missing suite input: $Required"
    }
}

New-Item -ItemType Directory -Path $ResolvedMawOutput -Force | Out-Null
New-Item -ItemType Directory -Path $ResolvedMoseOutput -Force | Out-Null
# -Path is intentional: -LiteralPath treats the trailing * as a literal name
# and would leave the staged directory empty on Windows.
Copy-Item -Path (Join-Path $ResolvedMawSource '*') -Destination $ResolvedMawOutput -Recurse -Force
Copy-Item -Path (Join-Path $ResolvedMoseSource '*') -Destination $ResolvedMoseOutput -Recurse -Force

$SuiteRoot = Split-Path -Parent $ResolvedOutput
$MoseExe = Join-Path $ResolvedMoseOutput 'MOSE.exe'
$FfmpegFiles = @(Get-ChildItem -LiteralPath $SuiteRoot -Filter 'ffmpeg.exe' -File -Recurse)
$FfprobeFiles = @(Get-ChildItem -LiteralPath $SuiteRoot -Filter 'ffprobe.exe' -File -Recurse)
$MawExecutables = @(Get-ChildItem -LiteralPath $SuiteRoot -Filter 'MAW.exe' -File -Recurse)
if ($FfmpegFiles.Count -ne 1) {
    throw "MAW-MOSE suite must contain exactly one ffmpeg.exe; found $($FfmpegFiles.Count)."
}
if ($FfprobeFiles.Count -ne 1) {
    throw "MAW-MOSE suite must contain exactly one ffprobe.exe; found $($FfprobeFiles.Count)."
}
if ($MawExecutables.Count -ne 1) {
    throw "MAW-MOSE suite must contain exactly one MAW.exe; found $($MawExecutables.Count)."
}
foreach ($Name in @('ffmpeg.exe', 'ffprobe.exe', 'MAW.exe')) {
    $Duplicates = @(Get-ChildItem -LiteralPath $ResolvedMoseOutput -Filter $Name -File -Recurse)
    if ($Duplicates.Count -ne 0) {
        throw "MOSE subtree must not carry a second $Name; found $($Duplicates.Count)."
    }
}
$MosePython = @(Get-ChildItem -LiteralPath $ResolvedMoseOutput -File -Recurse |
    Where-Object { $_.Name -in @('python.exe', 'python311.dll', 'python3.dll') })
if ($MosePython.Count -ne 0) {
    throw "MOSE subtree must not carry a Python runtime; found $($MosePython.Count) file(s)."
}

Write-Host "Staged MAW + MOSE suite at $ResolvedOutput"
