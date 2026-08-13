@echo off
@REM chcp 65001 >nul
@REM set PYTHONUTF8=1
@REM set PYTHONIOENCODING=utf-8

call ".venv\Scripts\activate.bat"

python maw_gui.py