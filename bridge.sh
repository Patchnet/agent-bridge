#!/usr/bin/env bash
# Patchnet Agent Bridge CLI - single entry point for all bridge operations.
# Run from the project root: ./bridge.sh

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
PID_FILE="$ROOT_DIR/bridge.pid"
MODES_FILE="$ROOT_DIR/channel-modes.json"
LOG_FILE="$ROOT_DIR/bridge.log"
ERR_FILE="$ROOT_DIR/bridge-error.log"
MAX_LOG_SIZE_KB=512

# Colors
BLUE='\033[0;34m'
CYAN='\033[0;36m'
DCYAN='\033[0;36m'
DYELLOW='\033[0;33m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
WHITE='\033[1;37m'
DIM='\033[0;90m'
NC='\033[0m'

# ── Helpers ──────────────────────────────────────────────────────────────

write_ok()   { echo -e "  ${GREEN}$1${NC}"; }
write_warn() { echo -e "  ${YELLOW}$1${NC}"; }
write_err()  { echo -e "  ${RED}$1${NC}"; }
write_dim()  { echo -e "  ${DIM}$1${NC}"; }

write_banner() {
    echo ""
    echo -e "  ${BLUE}  ____        __       __               __  ${NC}"
    echo -e "  ${BLUE} / __ \\____ _/ /______/ /_  ____  ___  / /_${NC}"
    echo -e "  ${DCYAN}/ /_/ / __ \`/ __/ ___/ __ \\/ __ \\/ _ \\/ __/${NC}"
    echo -e "  ${DYELLOW}/ ____/ /_/ / /_/ /__/ / / / / / /  __/ /_  ${NC}"
    echo -e "  ${YELLOW}/_/    \\__,_/\\__/\\___/_/ /_/_/ /_/\\___/\\__/  ${NC}"
    echo ""
    echo -e "  ${DIM}------------------------------------------------${NC}"
    echo -e "  ${WHITE}Agent Bridge${NC}  ${DIM}for OpenClaw and Microsoft Teams${NC}"
    echo -e "  ${DIM}------------------------------------------------${NC}"
    echo ""
    echo -e "  ${DIM}Built with ${NC}${RED}♥${NC}${DIM} by Patchnet  |  Powered by OpenClaw${NC}"
    echo -e "  ${DIM}Not affiliated with or endorsed by Microsoft Corporation.${NC}"
    echo ""
}

load_env() {
    if [ -f "$ENV_FILE" ]; then
        while IFS= read -r line; do
            line=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
            [[ -z "$line" || "$line" == \#* ]] && continue
            if [[ "$line" == *=* ]]; then
                key="${line%%=*}"
                value="${line#*=}"
                eval "ENV_${key}=\"${value}\""
            fi
        done < "$ENV_FILE"
    fi
}

get_env() {
    local key="$1" default="${2:-}"
    local var="ENV_${key}"
    echo "${!var:-$default}"
}

save_env_value() {
    local key="$1" value="$2"
    if [ ! -f "$ENV_FILE" ]; then
        write_err ".env file not found. Run 'setup' first."
        return
    fi
    if grep -q "^${key}=" "$ENV_FILE"; then
        # Use a temp file for portability (sed -i differs between macOS and Linux)
        local tmp=$(mktemp)
        sed "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
    else
        echo "${key}=${value}" >> "$ENV_FILE"
    fi
}

get_bridge_status() {
    if [ ! -f "$PID_FILE" ]; then
        return 1
    fi
    local bridge_pid=$(cat "$PID_FILE" | tr -d '[:space:]')
    if kill -0 "$bridge_pid" 2>/dev/null; then
        echo "$bridge_pid"
        return 0
    fi
    return 1
}

# ── Commands ─────────────────────────────────────────────────────────────

show_help() {
    echo ""
    echo -e "  ${WHITE}Commands:${NC}"
    echo -e "    ${YELLOW}start       ${NC}Start the bridge (stops existing first)"
    echo -e "    ${YELLOW}stop        ${NC}Stop the bridge"
    echo -e "    ${YELLOW}restart     ${NC}Restart the bridge"
    echo -e "    ${YELLOW}status      ${NC}Show bridge process status"
    echo -e "    ${YELLOW}config      ${NC}Show current configuration"
    echo -e "    ${YELLOW}teams       ${NC}List teams and channel modes"
    echo -e "    ${YELLOW}set         ${NC}Modify a config value"
    echo -e "    ${YELLOW}setup       ${NC}Run first-time setup / re-auth"
    echo -e "    ${YELLOW}logs        ${NC}Tail bridge output (Ctrl+C to stop)"
    echo -e "    ${YELLOW}help        ${NC}Show this menu"
    echo -e "    ${YELLOW}exit        ${NC}Exit the CLI"
    echo ""
}

show_status() {
    local bridge_pid
    if bridge_pid=$(get_bridge_status); then
        local start_time
        if [[ "$(uname)" == "Darwin" ]]; then
            start_time=$(ps -p "$bridge_pid" -o lstart= 2>/dev/null | xargs)
        else
            start_time=$(ps -p "$bridge_pid" -o lstart= 2>/dev/null | xargs)
        fi
        local elapsed=$(ps -p "$bridge_pid" -o etime= 2>/dev/null | xargs)
        write_ok "Bridge is running (PID $bridge_pid)"
        write_dim "  Started: $start_time"
        write_dim "  Uptime:  $elapsed"
    else
        write_warn "Bridge is not running"
    fi
}

show_config() {
    load_env
    echo ""
    echo -e "  ${WHITE}Configuration${NC}"
    echo -e "  ${DIM}-------------${NC}"

    echo -e "  Log Level         : ${WHITE}$(get_env LOG_LEVEL full)${NC}"
    echo -e "  Bot User ID       : ${WHITE}$(get_env BOT_USER_ID '(not set)')${NC}"
    echo -e "  OpenClaw URL      : ${WHITE}$(get_env OPENCLAW_URL '(not set)')${NC}"
    echo -e "  Agent ID          : ${WHITE}$(get_env OPENCLAW_AGENT_ID main)${NC}"
    echo -e "  DM Poll (ms)      : ${WHITE}$(get_env POLL_INTERVAL_MS 5000)${NC}"
    echo -e "  Allowed Users     : ${WHITE}$(get_env ALLOWED_USERS '(all)')${NC}"
    echo ""
    echo -e "  Channel Poll (ms) : ${WHITE}$(get_env CHANNEL_POLL_INTERVAL_MS 10000)${NC}"
    echo -e "  Channel Manager   : ${WHITE}$(get_env CHANNEL_MANAGER '(not set)')${NC}"
    echo ""
    echo -e "  Email Mode        : ${WHITE}$(get_env EMAIL_MODE off)${NC}"
    echo -e "  Bot Email         : ${WHITE}$(get_env BOT_EMAIL '(not set)')${NC}"
    echo -e "  Email Poll (ms)   : ${WHITE}$(get_env EMAIL_POLL_INTERVAL_MS 15000)${NC}"
    echo -e "  Email Whitelist   : ${WHITE}$(get_env EMAIL_WHITELIST '(none - all sends blocked)')${NC}"
    echo ""

    local tid=$(get_env TENANT_ID '')
    local cid=$(get_env CLIENT_ID '')
    local cs=$(get_env CLIENT_SECRET '')
    local rt=$(get_env REFRESH_TOKEN '')
    local ot=$(get_env OPENCLAW_TOKEN '')

    echo -e "  Tenant ID         : ${DIM}${tid:+${tid:0:8}...}${tid:-(not set)}${NC}"
    echo -e "  Client ID         : ${DIM}${cid:+${cid:0:8}...}${cid:-(not set)}${NC}"
    echo -e "  Client Secret     : ${DIM}${cs:+********}${cs:-(not set)}${NC}"
    echo -e "  Refresh Token     : ${DIM}${rt:+********}${rt:-(not set)}${NC}"
    echo -e "  OpenClaw Token    : ${DIM}${ot:+********}${ot:-(not set)}${NC}"
    echo ""
}

show_teams() {
    if [ ! -f "$MODES_FILE" ]; then
        write_warn "No teams detected yet. Start the bridge first."
        return
    fi

    # Parse JSON with python3 (available on macOS and most Linux)
    python3 -c "
import json, sys
try:
    with open('$MODES_FILE') as f:
        modes = json.load(f)
    if not modes:
        print('  \033[1;33mNo teams detected yet.\033[0m')
        sys.exit(0)
    print()
    print('  \033[1;37mTeams and Channel Modes\033[0m')
    print('  \033[0;90m-----------------------\033[0m')
    colors = {'open': '\033[0;32m', 'managed': '\033[1;33m', 'monitor': '\033[0;90m'}
    for team_id, info in modes.items():
        mode = info.get('mode', 'unknown')
        name = info.get('name', team_id)
        set_by = info.get('setBy', 'unknown')
        set_at = info.get('setAt', '')[:10]
        color = colors.get(mode, '\033[0m')
        print(f'  \033[1;37m{name}\033[0m - {color}{mode}\033[0m')
        print(f'  \033[0;90m    Set by {set_by} on {set_at}\033[0m')
    print()
except Exception as e:
    print(f'  \033[0;31mFailed to read channel-modes.json: {e}\033[0m')
" 2>&1
}

set_config_value() {
    local settable=(
        ALLOWED_USERS
        CHANNEL_MANAGER
        CHANNEL_POLL_INTERVAL_MS
        POLL_INTERVAL_MS
        EMAIL_MODE
        EMAIL_WHITELIST
        EMAIL_POLL_INTERVAL_MS
        BOT_EMAIL
        OPENCLAW_AGENT_ID
        LOG_LEVEL
    )

    load_env
    echo ""
    echo -e "  ${WHITE}Editable settings:${NC}"
    for i in "${!settable[@]}"; do
        local key="${settable[$i]}"
        local val=$(get_env "$key" "")
        local num=$((i + 1))
        echo -e "    ${YELLOW}${num}. ${key}${NC} = ${DIM}${val:-(empty)}${NC}"
    done
    echo ""

    read -rp "  Enter number (or name) to edit, or 'back' to cancel: " choice
    choice=$(echo "$choice" | xargs)
    [[ -z "$choice" || "$choice" == "back" ]] && return

    local key=""
    if [[ "$choice" =~ ^[0-9]+$ ]]; then
        local idx=$((choice - 1))
        if [ "$idx" -ge 0 ] && [ "$idx" -lt "${#settable[@]}" ]; then
            key="${settable[$idx]}"
        fi
    else
        local upper=$(echo "$choice" | tr '[:lower:]' '[:upper:]')
        for s in "${settable[@]}"; do
            if [ "$s" = "$upper" ]; then
                key="$s"
                break
            fi
        done
    fi

    if [ -z "$key" ]; then
        write_err "Invalid selection."
        return
    fi

    local current=$(get_env "$key" "")
    echo -e "  ${DIM}Current value: ${current:-(empty)}${NC}"
    read -rp "  New value for $key (blank to clear): " new_val

    save_env_value "$key" "$new_val"
    write_ok "$key updated. Restart the bridge for changes to take effect."
}

rotate_log() {
    if [ -f "$LOG_FILE" ]; then
        local size_kb=$(du -k "$LOG_FILE" | cut -f1)
        if [ "$size_kb" -gt "$MAX_LOG_SIZE_KB" ]; then
            tail -200 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
            write_dim "  Log rotated (was ${size_kb}KB)"
        fi
    fi
}

do_start() {
    # Pre-flight checks
    if ! command -v node &>/dev/null; then
        write_err "Node.js not found. Install from https://nodejs.org/"
        return
    fi
    if [ ! -d "$ROOT_DIR/node_modules" ]; then
        write_err "node_modules not found. Run 'npm install' in the bridge directory first."
        return
    fi
    if [ ! -f "$ENV_FILE" ]; then
        write_err ".env file not found. Run 'setup' first."
        return
    fi

    "$ROOT_DIR/scripts/stop.sh"
    echo ""
    rotate_log

    # Start node in background
    cd "$ROOT_DIR"
    nohup node index.js > "$LOG_FILE" 2> "$ERR_FILE" &
    local pid=$!
    echo "$pid" > "$PID_FILE"

    write_ok "Bridge started (PID $pid)"
    write_dim "  Log file: $LOG_FILE"
    write_dim "  Type 'logs' to tail output, 'status' to check"
}

do_stop() {
    "$ROOT_DIR/scripts/stop.sh"
}

do_setup() {
    bash "$ROOT_DIR/scripts/setup-bridge.sh"
}

# ── Main loop ────────────────────────────────────────────────────────────

write_banner
show_help

while true; do
    echo ""
    read -rp "bridge: " cmd
    cmd=$(echo "$cmd" | xargs | tr '[:upper:]' '[:lower:]')

    case "$cmd" in
        start)   do_start ;;
        stop)    do_stop ;;
        restart) do_stop; echo ""; do_start ;;
        status)  show_status ;;
        config)  show_config ;;
        teams)   show_teams ;;
        set)     set_config_value ;;
        setup)   do_setup ;;
        logs)
            if [ -f "$LOG_FILE" ]; then
                write_dim "  Tailing $LOG_FILE (Ctrl+C to return to prompt)"
                echo ""
                tail -50f "$LOG_FILE" || true
            else
                write_warn "No log file found. Start the bridge first."
            fi
            ;;
        help)    show_help ;;
        exit|quit) write_ok "Bye."; exit 0 ;;
        "")      ;;
        *)       write_warn "Unknown command: $cmd. Type 'help' for options." ;;
    esac
done
