@echo off
setlocal

cd /d "%~dp0"
set "MOCK_MODE=true"
set "PORT=4173"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20.11 or later.
  pause
  exit /b 1
)

echo Checking for an existing server on port 4173...
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /R /C:":4173 .*LISTENING"') do (
  echo Stopping process %%P...
  taskkill /PID %%P /T /F >nul 2>&1
  if errorlevel 1 echo Could not stop process %%P. Try running this file as administrator.
)
timeout /t 1 /nobreak >nul

echo Starting gemini-tas-demo on http://127.0.0.1:4173/
echo Press Ctrl+C to stop the server.
npm.cmd start

endlocal
