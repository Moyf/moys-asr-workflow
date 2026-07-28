@echo off
cd /d "%~dp0"
echo [MAW] Starting local model GUI...
uv run python maw_local_gui.py
pause
