Write-Host "========================================================" -ForegroundColor Red
Write-Host "🛑 Stopping all Vercel Clone Microservices & Redis..." -ForegroundColor Red
Write-Host "========================================================" -ForegroundColor Red

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
docker stop vercel-redis 2>$null

Write-Host "========================================================" -ForegroundColor Green
Write-Host "✅ All microservices stopped and ports freed successfully!" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
