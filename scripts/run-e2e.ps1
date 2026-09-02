[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $PlaywrightArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
Set-Location -LiteralPath $repoRoot

function Resolve-ExecutablePath {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Value
    )

    if (Test-Path -LiteralPath $Value -PathType Leaf) {
        return (Resolve-Path -LiteralPath $Value).Path
    }

    $command = Get-Command $Value -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }

    return $null
}

function Test-MawE2ePython {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Python
    )

    if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
        return $false
    }

    try {
        & $Python -c "import importlib.metadata as metadata; import reapeaks; print(metadata.version('reapeaks'))" *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Find-MawSystemPython {
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($null -ne $launcher) {
        $candidate = (& $launcher.Source -3 -c "import sys; print(sys.executable)" 2>$null | Select-Object -Last 1)
        if ($null -ne $candidate) {
            $resolved = Resolve-ExecutablePath ([string] $candidate).Trim()
            if ($null -ne $resolved) {
                return $resolved
            }
        }
    }

    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($null -ne $python) {
        return $python.Source
    }

    return $null
}

$configuredPython = [string] $env:MAW_E2E_PYTHON
$pythonPath = $null

if (-not [string]::IsNullOrWhiteSpace($configuredPython)) {
    $pythonPath = Resolve-ExecutablePath $configuredPython.Trim()
    if ($null -eq $pythonPath -or -not (Test-MawE2ePython $pythonPath)) {
        throw "MAW_E2E_PYTHON is missing or cannot import reapeaks: $configuredPython"
    }
} else {
    $venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
    if (Test-MawE2ePython $venvPython) {
        $pythonPath = (Resolve-Path -LiteralPath $venvPython).Path
    } else {
        $systemPython = Find-MawSystemPython
        if ($null -eq $systemPython) {
            throw "No usable Python was found. Install Python >= 3.11 or set MAW_E2E_PYTHON explicitly."
        }

        $tempRoot = if ([string]::IsNullOrWhiteSpace([string] $env:MAW_E2E_ROOT)) {
            Join-Path ([System.IO.Path]::GetTempPath()) "maw-e2e"
        } else {
            $env:MAW_E2E_ROOT
        }
        $environmentPath = if ([string]::IsNullOrWhiteSpace([string] $env:MAW_E2E_ENV_DIR)) {
            Join-Path $tempRoot "python-env"
        } else {
            $env:MAW_E2E_ENV_DIR
        }
        $cachePath = if ([string]::IsNullOrWhiteSpace([string] $env:MAW_E2E_CACHE_DIR)) {
            Join-Path $tempRoot "uv-cache"
        } else {
            $env:MAW_E2E_CACHE_DIR
        }

        New-Item -ItemType Directory -Force -Path $tempRoot, $cachePath | Out-Null
        $env:UV_CACHE_DIR = $cachePath
        $env:UV_PROJECT_ENVIRONMENT = $environmentPath
        $env:UV_NO_MANAGED_PYTHON = "1"
        $env:UV_PYTHON_DOWNLOADS = "never"
        $env:UV_PYTHON = $systemPython

        & uv sync --frozen --python $systemPython --no-managed-python --no-python-downloads --cache-dir $cachePath
        if ($LASTEXITCODE -ne 0) {
            throw "uv sync failed while preparing the isolated E2E environment."
        }

        $pythonPath = Join-Path $environmentPath "Scripts\python.exe"
        if (-not (Test-MawE2ePython $pythonPath)) {
            throw "The isolated E2E environment was created, but it cannot import reapeaks: $pythonPath"
        }
    }
}

$env:MAW_E2E_PYTHON = $pythonPath

$arguments = @($PlaywrightArguments)
$hasOutputArgument = $arguments | Where-Object {
    $_ -eq "-o" -or $_ -eq "--output" -or $_ -like "--output=*"
}
if ($null -eq $hasOutputArgument) {
    $outputPath = if ([string]::IsNullOrWhiteSpace([string] $env:MAW_E2E_OUTPUT_DIR)) {
        Join-Path ([System.IO.Path]::GetTempPath()) "maw-playwright-results"
    } else {
        $env:MAW_E2E_OUTPUT_DIR
    }
    New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
    $arguments += @("--output", $outputPath)
}

& npx.cmd playwright test @arguments
exit $LASTEXITCODE
