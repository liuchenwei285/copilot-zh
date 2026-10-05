#Requires -Version 5.1
<#
  create-shortcut.ps1 —— 在桌面创建「GitHub Copilot（中文）」快捷方式

  用法（推荐双击 create-shortcut.cmd，或在本目录执行）：
    powershell -ExecutionPolicy Bypass -File .\create-shortcut.ps1
    powershell -ExecutionPolicy Bypass -File .\create-shortcut.ps1 -Name "Copilot 中文"
    powershell -ExecutionPolicy Bypass -File .\create-shortcut.ps1 -Remove

  说明：
    · 只创建/删除一个桌面 .lnk，不碰官方安装目录里的任何文件
    · 快捷方式指向本目录的 start-copilot-zh.cmd
    · 图标取自官方 github.exe（只读取，不修改）
#>

[CmdletBinding()]
param(
  [string]$Name = 'GitHub Copilot（中文）',
  [string]$Target,
  [switch]$Remove,
  [switch]$AllUsers
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Utf8([string]$text) { Write-Host $text }

# ---- 桌面路径（自动处理 OneDrive 重定向） ----
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop -or -not (Test-Path $desktop)) {
  $desktop = Join-Path $env:USERPROFILE 'Desktop'
}
if ($AllUsers) { $desktop = [Environment]::GetFolderPath('CommonDesktopDirectory') }

$lnkPath = Join-Path $desktop ($Name + '.lnk')

# ---- 删除模式 ----
if ($Remove) {
  if (Test-Path -LiteralPath $lnkPath) {
    Remove-Item -LiteralPath $lnkPath -Force
    Write-Utf8 "[OK] 已删除快捷方式：$lnkPath"
  } else {
    Write-Utf8 "[跳过] 快捷方式不存在：$lnkPath"
  }
  exit 0
}

# ---- 定位目标 .cmd ----
if (-not $Target) { $Target = Join-Path $here 'start-copilot-zh.cmd' }
if (-not (Test-Path -LiteralPath $Target)) {
  Write-Utf8 "[错误] 找不到启动器：$Target"
  Write-Utf8 "       请确认本脚本与 start-copilot-zh.cmd 在同一个目录里。"
  exit 1
}

# ---- 图标：优先项目自带 icon.ico，其次官方 github.exe ----
$icon = ''
$localIco = Join-Path $here 'icon.ico'
if (Test-Path -LiteralPath $localIco) {
  $icon = "$localIco,0"
} else {
  $cands = @(
    (Join-Path $here 'launcher.config.json')
  )
  # 从 launcher.config.json 里读 exe 路径（若已配置）
  $exe = ''
  $cfgPath = Join-Path $here 'launcher.config.json'
  if (Test-Path -LiteralPath $cfgPath) {
    try {
      $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.exe) { $exe = $cfg.exe }
    } catch { }
  }
  if (-not $exe) {
    $guess = @(
      (Join-Path $env:LOCALAPPDATA 'Programs\GitHub Copilot\github.exe'),
      (Join-Path $env:LOCALAPPDATA 'GitHub Copilot\github.exe'),
      (Join-Path ${env:ProgramFiles} 'GitHub Copilot\github.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'GitHub Copilot\github.exe')
    )
    # AppData 可能被重定向到别的盘，扫一遍
    foreach ($drive in 'C','D','E','F','G','H','I') {
      $p = "${drive}:\Users\$env:USERNAME\AppData\Local\Programs\GitHub Copilot\github.exe"
      $guess += $p
    }
    foreach ($g in $guess) { if ($g -and (Test-Path -LiteralPath $g)) { $exe = $g; break } }
  }
  if ($exe -and (Test-Path -LiteralPath $exe)) { $icon = "$exe,0" }
  $null = $cands
}

# ---- 创建快捷方式 ----
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath       = $Target
$lnk.WorkingDirectory = $here
$lnk.Description      = 'GitHub Copilot 桌面客户端（简体中文汉化版）'
$lnk.WindowStyle      = 1
if ($icon) { $lnk.IconLocation = $icon }
$lnk.Save()

# ---- 验证 ----
if (Test-Path -LiteralPath $lnkPath) {
  Write-Utf8 "[OK] 已在桌面创建快捷方式：$lnkPath"
  Write-Utf8 "     指向：$Target"
  if ($icon) { Write-Utf8 "     图标：$icon" }
  Write-Utf8 ""
  Write-Utf8 "以后直接双击桌面上的「$Name」即可启动汉化版 Copilot。"
} else {
  Write-Utf8 "[错误] 创建失败：$lnkPath"
  exit 1
}
