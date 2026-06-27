# scripts/safe-migrate.ps1
#
# T0.1 — Wraps `pnpm db:migrate` with a snapshot-then-dry-run-then-apply guard.
# Required by the plan for every schema migration in T1.1, T1.2, T1.3, T4.3
# ("A 2pm migration against a 6am backup loses 8h of labels if it fails.")
#
# Flow:
#   1. Take a fresh on-demand pg_dump RIGHT NOW (calls backup-db.ps1 -OnDemand)
#   2. Restore that dump into a temp DB (solpump_migration_dryrun)
#   3. Run `pnpm db:migrate` against the temp DB
#   4. If success: drop temp DB and run `pnpm db:migrate` against LIVE
#   5. If failure: print the error, leave the temp DB in place for inspection,
#      and EXIT NON-ZERO without touching live
#
# Usage:
#   ./scripts/safe-migrate.ps1
#
# Override the dry-run DB name if needed:
#   ./scripts/safe-migrate.ps1 -TestDbName 'solpump_premig_t1_1'

param(
  [string]$TestDbName = 'solpump_migration_dryrun',
  [string]$Dest = $(if ($env:BACKUP_DIR) { $env:BACKUP_DIR } else { Join-Path $HOME 'OneDrive\sol-pump-radar-backups' })
)

$ErrorActionPreference = 'Continue'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

Write-Host "=========================================="
Write-Host "  safe-migrate.ps1"
Write-Host "  test DB: $TestDbName"
Write-Host "=========================================="

# --- Step 1: fresh on-demand backup ---
Write-Host "`n[1/4] Taking fresh on-demand backup ..."
& "$PSScriptRoot\backup-db.ps1" -OnDemand -Dest $Dest
if ($LASTEXITCODE -ne 0) {
  Write-Host "`n[safe-migrate] ABORT: pre-migration backup failed. Live DB untouched."
  exit 1
}

# Find the on-demand dump we just wrote
$latestOnDemand = Get-ChildItem -Path $Dest -Filter 'solpump-*-ondemand.dump' |
                  Sort-Object LastWriteTime -Descending |
                  Select-Object -First 1
if (-not $latestOnDemand) {
  Write-Host "`n[safe-migrate] ABORT: cannot locate on-demand dump after backup."
  exit 1
}
Write-Host "[safe-migrate] backup ready: $($latestOnDemand.FullName)"

# --- Step 2: restore that backup into temp DB ---
Write-Host "`n[2/4] Restoring backup into $TestDbName for dry-run ..."
$containerId = docker compose ps -q postgres
if (-not $containerId) {
  Write-Host "[safe-migrate] ABORT: postgres container not running"
  exit 1
}
$inContainer = "/tmp/safe-migrate-dryrun.dump"
docker cp $latestOnDemand.FullName "${containerId}:${inContainer}"
if ($LASTEXITCODE -ne 0) { Write-Host "[safe-migrate] ABORT: docker cp failed"; exit 1 }

docker compose exec -T postgres psql -U sol -d postgres -c "DROP DATABASE IF EXISTS $TestDbName;" | Out-Null
docker compose exec -T postgres psql -U sol -d postgres -c "CREATE DATABASE $TestDbName;" | Out-Null
docker compose exec -T postgres pg_restore -U sol -d $TestDbName --no-owner -j 2 $inContainer
$restoreExit = $LASTEXITCODE
# pg_restore exit 1 = warnings only (commonly missing role) — proceed if tables are present.
$tablesExist = (docker compose exec -T postgres psql -U sol -d $TestDbName -tA -c "SELECT to_regclass('public.events') IS NOT NULL AND to_regclass('public.paper_positions') IS NOT NULL").Trim()
if ($tablesExist -ne 't') {
  Write-Host "[safe-migrate] ABORT: critical tables missing after restore (events / paper_positions). Live DB untouched."
  Write-Host "[safe-migrate] Temp DB $TestDbName left in place for inspection."
  exit 1
}
if ($restoreExit -ne 0) {
  Write-Host "[safe-migrate] note: pg_restore exited $restoreExit (warnings) but tables verified. Continuing."
}

# --- Step 3: run migrations against the TEMP DB ---
Write-Host "`n[3/4] Running pnpm db:migrate against temp DB (dry-run) ..."
# Override DATABASE_URL just for this invocation
$origDbUrl = $env:DATABASE_URL
$env:DATABASE_URL = "postgresql://sol:sol@127.0.0.1:5432/$TestDbName"
try {
  pnpm db:migrate
  $migExit = $LASTEXITCODE
} finally {
  $env:DATABASE_URL = $origDbUrl
}

if ($migExit -ne 0) {
  Write-Host "`n[safe-migrate] DRY-RUN FAILED: migrations errored against temp DB (exit $migExit)."
  Write-Host "[safe-migrate] Live DB UNTOUCHED. Temp DB $TestDbName left in place for inspection."
  Write-Host "[safe-migrate] Inspect with:  docker compose exec postgres psql -U sol -d $TestDbName"
  exit 1
}
Write-Host "[safe-migrate] dry-run OK"

# --- Step 4: apply for real ---
Write-Host "`n[4/4] Dry-run succeeded. Applying migrations to LIVE solpump DB ..."
pnpm db:migrate
$liveExit = $LASTEXITCODE

# Clean up temp DB regardless (we have the on-demand backup if anything goes wrong)
docker compose exec -T postgres psql -U sol -d postgres -c "DROP DATABASE IF EXISTS $TestDbName;" | Out-Null
docker compose exec -T postgres rm -f $inContainer | Out-Null

if ($liveExit -ne 0) {
  Write-Host "`n[safe-migrate] LIVE MIGRATION FAILED (exit $liveExit) -- UNEXPECTED, since dry-run passed."
  Write-Host "[safe-migrate] On-demand backup is at: $($latestOnDemand.FullName)"
  Write-Host "[safe-migrate] Restore with:  ./scripts/restore-test.ps1 -DumpFile '$($latestOnDemand.FullName)'"
  exit $liveExit
}

Write-Host "`n[safe-migrate] SUCCESS"
Write-Host "  Backup: $($latestOnDemand.FullName)"
Write-Host "  Migrations applied to live."
exit 0
