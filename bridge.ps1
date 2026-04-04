#Requires -Version 5.1
<#
.SYNOPSIS
    Patchnet Agent Bridge CLI - single entry point for all bridge operations.

.NOTES
    Interactive:  powershell -ExecutionPolicy Bypass -File bridge.ps1
    Scriptable:   powershell -ExecutionPolicy Bypass -File bridge.ps1 <command> [args]

    Commands: start, stop, restart, status, logs, config, teams, setup, doctor, help
#>

param(
    [Parameter(Position=0)]
    [string]$Command,
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$CommandArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$rootDir   = $PSScriptRoot
$envFile   = Join-Path $rootDir ".env"
$pidFile   = Join-Path $rootDir "bridge.pid"
$modesFile = Join-Path $rootDir "channel-modes.json"
$logFile   = Join-Path $rootDir "bridge.log"
$errFile   = Join-Path $rootDir "bridge-error.log"
$pkgFile   = Join-Path $rootDir "package.json"
$maxLogSizeKB = 512

$bridgeVersion = "unknown"
if (Test-Path $pkgFile) {
    try { $bridgeVersion = (Get-Content $pkgFile -Raw | ConvertFrom-Json).version } catch {}
}

# Helpers

function Write-Banner {
    Write-Host ""
    Write-Host "    ____        __       __               __  " -ForegroundColor Blue
    Write-Host "   / __ \____ _/ /______/ /_  ____  ___  / /_" -ForegroundColor Blue
    Write-Host "  / /_/ / __ ``/ __/ ___/ __ \/ __ \/ _ \/ __/" -ForegroundColor DarkCyan
    Write-Host " / ____/ /_/ / /_/ /__/ / / / / / /  __/ /_  " -ForegroundColor DarkYellow
    Write-Host "/_/    \__,_/\__/\___/_/ /_/_/ /_/\___/\__/  " -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  ------------------------------------------------" -ForegroundColor DarkGray
    Write-Host "  Agent Bridge" -NoNewline -ForegroundColor White
    Write-Host " v$bridgeVersion" -NoNewline -ForegroundColor DarkGray
    Write-Host "  for OpenClaw and Microsoft Teams" -ForegroundColor DarkGray
    Write-Host "  ------------------------------------------------" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Built with " -NoNewline -ForegroundColor DarkGray; Write-Host ([char]0x2764) -NoNewline -ForegroundColor Red; Write-Host " by Patchnet  |  Powered by OpenClaw" -ForegroundColor DarkGray
    Write-Host "  Not affiliated with or endorsed by Microsoft Corporation." -ForegroundColor DarkGray
    Write-Host ""
}

function Write-Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  $msg" -ForegroundColor Red }
function Write-Dim($msg)  { Write-Host "  $msg" -ForegroundColor DarkGray }

function Load-Env {
    $env = @{}
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            $line = $_.Trim()
            if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
                $parts = $line -split '=', 2
                $env[$parts[0].Trim()] = $parts[1].Trim()
            }
        }
    }
    return $env
}

function Save-EnvValue($key, $value) {
    if (-not (Test-Path $envFile)) {
        Write-Err ".env file not found. Run 'setup' first."
        return
    }
    $lines = Get-Content $envFile
    $found = $false
    $updated = $lines | ForEach-Object {
        if ($_ -match "^$key=") {
            $found = $true
            "$key=$value"
        } else {
            $_
        }
    }
    if (-not $found) {
        $updated += "$key=$value"
    }
    Set-Content -Path $envFile -Value $updated -Encoding UTF8
}

function Get-BridgeStatus {
    if (-not (Test-Path $pidFile)) { return $null }
    $bridgePid = (Get-Content $pidFile).Trim()
    try {
        $proc = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'node') { return $proc }
    } catch {}
    return $null
}

function Show-Help {
    Write-Host ""
    Write-Host "  Commands:" -ForegroundColor White
    Write-Host "    start       " -NoNewline -ForegroundColor Yellow; Write-Host "Start the bridge (stops existing first)"
    Write-Host "    stop        " -NoNewline -ForegroundColor Yellow; Write-Host "Stop the bridge"
    Write-Host "    restart     " -NoNewline -ForegroundColor Yellow; Write-Host "Restart the bridge"
    Write-Host "    status      " -NoNewline -ForegroundColor Yellow; Write-Host "Show bridge process status"
    Write-Host "    config      " -NoNewline -ForegroundColor Yellow; Write-Host "Show current configuration"
    Write-Host "    teams       " -NoNewline -ForegroundColor Yellow; Write-Host "List teams and channel modes"
    Write-Host "    set         " -NoNewline -ForegroundColor Yellow; Write-Host "Modify a config value"
    Write-Host "    setup       " -NoNewline -ForegroundColor Yellow; Write-Host "Run first-time setup / re-auth"
    Write-Host "    logs        " -NoNewline -ForegroundColor Yellow; Write-Host "Tail bridge output (Ctrl+C to stop)"
    Write-Host "    doctor      " -NoNewline -ForegroundColor Yellow; Write-Host "Run health checks"
    Write-Host "    help        " -NoNewline -ForegroundColor Yellow; Write-Host "Show this menu"
    Write-Host "    exit        " -NoNewline -ForegroundColor Yellow; Write-Host "Exit the CLI"
    Write-Host ""
}

function Show-Status {
    $proc = Get-BridgeStatus
    if ($proc) {
        $uptime = (Get-Date) - $proc.StartTime
        $hours = [math]::Floor($uptime.TotalHours)
        $mins  = $uptime.Minutes
        Write-Ok "Bridge is running (PID $($proc.Id))"
        Write-Dim "  Started: $($proc.StartTime.ToString('yyyy-MM-dd HH:mm:ss'))"
        Write-Dim "  Uptime:  ${hours}h ${mins}m"
    } else {
        Write-Warn "Bridge is not running"
    }
}

function Show-Config {
    $cfg = Load-Env
    Write-Host ""
    Write-Host "  Configuration" -ForegroundColor White
    Write-Host "  -------------" -ForegroundColor DarkGray

    # Safe values
    Write-Host "  Log Level         : " -NoNewline; Write-Host $(if ($cfg['LOG_LEVEL']) { $cfg['LOG_LEVEL'] } else { 'full' }) -ForegroundColor White
    Write-Host "  Bot User ID       : " -NoNewline; Write-Host $(if ($cfg['BOT_USER_ID']) { $cfg['BOT_USER_ID'] } else { '(not set)' }) -ForegroundColor White
    Write-Host "  OpenClaw URL      : " -NoNewline; Write-Host $(if ($cfg['OPENCLAW_URL']) { $cfg['OPENCLAW_URL'] } else { '(not set)' }) -ForegroundColor White
    Write-Host "  Agent ID          : " -NoNewline; Write-Host $(if ($cfg['OPENCLAW_AGENT_ID']) { $cfg['OPENCLAW_AGENT_ID'] } else { 'main' }) -ForegroundColor White
    Write-Host "  DM Poll (ms)      : " -NoNewline; Write-Host $(if ($cfg['POLL_INTERVAL_MS']) { $cfg['POLL_INTERVAL_MS'] } else { '5000' }) -ForegroundColor White
    Write-Host "  Allowed Users     : " -NoNewline; Write-Host $(if ($cfg['ALLOWED_USERS']) { $cfg['ALLOWED_USERS'] } else { '(all)' }) -ForegroundColor White
    Write-Host ""

    # Channel config
    Write-Host "  Channel Poll (ms) : " -NoNewline; Write-Host $(if ($cfg['CHANNEL_POLL_INTERVAL_MS']) { $cfg['CHANNEL_POLL_INTERVAL_MS'] } else { '10000' }) -ForegroundColor White
    Write-Host "  Channel Manager   : " -NoNewline; Write-Host $(if ($cfg['CHANNEL_MANAGER']) { $cfg['CHANNEL_MANAGER'] } else { '(not set)' }) -ForegroundColor White
    Write-Host ""

    # Email config
    Write-Host "  Email Mode        : " -NoNewline; Write-Host $(if ($cfg['EMAIL_MODE']) { $cfg['EMAIL_MODE'] } else { 'off' }) -ForegroundColor White
    Write-Host "  Bot Email         : " -NoNewline; Write-Host $(if ($cfg['BOT_EMAIL']) { $cfg['BOT_EMAIL'] } else { '(not set)' }) -ForegroundColor White
    Write-Host "  Email Poll (ms)   : " -NoNewline; Write-Host $(if ($cfg['EMAIL_POLL_INTERVAL_MS']) { $cfg['EMAIL_POLL_INTERVAL_MS'] } else { '15000' }) -ForegroundColor White
    Write-Host "  Email Whitelist   : " -NoNewline; Write-Host $(if ($cfg['EMAIL_WHITELIST']) { $cfg['EMAIL_WHITELIST'] } else { '(none - all sends blocked)' }) -ForegroundColor White
    Write-Host ""

    # Sensitive values - show presence only
    Write-Host "  Tenant ID         : " -NoNewline; Write-Host ($(if ($cfg['TENANT_ID']) { $cfg['TENANT_ID'].Substring(0,8) + '...' } else { '(not set)' })) -ForegroundColor DarkGray
    Write-Host "  Client ID         : " -NoNewline; Write-Host ($(if ($cfg['CLIENT_ID']) { $cfg['CLIENT_ID'].Substring(0,8) + '...' } else { '(not set)' })) -ForegroundColor DarkGray
    Write-Host "  Client Secret     : " -NoNewline; Write-Host ($(if ($cfg['CLIENT_SECRET']) { '********' } else { '(not set)' })) -ForegroundColor DarkGray
    Write-Host "  Refresh Token     : " -NoNewline; Write-Host ($(if ($cfg['REFRESH_TOKEN']) { '********' } else { '(not set)' })) -ForegroundColor DarkGray
    Write-Host "  OpenClaw Token    : " -NoNewline; Write-Host ($(if ($cfg['OPENCLAW_TOKEN']) { '********' } else { '(not set)' })) -ForegroundColor DarkGray
    Write-Host ""
}

function Show-Teams {
    if (-not (Test-Path $modesFile)) {
        Write-Warn "No teams detected yet. Start the bridge first."
        return
    }
    try {
        $modes = Get-Content $modesFile -Raw | ConvertFrom-Json
        $teams = @($modes.PSObject.Properties)
        if ($teams.Length -eq 0) {
            Write-Warn "No teams detected yet."
            return
        }
        Write-Host ""
        Write-Host "  Teams and Channel Modes" -ForegroundColor White
        Write-Host "  -----------------------" -ForegroundColor DarkGray
        foreach ($team in $teams) {
            $info = $team.Value
            $modeColor = switch ($info.mode) {
                'open'    { 'Green' }
                'managed' { 'Yellow' }
                'monitor' { 'DarkGray' }
                default   { 'White' }
            }
            Write-Host "  $($info.name)" -NoNewline -ForegroundColor White
            Write-Host " - " -NoNewline
            Write-Host $info.mode -ForegroundColor $modeColor
            Write-Dim "    Set by $($info.setBy) on $($info.setAt.Substring(0,10))"
        }
        Write-Host ""
    } catch {
        Write-Err "Failed to read channel-modes.json: $_"
    }
}

function Set-ConfigValue {
    $settable = @(
        'ALLOWED_USERS',
        'CHANNEL_MANAGER',
        'CHANNEL_POLL_INTERVAL_MS',
        'POLL_INTERVAL_MS',
        'EMAIL_MODE',
        'EMAIL_WHITELIST',
        'EMAIL_POLL_INTERVAL_MS',
        'BOT_EMAIL',
        'OPENCLAW_AGENT_ID',
        'LOG_LEVEL'
    )

    Write-Host ""
    Write-Host "  Editable settings:" -ForegroundColor White
    for ($i = 0; $i -lt $settable.Count; $i++) {
        $cfg = Load-Env
        $val = $cfg[$settable[$i]]
        Write-Host "    $($i + 1). $($settable[$i])" -NoNewline -ForegroundColor Yellow
        Write-Host " = $(if ($val) { $val } else { '(empty)' })" -ForegroundColor DarkGray
    }
    Write-Host ""

    $choice = (Read-Host "  Enter number (or name) to edit, or 'back' to cancel").Trim()
    if ($choice -eq 'back' -or $choice -eq '') { return }

    $key = $null
    if ($choice -match '^\d+$') {
        $idx = [int]$choice - 1
        if ($idx -ge 0 -and $idx -lt $settable.Count) { $key = $settable[$idx] }
    } else {
        $upper = $choice.ToUpper()
        if ($settable -contains $upper) { $key = $upper }
    }

    if (-not $key) {
        Write-Err "Invalid selection."
        return
    }

    $cfg = Load-Env
    $current = $cfg[$key]
    Write-Host "  Current value: $(if ($current) { $current } else { '(empty)' })" -ForegroundColor DarkGray
    $newVal = (Read-Host "  New value for $key (blank to clear)").Trim()

    Save-EnvValue $key $newVal
    Write-Ok "$key updated. Restart the bridge for changes to take effect."
}

function Rotate-Log {
    if (Test-Path $logFile) {
        $size = (Get-Item $logFile).Length / 1KB
        if ($size -gt $maxLogSizeKB) {
            # Keep last ~10 min of logs, overwrite the rest
            $lines = Get-Content $logFile -Tail 200
            Set-Content -Path $logFile -Value $lines -Encoding UTF8
            Write-Dim "  Log rotated (was $([math]::Round($size))KB)"
        }
    }
}

function Do-Start {
    # Pre-flight checks
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Err "Node.js not found. Install from https://nodejs.org/"
        return
    }
    if (-not (Test-Path (Join-Path $rootDir "node_modules"))) {
        Write-Err "node_modules not found. Run 'npm install' in the bridge directory first."
        return
    }
    if (-not (Test-Path (Join-Path $rootDir ".env"))) {
        Write-Err ".env file not found. Run 'setup' first."
        return
    }

    & "$rootDir\scripts\stop.ps1"
    Write-Host ""
    Rotate-Log

    # Start node in background, redirect output to log file
    $proc = Start-Process node -ArgumentList "index.js" `
        -WorkingDirectory $rootDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError $errFile `
        -PassThru

    # Write PID file (bridge also writes one, but this catches the gap)
    Set-Content -Path $pidFile -Value $proc.Id -Encoding UTF8

    Write-Ok "Bridge started (PID $($proc.Id))"
    Write-Dim "  Log file: $logFile"
    Write-Dim "  Type 'logs' to tail output, 'status' to check"
}

function Do-Stop {
    & "$rootDir\scripts\stop.ps1"
}

function Do-Setup {
    & powershell -ExecutionPolicy Bypass -File "$rootDir\scripts\setup-bridge.ps1"
}

# Non-interactive helpers (scriptable / SSH-friendly)

function Show-CliHelp {
    Write-Host ""
    Write-Host "  Patchnet Agent Bridge CLI v$bridgeVersion" -ForegroundColor White
    Write-Host "  -------------------------" -ForegroundColor DarkGray
    Write-Host "  Usage: bridge.ps1 <command> [args]"
    Write-Host ""
    Write-Host "  Commands:" -ForegroundColor White
    Write-Host "    start                        Start the bridge in the background"
    Write-Host "    stop                         Stop the bridge"
    Write-Host "    restart                      Stop then start"
    Write-Host "    status                       Show state (exit 0 if running, 1 if not)"
    Write-Host "    logs [--tail N] [--follow]   Print last N lines (default 100), or follow"
    Write-Host "    config                       Show full configuration"
    Write-Host "    config get <KEY>             Print a single config value"
    Write-Host "    config set <KEY> <VALUE>     Update a config value (allowlist enforced)"
    Write-Host "    teams                        List teams and channel modes"
    Write-Host "    setup                        Run interactive setup / re-auth"
    Write-Host "    doctor                       Run health checks"
    Write-Host "    help                         Show this help"
    Write-Host ""
    Write-Host "  Run with no arguments for interactive mode." -ForegroundColor DarkGray
    Write-Host ""
}

function Get-StatusLine {
    $proc = Get-BridgeStatus
    if ($proc) {
        $uptime = (Get-Date) - $proc.StartTime
        $h = [math]::Floor($uptime.TotalHours)
        $m = $uptime.Minutes
        [Console]::WriteLine("running pid=$($proc.Id) uptime=${h}h${m}m log=$logFile")
        return 0
    } else {
        [Console]::WriteLine("stopped")
        return 1
    }
}

function Do-ConfigGet {
    param([string]$Key)
    if (-not $Key) {
        Write-Err "Usage: bridge config get <KEY>"
        return 2
    }
    $upperKey = $Key.ToUpper()
    $secrets = @('TENANT_ID','CLIENT_ID','CLIENT_SECRET','REFRESH_TOKEN','OPENCLAW_TOKEN')
    if ($secrets -contains $upperKey) {
        Write-Err "Key '$Key' is sensitive and cannot be read via config get"
        return 2
    }
    $cfg = Load-Env
    if ($cfg.ContainsKey($upperKey) -and $cfg[$upperKey]) {
        [Console]::WriteLine($cfg[$upperKey])
        return 0
    }
    return 1
}

function Do-ConfigSet {
    param([string]$Key, [string]$Value)
    $settable = @(
        'ALLOWED_USERS','CHANNEL_MANAGER','CHANNEL_POLL_INTERVAL_MS','POLL_INTERVAL_MS',
        'EMAIL_MODE','EMAIL_WHITELIST','EMAIL_POLL_INTERVAL_MS','BOT_EMAIL',
        'OPENCLAW_AGENT_ID','LOG_LEVEL'
    )
    if (-not $Key) {
        Write-Err "Usage: bridge config set <KEY> <VALUE>"
        return 2
    }
    $upperKey = $Key.ToUpper()
    if ($settable -notcontains $upperKey) {
        Write-Err "Key '$Key' is not settable. Allowed: $($settable -join ', ')"
        return 2
    }
    Save-EnvValue $upperKey $Value
    Write-Ok "$upperKey updated. Restart the bridge for changes to take effect."
    return 0
}

function Do-LogsTail {
    param([int]$Lines = 100, [switch]$Follow)
    if (-not (Test-Path $logFile)) {
        Write-Err "No log file at $logFile"
        return 1
    }
    if ($Follow) {
        Get-Content $logFile -Wait -Tail $Lines
    } else {
        Get-Content $logFile -Tail $Lines
    }
    return 0
}

function Do-Doctor {
    $issues = 0
    Write-Host ""
    Write-Host "  Doctor" -ForegroundColor White
    Write-Host "  ------" -ForegroundColor DarkGray

    if (Get-Command node -ErrorAction SilentlyContinue) {
        $nodeVer = & node --version
        Write-Ok "Node.js: $nodeVer"
    } else {
        Write-Err "Node.js: not found"
        $issues++
    }

    if (Test-Path (Join-Path $rootDir "node_modules")) {
        Write-Ok "node_modules: present"
    } else {
        Write-Err "node_modules: missing (run 'npm install')"
        $issues++
    }

    if (Test-Path $envFile) {
        Write-Ok ".env: present"
    } else {
        Write-Err ".env: missing (run 'bridge setup')"
        $issues++
    }

    $cfg = Load-Env
    $required = @('TENANT_ID','CLIENT_ID','OPENCLAW_URL','OPENCLAW_TOKEN','BOT_USER_ID')
    foreach ($key in $required) {
        if ($cfg[$key]) { Write-Ok "${key}: set" }
        else { Write-Err "${key}: missing"; $issues++ }
    }

    $identityFile = Join-Path $env:USERPROFILE ".openclaw\identity\device.json"
    if (Test-Path $identityFile) {
        Write-Ok "OpenClaw identity: present"
    } else {
        Write-Warn "OpenClaw identity: missing at $identityFile"
    }

    $proc = Get-BridgeStatus
    if ($proc) { Write-Ok "Bridge process: running (PID $($proc.Id))" }
    else { Write-Dim "Bridge process: not running" }

    if ($cfg['OPENCLAW_URL']) {
        try {
            $uri = [System.Uri]$cfg['OPENCLAW_URL']
            $tcp = [System.Net.Sockets.TcpClient]::new()
            $task = $tcp.ConnectAsync($uri.Host, $uri.Port)
            if ($task.Wait(2000) -and $tcp.Connected) { Write-Ok "OpenClaw reachable: $($uri.Host):$($uri.Port)" }
            else { Write-Warn "OpenClaw unreachable: $($uri.Host):$($uri.Port)" }
            $tcp.Close()
        } catch { Write-Warn "OpenClaw reachability check failed" }
    }

    Write-Host ""
    if ($issues -eq 0) {
        Write-Ok "Doctor: all checks passed"
        return 0
    } else {
        Write-Err "Doctor: $issues issue(s) found"
        return 1
    }
}

function Invoke-BridgeCommand {
    param([string]$Cmd, [string[]]$Rest)
    if (-not $Rest) { $Rest = @() }
    switch ($Cmd.ToLower()) {
        'start'   { Do-Start; return 0 }
        'stop'    { Do-Stop; return 0 }
        'restart' { Do-Stop; Write-Host ""; Do-Start; return 0 }
        'status'  { return (Get-StatusLine) }
        'logs'    {
            $lines = 100
            $follow = $false
            for ($i = 0; $i -lt $Rest.Count; $i++) {
                if ($Rest[$i] -eq '--tail' -and ($i + 1) -lt $Rest.Count) {
                    $lines = [int]$Rest[$i + 1]; $i++
                } elseif ($Rest[$i] -eq '--follow' -or $Rest[$i] -eq '-f') {
                    $follow = $true
                }
            }
            return (Do-LogsTail -Lines $lines -Follow:$follow)
        }
        'config'  {
            if ($Rest.Count -eq 0) { Show-Config; return 0 }
            $sub = $Rest[0].ToLower()
            if ($sub -eq 'get' -and $Rest.Count -ge 2) {
                return (Do-ConfigGet $Rest[1])
            } elseif ($sub -eq 'set' -and $Rest.Count -ge 2) {
                $key = $Rest[1]
                $value = if ($Rest.Count -ge 3) { ($Rest[2..($Rest.Count - 1)] -join ' ') } else { '' }
                return (Do-ConfigSet $key $value)
            } else {
                Write-Err "Usage: bridge config [get <KEY> | set <KEY> <VALUE>]"
                return 2
            }
        }
        'teams'   { Show-Teams; return 0 }
        'setup'   { Do-Setup; return 0 }
        'doctor'  { return (Do-Doctor) }
        'help'    { Show-CliHelp; return 0 }
        default   {
            Write-Err "Unknown command: $Cmd"
            Show-CliHelp
            return 2
        }
    }
}

# Non-interactive dispatch — if command passed as arg, run and exit

if ($Command) {
    $result = @(Invoke-BridgeCommand -Cmd $Command -Rest $CommandArgs)
    $exitCode = 0
    if ($result.Count -gt 0) {
        try { $exitCode = [int]($result[-1]) } catch { $exitCode = 0 }
    }
    exit $exitCode
}

# Interactive loop

Write-Banner
Show-Help

while ($true) {
    Write-Host ""
    $cmd = (Read-Host "bridge").Trim().ToLower()

    switch ($cmd) {
        'start'   { Do-Start; break }
        'stop'    { Do-Stop; break }
        'restart' { Do-Stop; Write-Host ""; Do-Start; break }
        'status'  { Show-Status; break }
        'config'  { Show-Config; break }
        'teams'   { Show-Teams; break }
        'set'     { Set-ConfigValue; break }
        'setup'   { Do-Setup; break }
        'logs'    {
            if (Test-Path $logFile) {
                Write-Dim "  Tailing $logFile (Ctrl+C to return to prompt)"
                Write-Host ""
                try { Get-Content $logFile -Wait -Tail 50 }
                catch { }
            } else {
                Write-Warn "No log file found. Start the bridge first."
            }
            break
        }
        'doctor'  { Do-Doctor | Out-Null; break }
        'help'    { Show-Help; break }
        'exit'    { Write-Ok "Bye."; exit 0 }
        'quit'    { Write-Ok "Bye."; exit 0 }
        ''        { break }
        default   { Write-Warn "Unknown command: $cmd. Type 'help' for options." }
    }
}
