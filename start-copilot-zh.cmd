@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem ============================================================
rem  GitHub Copilot (Chinese) -- one-click launcher
rem
rem  Just double-click this file. It will:
rem    1. Check whether Copilot is already running (never start a 2nd one)
rem    2. Set the per-process env var WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
rem    3. Start the official github.exe (never touches its install folder)
rem    4. Wait for CDP -> inject the Chinese runtime -> start a windowless daemon
rem    5. Close this window once injection is confirmed; the daemon keeps it alive
rem
rem  Optional arguments (not needed when double-clicking):
rem    -k            keep this window open when done (troubleshooting)
rem    --restart     Copilot is running without a debug port -> restart it
rem    --lang=en-US  start in English (translation disabled)
rem
rem  ------------------------------------------------------------
rem  KEEP THIS FILE PURE ASCII -- do not add Chinese text here.
rem  cmd.exe mis-parses a batch file that mixes "chcp 65001" with
rem  multi-byte characters: it loses sync and turns comment text into
rem  bogus commands ("'xxx' is not recognized as an internal or
rem  external command"). Verified on Windows 11 / cmd 10.0.
rem  Chinese console messages are printed with "type" from the UTF-8
rem  files in tools\messages\ instead -- that path is safe.
rem  ------------------------------------------------------------
rem ============================================================

set "KEEP="
if /i "%~1"=="-k" set "KEEP=1"

rem ---- locate Node.js ----
set "NODE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%APPDATA%\npm\node.exe" set "NODE=%APPDATA%\npm\node.exe"

if not defined NODE (
  type "%~dp0tools\messages\node-missing.txt"
  echo.
  pause
  exit /b 1
)

rem ---- hand over to Node ----
set "RC=0"
"%NODE%" "%~dp0zh-launcher.js" --start %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo   [ERROR] Launcher did not succeed ^(exit code %RC%^).
  echo           Full log : out\zh-daemon.log
  echo           If Copilot is already running without a debug port, retry:
  echo             start-copilot-zh.cmd --restart
  echo           Otherwise fully quit Copilot ^(including the tray icon^) and
  echo           double-click this file again.
  echo.
  pause
  exit /b %RC%
)

if defined KEEP (
  echo.
  pause
)

endlocal
exit /b 0
