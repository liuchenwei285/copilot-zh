#!/usr/bin/env node
/* =============================================================================
 * probe.js —— GitHub Copilot Desktop DOM 探测工具（P1）
 * -----------------------------------------------------------------------------
 * 用途：连接到已经开启 CDP 的 Copilot Desktop，只读扫描真实 DOM，
 *       产出 dom-inventory.json 与 untranslated-candidates.json。
 *
 * 硬约束：
 *   - 只读：绝不修改任何 DOM、绝不调用任何会改变页面状态的 CDP 方法。
 *   - 只连 127.0.0.1。
 *   - 不触碰官方安装目录。
 *
 * 本文件为【零依赖单文件】，可直接复制到任何位置运行，只依赖 Node 内置模块。
 *
 * 用法：
 *   node probe.js                      交互模式（推荐）：每切一个页面按一次回车
 *   node probe.js --once               只扫描一次
 *   node probe.js --port=9222          指定 CDP 端口
 *   node probe.js --out=./out          指定输出目录
 *   node probe.js --all                不过滤元素（体积会很大）
 *   node probe.js --list               只列出发现的 CDP 端口和目标，不扫描
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');

const PROBE_VERSION = '1.0.0';
const HERE = __dirname;

/* ------------------------------------------------------------------ CLI --- */

function parseArgs(argv) {
  const o = { port: null, out: null, once: false, all: false, list: false, maxElements: 5000, help: false, match: 'tauri\\.localhost' };
  for (const a of argv.slice(2)) {
    if (a === '--once') o.once = true;
    else if (a === '--all') o.all = true;
    else if (a === '--list') o.list = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--port=')) o.port = Number(a.slice(7)) || null;
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a.startsWith('--match=')) o.match = a.slice(8);
    else if (a.startsWith('--max-elements=')) o.maxElements = Number(a.slice(15)) || 5000;
  }
  return o;
}

const OPT = parseArgs(process.argv);
const OUT_DIR = path.resolve(OPT.out || path.join(HERE, 'out'));

const HELP = `
probe.js ${PROBE_VERSION} —— Copilot Desktop DOM 探测（只读）

  node probe.js                交互模式：每切换一个页面按一次回车，q 退出
  node probe.js --once         只扫描当前页面一次
  node probe.js --port=9222    指定 CDP 端口
  node probe.js --out=DIR      输出目录（默认 ./out）
  node probe.js --all          输出全部元素（默认只输出“值得关注”的元素）
  node probe.js --list         只列出探测到的 CDP 端口与页面目标
  node probe.js --match=REGEX  页面 URL 匹配规则（默认 tauri\\.localhost）
`;

/* ------------------------------------------------------------- 小工具 --- */

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) { /* noop */ }
}

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

/* --------------------------------------------------------- 词典/配置加载 --- */

function loadAssets() {
  const dict = readJsonSafe(path.join(HERE, 'zh-CN.json'), {}) || {};
  const keep = readJsonSafe(path.join(HERE, 'keep.json'), []) || [];
  const selFile = readJsonSafe(path.join(HERE, 'runtime', 'selectors.json'), null);
  const patterns = readJsonSafe(path.join(HERE, 'runtime', 'patterns.json'), []) || [];

  const sel = selFile && selFile.scopes ? selFile : FALLBACK_SELECTORS;

  return {
    dict,
    keep,
    patterns,
    scopes: sel.scopes || [],
    skipText: sel.skipText || [],
    attrScopes: sel.attrScopes || [],
    skipAttr: sel.skipAttr || [],
    attributes: sel.attributes || ['placeholder', 'title', 'aria-label'],
    selectorsSource: selFile ? 'runtime/selectors.json' : '(内置默认)',
    dictSource: fs.existsSync(path.join(HERE, 'zh-CN.json')) ? 'zh-CN.json' : '(空)'
  };
}

/* 当 runtime/selectors.json 不存在时的兜底白名单 */
const FALLBACK_SELECTORS = {
  scopes: [
    'nav', 'aside', 'header', 'footer', 'button', 'label', 'legend', 'summary',
    '[role="navigation"]', '[role="menu"]', '[role="menuitem"]', '[role="dialog"]',
    '[role="tooltip"]', '[role="tab"]', '[role="tablist"]', '[role="button"]',
    '[role="listbox"]', '[role="option"]', '[role="switch"]', '[role="checkbox"]',
    '[role="radio"]', '[role="combobox"]', '[role="status"]', '[role="alert"]',
    '[aria-label]', '[title]', '[data-testid]',
    "[class*='sidebar' i]", "[class*='nav' i]", "[class*='menu' i]",
    "[class*='settings' i]", "[class*='dialog' i]", "[class*='tooltip' i]",
    "[class*='toast' i]", "[class*='empty' i]", "[class*='tab' i]"
  ],
  skipText: [
    'code', 'pre', 'kbd', 'samp', 'var', 'script', 'style', 'noscript',
    'textarea', 'input', 'select', 'svg', 'canvas',
    '[contenteditable]', '[data-lexical-editor]', "[class*='lexical' i]",
    "[class*='monaco' i]", "[class*='xterm' i]", "[class*='terminal' i]",
    "[class*='diff' i]", "[class*='markdown' i]", "[class*='prose' i]",
    "[class*='messageContent' i]", "[class*='chatMessage' i]",
    '[data-message-author-role]', '[data-code]', '[data-language]'
  ],
  attrScopes: ['input', 'textarea', 'select', 'button', 'a', 'img', 'label', '[title]', '[aria-label]', '[data-testid]'],
  skipAttr: ["[class*='monaco' i]", "[class*='xterm' i]", '[data-lexical-editor]'],
  attributes: ['placeholder', 'title', 'aria-label', 'aria-description', 'alt', 'data-tooltip', 'data-placeholder']
};

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
        res.on('data', (c) => { body += c; if (body.length > 8e6) { req.destroy(); } });
        res.on('end', () => {
          try { finish(JSON.parse(body)); } catch (e) { finish(null); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

/* ------------------------------------------------------------ 端口发现 --- */

const WELL_KNOWN = [9222, 9223, 9224, 9225, 9229, 9333, 9444, 9555, 9221, 8315];

function listListeningPorts() {
  return new Promise((resolve) => {
    const ports = new Set();
    let out = '';
    let p;
    try {
      p = spawn('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      warn('[warn] netstat 不可用，仅扫描常见端口：' + e.message);
      return resolve([]);
    }
    const timer = setTimeout(() => { try { p.kill(); } catch (e) { /* noop */ } }, 8000);
    p.stdout.on('data', (d) => {
      out += d;
      if (out.length > 4e6) { try { p.kill(); } catch (e) { /* noop */ } }
    });
    const finish = () => {
      clearTimeout(timer);
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m) ports.add(Number(m[1]));
      }
      resolve([...ports]);
    };
    p.on('close', finish);
    p.on('error', () => { clearTimeout(timer); warn('[warn] netstat 不可用，仅扫描常见端口'); resolve([]); });
  });
}

async function discoverCdp(optPort) {
  const cand = new Set();
  if (optPort) {
    cand.add(optPort);
  } else {
    WELL_KNOWN.forEach((p) => cand.add(p));
    (await listListeningPorts()).forEach((p) => { if (p > 1024 && p < 65536) cand.add(p); });
  }

  let matcher;
  try { matcher = new RegExp(OPT.match, 'i'); } catch (e) { matcher = /tauri\.localhost/i; }

  const found = [];
  const list = [...cand].slice(0, 400);

  await Promise.all(
    list.map(async (port) => {
      const ver = await httpGetJson(port, '/json/version', 500);
      if (!ver || !ver.Browser) return;
      const targets = (await httpGetJson(port, '/json/list', 900)) || [];
      const pages = targets
        .filter((t) => t && t.type === 'page')
        .map((t) => ({
          id: t.id,
          type: t.type,
          title: t.title,
          url: t.url,
          ws: t.webSocketDebuggerUrl || t.ws
        }));
      const hits = pages.filter((t) => matcher.test(t.url || ''));
      found.push({
        port,
        browser: ver.Browser,
        userAgent: ver.UserAgent || '',
        isWebView2: /WebView2|Edg\//i.test(ver.Browser) || /WebView2/i.test(ver.UserAgent || ''),
        pageCount: pages.length,
        tauriTargets: hits,
        pages
      });
    })
  );

  /* 打分：命中匹配规则的页面优先，其次 WebView2 */
  found.sort((a, b) => {
    const sa = (a.tauriTargets.length ? 100 : 0) + (a.isWebView2 ? 10 : 0);
    const sb = (b.tauriTargets.length ? 100 : 0) + (b.isWebView2 ? 10 : 0);
    return sb - sa;
  });
  return found;
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
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (e) {
        clearTimeout(timer);
        return reject(e);
      }
      this.ws = ws;

      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve();
      });
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 调用超时: ' + method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close() {
    try { this.ws && this.ws.close(); } catch (e) { /* noop */ }
  }
}

/* ============================================================================
 * 页面扫描器 —— 这段代码会被序列化后送进页面执行
 * 必须自包含：只允许使用参数 opts，不能引用外部变量。
 * ========================================================================== */
function pageScan(opts) {
  var PROTECT_TAGS = {
    CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1,
    TEXTAREA: 1, INPUT: 1, SELECT: 1, SVG: 1, CANVAS: 1, MATH: 1
  };
  var INTERESTING_TAGS = {
    BUTTON: 1, A: 1, LABEL: 1, SUMMARY: 1, OPTION: 1, LI: 1, DT: 1, DD: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, TH: 1, TD: 1, FIGCAPTION: 1,
    INPUT: 1, TEXTAREA: 1, SELECT: 1, LEGEND: 1, FIELDSET: 1, DIALOG: 1, DETAILS: 1
  };
  var UTILITY = /^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|w-|h-|min-|max-|p-|px-|py-|pt-|pb-|pl-|pr-|m-|mx-|my-|mt-|mb-|ml-|mr-|gap-|space-|text-|font-|leading-|tracking-|bg-|border-|rounded|shadow|opacity-|z-|top-|bottom-|left-|right-|inset-|overflow-|items-|justify-|self-|order-|col-|row-|grid-|flex-|grow|shrink|basis-|translate-|rotate-|scale-|transition|duration-|ease-|animate-|cursor-|select-|pointer-|whitespace-|truncate|break-|list-|divide-|ring-|outline-|fill-|stroke-|sr-only|not-sr-only|antialiased|appearance-|resize|touch-|will-|content-|aspect-|object-|filter|backdrop-|mix-|isolate|sr-|uppercase|lowercase|capitalize|italic|underline|line-through|no-underline|normal-|ordinal|tabular-|proportional-|diagonal-|stacked-|subpixel-|texture-)/i;
  var HASHY = /^[a-zA-Z]+[-_]?[a-zA-Z0-9]{5,}$/;

  var NOISE = [
    /^https?:\/\//i, /^www\./i, /^[\w.+-]+@[\w-]+\.[\w.-]+$/,
    /^[A-Za-z]:[\\/]/, /^(?:\.{0,2}[\\/])/, /^[0-9a-f]{7,40}$/i,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    /^[\s\W]+$/, /^v?\d+(\.\d+)+/,     /^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,6}$/,
    /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/, /^\d/,
    /^[\w.-]+\/[\w.-]+$/,         /* owner/repo、a/b 这类标识，不是 UI 文案 */
    /* 被 <span> 切碎的句子残片（小写词 / 小写词 + 尾标点），单独翻译必然成病句 */
    /^[a-z][a-z'’-]{1,14}[.,;:!?]$/, /^[a-z]{2,14}$/,
    /@$/, /^[a-z][a-z0-9_]{2,20}$/   /* 用户名前缀 / 小写账号名 */
  ];

  var doc = document;
  var SEL = opts.scopes && opts.scopes.length ? opts.scopes.join(',') : null;
  var SKIP = opts.skipText && opts.skipText.length ? opts.skipText.join(',') : null;
  var ATTRS = opts.attributes || ['placeholder', 'title', 'aria-label'];
  var DICT = opts.dict || {};
  var KEEP = {};
  (opts.keep || []).forEach(function (k) { KEEP[k] = 1; });
  var MAX_ELEMENTS = opts.maxElements || 5000;
  var INCLUDE_ALL = !!opts.includeAll;

  var hasOwn = Object.prototype.hasOwnProperty;

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  function matchSel(el, sel) {
    if (!sel || !el || el.nodeType !== 1 || !el.matches) return false;
    try { return el.matches(sel); } catch (e) { return false; }
  }
  function closestSel(el, sel) {
    if (!sel || !el || el.nodeType !== 1 || !el.closest) return null;
    try { return el.closest(sel); } catch (e) { return null; }
  }

  function protectReason(el) {
    var n = el, d = 0;
    while (n && n.nodeType === 1 && d < 40) {
      if (PROTECT_TAGS[n.nodeName]) return n.nodeName.toLowerCase();
      if (n.hasAttribute && (n.hasAttribute('contenteditable') || n.hasAttribute('data-lexical-editor'))) return 'contenteditable';
      if (SKIP && matchSel(n, SKIP)) {
        for (var i = 0; i < opts.skipText.length; i++) {
          if (matchSel(n, opts.skipText[i])) return opts.skipText[i];
        }
        return 'skip';
      }
      n = n.parentElement; d++;
    }
    return null;
  }

  function isVisible(el) {
    try {
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      if (parseFloat(cs.opacity) === 0) return false;
      return true;
    } catch (e) { return false; }
  }

  function directText(el) {
    var s = '';
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) s += c.nodeValue;
    }
    return norm(s);
  }

  function firstSemanticClass(el) {
    var cl = (el.getAttribute && el.getAttribute('class')) || '';
    if (!cl) return '';
    var parts = cl.split(/\s+/).filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.length < 3 || p.length > 48) continue;
      if (UTILITY.test(p)) continue;
      if (/^[a-z]+[0-9]{4,}$/i.test(p)) continue;
      return p;
    }
    return '';
  }

  function nthOfType(el) {
    var i = 1, s = el.previousElementSibling;
    while (s) { if (s.nodeName === el.nodeName) i++; s = s.previousElementSibling; }
    return i;
  }

  function shortSeg(el) {
    var t = el.tagName.toLowerCase();
    if (el.id) return t + '#' + el.id;
    var tid = el.getAttribute && el.getAttribute('data-testid');
    if (tid) return t + '[data-testid="' + tid + '"]';
    var role = el.getAttribute && el.getAttribute('role');
    if (role) return t + '[role="' + role + '"]';
    var al = el.getAttribute && el.getAttribute('aria-label');
    if (al && al.length < 40) return t + '[aria-label="' + al + '"]';
    var c = firstSemanticClass(el);
    return c ? t + '.' + c : t;
  }

  function stablePath(el) {
    var parts = [], n = el, d = 0;
    while (n && n.nodeType === 1 && n !== doc.body && d < 6) {
      var s = shortSeg(n);
      if (!el.id && !n.id && !(n.getAttribute && (n.getAttribute('data-testid') || n.getAttribute('role')))) {
        var idx = nthOfType(n);
        if (idx > 1) s += ':nth-of-type(' + idx + ')';
      }
      parts.unshift(s);
      n = n.parentElement; d++;
    }
    return parts.join(' > ');
  }

  function chainOf(el) {
    var out = [], n = el.parentElement, d = 0;
    while (n && n !== doc.body && n.nodeType === 1 && d < 6) {
      out.unshift(shortSeg(n));
      n = n.parentElement; d++;
    }
    return out;
  }

  function regionOf(el) {
    if (closestSel(el, '[role="dialog"],[role="alertdialog"],dialog')) return 'dialog';
    if (closestSel(el, '[role="tooltip"]')) return 'tooltip';
    if (closestSel(el, '[role="menu"],[role="menubar"],[role="listbox"]')) return 'menu';
    if (closestSel(el, '[class*="toast" i],[class*="notification" i],[role="status"],[role="alert"]')) return 'toast';
    if (closestSel(el, 'nav,aside,[role="navigation"]')) return 'sidebar';
    if (closestSel(el, '[class*="settings" i],[class*="preferences" i]')) return 'settings';
    if (closestSel(el, 'header,[class*="titlebar" i],[class*="title-bar" i]')) return 'header';
    if (closestSel(el, 'footer')) return 'footer';
    if (closestSel(el, '[class*="toolbar" i]')) return 'toolbar';
    return 'content';
  }

  function isEnglishLike(s) {
    if (s.length < 2 || s.length > 80) return false;
    if (!/[A-Za-z]{2}/.test(s)) return false;
    if (s.indexOf('\n') !== -1) return false;
    if (s.split(/\s+/).length > 10) return false;
    for (var i = 0; i < NOISE.length; i++) if (NOISE[i].test(s)) return false;
    return true;
  }

  /* ---- 遍历 ---- */
  var res = {
    url: location.href,
    route: location.pathname + location.search + location.hash,
    title: doc.title,
    capturedAt: new Date().toISOString(),
    readyState: doc.readyState,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    counts: {
      elements: 0, visible: 0, protectedElements: 0,
      uiCandidates: 0, dictHits: 0, unmatched: 0, truncated: false
    },
    elements: [],
    protectedZones: [],
    classTokens: {},
    testIds: {},
    roles: {},
    unmatched: {},
    scopeGaps: {}
  };

  var seenProtected = {};

  function visit(el) {
    res.counts.elements++;
    var tag = el.nodeName;

    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;

    var reason = protectReason(el);
    var vis = isVisible(el);
    if (vis) res.counts.visible++;

    var txt = directText(el);
    var cl = (el.getAttribute && el.getAttribute('class')) || '';
    var role = (el.getAttribute && el.getAttribute('role')) || '';
    var tid = (el.getAttribute && el.getAttribute('data-testid')) || '';

    /* 统计类名 / testid / role —— 用于推导稳定选择器 */
    if (cl) {
      cl.split(/\s+/).filter(Boolean).forEach(function (c) {
        if (c.length > 60) return;
        res.classTokens[c] = (res.classTokens[c] || 0) + 1;
      });
    }
    if (tid) res.testIds[tid] = (res.testIds[tid] || 0) + 1;
    if (role) res.roles[role] = (res.roles[role] || 0) + 1;

    if (reason) {
      res.counts.protectedElements++;
      var k = tag.toLowerCase() + '|' + reason;
      if (!seenProtected[k]) {
        seenProtected[k] = { tag: tag.toLowerCase(), reason: reason, count: 0, samplePath: stablePath(el), sampleText: norm(el.textContent).slice(0, 80), visible: vis };
        res.protectedZones.push(seenProtected[k]);
      }
      seenProtected[k].count++;
      if (INCLUDE_ALL) {
        res.elements.push({
          path: stablePath(el), chain: chainOf(el), tag: tag.toLowerCase(),
          role: role, text: txt.slice(0, 200), visible: vis, protected: reason,
          region: regionOf(el), uiCandidate: false
        });
      }

      /* 属性仍然采集：placeholder / title / aria-label 不属于“正文”，
         即使元素本身在受保护区（如 input），其占位符也是要翻译的 UI 文案。 */
      var pattrs = {};
      for (var pi = 0; pi < ATTRS.length; pi++) {
        var pa = ATTRS[pi];
        if (el.getAttribute && el.hasAttribute && el.hasAttribute(pa)) {
          var pv = el.getAttribute(pa);
          if (pv) pattrs[pa] = pv;
        }
      }
      if (Object.keys(pattrs).length && (vis || INCLUDE_ALL)) {
        res.elements.push({
          path: stablePath(el), chain: chainOf(el), tag: tag.toLowerCase(),
          id: el.id || undefined, role: role || undefined, testid: tid || undefined,
          attrs: pattrs, region: regionOf(el), visible: vis,
          inScope: true, uiCandidate: true, protected: reason
        });
        Object.keys(pattrs).forEach(function (a) {
          var v = norm(pattrs[a]);
          if (!isEnglishLike(v) || KEEP[v]) return;
          if (hasOwn.call(DICT, v)) return;
          addUnmatched(res, v, a, regionOf(el), stablePath(el), pattrs);
        });
      }
    } else {
      var inScope = SEL ? !!closestSel(el, SEL) : false;

      var attrs = {};
      for (var i = 0; i < ATTRS.length; i++) {
        var a = ATTRS[i];
        if (el.getAttribute && el.hasAttribute && el.hasAttribute(a)) {
          var v = el.getAttribute(a);
          if (v) attrs[a] = v;
        }
      }

      var interesting = txt.length > 0 || el.id || role || tid ||
        Object.keys(attrs).length > 0 || INTERESTING_TAGS[tag];

      if (interesting && (vis || INCLUDE_ALL)) {
        var dictHit = null;
        if (txt && !KEEP[txt] && hasOwn.call(DICT, txt)) dictHit = DICT[txt];

        var uiCandidate = inScope || INTERESTING_TAGS[tag] || Object.keys(attrs).length > 0;

        if (res.elements.length < MAX_ELEMENTS) {
          res.elements.push({
            path: stablePath(el),
            chain: chainOf(el),
            tag: tag.toLowerCase(),
            id: el.id || undefined,
            class: cl || undefined,
            role: role || undefined,
            testid: tid || undefined,
            attrs: Object.keys(attrs).length ? attrs : undefined,
            region: regionOf(el),
            text: txt.slice(0, 200) || undefined,
            textLen: el.textContent ? norm(el.textContent).length : 0,
            visible: vis,
            inScope: inScope,
            uiCandidate: uiCandidate,
            dictHit: dictHit || undefined
          });
        } else {
          res.counts.truncated = true;
        }

        if (uiCandidate) {
          res.counts.uiCandidates++;
          if (dictHit) res.counts.dictHits++;

          /* 文本候选 */
          if (txt && isEnglishLike(txt) && !KEEP[txt]) {
            if (dictHit) { /* 已翻译，跳过 */ }
            else addUnmatched(res, txt, 'text', regionOf(el), stablePath(el), attrs);
          }
          /* 属性候选 */
          Object.keys(attrs).forEach(function (a) {
            var v = norm(attrs[a]);
            if (!isEnglishLike(v) || KEEP[v]) return;
            if (hasOwn.call(DICT, v)) return;
            addUnmatched(res, v, a, regionOf(el), stablePath(el), attrs);
          });
        }
      }

      /* 白名单缺口：像 UI 但不在白名单里的英文文本 */
      if (!inScope && txt && isEnglishLike(txt) && !KEEP[txt] && (role || INTERESTING_TAGS[tag])) {
        var gk = txt;
        if (!res.scopeGaps[gk]) {
          res.scopeGaps[gk] = { count: 0, tag: tag.toLowerCase(), role: role || '', path: stablePath(el), region: regionOf(el) };
        }
        res.scopeGaps[gk].count++;
      }
    }

    /* 递归（含 open shadow root） */
    if (el.shadowRoot) {
      var sc = el.shadowRoot.children;
      for (var s = 0; s < sc.length; s++) visit(sc[s]);
    }
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) visit(c);
  }

  function addUnmatched(res, key, source, region, p, attrs) {
    var e = res.unmatched[key];
    if (!e) {
      e = res.unmatched[key] = { count: 0, sources: {}, regions: {}, samplePath: p, sampleTag: '', dict: '' };
    }
    e.count++;
    e.sources[source] = (e.sources[source] || 0) + 1;
    e.regions[region] = (e.regions[region] || 0) + 1;
    res.counts.unmatched = Object.keys(res.unmatched).length;
  }

  try {
    visit(doc.documentElement);
  } catch (e) {
    res.scanError = String((e && e.stack) || e);
  }

  res.tookMs = Date.now() - (opts.__t0 || Date.now());
  return res;
}

/* --------------------------------------------------------------- 合并输出 --- */

function emptyInventory(assets) {
  return {
    meta: {
      probeVersion: PROBE_VERSION,
      generatedAt: new Date().toISOString(),
      cdpPort: null,
      browser: null,
      app: { url: null, title: null },
      dictFile: assets.dictSource,
      dictEntries: Object.keys(assets.dict).length,
      selectorsFile: assets.selectorsSource,
      captureCount: 0
    },
    captures: [],
    merged: {
      classTokens: {},
      testIds: {},
      roles: {},
      regions: {},
      byRegion: {}
    },
    protectedZones: [],
    scopeGaps: {}
  };
}

function mergeInto(inv, cap) {
  inv.meta.captureCount++;
  inv.captures.push({
    index: inv.meta.captureCount,
    capturedAt: cap.capturedAt,
    url: cap.url,
    route: cap.route,
    title: cap.title,
    counts: cap.counts,
    elements: cap.elements,
    unmatched: cap.unmatched,
    protectedZones: cap.protectedZones
  });

  const m = inv.merged;
  for (const [k, v] of Object.entries(cap.classTokens || {})) m.classTokens[k] = (m.classTokens[k] || 0) + v;
  for (const [k, v] of Object.entries(cap.testIds || {})) m.testIds[k] = (m.testIds[k] || 0) + v;
  for (const [k, v] of Object.entries(cap.roles || {})) m.roles[k] = (m.roles[k] || 0) + v;

  for (const el of cap.elements || []) {
    const r = el.region || 'content';
    m.regions[r] = (m.regions[r] || 0) + 1;
    if (!m.byRegion[r]) m.byRegion[r] = [];
    if (m.byRegion[r].length < 200) {
      m.byRegion[r].push({ path: el.path, tag: el.tag, text: el.text, attrs: el.attrs, role: el.role, route: cap.route });
    }
  }

  for (const pz of cap.protectedZones || []) {
    const hit = inv.protectedZones.find((x) => x.tag === pz.tag && x.reason === pz.reason);
    if (hit) hit.count += pz.count;
    else inv.protectedZones.push({ ...pz });
  }

  for (const [k, v] of Object.entries(cap.scopeGaps || {})) {
    if (!inv.scopeGaps[k]) inv.scopeGaps[k] = { count: 0, tag: v.tag, role: v.role, path: v.path, region: v.region };
    inv.scopeGaps[k].count += v.count;
  }
}

function buildCandidates(inv, assets) {
  const acc = {};
  for (const cap of inv.captures) {
    for (const [k, v] of Object.entries(cap.unmatched || {})) {
      if (!acc[k]) acc[k] = { count: 0, sources: {}, regions: {}, samplePath: v.samplePath, zh: '' };
      acc[k].count += v.count;
      for (const [s, n] of Object.entries(v.sources || {})) acc[k].sources[s] = (acc[k].sources[s] || 0) + n;
      for (const [r, n] of Object.entries(v.regions || {})) acc[k].regions[r] = (acc[k].regions[r] || 0) + n;
    }
  }

  const sorted = {};
  Object.keys(acc)
    .sort((a, b) => acc[b].count - acc[a].count || a.localeCompare(b))
    .forEach((k) => { sorted[k] = acc[k]; });

  return {
    meta: {
      probeVersion: PROBE_VERSION,
      generatedAt: new Date().toISOString(),
      note: '把 zh 填上后，把整个 candidates 对象合并进 zh-CN.json 即可。',
      dictFile: assets.dictSource,
      dictEntries: Object.keys(assets.dict).length,
      totalCandidates: Object.keys(sorted).length
    },
    candidates: sorted
  };
}

/* ------------------------------------------------------- 建议选择器推导 --- */

function suggestSelectors(inv) {
  const utility = /^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|w-|h-|min-|max-|p-|px-|py-|pt-|pb-|pl-|pr-|m-|mx-|my-|mt-|mb-|ml-|mr-|gap-|space-|text-|font-|leading-|tracking-|bg-|border-|rounded|shadow|opacity-|z-|top-|bottom-|left-|right-|inset-|overflow-|items-|justify-|self-|order-|col-|row-|grow|shrink|basis-|translate-|rotate-|scale-|transition|duration-|ease-|animate-|cursor-|select-|pointer-|whitespace-|truncate|break-|list-|divide-|ring-|outline-|fill-|stroke-|sr-only|antialiased|appearance-|resize|touch-|content-|aspect-|object-)/i;

  const tokens = Object.entries(inv.merged.classTokens || {})
    .filter(([k, v]) => v >= 3 && k.length >= 4 && k.length <= 48 && !utility.test(k) && !/^[a-z]+[0-9]{4,}$/i.test(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([k, v]) => ({ token: k, count: v }));

  const testIds = Object.entries(inv.merged.testIds || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 80)
    .map(([k, v]) => ({ testid: k, count: v }));

  return {
    suggestedScopeTokens: tokens,
    suggestedTestIds: testIds,
    roles: Object.entries(inv.merged.roles || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ role: k, count: v }))
  };
}

/* ------------------------------------------------------------------ 主流程 --- */

async function connectToApp(assets) {
  const found = await discoverCdp(OPT.port);

  if (OPT.list) {
    if (!found.length) log('未发现任何可用的 CDP 端点。');
    for (const f of found) {
      log(`\n端口 ${f.port}  Browser=${f.browser}`);
      log(`  WebView2=${f.isWebView2}  页面数=${f.pageCount}  tauri 目标=${f.tauriTargets.length}`);
      for (const p of f.pages) log(`    - [${p.type || 'page'}] ${p.url}`);
    }
    return { listOnly: true };
  }

  if (!found.length) return { error: 'no-cdp' };

  const pick = found[0];
  const target = pick.tauriTargets[0] || pick.pages[0];
  if (!target || !target.ws) return { error: 'no-target', ports: found };

  const cdp = new CDP(target.ws);
  await cdp.connect();

  return { cdp, port: pick.port, browser: pick.browser, target, all: found };
}

function printNoCdpHelp() {
  log('');
  log('============================================================');
  log(' 未发现已开启 CDP 的 GitHub Copilot Desktop');
  log('============================================================');
  log('');
  log(' 请先【完全退出】Copilot，然后用下面任一方式启动它：');
  log('');
  log(' 方式 A（推荐）：双击本目录下的  probe-start.cmd');
  log('');
  log(' 方式 B：在 PowerShell 里执行');
  log('');
  log('   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222 --remote-allow-origins=*"');
  log('   & "$env:LOCALAPPDATA\\Programs\\GitHub Copilot\\github.exe"');
  log('');
  log(' 方式 C：在 CMD 里执行');
  log('');
  log('   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 --remote-allow-origins=*');
  log('   start "" "%LOCALAPPDATA%\\Programs\\GitHub Copilot\\github.exe"');
  log('');
  log(' 说明：该环境变量由 WebView2 运行时读取，不会写入官方安装目录，');
  log('       不修改任何文件，关闭窗口后即失效。');
  log('');
}

async function captureOnce(conn, assets) {
  /* 等待页面就绪 */
  for (let i = 0; i < 40; i++) {
    const r = await conn.cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ready:document.readyState, hasBody:!!document.body, nodes:document.body?document.body.getElementsByTagName("*").length:0, url:location.href})',
      returnByValue: true
    }).catch(() => null);
    if (r && r.result && r.result.value) {
      try {
        const s = JSON.parse(r.result.value);
        if (s.ready !== 'loading' && s.hasBody && s.nodes > 20) break;
      } catch (e) { /* noop */ }
    }
    await new Promise((r2) => setTimeout(r2, 500));
  }

  const expression = '(' + pageScan.toString() + ')(' + JSON.stringify({
    scopes: assets.scopes,
    skipText: assets.skipText,
    attributes: assets.attributes,
    dict: assets.dict,
    keep: assets.keep,
    maxElements: OPT.maxElements,
    includeAll: OPT.all,
    __t0: Date.now()
  }) + ')';

  const res = await conn.cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
    timeout: 120000
  }, 120000);

  if (res.exceptionDetails) {
    throw new Error('页面扫描异常: ' + JSON.stringify(res.exceptionDetails.exception || res.exceptionDetails.text));
  }
  return res.result.value;
}

async function main() {
  if (OPT.help) { log(HELP); return; }

  log('');
  log('=== GitHub Copilot Desktop DOM 探测 probe.js v' + PROBE_VERSION + ' ===');
  log('只读扫描，不会修改页面、不会修改官方安装目录。');
  log('');

  const assets = loadAssets();
  log(`词典：${assets.dictSource}（${Object.keys(assets.dict).length} 条）`);
  log(`白名单：${assets.selectorsSource}（${assets.scopes.length} 个 scope）`);
  log('');

  log('正在查找已开启 CDP 的 Copilot Desktop ...');
  let conn;
  try {
    conn = await connectToApp(assets);
  } catch (e) {
    warn('连接失败：' + e.message);
    conn = { error: 'connect', message: e.message };
  }

  if (conn && conn.listOnly) return;

  if (!conn || conn.error) {
    printNoCdpHelp();
    process.exitCode = 2;
    return;
  }

  log(`已连接：端口 ${conn.port}  ${conn.browser}`);
  log(`目标页面：${conn.target.url}`);

  const other = conn.all.filter((f) => f.port !== conn.port);
  if (other.length) log(`（另外还发现 ${other.length} 个 CDP 端点，未使用）`);
  log('');

  const inv = emptyInventory(assets);
  inv.meta.cdpPort = conn.port;
  inv.meta.browser = conn.browser;
  inv.meta.app.url = conn.target.url;

  const invPath = path.join(OUT_DIR, 'dom-inventory.json');
  const candPath = path.join(OUT_DIR, 'untranslated-candidates.json');

  let count = 0;
  async function doCapture(label) {
    process.stdout.write(`[${++count}] 扫描中${label ? '（' + label + '）' : ''} ... `);
    const cap = await captureOnce(conn, assets);
    mergeInto(inv, cap);
    inv.merged.suggested = suggestSelectors(inv);
    writeJson(invPath, inv);
    const cand = buildCandidates(inv, assets);
    writeJson(candPath, cand);
    log(`完成：元素 ${cap.counts.elements} / 可见 ${cap.counts.visible} / 保护 ${cap.counts.protectedElements} / UI候选 ${cap.counts.uiCandidates} / 已翻译命中 ${cap.counts.dictHits} / 待翻译 ${Object.keys(cap.unmatched).length}`);
    log(`    route = ${cap.route}`);
    return cap;
  }

  await doCapture('首次');

  if (OPT.once) {
    log('');
    log('已写出：');
    log('  ' + invPath);
    log('  ' + candPath);
    conn.cdp.close();
    return;
  }

  log('');
  log('------------------------------------------------------------');
  log(' 交互模式：在 Copilot 里切换到下一个页面/打开一个菜单/对话框，');
  log('           然后回到这里按【回车】再扫一次，结果会合并累积。');
  log('           输入 q 回车 结束并写出文件。');
  log('------------------------------------------------------------');
  log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let quit = false;

  await new Promise((resolve) => {
    rl.on('line', async (line) => {
      const cmd = line.trim().toLowerCase();
      if (cmd === 'q' || cmd === 'quit' || cmd === 'exit') {
        quit = true;
        rl.close();
        resolve();
        return;
      }
      rl.pause();
      try {
        await doCapture(cmd || undefined);
      } catch (e) {
        warn('扫描失败：' + e.message);
      }
      if (!quit) {
        log('');
        rl.resume();
        rl.prompt();
      }
    });
    rl.on('close', () => { if (!quit) resolve(); });
    rl.setPrompt('按回车再扫一次（q 退出）> ');
    rl.prompt();
  });

  /* 收尾：附加建议选择器 */
  writeJson(invPath, inv);
  writeJson(candPath, buildCandidates(inv, assets));

  conn.cdp.close();

  log('');
  log('============================================================');
  log(' 完成，共 ' + inv.meta.captureCount + ' 次扫描');
  log('============================================================');
  log('  ' + invPath);
  log('  ' + candPath);
  log('');
  log(' 把这两个 json 发给我，我会据此：');
  log('   1. 校正 runtime/selectors.json 的白名单与排除区');
  log('   2. 用 untranslated-candidates.json 扩充 zh-CN.json');
  log(' 注意：本脚本不会自动进入 P2。');
  log('');
}

if (require.main === module) {
  main().catch((e) => {
    warn('probe.js 运行失败：' + (e && e.stack || e));
    process.exitCode = 1;
  });
} else {
  /* 被当作模块 require 时，导出内部件供自测工具复用 */
  module.exports = {
    PROBE_VERSION,
    CDP,
    discoverCdp,
    pageScan,
    loadAssets,
    httpGetJson,
    emptyInventory,
    mergeInto,
    buildCandidates,
    suggestSelectors,
    parseArgs,
    OPT
  };
}
