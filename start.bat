@echo off
REM Negev-chan launcher.
REM   manual use : double-click; close the window to stop her
REM   24/7 use   : started hidden by negev-supervisor.ps1 / the "NegevChan" task
REM
REM The keep-alive loop lives in runner.js (Node), not in this batch file, and the
REM bot writes data\negev.log itself - so nothing here can lose the process or
REM fight over an open log file.
cd /d "%~dp0"
title Negev-chan

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required but "node" was not found in PATH.
  pause
  exit /b 1
)

node runner.js
set CODE=%ERRORLEVEL%

if "%CODE%"=="3" (
  echo [start.bat] another Negev instance already holds the lock - leaving it running.
  exit /b 3
)

echo [start.bat] Negev stopped (exit %CODE%). Closing.
