@echo off
setlocal

rem Starts the app in real-connection mode (Gemini on GEAP).
rem Values come from real-connection.env (not tracked by git).
rem See docs\FEWSHOT_OPERATIONS.md "real connection" section before use.

cd /d "%~dp0"

rem Prefer the settings saved during the 2026-09-12 connectivity measurement.
if exist ".local-validation\connectivity-env.ps1" (
  echo Using .local-validation\connectivity-env.ps1
  echo Videos are sent to Google Cloud when an analysis starts.
  powershell -NoProfile -ExecutionPolicy Bypass -Command ". '.\.local-validation\connectivity-env.ps1'; if ($env:MOCK_MODE -ne 'false') { Write-Host 'MOCK_MODE is not false.'; exit 1 }; Write-Host ('Project: ' + $env:GEAP_PROJECT + ' / Data: ' + $env:DATA_ROOT); $p = (Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue).OwningProcess; if ($p) { Stop-Process -Id $p -Force }; npm.cmd start"
  exit /b %errorlevel%
)

if not exist "real-connection.env" (
  echo real-connection.env was not found.
  echo Copy real-connection.env.example to real-connection.env and fill in the confirmed values.
  pause
  exit /b 1
)

for /f "usebackq eol=# tokens=1,* delims==" %%A in ("real-connection.env") do (
  if not "%%B"=="" set "%%A=%%B"
)

rem Real mode is forced here; results are never mixed with mock data.
set "MOCK_MODE=false"
if not defined DATA_ROOT set "DATA_ROOT=data-real"
if not defined PORT set "PORT=4173"

if /i not "%GEAP_ENVIRONMENT_CONFIRMED%"=="true" (
  echo GEAP_ENVIRONMENT_CONFIRMED is not true in real-connection.env.
  echo Set it only after gcloud login, project, permissions and consent have been confirmed.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20.11 or later.
  pause
  exit /b 1
)
where gcloud >nul 2>&1
if errorlevel 1 (
  echo gcloud was not found on PATH. Add Cloud SDK\bin to PATH and open a new shell.
  pause
  exit /b 1
)

echo Checking for an existing server on port %PORT%...
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  echo Stopping process %%P...
  taskkill /PID %%P /T /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo Starting gemini-tas-demo in REAL mode on http://127.0.0.1:%PORT%/
echo Project: %GEAP_PROJECT% / Location: %GEAP_LOCATION% / Data: %DATA_ROOT%
echo Videos are sent to Google Cloud when an analysis starts.
npm.cmd start

endlocal
