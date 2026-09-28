#!/usr/bin/env bash
# Negev-chan one-file installer (Linux / macOS).
#
#   curl -fsSL <raw-url>/install-online.sh | bash
#
# Takes a fresh machine from nothing to a running bot: installs Node 20+
# if missing, downloads the project, asks once for the two API keys, writes
# .env + config.js, starts her. Keys are stored in .env on disk only.
set -euo pipefail

REPO_ZIP="https://github.com/IlliaDol/local-waifu-companion/archive/refs/heads/main.zip"
DEFAULT_DIR="$HOME/negev-chan"

cyan() { printf "\033[36m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
gray() { printf "\033[90m%s\033[0m\n" "$1"; }

echo ""
cyan "  Negev-chan installer"
echo "  ===================="
echo ""

# ---------------------------------------------------------------- 1. Node.js
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }

if node_ok; then
  green " [1/5] Node.js found: $(node --version)"
else
  yellow " [1/5] Node.js 20+ not found - installing..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
    sudo apt-get install -y nodejs >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - >/dev/null
    sudo dnf install -y nodejs >/dev/null
  elif command -v brew >/dev/null 2>&1; then
    brew install node@20 >/dev/null && brew link --overwrite node@20 >/dev/null || true
  else
    echo "No supported package manager found (apt/dnf/brew). Install Node 20+ from https://nodejs.org and re-run." >&2
    exit 1
  fi
  node_ok || { echo "Node.js install did not succeed - install it manually and re-run." >&2; exit 1; }
  green "       installed: $(node --version)"
fi

# ---------------------------------------------------------------- 2. folder
if [ -f "$DEFAULT_DIR/bot.js" ]; then
  yellow " [2/5] Already installed at $DEFAULT_DIR - updating code..."
  git -C "$DEFAULT_DIR" pull >/dev/null 2>&1 || true
else
  echo " [2/5] Downloading the project -> $DEFAULT_DIR"
  TMP="$(mktemp -d)"
  curl -fsSL "$REPO_ZIP" -o "$TMP/proj.zip"
  unzip -q "$TMP/proj.zip" -d "$TMP"
  SRC="$(find "$TMP" -maxdepth 1 -type d -name 'local-waifu-companion-*' | head -1)"
  [ -n "$SRC" ] || { echo "archive did not contain the project" >&2; exit 1; }
  mkdir -p "$DEFAULT_DIR"
  cp -r "$SRC"/. "$DEFAULT_DIR"/
  rm -rf "$TMP"
  echo "       done."
fi
cd "$DEFAULT_DIR"

# ---------------------------------------------------------------- 3. secrets
echo ""
cyan " [3/5] Two keys are needed. They go into .env inside the folder only,"
cyan "       never sent anywhere else, never committed."
echo ""

ask_key() {
  local label="$1" envname="$2" existing=""
  if [ -f .env ]; then
    existing="$(grep -E "^${envname}=" .env | head -1 | cut -d= -f2- || true)"
  fi
  if [ -n "$existing" ] && [[ "$existing" != your-* ]]; then
    gray "       $label : already set, keeping it (edit .env to change)"
    return 0
  fi
  while true; do
    printf "       %s\n" "$label"
    local value=""
    read -r -p "         paste it (or Enter to skip): " value || value=""
    if [ -n "${value// }" ]; then
      printf "%s=%s\n" "$envname" "$value" >> .env
      return 0
    fi
    yellow "         skipped - fill .env by hand later; she cannot start without it."
    return 0
  done
}

touch .env
ask_key "DeepSeek API key  - https://platform.deepseek.com  (API keys)" "DEEPSEEK_API_KEY"
ask_key "Telegram bot token - open @BotFather in Telegram, /newbot, paste the token" "NEGEV_BOT_TOKEN"
gray "       .env written."

# ---------------------------------------------------------------- 4. config
if [ ! -f config.js ]; then
  cp config.example.js config.js
  echo " [4/5] config.js created from the template (defaults are fine to start)."
else
  echo " [4/5] config.js already exists - leaving it untouched."
fi

# ---------------------------------------------------------------- 5. start
echo " [5/5] Starting her..."

# The verdict must come from THIS copy's own log, never from the ports alone:
# another Negev already on this machine answers them too, so a fresh install
# that exits would otherwise be reported as running. Everything this copy logs
# after we launch it lands past this mark.
LOG="data/negev.log"
MARK=0
if [ -f "$LOG" ]; then MARK="$(wc -l < "$LOG" | tr -d ' ')"; fi
fresh_lines() { tail -n "+$((MARK + 1))" "$LOG" 2>/dev/null || true; }

if command -v nohup >/dev/null 2>&1; then
  nohup ./start.sh > /dev/null 2>&1 &
  disown || true
else
  ./start.sh &
fi

# Starting is not the same as running: a key missing from .env, or a second copy
# on the same token, makes her exit within seconds. So wait until she actually
# answers before telling the user she is up.
negev_alive() {
  local p line
  # the singleton port she binds - works even with the control panel switched off
  for p in 47631 47632 47633; do
    if exec 3<>"/dev/tcp/127.0.0.1/$p" 2>/dev/null; then
      if IFS= read -r -t 1 line <&3 && [[ "$line" == *NEGEV-CHAN* ]]; then
        exec 3<&- 3>&-
        return 0
      fi
      exec 3<&- 3>&-
    fi
  done
  # and the panel, when it is on and curl is available
  local port="${NEGEV_PANEL_PORT:-8765}"
  if [ "$port" != "0" ] && command -v curl >/dev/null 2>&1; then
    curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${port}/" 2>/dev/null && return 0
  fi
  return 1
}

UP=""
WHY=""
i=0
while [ "$i" -lt 20 ]; do
  fresh="$(fresh_lines)"
  # a logged-in line from THIS dir wins: a stray restart of an older attempt
  # can append a lock-exit after it, and that must not flip a healthy verdict
  if printf '%s\n' "$fresh" | grep -q "\[boot\] logged in as" && negev_alive; then UP="yes"; break; fi
  if printf '%s\n' "$fresh" | grep -q "another Negev is alive"; then WHY="other"; break; fi
  if printf '%s\n' "$fresh" | grep -q "\[boot\] cannot reach Telegram"; then WHY="keys"; break; fi
  sleep 1
  i=$((i + 1))
done

fresh="$(fresh_lines)"
if [ -n "$fresh" ]; then
  gray "       what she logged:"
  printf '%s\n' "$fresh" | tail -5 | while IFS= read -r line; do gray "       $line"; done
fi
echo ""

if [ "$UP" = "yes" ]; then
  green "  She is running and the control panel is at http://127.0.0.1:${NEGEV_PANEL_PORT:-8765}"
  green "  (start her any time with ./start.sh - the panel comes up with her)"
  echo ""
  gray "  Stop her:  pkill -f 'node bot.js'   |   24/7 on a VPS: see negev.service"
elif [ "$WHY" = "other" ]; then
  yellow "  Another Negev is already running on this machine, so this copy exited."
  yellow "  Two copies on one token fight over the same updates - only one can run."
  echo ""
  gray "  Stop the running one : stop-negev.bat   (or pkill -f 'node bot.js')"
  gray "  Then start THIS copy : ./start.sh"
elif [ "$WHY" = "keys" ]; then
  yellow "  She booted but could not log in to Telegram - the keys are missing or wrong."
  echo ""
  gray "  Put them in .env (DEEPSEEK_API_KEY and NEGEV_BOT_TOKEN), then: ./start.sh"
  gray "  Log   : data/negev.log"
else
  yellow "  She did not answer - she is probably not running yet."
  yellow "  Usual causes: a key missing from .env, or another copy already running"
  gray   "  (two instances on one token fight over the same updates)."
  echo ""
  gray "  Check : the two keys in .env are filled in"
  gray "  Start : ./start.sh   (run it in the foreground and watch her)"
  gray "  Log   : data/negev.log"
fi
echo ""
