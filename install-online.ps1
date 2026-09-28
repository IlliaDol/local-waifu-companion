# Negev-chan one-file installer (Windows).
#
# Takes a fresh machine from nothing to a running, configured bot:
#   1. checks/installs Node.js 20+   2. downloads this project   3. asks for the
#   two API keys once   4. writes config.js + .env   5. starts her (and can
#   register the 24/7 watchdog).
#
# Run it from PowerShell:
#   powershell -ExecutionPolicy Bypass -File install-online.ps1
# or the one-liner from a bare shell (see README).
#
# Nothing is sent anywhere except github.com (the code), api.telegram.org and
# api.deepseek.com (her runtime). The keys you type go into .env on disk only.

[CmdletBinding()]
param(
  [switch]$No247,      # skip the 24/7 scheduled-task step
  [switch]$NoStart     # configure everything but do not start her
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$REPO = "https://github.com/IlliaDol/local-waifu-companion/archive/refs/heads/main.zip"
$DEFAULT_DIR = Join-Path $env:USERPROFILE "negev-chan"

Write-Host ""
Write-Host "  Negev-chan installer" -ForegroundColor Cyan
Write-Host "  ==================="
Write-Host ""

# ---------------------------------------------------------------- 1. Node.js
function Test-Node {
  try { $v = (node --version) 2>$null; return $v -match "^v(\d+)" -and [int]$Matches[1] -ge 20 } catch { return $false }
}

if (Test-Node) {
  Write-Host " [1/5] Node.js found: $(node --version)" -ForegroundColor Green
} else {
  Write-Host " [1/5] Node.js 20+ not found - installing (winget)..." -ForegroundColor Yellow
  $ok = $false
  try {
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
    $ok = $true
  } catch { }
  if (-not $ok -or -not (Test-Node)) {
    # winget missing or PATH not refreshed in this session: fetch the MSI directly
    Write-Host "       winget unavailable - downloading the Node.js LTS installer..." -ForegroundColor Yellow
    $msi = Join-Path $env:TEMP "node-lts.msi"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/latest-v20.x/node-v20.19.5-x64.msi" -OutFile $msi -UseBasicParsing
    Start-Process msiexec -ArgumentList "/i `"$msi`" /qn" -Wait
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
    # this session cannot see the new PATH; use the known location
    $env:Path = "$env:Path;C:\Program Files\nodejs"
    if (-not (Test-Node)) { throw "Node.js was installed but is not reachable in this session. Open a NEW terminal and run this installer again." }
  }
  Write-Host "       Node.js installed: $(node --version)" -ForegroundColor Green
}

# ---------------------------------------------------------------- 2. folder
$dir = $DEFAULT_DIR
if (Test-Path (Join-Path $dir "bot.js")) {
  Write-Host " [2/5] Already installed at $dir - updating code..." -ForegroundColor Yellow
  Push-Location $dir
  try { git pull 2>$null | Out-Null } catch { }
  Pop-Location
  if (-not (Test-Node)) { }
} else {
  Write-Host " [2/5] Downloading the project -> $dir"
  $zip = Join-Path $env:TEMP "negev-chan.zip"
  Invoke-WebRequest -Uri $REPO -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $env:TEMP -Force
  $extracted = Get-ChildItem $env:TEMP -Directory -Filter "local-waifu-companion-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $extracted) { throw "the downloaded archive did not contain the project" }
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Copy-Item -Path (Join-Path $extracted.FullName "*") -Destination $dir -Recurse -Force
  Remove-Item $zip, $extracted.FullName -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "       done."
}

Set-Location $dir

# ---------------------------------------------------------------- 3. secrets
Write-Host ""
Write-Host " [3/5] Two keys are needed. They are stored in .env inside the folder only," -ForegroundColor Cyan
Write-Host "       never sent anywhere else, never committed." -ForegroundColor Cyan
Write-Host ""

function Ask-Key($label, $envName, $example) {
  $existing = ""
  $envFile = Join-Path $dir ".env"
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
      if ($line -match "^\s*$envName\s*=\s*(.+)\s*$") { $existing = $Matches[1].Trim() }
    }
  }
  if ($existing -and $existing -notmatch "your-") {
    Write-Host "       $label : already set, keeping it (delete it from .env to change)" -ForegroundColor DarkGray
    return $existing
  }
  while ($true) {
    Write-Host "       $label" -ForegroundColor White
    if ($example) { Write-Host "         ($example)" -ForegroundColor DarkGray }
    $value = Read-Host "         paste it (or Enter to skip)"
    if ($value -and $value.Trim()) { return $value.Trim() }
    Write-Host "         skipped - you can fill .env by hand later, but she cannot start without it." -ForegroundColor Yellow
    return ""
  }
}

$keyDeep = Ask-Key "DeepSeek API key  - https://platform.deepseek.com  (API keys)" "DEEPSEEK_API_KEY" "sk-..."
$keyBot  = Ask-Key "Telegram bot token - open @BotFather in Telegram, /newbot, paste the token" "NEGEV_BOT_TOKEN" "123456789:AAF..."

$envLines = @(
  "DEEPSEEK_API_KEY=$keyDeep",
  "NEGEV_BOT_TOKEN=$keyBot"
) | Where-Object { $_ -notmatch "=$\s*$" }
Set-Content -Path (Join-Path $dir ".env") -Value $envLines -Encoding UTF8
Write-Host "       .env written."

# ---------------------------------------------------------------- 4. config
if (-not (Test-Path (Join-Path $dir "config.js"))) {
  Copy-Item (Join-Path $dir "config.example.js") (Join-Path $dir "config.js")
  Write-Host " [4/5] config.js created from the template (all defaults are fine to start)."
} else {
  Write-Host " [4/5] config.js already exists - leaving it untouched."
}

# ---------------------------------------------------------------- 5. start
# Starting is not the same as running: a key missing from .env, or a second copy
# on the same token, makes her exit within seconds. So wait until she actually
# answers before telling the user she is up.
$panelPort = if ($env:NEGEV_PANEL_PORT) { $env:NEGEV_PANEL_PORT } else { "8765" }
$panelUrl = "http://127.0.0.1:$panelPort"

function Test-Negev {
  # the singleton port she binds - works even with the control panel switched off
  foreach ($p in 47631, 47632, 47633) {
    $client = $null
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $client.Connect("127.0.0.1", $p)
      $stream = $client.GetStream()
      $stream.ReadTimeout = 1000
      $buf = New-Object byte[] 64
      $n = $stream.Read($buf, 0, 64)
      $line = [System.Text.Encoding]::ASCII.GetString($buf, 0, $n)
      $client.Close()
      if ($line -match "NEGEV-CHAN") { return $true }
    } catch {
      if ($client) { $client.Close() }
    }
  }
  # and the panel, when it is on
  if ($panelPort -ne "0") {
    try {
      $r = Invoke-WebRequest -Uri "$panelUrl/" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { return $true }
    } catch { }
  }
  return $false
}

if (-not $NoStart) {
  Write-Host " [5/5] Starting her..."
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c \"\"$(Join-Path $dir 'negev.cmd')\"\"" -WorkingDirectory $dir -WindowStyle Hidden

  $up = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Negev) { $up = $true; break }
  }

  $log = Join-Path $dir "data\negev.log"
  if (Test-Path $log) {
    Write-Host ""
    Write-Host "       last log lines:" -ForegroundColor DarkGray
    Get-Content $log -Tail 5 | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkGray }
  }
  Write-Host ""
  if ($up) {
    Write-Host "  She is running and the control panel opened in your browser." -ForegroundColor Green
    Write-Host "  Panel any time : double-click negev.cmd (or $panelUrl)" -ForegroundColor Green
    Write-Host "  Stop her       : stop-negev.bat (also fences off the 24/7 watchdog)" -ForegroundColor Green
    Write-Host ""
    if (-not $No247) {
      $answer = Read-Host "  Also keep her alive 24/7 (restart after crashes/reboots)? [Y/n]"
      if ($answer -notmatch "^n" -and $answer -notmatch "^N") {
        & (Join-Path $dir "install-24-7.ps1")
      }
    }
  } else {
    Write-Host "  She did not answer - she is probably not running yet." -ForegroundColor Yellow
    Write-Host "  Usual causes: a key missing from .env, or another copy already running" -ForegroundColor Yellow
    Write-Host "  (two instances on one token fight over the same updates)." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Check : notepad .env      (both keys filled in?)" -ForegroundColor DarkGray
    Write-Host "  Start : negev.cmd         (run it and watch the window)" -ForegroundColor DarkGray
    Write-Host "  Log   : data\negev.log" -ForegroundColor DarkGray
    Write-Host ""
  }
} else {
  Write-Host " [5/5] -NoStart given: configure only. Start later: double-click negev.cmd"
}

Write-Host ""
