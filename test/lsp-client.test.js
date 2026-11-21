// L3 slice 2: the pure half of renderer/lsp-client.js (no Monaco, no server).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const L = require('../renderer/lsp-client.js');
const { applyTextEdits: helperApply } = require('./helpers/lsp-client.js');
const { renameRegistry } = require('./helpers/l2-registry.js');
const { start } = require('./helpers/lsp-client.js');

const ROOT = 'file:///work/reg';

function loopback() {
  const a = { subs: [] }, b = { subs: [] };
  const end = (me, other) => ({ send: m => queueMicrotask(() => other.subs.forEach(f => f(JSON.parse(JSON.stringify(m))))), subscribe: f => { me.subs.push(f); return () => { me.subs = me.subs.filter(x => x !== f); }; } });
  return [end(a, b), end(b, a)];
}

test('connection: request/response, errors, server requests, dispose', async () => {
  const [ca, cb] = loopback();
  const client = L.connection(ca), server = L.connection(cb);
  server.onRequest('echo', p => ({ got: p }));
  server.onRequest('boom', () => { throw new Error('nope'); });
  assert.deepEqual(await client.request('echo', { a: 1 }), { got: { a: 1 } });
  await assert.rejects(client.request('boom', {}), /nope/);
  await assert.rejects(client.request('unknown/method', {}), /Method not found/);
  // server -> client
  client.onRequest('mine', () => 'ok');
  assert.equal(await server.request('mine', {}), 'ok');
  assert.equal(await server.request('client/registerCapability', { registrations: [] }), null);
  assert.equal(await server.request('window/workDoneProgress/create', {}), null);
  await assert.rejects(server.request('weird/thing', {}), e => /-32601|not found/i.test(e.message));
  // the -32601 code itself, on the wire
  const sent = [];
  let feed;
  L.connection({ send: m => sent.push(m), subscribe: f => { feed = f; return () => {}; } });
  const raw = { feed: m => feed(m) };
  raw.feed({ jsonrpc: '2.0', id: 7, method: 'x/y', params: {} });
  assert.equal(sent[0].error.code, -32601);
  raw.feed({ jsonrpc: '2.0', id: 8, method: 'client/registerCapability', params: {} });
  assert.deepEqual(sent[1], { jsonrpc: '2.0', id: 8, result: null });
  // notifications
  const got = new Promise(res => client.onNotification('ping', res));
  server.notify('ping', { n: 1 });
  assert.deepEqual(await got, { n: 1 });
  // dispose rejects what is pending
  const hang = L.connection({ send: () => {}, subscribe: () => () => {} });
  const p = hang.request('never', {});
  hang.dispose();
  await assert.rejects(p, /closed/);
  await assert.rejects(hang.request('after', {}), /closed/);
});

test('uriOf / relOfUri round trip, and outside the root', () => {
  for (const rel of ['model/workspace.dsl', 'a b/c%d/e#f.yaml', 'dé/ü.yaml']) {
    const u = L.uriOf(ROOT, rel);
    assert.equal(L.relOfUri(ROOT, u), rel);
  }
  assert.equal(L.uriOf(ROOT, 'a b/c#d'), `${ROOT}/a%20b/c%23d`);
  assert.equal(L.relOfUri(ROOT, 'file:///elsewhere/x.dsl'), null);
  assert.equal(L.relOfUri(ROOT, `${ROOT}/../x`), null);
  assert.equal(L.relOfUri(ROOT, ROOT), null);
  assert.equal(L.relOfUri(ROOT + '/', `${ROOT}/m.dsl`), 'm.dsl');
});

test('modelRel: file:, code:, inmemory:', () => {
  const m = (scheme, p) => ({ uri: { scheme, path: p } });
  assert.equal(L.modelRel(m('file', '/model/work%20space.dsl')), 'model/work space.dsl');
  assert.equal(L.modelRel(m('code', '/x.cs')), null);
  assert.equal(L.modelRel(m('inmemory', '/model/1')), null);
  assert.equal(L.modelRel({}), null);
});

test('positions and ranges, including a non-BMP character', () => {
  assert.deepEqual(L.toLspPosition({ lineNumber: 1, column: 1 }), { line: 0, character: 0 });
  assert.deepEqual(L.toMonacoRange({ start: { line: 0, character: 0 }, end: { line: 2, character: 5 } }), { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 6 });
  // "😀" is two UTF-16 units: LSP character and Monaco column-1 agree on units, so the conversion is just the offset by one
  const line = 'a😀b'; assert.equal(line.length, 4);
  assert.deepEqual(L.toLspPosition({ lineNumber: 5, column: line.indexOf('b') + 1 }), { line: 4, character: 3 });
  assert.deepEqual(L.toMonacoRange({ start: { line: 4, character: 3 }, end: { line: 4, character: 4 } }), { startLineNumber: 5, startColumn: 4, endLineNumber: 5, endColumn: 5 });
});

test('toMarker: severities 1-4, code as a string, related information', () => {
  const S = { Error: 8, Warning: 4, Info: 2, Hint: 1 };
  const range = { start: { line: 9, character: 2 }, end: { line: 9, character: 7 } };
  const res = u => ({ resource: u });
  assert.deepEqual([1, 2, 3, 4].map(s => L.toMarker({ range, severity: s, message: 'm' }, S, res).severity), [8, 4, 2, 1]);
  const m = L.toMarker({ range, severity: 1, code: 12, source: 'designc', message: 'm', relatedInformation: [{ location: { uri: `${ROOT}/a.dsl`, range }, message: 'see' }] }, S, res);
  assert.equal(m.code, '12'); assert.equal(m.source, 'designc');
  assert.deepEqual([m.startLineNumber, m.startColumn, m.endLineNumber, m.endColumn], [10, 3, 10, 8]);
  assert.deepEqual(m.relatedInformation, [{ resource: { resource: `${ROOT}/a.dsl` }, message: 'see', startLineNumber: 10, startColumn: 3, endLineNumber: 10, endColumn: 8 }]);
});

test('toSuggestions: kinds by name, snippet rule, textEdit range', () => {
  const K = { Text: 0, Property: 9, EnumMember: 19 };
  const range = { start: { line: 3, character: 4 }, end: { line: 3, character: 6 } };
  const out = L.toSuggestions([
    { label: 'd.retry', kind: 10, textEdit: { range, newText: 'd.retry" "${1}"' }, insertTextFormat: 2, detail: 'x', documentation: 'doc' },
    { label: 'yes', kind: 20, textEdit: { range, newText: 'yes' } },
    { label: '?', kind: 999, insertText: 'q' }], K, 'SNIP', { fallback: true });
  assert.deepEqual(out.map(s => s.kind), [9, 19, 0]);
  assert.equal(out[0].insertTextRules, 'SNIP'); assert.equal(out[1].insertTextRules, undefined);
  assert.deepEqual(out[0].range, { startLineNumber: 4, startColumn: 5, endLineNumber: 4, endColumn: 7 });
  assert.equal(out[0].insertText, 'd.retry" "${1}"'); assert.equal(out[0].documentation, 'doc');
  assert.deepEqual(out[2].range, { fallback: true });
});

test('toMonacoHover', () => {
  const h = L.toMonacoHover({ contents: { kind: 'markdown', value: '**x**' }, range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } } });
  assert.deepEqual(h, { range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 4 }, contents: [{ value: '**x**' }] });
  assert.equal(L.toMonacoHover(null), null);
});

test('editTargets: changes vs documentChanges, create first, refusals', () => {
  const relOf = u => L.relOfUri(ROOT, u);
  const e1 = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' };
  const viaChanges = L.editTargets({ changes: { [L.uriOf(ROOT, 'a.yaml')]: [e1] } }, relOf);
  assert.deepEqual(viaChanges, [{ rel: 'a.yaml', create: false, version: null, edits: [e1] }]);
  const viaDocs = L.editTargets({ documentChanges: [
    { kind: 'create', uri: L.uriOf(ROOT, 'decisions/n.yaml'), options: {} }, { textDocument: { uri: L.uriOf(ROOT, 'decisions/n.yaml'), version: null }, edits: [e1] },
    { textDocument: { uri: L.uriOf(ROOT, 'm.dsl'), version: 4 }, edits: [e1, e1] }] }, relOf);
  assert.deepEqual(viaDocs.map(t => [t.rel, t.create, t.version, t.edits.length]), [['decisions/n.yaml', true, null, 1], ['m.dsl', false, 4, 2]]);
  assert.match(L.editTargets({ changes: { [L.uriOf(ROOT, 'handovers/h1/x.yaml')]: [e1] } }, relOf).error, /handover/);
  assert.match(L.editTargets({ changes: { 'file:///other/x.yaml': [e1] } }, relOf).error, /outside/);
});

test('applyTextEdits: same-line edits, multi-line, CRLF', () => {
  const E = (sl, sc, el, ec, t) => ({ range: { start: { line: sl, character: sc }, end: { line: el, character: ec } }, newText: t });
  assert.equal(L.applyTextEdits('abc def ghi', [E(0, 0, 0, 3, 'X'), E(0, 8, 0, 11, 'Z')]), 'X def Z');
  assert.equal(L.applyTextEdits('one\ntwo\nthree', [E(0, 1, 2, 2, '-')]), 'o-ree');
  assert.equal(L.applyTextEdits('a\r\nbb\r\nc', [E(1, 0, 1, 2, 'BB')]), 'a\r\nBB\r\nc');
  assert.equal(L.applyTextEdits('a\r\nb', [E(0, 1, 1, 0, ' ')]), 'a b');
  assert.equal(L.applyTextEdits('', [E(0, 0, 0, 0, 'hi')]), 'hi');
});

test('applyTextEdits equals the test helper on the L2 rename edit', async t => {
  const dir = renameRegistry();
  const c = start([path.join(__dirname, '..', 'lsp/server.js'), '--stdio']);
  t.after(() => c.close());
  const root = pathToFileURL(dir).href;
  await c.request('initialize', { processId: process.pid, rootUri: root, workspaceFolders: [{ uri: root, name: 'r' }], capabilities: { workspace: { workspaceEdit: { documentChanges: true } } } });
  c.notify('initialized', {});
  const W = 'model/workspace.dsl', ws = fs.readFileSync(path.join(dir, W), 'utf8').split('\n');
  const edit = await c.request('textDocument/rename', { textDocument: { uri: pathToFileURL(path.join(dir, W)).href }, position: { line: 52, character: ws[52].indexOf('"Bookings DB"') + 3 }, newName: 'Booking Store' });
  const targets = L.editTargets(edit, u => L.relOfUri(root, u));
  assert.ok(Array.isArray(targets) && targets.length >= 3);
  const mine = Object.fromEntries(targets.map(x => [x.rel, L.applyTextEdits(fs.readFileSync(path.join(dir, x.rel), 'utf8'), x.edits)]));
  helperApply(dir, edit);
  for (const [rel, text] of Object.entries(mine)) assert.equal(fs.readFileSync(path.join(dir, rel), 'utf8'), text, rel);
});
