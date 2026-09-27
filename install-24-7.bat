@echo off
REM Double-click helper: installs the NegevChan 24/7 scheduled task.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-24-7.ps1"
echo.
pause
