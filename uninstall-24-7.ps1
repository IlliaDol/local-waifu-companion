# Remove the Negev-chan 24/7 scheduled task and stop her if she is running.
[CmdletBinding()]
param(
  [string]$TaskName = "NegevChan",
  [switch]$KeepRunning
)

$ErrorActionPreference = "Continue"
$dir = $PSScriptRoot

Write-Host "Removing Negev-chan 24/7 setup" -ForegroundColor Cyan

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "  task       : $TaskName removed" -ForegroundColor Green
} else {
  Write-Host "  task       : $TaskName was not registered"
}

if (-not $KeepRunning) {
  # the bot writes its own pid to data/bot.lock every 30 seconds
  $lock = Join-Path $dir "data\bot.lock"
  if (Test-Path $lock) {
    try {
      $pidFromLock = (Get-Content $lock -Raw | ConvertFrom-Json).pid
      if ($pidFromLock) {
        Stop-Process -Id $pidFromLock -Force -ErrorAction SilentlyContinue
        Write-Host "  bot        : stopped (pid $pidFromLock)" -ForegroundColor Green
      }
    } catch {
      Write-Host "  bot        : could not read $lock"
    }
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
  }

  # safety net: the keep-alive runner and any stray copy from this folder
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object {
      $cl = $_.CommandLine
      if ($cl -and ($cl -like "*$dir*bot.js*" -or $cl -like "*$dir*runner.js*" -or $cl -like "*runner.js*")) {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "  bot        : stopped (pid $($_.ProcessId))" -ForegroundColor Green
      }
    }
}

Write-Host ""
Write-Host "Her memory is untouched: $dir\data" -ForegroundColor Cyan
Write-Host "You can still run her manually with start.bat."
