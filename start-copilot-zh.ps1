#Requires -Version 5.1
<#
  start-copilot-zh.ps1 —— 启动汉化版 GitHub Copilot（PowerShell 入口）

  与 start-copilot-zh.cmd 完全等价，都只是调用：
      node zh-launcher.js --start

  用法：
    powershell -ExecutionPolicy Bypass -File .\start-copilot-zh.ps1
    powershell -ExecutionPolicy Bypass -File .\start-copilot-zh.ps1 -Restart
    powershell -ExecutionPolicy Bypass -File .\start-copilot-zh.ps1 -Lang en-US

  日常使用请直接双击 start-copilot-zh.cmd（或桌面快捷方式）。
  本文件主要给脚本/自动化调用。
#>

[CmdletBinding()]
param(
  [switch]$Restart,
  [switch]$KeepOpen,
  [string]$Lang,
  [int]$Port = 0,
  [int]$WaitSec = 0
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $here

# ---- 找 Node.js ----
function Find-Node {
  $cands = @()
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { $cands += $cmd.Source }
  $cands += @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:APPDATA 'npm\node.exe'),
    (Join-Path $env:USERPROFILE '.workbuddy-ai\binaries\node\versions\22.22.2-3\node.exe')
  )
  $verDir = Join-Path $env:USERPROFILE '.workbuddy-ai\binaries\node\versions'
  if (Test-Path -LiteralPath $verDir) {
    Get-ChildItem -LiteralPath $verDir -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { $cands += (Join-Path $_.FullName 'node.exe') }
  }
  foreach ($c in $cands) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

$node = Find-Node
if (-not $node) {
  Write-Host ''
  Write-Host '[错误] 未找到 Node.js。汉化启动器需要 Node.js 22 或更高版本。' -ForegroundColor Red
  Write-Host '       下载： https://nodejs.org/   （装 LTS 版，一路下一步即可）'
  Write-Host ''
  if ($KeepOpen) { Read-Host '按回车关闭' | Out-Null }
  exit 1
}

# ---- 组装参数 ----
$launcherArgs = @((Join-Path $here 'zh-launcher.js'), '--start')
if ($Restart) { $launcherArgs += '--restart' }
if ($Lang)    { $launcherArgs += ('--lang=' + $Lang) }
if ($Port -gt 0)   { $launcherArgs += ('--port=' + $Port) }
if ($WaitSec -gt 0) { $launcherArgs += ('--wait=' + $WaitSec) }

# ---- 调用（Node 自己输出中文，避免 PowerShell 编码问题） ----
& $node @launcherArgs
$rc = $LASTEXITCODE

if ($rc -ne 0) {
  Write-Host ''
  Write-Host ("[提示] 启动未成功（退出码 $rc）。") -ForegroundColor Yellow
  Write-Host ("       详细日志： " + (Join-Path $here 'out\zh-daemon.log'))
  Write-Host '       常见原因：Copilot 已在运行但没有调试端口 —— 加 -Restart 重试，'
  Write-Host '                 或手动完全退出 Copilot（含托盘）后再试。'
  Write-Host ''
  if ($KeepOpen) { Read-Host '按回车关闭' | Out-Null }
}

exit $rc
