#!/usr/bin/env node
/* =============================================================================
 * verify.js —— 词典与选择器静态校验
 * -----------------------------------------------------------------------------
 * 用法： node tools/verify.js
 * 退出码：0 = 无错误；1 = 有错误（警告不影响退出码）
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let ERRORS = 0, WARNS = 0;

const c = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', off: '\x1b[0m' };

function err(msg) { ERRORS++; console.log(c.red + '  ERROR  ' + c.off + msg); }
function warn(msg) { WARNS++; console.log(c.yellow + '  WARN   ' + c.off + msg); }
function info(msg) { console.log(c.dim + '  info   ' + msg + c.off); }

function readJson(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return { raw, obj: JSON.parse(raw) };
}

/* ------------------------------------------------------------ 重复键检测 --- */

function findDuplicateKeys(raw) {
  const re = /^\s*"((?:[^"\\]|\\.)*)"\s*:/gm;
  const seen = new Set();
  const dups = [];
  let m;
  while ((m = re.exec(raw))) {
    const k = m[1];
    if (seen.has(k)) dups.push(k); else seen.add(k);
  }
  return { count: seen.size, dups };
}

/* ------------------------------------------------------------------ 主流程 --- */

console.log('\n=== copilot-zh 静态校验 ===\n');

/* ---- 1. zh-CN.json ---- */
const dictPath = path.join(ROOT, 'zh-CN.json');
if (!fs.existsSync(dictPath)) {
  err('找不到 zh-CN.json');
  process.exit(1);
}
const { raw: dictRaw, obj: dict } = readJson(dictPath);
const { count: dictCount, dups } = findDuplicateKeys(dictRaw);

console.log(`[1] zh-CN.json —— ${dictCount} 条词条`);
if (dups.length) err('存在重复键：' + dups.join(' | '));
else info('无重复键');

for (const [k, v] of Object.entries(dict)) {
  if (typeof v !== 'string') { err(`词条 "${k}" 的值不是字符串`); continue; }
  if (!v.trim()) err(`词条 "${k}" 的译文为空`);
  if (v === k) warn(`词条 "${k}" 的译文与原文相同（可考虑删除）`);
  if (k.trim() !== k) warn(`词条键 "${k}" 首尾有空白`);
  if (/\s{2,}/.test(k)) warn(`词条键 "${k}" 含连续空格（运行时已归一化，通常无需修改）`);
  if (/^\d/.test(k)) warn(`词条键 "${k}" 以数字开头，容易误匹配`);
  /* 中文长度膨胀：中文通常比英文短，超过 2 倍才提示 */
  if (v.length > k.length * 2 + 6) warn(`"${k}" → "${v}" 译文明显偏长，可能造成布局溢出`);
  if (/[\u4e00-\u9fa5]/.test(k)) err(`词条键 "${k}" 已含中文，词典应只放英文原文`);
}

/* ---- 2. keep.json ---- */
console.log('\n[2] keep.json');
const keepPath = path.join(ROOT, 'keep.json');
const keep = fs.existsSync(keepPath) ? readJson(keepPath).obj : [];
if (!Array.isArray(keep)) err('keep.json 必须是字符串数组');
else {
  info(`${keep.length} 条永不翻译项`);
  const conflict = keep.filter((k) => Object.prototype.hasOwnProperty.call(dict, k));
  if (conflict.length) {
    warn('以下词条同时出现在 keep.json 与 zh-CN.json，运行时 keep 优先、不会被翻译：\n         ' + conflict.join(' | '));
  }
  const dup = keep.filter((k, i) => keep.indexOf(k) !== i);
  if (dup.length) warn('keep.json 有重复项：' + [...new Set(dup)].join(' | '));
}

/* ---- 3. patterns.json ---- */

/* 取出正则里所有【捕获组】的组体（跳过转义、字符类、非捕获组/环视） */
function captureBodies(re) {
  const bodies = [];
  let i = 0;
  while (i < re.length) {
    const ch = re[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '[') {
      i++;
      while (i < re.length && re[i] !== ']') { if (re[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (ch === '(') {
      if (re[i + 1] === '?') { i += 2; continue; }   /* (?: (?= (?! (?<= (?<! */
      let depth = 1, j = i + 1;
      while (j < re.length && depth > 0) {
        const c2 = re[j];
        if (c2 === '\\') { j += 2; continue; }
        if (c2 === '[') {
          j++;
          while (j < re.length && re[j] !== ']') { if (re[j] === '\\') j++; j++; }
          j++;
          continue;
        }
        if (c2 === '(') depth++;
        else if (c2 === ')') depth--;
        if (depth === 0) break;
        j++;
      }
      bodies.push(re.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    i++;
  }
  return bodies;
}

/* 组体是否可能匹配任意自由文本（区别于纯数字/纯空白） */
function groupIsFreeText(body) {
  const b = body
    .replace(/\\d/g, '')
    .replace(/\\s/g, '')
    .replace(/[+*?]/g, '')
    .replace(/\{\d+(?:,\d*)?\}/g, '');
  if (b === '') return false;
  return /[.A-Za-z]|\[/.test(b) || /\\[wS]/.test(body);
}

console.log('\n[3] runtime/patterns.json');
const patPath = path.join(ROOT, 'runtime', 'patterns.json');
const WHERE_OK = ['text', 'attr', 'both'];
if (!fs.existsSync(patPath)) warn('找不到 runtime/patterns.json');
else {
  const patFile = readJson(patPath).obj;
  /* 兼容两种形态：旧版数组 / 新版 { guards, patterns } */
  const pats = Array.isArray(patFile) ? patFile : (patFile.patterns || []);
  const guards = Array.isArray(patFile) ? [] : (patFile.guards || []);

  if (!Array.isArray(pats)) err('patterns 必须是数组');
  else {
    info(`${pats.length} 条模板，${guards.length} 条 guard`);
    pats.forEach((p, i) => {
      if (!p || typeof p.re !== 'string' || typeof p.zh !== 'string') { err(`第 ${i} 条格式不正确，需要 { re, zh }`); return; }
      if (p.where != null && !WHERE_OK.includes(p.where)) err(`第 ${i} 条 where 非法：${p.where}（只能是 ${WHERE_OK.join('/')}）`);
      let re;
      try { re = new RegExp(p.re); } catch (e) { err(`第 ${i} 条正则非法：${p.re} —— ${e.message}`); return; }
      const groups = new RegExp(re.source + '|').exec('').length - 1;
      const refs = [...p.zh.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
      refs.forEach((r) => {
        if (r < 1 || r > groups) err(`第 ${i} 条模板 "${p.zh}" 引用了不存在的分组 {${r}}（该正则共 ${groups} 个分组）`);
      });
      /* 带自由文本捕获组的模板必须限定 where='attr'，或用 allowFreeText 显式放行 */
      const free = captureBodies(p.re).some(groupIsFreeText);
      if (free && p.where !== 'attr' && p.allowFreeText !== true) {
        err(`第 ${i} 条含自由文本捕获组却未限定 where='attr'，也未声明 allowFreeText，有误伤正文的风险：${p.re}`);
      }
      if (free && p.allowFreeText === true && typeof p.note !== 'string') {
        warn(`第 ${i} 条使用了 allowFreeText 但没写 note 说明理由：${p.re}`);
      }
      if (!/^\^/.test(p.re) || !/\$$/.test(p.re)) {
        warn(`第 ${i} 条正则未做首尾锚定，建议加 ^...$：${p.re}`);
      }
    });
    guards.forEach((g, i) => {
      try { new RegExp(g); } catch (e) { err(`第 ${i} 条 guard 正则非法：${g} —— ${e.message}`); }
    });
    const need = ['^(?:Copilot|You) said:', '^https?://'];
    need.forEach((n) => {
      if (!guards.includes(n)) warn(`guards 缺少推荐项：${n}`);
    });
  }
}

/* ---- 4. selectors.json ---- */
console.log('\n[4] runtime/selectors.json');
const selPath = path.join(ROOT, 'runtime', 'selectors.json');
let SEL = null;
if (!fs.existsSync(selPath)) err('找不到 runtime/selectors.json');
else {
  const sel = readJson(selPath).obj;
  SEL = sel;
  const lists = ['scopes', 'skipText', 'rescope', 'rescopeAttr', 'attrScopes', 'skipAttr', 'attributes'];
  lists.forEach((k) => {
    if (!Array.isArray(sel[k])) err(`selectors.json 缺少数组字段 ${k}`);
    else if (!sel[k].length) warn(`selectors.json 的 ${k} 为空`);
  });
  info(`scopes=${(sel.scopes || []).length} skipText=${(sel.skipText || []).length} rescope=${(sel.rescope || []).length} rescopeAttr=${(sel.rescopeAttr || []).length} attrScopes=${(sel.attrScopes || []).length} skipAttr=${(sel.skipAttr || []).length}`);

  /* 基本语法体检：括号/引号成对 */
  (sel.scopes || []).concat(sel.skipText || [], sel.rescope || [], sel.rescopeAttr || [],
    sel.attrScopes || [], sel.skipAttr || []).forEach((s) => {
    if (typeof s !== 'string') { err('选择器必须是字符串：' + JSON.stringify(s)); return; }
    const open = (s.match(/\[/g) || []).length, close = (s.match(/\]/g) || []).length;
    if (open !== close) err(`选择器括号不匹配：${s}`);
    if (/[^\w\s\-.#*=\[\]'"(),:>~+|^$!]/.test(s)) warn(`选择器含可疑字符：${s}`);
  });

  /* 冲突提示：同一个选择器同时出现在 scopes 与 skipText */
  const both = (sel.scopes || []).filter((s) => (sel.skipText || []).includes(s));
  if (both.length) warn('以下选择器同时在 scopes 与 skipText 中（skipText 优先）：' + both.join(' | '));

  /* rescope 与 skipAttr 互斥：rescope 目标若在 skipAttr 里，属性仍然翻不了 */
  const clash = (sel.rescope || []).filter((s) => (sel.skipAttr || []).includes(s));
  if (clash.length) err('以下选择器同时在 rescope 与 skipAttr 中，rescope 会失效：' + clash.join(' | '));

  /* rescopeAttr 语义：只开【属性】通道，绝不开【文本】通道。
     若同一个选择器同时出现在 rescope 与 rescopeAttr，属性开口子就会顺带
     打开文本通道 —— 对自带 .prose 的输入框来说，等于用户输入会被翻译。 */
  const overlap = (sel.rescope || []).filter((s) => (sel.rescopeAttr || []).includes(s));
  if (overlap.length) err('rescope 与 rescopeAttr 出现相同选择器，会让「只开属性」失效：' + overlap.join(' | '));

  /* rescopeAttr 不允许过宽：否则等于把 skipAttr 整块拆掉 */
  const bannedSel = ['*', 'div', 'span', 'body', 'html', '[class]', '[id]', '[class*=\'prose\' i]', '[class*=\'markdown\' i]'];
  const badRA = (sel.rescopeAttr || []).filter((s) => bannedSel.includes(s));
  if (badRA.length) err('rescopeAttr 含过宽选择器，会拆掉正文属性保护：' + badRA.join(' | '));
  else if ((sel.rescopeAttr || []).length) info('rescopeAttr 未出现通配/过宽选择器');
}

/* ---- 5. 安全断言：聊天正文必须被硬排除 ---- */
console.log('\n[5] 安全断言（对话正文 / 用户输入 / 代码）');
if (SEL) {
  const skip = SEL.skipText || [];
  const mustSkip = [
    '[data-testid=\'conversation-message-row\']',
    '[data-testid=\'user-message-bubble\']',
    '[data-testid=\'conversation-recent-activity\']',
    '[data-testid=\'system-error-row\']',
    '[class*=\'prose\' i]',
    '[contenteditable]',
    'pre',
    'code'
  ];
  const miss = mustSkip.filter((s) => !skip.includes(s));
  if (miss.length) err('skipText 缺少关键保护项：' + miss.join(' | '));
  else info('聊天正文 / 用户气泡 / 输入框 / 代码块的硬排除齐备');

  const attrSkip = SEL.skipAttr || [];
  const mustSkipAttr = ['[class*=\'prose\' i]', '[data-testid=\'user-message-bubble\']'];
  const missA = mustSkipAttr.filter((s) => !attrSkip.includes(s));
  if (missA.length) err('skipAttr 缺少关键保护项：' + missA.join(' | '));
  else info('正文容器内的属性也被保护');

  /* scopes 里不允许出现会吞掉整棵文档的裸选择器 */
  const banned = ['*', 'div', 'span', 'body', 'html', '[class]', '[id]'];
  const bad = (SEL.scopes || []).filter((s) => banned.includes(s));
  if (bad.length) err('scopes 含过宽选择器，会吞掉整棵 DOM：' + bad.join(' | '));
  else info('scopes 未出现通配/过宽选择器');

  /* rescopeAttr 只开属性通道的前提：对应元素的【文本】通道必须仍然关闭。
     真实 DOM 里输入框本体是 div[role=textbox][contenteditable].prose，
     这三者必须在 skipText 里，否则放开 aria-placeholder 会连带翻掉用户输入。 */
  if ((SEL.rescopeAttr || []).length) {
    const mustStaySkipped = ['[role=\'textbox\']', '[contenteditable]', '[class*=\'prose\' i]'];
    const lost = mustStaySkipped.filter((s) => !skip.includes(s));
    if (lost.length) err('rescopeAttr 开口子后，输入框文本通道保护项缺失：' + lost.join(' | '));
    else info('输入框属性开口子后，其文本通道保护项（textbox/contenteditable/prose）仍然齐备');
  }
}

/* ---- 6. 与 Copilot 相关的关键术语是否齐备 ---- */
console.log('\n[6] 关键术语覆盖检查');
const must = ['New', 'Pull requests', 'Issues', 'Automations', 'Customize', 'More', 'Projects', 'Chats',
  'Ask anything or paste a URL...', 'Interactive', 'Efficiency', 'Balance', 'Intelligence'];
const missing = must.filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
if (missing.length) err('缺少必需术语：' + missing.join(' | '));
else info('需求中列出的 12 条核心术语齐备');

/* ---- 汇总 ---- */
console.log('\n============================================================');
if (ERRORS === 0) console.log(c.green + ` 校验通过（${WARNS} 条警告）` + c.off);
else console.log(c.red + ` 校验失败：${ERRORS} 个错误，${WARNS} 条警告` + c.off);
console.log('============================================================\n');

process.exitCode = ERRORS ? 1 : 0;
