@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem ============================================================
rem  汉化启动器（调试模式）—— 与 start-copilot-zh.cmd 同一条路径，
rem  但结束后保留窗口，方便看诊断信息。
rem  额外输出：CDP 是否连通、注入是否成功、未匹配的 UI 文本、JS 错误
rem  结果写到 out\zh-daemon.log / out\zh-status.json
rem ============================================================

set "NODE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-3\node.exe" set "NODE=%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-3\node.exe"
if not defined NODE (
  for /d %%D in ("%USERPROFILE%\.workbuddy-ai\binaries\node\versions\*") do (
    if exist "%%~fD\node.exe" if not defined NODE set "NODE=%%~fD\node.exe"
  )
)

if not defined NODE (
  echo [错误] 未找到 Node.js。请先安装 Node.js 22+：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

"%NODE%" "%~dp0zh-launcher.js" --start --debug %*

echo.
pause
