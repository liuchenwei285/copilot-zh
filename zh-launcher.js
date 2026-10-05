#!/usr/bin/env node
/* =============================================================================
 * zh-launcher.js —— GitHub Copilot Desktop 简体中文汉化启动器（P2）
 * -----------------------------------------------------------------------------
 * 它做什么：
 *   1. 找到官方 github.exe（优先读配置，其次按候选路径搜索）
 *   2. 挑一个 127.0.0.1 上的空闲端口（默认固定 9222）
 *   3. 只通过【进程级环境变量】让 WebView2 打开 CDP，然后启动官方程序
 *   4. 连上 CDP，把 runtime/zh-runtime.js 用
 *      Page.addScriptToEvaluateOnNewDocument 注入
 *   5. 官方程序退出后自动退出
 *
 * 两种运行形态（关键）：
 *   --start    前台模式：检测/启动/等待/确认注入，**确认后立刻退出窗口**
 *   --daemon   后台模式：无窗口守护进程，持有 CDP 会话
 *
 *   为什么要拆成两个？
 *     CDP 的 Page.addScriptToEvaluateOnNewDocument 注册是【挂在连接上的】，
 *     连接一断，刷新页面就没人再注入 → 汉化丢失。
 *     所以「窗口立刻关掉」和「刷新后仍然汉化」只能靠一个无窗口守护进程同时满足：
 *     双击 → 前台确认成功 → 窗口消失 → 后台守护默默续命 → Copilot 退出后守护自杀。
 *
 * 它绝不做什么：
 *   - 不写入、不修改、不替换官方安装目录里的任何文件
 *   - 不修改 github.exe
 *   - 不碰登录 / 网络 / 更新流程
 *   - 不修改用户输入、AI 回复、代码、Markdown、模型名
 *
 * 零依赖，只用 Node 内置模块。
 *
 * 用法：
 *   node zh-launcher.js --start             ★ 推荐：一条命令搞定（双击 start-copilot-zh.cmd）
 *   node zh-launcher.js                    启动并汉化，前台守护（Ctrl+C 结束）
 *   node zh-launcher.js --debug            额外输出未翻译文本与错误
 *   node zh-launcher.js --lang=en-US       启动但不汉化（关闭开关）
 *   node zh-launcher.js --attach           不启动程序，只汉化已在运行的 Copilot
 *   node zh-launcher.js --stop             停掉后台守护进程
 *   node zh-launcher.js --port=9222        固定 CDP 端口
 *   node zh-launcher.js --exe="D:\\...\\github.exe"
 * ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');

const LAUNCHER_VERSION = '2.2.0';
const HERE = __dirname;
const RUNTIME_DIR = path.join(HERE, 'runtime');
const OUT_DIR = path.join(HERE, 'out');
const PID_FILE = path.join(OUT_DIR, 'zh-daemon.pid');
const DAEMON_LOG = path.join(OUT_DIR, 'zh-daemon.log');
const STATUS_FILE = path.join(OUT_DIR, 'zh-status.json');
/* 守护进程写、前台 --start 读：注入是否已经建立。
   为什么不让 --start 自己去连 CDP 判断：前台和守护会同时向同一个 target 开连接，
   而 WebView2 的 DevTools HTTP 服务在应用启动期经常「TCP 能连、HTTP 不响应」，
   实测导致前台明明汉化已经生效却报超时（假失败）。
   让真正做注入的守护进程写一份状态出来，前台读文件即可，唯一事实来源。 */
const STATE_FILE = path.join(OUT_DIR, 'zh-daemon-state.json');
const DEFAULT_PORT = 9222;

/* ------------------------------------------------------------------ CLI --- */

function parseArgs(argv) {
  const o = {
    lang: null, port: 0, exe: null, debug: false,
    attach: false, waitSec: 120, help: false, match: null,
    start: false, daemon: false, stop: false, restart: false, yes: false
  };
  for (const a of argv.slice(2)) {
    if (a === '--debug') o.debug = true;
    else if (a === '--attach' || a === '--no-launch') o.attach = true;
    else if (a === '--start') o.start = true;
    else if (a === '--daemon') o.daemon = true;
    else if (a === '--stop') o.stop = true;
    else if (a === '--restart') o.restart = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--lang=')) o.lang = a.slice(7).trim();
    else if (a.startsWith('--port=')) o.port = Number(a.slice(7)) || 0;
    else if (a.startsWith('--exe=')) o.exe = a.slice(6).replace(/^"|"$/g, '');
    else if (a.startsWith('--wait=')) o.waitSec = Number(a.slice(7)) || 120;
    else if (a.startsWith('--match=')) o.match = a.slice(8);
  }
  return o;
}

const OPT = parseArgs(process.argv);

const HELP = `
zh-launcher.js ${LAUNCHER_VERSION} —— GitHub Copilot Desktop 汉化启动器

  node zh-launcher.js --start        ★ 一条命令：检测/启动/等待/注入，成功后窗口自动关闭
  node zh-launcher.js --start --restart   已在运行但没开调试端口时，自动关掉再重启
  node zh-launcher.js --start --yes       同上，但不询问（适合脚本/快捷方式）
  node zh-launcher.js --stop         停掉后台守护进程（下次启动 Copilot 就不再汉化）
  node zh-launcher.js --daemon       后台守护模式（无窗口；由 --start 自动拉起，一般不用手动跑）
  node zh-launcher.js                前台守护模式（窗口保持打开，Ctrl+C 结束）
  node zh-launcher.js --debug        输出 CDP/注入状态、未翻译文本、JS 错误
  node zh-launcher.js --lang=en-US   启动但不汉化（一键关闭）
  node zh-launcher.js --attach       只汉化已在运行的 Copilot（不启动新进程）
  node zh-launcher.js --no-launch    同 --attach（别名）
  node zh-launcher.js --port=9222    固定 CDP 端口（--start 默认 9222）
  node zh-launcher.js --exe=PATH     手动指定 github.exe
  node zh-launcher.js --wait=120     等待 CDP 就绪的上限秒数（默认 120）
  node zh-launcher.js --match=REGEX  目标页面 URL 匹配规则（默认 tauri\\.localhost）
  node zh-launcher.js --help         显示本帮助

  说明：只设置进程级环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS，
        不修改、不写入官方安装目录里的任何文件。

  日志：out/zh-daemon.log      状态：out/zh-status.json
`;

/* ------------------------------------------------------------- 日志工具 --- */

const C = { dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', off: '\x1b[0m' };
const log = (...a) => console.log(...a);
const info = (...a) => console.log(C.dim + '  ' + a.join(' ') + C.off);
const ok = (...a) => console.log(C.green + '  ✓ ' + a.join(' ') + C.off);
const warn = (...a) => console.warn(C.yellow + '  ! ' + a.join(' ') + C.off);
const bad = (...a) => console.error(C.red + '  ✗ ' + a.join(' ') + C.off);

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) { /* noop */ }
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- 配置加载 --- */

const DEFAULT_SEARCH = [
  '%LOCALAPPDATA%\\Programs\\GitHub Copilot\\github.exe',
  '%LOCALAPPDATA%\\GitHub Copilot\\github.exe',
  '%ProgramFiles%\\GitHub Copilot\\github.exe',
  '%ProgramFiles(x86)%\\GitHub Copilot\\github.exe',
  '%ProgramW6432%\\GitHub Copilot\\github.exe'
];

function expandEnv(p) {
  return String(p).replace(/%([^%]+)%/g, (m, name) => {
    const v = process.env[name];
    return v == null ? m : v;
  });
}

function loadConfig() {
  const cfgPath = path.join(HERE, 'launcher.config.json');
  const cfg = readJsonSafe(cfgPath, null);
  return {
    path: cfgPath,
    exists: !!cfg,
    exe: (cfg && typeof cfg.exe === 'string' && cfg.exe.trim()) ? cfg.exe.trim() : '',
    exeSearch: (cfg && Array.isArray(cfg.exeSearch) && cfg.exeSearch.length) ? cfg.exeSearch : DEFAULT_SEARCH,
    port: (cfg && Number(cfg.port)) || 0,
    lang: (cfg && typeof cfg.lang === 'string' && cfg.lang) ? cfg.lang : 'zh-CN',
    debug: !!(cfg && cfg.debug),
    extraBrowserArgs: (cfg && typeof cfg.extraBrowserArgs === 'string') ? cfg.extraBrowserArgs : ''
  };
}

/* ------------------------------------------------------------- 定位 exe --- */

/* 在 <盘>:\\Users\\*\\AppData\\Local\\Programs\\* 下扫一层（AppData 可能被重定向到非 C 盘） */
function scanDrives(username) {
  const hits = [];
  const letters = 'CDEFGHIJ';
  for (const L of letters) {
    const base = L + ':\\Users\\' + username + '\\AppData\\Local';
    for (const sub of ['\\Programs', '']) {
      const dir = base + sub;
      let names;
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const d of names) {
        if (!d.isDirectory()) continue;
        if (!/copilot|github/i.test(d.name)) continue;
        const exe = path.join(dir, d.name, 'github.exe');
        if (fs.existsSync(exe)) hits.push(exe);
      }
    }
  }
  return hits;
}

function resolveExe(cfg) {
  const tried = [];
  const push = (label, p) => {
    if (!p) return null;
    const full = path.resolve(expandEnv(p));
    tried.push({ label, path: full, exists: fs.existsSync(full) });
    return fs.existsSync(full) ? full : null;
  };

  /* 1. 命令行 --exe */
  if (OPT.exe) {
    const r = push('--exe 参数', OPT.exe);
    if (r) return { exe: r, tried, how: '--exe 参数' };
  }
  /* 2. 配置文件里的 exe */
  if (cfg.exe) {
    const r = push('launcher.config.json', cfg.exe);
    if (r) return { exe: r, tried, how: 'launcher.config.json' };
  }
  /* 3. 候选路径（使用环境变量覆盖用户级与系统级常见安装位置） */
  for (const p of cfg.exeSearch) {
    const r = push('候选路径', p);
    if (r) return { exe: r, tried, how: '候选路径 ' + expandEnv(p) };
  }
  /* 4. 兜底：扫盘 */
  const user = process.env.USERNAME || os.userInfo().username;
  for (const p of scanDrives(user)) {
    const r = push('扫盘发现', p);
    if (r) return { exe: r, tried, how: '扫盘发现' };
  }
  return { exe: null, tried, how: null };
}

/* ------------------------------------------------------------- 端口选择 --- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/* ------------------------------------------------------------ HTTP 小工具 --- */

function httpGetJson(port, urlPath, timeoutMs = 700) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get(
      { host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs, headers: { Host: '127.0.0.1:' + port } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 8e6) req.destroy(); });
        res.on('end', () => { try { finish(JSON.parse(body)); } catch (e) { finish(null); } });
      }
    );
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

/* ------------------------------------------------------------ CDP 客户端 --- */

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
    this.closed = false;
  }

  connect(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; try { this.ws && this.ws.close(); } catch (e) {} reject(new Error('CDP WebSocket 连接超时')); }
      }, timeoutMs);

      let ws;
      try { ws = new WebSocket(this.wsUrl); } catch (e) { clearTimeout(timer); return reject(e); }
      this.ws = ws;

      ws.addEventListener('open', () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); });
      ws.addEventListener('error', (ev) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        reject(new Error('CDP WebSocket 错误: ' + ((ev && ev.message) || 'unknown')));
      });
      ws.addEventListener('close', () => {
        this.closed = true;
        for (const [, p] of this.pending) p.reject(new Error('CDP 连接已关闭'));
        this.pending.clear();
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('CDP 连接被关闭')); }
      });
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      });
    });
  }

  send(method, params = {}, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(new Error('CDP 已关闭'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 调用超时: ' + method)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  close() { try { this.ws && this.ws.close(); } catch (e) { /* noop */ } }
}

/* --------------------------------------------------- 找到 tauri.localhost --- */

/* 浏览器内部页面（edge:// chrome:// devtools:// …）永远不是我们的目标 */
const INTERNAL_URL = /^(?:edge|chrome|devtools|about|chrome-extension|extension):/i;

function compileMatch() {
  const src = OPT.match || 'tauri\\.localhost';
  try { return new RegExp(src, 'i'); } catch (e) { return /tauri\.localhost/i; }
}

async function findTauriTarget(port, matchRe) {
  const list = await httpGetJson(port, '/json/list', 900);
  if (!Array.isArray(list)) return null;
  const re = matchRe || compileMatch();
  const pages = list.filter((t) => t && t.type === 'page' && (t.webSocketDebuggerUrl || t.ws));
  if (!pages.length) return null;
  /* 只认「非浏览器内部页」。
     启动初期 WebView2 往往只有一个 about:blank 临时页，它会被立刻销毁；
     如果在这里回退取它，注入就会打在死页上（连上→断开→守护进程崩）。
     所以内部页一律不算数，宁可继续等真正的 tauri.localhost 出现。 */
  const usable = pages.filter((t) => !INTERNAL_URL.test(t.url || ''));
  if (!usable.length) return null;
  const hit = usable.find((t) => re.test(t.url || '')) || usable[0];
  if (!hit) return null;
  return { id: hit.id, url: hit.url, title: hit.title, ws: hit.webSocketDebuggerUrl || hit.ws };
}

async function waitForCdp(port, maxMs, onTick, matchRe) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const ver = await httpGetJson(port, '/json/version', 500);
    if (ver && ver.Browser) {
      const target = await findTauriTarget(port, matchRe);
      if (target) return { browser: ver.Browser, target };
    }
    if (onTick) onTick(Date.now() - t0);
    await sleep(500);
  }
  return null;
}

/* -------------------------------------------------------- 已运行的实例检查 --- */

function listGithubProcs() {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn('tasklist', ['/FI', 'IMAGENAME eq github.exe', '/NH'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { return resolve([]); }
    const timer = setTimeout(() => { try { p.kill(); } catch (e) {} resolve([]); }, 6000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve([]); });
    p.on('close', () => {
      clearTimeout(timer);
      const pids = [];
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/github\.exe\s+(\d+)/i);
        if (m) pids.push(Number(m[1]));
      }
      resolve(pids);
    });
  });
}

/* ------------------------------------------------- Copilot 进程控制 / 询问 --- */

/* 统一用异步 spawn 跑外部命令。
   刻意不用 spawnSync：同步子进程在部分受限环境（含本项目作者的沙箱）会直接
   报 EBUSY，导致 --stop / killGithub 静默失效。异步版没有这个问题。 */
function runAsync(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (code, extra) => {
      if (done) return;
      done = true;
      resolve(Object.assign({ code, out, err }, extra || {}));
    };
    let p;
    try {
      p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return finish(-1, { spawnError: e.message }); }
    const timer = setTimeout(() => { try { p.kill(); } catch (e) { /* noop */ } finish(-1, { timedOut: true }); }, timeoutMs || 15000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); finish(-1, { spawnError: e.message }); });
    p.on('close', (code) => { clearTimeout(timer); finish(code == null ? -1 : code); });
  });
}

/* 先温和关闭（等同点右上角 ×），3 秒后还在就强杀 */
async function killGithub() {
  await runAsync('taskkill', ['/IM', 'github.exe', '/T'], 12000);
  await sleep(3000);
  let left = await listGithubProcs();
  if (!left.length) return true;
  await runAsync('taskkill', ['/IM', 'github.exe', '/T', '/F'], 12000);
  await sleep(1500);
  left = await listGithubProcs();
  return left.length === 0;
}

async function isPidAlive(pid) {
  if (!pid) return false;
  const r = await runAsync('tasklist', ['/FI', 'PID eq ' + pid, '/NH'], 8000);
  return new RegExp('\\b' + pid + '\\b').test(r.out || '');
}

async function readPidFile() {
  const o = readJsonSafe(PID_FILE, null);
  if (!o || typeof o.pid !== 'number') return null;
  if (!(await isPidAlive(o.pid))) {
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* noop */ }
    return null;
  }
  return o;
}

function writePidFile(extra) {
  ensureDir(OUT_DIR);
  try {
    fs.writeFileSync(PID_FILE, JSON.stringify(Object.assign({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      port: OPT.port || 0
    }, extra || {}), null, 2), 'utf8');
  } catch (e) { /* noop */ }
}

function removePidFile() {
  try {
    const o = readJsonSafe(PID_FILE, null);
    if (!o || o.pid === process.pid) fs.unlinkSync(PID_FILE);
  } catch (e) { /* noop */ }
}

function killPid(pid) {
  return runAsync('taskkill', ['/PID', String(pid), '/T', '/F'], 12000);
}

/* 停掉后台守护。quiet=true 时不打印（供 --start 内部静默清理） */
async function stopDaemon(quiet) {
  const cur = await readPidFile();
  if (!cur) {
    if (!quiet) info('没有正在运行的后台守护进程。');
    return false;
  }
  await killPid(cur.pid);
  await sleep(600);
  removePidFile();
  if (!quiet) ok('已停止后台守护进程（PID ' + cur.pid + '）。');
  return true;
}

function ask(question, defaultYes) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(defaultYes ? 'y' : 'n');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(String(a || '').trim() || (defaultYes ? 'y' : 'n')); });
  });
}

/* --------------------------------------------- 后台守护：日志重定向 / 启动 --- */

const ANSI = /\x1b\[[0-9;]*m/g;

function redirectToLog(logPath) {
  ensureDir(path.dirname(logPath));
  /* 超过 1MB 就截断，避免日志无限长大 */
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) fs.unlinkSync(logPath);
  } catch (e) { /* noop */ }
  let fd;
  try { fd = fs.openSync(logPath, 'a'); } catch (e) { return; }
  const fmt = (a) => a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch (e2) { return String(x); } })())).join(' ').replace(ANSI, '');
  const w = (prefix) => (...a) => {
    try { fs.writeSync(fd, new Date().toISOString() + ' ' + prefix + fmt(a) + '\n'); } catch (e) { /* noop */ }
  };
  console.log = w('');
  console.error = w('[err] ');
  console.warn = w('[warn] ');
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  console.log('===== daemon 启动 PID ' + process.pid + ' =====');
}

function spawnDaemon(port, lang, debug) {
  /* 守护进程的等待预算要比前台 --start 更宽：
     前台 90 秒确认不了会报错退出，但守护进程还应该继续努力
     （用户机器慢、首次登录、安全软件拖慢启动都可能超过 90 秒）。
     最小 300 秒，避免出现「前台放弃了、后台也刚好放弃」的死局。 */
  const daemonWait = Math.max(OPT.waitSec, 300);
  const args = [__filename, '--daemon', '--port=' + port, '--lang=' + lang, '--wait=' + daemonWait];
  if (debug) args.push('--debug');
  if (OPT.exe) args.push('--exe=' + OPT.exe);
  if (OPT.match) args.push('--match=' + OPT.match);
  const p = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: HERE,
    env: Object.assign({}, process.env, { ZH_DAEMON: '1' })
  });
  p.unref();
  return p.pid;
}

function writeStatus(obj) {
  try { writeJson(STATUS_FILE, obj); } catch (e) { /* noop */ }
}

/* 守护进程 → 前台的状态通道。写失败不影响主流程。 */
function writeState(obj) {
  try {
    writeJson(STATE_FILE, Object.assign({ pid: process.pid, at: new Date().toISOString() }, obj || {}));
  } catch (e) { /* noop */ }
}

function readState() {
  const o = readJsonSafe(STATE_FILE, null);
  if (!o || typeof o.pid !== 'number') return null;
  return o;
}

function removeStateFile() {
  try { fs.unlinkSync(STATE_FILE); } catch (e) { /* noop */ }
}

/* ------------------------------------------------- 应用自身日志诊断 --- */

/* 官方 github.exe 会自己写日志到 %USERPROFILE%\.copilot\logs\github-app.<pid>.log。
   当 CDP 一直连不上时，读它比猜有用得多 —— 实测最常见的失败是应用自带的
   启动看门狗报 frontend.startup_timed_out（前端 30 秒内没变成 interactive），
   根因通常是 WebView2 的 GPU / Storage / browser 子进程崩溃（exit_code=7、
   -2147483645 即 0x80000003 STATUS_BREAKPOINT）。 */
function appLogDir() {
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.copilot', 'logs');
}

function latestAppLog() {
  try {
    const dir = appLogDir();
    const files = fs.readdirSync(dir).filter((f) => /^github-app\.\d+\.log$/.test(f));
    if (!files.length) return null;
    let best = null, bestT = -1;
    for (const f of files) {
      const p = path.join(dir, f);
      const t = fs.statSync(p).mtimeMs;
      if (t > bestT) { bestT = t; best = p; }
    }
    return best;
  } catch (e) { return null; }
}

function diagnoseAppLog() {
  const p = latestAppLog();
  if (!p) return { path: null, verdict: 'not-found', lines: [], flags: {} };
  let txt = '';
  try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { return { path: p, verdict: 'unreadable', lines: [], flags: {} }; }
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const flags = {
    frontendTimeout: /frontend\.startup_timed_out|Frontend did not become interactive/.test(txt),
    webviewCrashed: /WebView2 process failure/.test(txt),
    childCrash: /exit_code=7\b/.test(txt),
    browserBreakpoint: /exit_code=-2147483645/.test(txt)
  };
  let verdict = 'ok';
  if (flags.frontendTimeout) verdict = 'frontend-timeout';
  else if (flags.webviewCrashed) verdict = 'webview-crash';
  return { path: p, verdict, flags, lines: lines.slice(-10) };
}

/* ------------------------------------------------------- --start 主流程 --- */

/* 前台「一键启动」：检测 → 启动 → 等 CDP → 起后台守护 → 确认注入 → 退出 */
async function startMode() {
  const cfg = loadConfig();
  const lang = OPT.lang || cfg.lang || 'zh-CN';
  const debug = OPT.debug || cfg.debug;
  const port = OPT.port || cfg.port || DEFAULT_PORT;
  const matchRe = compileMatch();

  log('');
  log('=== GitHub Copilot（中文）启动器 v' + LAUNCHER_VERSION + ' ===');
  log('');

  if (!['zh-CN', 'en-US'].includes(lang)) { bad('不支持的 --lang=' + lang); return 2; }

  let assets;
  try { assets = loadAssets(); }
  catch (e) { bad(e.message); return 2; }

  /* 1. 清掉旧守护，避免重复注入 */
  const hadDaemon = await stopDaemon(true);
  if (hadDaemon) info('已停掉上一次遗留的后台守护进程。');

  /* 2. 定位 exe */
  const r = resolveExe(cfg);
  if (!r.exe) {
    bad('找不到 GitHub Copilot 的 github.exe。');
    log('');
    log('  已尝试以下路径：');
    for (const t of r.tried.slice(0, 12)) log('    ' + (t.exists ? '[有] ' : '[无] ') + t.path);
    log('');
    log('  请在 launcher.config.json 里把 exe 填成实际路径。');
    return 2;
  }
  info('程序：' + r.exe);
  info('资源版本：' + assets.version + '（词典 ' + assets.counts.dict + ' 条）');

  /* 3. 已在运行？ */
  let running = await listGithubProcs();
  let needLaunch = false;
  let launched = false;

  if (running.length) {
    const cdp = await waitForCdp(port, 2500, null, matchRe);
    if (cdp) {
      info('Copilot 已在运行，且调试端口 ' + port + ' 可用 → 直接注入，不重复启动。');
    } else {
      warn('检测到 Copilot 已在运行（PID ' + running.join(', ') + '），但它没有开启调试端口。');
      warn('Copilot 是单实例应用，无法给已运行的实例补开端口。');
      /* --restart = 明确要求重启；--yes = 对提示回答「是」。
         非交互环境（stdin 不是 TTY）下 ask() 会返回默认值「是」。 */
      let doRestart = OPT.restart || OPT.yes;
      if (!doRestart) {
        const a = await ask('  是否关闭它并以汉化模式重新启动？[Y/n] ', true);
        doRestart = !/^n/i.test(a);
      }
      if (!doRestart) {
        bad('已取消。请手动完全退出 Copilot 后再运行本启动器。');
        writeStatus({ ok: false, reason: 'already-running-no-cdp', at: new Date().toISOString() });
        return 3;
      }
      info('正在关闭已在运行的 Copilot …');
      await killGithub();
      running = await listGithubProcs();
      if (running.length) { bad('没能关闭 Copilot（PID ' + running.join(', ') + '），请手动退出后重试。'); return 3; }
      ok('已关闭。');
      needLaunch = true;
    }
  } else {
    needLaunch = true;
  }

  /* 4. 启动官方程序（只加一个进程级环境变量，detached 以便本窗口关闭后它继续活着） */
  if (needLaunch) {
    const browserArgs = '--remote-debugging-port=' + port + ' --remote-allow-origins=*'
      + (cfg.extraBrowserArgs ? ' ' + cfg.extraBrowserArgs : '');
    info('设置 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=' + browserArgs);
    info('（仅本次进程有效，不写入任何文件）');
    try {
      const child = spawn(r.exe, [], {
        env: Object.assign({}, process.env, { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs }),
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.on('error', (e) => bad('启动失败：' + e.message));
      child.unref();
      launched = true;
      ok('已启动 GitHub Copilot，等待 WebView2 就绪 …');
    } catch (e) {
      bad('启动失败：' + e.message);
      return 2;
    }
  }

  /* 5. 起后台守护（无窗口）。由它持有 CDP 会话 → 刷新页面也不会丢汉化 */
  removeStateFile();                     /* 清掉上一次的残留，避免把旧的成功当成本次的 */
  const dpid = spawnDaemon(port, lang, debug);
  info('后台守护进程 PID ' + dpid + '（无窗口，Copilot 退出后自动结束）');
  log('');

  /* 6. 等注入确认
   *
   * 判定标准分两级：
   *   confirmed  = 守护进程报告 __ZH__ 已注入且资源版本一致 → 注入确实建立了（这是「成功」）
   *   translated = 已经翻译了至少一处 → 页面内容也渲染出来了（这是「已看到效果」）
   * 分开的原因：应用启动慢的时候，注入可能在第 20 秒就建立好了，
   * 但页面还是空白，translated 一直是 0。此时报「失败」是错的。
   * 所以：注入建立后再给它 30 秒等页面渲染；到点还没内容也按成功报，并说明情况。
   *
   * 主通道是守护进程写的 out/zh-daemon-state.json —— 让真正做注入的那个进程来汇报，
   * 前台不再自己抢连 CDP（实测前台自连会假失败）。自连只作为兜底。 */
  let dots = 0;
  const deadline = Date.now() + OPT.waitSec * 1000;
  let confirmed = null;
  let confirmAt = 0;
  let translated = null;
  let lastRep = null;
  let staleState = 0;                     /* 状态文件还是上一次的？连续看到就说明守护没起来 */
  while (Date.now() < deadline) {
    await sleep(600);

    /* 主通道：守护进程的状态文件 */
    const st = readState();
    if (st && st.pid === dpid && st.injected !== false && st.phase && st.phase !== 'booting') {
      if (!confirmed) { confirmed = st; confirmAt = Date.now(); }
      confirmed = st;
      if (st.translated > 0) { translated = st; break; }
      if (Date.now() - confirmAt > 30000) break;
      dots++;
      if (dots % 5 === 0) process.stdout.write('.');
      continue;
    }
    if (st && st.pid !== dpid) {
      staleState++;
      if (staleState > 20) {
        bad('守护进程没有起来（状态文件仍属于 PID ' + st.pid + '）。');
        break;
      }
    }

    if (!launched && !(await listGithubProcs()).length) {
      bad('Copilot 进程消失了。');
      break;
    }

    /* 兜底通道：自己连一次 CDP */
    let rep = null;
    try {
      const t = await findTauriTarget(port, matchRe);
      if (t) {
        const cdp = new CDP(t.ws);
        await cdp.connect(4000);
        const res = await cdp.send('Runtime.evaluate', {
          expression: 'JSON.stringify(globalThis.__ZH__ ? globalThis.__ZH__.report() : null)',
          returnByValue: true
        }, 5000);
        const v = res && res.result && res.result.value;
        if (v) rep = JSON.parse(v);
        cdp.close();
      }
    } catch (e) { rep = null; }

    if (rep) lastRep = rep;

    if (rep && rep.enabled && rep.version === assets.version) {
      if (!confirmed) { confirmed = rep; confirmAt = Date.now(); }
      if (rep.stats && rep.stats.translated > 0) { confirmed = rep; translated = rep; break; }
      if (Date.now() - confirmAt > 30000) break;
    }
    dots++;
    if (dots % 3 === 0) process.stdout.write('.');
  }
  if (dots) process.stdout.write('\n');

  if (!confirmed) {
    bad(OPT.waitSec + ' 秒内没能确认汉化注入成功。');
    log('');
    log('  诊断信息：');
    const ghNow = await listGithubProcs();
    log('    · Copilot 进程：' + (ghNow.length ? '在运行（PID ' + ghNow.join(', ') + '）' : '不在运行'));
    const ver = await httpGetJson(port, '/json/version', 900);
    const tNow = await findTauriTarget(port, matchRe);
    if (!ver || !ver.Browser) {
      log('    · CDP 端口 ' + port + '：未监听（WebView2 没有开调试端口，或浏览器进程已退出）');
    } else if (tNow) {
      log('    · CDP 端口 ' + port + '：已监听（' + ver.Browser + '），目标页 ' + tNow.url);
    } else {
      const raw = await httpGetJson(port, '/json/list', 900);
      const urls = Array.isArray(raw) ? raw.map((x) => x.url).join(', ') : '未知';
      log('    · CDP 端口 ' + port + '：已监听（' + ver.Browser + '），但还没有可注入的应用页');
      log('        当前 target：' + (urls || '无') + '（about:blank / 内部页会被跳过）');
    }
    if (lastRep) {
      log('    · 读到过 __ZH__：版本 ' + lastRep.version + '，enabled=' + lastRep.enabled
        + '，已翻译 ' + (lastRep.stats ? lastRep.stats.translated : '?'));
    } else {
      log('    · 没有读到过 __ZH__（脚本没进到页面里）');
    }
    const stNow = readState();
    log('    · 守护进程状态文件：' + (stNow
      ? ('phase=' + stNow.phase + '，injected=' + stNow.injected + '，translated=' + stNow.translated)
      : '不存在（守护进程还没走到注入这一步）'));
    log('    · 守护进程 PID：' + dpid + '（' + ((await isPidAlive(dpid)) ? '存活' : '已退出') + '）');
    log('');
    log('  守护进程日志尾部（out/zh-daemon.log）：');
    try {
      const txt = fs.readFileSync(DAEMON_LOG, 'utf8');
      for (const line of txt.split(/\r?\n/).slice(-14)) log('    ' + line);
    } catch (e) { log('    （读不到日志）'); }
    log('');

    /* 读应用自己的日志 —— 这才是「为什么前端没起来」的答案所在 */
    const diag = diagnoseAppLog();
    log('  GitHub Copilot 自身日志（' + (diag.path || '找不到') + '）：');
    if (diag.verdict === 'frontend-timeout') {
      bad('  应用自己的启动看门狗超时：前端 30 秒内没有变成可交互。');
      log('');
      log('    这【不是】汉化环境变量造成的。对照实验：不加任何环境变量、');
      log('    直接启动官方 github.exe，日志里出现完全相同的报错。');
      log('    日志里的关键行：');
      for (const l of diag.lines.filter((x) => /WebView2 process failure|startup_timed_out|did not become interactive/.test(x)).slice(0, 6)) {
        log('      ' + l.trim());
      }
      log('');
      log('    · 若伴随 exit_code=7 / -2147483645（0x80000003 STATUS_BREAKPOINT）：');
      log('      WebView2 的 GPU / Storage / browser 子进程被拦住了 —— 通常是');
      log('      进程被套在另一个沙箱 / Job Object 里，Chromium 沙箱起不来。');
      log('      请从资源管理器直接双击 start-copilot-zh.cmd 启动，不要从');
      log('      IDE / 沙箱 / 自动化脚本里拉起。');
      log('    · 若只有超时没有崩溃：应用可能在等登录或网络，先手动启动一次');
      log('      官方 github.exe 确认能进主界面，再回来用启动器。');
    } else if (diag.verdict === 'webview-crash') {
      warn('  应用日志里出现 WebView2 子进程崩溃（详见下面日志尾部）。');
      for (const l of diag.lines.slice(-4)) log('      ' + l.trim());
    } else if (diag.verdict === 'ok') {
      info('  应用日志里没有明显的启动错误。');
      for (const l of diag.lines.slice(-4)) log('      ' + l.trim());
    } else {
      info('  读不到应用日志（' + diag.verdict + '）。');
    }
    log('');

    writeStatus({ ok: false, reason: 'inject-timeout', port, daemonPid: dpid, at: new Date().toISOString() });
    return 4;
  }

  /* confirmed 可能来自守护进程的状态文件（字段 translated 是数字），
     也可能来自我们自己读到的 report（字段 stats.translated）。
     统一成 nTranslated / nUnmatched / nErrors 再报告。 */
  const nTranslated = confirmed.stats ? confirmed.stats.translated : (confirmed.translated || 0);
  const src = translated || confirmed;
  const nUnmatched = src.stats ? Object.keys(src.unmatched || {}).length
    : (typeof src.unmatched === 'number' ? src.unmatched : 0);
  const nErrors = src.stats ? (src.errors || []).length : (src.errors || 0);

  if (translated) {
    ok('汉化已生效：本轮已翻译 ' + nTranslated + ' 处，未翻译候选 ' + nUnmatched
      + ' 条，JS 错误 ' + nErrors + ' 条。');
  } else {
    ok('汉化注入已建立（资源版本 ' + confirmed.version + '）。');
    warn('但当前页面还没有可翻译的内容（已翻译 0 处）——应用可能仍在加载或停在空白页。');
    info('汉化会随页面渲染自动生效；如果一直不生效，请看 out/zh-daemon.log。');
  }
  log('');
  log('  以后照常双击 start-copilot-zh.cmd 即可。');
  log('  本窗口可以关掉了 —— 汉化由后台守护进程维持，刷新页面也不会丢。');
  log('  想彻底关闭汉化：双击 zh-off.cmd。');
  log('');

  writeStatus({
    ok: true, lang, port, daemonPid: dpid, launched,
    translated: nTranslated,
    injected: true,
    unmatched: nUnmatched,
    errors: nErrors,
    resourceVersion: confirmed.version,
    at: new Date().toISOString()
  });
  return 0;
}

/* ------------------------------------------------------------ 资源加载 --- */

function loadAssets() {
  const dict = readJsonSafe(path.join(HERE, 'zh-CN.json'), {}) || {};
  const keep = readJsonSafe(path.join(HERE, 'keep.json'), []) || [];
  const selectors = readJsonSafe(path.join(RUNTIME_DIR, 'selectors.json'), null);
  const patterns = readJsonSafe(path.join(RUNTIME_DIR, 'patterns.json'), { guards: [], patterns: [] });
  const runtimeSrc = fs.readFileSync(path.join(RUNTIME_DIR, 'zh-runtime.js'), 'utf8');

  if (!selectors || !selectors.scopes) throw new Error('找不到 runtime/selectors.json');

  const hash = crypto.createHash('sha1')
    .update(runtimeSrc)
    .update(JSON.stringify(dict))
    .update(JSON.stringify(keep))
    .update(JSON.stringify(selectors))
    .update(JSON.stringify(patterns))
    .digest('hex').slice(0, 12);

  return {
    dict, keep, selectors, patterns, runtimeSrc,
    version: 'p2-' + hash,
    counts: {
      dict: Object.keys(dict).length,
      keep: keep.length,
      scopes: (selectors.scopes || []).length,
      skipText: (selectors.skipText || []).length,
      rescope: (selectors.rescope || []).length,
      rescopeAttr: (selectors.rescopeAttr || []).length,
      patterns: (patterns.patterns || []).length,
      guards: (patterns.guards || []).length
    }
  };
}

function buildBundle(assets, lang, debug) {
  const cfg = {
    version: assets.version,
    lang,
    debug,
    dict: assets.dict,
    keep: assets.keep,
    patterns: assets.patterns,
    selectors: assets.selectors,
    maxNodesPerPass: 20000
  };
  return 'globalThis.__ZH_CFG__ = ' + JSON.stringify(cfg) + ';\n' + assets.runtimeSrc + '\n;';
}

/* --------------------------------------------- 连接 + 注入（带整体重试） --- */

/* 把「找 target → 连接 → 注册脚本 → 立即执行 → 回读确认」当成一个可重试的原子步骤。
 *
 * 为什么必须重试：WebView2 启动期 target 会反复出现又销毁
 * （about:blank → tauri.localhost → 路由重建 → 刷新），
 * 只要在「拿到 target」之后、「注入完成」之前页面被销毁，CDP 就会断开。
 * 旧实现遇到这种情况直接抛错 → 守护进程当场死掉，
 * 用户看到的就是「启动器窗口一闪就没了，汉化根本没生效」。
 * 现在：任何一步失败都只丢弃这条连接，700ms 后再来一遍，直到 deadline。
 *
 * o = { port, matchRe, bundle, deadline, onTick(attempt, err|null) }
 * 返回 { cdp, scriptId, target, report, attempts } 或 { error, attempts }
 */
async function attachAndInject(o) {
  let attempt = 0;
  let lastErr = null;

  while (Date.now() < o.deadline) {
    attempt++;

    let target = null;
    try { target = await findTauriTarget(o.port, o.matchRe); } catch (e) { target = null; }
    if (!target) {
      if (o.onTick) o.onTick(attempt, null);
      await sleep(700);
      continue;
    }

    let cdp = null;
    try {
      cdp = new CDP(target.ws);
      await cdp.connect(8000);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      const scriptId = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: o.bundle })).identifier;
      await cdp.send('Runtime.evaluate', { expression: o.bundle, returnByValue: false });

      /* 回读一次，确认脚本真的活在页面里；读不到说明页面又换了 */
      await sleep(250);
      const res = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify(globalThis.__ZH__ ? globalThis.__ZH__.report() : null)',
        returnByValue: true
      }, 8000);
      const v = res && res.result && res.result.value;
      if (!v) throw new Error('注入后读不到 __ZH__（页面刚被重建）');

      return { cdp, scriptId, target, report: JSON.parse(v), attempts: attempt };
    } catch (e) {
      lastErr = e;
      try { if (cdp) cdp.close(); } catch (e2) { /* noop */ }
      if (o.onTick) o.onTick(attempt, e);
      await sleep(700);
    }
  }

  return { error: lastErr || new Error('等待 CDP 目标页面超时'), attempts: attempt };
}

/* --------------------------------------------------------------- 主流程 --- */

async function main() {
  if (OPT.help) { log(HELP); return; }

  /* ---- 子命令分发 ---- */
  if (OPT.stop) {
    log('');
    log('=== 停止后台守护进程 ===');
    const did = await stopDaemon(false);
    removeStateFile();
    writeStatus({ ok: true, stopped: did, at: new Date().toISOString() });
    log('');
    log('  下次启动 Copilot 将不再自动汉化（除非再用 start-copilot-zh.cmd 启动）。');
    log('');
    return;
  }
  if (OPT.start) {
    process.exitCode = await startMode();
    return;
  }

  /* ---- 守护进程模式：无窗口、日志落盘、写 PID 文件 ---- */
  if (OPT.daemon) {
    redirectToLog(DAEMON_LOG);
    OPT.attach = true;                       /* 守护进程只接管，不负责启动程序 */
    const prev = await readPidFile();
    if (prev && prev.pid !== process.pid) {
      console.log('已有守护进程 PID ' + prev.pid + ' 在运行，本进程退出。');
      return;
    }
    writePidFile({ lang: OPT.lang || null });
    writeState({ phase: 'booting', port: OPT.port || null, lang: OPT.lang || null, injected: false });
    const onExit = () => { removePidFile(); removeStateFile(); };
    process.on('exit', onExit);
    process.on('SIGINT', () => { onExit(); process.exit(0); });
    process.on('SIGTERM', () => { onExit(); process.exit(0); });
  }

  log('');
  log('=== GitHub Copilot Desktop 汉化启动器 v' + LAUNCHER_VERSION + ' ===');
  log('');

  const cfg = loadConfig();
  const lang = OPT.lang || cfg.lang || 'zh-CN';
  const debug = OPT.debug || cfg.debug;
  const attach = OPT.attach;

  if (!['zh-CN', 'en-US'].includes(lang)) {
    bad(`不支持的 --lang=${lang}（只能是 zh-CN 或 en-US）`);
    process.exitCode = 2; return;
  }

  let assets;
  try { assets = loadAssets(); }
  catch (e) { bad(e.message); process.exitCode = 2; return; }

  info(`词典 ${assets.counts.dict} 条 | keep ${assets.counts.keep} 条 | 模板 ${assets.counts.patterns} 条 | guard ${assets.counts.guards} 条`);
  info(`白名单 scopes ${assets.counts.scopes} | skipText ${assets.counts.skipText} | rescope ${assets.counts.rescope} | rescopeAttr ${assets.counts.rescopeAttr}`);
  info(`资源版本 ${assets.version}`);
  log('');

  /* ---- 端口 ---- */
  let port = OPT.port || cfg.port || 0;
  if (!port) {
    port = await freePort();
    info(`自动选择空闲 CDP 端口：${port}`);
  } else {
    info(`使用 CDP 端口：${port}`);
  }

  /* ---- 定位 exe ---- */
  let child = null;
  let exePath = null;
  if (!attach) {
    const r = resolveExe(cfg);
    if (!r.exe) {
      bad('找不到 GitHub Copilot 的 github.exe。');
      log('');
      log('  已尝试以下路径：');
      for (const t of r.tried.slice(0, 12)) log('    ' + (t.exists ? '[有] ' : '[无] ') + t.path);
      log('');
      log('  请在 launcher.config.json 里把 exe 填成实际路径，或用 --exe=PATH 指定。');
      log('');
      process.exitCode = 2; return;
    }
    exePath = r.exe;
    ok(`找到程序（${r.how}）`);
    info(exePath);
    log('');

    /* 单实例检查：Copilot 会把新进程转交给已有实例，那样端口不生效 */
    const running = await listGithubProcs();
    if (running.length) {
      warn(`检测到 github.exe 已在运行（PID ${running.join(', ')}）。`);
      warn('Copilot 是单实例应用：新进程会把请求转交已有实例后退出，CDP 端口不会生效。');
      log('');
      log('  请二选一：');
      log('    a) 完全退出 Copilot，再重新运行本启动器；');
      log('    b) 保留当前实例，改用  node zh-launcher.js --attach');
      log('       （前提是该实例当初是用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 启动的）');
      log('');
      process.exitCode = 3; return;
    }
  }

  /* ---- 启动官方程序（只加一个进程级环境变量） ---- */
  if (!attach) {
    const browserArgs = `--remote-debugging-port=${port} --remote-allow-origins=*`
      + (cfg.extraBrowserArgs ? ' ' + cfg.extraBrowserArgs : '');
    const env = Object.assign({}, process.env, {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs
    });
    info('环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=' + browserArgs);
    info('（仅本进程有效，不写入任何文件；Copilot 关闭后自动失效）');

    child = spawn(exePath, [], { env, detached: false, stdio: 'ignore', windowsHide: false });
    child.on('error', (e) => bad('启动失败：' + e.message));
    ok('已启动官方程序，等待 WebView2 CDP 就绪 …');
  } else {
    info('--attach 模式：不启动新进程，直接连接已在运行的 Copilot');
  }
  log('');

  /* ---- 等 CDP 端口起来 ---- */
  const matchRe = compileMatch();
  const deadline = Date.now() + OPT.waitSec * 1000;

  let dots = 0;
  let browser = null;
  const waitT0 = Date.now();
  while (Date.now() < deadline) {
    const ver = await httpGetJson(port, '/json/version', 600);
    if (ver && ver.Browser) { browser = ver.Browser; break; }
    /* 守护进程模式：如果等了 20 秒 Copilot 连进程都没有，别挂在那里当僵尸 */
    if (OPT.daemon && Date.now() - waitT0 > 20000 && !(await listGithubProcs()).length) {
      console.log('Copilot 进程不存在，守护进程退出。');
      return;
    }
    dots++;
    if (dots % 4 === 0) process.stdout.write('.');
    await sleep(500);
  }
  if (dots) process.stdout.write('\n');
  if (!browser) {
    bad(`${OPT.waitSec} 秒内没有连上 CDP（端口 ${port}）。`);
    log('');
    log('  可能原因：');
    log('    · Copilot 仍在启动或登录界面，页面还没建好 → 加大 --wait=');
    log('    · 已经有实例在运行，端口没生效 → 完全退出后重试');
    log('    · 端口被占用或安全软件拦截 → 换 --port=9223 试试');
    log('');
    if (child) { try { child.kill(); } catch (e) {} }
    process.exitCode = 4; return;
  }
  ok(`CDP 就绪：${browser}`);
  info('正在注入汉化脚本（启动期页面会反复重建，失败会自动重试）…');

  /* ---- 连接 + 注入：整体重试，直到 deadline ---- */
  const bundle = buildBundle(assets, lang, debug);
  const inj = await attachAndInject({
    port, matchRe, bundle, deadline,
    onTick: (n, err) => {
      if (err && n % 6 === 0) info(`第 ${n} 次注入未成功（${err.message}），继续重试 …`);
    }
  });

  if (!inj.cdp) {
    bad(`${OPT.waitSec} 秒内没能把汉化注入进去（尝试 ${inj.attempts} 次）。`);
    log('');
    log('  最后一次错误：' + (inj.error && inj.error.message));
    log('');
    if (child) { try { child.kill(); } catch (e) {} }
    process.exitCode = 4; return;
  }

  let cdp = inj.cdp;
  let scriptId = inj.scriptId;
  const found = inj.target;
  let rep = inj.report;

  info(`页面：${found.url}`);
  if (!rep) {
    warn('注入后没读到 __ZH__，可能页面正在重新加载；稍后会自动补注入。');
  } else if (!rep.enabled) {
    ok(`已注入，但汉化处于关闭状态（lang=${rep.lang}）。`);
    info('要打开：在控制台执行 __ZH__.enable()，或用 --lang=zh-CN 重新启动。');
  } else {
    ok(`汉化已生效：lang=${rep.lang}，本轮已翻译 ${rep.stats.translated} 处。`);
  }
  log('');

  /* 告诉前台 --start：注入已经建立了（前台据此退出辅助窗口） */
  writeState({
    phase: 'injected',
    port,
    lang,
    url: found.url,
    version: (rep && rep.version) || assets.version,
    enabled: !!(rep && rep.enabled),
    translated: rep && rep.stats ? rep.stats.translated : 0,
    targetId: found.id
  });

  if (debug && rep) {
    const outPath = path.join(HERE, 'out', 'untranslated.json');
    writeJson(outPath, {
      generatedAt: new Date().toISOString(),
      launcherVersion: LAUNCHER_VERSION,
      lang: rep.lang,
      url: rep.url,
      stats: rep.stats,
      errors: rep.errors,
      unmatched: rep.unmatched
    });
    const n = Object.keys(rep.unmatched || {}).length;
    info(`--debug：未翻译候选 ${n} 条 → ${outPath}`);
    if (rep.errors && rep.errors.length) {
      warn(`注入侧记录了 ${rep.errors.length} 条错误，详见上面文件`);
    }
  }

  log(C.dim + '  正在守护运行。切换页面 / 刷新 / 打开菜单都会保持汉化。' + C.off);
  log(C.dim + '  关闭 Copilot 窗口后本启动器会自动退出；也可按 Ctrl+C。' + C.off);
  log('');

  /* ---- 守护循环 ---- */
  let childExited = false;
  if (child) child.on('exit', () => { childExited = true; });

  let stop = false;
  const onSig = () => { stop = true; };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  let missed = 0;
  let ghMissed = 0;
  let injectedTargets = new Set([found.id]);
  let lastStats = rep ? rep.stats.translated : 0;
  let curUrl = found.url;

  while (!stop) {
    await sleep(2000);

    /* 结束条件只看一件事：github.exe 本身有没有消失。
       为什么不用「CDP 断了几次」来判断退出：WebView2 的浏览器进程在应用启动期
       会被反复重建（实测每 10 秒左右换一个 PID，端口会短暂不可用），
       按 CDP 断连计数退出会让守护进程在应用还没稳定时自己先死掉，
       用户看到的就是「汉化闪一下然后没了」。 */
    const gh = await listGithubProcs();
    if (!gh.length) {
      ghMissed++;
      if (ghMissed === 1) info('github.exe 已消失，先等一会儿看它会不会回来 …');
      if (ghMissed >= 10) { ok('Copilot 已退出，守护进程结束。'); break; }
    } else {
      if (ghMissed) info('github.exe 又出现了，继续守护。');
      ghMissed = 0;
    }

    let alive = false;
    if (!cdp.closed) {
      try {
        const r = await cdp.send('Runtime.evaluate', {
          expression: 'JSON.stringify({zh: typeof globalThis.__ZH__, url: location.href, n: globalThis.__ZH__ ? globalThis.__ZH__.stats.translated : -1})',
          returnByValue: true
        }, 5000);
        const v = r && r.result && r.result.value;
        if (v) {
          const s = JSON.parse(v);
          alive = true;
          if (s.zh === 'undefined') {
            /* 页面被重建（例如整页刷新且脚本没挂上），补一次 */
            await cdp.send('Runtime.evaluate', { expression: bundle, returnByValue: false });
            info('检测到页面重建，已重新注入。');
          } else {
            curUrl = s.url || curUrl;
            if (s.n !== lastStats) {
              lastStats = s.n;
              if (debug) info(`已翻译 ${s.n} 处`);
              /* 让前台/诊断脚本随时能看到「现在翻译了多少」 */
              writeState({ phase: 'running', port, lang, url: curUrl, version: assets.version, enabled: true, translated: s.n });
            }
          }
        }
      } catch (e) { alive = false; }
    }

    if (!alive) {
      missed++;
      /* 尝试重连（页面可能换了 target，或浏览器进程刚被重建） */
      try {
        cdp.close();
        const t = await findTauriTarget(port, matchRe);
        if (t) {
          cdp = new CDP(t.ws);
          await cdp.connect();
          await cdp.send('Page.enable');
          await cdp.send('Runtime.enable');
          if (!injectedTargets.has(t.id)) {
            scriptId = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle })).identifier;
            injectedTargets.add(t.id);
          }
          await cdp.send('Runtime.evaluate', { expression: bundle, returnByValue: false });
          missed = 0;
          curUrl = t.url || curUrl;
          info('CDP 重连成功，已重新注入。');
          writeState({ phase: 'running', port, lang, url: curUrl, version: assets.version, enabled: true, translated: lastStats });
          continue;
        }
      } catch (e) { /* 继续等 */ }

      if (missed === 8) info('CDP 暂时不可用，继续等待应用页面出现 …');
      /* 只在「页面已连续断开很久」时降噪，不退出 */
      if (missed % 60 === 0) info(`CDP 已断开 ${missed * 2} 秒，仍在等待。`);
    } else {
      if (missed) info('CDP 已恢复。');
      missed = 0;
      if (childExited && !child) { /* 不会发生，保留结构 */ }
    }
  }

  try { cdp.close(); } catch (e) { /* noop */ }
  if (child) { try { child.kill(); } catch (e) { /* noop */ } }
  log('');
}

/* ------------------------------------------------------------------ 入口 --- */

if (require.main === module) {
  main().catch((e) => {
    bad('启动器异常：' + (e && e.stack || e));
    process.exitCode = 1;
  });
} else {
  module.exports = {
    LAUNCHER_VERSION, CDP, parseArgs, loadAssets, buildBundle, resolveExe, loadConfig,
    httpGetJson, freePort, waitForCdp, findTauriTarget, compileMatch, attachAndInject,
    listGithubProcs, killGithub, isPidAlive, readPidFile, writePidFile, removePidFile,
    stopDaemon, startMode, spawnDaemon, DEFAULT_PORT, PID_FILE, DAEMON_LOG, STATUS_FILE,
    STATE_FILE, writeState, readState, removeStateFile, diagnoseAppLog, latestAppLog
  };
}
