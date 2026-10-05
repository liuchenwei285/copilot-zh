@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem ============================================================
rem  GitHub Copilot（中文）—— 一键启动
rem
rem  双击本文件即可。它会：
rem    1. 检测 Copilot 是否已在运行（在运行就不再启动第二个）
rem    2. 需要时设置进程级环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
rem    3. 启动官方 github.exe（绝不修改官方安装目录里的任何文件）
rem    4. 等待 CDP 就绪 → 注入汉化 → 起一个无窗口守护进程
rem    5. 确认注入成功后【本窗口自动关闭】，汉化由守护进程维持
rem
rem  参数（可选，双击时不用管）：
rem    -k            结束后保留窗口（排查问题用）
rem    --restart     已在运行但没开调试端口时，自动关掉再重启
rem    --lang=en-US  临时以英文启动
rem ============================================================

set "KEEP="
if /i "%~1"=="-k" set "KEEP=1"

rem ---- 找 Node.js ----
set "NODE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%APPDATA%\npm\node.exe" set "NODE=%APPDATA%\npm\node.exe"
if not defined NODE if exist "%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-3\node.exe" set "NODE=%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-3\node.exe"
if not defined NODE (
  for /d %%D in ("%USERPROFILE%\.workbuddy-ai\binaries\node\versions\*") do (
    if exist "%%~fD\node.exe" if not defined NODE set "NODE=%%~fD\node.exe"
  )
)

if not defined NODE (
  echo.
  echo [错误] 未找到 Node.js。
  echo        汉化启动器需要 Node.js 22 或更高版本。
  echo        下载： https://nodejs.org/   （装 LTS 版，一路下一步即可）
  echo.
  pause
  exit /b 1
)

rem ---- 交给 Node 处理 ----
set "RC=0"
"%NODE%" "%~dp0zh-launcher.js" --start %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [提示] 启动未成功（退出码 %RC%）。
  echo        详细日志： %~dp0out\zh-daemon.log
  echo        常见原因：Copilot 已在运行但没有调试端口 —— 加参数 --restart 重试，
  echo                  或手动完全退出 Copilot（含托盘）后再双击本文件。
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
