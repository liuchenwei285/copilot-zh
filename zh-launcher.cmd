@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem ============================================================
rem  GitHub Copilot Desktop Chinese launcher (raw entry point).
rem  Only sets a per-process environment variable; never modifies
rem  any file inside the official install folder.
rem
rem  KEEP THIS FILE PURE ASCII -- see start-copilot-zh.cmd for why.
rem ============================================================

set "NODE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
  type "%~dp0tools\messages\node-missing.txt"
  echo.
  pause
  exit /b 1
)

"%NODE%" "%~dp0zh-launcher.js" %*

echo.
pause
