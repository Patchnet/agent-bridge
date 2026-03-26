#Requires -Version 5.1
<#
.SYNOPSIS
    One-time setup for Patchnet Agent Bridge.

.DESCRIPTION
    - Verifies Node.js and npm packages
    - Prompts for all required credentials
    - Runs the OAuth2 authorization code flow to obtain a delegated refresh token
    - Writes a complete .env file
    - Optionally installs as a Windows service via NSSM

.NOTES
    Run from the project root:
        powershell -ExecutionPolicy Bypass -File scripts\setup-teams-bridge.ps1

    The bot account login MUST be completed as the dedicated bot user
    (e.g., pnet1aigent@patchnet.net) -- NOT your personal account.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$REDIRECT_PORT = 3000
$REDIRECT_URI  = "http://localhost:$REDIRECT_PORT/callback"
$SCOPES        = "Chat.ReadWrite User.Read Presence.ReadWrite offline_access"

$rootDir = Split-Path $PSScriptRoot -Parent

# Helpers

function Write-Step($n, $msg) {
    Write-Host ""
    Write-Host "[$n] $msg" -ForegroundColor Cyan
}

function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    !! $msg !!" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "    $msg" }

# 1. Check Node.js

Write-Step "1/9" "Checking Node.js"

try {
    $nodeRaw = & node --version 2>&1
    $nodeVer = [Version]($nodeRaw -replace '^v', '')
    if ($nodeVer.Major -lt 18) {
        Write-Error "Node.js 18+ required. Found: $nodeRaw. Install from https://nodejs.org"
        exit 1
    }
    Write-Ok "Node.js $nodeRaw"
} catch {
    Write-Error "Node.js not found. Install from https://nodejs.org"
    exit 1
}

# 2. npm install

Write-Step "2/9" "Checking npm packages"

Push-Location $rootDir
if (-not (Test-Path "node_modules")) {
    Write-Info "node_modules not found -- running npm install"
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Error "npm install failed."
        exit 1
    }
} else {
    Write-Ok "node_modules present -- skipping"
}
Pop-Location

# 3. Prompt for credentials

Write-Step "3/9" "Azure AD credentials"
Write-Info "Find these in Azure Portal -> App registrations -> your app"
Write-Host ""

$tenantId     = (Read-Host "  TENANT_ID       (Azure AD -> Overview -> Tenant ID)").Trim()
$clientId     = (Read-Host "  CLIENT_ID       (App registrations -> Application (client) ID)").Trim()
$clientSecret = (Read-Host "  CLIENT_SECRET   (Certificates & secrets -> client secret Value)").Trim()
$botUserId    = (Read-Host "  BOT_USER_ID     (Entra ID -> Users -> bot account -> Object ID -- NOT the app registration ID)").Trim()

Write-Host ""
Write-Info "OpenClaw Gateway"

$openclawUrl = (Read-Host "  OPENCLAW_URL    [ws://127.0.0.1:18789]").Trim()
if (-not $openclawUrl) { $openclawUrl = "ws://127.0.0.1:18789" }

$openclawToken = (Read-Host "  OPENCLAW_TOKEN  (from openclaw.json -> gateway.auth.token)").Trim()

$openclawAgentId = (Read-Host "  OPENCLAW_AGENT_ID [main]").Trim()
if (-not $openclawAgentId) { $openclawAgentId = "main" }

Write-Host ""
Write-Info "Access Control"

$allowedUsers = (Read-Host "  ALLOWED_USERS   (comma-separated UPNs or Entra object IDs; blank = allow all)").Trim()

Write-Host ""
Write-Info "Email Integration (optional - press Enter to skip)"
Write-Info "  Modes: off = disabled, read = inbox only, full = inbox + send/reply"

$emailMode = (Read-Host "  EMAIL_MODE      [off]").Trim().ToLower()
if (-not $emailMode) { $emailMode = "off" }

$botEmail        = ""
$emailWhitelist  = ""
$emailPollMs     = "15000"

if ($emailMode -ne "off") {
    $botEmail = (Read-Host "  BOT_EMAIL       (bot account email, e.g. bot@yourdomain.com)").Trim()

    if ($emailMode -eq "full") {
        Write-Info "  Whitelist formats: user@domain.com, *@domain.com, domain.com, * (bot domain)"
        $emailWhitelist = (Read-Host "  EMAIL_WHITELIST (comma-separated; blank = block all sends)").Trim()

        $emailPollInput = (Read-Host "  EMAIL_POLL_INTERVAL_MS [15000]").Trim()
        if ($emailPollInput) { $emailPollMs = $emailPollInput }
    }

    Write-Warn "Ensure Mail.ReadWrite$(if ($emailMode -eq 'full') { ' + Mail.Send' }) is consented on the app registration"
}

Write-Host ""
Write-Info "Teams Channels (optional - press Enter to skip)"
Write-Info "  The bot auto-detects teams it belongs to. Set a manager to control channel modes."

$channelManager = (Read-Host "  CHANNEL_MANAGER (UPN or Entra object ID of manager; blank = no channel management)").Trim()

$channelPollMs = "10000"
if ($channelManager) {
    $channelPollInput = (Read-Host "  CHANNEL_POLL_INTERVAL_MS [10000]").Trim()
    if ($channelPollInput) { $channelPollMs = $channelPollInput }
    Write-Info "  Manager will receive notifications when bot is added to new teams."
    Write-Info "  All teams default to monitor mode. Manager elevates via DM."
}

# 4. Start local HTTP listener

Write-Step "4/9" "Starting local OAuth callback listener on port $REDIRECT_PORT"

Add-Type -AssemblyName System.Web

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$REDIRECT_PORT/")

try {
    $listener.Start()
    Write-Ok "Listener ready at http://localhost:$REDIRECT_PORT/"
} catch {
    Write-Error "Could not start HTTP listener on port $REDIRECT_PORT -- is something else using that port?"
    exit 1
}

# 5. Open browser for bot account login

Write-Step "5/9" "Opening browser for bot account login"
Write-Warn "Log in as the BOT ACCOUNT -- NOT your personal account"

$encodedRedirect = [Uri]::EscapeDataString($REDIRECT_URI)
$encodedScopes   = [Uri]::EscapeDataString($SCOPES)

$authUrl = "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/authorize" +
           "?client_id=$clientId" +
           "&response_type=code" +
           "&redirect_uri=$encodedRedirect" +
           "&scope=$encodedScopes" +
           "&response_mode=query" +
           "&prompt=login"

# Launch in incognito/private to avoid cached sessions from other accounts
$edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (Test-Path $edgePath) {
    Start-Process $edgePath -ArgumentList "--inprivate", $authUrl
} elseif (Test-Path $chromePath) {
    Start-Process $chromePath -ArgumentList "--incognito", $authUrl
} else {
    Start-Process $authUrl
}
Write-Ok "Browser launched (private/incognito) -- complete the login, then return here"

# 6. Wait for OAuth callback

Write-Step "6/9" "Waiting for OAuth callback"
Write-Info "Waiting for browser redirect... (complete the login)"

$authCode  = $null
$authError = $null

try {
    $context = $listener.GetContext()
    $query   = [System.Web.HttpUtility]::ParseQueryString($context.Request.Url.Query)
    $authCode  = $query["code"]
    $authError = $query["error"]

    $html = if ($authCode) {
        "<html><body style='font-family:sans-serif;padding:40px'><h2 style='color:green'>&#10003; Auth successful</h2><p>You can close this tab and return to the setup script.</p></body></html>"
    } else {
        "<html><body style='font-family:sans-serif;padding:40px'><h2 style='color:red'>&#10007; Auth failed</h2><p>Error: $authError -- $($query['error_description'])</p></body></html>"
    }

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($html)
    $context.Response.ContentType = "text/html"
    $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $context.Response.Close()

} finally {
    $listener.Stop()
    Write-Ok "Listener stopped"
}

if (-not $authCode) {
    Write-Error "No auth code received. Azure error: $authError -- $($query['error_description'])"
    exit 1
}

Write-Ok "Auth code received"

# 7. Exchange auth code for refresh token

Write-Step "7/9" "Exchanging auth code for tokens"

$tokenEndpoint = "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token"

$tokenBody = @{
    client_id     = $clientId
    client_secret = $clientSecret
    code          = $authCode
    redirect_uri  = $REDIRECT_URI
    grant_type    = "authorization_code"
    scope         = $SCOPES
}

try {
    $tokenResponse = Invoke-RestMethod -Method Post -Uri $tokenEndpoint `
        -Body $tokenBody -ContentType "application/x-www-form-urlencoded"
} catch {
    Write-Error "Token exchange failed: $_"
    exit 1
}

$refreshToken = $tokenResponse.refresh_token

if (-not $refreshToken) {
    Write-Error "No refresh_token in response. Ensure 'offline_access' scope was granted and admin consent is complete."
    exit 1
}

Write-Ok "Access token and refresh token obtained"

# 8. Write .env

Write-Step "8/9" "Writing .env"

$envPath    = Join-Path $rootDir ".env"
$timestamp  = Get-Date -Format "yyyy-MM-dd HH:mm"

$envContent = @"
# Teams <-> OpenClaw Bridge -- Configuration
# Generated by setup-teams-bridge.ps1 on $timestamp
# NEVER commit this file to git.

# Azure AD
TENANT_ID=$tenantId
CLIENT_ID=$clientId
CLIENT_SECRET=$clientSecret

# Bot Account
# Refresh token obtained via OAuth2 auth code flow -- auto-rotates on every use.
# As long as the bridge runs at least once every 90 days this never expires.
REFRESH_TOKEN=$refreshToken
BOT_USER_ID=$botUserId

# OpenClaw Gateway
OPENCLAW_URL=$openclawUrl
OPENCLAW_TOKEN=$openclawToken
OPENCLAW_AGENT_ID=$openclawAgentId

# Polling
POLL_INTERVAL_MS=5000

# Access Control
# Comma-separated UPNs or Entra object IDs. Blank = allow all (not recommended).
ALLOWED_USERS=$allowedUsers

# Email Integration
# off = disabled, read = inbox only, full = inbox + send/reply (whitelist-gated)
EMAIL_MODE=$emailMode
BOT_EMAIL=$botEmail
EMAIL_POLL_INTERVAL_MS=$emailPollMs
EMAIL_WHITELIST=$emailWhitelist

# Teams Channels
# Bot auto-detects joined teams. All default to monitor mode.
# Manager controls modes via DM: "teams" to list, "set <name> <mode>" to change.
CHANNEL_POLL_INTERVAL_MS=$channelPollMs
CHANNEL_MANAGER=$channelManager
"@

Set-Content -Path $envPath -Value $envContent -Encoding UTF8
Write-Ok ".env written to: $envPath"

# 9. Done

Write-Step "9/9" "Setup complete"
Write-Host ""
Write-Host "===================================================================" -ForegroundColor Green
Write-Host " Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host " To start the bridge:" -ForegroundColor White
Write-Host "   powershell -ExecutionPolicy Bypass -File scripts\start.ps1"
Write-Host ""
Write-Host " To stop the bridge:" -ForegroundColor White
Write-Host "   powershell -ExecutionPolicy Bypass -File scripts\stop.ps1"
Write-Host "===================================================================" -ForegroundColor Green
