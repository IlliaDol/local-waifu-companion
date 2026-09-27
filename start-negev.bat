@echo off
REM Turn Negev-chan back ON after stop-negev.bat.
REM   - clears the MANUAL OFF flag
REM   - starts her now and (re)installs the 24/7 scheduled task, so she
REM     survives crashes and reboots again
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-24-7.ps1"
if errorlevel 1 pause
