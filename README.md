# GitHub Copilot Desktop 简体中文运行时汉化

一个面向 **Windows 版 GitHub Copilot Desktop** 的简体中文运行时汉化工具。它通过独立启动器连接本机 WebView2 页面，只翻译白名单内的界面文案；不修改 Copilot 官方安装文件。

> 本项目是社区维护的非官方工具，与 GitHub 无隶属关系。

## 项目简介

GitHub Copilot Desktop 的部分界面文案目前没有被本项目覆盖。本工具用精确词典将已适配的界面文字显示为简体中文。

**想使用中文界面，需通过本项目的启动方式打开 Copilot。** 直接使用官方图标启动时，不会自动加载本项目的运行时汉化。

## 当前支持

- **操作系统：** Windows
- **应用：** GitHub Copilot Desktop（独立桌面客户端；不是 VS Code，也不是 GitHub Desktop）
- **当前实测基线：** GitHub Copilot Desktop **1.1.26**
- **其他版本：** 未保证兼容。Copilot 更新后页面结构可能变化，选择器和词典可能需要重新适配。

历史验收记录：静态校验 0 条警告；`selftest.js` 216 项通过；真实运行中的 1.1.26 实例 `live-check.js` 曾记录 40 项通过、0 项失败、3 项跳过。**完整的冷启动、关闭后重开及桌面端持久化流程尚未得到可靠的端到端验收；这些记录不代表所有机器和页面都能正常工作。**

## 工作原理

1. 启动器给本次启动的 Copilot 进程附加一个 WebView2 调试参数。
2. Copilot 打开后，启动器通过本机 CDP 连接页面并注入汉化运行时。
3. 运行时只在明确列出的界面区域内查找词典中的文字；页面切换或动态更新时会再次处理。

它不会把词典中的文字全局替换，也不会有意翻译聊天正文、用户输入、代码、终端或 diff。运行时翻译结果仅存在于当前页面，不写入 Copilot 官方文件。

## 使用前准备

- Windows 电脑。
- 已安装 GitHub Copilot Desktop。
- **Node.js 22 或更高版本。** 启动器、探测器和测试使用 Node.js；运行时使用 Node 内置模块及全局 WebSocket，不需要通过 npm 安装项目依赖。
- 创建桌面快捷方式需要 Windows PowerShell（Windows 通常自带）。日常双击启动不需要手动打开 PowerShell。
- 不需要 Git 才能使用下载的项目文件夹。

## 安装

1. 从本项目的 GitHub 页面下载 ZIP 压缩包：在页面选择 **Code（代码）→ Download ZIP（下载 ZIP）**。
2. 解压整个压缩包到一个你容易找到的位置。不要只复制单个脚本；启动器需要同目录下的词典和 `runtime` 文件夹。
3. 安装 Node.js 22 或更高版本。请从 Node.js 官方网站获取安装程序：<https://nodejs.org/>。
4. 打开 Windows 命令提示符，输入 `node -v` 并回车。应显示 `v22` 或更高的版本号。

本项目不需要执行 `npm install`。

## 第一次启动

1. 如果 Copilot 已打开，请先从 Copilot 菜单正常退出，并确认托盘中也没有仍在运行的实例。
2. 在解压后的项目文件夹中双击 `start-copilot-zh.cmd`。
3. 等待 Copilot 页面加载和注入。若启动器提示已有实例但没有调试端口，按提示选择是否关闭并重新启动。
4. 启动器成功确认注入后会退出前台窗口；后台守护进程负责维持 CDP 连接。

如果窗口报告失败，请保留完整错误文字。不要反复启动多个实例；先查看本 README 的“常见问题”。

## 日常使用

- 每次希望使用中文界面，都通过 `start-copilot-zh.cmd` 启动 Copilot。
- 可选：双击 `create-shortcut.cmd`，在桌面创建 **GitHub Copilot（中文）** 快捷方式。此脚本会调用 PowerShell 创建快捷方式。
- 也可以使用 `start-copilot-zh.ps1` 作为 PowerShell 启动入口。

## 恢复英文

`zh-off.cmd` 会尝试停止项目的后台守护进程，并在**不附加本项目 CDP 参数**的情况下启动官方 Copilot。

如果 Copilot 已经打开，先完全退出它（包括托盘），再运行 `zh-off.cmd`。否则 Copilot 的单实例机制可能把启动请求转交给现有实例，已经注入的运行时也可能继续留在当前页面，直到页面关闭或刷新。

## 卸载

1. 先完全退出 Copilot。
2. 在项目文件夹中运行 `node zh-launcher.js --stop`，确认停止本项目的后台守护进程。
3. 若创建过桌面快捷方式，在项目文件夹中运行 `create-shortcut.cmd -Remove`。
4. 删除你解压出来的 **copilot-zh 项目文件夹**。
5. 以后从官方 Copilot 快捷方式启动即可。

以上操作不卸载、不修改 Copilot。卸载前先关闭应用，避免已注入的页面仍留在运行中的进程里。请不要删除 Copilot 官方安装目录来卸载本汉化工具。

## 常见问题

### 双击 CMD 后出现乱码或“不是内部或外部命令”

Windows 批处理需要 CRLF 换行。本项目的 `.cmd` 文件已使用 CRLF，并由自测检查。若错误仍出现，先重新下载/解压完整项目，不要将脚本内容粘贴到命令提示符中执行。

### 找不到 Node.js

安装 Node.js 22 或更高版本，然后关闭并重新打开命令提示符，再运行 `node -v` 检查。启动脚本会尝试从 PATH 和常见安装位置查找 Node.js。

### Copilot 已经运行，但启动器说没有调试端口

Copilot 是单实例应用。先完全退出（含托盘），然后重新双击 `start-copilot-zh.cmd`。不要从官方图标再启动一个实例来代替。

### Copilot 提示启动超时

这表示 Copilot 自己没有及时完成前端启动，不等同于汉化注入一定失败。先尝试用官方方式启动 Copilot，确认应用本身能够进入主界面；记录 Copilot 版本和完整错误信息，再按“反馈问题”提交脱敏信息。

### 有些文字仍是英文

本工具只翻译白名单中的界面区域和词典/模板覆盖的文字。未命中的内容会保持原文；Copilot 更新也可能改变界面结构。可以用 `zh-launcher-debug.cmd` 收集调试报告，但报告可能包含页面文字，公开分享前必须仔细脱敏。

## 已知限制

- 目前以 GitHub Copilot Desktop 1.1.26 为实测基线，**不保证其他版本兼容**。
- 完整冷启动、退出后重开和桌面端持久化启动流程尚未完成可靠的端到端验收；请勿将历史单实例的 `live-check.js` 结果理解为对完整启动流程的保证。
- 词典和选择器覆盖有限；特定页面、弹窗或动态内容可能保留英文。
- Copilot 页面结构、WebView2/CDP 行为变化时，启动和注入可能失败，需要重新适配。
- CDP 调试端口在 Copilot 运行期间开启。本工具面向本机使用，不应把调试端口暴露给不可信网络或其他用户。
- 运行时注入不是官方支持的扩展接口；Copilot 更新可能随时破坏兼容性。

## 隐私与安全

- 项目代码用于本机启动、连接本机 CDP、读取或修改白名单内的界面 DOM；**本项目本身没有向第三方服务器上传数据的功能**。
- `probe.js` 会读取当前页面 DOM，并把采集结果（可能包含页面文字、仓库/会话标识等）写入本地 `out/`。不要把这些扫描结果上传到公开仓库或未经脱敏地发给他人。
- `.gitignore` 排除了整个 `out/` 目录及日志、PID、临时文件；发布前仍应人工检查准备提交的文件。
- 本项目不控制 GitHub Copilot 官方应用自身的联网、遥测、登录或数据处理行为；这些属于官方应用的行为范围。
- 启动器不会改写 `github.exe`、Copilot 安装目录或官方资源文件。请只从可信来源获取项目，并在更新后重新检查文件。

## 反馈问题

项目公开发布后，可在 GitHub 仓库的 **Issues（问题）** 页面提交反馈。请附上：

- Copilot Desktop 版本（可在应用“关于”页面查看）。
- Windows 版本（运行 `winver` 查看）。
- 发生问题的步骤和完整错误文字。
- 必要时提供脱敏后的 `out/zh-daemon.log` 或 Copilot 日志片段。

提交前请删除账号名、仓库名、会话标题/正文、文件路径中的个人用户名、Cookie、Token、密钥及其他个人信息。不要公开上传整个 `out/` 目录。

## 许可证

本项目采用 **MIT License**，完整文本见 [`LICENSE`](LICENSE)。版权声明使用公开署名 `copilot-zh contributors`，年份为 2026，不包含个人真实姓名。MIT 允许使用、复制、修改和再分发，但需保留版权与许可声明；软件按“现状”提供，不附带担保。该许可证不授予 GitHub 商标或 Copilot 官方软件的权利。

## 项目文件

```text
copilot-zh/
├── .gitignore
├── LICENSE
├── README.md
├── create-shortcut.cmd
├── create-shortcut.ps1
├── keep.json
├── launcher.config.json
├── probe-start.cmd
├── probe.cmd
├── probe.js
├── start-copilot-zh.cmd
├── start-copilot-zh.ps1
├── zh-CN.json
├── zh-launcher-debug.cmd
├── zh-launcher.cmd
├── zh-launcher.js
├── zh-off.cmd
├── runtime/
│   ├── patterns.json
│   ├── selectors.json
│   └── zh-runtime.js
└── tools/
    ├── fixture.html
    ├── live-check.js
    ├── selftest.js
    ├── state-probe.js
    └── verify.js
```

树中只列出源码、说明和测试文件。运行时生成的 `out/` 内容属于本机数据，已由 `.gitignore` 排除，不应上传。
