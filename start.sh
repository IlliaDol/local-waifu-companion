#!/usr/bin/env bash
# Negev-chan launcher with auto-restart (Linux, macOS, Git Bash).
# Usage: ./start.sh      stop with Ctrl+C
set -u
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required but not found in PATH."
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "NOTE: ffmpeg not in PATH - the local whisper pipeline's own ffmpeg copy is used when available."
fi

while true; do
  node bot.js
  code=$?
  echo "[start.sh] Negev exited with code $code - restarting in 5s (Ctrl+C to stop)"
  sleep 5
done
