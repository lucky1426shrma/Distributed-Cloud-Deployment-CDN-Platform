@echo off
echo ========================================================
echo 🛑 Stopping all Vercel Clone Microservices & Redis...
echo ========================================================

REM Kill all running node processes
taskkill /F /IM node.exe /T 2>nul

REM Stop Redis container
docker stop vercel-redis 2>nul

echo ========================================================
echo ✅ All microservices stopped and ports freed successfully!
echo ========================================================
