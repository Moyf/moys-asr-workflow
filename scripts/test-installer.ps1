[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [string]$Version = "",
    [switch]$AllowDestructive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Installer = [System.IO.Path]::GetFullPath($InstallerPath)
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
    throw "Installer not found: $Installer"
}

if (-not $AllowDestructive -and $env:CI -ne 'true') {
    throw 'Installer smoke changes the per-user MAW install and must be run with -AllowDestructive (or CI=true).'
}

$AppRoot = Join-Path $env:LOCALAPPDATA 'Programs\MAW'
$DataRoot = Join-Path $env:LOCALAPPDATA 'MAW'
$EnvPath = Join-Path $DataRoot '.env'
$ExpectedVersion = ($Version -replace '^v', '')
$LogRoot = Join-Path $env:TEMP 'maw-installer-smoke'
New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null

if (Test-Path -LiteralPath $AppRoot) {
    throw "Refusing to overwrite an existing MAW installation: $AppRoot"
}
if (Test-Path -LiteralPath $EnvPath) {
    throw "Refusing to overwrite existing MAW user data: $EnvPath"
}
$UninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$ExistingUninstall = Get-ChildItem -Path $UninstallRoot -ErrorAction SilentlyContinue |
    Where-Object { $_.GetValue('DisplayName') -eq "Moy's ASR Workflow" } |
    Select-Object -First 1
if ($ExistingUninstall) {
    throw "Refusing to overwrite an existing MAW uninstall entry: $($ExistingUninstall.Name)"
}

function Invoke-Installer([string]$Path, [string]$LogPath) {
    $process = Start-Process -FilePath $Path -ArgumentList @(
        '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS',
        "/LOG=$LogPath"
    ) -PassThru -Wait -WindowStyle Hidden
    if ($process.ExitCode -ne 0) {
        throw "Installer exited with $($process.ExitCode). See $LogPath"
    }
}

Invoke-Installer $Installer (Join-Path $LogRoot 'install.log')
if (-not (Test-Path -LiteralPath (Join-Path $AppRoot 'MAW.exe') -PathType Leaf)) {
    throw "MAW.exe was not installed under $AppRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $AppRoot 'MOSE\MOSE.exe') -PathType Leaf)) {
    throw "MOSE\MOSE.exe was not installed under $AppRoot"
}
$StartMenuShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Moy's ASR Workflow.lnk"
if (-not (Test-Path -LiteralPath $StartMenuShortcut -PathType Leaf)) {
    throw "The expected Start Menu shortcut was not created: $StartMenuShortcut"
}
$UninstallEntry = Get-ChildItem -Path $UninstallRoot -ErrorAction SilentlyContinue |
    Where-Object { $_.GetValue('DisplayName') -eq "Moy's ASR Workflow" } |
    Select-Object -First 1
if (-not $UninstallEntry) {
    throw 'The Inno Setup uninstall entry was not found after installation.'
}
if ($Version -and [string]$UninstallEntry.GetValue('DisplayVersion') -ne $ExpectedVersion) {
    throw "Installer version mismatch: expected $ExpectedVersion, got $($UninstallEntry.GetValue('DisplayVersion'))"
}

New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
Set-Content -LiteralPath $EnvPath -Value 'MAW_INSTALLER_SMOKE=keep' -Encoding utf8

# Run the exact same installer again to exercise fixed-AppId in-place upgrade.
Invoke-Installer $Installer (Join-Path $LogRoot 'upgrade.log')
if ((Get-Content -Raw -LiteralPath $EnvPath) -notmatch 'MAW_INSTALLER_SMOKE=keep') {
    throw 'The user .env file was not preserved across an in-place upgrade.'
}

$help = Start-Process -FilePath (Join-Path $AppRoot 'MAW.exe') -ArgumentList '--help' -PassThru -Wait -WindowStyle Hidden
if ($help.ExitCode -ne 0) {
    throw "Installed MAW.exe --help exited with $($help.ExitCode)."
}

$uninstall = Get-ChildItem -Path $UninstallRoot -ErrorAction SilentlyContinue |
    Where-Object { $_.GetValue('DisplayName') -eq "Moy's ASR Workflow" } |
    Select-Object -First 1
if (-not $uninstall) {
    throw 'The Inno Setup uninstall entry was not found under HKCU.'
}
$uninstallString = [string]$uninstall.GetValue('UninstallString')
if (-not $uninstallString) {
    throw 'The Inno Setup uninstall command is empty.'
}
$uninstaller = $uninstallString.Trim().Trim('"')
$remove = Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -PassThru -Wait -WindowStyle Hidden
if ($remove.ExitCode -ne 0) {
    throw "Uninstaller exited with $($remove.ExitCode)."
}
if (Test-Path -LiteralPath $AppRoot) {
    throw "The application directory still exists after uninstall: $AppRoot"
}
if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
    throw 'The user .env file was removed by uninstall.'
}
Write-Host "Installer install/upgrade/launch/uninstall smoke passed; user data preserved at $EnvPath"
