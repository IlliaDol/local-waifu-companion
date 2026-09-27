# Stop Negev-chan and keep her stopped until start-negev.bat runs.
#
#   - kills her process and the keep-alive runner (her memory is untouched)
#   - drops data\MANUAL_OFF so the 24/7 supervisor is a no-op while she is
#     manually off (no restart at logon, no watchdog resurrection)
#   - leaves the scheduled task installed: "off" is just the flag, so
#     start-negev.bat only needs to clear it and relaunch

$ErrorActionPreference = "Continue"
$dir = $PSScriptRoot
$manualOff = Join-Path $dir "data\MANUAL_OFF"

Write-Host "Negev-chan: stopping" -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path (Join-Path $dir "data") | Out-Null
Set-Content -Path $manualOff -Value "manual off since $(Get-Date -Format s)" -Encoding UTF8

# 1. our keep-alive runner (must go first or it respawns her within 5 s)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$dir\runner.js*" } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "  keep-alive : stopped (pid $($_.ProcessId))" -ForegroundColor Green
  }

# 2. our bot process
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$dir\bot.js*" } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "  bot        : stopped (pid $($_.ProcessId))" -ForegroundColor Green
  }

Start-Sleep -Seconds 1

# 3. the lock file is stale the moment she dies; remove it so status shows clean
Remove-Item (Join-Path $dir "data\bot.lock") -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "She is off and will stay off. Her memory is untouched: $dir\data" -ForegroundColor Cyan
Write-Host "Turn her back on: start-negev.bat"
