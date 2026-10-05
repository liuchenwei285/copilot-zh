#!/usr/bin/env node
/* tools/state-probe.js —— 只读状态探针（排查用，不启动任何东西、不注入任何东西）
 *
 * 用法：node tools/state-probe.js [port]
 * 输出一行 JSON：Copilot 进程、CDP 版本、全部 target（含被过滤掉的内部页）、
 *               findTauriTarget 的判定结果、守护进程 PID 文件状态。
 *
 * 存在的理由：--start 的失败诊断里「CDP 端口不可用」这句话有歧义 ——
 * 端口没起来、和端口起来了但只有 about:blank，是完全不同的两种故障。
 */
const L = require('../zh-launcher.js');

(async () => {
  const port = Number(process.argv[2] || 9222);
  const pids = await L.listGithubProcs();
  const ver = await L.httpGetJson(port, '/json/version', 1200);
  const raw = await L.httpGetJson(port, '/json/list', 1200);
  const target = await L.findTauriTarget(port);
  const pidFile = await L.readPidFile();
  const state = L.readState();

  const out = {
    at: new Date().toISOString(),
    port,
    githubPids: pids,
    portUp: !!(ver && ver.Browser),
    browser: ver && ver.Browser ? ver.Browser : null,
    targets: Array.isArray(raw)
      ? raw.map((t) => ({ type: t.type, url: t.url, title: t.title, hasWs: !!(t.webSocketDebuggerUrl || t.ws) }))
      : null,
    chosen: target ? { url: target.url, id: target.id } : null,
    daemonPid: pidFile ? pidFile.pid : null,
    daemonState: state || null
  };
  console.log(JSON.stringify(out));
  process.exit(0);
})();
