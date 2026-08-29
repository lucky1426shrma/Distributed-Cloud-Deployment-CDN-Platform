Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "🚀 Starting Vercel Clone Microservices & Frontend..." -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

# 1. Start Redis
Write-Host "[1/5] Starting Redis container..." -ForegroundColor Yellow
docker run -d -p 6379:6379 --name vercel-redis redis:7-alpine 2>$null
docker start vercel-redis 2>$null

# 2. Launch Upload Service
Write-Host "[2/5] Launching Upload Service (Port 3000)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "& { Set-Location -LiteralPath '$PSScriptRoot\vercel-upload-service'; npm run dev }"

# 3. Launch Deploy Worker
Write-Host "[3/5] Launching Deploy Worker Service..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "& { Set-Location -LiteralPath '$PSScriptRoot\vercel-deploy-service'; npm run dev }"

# 4. Launch Request Handler
Write-Host "[4/5] Launching Edge CDN Request Handler (Port 3001)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "& { Set-Location -LiteralPath '$PSScriptRoot\vercel-request-handler'; npm run dev }"

# 5. Launch Frontend
Write-Host "[5/5] Launching Frontend Dashboard (Port 5173)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "& { Set-Location -LiteralPath '$PSScriptRoot\frontend'; npm run dev }"

Write-Host "========================================================" -ForegroundColor Green
Write-Host "🎉 All 4 microservices launched in separate PowerShell windows!" -ForegroundColor Green
Write-Host "Open http://localhost:5173 in your browser." -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
