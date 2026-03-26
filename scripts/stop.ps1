<#
.SYNOPSIS
    Stop the Patchnet Agent Bridge by PID file.

.DESCRIPTION
    Reads bridge.pid from the project root and kills that specific process.
    Also sweeps for any orphaned node processes running index.js as a fallback.

.NOTES
    Run from anywhere:
        powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$rootDir = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $rootDir "bridge.pid"

$killed = 0

# Kill by PID file

if (Test-Path $pidFile) {
    $bridgePid = (Get-Content $pidFile).Trim()
    try {
        $proc = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'node') {
            Stop-Process -Id $bridgePid -Force
            Write-Host "[stop] Killed bridge process (PID $bridgePid)" -ForegroundColor Green
            $killed++
        } else {
            Write-Host "[stop] PID $bridgePid is not a running node process - stale PID file" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "[stop] Could not kill PID $bridgePid - may already be stopped" -ForegroundColor Yellow
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "[stop] No bridge.pid found" -ForegroundColor Yellow
}

# Sweep for orphaned node processes running index.js

$orphans = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'index\.js' -and $_.CommandLine -match 'agent-bridge' }

foreach ($orphan in $orphans) {
    try {
        Stop-Process -Id $orphan.ProcessId -Force
        Write-Host "[stop] Killed orphaned bridge process (PID $($orphan.ProcessId))" -ForegroundColor Yellow
        $killed++
    } catch {
        Write-Host "[stop] Could not kill orphan PID $($orphan.ProcessId)" -ForegroundColor Yellow
    }
}

if ($killed -eq 0) {
    Write-Host "[stop] No bridge processes found" -ForegroundColor Cyan
} else {
    Write-Host "[stop] Stopped $killed process(es)" -ForegroundColor Green
}
