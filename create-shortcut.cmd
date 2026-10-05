@echo off
setlocal
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem ============================================================
rem  在桌面创建「GitHub Copilot（中文）」快捷方式
rem  双击本文件即可（它会用 -ExecutionPolicy Bypass 调 create-shortcut.ps1）
rem  想删掉快捷方式：create-shortcut.cmd -Remove
rem ============================================================

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" echo [提示] 创建快捷方式失败（退出码 %RC%）。
pause
endlocal
exit /b %RC%
