@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem ============================================================
rem  以【原始英文状态】启动 GitHub Copilot Desktop（一键关闭汉化）
rem
rem  它会先停掉后台守护进程，然后不设任何环境变量地启动官方程序，
rem  等价于双击官方快捷方式。
rem ============================================================

rem ---- 找 Node.js（只用来停守护进程；找不到也不影响启动） ----
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

if defined NODE (
  "%NODE%" "%~dp0zh-launcher.js" --stop >nul 2>nul
) else (
  echo [提示] 未找到 Node.js，无法自动停止后台守护进程。
  echo        如果汉化还在，请完全退出 Copilot 后再重试。
)

rem ---- 定位官方程序 ----
set "APP="
if exist "%LOCALAPPDATA%\Programs\GitHub Copilot\github.exe" set "APP=%LOCALAPPDATA%\Programs\GitHub Copilot\github.exe"
if not defined APP if exist "%ProgramFiles%\GitHub Copilot\github.exe" set "APP=%ProgramFiles%\GitHub Copilot\github.exe"
if not defined APP if exist "%ProgramFiles(x86)%\GitHub Copilot\github.exe" set "APP=%ProgramFiles(x86)%\GitHub Copilot\github.exe"
if not defined APP if exist "%LOCALAPPDATA%\GitHub Copilot\github.exe" set "APP=%LOCALAPPDATA%\GitHub Copilot\github.exe"

rem AppData 有时被重定向，但 LOCALAPPDATA 环境变量未同步；按当前用户名跨盘兜底。
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
  echo [错误] 未找到 GitHub Copilot Desktop 的 github.exe
  echo        请直接用官方开始菜单快捷方式启动。
  echo.
  pause
  exit /b 1
)

echo 以原始英文状态启动：%APP%
start "" "%APP%"
