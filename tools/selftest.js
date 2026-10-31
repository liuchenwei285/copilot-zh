#!/usr/bin/env node
/* =============================================================================
 * selftest.js —— 端到端自测
 * -----------------------------------------------------------------------------
 * 用本机 Edge 的 headless 模式加载 tools/fixture.html（仿 Copilot 界面结构），
 * 然后：
 *   1. 跑一遍 probe.js 的只读扫描，校验 dom-inventory / candidates 输出；
 *   2. 注入 runtime/zh-runtime.js，校验：
 *      - 白名单内的 UI 文本被正确翻译
 *      - 受保护区（代码 / 输入框 / Markdown / 终端 / diff / 仓库名 / PR 标题）一字未改
 *      - MutationObserver 能处理动态插入
 *      - React 式重渲染后会自动重新翻译
 *      - 不会因为自身写入导致 Mutation 无限增长
 *
 * 只在本机 127.0.0.1 上跑，不接触 Copilot 安装目录。
 * 用法： node tools/selftest.js
 * ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { CDP, pageScan, loadAssets, httpGetJson } = require(path.join(ROOT, 'probe.js'));

/* --------------------------------------------------------------- 工具 --- */

let PASS = 0, FAIL = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { PASS++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { FAIL++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  → ' + detail : '')); }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

function info2(msg) {
  console.log('  \x1b[2m     ' + msg + '\x1b[0m');
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 以子进程方式运行 node 脚本并收集输出（execFileSync 在本机会 EBUSY） */
function runNode(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { p.kill(); } catch (e) { /* noop */ } }, timeoutMs);
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e) }); });
  });
}

function findEdge() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

/* ------------------------------------------------------------- HTTP 服务 --- */

function startFixtureServer(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = decodeURIComponent((req.url || '/').split('?')[0]);
      const p = path.join(dir, u === '/' ? 'fixture.html' : u.replace(/^\//, ''));
      if (!p.startsWith(dir) || !fs.existsSync(p)) { res.writeHead(404); res.end('nope'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(p));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ---------------------------------------------------------------- 主流程 --- */

async function main() {
  console.log('\n=== Copilot-zh 端到端自测 ===\n');

  const edge = findEdge();
  if (!edge) { console.log('未找到 Edge，跳过。'); process.exitCode = 1; return; }
  console.log('浏览器: ' + edge);

  const assets = loadAssets();
  console.log(`词典: ${Object.keys(assets.dict).length} 条, scope: ${assets.scopes.length} 个, skipText: ${assets.skipText.length} 个\n`);

  /* ---- 1. 起 fixture 服务 ---- */
  const { server, port: webPort } = await startFixtureServer(path.join(ROOT, 'tools'));
  const fixtureUrl = `http://127.0.0.1:${webPort}/fixture.html`;

  /* ---- 2. 起 headless Edge ---- */
  const debugPort = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-selftest-'));
  const edgeProc = spawn(edge, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--user-data-dir=' + userDataDir,
    '--remote-debugging-port=' + debugPort,
    '--remote-allow-origins=*',
    fixtureUrl
  ], { stdio: 'ignore', windowsHide: true });

  const cleanup = () => {
    try { edgeProc.kill(); } catch (e) { /* noop */ }
    try { server.close(); } catch (e) { /* noop */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* noop */ }
  };

  try {
    /* 等 CDP 起来 */
    let ver = null;
    for (let i = 0; i < 60; i++) {
      ver = await httpGetJson(debugPort, '/json/version', 400);
      if (ver && ver.Browser) break;
      await sleep(250);
    }
    if (!ver) throw new Error('headless Edge 的 CDP 未就绪');
    console.log('CDP 就绪: ' + ver.Browser + '  端口 ' + debugPort + '\n');

    let list = [];
    for (let i = 0; i < 40; i++) {
      list = (await httpGetJson(debugPort, '/json/list', 700)) || [];
      if (list.some((t) => t.type === 'page' && /fixture\.html/.test(t.url || ''))) break;
      await sleep(250);
    }
    const target = list.find((t) => t.type === 'page' && /fixture\.html/.test(t.url || ''));
    if (!target) throw new Error('未找到 fixture 页面目标');

    const cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面执行异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
      return r.result.value;
    };

    /* =============================== A. probe 只读扫描 =============================== */
    console.log('[A] probe.js 只读扫描');
    const scanOut = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-probe-'));
    const probeOut = await runNode([
      path.join(ROOT, 'probe.js'),
      '--once',
      '--port=' + debugPort,
      '--match=127\\.0\\.0\\.1',
      '--out=' + scanOut
    ]);
    if (probeOut.code !== 0) console.log('  probe 输出:\n' + probeOut.stdout + probeOut.stderr);
    ok('probe.js 正常退出', probeOut.code === 0, 'exit=' + probeOut.code);

    const invPath = path.join(scanOut, 'dom-inventory.json');
    const candPath = path.join(scanOut, 'untranslated-candidates.json');
    ok('生成 dom-inventory.json', fs.existsSync(invPath));
    ok('生成 untranslated-candidates.json', fs.existsSync(candPath));

    const inv = JSON.parse(fs.readFileSync(invPath, 'utf8'));
    const cand = JSON.parse(fs.readFileSync(candPath, 'utf8'));

    ok('capture 数 >= 1', inv.meta.captureCount >= 1, 'got ' + inv.meta.captureCount);
    ok('采到元素', inv.captures[0].counts.elements > 30, 'elements=' + inv.captures[0].counts.elements);
    ok('识别出受保护区', (inv.protectedZones || []).length > 0, JSON.stringify((inv.protectedZones || []).map((z) => z.reason)));
    ok('类名统计非空', Object.keys(inv.merged.classTokens).length > 0);
    ok('推导出建议选择器', !!(inv.merged.suggested && inv.merged.suggested.suggestedScopeTokens.length >= 0));

    const reasons = (inv.protectedZones || []).map((z) => z.reason).join(' | ');
    ok('受保护区覆盖 code/pre', /code|pre/.test(reasons), reasons);
    ok('受保护区覆盖 contenteditable', /contenteditable/.test(reasons), reasons);
    ok('受保护区覆盖 markdown', /markdown/i.test(reasons), reasons);
    ok('受保护区覆盖 xterm', /xterm/i.test(reasons), reasons);
    ok('受保护区覆盖 diff', /diff/i.test(reasons), reasons);

    const els = inv.captures[0].elements || [];
    const navNew = els.find((e) => e.testid === 'nav-new');
    ok('采到 nav-new 元素', !!navNew, navNew ? JSON.stringify(navNew.path) : 'not found');
    if (navNew) {
      ok('nav-new 落在白名单内', navNew.inScope === true);
      eq('nav-new 命中词典', navNew.dictHit, '新建');
    }
    const composer = els.find((e) => e.attrs && e.attrs.placeholder);
    ok('采到 placeholder 属性', !!composer, composer ? JSON.stringify(composer.attrs) : 'not found');

    const keys = Object.keys(cand.candidates || {});
    ok('产出待翻译候选', keys.length > 0, keys.length + ' 条');
    ok('候选含 "Manage repositories"', keys.includes('Manage repositories'), keys.slice(0, 12).join(', '));
    ok('候选含 "Show archived chats"', keys.includes('Show archived chats'));
    ok('候选含 placeholder "Filter by repository"', keys.includes('Filter by repository'));
    ok('候选含 title "Reopen the last closed chat"', keys.includes('Reopen the last closed chat'));
    ok('候选未误收已翻译文案', !keys.includes('Storage location') && !keys.includes('No chats yet'));
    ok('候选未误收受保护区文本', !keys.some((k) => /const options|console\.log|npm run build|Step one|Here is the fix|theme = "Dark"/.test(k)), keys.filter((k) => /const options|console\.log|npm run build|Step one|Here is the fix/.test(k)).join(' | '));
    ok('候选未误收仓库名', !keys.includes('octocat/Hello-World'));

    fs.rmSync(scanOut, { recursive: true, force: true });

    /* =============================== B. 运行时注入 =============================== */
    console.log('\n[B] 注入 runtime/zh-runtime.js');

    const runtimeSrc = fs.readFileSync(path.join(ROOT, 'runtime', 'zh-runtime.js'), 'utf8');
    /* probe.js 的 loadAssets 只回传 P1 需要的字段，rescope* 单独读一次 */
    const selRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'selectors.json'), 'utf8'));
    const cfg = {
      version: 'selftest-1',
      lang: 'zh-CN',
      debug: true,
      dict: assets.dict,
      keep: assets.keep,
      patterns: assets.patterns,
      selectors: {
        scopes: assets.scopes,
        skipText: assets.skipText,
        rescope: selRaw.rescope || [],
        rescopeAttr: selRaw.rescopeAttr || [],
        attrScopes: assets.attrScopes,
        skipAttr: assets.skipAttr,
        attributes: assets.attributes
      },
      maxNodesPerPass: 20000
    };
    const preload = 'globalThis.__ZH_CFG__ = ' + JSON.stringify(cfg) + ';\n' + runtimeSrc + '\n;';

    const r1 = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: preload });
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(2500);

    const zh = await evalJs('!!(globalThis.__ZH__ && globalThis.__ZH__.enabled)');
    ok('运行时已注入', zh === true);

    const T = async (sel) => evalJs('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');return e?e.textContent:null;})()');
    const A = async (sel, attr) => evalJs('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');return e?e.getAttribute(' + JSON.stringify(attr) + '):null;})()');

    console.log('  -- 白名单内 UI 应被翻译 --');
    eq('侧栏 New', await T('[data-testid="nav-new"]'), '新建');
    eq('侧栏 Pull requests', await T('[data-testid="nav-pull-requests"]'), '拉取请求');
    eq('侧栏 Issues', await T('[data-testid="nav-issues"]'), '问题');
    eq('侧栏 Automations', await T('[data-testid="nav-automations"]'), '自动化');
    eq('侧栏 Customize', await T('[data-testid="nav-customize"]'), '自定义');
    eq('侧栏 More', await T('[data-testid="nav-more"]'), '更多');
    eq('侧栏 Projects', await T('[data-testid="nav-projects"]'), '项目');
    eq('侧栏 Chats', await T('[data-testid="nav-chats"]'), '聊天');
    eq('输入框 placeholder', await A('#composer', 'placeholder'), '输入问题或粘贴 URL……');
    eq('输入框 title', await A('#composer', 'title'), '给 Copilot 发消息');
    eq('档位 Efficiency', await T('[data-tier="efficiency"]'), '效率');
    eq('档位 Balance', await T('[data-tier="balance"]'), '均衡');
    eq('档位 Intelligence', await T('[data-tier="intelligence"]'), '智能');
    eq('Switch to Auto aria-label', await A('#switch-auto', 'aria-label'), '切换到 Auto');
    eq('首页引导语', await T('main h1'), '从下面的项目点子开始吧。');
    eq('设置 Current theme', await T('label[for="theme"]'), '当前主题');
    eq('设置 Storage location', await T('label[for="loc"]'), '存储位置');
    eq('设置 Start on system start', await T('label[for="login"]'), '开机时启动');
    eq('空状态文案', await T('#empty p'), '还没有聊天');
    eq('词典未收录的 placeholder 保持英文', await A('#repo-filter', 'placeholder'), 'Filter by repository');

    console.log('  -- 受保护区必须保持英文原样 --');
    const codeText = await T('pre code');
    ok('代码块未被翻译', /const options = \{ mode: "New", title: "Search", retry: true \}/.test(codeText), codeText);
    eq('contenteditable 用户输入未被翻译', await T('#user-input'), 'Delete this line and write your own prompt');
    eq('AI Markdown 正文未被翻译', await T('.markdown p'), 'Here is the fix. Save this file and restart the server.');
    eq('AI Markdown 列表未被翻译', await T('.markdown li'), 'Step one: open the config');
    const xterm = await T('.xterm');
    ok('终端内容未被翻译', /npm run build/.test(xterm) && /Searching for changed files/.test(xterm), xterm.replace(/\n/g, ' '));
    const diff = await T('.diff-view');
    ok('diff 内容未被翻译', /const theme = "Dark"/.test(diff), diff.replace(/\n/g, ' '));
    eq('仓库名未被翻译', await T('.repo-name'), 'octocat/Hello-World');
    eq('PR 标题未被翻译', await T('.pr-title'), 'Fix login redirect loop in OAuth flow');

    console.log('  -- 输入框 value 必须未被触碰 --');
    const valState = await evalJs(`(function(){
      var i=document.getElementById('composer');
      i.value='user typed text 中文原样';
      return {v:i.value};
    })()`);
    eq('用户输入的值原样保留', valState.v, 'user typed text 中文原样');

    console.log('  -- 动态渲染（MutationObserver） --');
    await evalJs('window.__fixture.addDynamic()');
    await sleep(700);
    eq('动态按钮文本被翻译', await T('#dyn-btn'), '自定义');
    eq('动态 aria-label 被翻译', await A('#dyn-btn2', 'aria-label'), '自动化');
    eq('动态空状态被翻译', await T('#dynamic-host .empty-state p'), '未找到结果');

    console.log('  -- React 式重渲染后自动重译 --');
    await evalJs('window.__fixture.resetText()');
    await sleep(700);
    eq('重渲染后仍为中文', await T('#rerender-target'), '新建');

    console.log('  -- 防无限循环 --');
    const before = await evalJs('window.__fixture.mutationCount');
    await sleep(1500);
    const after = await evalJs('window.__fixture.mutationCount');
    ok('稳定后 Mutation 不再增长', after - before <= 5, `before=${before} after=${after} delta=${after - before}`);
    ok('Mutation 总量在合理范围', after < 3000, 'total=' + after);

    console.log('  -- 报告接口 --');
    const rep = await evalJs('JSON.stringify(window.__ZH__.report())');
    const report = JSON.parse(rep);
    ok('report() 可调用', !!report.stats);
    ok('report 含 url', typeof report.url === 'string' && report.url.length > 0);
    ok('report 统计到翻译条数', report.stats.translated > 10, 'translated=' + report.stats.translated);
    ok('report 收集到未翻译候选', Object.keys(report.unmatched).length > 0, Object.keys(report.unmatched).length + ' 条');
    ok('未翻译候选含 Manage repositories', Object.prototype.hasOwnProperty.call(report.unmatched, 'Manage repositories'));
    ok('未翻译候选含 placeholder', Object.prototype.hasOwnProperty.call(report.unmatched, 'Filter by repository'));
    ok('未翻译候选不含代码', !Object.keys(report.unmatched).some((k) => /const options|console\.log/.test(k)));

    /* ==================== C. 对话区：该翻的翻，该保的必须原样 ==================== */
    console.log('\n[C] 对话区（真实 DOM 结构）—— UI 翻译 vs 正文保护');

    console.log('  -- C1. 对话区里的 UI 必须被翻译（rescope 生效） --');
    eq('Model changed to ... 被翻译', await T('#model-notice'), '模型已切换至 Kimi K3 · NVIDIA NIM');
    eq('Thought for Ns 被翻译', await T('#thought'), '思考了 7 秒');
    eq('流式 Thinking 文本被翻译', await T('#thinking-visible'), '思考中');
    eq('流式 Thinking 的 shimmer data-text 同步翻译（避免英文/中文重叠）',
      await A('#thinking-shimmer', 'data-text'), '思考中');
    eq('相对时间 2h ago 被翻译', await T('#stamp'), '2 小时前');
    eq('时间戳 aria-label 被翻译', await A('#stamp', 'aria-label'), '2 小时前，已发送，显示时间戳');
    eq('Copy user message', await A('#act-copy-user', 'aria-label'), '复制用户消息');
    eq('Edit message', await A('#act-edit', 'aria-label'), '编辑消息');
    eq('Bookmark to timeline', await A('#act-bookmark', 'aria-label'), '添加到时间线');
    eq('Copy assistant message', await A('#act-copy-asst', 'aria-label'), '复制助手消息');
    eq('Retry', await A('#act-retry', 'aria-label'), '重试');
    eq('More response actions', await A('#act-more', 'aria-label'), '更多回复操作');

    console.log('  -- C2. 输入区 UI 翻译，输入内容不动 --');
    eq('Send message', await A('#btn-send', 'aria-label'), '发送消息');
    eq('Set up voice dictation', await A('#btn-dictate', 'aria-label'), '设置语音听写');
    eq('Add context & more', await A('#btn-ctx', 'aria-label'), '添加上下文及更多');
    eq('聊天配额 aria-label', await A('#btn-quota', 'aria-label'), '聊天消息配额：已用 0%');
    eq('编辑器 aria-label', await A('#chat-input', 'aria-label'), '消息');
    eq('编辑器 aria-placeholder', await A('#chat-input', 'aria-placeholder'), '输入问题。用 / 调用命令、& 引用会话……');
    eq('可见 placeholder 文本', await T('#chat-placeholder'), '输入问题。用 / 调用命令、& 引用会话……');
    eq('编辑器内用户输入未被翻译', await T('#chat-input'), 'New Search Customize');
    eq('滚动到底部 aria-label', await A('#btn-scroll-bottom', 'aria-label'), '滚动到底部');
    eq('联想菜单 aria-label', await A('#typeahead-host', 'aria-label'), '联想菜单');

    console.log('  -- C7. 输入框自带 .prose 类（rescopeAttr 只开属性、不开文本） --');
    const inputCls = await evalJs('document.querySelector("#chat-input").className');
    ok('#chat-input 确实带 prose 类（复现真实 DOM 条件）', /\bprose\b/.test(inputCls), inputCls);
    ok('#chat-input 文本内容未被翻译（rescopeAttr 不放开文本通道）',
      (await T('#chat-input')) === 'New Search Customize', await T('#chat-input'));
    eq('同一元素上属性被翻译（说明开口子只作用于属性通道）',
      await A('#chat-input', 'aria-placeholder'), '输入问题。用 / 调用命令、& 引用会话……');
    const nonComposerProse = await evalJs('document.querySelector("#asst-prose").textContent.replace(/\\s+/g,"")');
    ok('对话区其它 .prose 仍在 skipAttr 保护下', nonComposerProse === 'NewCustomizeSearch',
      JSON.stringify(nonComposerProse));
    eq('用量浮层 dt 文案', await T('#quota-label'), '套餐');
    eq('用量浮层 dd 百分比', await T('#quota-value'), '已用 0%');
    eq('查看用量与套餐', await T('#btn-usage'), '查看用量与套餐……');
    eq('分享反馈 aria-label', await A('#btn-feedback', 'aria-label'), '分享反馈，Control + Enter');
    eq('反馈对话框标题', await T('#fb-title'), '报告问题或提出建议');
    eq('反馈输入框 placeholder', await A('#fb-body', 'placeholder'), '你想分享什么反馈？');
    eq('反馈发布说明', await T('#fb-note'), '这会以公开的 GitHub issue 形式发布。');
    eq('打开语音设置', await T('#fb-voice'), '打开语音设置');

    console.log('  -- C3. 对话正文 / 用户内容 / 报错 必须原样 --');
    const srText = await T('[data-testid="conversation-message-row"] h2');
    ok('“You said:” sr-only 摘要未被翻译', /^You said: New$/.test(srText), JSON.stringify(srText));
    const srCopilot = await T('[data-testid="conversation-message-row"]:nth-of-type(2) h2');
    ok('“Copilot said:” sr-only 摘要未被翻译', /^Copilot said: New\. Customize/.test(srCopilot), JSON.stringify(srCopilot));
    eq('用户消息正文（prose）未被翻译', await T('#user-prose p'), 'New');
    eq('AI 回复正文（prose）未被翻译', await T('#asst-prose p'), 'New');
    eq('AI 回复正文列表未被翻译', await T('#asst-prose li'), 'Search');
    const errText = await T('#err-text');
    ok('系统报错原文未被翻译', /^Model 'moonshotai\/kimi-k2\.6' not found/.test(errText), JSON.stringify(errText).slice(0, 80));
    eq('会话标题（用户内容）未被翻译', await T('#chat-title-text'), '你好');
    const canvasText = await T('[data-testid="chat-canvas-panel-content"] > div');
    eq('画布/产物预览未被翻译', canvasText, 'New');

    console.log('  -- C4. 顶栏与无障碍标签 --');
    eq('header Utility 被翻译', await A('header[aria-label]', 'aria-label'), '工具');
    eq('Session: <标题> 只翻前缀', await T('header h1'), '会话：你好');
    eq('会话选项 aria-label 只翻后缀', await A('#sess-options', 'aria-label'), '你好 的会话选项');
    eq('对话记录 aria-label 被翻译', await A('[data-testid="conversation-body"]', 'aria-label'), '对话记录');
    eq('对话时间线 aria-label 被翻译', await A('[role="scrollbar"]', 'aria-label'), '对话时间线');

    console.log('  -- C5. 未翻译候选不得收录正文/报错/刻意保留项 --');
    const rep2 = JSON.parse(await evalJs('JSON.stringify(window.__ZH__.report())'));
    const badKeys = Object.keys(rep2.unmatched).filter((k) =>
      /^(?:Copilot|You) said:/.test(k) || /moonshotai|HTTP 404/.test(k) || /^https?:\/\//.test(k));
    ok('候选未收录 AI/用户正文与报错', badKeys.length === 0, badKeys.join(' | '));
    const keepKeys = assets.keep.filter((k) => Object.prototype.hasOwnProperty.call(rep2.unmatched, k));
    ok('候选未收录 keep.json 里刻意保留的品牌/模型名', keepKeys.length === 0, keepKeys.join(' | '));
    ok('候选未收录模型名后缀片段（guard ^·\\\\s 生效）',
      !Object.keys(rep2.unmatched).some((k) => /^·\s/.test(k)),
      Object.keys(rep2.unmatched).filter((k) => /^·/.test(k)).join(' | '));

    console.log('  -- C6. 一键启用 / 禁用 --');
    await evalJs('window.__fixture.zhOff()');
    await sleep(300);
    eq('disable() 后侧栏回到英文', await T('[data-testid="nav-new"]'), 'New');
    eq('disable() 后对话区 UI 回到英文', await T('#thought'), 'Thought for 7s');
    eq('disable() 后 shimmer data-text 回到英文', await A('#thinking-shimmer', 'data-text'), 'Thinking');
    await evalJs('window.__fixture.zhOn()');
    await sleep(500);
    eq('enable() 后侧栏恢复中文', await T('[data-testid="nav-new"]'), '新建');
    eq('enable() 后对话区 UI 恢复中文', await T('#thought'), '思考了 7 秒');
    eq('enable() 后 shimmer data-text 恢复中文', await A('#thinking-shimmer', 'data-text'), '思考中');

    /* =============================== D. en-US 开关 =============================== */
    console.log('\n[D] --lang=en-US 时不注入');
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: r1.identifier });
    const cfgEn = Object.assign({}, cfg, { version: 'selftest-en', lang: 'en-US' });
    const preloadEn = 'globalThis.__ZH_CFG__ = ' + JSON.stringify(cfgEn) + ';\n' + runtimeSrc + '\n;';
    const rEn = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: preloadEn });
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(2000);
    eq('en-US 下侧栏保持英文', await T('[data-testid="nav-new"]'), 'New');
    eq('en-US 下 placeholder 保持英文', await A('#composer', 'placeholder'), 'Ask anything or paste a URL...');
    const en = await evalJs('window.__ZH__ && window.__ZH__.enabled');
    ok('en-US 下 enabled=false', en === false, 'got ' + en);

    /* ==================== E. P2 启动器：CDP 注入链路端到端 ==================== */
    console.log('\n[E] zh-launcher.js —— 真实 CDP 注入链路');

    const L = require(path.join(ROOT, 'zh-launcher.js'));

    console.log('  -- E1. 配置与资源加载 --');
    const lcfg = L.loadConfig();
    ok('读到 launcher.config.json', lcfg.exists === true);
    ok('配置优先使用 %LOCALAPPDATA% 常见安装位置',
      lcfg.exeSearch.some((p) => p === '%LOCALAPPDATA%\\Programs\\GitHub Copilot\\github.exe'));
    const privacyFiles = ['launcher.config.json', 'zh-launcher.js', 'zh-off.cmd', 'README.md'];
    const localNames = Array.from(new Set([process.env.USERNAME, os.userInfo().username].filter(Boolean)));
    const privacyLeaks = privacyFiles.filter((f) => {
      const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
      return localNames.some((name) => name.length >= 3 && s.toLowerCase().includes(name.toLowerCase()));
    });
    ok('重点发布文件不含当前 Windows 用户名', privacyLeaks.length === 0, privacyLeaks.join(', '));
    const assets2 = L.loadAssets();
    ok('启动器能加载词典/白名单/模板', assets2.counts.dict > 400 && assets2.counts.scopes > 50,
      JSON.stringify(assets2.counts));
    ok('资源版本号已计算', /^p2-[0-9a-f]{12}$/.test(assets2.version), assets2.version);
    const bundle = L.buildBundle(assets2, 'zh-CN', false);
    ok('注入包含 __ZH_CFG__', bundle.indexOf('globalThis.__ZH_CFG__') === 0);
    ok('注入包含 rescope 配置', bundle.indexOf('rescope') !== -1);
    ok('注入包含 rescopeAttr 配置', bundle.indexOf('rescopeAttr') !== -1);
    ok('注入包含 guards', bundle.indexOf('guards') !== -1);

    console.log('  -- E2. 自动定位官方 github.exe --');
    const rExe = L.resolveExe(lcfg);
    if (rExe.exe) {
      ok('找到 github.exe', true);
      info2('已定位（测试输出不显示具体本机路径）');
      info2('方式 ' + rExe.how);
      ok('识别到的是 github.exe', /github\.exe$/i.test(rExe.exe), rExe.exe);
      ok('不落在项目目录内（没走错路径）', !rExe.exe.toLowerCase().startsWith(ROOT.toLowerCase()));
    } else {
      ok('未安装 Copilot 时给出候选清单', rExe.tried.length > 0, 'tried=' + rExe.tried.length);
      info2('本机未找到 github.exe（跳过该项断言）');
    }

    console.log('  -- E3. 真实注入：用 headless 浏览器当被注入目标 --');
    /* 先把之前注入的运行时清干净，回到原始英文页面 */
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: rEn.identifier });
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(1800);
    eq('清场后页面回到英文', await T('[data-testid="nav-new"]'), 'New');
    const zhGone = await evalJs('typeof globalThis.__ZH__');
    eq('清场后页面无运行时', zhGone, 'undefined');

    const launcher = spawn(process.execPath, [
      path.join(ROOT, 'zh-launcher.js'),
      '--attach',
      '--port=' + debugPort,
      '--lang=zh-CN',
      '--match=127\\.0\\.0\\.1',
      '--wait=25'
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let lOut = '';
    launcher.stdout.on('data', (d) => { lOut += d; });
    launcher.stderr.on('data', (d) => { lOut += d; });

    let injected = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const v = await evalJs('document.querySelector(\'[data-testid="nav-new"]\').textContent');
        if (v === '新建') { injected = true; break; }
      } catch (e) { /* 页面可能正在加载 */ }
    }
    ok('启动器把页面汉化了', injected, injected ? '' : lOut.slice(-800));
    ok('启动器打印了 CDP 就绪信息', /CDP 就绪/.test(lOut), lOut.slice(0, 300));
    ok('启动器未触碰官方安装目录（attach 模式不解析 exe）', !/找不到 GitHub Copilot/.test(lOut));

    if (injected) {
      eq('启动器注入后：侧栏 New', await T('[data-testid="nav-new"]'), '新建');
      eq('启动器注入后：侧栏 Customize', await T('[data-testid="nav-customize"]'), '自定义');
      eq('启动器注入后：placeholder', await A('#composer', 'placeholder'), '输入问题或粘贴 URL……');
      eq('启动器注入后：对话区 UI', await T('#thought'), '思考了 7 秒');
      eq('启动器注入后：AI 正文仍为英文', await T('#asst-prose p'), 'New');
      eq('启动器注入后：用户输入仍为英文', await T('#chat-input'), 'New Search Customize');
      const lrep = JSON.parse(await evalJs('JSON.stringify(window.__ZH__.report())'));
      ok('启动器注入后 report 可用', !!lrep.stats && lrep.enabled === true);
      ok('启动器注入后仍不收录正文候选',
        !Object.keys(lrep.unmatched).some((k) => /^(?:Copilot|You) said:/.test(k)));
    }

    console.log('  -- E4. 启动器可正常退出 --');
    launcher.kill();
    await sleep(600);
    ok('启动器进程已结束', launcher.killed === true || launcher.exitCode !== null, 'exit=' + launcher.exitCode);

    /* ==================== F. 持久化启动链路（--start / --daemon / --stop） ==================== */
    console.log('\n[F] 持久化启动链路（start-copilot-zh.cmd 背后的东西）');

    console.log('  -- F1. 命令行解析 --');
    const pa = (argv) => L.parseArgs(['node', 'zh-launcher.js'].concat(argv));
    ok('--start 被识别', pa(['--start']).start === true);
    ok('--daemon 被识别', pa(['--daemon']).daemon === true);
    ok('--stop 被识别', pa(['--stop']).stop === true);
    ok('--restart 被识别', pa(['--restart']).restart === true);
    ok('--yes 被识别', pa(['-y']).yes === true);
    ok('默认等待时间已放宽到 120 秒', pa([]).waitSec === 120, String(pa([]).waitSec));
    eq('默认 CDP 端口是 9222', L.DEFAULT_PORT, 9222);
    ok('PID / 日志 / 状态文件路径都在 out/ 下',
      L.PID_FILE.startsWith(path.join(ROOT, 'out')) &&
      L.DAEMON_LOG.startsWith(path.join(ROOT, 'out')) &&
      L.STATUS_FILE.startsWith(path.join(ROOT, 'out')));
    ok('启动器不依赖 spawnSync（同步子进程在受限环境会 EBUSY）',
      !/spawnSync\s*\(/.test(fs.readFileSync(path.join(ROOT, 'zh-launcher.js'), 'utf8')));

    /* 启动期 WebView2 会反复重建浏览器进程（实测每 10 秒左右换一个 PID），
       所以「连接 + 注入」必须是可重试的原子步骤，且守护循环不能按 CDP 断连次数退出。 */
    const launcherSrc = fs.readFileSync(path.join(ROOT, 'zh-launcher.js'), 'utf8');
    ok('导出 attachAndInject（可重试的注入步骤）', typeof L.attachAndInject === 'function');
    ok('findTauriTarget 不再回退到浏览器内部页（about:blank 会打到死页上）',
      /const usable = pages\.filter\(\(t\) => !INTERNAL_URL\.test/.test(launcherSrc) &&
      /if \(!usable\.length\) return null;/.test(launcherSrc));
    ok('守护循环按 github.exe 是否消失决定退出（不按 CDP 断连次数）',
      /ghMissed/.test(launcherSrc) && /Copilot 已退出，守护进程结束/.test(launcherSrc));
    ok('守护进程的等待预算比前台更宽（避免前后台同时放弃）',
      /Math\.max\(OPT\.waitSec, 300\)/.test(launcherSrc));
    /* 前台执行 stopDaemon() 时，PID 文件里记的是守护进程的 PID，永远不等于 process.pid；
       旧的 removePidFile() 只在 pid 相等时才删，于是陈旧记录留了下来，
       下一次启动的守护进程看到它就以为自己多余、直接退出 → 汉化失效。 */
    ok('stopDaemon 强制清理 PID 文件（否则会留下陈旧记录卡死后续启动）',
      /removePidFile\(true\)/.test(launcherSrc));
    ok('removePidFile 支持 force 参数', /function removePidFile\(force\)/.test(launcherSrc));

    /* 跑一次启动器子进程，收集 stdout/stderr/退出码。
       用异步 spawn（本机 spawnSync 不可用）。 */
    const runLauncher = (args, timeoutMs) => new Promise((resolve) => {
      let out = '', err = '', done = false;
      const finish = (code) => { if (!done) { done = true; resolve({ code, out, err }); } };
      const p = spawn(process.execPath, [path.join(ROOT, 'zh-launcher.js')].concat(args),
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { try { p.kill(); } catch (e) { /* noop */ } finish(-1); }, timeoutMs || 60000);
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => { clearTimeout(timer); err += e.message; finish(-1); });
      p.on('close', (c) => { clearTimeout(timer); finish(c == null ? -1 : c); });
    });

    console.log('  -- F2. --help 覆盖全部参数 --');
    const helpRun = await runLauncher(['--help'], 20000);
    const helpTxt = helpRun.out + helpRun.err;
    ['--start', '--stop', '--daemon', '--restart', '--yes', '--lang', '--port', '--exe', '--wait', '--attach', '--debug', '--match', '--no-launch', '--help'].forEach((f) => {
      ok('  help 含 ' + f, helpTxt.includes(f));
    });
    eq('help 退出码为 0', helpRun.code, 0);

    console.log('  -- F3. --stop 在没有守护进程时也要安全退出 --');
    L.removePidFile();
    const stopRun = await runLauncher(['--stop'], 25000);
    const stopTxt = stopRun.out + stopRun.err;
    eq('--stop 退出码为 0', stopRun.code, 0);
    ok('--stop 提示没有守护进程', /没有正在运行/.test(stopTxt), JSON.stringify(stopTxt.slice(0, 160)));

    console.log('  -- F4. PID 文件读写与自清理 --');
    L.writePidFile({ test: true });
    const rd = await L.readPidFile();
    ok('写入后能读回自己的 PID', rd && rd.pid === process.pid, JSON.stringify(rd));
    ok('isPidAlive 认得活进程', (await L.isPidAlive(process.pid)) === true);
    ok('isPidAlive 判定不存在的 PID 为已死', (await L.isPidAlive(999999)) === false);

    /* Windows 会复用 PID。真实踩到过：守护进程早已退出，它的 PID 被一个无关程序
       接手（实测是 SenaryAdvancedFeaturesApp），于是
         · 每个新守护进程一启动就以为自己多余、立刻退出 → 汉化再也注入不进来；
         · stopDaemon 还会去 taskkill 那个无关进程 → 误杀别人的程序。
       所以存活判定必须确认这个 PID 现在确实是 node.exe。 */
    ok('isPidAlive 会校验映像名，不把非 node 进程当成守护进程',
      (await L.isPidAlive(4)) === false, 'PID 4 = System，必须是 false');
    fs.writeFileSync(L.PID_FILE, JSON.stringify({ pid: 4, startedAt: new Date().toISOString(), port: 9222 }, null, 2));
    const reused = await L.readPidFile();
    ok('PID 被非 node 进程复用时 readPidFile 视为已死', reused === null, JSON.stringify(reused));
    ok('并顺手清掉了那个陈旧 PID 文件（否则会永久卡死）', !fs.existsSync(L.PID_FILE));

    L.removePidFile();
    ok('removePidFile 清掉了文件', !fs.existsSync(L.PID_FILE));
    const stale = await L.readPidFile();
    ok('无 PID 文件时 readPidFile 返回 null', stale === null, JSON.stringify(stale));

    /* 守护进程 → 前台的状态通道（前台据此判断注入是否建立，避免假失败） */
    L.removeStateFile();
    ok('无状态文件时 readState 返回 null', L.readState() === null);
    L.writeState({ phase: 'injected', translated: 7, injected: true });
    const st = L.readState();
    ok('writeState/readState 往返正常', st && st.pid === process.pid && st.phase === 'injected' && st.translated === 7,
      JSON.stringify(st));
    L.removeStateFile();
    ok('removeStateFile 清掉了状态文件', !fs.existsSync(L.STATE_FILE));
    ok('状态文件路径在 out/ 下', L.STATE_FILE.startsWith(path.join(ROOT, 'out')));

    console.log('  -- F5. --daemon 连不上 CDP 时快速失败（不误启动 Copilot） --');
    const beforeProcs = (await L.listGithubProcs()).length;
    if (fs.existsSync(L.DAEMON_LOG)) fs.unlinkSync(L.DAEMON_LOG);
    const dRun = await runLauncher(['--daemon', '--port=19999', '--wait=2'], 60000);
    eq('--daemon 连不上时退出码为 4', dRun.code, 4);
    const afterProcs = (await L.listGithubProcs()).length;
    eq('--daemon 不会启动新的 Copilot 进程', afterProcs, beforeProcs);
    ok('--daemon 把日志写到了 out/zh-daemon.log', fs.existsSync(L.DAEMON_LOG));
    if (fs.existsSync(L.DAEMON_LOG)) {
      const dtxt = fs.readFileSync(L.DAEMON_LOG, 'utf8');
      ok('守护日志里有启动标记', /daemon 启动 PID/.test(dtxt), dtxt.slice(0, 120));
      ok('守护日志里没有 ANSI 转义码', !/\x1b\[/.test(dtxt));
    }
    ok('--daemon 退出后 PID 文件已清理', !fs.existsSync(L.PID_FILE));

    console.log('  -- F6. 交付的 .cmd / .ps1 都在位且指向正确 --');
    const needFiles = [
      ['start-copilot-zh.cmd', /zh-launcher\.js"\s+--start/],
      ['create-shortcut.cmd', /create-shortcut\.ps1/],
      ['create-shortcut.ps1', /start-copilot-zh\.cmd/],
      ['zh-off.cmd', /--stop/],
      ['zh-launcher-debug.cmd', /--start --debug/],
      ['zh-launcher.cmd', /zh-launcher\.js/]
    ];
    for (const [f, re] of needFiles) {
      const p = path.join(ROOT, f);
      const exists = fs.existsSync(p);
      ok(f + ' 存在', exists);
      if (exists) {
        const raw = fs.readFileSync(p);
        const txt = raw.toString('utf8');
        ok(f + ' 内容正确', re.test(txt), txt.slice(0, 120).replace(/\n/g, ' '));
        if (f.endsWith('.cmd')) {
          const crlf = (raw.toString('binary').match(/\r\n/g) || []).length;
          const lf = (raw.toString('binary').match(/\n/g) || []).length;
          ok(f + ' 使用 Windows CRLF（避免 CMD 把注释当命令执行）', crlf > 0 && crlf === lf,
            'CRLF=' + crlf + ' LF=' + lf);
        }
      }
    }
    const cmdFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.cmd'));
    const allCmdCrlf = cmdFiles.length > 0 && cmdFiles.every((f) => {
      const b = fs.readFileSync(path.join(ROOT, f));
      const lfCount = (b.toString('binary').match(/\n/g) || []).length;
      const crlfCount = (b.toString('binary').match(/\r\n/g) || []).length;
      return crlfCount > 0 && lfCount === crlfCount;
    });
    ok('全部项目 .cmd 都使用 CRLF（LF-only 会令 CMD 执行乱码注释）', allCmdCrlf,
      cmdFiles.join(', '));

    /* cmd.exe 在 "chcp 65001" 下解析含多字节字符的批处理会错位：
       它会丢掉与字符数不符的字节，把注释/echo 的片段当成命令执行，报出
         'xxx' is not recognized as an internal or external command
       而且错位位置随文件长度漂移（实测同一份内容，21 行时 0 个错、44 行时 9 个错）。
       UTF-8+BOM / GBK / chcp 936 都不能稳定解决，唯一确定性做法是 .cmd 保持纯 ASCII。
       中文提示改由 tools\messages\*.txt（UTF-8）配合 type 输出 —— 这条路已验证安全。 */
    const asciiCheck = cmdFiles.map((f) => {
      const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
      return [f, [...txt].filter((c) => c.charCodeAt(0) > 127).length];
    });
    ok('全部项目 .cmd 都是纯 ASCII（chcp 65001 下多字节字符会让 cmd 解析错位）',
      asciiCheck.every(([, n]) => n === 0),
      asciiCheck.filter(([, n]) => n > 0).map(([f, n]) => f + '=' + n).join(', ') || 'ok');

    const msgDir = path.join(ROOT, 'tools', 'messages');
    ok('中文控制台提示放在 tools/messages/ 下的 UTF-8 文本里',
      fs.existsSync(path.join(msgDir, 'node-missing.txt')));
    const nodeMissingTxt = fs.readFileSync(path.join(msgDir, 'node-missing.txt'));
    ok('node-missing.txt 是 UTF-8 且不带 BOM（type 输出时不会多一个字符）',
      !(nodeMissingTxt[0] === 0xEF && nodeMissingTxt[1] === 0xBB && nodeMissingTxt[2] === 0xBF));
    ok('node-missing.txt 里确实是中文提示',
      nodeMissingTxt.toString('utf8').includes('未找到 Node.js'));
    const referrers = cmdFiles.filter((f) =>
      fs.readFileSync(path.join(ROOT, f), 'utf8').includes('tools\\messages\\node-missing.txt'));
    ok('找不到 Node 的 .cmd 都用 type 打印该文本而不是 echo 中文',
      referrers.length >= 4, referrers.join(', '));

    const zhOff = fs.readFileSync(path.join(ROOT, 'zh-off.cmd'), 'utf8');
    ok('zh-off.cmd 在 LOCALAPPDATA 不同步时按当前用户名跨盘查找',
      /for %%D in \(C D E F G H I J\)/.test(zhOff) && zhOff.includes('%USERNAME%'));
    const probeStart = fs.readFileSync(path.join(ROOT, 'probe-start.cmd'), 'utf8');
    ok('probe-start.cmd 也支持 AppData 跨盘重定向',
      /for %%D in \(C D E F G H I J\)/.test(probeStart) && probeStart.includes('%USERNAME%'));

    const ps1 = fs.readFileSync(path.join(ROOT, 'create-shortcut.ps1'), 'utf8');
    ok('create-shortcut.ps1 是 UTF-8 with BOM（PowerShell 5.1 中文不乱码）',
      ps1.charCodeAt(0) === 0xFEFF, 'first char code=' + ps1.charCodeAt(0).toString(16));
    ok('create-shortcut.ps1 默认快捷方式名为「GitHub Copilot（中文）」',
      ps1.includes('GitHub Copilot（中文）'));

    cdp.close();
  } catch (e) {
    FAIL++;
    failures.push('运行异常: ' + (e && e.stack || e));
    console.log('\n\x1b[31m运行异常:\x1b[0m ' + (e && e.stack || e));
  } finally {
    cleanup();
  }

  console.log('\n============================================================');
  console.log(` 通过 ${PASS} 项，失败 ${FAIL} 项`);
  if (failures.length) {
    console.log(' 失败清单：');
    failures.forEach((f) => console.log('   - ' + f));
  }
  console.log('============================================================\n');
  process.exitCode = FAIL ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
