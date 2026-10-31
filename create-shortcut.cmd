@echo off
setlocal
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem ============================================================
rem  Create a "GitHub Copilot (Chinese)" shortcut on the Desktop.
rem  Just double-click this file (it calls create-shortcut.ps1 with
rem  -ExecutionPolicy Bypass).
rem  To remove the shortcut: create-shortcut.cmd -Remove
rem
rem  KEEP THIS FILE PURE ASCII -- see start-copilot-zh.cmd for why.
rem  The Chinese wording lives in create-shortcut.ps1 (UTF-8 + BOM),
rem  which PowerShell parses correctly.
rem ============================================================

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" echo   [ERROR] Failed to create the shortcut ^(exit code %RC%^).
pause
endlocal
exit /b %RC%
