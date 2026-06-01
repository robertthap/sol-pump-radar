param(
  [switch]$ArtifactsOnly
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root

$artifactPaths = @(
  ".next",
  "tsconfig.tsbuildinfo",
  "data\engine-b-traces",
  "data\intelligence-traces",
  "data\worker-hb.json"
)

if ($ArtifactsOnly) {
  Write-Host "Removing build/cache artifacts only (Postgres data kept)..." -ForegroundColor Cyan
} else {
  Write-Host ""
  Write-Host "This will:" -ForegroundColor Yellow
  Write-Host "  - drop and recreate the Docker Postgres volume (full DB wipe)"
  Write-Host "  - delete build/cache artifacts (.next, trace logs)"
  Write-Host ""
  $confirm = Read-Host "Type 'wipe' to confirm"
  if ($confirm -ne "wipe") {
    Write-Host "Cancelled." -ForegroundColor Green
    exit 0
  }
  Write-Host "Stopping Postgres and removing volume..." -ForegroundColor Cyan
  docker compose down -v
}

foreach ($p in $artifactPaths) {
  if (Test-Path $p) {
    Remove-Item -Recurse -Force $p
    Write-Host "removed $p"
  }
}

Write-Host ""
if ($ArtifactsOnly) {
  Write-Host "Artifacts cleared." -ForegroundColor Green
} else {
  Write-Host "Local state wiped. Run: pnpm db:up && pnpm db:migrate" -ForegroundColor Green
}
