[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [string]$CertificatePath = "",
    [string]$CertificatePassword = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ResolvedInstaller = [System.IO.Path]::GetFullPath($InstallerPath)
if (-not (Test-Path -LiteralPath $ResolvedInstaller -PathType Leaf)) {
    throw "Installer not found: $ResolvedInstaller"
}

$TemporaryCertificate = $null
try {
    if (-not $CertificatePath -and $env:MAW_SIGN_CERTIFICATE_BASE64) {
        $TemporaryCertificate = Join-Path ([System.IO.Path]::GetTempPath()) ("maw-sign-" + [guid]::NewGuid().ToString('N') + '.pfx')
        try {
            $bytes = [Convert]::FromBase64String($env:MAW_SIGN_CERTIFICATE_BASE64)
        }
        catch [FormatException] {
            throw 'MAW_SIGN_CERTIFICATE_BASE64 is not valid base64.'
        }
        [System.IO.File]::WriteAllBytes($TemporaryCertificate, $bytes)
        $CertificatePath = $TemporaryCertificate
    }

    if (-not $CertificatePassword -and $env:MAW_SIGN_CERTIFICATE_PASSWORD) {
        $CertificatePassword = $env:MAW_SIGN_CERTIFICATE_PASSWORD
    }

    if (-not $CertificatePath) {
        Write-Warning 'No code-signing certificate configured; the official Installer remains unsigned and may trigger SmartScreen.'
        return
    }
    $ResolvedCertificate = [System.IO.Path]::GetFullPath($CertificatePath)
    if (-not (Test-Path -LiteralPath $ResolvedCertificate -PathType Leaf)) {
        throw "Code-signing certificate not found: $ResolvedCertificate"
    }

    $SignTool = Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
    if (-not $SignTool) {
        $KitRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
        $SignTool = Get-ChildItem -LiteralPath $KitRoot -Filter signtool.exe -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
            Sort-Object FullName -Descending |
            Select-Object -ExpandProperty FullName -First 1
    }
    if (-not $SignTool) {
        throw 'signtool.exe was not found. Install the Windows SDK before enabling release signing.'
    }

    & $SignTool sign /fd SHA256 /f $ResolvedCertificate /p $CertificatePassword /tr 'http://timestamp.digicert.com' /td SHA256 /d "Moy's ASR Workflow" $ResolvedInstaller
    if ($LASTEXITCODE -ne 0) {
        throw "signtool sign failed with exit code $LASTEXITCODE."
    }
    & $SignTool verify /pa /all $ResolvedInstaller
    if ($LASTEXITCODE -ne 0) {
        throw "signtool verify failed with exit code $LASTEXITCODE."
    }
    Write-Host "Signed and verified $ResolvedInstaller"
}
finally {
    if ($TemporaryCertificate -and (Test-Path -LiteralPath $TemporaryCertificate)) {
        Remove-Item -LiteralPath $TemporaryCertificate -Force -ErrorAction SilentlyContinue
    }
}
