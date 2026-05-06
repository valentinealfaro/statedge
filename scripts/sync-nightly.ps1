# StatEdge nightly NBA data sync.
# Pulls fresh game logs into the Neon DB cache. Runs from your local
# machine (this works because home IPs aren't blocked by stats.nba.com,
# unlike Vercel and GitHub Actions runners).
#
# Registered as a Windows Scheduled Task — see scripts/install-schedule.ps1

$ErrorActionPreference = "Continue"

$root = "C:\Users\alfar\Projects\StatEdge"
$backend = Join-Path $root "backend"
$logDir = Join-Path $root "logs"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$log = Join-Path $logDir ("sync-{0}.log" -f $timestamp)

"=== StatEdge sync started $(Get-Date -Format 'u') ===" | Out-File -FilePath $log -Encoding utf8

Set-Location $backend
& npm run db:sync-games *>> $log 2>&1
$exit = $LASTEXITCODE

"=== Finished with exit code $exit at $(Get-Date -Format 'u') ===" | Out-File -FilePath $log -Append -Encoding utf8

# Keep only the last 14 logs so this doesn't grow forever.
Get-ChildItem $logDir -Filter "sync-*.log" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 14 |
    Remove-Item -Force -ErrorAction SilentlyContinue

exit $exit
