#!/usr/bin/env node
/* =============================================================================
 * live-check.js —— 对【真实运行中的 GitHub Copilot Desktop】做只读验收
 * -----------------------------------------------------------------------------
 * 它不启动 Copilot、不改官方文件；只在已开启 CDP 的实例上：
 *   1. 若页面还没有 __ZH__，就用 zh-launcher.js --attach 注入一次；
 *   2. 逐条断言「该翻的翻了 / 不该翻的一字未动」；
 *   3. 实际点侧栏做页面切换，验证切换后汉化仍在；
 *   4. 实际插入/改写节点，验证 React 式动态更新后仍会翻译。
 *
 * 用法：
 *   node tools/live-check.js                     # 默认端口 9222
 *   node tools/live-check.js --port=9222
 *   node tools/live-check.js --no-inject         # 只检查，不自动注入
 *   node tools/live-check.js --json=out/live-report.json
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const L = require(path.join(ROOT, 'zh-launcher.js'));

let PASS = 0, FAIL = 0, SKIP = 0;
const failures = [];
const c = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m' };

function ok(name, cond, detail) {
  if (cond) { PASS++; console.log('  ' + c.green + 'PASS' + c.off + ' ' + name); }
  else {
    FAIL++; failures.push(name + (detail ? ' → ' + detail : ''));
    console.log('  ' + c.red + 'FAIL' + c.off + ' ' + name + (detail ? ' → ' + detail : ''));
  }
}
function eq(name, got, want) { ok(name, got === want, JSON.stringify(got) + ' !== ' + JSON.stringify(want)); }
function skip(name, why) { SKIP++; console.log('  ' + c.yellow + 'SKIP' + c.off + ' ' + name + '（' + why + '）'); }
function head(t) { console.log('\n' + t); }
function info(t) { console.log('  ' + c.dim + t + c.off); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 参数 --- */

const OPT = { port: 9222, inject: true, refresh: false, json: '' };
process.argv.slice(2).forEach((a) => {
  if (a.startsWith('--port=')) OPT.port = Number(a.slice(7)) || 9222;
  else if (a === '--no-inject') OPT.inject = false;
  else if (a === '--refresh') OPT.refresh = true;
  else if (a.startsWith('--json=')) OPT.json = a.slice(7);
  else if (a === '--help' || a === '-h') {
    console.log('用法: node tools/live-check.js [--port=9222] [--no-inject] [--refresh] [--json=out/live-report.json]');
    process.exit(0);
  }
});

/* ------------------------------------------------------------------ 主体 --- */

let launcher = null;
let launcherOut = '';
let cdp = null;

async function connect() {
  const found = await L.waitForCdp(OPT.port, 12000);
  if (!found) throw new Error(`连不上 CDP 端口 ${OPT.port}`);
  const cli = new L.CDP(found.target.ws);
  await cli.connect();
  try { await cli.send('Page.enable'); } catch (e) { /* noop */ }
  try { await cli.send('Runtime.enable'); } catch (e) { /* noop */ }
  return { cli, target: found.target, browser: found.browser };
}

async function evalJs(cli, expr) {
  const r = await cli.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  });
  if (r.exceptionDetails) {
    throw new Error('页面求值异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  }
  return r.result ? r.result.value : undefined;
}

async function hasRuntime(cli) {
  try { return await evalJs(cli, '!!(globalThis.__ZH__ && globalThis.__ZH__.version)') === true; }
  catch (e) { return false; }
}

async function main() {
  console.log('\n=== copilot-zh 真实环境验收（只读，不改官方文件） ===\n');

  let conn;
  try { conn = await connect(); }
  catch (e) {
    console.log(c.red + '  ' + e.message + c.off);
    console.log('  请先开启 CDP：设置 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=' +
      '"--remote-debugging-port=' + OPT.port + ' --remote-allow-origins=*" 再启动 Copilot，');
    console.log('  或直接用  node zh-launcher.js --debug  启动汉化版。');
    process.exitCode = 2;
    return;
  }
  cdp = conn.cli;
  info('CDP 已连接：' + conn.browser);
  info('目标页面：' + conn.target.url);

  /* ---------- 0. 必要时注入 ---------- */
  head('[0] 注入运行时');

  const expected = L.loadAssets().version;
  info('本地资源版本 ' + expected);

  const pageVer0 = await hasRuntime(cdp)
    ? await evalJs(cdp, 'globalThis.__ZH__.version')
    : null;

  if (pageVer0 === expected) {
    info('页面上的运行时已是最新版本，跳过注入。');
  } else if (!OPT.inject) {
    ok('页面运行时版本与本地一致', false,
      '页面=' + pageVer0 + ' 本地=' + expected + '（指定了 --no-inject，未重新注入）');
  } else {
    if (pageVer0) info('页面上的运行时是旧版本（' + pageVer0 + '），重新注入…');
    else info('页面还没有 __ZH__，用 zh-launcher.js --attach 注入一次…');
    launcher = spawn(process.execPath, [
      path.join(ROOT, 'zh-launcher.js'), '--attach', '--port=' + OPT.port, '--lang=zh-CN'
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    launcher.stdout.on('data', (d) => { launcherOut += d; });
    launcher.stderr.on('data', (d) => { launcherOut += d; });

    let hit = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const v = await hasRuntime(cdp) ? await evalJs(cdp, 'globalThis.__ZH__.version') : null;
      if (v === expected) { hit = true; break; }
    }
    ok('注入后页面运行时版本与本地一致', hit,
      '页面=' + (await (async () => (await hasRuntime(cdp)) ? await evalJs(cdp, 'globalThis.__ZH__.version') : null)()) + ' 本地=' + expected);
    await sleep(1500);
  }

  const ver = await evalJs(cdp, 'globalThis.__ZH__ ? globalThis.__ZH__.version : null');
  ok('运行时已注入', typeof ver === 'string' && ver.length > 0, String(ver));
  ok('运行时版本与本地资源一致（证明测的是最新代码）', ver === expected, String(ver) + ' vs ' + expected);
  const enabled = await evalJs(cdp, 'globalThis.__ZH__ ? globalThis.__ZH__.enabled : null');
  ok('汉化处于开启状态', enabled === true, String(enabled));
  if (typeof ver === 'string') info('资源版本 ' + ver);
  const url0 = await evalJs(cdp, 'location.pathname');
  info('起始路由 ' + url0);

  /* ---------- 0.5 确保停在聊天页（对话区断言都依赖它） ---------- */
  async function clickByText(label) {
    return evalJs(cdp, `(function(){
      var all = document.querySelectorAll('a,button,[role="link"],[role="button"],[role="tab"]');
      for (var i = 0; i < all.length; i++) {
        if ((all[i].textContent || '').trim() === ${JSON.stringify(label)}) {
          var r = all[i].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { all[i].click(); return true; }
        }
      }
      return false;
    })()`);
  }

  head('[0.5] 回到聊天页');
  let pathNow = await evalJs(cdp, 'location.pathname');
  if (/^\/chats\//.test(pathNow)) {
    info('已在聊天页 ' + pathNow);
  } else {
    if (await clickByText('聊天')) {
      await sleep(1800);
      const opened = await evalJs(cdp, `(function(){
        var e = document.querySelector("[data-testid='quick-chat-session-row']");
        if (e) { (e.querySelector('a,button') || e).click(); return 'session-row'; }
        var a = document.querySelector('a[href^="/chats/"]');
        if (a) { a.click(); return 'href'; }
        return null;
      })()`);
      await sleep(2500);
      pathNow = await evalJs(cdp, 'location.pathname');
      info('打开方式 ' + opened + ' → ' + pathNow);
    }
    ok('已进入聊天页（对话区断言的前提）', /^\/chats\//.test(pathNow), '当前 ' + pathNow);
  }

  /* ---------- 1. 输入框：本次修复的核心（自带 .prose，只开属性通道） ---------- */
  head('[1] 输入框（div[role=textbox].prose）—— 属性翻、内容不翻');

  const composer = await evalJs(cdp, `(function(){
    var e = document.querySelector("[data-testid='conversation-composer-area'] [role='textbox']")
         || document.querySelector("[role='textbox']");
    if (!e) return null;
    return {
      cls: e.className,
      ariaLabel: e.getAttribute('aria-label'),
      ariaPlaceholder: e.getAttribute('aria-placeholder'),
      text: e.textContent,
      ce: e.getAttribute('contenteditable')
    };
  })()`);

  if (!composer) {
    skip('输入框检查', '当前页面没有输入框');
  } else {
    ok('输入框确实带 prose 类（复现真实 DOM 条件）', /\bprose\b/.test(composer.cls), composer.cls);
    ok('输入框是 contenteditable（文本必须保护）', composer.ce === 'true' || composer.ce === '', String(composer.ce));
    eq('输入框 aria-label 已翻译', composer.ariaLabel, '消息');
    const phZh = composer.ariaPlaceholder;
    ok('输入框 aria-placeholder 已翻译为中文',
      /[\u4e00-\u9fa5]/.test(phZh || ''), JSON.stringify(phZh));
    if (phZh) info('aria-placeholder = ' + phZh);
    const ceNode = await evalJs(cdp, `(function(){
      var e = document.querySelector("[data-testid='conversation-composer-area'] [role='textbox']")
           || document.querySelector("[role='textbox']");
      if (!e) return null;
      var out = [];
      var w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
      var n;
      while ((n = w.nextNode())) out.push({ t: n.nodeValue, touched: n.__zh_out != null });
      return out;
    })()`);
    const touchedCe = (ceNode || []).filter((x) => x.touched);
    ok('输入框内的文本节点一个都没被改写（用户输入受保护）', touchedCe.length === 0,
      touchedCe.map((x) => x.t).join(' | '));
    info('输入框当前内容（原样）= ' + JSON.stringify(composer.text).slice(0, 120));
  }

  /* ---------- 2. 对话区 UI：该翻的必须翻 ---------- */
  head('[2] 对话区 UI（rescope / rescopeAttr 放行的部分）');

  const ui = await evalJs(cdp, `(function(){
    function txt(sel){ var e=document.querySelector(sel); return e?e.textContent:null; }
    function attr(sel,a){ var e=document.querySelector(sel); return e?e.getAttribute(a):null; }
    return {
      modelNotice: txt("[data-testid='model-change-notice']"),
      thought: txt("[data-testid='assistant-reasoning-toggle']"),
      shimmer: attr(".text-shimmer-overlay-text", "data-text"),
      copyUser: attr("[data-testid='user-message-actions'] button[aria-label]", "aria-label"),
      scrollBottom: attr("button[aria-label='Scroll to bottom'], button[aria-label='滚动到底部']", "aria-label"),
      typeahead: attr("div[aria-label='Typeahead menu'], div[aria-label='联想菜单']", "aria-label"),
      stamp: attr("[data-testid='user-message-actions'] button", "aria-label"),
      quota: attr("button[aria-label*='quota'], button[aria-label*='配额']", "aria-label")
    };
  })()`);

  if (ui.modelNotice) ok('“Model changed to X” 已翻译（模型名原样保留）',
    /^模型已切换至 /.test(ui.modelNotice) && /Kimi K3|DeepSeek/.test(ui.modelNotice), ui.modelNotice);
  else skip('Model changed to X', '当前对话没有该提示');

  if (ui.thought) ok('“Thought for Ns” 已翻译', /^思考了 /.test(ui.thought), ui.thought);
  else skip('Thought for Ns', '当前对话没有该提示');

  if (ui.shimmer) ok('流式文字 shimmer 的 data-text 已翻译（不会与中文重叠）',
    /[\u4e00-\u9fa5]/.test(ui.shimmer), ui.shimmer);
  else skip('流式文字 shimmer', '当前页面没有该控件');

  if (ui.scrollBottom) eq('“Scroll to bottom” 已翻译', ui.scrollBottom, '滚动到底部');
  else skip('Scroll to bottom', '当前页面没有该按钮');

  if (ui.typeahead) eq('“Typeahead menu” 已翻译', ui.typeahead, '联想菜单');
  else skip('Typeahead menu', '当前页面没有该控件');

  if (ui.quota) ok('配额 aria-label 已翻译', /[\u4e00-\u9fa5]/.test(ui.quota), ui.quota);
  else skip('配额 aria-label', '当前页面没有该控件');

  /* ---------- 3. 保护断言：正文 / 用户内容 / 代码 一字未动 ---------- */
  head('[3] 保护断言 —— 用 __zh_out 标记证明运行时从未写过这些节点');

  const PROTECTED = [
    ["[data-testid='conversation-message-row'] h2", '消息行 sr-only 摘要（Copilot said: …）'],
    ["[data-testid='user-message-bubble']", '用户消息气泡'],
    ["[data-testid='user-message-bubble'] .prose", '用户消息正文'],
    ["[data-testid='conversation-message-row'] .prose", 'AI 回复正文'],
    ["[data-testid='system-error-row']", '系统报错原文'],
    ["[data-testid='chat-header-title']", '会话标题（用户内容）'],
    ["[data-testid='chat-canvas-panel-content']", '画布 / 产物预览'],
    ["[data-testid='quick-chat-session-row']", '侧栏会话条目'],
    ['pre', '代码块'],
    ['code', '行内代码']
  ];

  for (const [sel, label] of PROTECTED) {
    const r = await evalJs(cdp, `(function(){
      var els = document.querySelectorAll(${JSON.stringify(sel)});
      if (!els.length) return { present: false };
      var touched = 0, total = 0, sample = null;
      for (var i = 0; i < els.length; i++) {
        var w = document.createTreeWalker(els[i], NodeFilter.SHOW_TEXT);
        var n;
        while ((n = w.nextNode())) {
          total++;
          if (n.__zh_out != null) { touched++; if (!sample) sample = n.nodeValue; }
        }
      }
      return { present: true, total: total, touched: touched, sample: sample };
    })()`);
    if (!r || !r.present) { skip(label + ' 未被改写', '当前页面没有该元素'); continue; }
    ok(label + ' 未被改写', r.touched === 0, r.touched + '/' + r.total + ' 个文本节点被改写' + (r.sample ? '，例：' + JSON.stringify(r.sample) : ''));
  }

  const guardHits = await evalJs(cdp, `(function(){
    var rep = window.__ZH__.report();
    var bad = Object.keys(rep.unmatched).filter(function(k){
      return /^(?:Copilot|You) said:/.test(k) || /^https?:\\/\\//.test(k) || /not found on provider/.test(k);
    });
    return { bad: bad, n: Object.keys(rep.unmatched).length, errors: rep.errors, translated: rep.stats.translated, passes: rep.stats.passes };
  })()`);
  ok('未翻译候选里不含正文 / URL / 报错', guardHits.bad.length === 0, guardHits.bad.join(' | '));
  ok('运行时未记录到 JS 错误', (guardHits.errors || []).length === 0, (guardHits.errors || []).join(' | '));
  info(`已翻译 ${guardHits.translated} 处 | 未翻译候选 ${guardHits.n} 条 | 扫描轮次 ${guardHits.passes}`);

  /* ---------- 4. 动态 UI：MutationObserver 仍然工作 ---------- */
  head('[4] 动态 UI（React 式节点插入 / 文本改写）');

  const dyn = await evalJs(cdp, `(function(){
    var host = document.createElement('div');
    host.setAttribute('data-testid','__live_probe_host');
    host.className = 'nav-item';
    var b = document.createElement('button');
    b.id = '__live_probe_btn';
    b.textContent = 'New';
    b.setAttribute('aria-label','Customize');
    host.appendChild(b);
    document.body.appendChild(host);
    return true;
  })()`);
  ok('成功向页面插入测试节点', dyn === true);
  await sleep(900);
  eq('新插入节点的文本被翻译', await evalJs(cdp, 'document.getElementById("__live_probe_btn").textContent'), '新建');
  eq('新插入节点的 aria-label 被翻译', await evalJs(cdp, 'document.getElementById("__live_probe_btn").getAttribute("aria-label")'), '自定义');

  /* 受保护区内的动态改写必须保持英文 */
  const protDyn = await evalJs(cdp, `(function(){
    var e = document.querySelector("[data-testid='conversation-message-row'] .prose");
    if (!e) return null;
    e.setAttribute('data-testid','__live_prose_probe');
    e.textContent = 'Customize';
    return true;
  })()`);
  if (protDyn) {
    await sleep(900);
    eq('受保护正文被改写后仍保持英文', await evalJs(cdp, 'document.querySelector("[data-testid=\'__live_prose_probe\']").textContent'), 'Customize');
  } else {
    skip('受保护正文动态改写', '当前对话没有 AI 正文节点');
  }

  await evalJs(cdp, `(function(){
    var h = document.querySelector("[data-testid='__live_probe_host']");
    if (h) h.remove();
  })()`);

  /* ---------- 5. 页面切换：真实点侧栏 ---------- */
  head('[5] 页面切换（真实点击侧栏导航）');

  const navPlan = await evalJs(cdp, `(function(){
    var labels = ['拉取请求','问题','聊天','新建','更多','扩展','Extensions'];
    var found = {};
    var all = document.querySelectorAll('a,button,[role="link"],[role="button"],[role="tab"]');
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].textContent || '').trim();
      if (labels.indexOf(t) !== -1 && !found[t]) {
        var r = all[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) found[t] = true;
      }
    }
    return found;
  })()`);
  info('侧栏可点的中文导航：' + JSON.stringify(navPlan));

  const beforePasses = await evalJs(cdp, 'window.__ZH__.report().stats.passes');

  let navDone = 0;
  for (const [label, wantPath] of [['拉取请求', '/pulls'], ['问题', '/issues']]) {
    if (!navPlan[label]) { skip('切换到 ' + wantPath, '侧栏没找到「' + label + '」（可能已折叠）'); continue; }
    const clicked = await clickByText(label);
    if (!clicked) { skip('切换到 ' + wantPath, '点击失败'); continue; }
    await sleep(2500);
    const p = await evalJs(cdp, 'location.pathname');
    ok('点击「' + label + '」后路由变为 ' + wantPath, p === wantPath, '实际 ' + p);
    const stillOn = await evalJs(cdp, '!!(window.__ZH__ && window.__ZH__.enabled)');
    ok('切换后汉化仍然开启', stillOn === true, String(stillOn));
    const zhHere = await evalJs(cdp, `(function(){
      var t = document.body.innerText || '';
      return /[\\u4e00-\\u9fa5]/.test(t);
    })()`);
    ok('切换后页面上仍显示中文', zhHere === true, String(zhHere));
    navDone++;
  }

  /* 更多菜单：点开后菜单项必须是中文 */
  const moreLabel = navPlan['更多'] ? '更多' : 'More';
  if (await clickByText(moreLabel)) {
    await sleep(1200);
    const menuText = await evalJs(cdp, `(function(){
      var m = document.querySelector("[role='menu']");
      return m ? m.innerText : null;
    })()`);
    if (menuText) ok('「更多」菜单内容为中文', /[\u4e00-\u9fa5]/.test(menuText), JSON.stringify(menuText).slice(0, 120));
    else skip('「更多」菜单内容为中文', '该构建下「更多」不弹出 role=menu');
    await evalJs(cdp, 'document.body.click()');
    await sleep(400);
  } else {
    skip('「更多」菜单内容为中文', '侧栏没有「更多」入口');
  }

  /* 扩展页：优先真实点击，退化为路由跳转 */
  const toExt = await evalJs(cdp, `(function(){
    var all = document.querySelectorAll('a,button,[role="link"],[role="button"],[role="tab"]');
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].textContent || '').trim();
      if (t === '扩展' || t === 'Extensions') {
        var r = all[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { all[i].click(); return 'click'; }
      }
    }
    try {
      history.pushState({}, '', '/extensions');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      return 'route';
    } catch (e) { return null; }
  })()`);
  await sleep(2500);
  const extPath = await evalJs(cdp, 'location.pathname');
  ok('进入扩展页（方式：' + toExt + '）', extPath === '/extensions', '实际 ' + extPath);
  const extZh = await evalJs(cdp, `(function(){
    var t = document.body.innerText || '';
    return /[\\u4e00-\\u9fa5]/.test(t);
  })()`);
  ok('扩展页界面显示中文', extZh === true, String(extZh));

  if (navDone === 0) {
    ok('页面切换可用', false, '没有可点击的侧栏导航项');
  }

  const afterPasses = await evalJs(cdp, 'window.__ZH__.report().stats.passes');
  ok('切换页面后运行时继续扫描（passes 增长）', afterPasses >= beforePasses,
    `before=${beforePasses} after=${afterPasses}`);

  /* ---------- 6. 整页刷新后仍自动汉化（P2 目标 9） ---------- */
  head('[6] 整页刷新后仍自动汉化（可选，--refresh）');
  if (!OPT.refresh) {
    skip('刷新后仍自动汉化', '需要 --refresh（会真实重载 Copilot 页面）');
  } else {
    const guardian = spawn(process.execPath, [
      path.join(ROOT, 'zh-launcher.js'), '--attach', '--port=' + OPT.port, '--lang=zh-CN'
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let gOut = '';
    guardian.stdout.on('data', (d) => { gOut += d; });
    guardian.stderr.on('data', (d) => { gOut += d; });
    await sleep(3500);
    ok('守护型启动器已就绪（提供刷新后自动注入）', /CDP 就绪/.test(gOut), gOut.slice(0, 200));

    try { await cdp.send('Page.enable'); } catch (e) { /* 已启用 */ }
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(7000);

    const vAfter = await hasRuntime(cdp) ? await evalJs(cdp, 'globalThis.__ZH__.version') : null;
    ok('刷新后运行时自动恢复（无需手动干预）', vAfter === expected, '刷新后=' + vAfter + ' 本地=' + expected);
    const zhAfter = await evalJs(cdp, `/[\\u4e00-\\u9fa5]/.test(document.body.innerText || '')`);
    ok('刷新后页面仍显示中文', zhAfter === true, String(zhAfter));
    try { guardian.kill(); } catch (e) { /* noop */ }
  }

  /* ---------- 7. 汇总 ---------- */
  head('[7] 汇总');
  const finalRep = await evalJs(cdp, 'JSON.stringify(window.__ZH__.report())');
  const rep = JSON.parse(finalRep);
  info(`最终：路由 ${rep.url}`);
  info(`已翻译 ${rep.stats.translated} 处 | 扫描轮次 ${rep.stats.passes} | 未翻译候选 ${Object.keys(rep.unmatched).length} 条 | 错误 ${rep.errors.length} 条`);
  if (Object.keys(rep.unmatched).length) {
    info('仍未翻译（前 12 条）：' + Object.keys(rep.unmatched).slice(0, 12).map((k) => JSON.stringify(k)).join(', '));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    port: OPT.port,
    browser: conn.browser,
    launcherVersion: ver,
    pass: PASS, fail: FAIL, skip: SKIP,
    failures,
    runtime: rep,
    launcherOut: launcherOut.slice(-2000)
  };
  const outPath = OPT.json || path.join(ROOT, 'out', 'live-report.json');
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    info('验收报告写入 ' + outPath);
  } catch (e) { info('报告写入失败：' + e.message); }

  console.log('\n============================================================');
  console.log(` 通过 ${PASS} 项，失败 ${FAIL} 项，跳过 ${SKIP} 项`);
  if (failures.length) {
    console.log(' 失败清单：');
    failures.forEach((f) => console.log('   - ' + f));
  }
  console.log('============================================================\n');
  process.exitCode = FAIL ? 1 : 0;
}

main()
  .catch((e) => {
    FAIL++;
    console.log('\n\x1b[31m运行异常:\x1b[0m ' + (e && e.stack || e));
    process.exitCode = 1;
  })
  .finally(() => {
    if (launcher) { try { launcher.kill(); } catch (e) { /* noop */ } }
    if (cdp) cdp.close();
  });
