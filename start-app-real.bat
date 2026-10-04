@echo off
setlocal

rem Starts the app in real-connection mode (Gemini on GEAP).
rem Values come from real-connection.env (not tracked by git).
rem See docs\FEWSHOT_OPERATIONS.md "real connection" section before use.

cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-real.ps1" %*
exit /b %errorlevel%
