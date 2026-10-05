/* =============================================================================
 * GitHub Copilot Desktop 简体中文汉化运行时（注入到 WebView2 页面执行）
 * -----------------------------------------------------------------------------
 * 依赖：启动器在执行前先设置 globalThis.__ZH_CFG__
 *       { version, lang, debug, dict, keep, patterns, selectors, maxNodesPerPass }
 *
 * 设计约束（对应需求 3 / 5 / 6 / 7 / 9 / 12）：
 *   1. 白名单优先  —— 只有落在 selectors.scopes 内的文本节点才考虑翻译。
 *   2. 精确匹配    —— 词典精确匹配 + 模板；未命中一律保持英文，绝不强翻。
 *   3. 只写两处    —— 文本节点 nodeValue 与白名单属性；永不写 value，
 *                     永不进入 contenteditable / code / pre / 终端 / 消息正文。
 *   4. 幂等防循环  —— 写入后记录 __zh_out，下次进入若值未变则直接返回，
 *                     MutationObserver 不会被自己的写入自激。
 *   5. 抗重渲染    —— React 重置文本或替换节点后，值不再等于 __zh_out，
 *                     会被自动重新翻译。
 *   6. 三道保险    —— (a) skipText 整块保护；(b) guards 正则拦正文/URL/日志；
 *                     (c) 词典精确匹配，长句一律不译。
 *   7. rescope     —— 在 skipText 区域内开小口子，只放行明确列出的 UI 子区域。
 *   8. rescopeAttr —— 在 skipAttr 区域内开小口子（只影响属性通道）。
 *                    用于输入框本体自带 .prose 类的情况：只放行 aria-*，
 *                    输入框里的文本内容仍被 skipText 保护，用户输入绝不被翻。
 * ========================================================================== */
(function () {
  'use strict';

  var CFG = globalThis.__ZH_CFG__;
  if (!CFG) return;

  var VERSION = CFG.version || '0';
  var PREV = globalThis.__ZH__;
  if (PREV && PREV.version === VERSION && PREV.lang === CFG.lang) {
    return;
  }
  /* 版本不同 = 热更新/重新注入：先把上一版关掉，避免残留 MutationObserver
     与新实例同时改写 DOM（虽然幂等，但会白跑一遍）。 */
  if (PREV && typeof PREV.disable === 'function') {
    try { PREV.disable(); } catch (e) { /* 旧实例可能已损坏，忽略 */ }
  }

  /* ------------------------------------------------------------------ 配置 */

  var SEL = CFG.selectors || {};
  var ATTRS = SEL.attributes || ['placeholder', 'title', 'aria-label'];
  var SCOPE_SEL = (SEL.scopes || []).join(',');
  var ATTR_SCOPE_SEL = (SEL.attrScopes || []).join(',');
  var SKIP_TEXT_SEL = (SEL.skipText || []).join(',');
  var SKIP_ATTR_SEL = (SEL.skipAttr || []).join(',');
  var RESCOPE_SEL = (SEL.rescope || []).join(',');
  var RESCOPE_ATTR_SEL = (SEL.rescopeAttr || []).join(',');
  /* 遍历入口 = 白名单区 ∪ 属性白名单区 */
  var WALK_SEL = [SCOPE_SEL, ATTR_SCOPE_SEL].filter(Boolean).join(',');
  var MAX_NODES = CFG.maxNodesPerPass || 20000;
  var DEBUG = !!CFG.debug;
  var LANG = CFG.lang || 'zh-CN';
  var enabled = LANG !== 'en-US';

  /* ------------------------------------------------------------------ 词典 */

  var DICT = CFG.dict || {};
  var KEEP = Object.create(null);
  (CFG.keep || []).forEach(function (k) { KEEP[k] = 1; });

  /* patterns.json 既接受数组（旧格式），也接受 { guards, patterns } */
  var patSrc = CFG.patterns || {};
  if (Array.isArray(patSrc)) patSrc = { patterns: patSrc };

  var GUARDS = [];
  (patSrc.guards || []).forEach(function (g) {
    try { GUARDS.push(new RegExp(g)); } catch (e) { /* 跳过非法正则 */ }
  });

  var PATTERNS = [];
  (patSrc.patterns || []).forEach(function (p) {
    try {
      PATTERNS.push({ re: new RegExp(p.re), zh: String(p.zh), where: p.where || 'both' });
    } catch (e) {
      warn('patterns 正则非法，已跳过: ' + p.re + ' / ' + e.message);
    }
  });

  var hasOwn = Object.prototype.hasOwnProperty;

  /* 最后一道保险：AI 正文 / URL / 报错日志 / 超长文本，一律不碰 */
  function guarded(key) {
    for (var i = 0; i < GUARDS.length; i++) {
      if (GUARDS[i].test(key)) return true;
    }
    return false;
  }

  /* kind: 'text' | 'attr' */
  function lookup(key, kind) {
    if (KEEP[key]) return null;
    if (guarded(key)) return null;

    if (hasOwn.call(DICT, key)) {
      var v = DICT[key];
      if (typeof v === 'string' && v && v !== key) return v;
    }

    for (var i = 0; i < PATTERNS.length; i++) {
      var p = PATTERNS[i];
      if (p.where !== 'both' && p.where !== kind) continue;
      var m = key.match(p.re);
      if (m) {
        return p.zh.replace(/\{(\d+)\}/g, function (_, d) {
          return m[+d] != null ? m[+d] : '';
        });
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- 工具 */

  var SRC_KEY = '__zh_src';
  var OUT_KEY = '__zh_out';
  var AOUT_PREFIX = '__zh_a_';
  var ASRC_PREFIX = '__zh_as_';

  var stats = { scanned: 0, translated: 0, passes: 0, startedAt: Date.now() };
  var errors = [];
  var observer = null;

  function norm(s) {
    return String(s).replace(/\s+/g, ' ').trim();
  }

  function warn(msg) {
    if (DEBUG) {
      try { console.warn('[zh-CN] ' + msg); } catch (e) { /* noop */ }
    }
  }

  function recordError(msg) {
    if (errors.length < 200) errors.push(String(msg));
  }

  /* ------------------------------------------------- 白名单 / 排除区判定 */

  function matches(el, sel) {
    if (!sel || !el || el.nodeType !== 1 || !el.matches) return false;
    try { return el.matches(sel); } catch (e) { return false; }
  }

  function closest(el, sel) {
    if (!sel || !el || el.nodeType !== 1 || !el.closest) return null;
    try { return el.closest(sel); } catch (e) { return null; }
  }

  function newPass() {
    return {
      scope: new WeakMap(),
      skip: new WeakMap(),
      attrScope: new WeakMap(),
      skipAttr: new WeakMap(),
      rescope: new WeakMap(),
      rescopeAttr: new WeakMap(),
      budget: { n: MAX_NODES }
    };
  }

  function inScope(pass, el) {
    if (!SCOPE_SEL) return false;
    var c = pass.scope.get(el);
    if (c === undefined) { c = !!closest(el, SCOPE_SEL); pass.scope.set(el, c); }
    return c;
  }

  function inRescope(pass, el) {
    if (!RESCOPE_SEL) return false;
    var c = pass.rescope.get(el);
    if (c === undefined) { c = !!closest(el, RESCOPE_SEL); pass.rescope.set(el, c); }
    return c;
  }

  /* 属性通道的开口子：只让 aria-* / placeholder 这类属性通过，
     不会让 inSkipText 失效，所以输入框里的文本依然不翻。 */
  function inRescopeAttr(pass, el) {
    if (!RESCOPE_ATTR_SEL) return false;
    var c = pass.rescopeAttr.get(el);
    if (c === undefined) { c = !!closest(el, RESCOPE_ATTR_SEL); pass.rescopeAttr.set(el, c); }
    return c;
  }

  function inSkipText(pass, el) {
    if (!SKIP_TEXT_SEL) return false;
    var c = pass.skip.get(el);
    if (c === undefined) { c = !!closest(el, SKIP_TEXT_SEL); pass.skip.set(el, c); }
    /* rescope：在整块受保护区里为个别 UI 子区域开口子 */
    if (c && inRescope(pass, el)) return false;
    return c;
  }

  function inAttrScope(pass, el) {
    if (!ATTR_SCOPE_SEL) return false;
    var c = pass.attrScope.get(el);
    if (c === undefined) { c = !!closest(el, ATTR_SCOPE_SEL); pass.attrScope.set(el, c); }
    return c;
  }

  function inSkipAttr(pass, el) {
    if (!SKIP_ATTR_SEL) return false;
    var c = pass.skipAttr.get(el);
    if (c === undefined) { c = !!closest(el, SKIP_ATTR_SEL); pass.skipAttr.set(el, c); }
    /* rescopeAttr：在属性受保护区里为个别 UI 子区域开口子（只放行属性） */
    if (c && inRescopeAttr(pass, el)) return false;
    return c;
  }

  /* ------------------------------------------------------ 未翻译文本收集 */

  /* 注意：NOISE 只用于【过滤候选报告】，不参与翻译决策。
     命中的文本仍然会照常走 lookup()，只是不会被记进“未翻译候选”。 */
  var NOISE = [
    /^https?:\/\//i,
    /^www\./i,
    /^[\w.+-]+@[\w-]+\.[\w.-]+$/,
    /^[A-Za-z]:[\\/]/,
    /^(?:\.{0,2}[\\/])/,
    /^[0-9a-f]{7,40}$/i,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    /^[\s\W]+$/,
    /^v?\d+(\.\d+)+/,
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,6}$/,
    /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/,
    /^[\w.-]+\/[\w.-]+$/,          /* owner/repo、a/b 这类标识 */
    /^(?:Copilot|You) said:/,
    /* 被 <span> 切碎的句子残片：小写词 / 小写词 + 尾标点。
       例如 “Track sessions, … in parallel with zero merge conflicts.”
       会被拆成 track / sessions, / parallel / zero / conflicts.
       单独翻译这些碎片必然产生病句，所以不列为候选。 */
    /^[a-z][a-z'’-]{1,14}[.,;:!?]$/,
    /^[a-z]{2,14}$/,
    /@$/,                          /* “Continue as @” 这类被截断的用户名前缀 */
    /^[a-z][a-z0-9_]{2,20}$/       /* 小写字母数字账号名（GitHub handle） */
  ];

  function isCandidate(s) {
    if (s.length < 2 || s.length > 90) return false;
    if (!/[A-Za-z]{2}/.test(s)) return false;
    if (s.indexOf('\n') !== -1) return false;
    if (s.split(/\s+/).length > 10) return false;
    for (var i = 0; i < NOISE.length; i++) {
      if (NOISE[i].test(s)) return false;
    }
    return true;
  }

  var unmatched = Object.create(null);

  function recordUnmatched(key, source, el) {
    if (!isCandidate(key)) return;
    if (guarded(key)) return;
    /* keep.json 里的品牌/模型/用户名是“刻意不翻”，不该算作未翻译候选 */
    if (KEEP[key]) return;
    var e = unmatched[key];
    if (!e) {
      e = unmatched[key] = { count: 0, sources: Object.create(null), tag: (el && el.nodeName || '').toLowerCase() };
    }
    e.count++;
    e.sources[source] = (e.sources[source] || 0) + 1;
  }

  /* ------------------------------------------------------------ 文本处理 */

  var touchedText = [];

  function processTextNode(n, pass) {
    if (!enabled) return;
    var cur = n.nodeValue;
    if (cur == null) return;

    /* 幂等：值仍是我们上次写入的 → 说明外部没动它，直接跳过（防自激循环） */
    if (cur === n[OUT_KEY]) return;

    var key = norm(cur);
    if (!key) return;

    var parent = n.parentNode;
    if (!parent || parent.nodeType !== 1) return;

    var tag = parent.nodeName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TITLE') return;

    if (inSkipText(pass, parent)) return;
    if (!inScope(pass, parent)) return;

    var zh = lookup(key, 'text');
    if (zh == null) {
      recordUnmatched(key, 'text', parent);
      return;
    }

    n[SRC_KEY] = cur;
    n[OUT_KEY] = cur.replace(key, zh);
    n.nodeValue = n[OUT_KEY];
    if (touchedText.length < 200000) touchedText.push(n);
    stats.translated++;
  }

  /* ---------------------------------------------------------- 属性处理 */

  var touchedAttr = [];

  function processAttributes(el, pass) {
    if (!enabled) return;
    if (inSkipAttr(pass, el)) return;
    if (!inAttrScope(pass, el)) return;

    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;

      var cur = el.getAttribute(a);
      if (cur == null) continue;

      var slot = AOUT_PREFIX + a;
      if (cur === el[slot]) continue;      /* 幂等 */

      var key = norm(cur);
      if (!key) continue;

      var zh = lookup(key, 'attr');
      if (zh == null) {
        recordUnmatched(key, a, el);
        continue;
      }

      if (el[ASRC_PREFIX + a] == null) el[ASRC_PREFIX + a] = cur;
      el[slot] = cur.replace(key, zh);
      try {
        el.setAttribute(a, el[slot]);
      } catch (e) {
        recordError('setAttribute(' + a + ') 失败: ' + e.message);
        continue;
      }
      if (touchedAttr.length < 200000) touchedAttr.push({ el: el, attr: a });
      stats.translated++;
    }
  }

  /* ------------------------------------------------------------ 子树遍历 */

  function walkSubtree(root, pass) {
    var stack = [root];
    while (stack.length && pass.budget.n > 0) {
      var n = stack.pop();
      pass.budget.n--;

      if (n.nodeType === 3) {
        processTextNode(n, pass);
        continue;
      }
      if (n.nodeType !== 1) continue;

      var tag = n.nodeName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;

      /* 属性先处理：属性与“正文”无关，受保护区里的 input/textarea
         的 placeholder 也是要翻译的 UI 文案 */
      processAttributes(n, pass);

      /* 文本：遇到硬排除区就停止向下遍历（整棵子树不碰） */
      if (inSkipText(pass, n)) continue;

      for (var c = n.firstChild; c; c = c.nextSibling) stack.push(c);
    }
  }

  function safeQuery(root, sel) {
    if (!sel || !root.querySelectorAll) return [];
    try { return root.querySelectorAll(sel); } catch (e) { return []; }
  }

  /* ancestor 这棵子树往下遍历时，真的能走到 el 吗？
     —— 中间只要有一层是 skipText，walkSubtree 就会停下，
        那 el 就不能算“已被 ancestor 覆盖”。 */
  function reachableFrom(ancestor, el, pass) {
    var n = el.parentElement;
    var d = 0;
    while (n && n !== ancestor && d < 200) {
      if (inSkipText(pass, n)) return false;
      n = n.parentElement;
      d++;
    }
    return n === ancestor;
  }

  function processRoot(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      processTextNode(root, newPass());
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9) return;

    var pass = newPass();
    var deepRoots = [];
    var attrRoots = [];

    function consider(el) {
      if (!el || el.nodeType !== 1) return;
      var skipT = inSkipText(pass, el);
      var skipA = inSkipAttr(pass, el);
      if (skipT && skipA) return;
      if (!skipT && matches(el, SCOPE_SEL)) { deepRoots.push(el); return; }
      if (!skipA && matches(el, ATTR_SCOPE_SEL)) attrRoots.push(el);
    }

    consider(root);

    if (WALK_SEL) {
      var inner = safeQuery(root, WALK_SEL);
      for (var i = 0; i < inner.length; i++) {
        var el = inner[i];
        var covered = false;
        for (var r = 0; r < deepRoots.length; r++) {
          var dr = deepRoots[r];
          if (dr === el || !dr.contains || !dr.contains(el)) continue;
          if (reachableFrom(dr, el, pass)) { covered = true; break; }
        }
        if (covered) continue;
        consider(el);
      }
    }

    for (var d = 0; d < deepRoots.length; d++) {
      if (pass.budget.n <= 0) {
        warn('单轮节点预算用尽，剩余部分将在下一次 Mutation 时处理');
        break;
      }
      walkSubtree(deepRoots[d], pass);
    }
    for (var a = 0; a < attrRoots.length; a++) {
      processAttributes(attrRoots[a], pass);
    }
  }

  /* ------------------------------------------------------- MutationObserver */

  var pending = new Set();
  var scheduled = false;
  var writing = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    var raf = globalThis.requestAnimationFrame;
    if (typeof raf === 'function') {
      raf(function () { scheduled = false; flush(); });
    } else {
      setTimeout(function () { scheduled = false; flush(); }, 16);
    }
  }

  function flush() {
    if (writing || !enabled) return;
    var batch = Array.from(pending);
    pending.clear();
    if (!batch.length) return;

    writing = true;
    try {
      for (var i = 0; i < batch.length; i++) {
        var node = batch[i];
        if (!node) continue;
        if (node.nodeType === 1 && node.isConnected === false) continue;
        try {
          processRoot(node);
        } catch (e) {
          recordError('processRoot 异常: ' + (e && e.message));
        }
      }
    } finally {
      writing = false;
    }
  }

  function onMutations(muts) {
    /* 我们自己写入 DOM 引发的回调，直接忽略 */
    if (writing) return;

    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];

      if (m.type === 'childList') {
        for (var a = 0; a < m.addedNodes.length; a++) pending.add(m.addedNodes[a]);
        continue;
      }
      if (m.type === 'characterData') {
        var t = m.target;
        /* 关键防循环：值等于我们上次写入的结果 → 是我们自己造成的，忽略 */
        if (t && t.nodeValue === t[OUT_KEY]) continue;
        pending.add(t);
        continue;
      }
      if (m.type === 'attributes') {
        pending.add(m.target);
        continue;
      }
    }

    if (pending.size) schedule();
  }

  /* ------------------------------------------------------------- 统计/接口 */

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS
    });
  }

  function stopObserver() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  function fullScan() {
    if (!enabled) return;
    stats.passes++;
    processRoot(document.documentElement || document.body || document);
  }

  function revert() {
    stopObserver();
    for (var i = 0; i < touchedText.length; i++) {
      var n = touchedText[i];
      if (n && n[SRC_KEY] != null) {
        try { n.nodeValue = n[SRC_KEY]; } catch (e) { /* 节点已移除 */ }
        n[OUT_KEY] = undefined;
      }
    }
    for (var j = 0; j < touchedAttr.length; j++) {
      var it = touchedAttr[j];
      var orig = it.el && it.el[ASRC_PREFIX + it.attr];
      if (it.el && orig != null) {
        try {
          it.el.setAttribute(it.attr, orig);
          it.el[AOUT_PREFIX + it.attr] = undefined;
        } catch (e) { /* noop */ }
      }
    }
    touchedText.length = 0;
    touchedAttr.length = 0;
  }

  function report() {
    var out = {};
    for (var k in unmatched) {
      if (!hasOwn.call(unmatched, k)) continue;
      var e = unmatched[k];
      out[k] = { count: e.count, tag: e.tag, sources: e.sources };
    }
    return {
      version: VERSION,
      lang: LANG,
      enabled: enabled,
      url: location.href,
      stats: { passes: stats.passes, translated: stats.translated },
      unmatched: out,
      errors: errors.slice(0, 50)
    };
  }

  /* ------------------------------------------------------------- 公开接口 */

  function enable() {
    if (enabled) { fullScan(); return report(); }
    enabled = true;
    fullScan();
    startObserver();
    return report();
  }

  function disable() {
    enabled = false;
    revert();
    return report();
  }

  globalThis.__ZH__ = {
    version: VERSION,
    lang: LANG,
    get enabled() { return enabled; },
    apply: function () { fullScan(); return report(); },
    enable: enable,
    disable: disable,
    revert: revert,
    report: report,
    stats: stats,
    _cfg: CFG
  };

  /* --------------------------------------------------------------- 启动 */

  function boot() {
    try {
      /* --lang=en-US：汉化开关关闭，不扫描、不监听、不动 DOM */
      if (!enabled) {
        if (DEBUG) console.log('[zh-CN] lang=en-US，汉化已关闭，页面保持原样。');
        return;
      }
      fullScan();
      startObserver();
      if (DEBUG) {
        console.log('[zh-CN] 已注入。lang=' + LANG + ' 词典=' + Object.keys(DICT).length + ' 条 翻译=' + stats.translated);
      }
    } catch (e) {
      recordError('boot 失败: ' + (e && e.message));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
    /* 双保险：即便 DOMContentLoaded 已错过，也在下一帧补一次 */
    setTimeout(function () {
      if (!observer) boot();
    }, 1500);
  } else {
    boot();
  }

  globalThis.addEventListener('error', function (ev) {
    recordError('页面错误: ' + (ev && ev.message));
  });

})();
