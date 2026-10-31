@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul
cd /d "%~dp0"

echo ============================================================
echo  Start GitHub Copilot Desktop with CDP enabled
echo ------------------------------------------------------------
echo  This script only sets ONE per-process environment variable
echo  and then starts the official executable:
echo    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ...
echo  It never writes to or modifies any file inside the official
echo  install folder. The variable disappears when Copilot exits.
echo ============================================================
echo.

rem ---------- port (override with the 1st argument: probe-start.cmd 9333) ----------
set "PORT=%~1"
if "%PORT%"=="" set "PORT=9222"

rem ---------- locate the official github.exe ----------
set "APP="
if exist "%LOCALAPPDATA%\Programs\GitHub Copilot\github.exe" set "APP=%LOCALAPPDATA%\Programs\GitHub Copilot\github.exe"
if not defined APP if exist "%ProgramFiles%\GitHub Copilot\github.exe" set "APP=%ProgramFiles%\GitHub Copilot\github.exe"
if not defined APP if exist "%ProgramFiles(x86)%\GitHub Copilot\github.exe" set "APP=%ProgramFiles(x86)%\GitHub Copilot\github.exe"
if not defined APP if exist "%LOCALAPPDATA%\GitHub Copilot\github.exe" set "APP=%LOCALAPPDATA%\GitHub Copilot\github.exe"

rem AppData may be redirected; fall back to scanning every drive using the
rem CURRENT user name only (never hard-code a user name or a drive letter).
if not defined APP (
  for %%D in (C D E F G H I J) do (
    if not defined APP if exist "%%D:\Users\%USERNAME%\AppData\Local\Programs\GitHub Copilot\github.exe" set "APP=%%D:\Users\%USERNAME%\AppData\Local\Programs\GitHub Copilot\github.exe"
    if not defined APP if exist "%%D:\Users\%USERNAME%\AppData\Local\GitHub Copilot\github.exe" set "APP=%%D:\Users\%USERNAME%\AppData\Local\GitHub Copilot\github.exe"
  )
)

rem last resort: scan one level under %LOCALAPPDATA%\Programs
if not defined APP (
  for /d %%D in ("%LOCALAPPDATA%\Programs\*") do (
    if exist "%%~fD\github.exe" if exist "%%~fD\app-extensions" set "APP=%%~fD\github.exe"
  )
)

if not defined APP (
  echo   [ERROR] github.exe for GitHub Copilot Desktop was not found.
  echo.
  echo           Tried:
  echo             %%LOCALAPPDATA%%\Programs\GitHub Copilot\github.exe
  echo             %%ProgramFiles%%\GitHub Copilot\github.exe
  echo.
  echo           Run this by hand instead -- replace the path with yours:
  echo             set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=%PORT% --remote-allow-origins=*
  echo             start "" "%LOCALAPPDATA%\Programs\GitHub Copilot\github.exe"
  echo.
  pause
  exit /b 1
)

echo App path  : %APP%
echo CDP port  : %PORT%
echo.

rem ---------- make sure no instance is already running ----------
tasklist /FI "IMAGENAME eq github.exe" 2>nul | find /I "github.exe" >nul
if not errorlevel 1 (
  echo   [WARN] github.exe is already running.
  echo          Copilot is a single-instance app: a new process just hands the
  echo          request to the running instance and exits, so the CDP port
  echo          would never take effect.
  echo          Fully QUIT Copilot first, then run this script again.
  echo.
  pause
  exit /b 1
)

set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=%PORT% --remote-allow-origins=*"
start "" "%APP%"

echo Started. Waiting 6 seconds for the window to become ready ...
timeout /t 6 /nobreak >nul

echo.
echo Next: double-click probe.cmd, or run "node probe.js" in this folder
echo.
pause
