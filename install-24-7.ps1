# Negev-chan 24/7 setup for this Windows PC.
#
# Registers a scheduled task that:
#   - runs a SHORT-LIVED supervisor at every logon and every 5 minutes
#   - the supervisor does nothing while she is alive, and otherwise starts
#     start.bat hidden, whose runner.js restarts bot.js 5 s after any crash
#   - can never start a second copy: MultipleInstances = IgnoreNew, plus the
#     bot holds a real singleton lock (a bound TCP port in lock.js) and exits
#     with code 3 if another Negev already owns it
#
# No administrator rights needed. Run uninstall-24-7.ps1 to undo it.

[CmdletBinding()]
param(
  [string]$TaskName = "NegevChan"
)

$ErrorActionPreference = "Stop"
$dir = $PSScriptRoot
$supervisor = Join-Path $dir "negev-supervisor.ps1"
$bat = Join-Path $dir "start.bat"

Write-Host "Negev-chan 24/7 setup" -ForegroundColor Cyan
Write-Host "  folder     : $dir"

if (-not (Test-Path $supervisor)) { throw "negev-supervisor.ps1 not found in $dir" }
if (-not (Test-Path $bat)) { throw "start.bat not found in $dir" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js not found in PATH. Install Node 20+ first."
}

# Launch through wscript.exe (a GUI-subsystem host) so that no console window is
# ever allocated. "-WindowStyle Hidden" on powershell.exe is NOT enough: with
# Windows Terminal as the default console host, WindowsTerminal.exe is a GUI
# process that draws its own window regardless of the child console's hidden
# state, which produced a visible terminal flashing for ~1 s on every tick.
$vbs = Join-Path $dir "negev-hidden.vbs"
if (-not (Test-Path $vbs)) { throw "negev-hidden.vbs not found in $dir" }

$action = New-ScheduledTaskAction `
  -Execute (Join-Path $env:SystemRoot "System32\wscript.exe") `
  -Argument "//B //Nologo `"$vbs`"" `
  -WorkingDirectory $dir

$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# watchdog: the launcher is short-lived and does nothing unless she is actually
# gone, so a 5 minute tick costs nothing and caps worst-case downtime at 5 min.
# (A plain crash is already recovered in 5 seconds by runner.js.)
$triggerWatchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger @($triggerLogon, $triggerWatchdog) `
  -Settings $settings `
  -Description "Negev-chan Telegram companion bot - hidden launcher, restarts her after crashes and reboots" `
  -Force | Out-Null

Write-Host "  task       : $TaskName registered" -ForegroundColor Green

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6

$info = Get-ScheduledTaskInfo -TaskName $TaskName
$task = Get-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "state      : $($task.State)" -ForegroundColor Green
Write-Host "next run   : $($info.NextRunTime)"
Write-Host "last result: $($info.LastTaskResult)"
Write-Host ""
Write-Host "She is now running in the background and will come back after every reboot." -ForegroundColor Cyan
Write-Host "Live log   : $dir\data\negev.log"
Write-Host "Check      : .\status.bat   (or powershell -File .\negev-supervisor.ps1 -Status)"
Write-Host "Stop       : .\uninstall-24-7.ps1   (removes the task and stops her)"
Write-Host "Uninstall  : .\uninstall-24-7.bat"
Write-Host ""
Write-Host "Tip: so she never misses a message, stop Windows from sleeping:" -ForegroundColor Yellow
Write-Host "     powercfg /change standby-timeout-ac 0 ; powercfg /change monitor-timeout-ac 10"
