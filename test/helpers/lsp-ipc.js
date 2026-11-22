// A minimal LSP client over a forked child's Node IPC channel (what the app's main process does). Test-only.
const path = require('path');
const { fork } = require('child_process');

function ipcClient(dir, { autoReply = true } = {}) {
  const child = fork(path.join(__dirname, '..', '..', 'lsp/server.js'), ['--node-ipc', '--registry', dir], { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', () => {});
  const seen = [], waiters = [], pending = new Map(); let id = 0;
  const subs = new Set();
  child.on('message', m => {
    for (const f of subs) f(m);
    if (m.id !== undefined && !m.method && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (autoReply && m.id !== undefined && m.method) child.send({ jsonrpc: '2.0', id: m.id, result: null });
    seen.push(m); for (const w of [...waiters]) w();
  });
  const exited = new Promise(res => child.on('exit', (code, sig) => res({ code, sig })));
  return {
    child, exited, seen,
    subscribe: f => { subs.add(f); return () => subs.delete(f); },
    send: m => child.send(m),
    request: (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); child.send({ jsonrpc: '2.0', id: i, method, params }); }),
    notify: (method, params) => child.send({ jsonrpc: '2.0', method, params }),
    waitFor: (method, pred = () => true, ms = 10000) => new Promise((resolve, reject) => {
      const t = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); reject(new Error(`timeout waiting for ${method}`)); }, ms);
      const check = () => { const m = seen.find(x => x.method === method && pred(x.params)); if (m) { clearTimeout(t); waiters.splice(waiters.indexOf(check), 1); resolve(m.params); } };
      waiters.push(check); check();
    }),
    kill: () => child.kill(),
  };
}
module.exports = { ipcClient };
