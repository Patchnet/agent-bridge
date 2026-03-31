#!/usr/bin/env bash
# Stop the Patchnet Agent Bridge by PID file.
# Also sweeps for orphaned node processes running index.js as a fallback.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT_DIR/bridge.pid"

killed=0

# Kill by PID file
if [ -f "$PID_FILE" ]; then
    bridge_pid=$(cat "$PID_FILE" | tr -d '[:space:]')
    if kill -0 "$bridge_pid" 2>/dev/null; then
        kill "$bridge_pid" 2>/dev/null && {
            echo "[stop] Killed bridge process (PID $bridge_pid)"
            killed=$((killed + 1))
        }
    else
        echo "[stop] PID $bridge_pid is not running - stale PID file"
    fi
    rm -f "$PID_FILE"
else
    echo "[stop] No bridge.pid found"
fi

# Sweep for orphaned node processes running index.js
orphans=$(pgrep -f 'node.*index\.js.*agent-bridge' 2>/dev/null || true)
for pid in $orphans; do
    # Don't re-kill the one we already got
    if [ "$pid" != "${bridge_pid:-}" ]; then
        kill "$pid" 2>/dev/null && {
            echo "[stop] Killed orphaned bridge process (PID $pid)"
            killed=$((killed + 1))
        }
    fi
done

if [ "$killed" -eq 0 ]; then
    echo "[stop] No bridge processes found"
else
    echo "[stop] Stopped $killed process(es)"
fi
