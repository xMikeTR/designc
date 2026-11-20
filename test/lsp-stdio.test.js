// L1 slice 4: lsp/server.js over stdio, on a temp copy of sample-registry.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { start } = require('./helpers/lsp-client.js');

const APP = path.join(__dirname, '..');
const W = 'model/workspace.dsl';

test('the language server over stdio: diagnostics, overlay, hover, completion, disk changes, shutdown', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-lsp-'));
  fs.cpSync(path.join(APP, 'sample-registry'), dir, { recursive: true });
  const abs = rel => path.join(dir, rel), uriOf = rel => pathToFileURL(abs(rel)).href;
  const original = fs.readFileSync(abs(W), 'utf8');
  const c = start([path.join(APP, 'lsp/server.js'), '--stdio']);
  t.after(() => c.close());
  const next = (rel, from) => c.waitFor('textDocument/publishDiagnostics', p => p.uri === uriOf(rel), 10000, from).then(p => p.diagnostics);

  const init = await c.request('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).href, workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'r' }],
    capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } }, workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } } });
  assert.ok(init.capabilities.hoverProvider);
  assert.deepEqual(init.capabilities.completionProvider.triggerCharacters, ['"', '.']);
  assert.equal(init.capabilities.textDocumentSync.change, 2);
  c.notify('initialized', {});

  // eager first publish, nothing opened
  let ds = await next(W, 0);
  assert.equal(ds.length, 8);
  assert.equal(ds.filter(d => d.severity === 1).length, 2);
  assert.equal(ds.filter(d => d.severity === 2).length, 6);
  assert.ok(ds.find(d => d.code === 'DC002').relatedInformation.length === 2);

  // didOpen + the unsaved edit
  c.notify('textDocument/didOpen', { textDocument: { uri: uriOf(W), languageId: 'plaintext', version: 1, text: original } });
  const line = original.split('\n')[99];
  assert.match(line, /"d\.idempotent" "no"/);
  let mark = c.seen.length;
  c.notify('textDocument/didChange', { textDocument: { uri: uriOf(W), version: 2 }, contentChanges: [{ range: { start: { line: 99, character: line.indexOf('"no"') }, end: { line: 99, character: line.indexOf('"no"') + 4 } }, text: '"yes"' }] });
  ds = await c.waitFor('textDocument/publishDiagnostics', p => p.uri === uriOf(W) && !p.diagnostics.some(d => d.code === 'DC004'), 10000, mark).then(p => p.diagnostics);
  assert.equal(ds.length, 7);
  assert.equal(fs.readFileSync(abs(W), 'utf8'), original, 'the file on disk is untouched');

  // hover and completion on the open buffer
  const hv = await c.request('textDocument/hover', { textDocument: { uri: uriOf(W) }, position: { line: 90, character: 14 } });
  assert.match(hv.contents.value, /\*\*d\.idempotent\*\*/);
  const hover = await c.request('textDocument/hover', { textDocument: { uri: uriOf(W) }, position: { line: 99, character: line.indexOf('d.idempotent') + 2 } });
  assert.match(hover.contents.value, /\*\*d\.idempotent\*\*/);

  // completion right after "d.
  mark = c.seen.length;
  c.notify('textDocument/didChange', { textDocument: { uri: uriOf(W), version: 3 }, contentChanges: [{ text: original.replace('"d.idempotent" "no"', '"d.') }] });
  const items = await c.request('textDocument/completion', { textDocument: { uri: uriOf(W) }, position: { line: 99, character: line.indexOf('"') + 3 } });
  const retry = (Array.isArray(items) ? items : items.items).find(i => i.label === 'd.retry');
  assert.ok(retry); assert.equal(retry.insertTextFormat, 2);

  // a syntax break gives a parse Error, then didClose gives the disk (8)
  mark = c.seen.length;
  c.notify('textDocument/didChange', { textDocument: { uri: uriOf(W), version: 4 }, contentChanges: [{ text: original + '\n}}}}\n' }] });
  ds = await c.waitFor('textDocument/publishDiagnostics', p => p.uri === uriOf(W) && p.diagnostics.some(d => d.code === 'parse' && d.severity === 1), 10000, mark).then(p => p.diagnostics);
  assert.ok(ds.length >= 1);
  mark = c.seen.length;
  c.notify('textDocument/didClose', { textDocument: { uri: uriOf(W) } });
  ds = await c.waitFor('textDocument/publishDiagnostics', p => p.uri === uriOf(W) && p.diagnostics.length === 8, 10000, mark).then(p => p.diagnostics);
  assert.equal(ds.length, 8);

  // a decisions file made invalid on disk, then a save notification
  fs.mkdirSync(abs('decisions'), { recursive: true });
  fs.writeFileSync(abs('decisions/broken.yaml'), 'id: broken\n  oops: [unclosed\n');
  mark = c.seen.length;
  c.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uriOf('decisions/broken.yaml'), type: 1 }] });
  ds = await c.waitFor('textDocument/publishDiagnostics', p => p.uri === uriOf('decisions/broken.yaml') && p.diagnostics.length > 0, 10000, mark).then(p => p.diagnostics);
  assert.equal(ds[0].code, 'yaml'); assert.equal(ds[0].severity, 1);

  // shutdown, exit
  await c.request('shutdown', null);
  const t0 = Date.now();
  c.notify('exit', null);
  const { code } = await Promise.race([c.exited, new Promise((_, rej) => setTimeout(() => rej(new Error('did not exit in 2s')), 2000))]);
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 2000);
});
