@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul
cd /d "%~dp0"

echo ============================================================
echo  以「开启 CDP」的方式启动 GitHub Copilot Desktop
echo ------------------------------------------------------------
echo  本脚本只设置一个进程级环境变量并启动官方程序：
echo    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ...
echo  它不会写入、不会修改官方安装目录里的任何文件，
echo  关闭 Copilot 后该变量即失效。
echo ============================================================
echo.

rem ---------- 端口（可用第一个参数覆盖：probe-start.cmd 9333）----------
set "PORT=%~1"
if "%PORT%"=="" set "PORT=9222"

rem ---------- 找官方 github.exe ----------
set "APP="
if exist "%LOCALAPPDATA%\Programs\GitHub Copilot\github.exe" set "APP=%LOCALAPPDATA%\Programs\GitHub Copilot\github.exe"
if not defined APP if exist "%ProgramFiles%\GitHub Copilot\github.exe" set "APP=%ProgramFiles%\GitHub Copilot\github.exe"
if not defined APP if exist "%ProgramFiles(x86)%\GitHub Copilot\github.exe" set "APP=%ProgramFiles(x86)%\GitHub Copilot\github.exe"
if not defined APP if exist "%LOCALAPPDATA%\GitHub Copilot\github.exe" set "APP=%LOCALAPPDATA%\GitHub Copilot\github.exe"

rem AppData 可能被重定向；按当前用户名跨盘兜底（不写死具体用户名或盘符）。
if not defined APP (
  for %%D in (C D E F G H I J) do (
    if not defined APP if exist "%%D:\Users\%USERNAME%\AppData\Local\Programs\GitHub Copilot\github.exe" set "APP=%%D:\Users\%USERNAME%\AppData\Local\Programs\GitHub Copilot\github.exe"
    if not defined APP if exist "%%D:\Users\%USERNAME%\AppData\Local\GitHub Copilot\github.exe" set "APP=%%D:\Users\%USERNAME%\AppData\Local\GitHub Copilot\github.exe"
  )
)

rem 兜底：在 %LOCALAPPDATA%\Programs 下扫一层
if not defined APP (
  for /d %%D in ("%LOCALAPPDATA%\Programs\*") do (
    if exist "%%~fD\github.exe" if exist "%%~fD\app-extensions" set "APP=%%~fD\github.exe"
  )
)

if not defined APP (
  echo [错误] 未找到 GitHub Copilot Desktop 的 github.exe
  echo.
  echo        已尝试：
  echo          %%LOCALAPPDATA%%\Programs\GitHub Copilot\github.exe
  echo          %%ProgramFiles%%\GitHub Copilot\github.exe
  echo.
  echo        请手动执行（把路径换成你的实际路径）：
  echo          set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=%PORT% --remote-allow-origins=*
  echo          start "" "%LOCALAPPDATA%\Programs\GitHub Copilot\github.exe"
  echo.
  pause
  exit /b 1
)

echo 应用路径 : %APP%
echo CDP 端口 : %PORT%
echo.

rem ---------- 先确认没有已在运行的实例 ----------
tasklist /FI "IMAGENAME eq github.exe" 2>nul | find /I "github.exe" >nul
if not errorlevel 1 (
  echo [注意] 检测到 github.exe 已在运行。
  echo        Copilot 是单实例应用，新进程会把请求转交给已有实例后退出，
  echo        那样 CDP 端口不会生效。
  echo        请先【完全退出】Copilot，再重新运行本脚本。
  echo.
  pause
  exit /b 1
)

set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=%PORT% --remote-allow-origins=*"
start "" "%APP%"

echo 已启动。等待 6 秒让窗口就绪 ...
timeout /t 6 /nobreak >nul

echo.
echo 下一步：双击 probe.cmd（或在本目录执行 node probe.js）
echo.
pause
