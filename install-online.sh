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
if command -v nohup >/dev/null 2>&1; then
  nohup ./start.sh > /dev/null 2>&1 &
  disown || true
else
  ./start.sh &
fi
sleep 5
if [ -f data/negev.log ]; then
  gray "       last log lines:"
  tail -5 data/negev.log | while IFS= read -r line; do gray "       $line"; done
fi
echo ""
green "  She is running and the control panel is at http://127.0.0.1:8765"
green "  (start her any time with ./start.sh - the panel comes up with her)"
echo ""
gray "  Stop her:  pkill -f 'node bot.js'   |   24/7 on a VPS: see negev.service"
echo ""
