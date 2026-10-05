@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul
cd /d "%~dp0"

echo ============================================================
echo  Copilot Desktop DOM 探测（只读）
echo ============================================================
echo.

rem ---------- 找一个可用的 node ----------
set "NODE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
  echo [错误] 未找到 Node.js。
  echo        请先安装 Node.js 22 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo 使用 Node: %NODE%
echo.

"%NODE%" "%~dp0probe.js" %*

echo.
pause
