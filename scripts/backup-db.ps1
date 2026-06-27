# scripts/backup-db.ps1
#
# T0.1 — Off-disk Postgres backup. Writes a daily custom-format pg_dump of the
# solpump database to a second location and rotates the last N days.
#
# Per the kill-gate logic (T0.2): the feature_snapshots + outcome_labels dataset
# IS the project. One disk failure or one bad migration without a recent backup
# erases weeks of irreplaceable labeled history. This script is the cheapest
# insurance possible.
#
# Usage:
#   ./scripts/backup-db.ps1                      # daily backup, default dest
#   ./scripts/backup-db.ps1 -OnDemand            # tags the file with timestamp
#                                                # for pre-migration use
#   ./scripts/backup-db.ps1 -Dest 'D:\backups'   # custom destination
#
# Returns non-zero exit code on any failure so Task Scheduler / safe-migrate.ps1
# can detect it.

param(
  [string]$Dest = $(if ($env:BACKUP_DIR) { $env:BACKUP_DIR } else { Join-Path $HOME 'OneDrive\sol-pump-radar-backups' }),
  [int]$RetentionDays = 7,
  [switch]$OnDemand
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

if (-not (Test-Path $Dest)) {
  New-Item -ItemType Directory -Force $Dest | Out-Null
  Write-Host "[backup] created backup directory: $Dest"
}

$LogPath = Join-Path $Dest 'backup.log'

function Write-Log {
  param([string]$Message)
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Message"
  Write-Host "[backup] $Message"
  Add-Content -Path $LogPath -Value $line
}

# Filename: solpump-YYYY-MM-DD.dump for daily, solpump-YYYY-MM-DD-HHmmss.dump for on-demand
$stamp = if ($OnDemand) { Get-Date -Format 'yyyy-MM-dd-HHmmss' } else { Get-Date -Format 'yyyy-MM-dd' }
$tag = if ($OnDemand) { '-ondemand' } else { '' }
$filename = "solpump-${stamp}${tag}.dump"
$outPath = Join-Path $Dest $filename

Write-Log "starting backup → $outPath"

# Verify postgres container is up (compose service name from docker-compose.yml)
$containerState = docker compose ps --format '{{.Service}}={{.State}}' 2>$null | Select-String 'postgres='
if (-not $containerState -or -not ($containerState -match 'postgres=running')) {
  Write-Log "ERROR: postgres compose service is not running. Aborting backup."
  exit 1
}

# pg_dump in custom format (-Fc) → smaller, parallel-restorable. -Z 9 = max compress.
# Write to a temp file inside the container then docker cp it out, so partial failures
# don't leave a half-written file at $outPath.
$tempInContainer = "/tmp/$filename"
docker compose exec -T postgres pg_dump -U sol -d solpump -Fc -Z 9 -f $tempInContainer
if ($LASTEXITCODE -ne 0) {
  Write-Log "ERROR: pg_dump failed with exit $LASTEXITCODE"
  exit $LASTEXITCODE
}

# Get the container id once, then docker cp out
$containerId = docker compose ps -q postgres
if (-not $containerId) {
  Write-Log "ERROR: could not resolve postgres container id"
  exit 1
}
docker cp "${containerId}:${tempInContainer}" $outPath
if ($LASTEXITCODE -ne 0) {
  Write-Log "ERROR: docker cp failed with exit $LASTEXITCODE"
  exit $LASTEXITCODE
}
docker compose exec -T postgres rm -f $tempInContainer | Out-Null

# Sanity check the file exists and is non-trivial in size
if (-not (Test-Path $outPath)) {
  Write-Log "ERROR: dump file missing at $outPath after docker cp"
  exit 1
}
$sizeBytes = (Get-Item $outPath).Length
if ($sizeBytes -lt 10KB) {
  Write-Log "ERROR: dump file suspiciously small ($sizeBytes bytes). Refusing to accept."
  exit 1
}
$sizeMB = [math]::Round($sizeBytes / 1MB, 2)
Write-Log "OK: wrote ${sizeMB} MB → $outPath"

# Rotate: keep only RetentionDays of NON-on-demand backups.
# On-demand backups (with -ondemand tag) are kept until manually cleaned.
$cutoff = (Get-Date).AddDays(-$RetentionDays)
$rotated = 0
Get-ChildItem -Path $Dest -Filter 'solpump-*.dump' |
  Where-Object { $_.Name -notmatch '-ondemand\.dump$' } |
  Where-Object { $_.LastWriteTime -lt $cutoff } |
  ForEach-Object {
    Remove-Item -Force $_.FullName
    Write-Log "rotated (older than ${RetentionDays}d): $($_.Name)"
    $rotated++
  }
if ($rotated -gt 0) { Write-Log "rotated $rotated old daily dump(s)" }

exit 0
