@echo off
setlocal

rem Use this checkout when the reviewed launcher is present.
rem The same entry point can be installed in the older parent checkout.
if exist "%~dp0scripts\start-real.ps1" goto local

set "TAS_REVIEW_WORKSPACE=%~dp0.claude\worktrees\ui-rebuild"
if not exist "%TAS_REVIEW_WORKSPACE%\scripts\start-real.ps1" goto unavailable
if not exist "%TAS_REVIEW_WORKSPACE%\start-app-real.bat" goto unavailable
echo Starting the reviewed UI from %TAS_REVIEW_WORKSPACE%
if not "%~1"=="" goto reviewed_arguments
call "%TAS_REVIEW_WORKSPACE%\start-app-real.bat" -ReuseExisting -OpenBrowser
exit /b %errorlevel%

:reviewed_arguments
call "%TAS_REVIEW_WORKSPACE%\start-app-real.bat" %*
exit /b %errorlevel%

:unavailable
echo Reviewed REAL launcher was not found in this checkout or %TAS_REVIEW_WORKSPACE%.
echo Restore the reviewed workspace before starting. No fallback to the old UI.
exit /b 1

:local
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-real.ps1" %*
exit /b %errorlevel%
