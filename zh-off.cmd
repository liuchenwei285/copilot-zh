@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem ============================================================
rem  Start GitHub Copilot Desktop in its ORIGINAL ENGLISH state
rem  (one-click "turn the Chinese translation off").
rem
rem  It first stops the background daemon, then starts the official
rem  executable with no extra environment variable -- equivalent to
rem  double-clicking the official shortcut.
rem
rem  KEEP THIS FILE PURE ASCII -- see start-copilot-zh.cmd for why.
rem ============================================================

rem ---- locate Node.js (only needed to stop the daemon; optional) ----
set "NODE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if defined NODE (
  "%NODE%" "%~dp0zh-launcher.js" --stop >nul 2>nul
) else (
  echo   [WARN] Node.js not found -- cannot stop the background daemon.
  echo          If Chinese is still active, fully quit Copilot and try again.
)

rem ---- locate the official executable ----
set "APP="
if exist "%LOCALAPPDATA%\Programs\GitHub Copilot\github.exe" set "APP=%LOCALAPPDATA%\Programs\GitHub Copilot\github.exe"
if not defined APP if exist "%ProgramFiles%\GitHub Copilot\github.exe" set "APP=%ProgramFiles%\GitHub Copilot\github.exe"
if not defined APP if exist "%ProgramFiles(x86)%\GitHub Copilot\github.exe" set "APP=%ProgramFiles(x86)%\GitHub Copilot\github.exe"
if not defined APP if exist "%LOCALAPPDATA%\GitHub Copilot\github.exe" set "APP=%LOCALAPPDATA%\GitHub Copilot\github.exe"

rem AppData is sometimes redirected while %LOCALAPPDATA% is not updated;
rem fall back to scanning every drive using the CURRENT user name only
rem (never hard-code a user name or a drive letter).
if not defined APP (
  for %%D in (C D E F G H I J) do (
    if not defined APP if exist "%%D:\Users\%USERNAME%\AppData\Local\Programs\GitHub Copilot\github.exe" set "APP=%%D:\Users\%USERNAME%\AppData\Local\Programs\GitHub Copilot\github.exe"
    if not defined APP if exist "%%D:\Users\%USERNAME%\AppData\Local\GitHub Copilot\github.exe" set "APP=%%D:\Users\%USERNAME%\AppData\Local\GitHub Copilot\github.exe"
  )
)

if not defined APP (
  for /d %%D in ("%LOCALAPPDATA%\Programs\*") do (
    if exist "%%~fD\github.exe" if exist "%%~fD\app-extensions" set "APP=%%~fD\github.exe"
  )
)

if not defined APP (
  echo   [ERROR] github.exe for GitHub Copilot Desktop was not found.
  echo           Please start it from the official Start Menu shortcut instead.
  echo.
  pause
  exit /b 1
)

echo Launching in original English state: %APP%
start "" "%APP%"
