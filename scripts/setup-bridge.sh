#!/usr/bin/env bash
# One-time setup for Patchnet Agent Bridge.
# - Verifies Node.js and npm packages
# - Prompts for all required credentials
# - Runs the OAuth2 authorization code flow to obtain a delegated refresh token
# - Writes a complete .env file
#
# Run from the project root: ./scripts/setup-bridge.sh
#
# The bot account login MUST be completed as the dedicated bot user
# (e.g., pnet1aigent@patchnet.net) -- NOT your personal account.

set -euo pipefail

REDIRECT_PORT=3000
REDIRECT_URI="http://localhost:$REDIRECT_PORT/callback"
SCOPES="Chat.ReadWrite User.Read Presence.ReadWrite offline_access"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

step()  { echo -e "\n${CYAN}[$1] $2${NC}"; }
ok()    { echo -e "    ${GREEN}$1${NC}"; }
warn()  { echo -e "    ${YELLOW}!! $1 !!${NC}"; }
info()  { echo "    $1"; }
err()   { echo -e "    ${RED}$1${NC}"; }

prompt() {
    local label="$1" default="${2:-}"
    if [ -n "$default" ]; then
        read -rp "  $label [$default]: " value
        echo "${value:-$default}"
    else
        read -rp "  $label: " value
        echo "$value"
    fi
}

# ── 1. Check Node.js ─────────────────────────────────────────────────────

step "1/9" "Checking Node.js"

if ! command -v node &>/dev/null; then
    err "Node.js not found. Install from https://nodejs.org"
    exit 1
fi

node_ver=$(node --version)
node_major=$(echo "$node_ver" | sed 's/^v//' | cut -d. -f1)
if [ "$node_major" -lt 18 ]; then
    err "Node.js 18+ required. Found: $node_ver"
    exit 1
fi
ok "Node.js $node_ver"

# ── 2. npm install ───────────────────────────────────────────────────────

step "2/9" "Checking npm packages"

cd "$ROOT_DIR"
if [ ! -d "node_modules" ]; then
    info "node_modules not found -- running npm install"
    npm install
else
    ok "node_modules present -- skipping"
fi

# ── 3. Prompt for credentials ────────────────────────────────────────────

step "3/9" "Azure AD credentials"
info "Find these in Azure Portal -> App registrations -> your app"
echo ""

tenant_id=$(prompt "TENANT_ID       (Azure AD -> Overview -> Tenant ID)")
client_id=$(prompt "CLIENT_ID       (App registrations -> Application (client) ID)")
client_secret=$(prompt "CLIENT_SECRET   (Certificates & secrets -> client secret Value)")
bot_user_id=$(prompt "BOT_USER_ID     (Entra ID -> Users -> bot account -> Object ID)")

echo ""
info "OpenClaw Gateway"

openclaw_url=$(prompt "OPENCLAW_URL" "ws://127.0.0.1:18789")
openclaw_token=$(prompt "OPENCLAW_TOKEN  (from openclaw.json -> gateway.auth.token)")
openclaw_agent_id=$(prompt "OPENCLAW_AGENT_ID" "main")

echo ""
info "Access Control"

allowed_users=$(prompt "ALLOWED_USERS   (comma-separated UPNs or Entra object IDs; blank = allow all)")

echo ""
info "Email Integration (optional - press Enter to skip)"
info "  Modes: off = disabled, read = inbox only, full = inbox + send/reply"

email_mode=$(prompt "EMAIL_MODE" "off")
email_mode=$(echo "$email_mode" | tr '[:upper:]' '[:lower:]')

bot_email=""
email_whitelist=""
email_poll_ms="15000"

if [ "$email_mode" != "off" ]; then
    bot_email=$(prompt "BOT_EMAIL       (bot account email, e.g. bot@yourdomain.com)")

    if [ "$email_mode" = "full" ]; then
        info "  Whitelist formats: user@domain.com, *@domain.com, domain.com, * (bot domain)"
        email_whitelist=$(prompt "EMAIL_WHITELIST (comma-separated; blank = block all sends)")
        email_poll_input=$(prompt "EMAIL_POLL_INTERVAL_MS" "15000")
        email_poll_ms="${email_poll_input:-15000}"
    fi

    if [ "$email_mode" = "full" ]; then
        warn "Ensure Mail.ReadWrite + Mail.Send is consented on the app registration"
    else
        warn "Ensure Mail.ReadWrite is consented on the app registration"
    fi
fi

echo ""
info "Teams Channels (optional - press Enter to skip)"
info "  The bot auto-detects teams it belongs to. Set a manager to control channel modes."

channel_manager=$(prompt "CHANNEL_MANAGER (Entra object ID of manager; blank = no channel management)")

channel_poll_ms="10000"
if [ -n "$channel_manager" ]; then
    channel_poll_input=$(prompt "CHANNEL_POLL_INTERVAL_MS" "10000")
    channel_poll_ms="${channel_poll_input:-10000}"
    info "  Manager will receive notifications when bot is added to new teams."
    info "  All teams default to monitor mode. Manager elevates via DM."
fi

# ── 4. Start local HTTP listener ─────────────────────────────────────────

step "4/9" "Starting local OAuth callback listener on port $REDIRECT_PORT"

# Use Python's built-in HTTP server to capture the OAuth callback
# Works on macOS and Linux without additional dependencies
CALLBACK_FILE=$(mktemp)

python3 -c "
import http.server, urllib.parse, sys, threading

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        code = query.get('code', [''])[0]
        error = query.get('error', [''])[0]

        if code:
            html = '<html><body style=\"font-family:sans-serif;padding:40px\"><h2 style=\"color:green\">&#10003; Auth successful</h2><p>You can close this tab and return to the setup script.</p></body></html>'
        else:
            html = f'<html><body style=\"font-family:sans-serif;padding:40px\"><h2 style=\"color:red\">&#10007; Auth failed</h2><p>Error: {error}</p></body></html>'

        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(html.encode())

        with open('$CALLBACK_FILE', 'w') as f:
            f.write(code if code else f'ERROR:{error}')

        threading.Thread(target=lambda: self.server.shutdown()).start()

    def log_message(self, *args):
        pass

server = http.server.HTTPServer(('127.0.0.1', $REDIRECT_PORT), Handler)
server.serve_forever()
" &
LISTENER_PID=$!

# Give the listener a moment to start
sleep 1

if kill -0 "$LISTENER_PID" 2>/dev/null; then
    ok "Listener ready at http://localhost:$REDIRECT_PORT/"
else
    err "Could not start HTTP listener on port $REDIRECT_PORT -- is something else using that port?"
    exit 1
fi

# ── 5. Open browser for bot account login ────────────────────────────────

step "5/9" "Opening browser for bot account login"
warn "Log in as the BOT ACCOUNT -- NOT your personal account"

encoded_redirect=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$REDIRECT_URI', safe=''))")
encoded_scopes=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$SCOPES', safe=''))")

auth_url="https://login.microsoftonline.com/$tenant_id/oauth2/v2.0/authorize?client_id=$client_id&response_type=code&redirect_uri=$encoded_redirect&scope=$encoded_scopes&response_mode=query&prompt=login"

# Open browser (cross-platform)
if command -v open &>/dev/null; then
    open "$auth_url"  # macOS
elif command -v xdg-open &>/dev/null; then
    xdg-open "$auth_url"  # Linux
else
    echo ""
    info "Could not detect browser. Open this URL manually:"
    echo "  $auth_url"
fi

ok "Browser launched -- complete the login, then return here"

# ── 6. Wait for OAuth callback ───────────────────────────────────────────

step "6/9" "Waiting for OAuth callback"
info "Waiting for browser redirect... (complete the login)"

# Wait for the Python listener to finish
wait "$LISTENER_PID" 2>/dev/null || true

auth_code=$(cat "$CALLBACK_FILE")
rm -f "$CALLBACK_FILE"

if [ -z "$auth_code" ] || [[ "$auth_code" == ERROR:* ]]; then
    err "No auth code received. Error: ${auth_code#ERROR:}"
    exit 1
fi

ok "Auth code received"

# ── 7. Exchange auth code for refresh token ──────────────────────────────

step "7/9" "Exchanging auth code for tokens"

token_endpoint="https://login.microsoftonline.com/$tenant_id/oauth2/v2.0/token"

token_response=$(curl -s -X POST "$token_endpoint" \
    -d "client_id=$client_id" \
    -d "client_secret=$client_secret" \
    -d "code=$auth_code" \
    -d "redirect_uri=$REDIRECT_URI" \
    -d "grant_type=authorization_code" \
    -d "scope=$SCOPES")

refresh_token=$(echo "$token_response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('refresh_token',''))" 2>/dev/null)

if [ -z "$refresh_token" ]; then
    err "No refresh_token in response. Ensure 'offline_access' scope was granted and admin consent is complete."
    echo "$token_response"
    exit 1
fi

ok "Access token and refresh token obtained"

# ── 8. Write .env ────────────────────────────────────────────────────────

step "8/9" "Writing .env"

env_path="$ROOT_DIR/.env"
timestamp=$(date '+%Y-%m-%d %H:%M')

cat > "$env_path" << ENVEOF
# Teams <-> OpenClaw Bridge -- Configuration
# Generated by setup-bridge.sh on $timestamp
# NEVER commit this file to git.

# Azure AD
TENANT_ID=$tenant_id
CLIENT_ID=$client_id
CLIENT_SECRET=$client_secret

# Bot Account
# Refresh token obtained via OAuth2 auth code flow -- auto-rotates on every use.
# As long as the bridge runs at least once every 90 days this never expires.
REFRESH_TOKEN=$refresh_token
BOT_USER_ID=$bot_user_id

# OpenClaw Gateway
OPENCLAW_URL=$openclaw_url
OPENCLAW_TOKEN=$openclaw_token
OPENCLAW_AGENT_ID=$openclaw_agent_id

# Polling
POLL_INTERVAL_MS=5000

# Access Control
# Comma-separated UPNs or Entra object IDs. Blank = allow all (not recommended).
ALLOWED_USERS=$allowed_users

# Email Integration
# off = disabled, read = inbox only, full = inbox + send/reply (whitelist-gated)
EMAIL_MODE=$email_mode
BOT_EMAIL=$bot_email
EMAIL_POLL_INTERVAL_MS=$email_poll_ms
EMAIL_WHITELIST=$email_whitelist

# Teams Channels
# Bot auto-detects joined teams. All default to monitor mode.
# Manager controls modes via DM: "teams" to list, "set <name> <mode>" to change.
CHANNEL_POLL_INTERVAL_MS=$channel_poll_ms
CHANNEL_MANAGER=$channel_manager

# Logging
LOG_LEVEL=full
ENVEOF

ok ".env written to: $env_path"

# ── 9. Done ──────────────────────────────────────────────────────────────

step "9/9" "Setup complete"
echo ""
echo -e "${GREEN}==================================================================="
echo " Setup complete."
echo ""
echo -e " To start the bridge:${NC}"
echo "   ./bridge.sh start"
echo ""
echo -e "${GREEN} To stop the bridge:${NC}"
echo "   ./bridge.sh stop"
echo -e "${GREEN}===================================================================${NC}"
