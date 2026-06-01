# Compare first vs second load: dev server vs production.
# Usage: .\scripts\perf-baseline.ps1
# Prereq: app reachable at http://127.0.0.1:3000 (start dev or prod first).

$Base = "http://127.0.0.1:3000"
$Paths = @("/trade", "/mission", "/api/health?lite=1", "/api/trade/bootstrap?lite=1")

function Measure-Url($url) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 120
    $sw.Stop()
    return @{ ok = $true; ms = $sw.ElapsedMilliseconds; status = $r.StatusCode }
  } catch {
    $sw.Stop()
    return @{ ok = $false; ms = $sw.ElapsedMilliseconds; status = $_.Exception.Message }
  }
}

Write-Host "=== Perf baseline ($Base) ===" -ForegroundColor Cyan
Write-Host ""

foreach ($p in $Paths) {
  $url = "$Base$p"
  Write-Host "Path: $p" -ForegroundColor Yellow
  $a = Measure-Url $url
  Write-Host ("  run 1: {0} ms ({1})" -f $a.ms, $(if ($a.ok) { "HTTP $($a.status)" } else { $a.status }))
  Start-Sleep -Seconds 1
  $b = Measure-Url $url
  Write-Host ("  run 2: {0} ms ({1})" -f $b.ms, $(if ($b.ok) { "HTTP $($b.status)" } else { $b.status }))
  Write-Host ""
}

Write-Host "Interpretation:" -ForegroundColor Cyan
Write-Host "  - run1 >> run2 on HTML routes in 'pnpm dev' => mostly webpack compile (normal in dev)."
Write-Host "  - Both runs slow in 'pnpm start' => real server/API/DB issue — use /diagnostics/runtime?save=1"
Write-Host ""
Write-Host "Workflows:" -ForegroundColor Cyan
Write-Host "  Dev UI only:    WORKERS=off + pnpm dev:stable"
Write-Host "  Dev split:      pnpm workers  (terminal 1) + WORKERS=off + pnpm dev:stable (terminal 2)"
Write-Host "  Production-ish: pnpm build && pnpm start  (or VS Production profile)"
