#!/usr/bin/env bash
# Start the Patchnet Agent Bridge (stops any existing instance first).
# Run from the project root: ./scripts/start.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Stop any existing bridge first
"$ROOT_DIR/scripts/stop.sh"

echo ""
echo "[start] Starting bridge..."

cd "$ROOT_DIR"
node index.js
