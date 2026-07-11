# One-shot: authenticate, create GitHub repo, and push main.
# Run from PowerShell: .\scripts\push-github.ps1

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
  Write-Host "Installing GitHub CLI..."
  winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

Write-Host "Checking GitHub login..."
$loggedIn = $false
try {
  gh auth status *> $null
  if ($LASTEXITCODE -eq 0) { $loggedIn = $true }
} catch {
  $loggedIn = $false
}

if (-not $loggedIn) {
  Write-Host "Sign in to GitHub (browser will open)..."
  gh auth login --hostname github.com --git-protocol https --web
}

$repo = "robertthap/sol-pump-radar"
Write-Host "Creating repo $repo if it does not exist..."
$repoExists = $false
try {
  gh repo view $repo *> $null
  if ($LASTEXITCODE -eq 0) { $repoExists = $true }
} catch {
  $repoExists = $false
}

if (-not $repoExists) {
  gh repo create $repo `
    --public `
    --description "Localhost-only Solana pump.fun analytics and paper-first trading dashboard" `
    --source . `
    --remote origin `
    --push
} else {
  Write-Host "Repo exists. Pushing main..."
  git push -u origin main
}

gh repo edit $repo `
  --add-topic solana `
  --add-topic pump-fun `
  --add-topic trading-bot `
  --add-topic nextjs `
  --add-topic typescript

Write-Host ""
Write-Host ("Done: https://github.com/" + $repo)
