# Local CI: typecheck + tests + lint
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

pnpm typecheck
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

pnpm test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

pnpm lint
exit $LASTEXITCODE
