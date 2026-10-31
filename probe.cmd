@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul
cd /d "%~dp0"

echo ============================================================
echo  Copilot Desktop DOM probe -- read-only
echo ============================================================
echo.

rem ---------- locate a usable node ----------
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

echo Using Node: %NODE%
echo.

"%NODE%" "%~dp0probe.js" %*

echo.
pause
