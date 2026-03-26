<#
.SYNOPSIS
    Start the Patchnet Agent Bridge (stops any existing instance first).

.NOTES
    Run from the project root:
        powershell -ExecutionPolicy Bypass -File scripts\start.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$rootDir = Split-Path $PSScriptRoot -Parent

# Stop any existing bridge first

& "$PSScriptRoot\stop.ps1"

# Start the bridge

Write-Host ""
Write-Host "[start] Starting bridge..." -ForegroundColor Cyan

Push-Location $rootDir
node index.js
Pop-Location
