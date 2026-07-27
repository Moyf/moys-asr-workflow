@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"
echo Starting MAW Console...
echo.
uv run python web-console\server.py %*
if %errorlevel% neq 0 (
    echo.
    pause
)
endlocal
