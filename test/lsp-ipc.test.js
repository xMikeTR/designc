// L3 slice 1: lsp/server.js over --node-ipc with stdin ignored (the way the app's main process forks it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { pathToFileURL } = require('url');

const APP = path.join(__dirname, '..');

function ipcClient(dir) {
  const child = fork(path.join(APP, 'lsp/server.js'), ['--node-ipc', '--registry', dir], { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', () => {});
  const seen = [], waiters = [], pending = new Map(); let id = 0;
  child.on('message', m => {
    if (m.id !== undefined && !m.method && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.id !== undefined && m.method) child.send({ jsonrpc: '2.0', id: m.id, result: null });
    seen.push(m); for (const w of [...waiters]) w();
  });
  const exited = new Promise(res => child.on('exit', (code, sig) => res({ code, sig })));
  return {
    child, exited,
    request: (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); child.send({ jsonrpc: '2.0', id: i, method, params }); }),
    notify: (method, params) => child.send({ jsonrpc: '2.0', method, params }),
    waitFor: (method, pred = () => true, ms = 10000) => new Promise((resolve, reject) => {
      const t = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); reject(new Error(`timeout waiting for ${method}`)); }, ms);
      const check = () => { const m = seen.find(x => x.method === method && pred(x.params)); if (m) { clearTimeout(t); waiters.splice(waiters.indexOf(check), 1); resolve(m.params); } };
      waiters.push(check); check();
    }),
  };
}

test('server over node-ipc: diagnostics, survives ignored stdin, exits on disconnect', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-ipc-'));
  fs.cpSync(path.join(APP, 'sample-registry'), dir, { recursive: true });
  const c = ipcClient(dir);
  t.after(() => c.child.kill());
  const root = pathToFileURL(dir).href;
  const init = await c.request('initialize', { processId: null, rootUri: root, workspaceFolders: [{ uri: root, name: 'r' }], capabilities: {} });
  assert.ok(init.result.capabilities.hoverProvider);
  c.notify('initialized', {});
  const pub = await c.waitFor('textDocument/publishDiagnostics', p => p.uri === pathToFileURL(path.join(dir, 'model/workspace.dsl')).href && p.diagnostics.length > 0);
  assert.equal(pub.diagnostics.length, 8);
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(c.child.exitCode, null, 'still alive with stdin ignored');
  c.child.disconnect();
  const r = await Promise.race([c.exited, new Promise(res => setTimeout(() => res('timeout'), 2000))]);
  assert.notEqual(r, 'timeout');
  assert.equal(r.code, 0);
});
