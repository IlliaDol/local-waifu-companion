@echo off
REM ============================================================
REM  Negev one-click entry point.
REM
REM  Double-click this single file. It:
REM    1. opens the control panel if she is already running
REM    2. otherwise starts her first (hidden, auto-restarting),
REM       waits for the panel to come up, then opens it
REM
REM  This replaces the old start / stop / status / control-center
REM  shortcut quartet: one file, and the panel IS the control
REM  center while she runs.
REM ============================================================
cd /d "%~dp0"

REM is the panel (therefore she) already up?
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient('127.0.0.1',8765)).Close();exit 0}catch{exit 1}" >nul 2>nul
if not errorlevel 1 goto open

echo Starting Negev...
start "" /min cmd /c "%~dp0start.bat"

set TRIES=0
:wait
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient('127.0.0.1',8765)).Close();exit 0}catch{exit 1}" >nul 2>nul
if not errorlevel 1 goto open
set /a TRIES+=1
if %TRIES% lss 10 goto wait

echo.
echo She did not come up within 20 seconds. Check data\negev.log
echo (the panel would be at http://127.0.0.1:8765 once she is up)
echo.
pause
exit /b 1

:open
start "" http://127.0.0.1:8765/
exit /b 0
