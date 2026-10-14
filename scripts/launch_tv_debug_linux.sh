#!/bin/bash
# Launch TradingView Desktop on Linux with Chrome DevTools Protocol enabled
# Usage: ./scripts/launch_tv_debug_linux.sh [port]

# The Node parent owns the compatibility lease until this child finishes.
if [ "${TV_COMPATIBILITY_CHILD:-}" != "1" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "Error: Node.js >=22 is required for launch version tracking." >&2
    exit 1
  fi
  SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
  exec node "$SCRIPT_DIR/compatibility-launch.js" "$SCRIPT_DIR/$(basename -- "$0")" "${1:-9222}"
fi

PORT="${1:-9222}"

# Auto-detect TradingView install location
APP=""
LOCATIONS=(
  "/opt/TradingView/tradingview"
  "/opt/TradingView/TradingView"
  "$HOME/.local/share/TradingView/TradingView"
  "/usr/bin/tradingview"
  "/usr/local/bin/tradingview"
  "/snap/tradingview/current/tradingview"
  "/var/lib/flatpak/app/com.tradingview.TradingView/current/active/files/bin/tradingview"
  "$HOME/.local/share/flatpak/app/com.tradingview.TradingView/current/active/files/bin/tradingview"
)

for loc in "${LOCATIONS[@]}"; do
  if [ -f "$loc" ] && [ -x "$loc" ]; then
    APP="$loc"
    break
  fi
done

# Fallback: which / whereis
if [ -z "$APP" ]; then
  APP=$(which tradingview 2>/dev/null || which TradingView 2>/dev/null)
fi

# Fallback: find in common dirs
if [ -z "$APP" ]; then
  APP=$(find /opt /usr/local /snap "$HOME/.local" -name "tradingview" -o -name "TradingView" -type f -executable 2>/dev/null | head -1)
fi

if [ -z "$APP" ] || [ ! -f "$APP" ]; then
  echo "Error: TradingView not found."
  echo "Checked: /opt/TradingView, ~/.local/share/TradingView, snap, flatpak, PATH"
  echo ""
  echo "If installed elsewhere, run manually:"
  echo "  /path/to/tradingview --remote-debugging-port=$PORT"
  exit 1
fi

# Kill any existing TradingView
pkill -x TradingView 2>/dev/null
pkill -x tradingview 2>/dev/null
sleep 1

echo "Found TradingView at: $APP"
echo "Launching with --remote-debugging-port=$PORT ..."
"$APP" --remote-debugging-port=$PORT &
TV_PID=$!
echo "PID: $TV_PID"

# Wait for CDP to be ready
echo "Waiting for CDP..."
for i in $(seq 1 15); do
  if curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:$PORT/json/version" -o "$TV_COMPATIBILITY_RESPONSE_FILE" 2>/dev/null; then
    echo "CDP ready at http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 1
done

echo "Warning: CDP not responding after 15s. TradingView may still be loading."
