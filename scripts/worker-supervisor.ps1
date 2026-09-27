# worker-supervisor.ps1 - keep the Sol Pump Radar worker running for multi-day evaluations.
#
# Why: measured 2026-09-13, 42 of 76 auto sessions ended because the worker restarted
# and the median session lasted 17 minutes. Docker Desktop stops when this machine
# sleeps, which kills Postgres and, with it, the worker. Nothing brought either back.
#
# What it does, in a loop:
#   1. Keeps the PC awake while it runs (SetThreadExecutionState: system stays on,
#      the display may still turn off). Released automatically when the script exits.
#   2. Makes sure Docker Desktop and the Postgres container are up; starts them and
#      waits if not.
#   3. Runs `pnpm worker` in the foreground. When it exits for any reason, waits with
#      a growing backoff (5 s up to 60 s; reset after 10 minutes of healthy running)
#      and starts it again.
#
# Pair with RESUME_PAPER_SESSION_ON_BOOT=on in .env.local so a PAPER session keeps
# running across those restarts (live sessions are always retired on restart).
#
# Run:   pnpm worker:supervised        (Ctrl+C to stop)

$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Log([string]$msg) {
  Write-Host ("[supervisor {0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg)
}

Add-Type -Namespace Spr -Name Power -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$ES_CONTINUOUS = [uint32]"0x80000000"
$ES_SYSTEM_REQUIRED = [uint32]"0x00000001"
[void][Spr.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
Log "keeping the system awake while supervising"

function Test-Docker {
  docker info --format "{{.ServerVersion}}" *> $null
  return ($LASTEXITCODE -eq 0)
}

function Ensure-Database {
  if (-not (Test-Docker)) {
    $desktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $desktop) {
      Log "Docker is not running - starting Docker Desktop"
      Start-Process $desktop | Out-Null
    } else {
      Log "Docker is not running and Docker Desktop was not found at $desktop"
    }
    $deadline = (Get-Date).AddMinutes(4)
    while (-not (Test-Docker)) {
      if ((Get-Date) -gt $deadline) { Log "Docker did not come up within 4 minutes"; return $false }
      Start-Sleep -Seconds 5
    }
    Log "Docker is up"
  }
  docker compose up -d postgres *> $null
  $deadline = (Get-Date).AddMinutes(2)
  while ($true) {
    docker compose exec -T postgres pg_isready -U sol -d solpump *> $null
    if ($LASTEXITCODE -eq 0) { return $true }
    if ((Get-Date) -gt $deadline) { Log "Postgres did not become ready within 2 minutes"; return $false }
    Start-Sleep -Seconds 3
  }
}

$backoff = 5
try {
  while ($true) {
    if (-not (Ensure-Database)) {
      Log "database unavailable; retrying in 30 s"
      Start-Sleep -Seconds 30
      continue
    }
    Log "starting worker"
    $started = Get-Date
    & pnpm worker
    $code = $LASTEXITCODE
    $ranFor = (Get-Date) - $started
    Log ("worker exited with code {0} after {1:N0} s" -f $code, $ranFor.TotalSeconds)
    if ($ranFor.TotalMinutes -ge 10) { $backoff = 5 }
    Log "restarting in $backoff s"
    Start-Sleep -Seconds $backoff
    $backoff = [Math]::Min(60, $backoff * 2)
  }
} finally {
  [void][Spr.Power]::SetThreadExecutionState($ES_CONTINUOUS)
  Log "released keep-awake"
}
