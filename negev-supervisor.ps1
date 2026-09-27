# Negev-chan launcher / supervisor.
#
# Called by the "NegevChan" scheduled task at logon and every 5 minutes.
# It is deliberately SHORT-LIVED: it starts her detached and returns immediately.
# (Task Scheduler terminates an action that lingers with a long-lived hidden child,
# which is why the keep-alive loop lives in start.bat instead.)
#
# Liveness is decided by the PROCESSES and the heartbeat, never by the heartbeat
# alone: a force-killed bot leaves a fresh-looking data\bot.lock behind (there is no
# chance to clean it up), so trusting that file alone would leave her dead until the
# heartbeat finally aged out.
#
#   1. bot.js running and heartbeat fresh  -> healthy, exit silently
#   2. bot.js running but heartbeat stale  -> hung; kill it and let the runner respawn
#   3. runner.js running                   -> it restarts bot.js by itself, exit
#   4. neither running                     -> start start.bat hidden (this is the
#                                             reboot / power-loss path: it launches her
#                                             immediately even if the lock file is fresh)
#
# She logs to data\negev.log by herself, so no shell redirection is involved (two
# launchers can never deadlock over a log file one of them holds open).
#
# Manual use:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\negev-supervisor.ps1 -Status
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\negev-supervisor.ps1

[CmdletBinding()]
param(
  [switch]$Status,
  [switch]$Force,
  [int]$StaleAfterSeconds = 120
)

$ErrorActionPreference = "Stop"
$dir = $PSScriptRoot
$lock = Join-Path $dir "data\bot.lock"
$log = Join-Path $dir "data\negev.log"
$bat = Join-Path $dir "start.bat"
$manualOff = Join-Path $dir "data\MANUAL_OFF"

function Get-LockAgeSeconds {
  if (-not (Test-Path $lock)) { return $null }
  try {
    $raw = Get-Content $lock -Raw
    $stamp = [long](($raw | ConvertFrom-Json).ts)
    $when = [DateTimeOffset]::FromUnixTimeMilliseconds($stamp).UtcDateTime
    return [math]::Round(((Get-Date).ToUniversalTime() - $when).TotalSeconds)
  } catch {
    return $null
  }
}

function Get-RunningBot {
  # Only OUR bot: the command line must name THIS folder's bot.js. A bare
  # "bot.js" elsewhere (other projects, scratch copies) must never match.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$dir*bot.js*" }
}

function Get-RunningRunner {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$dir*runner.js*" }
}

function Invoke-Status {
  $age = Get-LockAgeSeconds
  $procs = @(Get-RunningBot)
  $runner = @(Get-RunningRunner)
  $task = Get-ScheduledTask -TaskName "NegevChan" -ErrorAction SilentlyContinue
  Write-Host "Negev-chan" -ForegroundColor Cyan
  Write-Host "  folder      : $dir"
  if (Test-Path $manualOff) {
    Write-Host "  switched    : MANUAL OFF (start-negev.bat turns her back on)" -ForegroundColor Yellow
  }
  Write-Host "  her process : $(if ($procs.Count) { "running (pid $($procs[0].ProcessId))" } else { 'NOT running' })" -ForegroundColor $(if ($procs.Count) { 'Green' } else { 'Red' })
  Write-Host "  keep-alive  : $(if ($runner.Count) { "active (pid $($runner[0].ProcessId))" } else { 'not running' })" -ForegroundColor $(if ($runner.Count) { 'Green' } else { 'Yellow' })
  Write-Host "  heartbeat   : $(if ($null -eq $age) { 'no lock file' } else { "$age s ago" })"
  Write-Host "  log         : $(if (Test-Path $log) { "$([math]::Round((Get-Item $log).Length / 1KB)) KB" } else { 'none yet' })"
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName "NegevChan"
    Write-Host "  task        : $($task.State) | next $($info.NextRunTime) | last $($info.LastRunTime)"
  } else {
    Write-Host "  task        : not installed (run install-24-7.ps1)"
  }
}

if ($Status) { Invoke-Status; exit 0 }

if (-not $Status) {
  # MANUAL OFF: stop-negev.bat drops this flag file in. While it exists the
  # supervisor is a no-op (never starts her, never "fixes" a manual shutdown)
  # — but -Status and -Force keep working so status.bat stays honest.
  if (Test-Path $manualOff) { exit 0 }
}

# ---------------------------------------------------------------- liveness
$age = Get-LockAgeSeconds
if (-not $Force) {
  $procs = @(Get-RunningBot)
  $stale = ($null -ne $age -and $age -ge $StaleAfterSeconds)

  if ($procs.Count -gt 0) {
    if (-not $stale) { exit 0 }
    # process exists but stopped refreshing its heartbeat: hung or wedged
    $procs | ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-Host "she stopped responding $(($age))s ago - restarting her"
  }

  # the keep-alive runner is alive - it respawns her within 5 seconds by itself
  if (@(Get-RunningRunner).Count -gt 0) { exit 0 }
} else {
  # -Force means "restart her now": clear the old chain first, then start fresh
  Write-Host "-Force: stopping the running chain"
  @(Get-RunningBot) + @(Get-RunningRunner) | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 800
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not found in PATH - install Node 20+" }
$runner = Join-Path $dir "runner.js"
if (-not (Test-Path $runner)) { throw "runner.js not found in $dir" }

# --------------------------------------------------------------- launch her
# Detached and hidden; runner.js keeps her alive from there with a 5s restart loop.
# Absolute runner path in quotes: our process checks match on the full command line.
if (Test-Path $manualOff) { Remove-Item $manualOff -Force -ErrorAction SilentlyContinue }
$runnerArg = '"' + $runner + '"'
Start-Process -FilePath $node -ArgumentList $runnerArg -WorkingDirectory $dir -WindowStyle Hidden
exit 0
