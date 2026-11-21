// L3 slice 1: lsp/server.js over --node-ipc with stdin ignored (the way the app's main process forks it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { ipcClient } = require('./helpers/lsp-ipc.js');

const APP = path.join(__dirname, '..');

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
