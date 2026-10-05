@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js not found. Please install Node.js LTS from https://nodejs.org
  pause
  exit /b 1
)
echo ==================================================
echo   Production Management System is starting...
echo   Keep this window open. Closing it stops the service.
echo ==================================================
node server.js
pause