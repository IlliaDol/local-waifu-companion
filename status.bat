@echo off
REM Is she alive? Shows the running process, the heartbeat age and the log.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0negev-supervisor.ps1" -Status
echo.
echo Scheduled task:
powershell.exe -NoProfile -Command "try { $i = Get-ScheduledTaskInfo -TaskName NegevChan; '  state: ' + (Get-ScheduledTask -TaskName NegevChan).State + ' | next: ' + $i.NextRunTime + ' | last: ' + $i.LastRunTime } catch { '  (not installed - run install-24-7.bat)' }"
echo.
echo Last 12 log lines:
powershell.exe -NoProfile -Command "if (Test-Path 'data\negev.log') { Get-Content 'data\negev.log' -Tail 12 } else { '  (no log yet)' }"
echo.
pause
