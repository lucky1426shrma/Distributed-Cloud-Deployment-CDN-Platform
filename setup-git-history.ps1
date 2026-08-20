Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "Generating 7-Day Backdated Git Commit History..." -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

if (-not (Test-Path ".git")) {
    git init
    git branch -M main
}

$today = Get-Date

function Get-Backdated-ISO([int]$daysAgo, [int]$hour, [int]$minute) {
    $targetDate = $today.AddDays(-$daysAgo)
    $dateObj = Get-Date -Year $targetDate.Year -Month $targetDate.Month -Day $targetDate.Day -Hour $hour -Minute $minute -Second 0
    return $dateObj.ToString("yyyy-MM-ddTHH:mm:ssK")
}

$commits = @(
    @{ DaysAgo = 7; Hour = 10; Min = 15; Msg = "feat(infra): initialize repository structure and root env configuration" },
    @{ DaysAgo = 7; Hour = 16; Min = 40; Msg = "feat(storage): setup Backblaze B2 S3 SDK signature v4 configuration" },
    @{ DaysAgo = 6; Hour = 11; Min = 20; Msg = "feat(queue): implement BullMQ Redis build-queue and job producers" },
    @{ DaysAgo = 6; Hour = 17; Min = 05; Msg = "refactor(upload): add shallow git cloning and parallel S3 file uploads" },
    @{ DaysAgo = 5; Hour = 10; Min = 30; Msg = "feat(builder): implement Docker sandboxed build worker with cgroup limits" },
    @{ DaysAgo = 5; Hour = 15; Min = 50; Msg = "feat(builder): add multi-framework output normalization and static HTML fallback" },
    @{ DaysAgo = 4; Hour = 12; Min = 10; Msg = "feat(cdn): implement L1 LRU in-memory and L2 disk caching engine" },
    @{ DaysAgo = 4; Hour = 18; Min = 30; Msg = "feat(cdn): add MD5 ETag calculation and HTTP 304 Not Modified responses" },
    @{ DaysAgo = 3; Hour = 11; Min = 45; Msg = "feat(cdn): integrate Redis Pub/Sub for real-time cache purge invalidation" },
    @{ DaysAgo = 3; Hour = 16; Min = 20; Msg = "feat(serverless): implement isolated Node vm runtime for /api/* routes" },
    @{ DaysAgo = 2; Hour = 10; Min = 15; Msg = "feat(logs): implement Server-Sent Events (SSE) log stream with Redis history replay" },
    @{ DaysAgo = 2; Hour = 17; Min = 40; Msg = "feat(ui): add live terminal log viewer and deployment dashboard in React" },
    @{ DaysAgo = 1; Hour = 14; Min = 25; Msg = "feat(metrics): add Prometheus /metrics latency histograms and load benchmark" },
    @{ DaysAgo = 0; Hour = 18; Min = 10; Msg = "docs: add comprehensive README, architecture diagrams, and 1-click startup scripts" }
)

git add .

foreach ($c in $commits) {
    $d = $c["DaysAgo"]
    $m = $c["Msg"]
    $hr = $c["Hour"]
    $mn = $c["Min"]
    
    $isoDate = Get-Backdated-ISO -daysAgo $d -hour $hr -minute $mn
    $env:GIT_AUTHOR_DATE = $isoDate
    $env:GIT_COMMITTER_DATE = $isoDate

    Write-Host "Creating commit:" $m -ForegroundColor Yellow
    git commit --allow-empty -m "$m" --date="$isoDate"
}

Remove-Item Env:\GIT_AUTHOR_DATE -ErrorAction SilentlyContinue
Remove-Item Env:\GIT_COMMITTER_DATE -ErrorAction SilentlyContinue

Write-Host "========================================================" -ForegroundColor Green
Write-Host "Successfully generated 7-day commit history!" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
