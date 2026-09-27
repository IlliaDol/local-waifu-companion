@echo off
REM Double-click helper: removes the NegevChan 24/7 scheduled task and stops her.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-24-7.ps1"
echo.
pause
