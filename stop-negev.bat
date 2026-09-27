@echo off
REM Turn Negev-chan OFF and keep her off.
REM   - stops her process and the keep-alive runner (her memory is untouched)
REM   - drops a MANUAL OFF flag (data\MANUAL_OFF) so the 24/7 watchdog will NOT
REM     restart her at logon or on its 5-minute tick
REM Back on with:  start-negev.bat
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-negev.ps1"
if errorlevel 1 pause
