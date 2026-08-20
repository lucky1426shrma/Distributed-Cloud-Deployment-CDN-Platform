@echo off
echo ========================================================
echo 🚀 Starting Vercel Clone Microservices & Frontend...
echo ========================================================

REM 1. Ensure Redis is running in Docker
echo [1/5] Checking Redis container...
docker run -d -p 6379:6379 --name vercel-redis redis:7-alpine 2>nul || docker start vercel-redis 2>nul

REM 2. Launch Upload Service (Port 3000)
echo [2/5] Starting Upload Service (Port 3000)...
start "Upload Service" cmd /k "cd /d "%~dp0vercel-upload-service" && npm run dev"

REM 3. Launch Deploy Worker Service
echo [3/5] Starting Deploy Worker Service...
start "Deploy Worker" cmd /k "cd /d "%~dp0vercel-deploy-service" && npm run dev"

REM 4. Launch Edge CDN Request Handler (Port 3001)
echo [4/5] Starting Request Handler CDN (Port 3001)...
start "Request Handler" cmd /k "cd /d "%~dp0vercel-request-handler" && npm run dev"

REM 5. Launch Frontend Dashboard (Port 5173)
echo [5/5] Starting Frontend Dashboard (Port 5173)...
start "Frontend Dashboard" cmd /k "cd /d "%~dp0frontend" && npm run dev"

echo ========================================================
echo 🎉 All 4 microservices launched in separate terminals!
echo Open http://localhost:5173 in your browser.
echo ========================================================
