# Saves runtime perf snapshot for before/after comparisons (Phase 0+).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$uri = "http://127.0.0.1:3000/api/diagnostics/runtime?save=1"
Write-Host "Requesting $uri ..." -ForegroundColor Cyan

try {
  $r = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 120
} catch {
  Write-Host "Failed. Is the app running? Try .\start-trading.ps1 first." -ForegroundColor Red
  Write-Host $_.Exception.Message
  exit 1
}

$j = $r.Content | ConvertFrom-Json
if ($j.savedTo) {
  Write-Host "Saved: $($j.savedTo)" -ForegroundColor Green
} else {
  Write-Host "Response (no save path):" -ForegroundColor Yellow
  Write-Host $r.Content
}
Write-Host ""
Write-Host "Share data/diagnostics/runtime-latest.json when asking for perf help." -ForegroundColor Cyan
