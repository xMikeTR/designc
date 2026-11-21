// L2 slice 5: definition, references, prepareRename, rename and codeAction over stdio, on the slice-3 temp registry.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { start, applyTextEdits } = require('./helpers/lsp-client.js');
const Refactor = require('../renderer/refactor.js');
const { sampleCopy, renameRegistry, stateOf } = require('./helpers/l2-registry.js');

const APP = path.join(__dirname, '..');
const W = 'model/workspace.dsl';

test('LSP refactoring over stdio: definition, references, rename, code actions; the server writes nothing', async t => {
  const dir = renameRegistry();
  const abs = rel => path.join(dir, rel), uriOf = rel => pathToFileURL(abs(rel)).href;
  const snapshot = () => Object.fromEntries(['model/workspace.dsl', 'decisions/D-0001.yaml', 'decisions/accept-escalations.yaml', 'work/W-1.yaml'].map(r => [r, fs.readFileSync(abs(r), 'utf8')]));
  const before = snapshot(), beforeState = stateOf(dir);
  const c = start([path.join(APP, 'lsp/server.js'), '--stdio']);
  t.after(() => c.close());
  const init = await c.request('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).href, workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'r' }],
    capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } }, workspace: { didChangeWatchedFiles: { dynamicRegistration: true },
      workspaceEdit: { documentChanges: true, resourceOperations: ['create'], changeAnnotationSupport: { groupsOnLabel: true } } } } });
  const cap = init.capabilities;
  assert.equal(cap.definitionProvider, true); assert.equal(cap.referencesProvider, true);
  assert.deepEqual(cap.renameProvider, { prepareProvider: true });
  assert.deepEqual(cap.codeActionProvider.codeActionKinds, ['quickfix']);
  c.notify('initialized', {});
  const pos = (line, character) => ({ textDocument: { uri: uriOf(W) }, position: { line, character } });
  const ws = fs.readFileSync(abs(W), 'utf8').split('\n');
  const wsLine = ws[75], col = wsLine.indexOf('bookings');
  assert.ok(col > 0);

  const def = await c.request('textDocument/definition', pos(75, col + 1));
  assert.equal(def.uri, uriOf(W)); assert.deepEqual(def.range, { start: { line: 52, character: 6 }, end: { line: 52, character: 14 } });

  const refs = await c.request('textDocument/references', { ...pos(75, col + 1), context: { includeDeclaration: true } });
  assert.deepEqual(refs.map(r => `${path.basename(r.uri)}:${r.range.start.line + 1}:${r.range.start.character}`),
    ['workspace.dsl:53:6', 'workspace.dsl:53:27', 'workspace.dsl:76:11', 'workspace.dsl:103:19', 'D-0001.yaml:5:8', 'accept-escalations.yaml:6:8', 'accept-escalations.yaml:13:30', 'accept-escalations.yaml:13:48', 'DEMO-1234.yaml:5:11', 's1.yaml:4:10', 'W-1.yaml:3:11']);
  const noDecl = await c.request('textDocument/references', { ...pos(75, col + 1), context: { includeDeclaration: false } });
  assert.equal(noDecl.length, refs.length - 2);

  const nameCol = ws[52].indexOf('"Bookings DB"');
  const prep = await c.request('textDocument/prepareRename', pos(52, nameCol + 3));
  assert.deepEqual(prep, { range: { start: { line: 52, character: nameCol + 1 }, end: { line: 52, character: nameCol + 12 } }, placeholder: 'Bookings DB' });
  const dline = ws.findIndex(l => l.includes('"d.interaction"'));
  await assert.rejects(c.request('textDocument/prepareRename', pos(dline, ws[dline].indexOf('d.interaction') + 2)), /nothing to rename/);

  await assert.rejects(c.request('textDocument/rename', { ...pos(52, nameCol + 3), newName: 'Fares API' }), /another element is already named "Fares API"/);
  assert.deepEqual(snapshot(), before, 'the server wrote nothing');

  const nMsgs = c.seen.filter(m => m.method === 'window/showMessage').length, from = c.seen.length;
  const edit = await c.request('textDocument/rename', { ...pos(52, nameCol + 3), newName: 'Booking Store' });
  const plan = Refactor.renamePlan({ ...beforeState, at: { path: W, line0: 52, character: nameCol + 3 }, newName: 'Booking Store' });
  assert.ok(plan.rebind.length > 0);
  const msg = await c.waitFor('window/showMessage', () => true, 10000, from);
  assert.equal(msg.message, `Rename changes the fingerprint of bound decisions: ${plan.rebind.map(r => r.decision).join(', ')}. Re-bind them (Rebind all) once the rename is saved.`);
  assert.equal(msg.type, 3);
  assert.equal(c.seen.filter(m => m.method === 'window/showMessage').length, nMsgs + 1);
  assert.ok(edit.documentChanges.every(d => d.textDocument && d.edits));
  assert.ok(!JSON.stringify(edit).includes('handovers'));
  assert.deepEqual(snapshot(), before, 'rename returns an edit; it does not apply it');
  applyTextEdits(dir, edit);
  const after = stateOf(dir);
  assert.deepEqual(after.s.diags.map(d => d.code), beforeState.s.diags.map(d => d.code));
  const was = beforeState.s.gate.clauses.map(x => x.text.split('Bookings DB').join('Booking Store'));
  const added = after.s.gate.clauses.filter(x => !was.includes(x.text)).map(x => x.text).sort();
  assert.deepEqual(added, ['accept-escalations: Booking Store changed since promotion', 'fix-api: Fares API changed since promotion']);
  for (const f of ['decisions/accept-escalations.yaml', 'decisions/fix-api.yaml']) assert.deepEqual(fs.readFileSync(abs(f), 'utf8').match(/"hash":"[^"]*"/g), (before[f] || fs.readFileSync(abs(f), 'utf8')).match(/"hash":"[^"]*"/g));
});

test('LSP code actions over stdio: Set d.idempotent and Record a decision', async t => {
  const dir = renameRegistry();
  const abs = rel => path.join(dir, rel), uriOf = rel => pathToFileURL(abs(rel)).href;
  const c = start([path.join(APP, 'lsp/server.js'), '--stdio']);
  t.after(() => c.close());
  await c.request('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).href, workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'r' }],
    capabilities: { textDocument: { publishDiagnostics: {} }, workspace: { workspaceEdit: { documentChanges: true, resourceOperations: ['create'] } } } });
  c.notify('initialized', {});
  const dg = (await c.waitFor('textDocument/publishDiagnostics', p => p.uri === uriOf(W) && p.diagnostics.length > 0, 10000)).diagnostics.find(d => d.code === 'DC001');
  assert.ok(dg);
  const acts = await c.request('textDocument/codeAction', { textDocument: { uri: uriOf(W) }, range: dg.range, context: { diagnostics: [dg] } });
  const titles = acts.map(a => a.title);
  assert.deepEqual(titles, ['Set d.idempotent: yes', 'Set d.idempotent: no', 'Record a decision for DC001']);
  const set = acts[0], rec = acts[2];
  assert.equal(set.edit.documentChanges[0].textDocument.uri, uriOf(W));
  assert.equal(rec.edit.documentChanges[0].kind, 'create');
  assert.equal(rec.edit.documentChanges[0].uri, uriOf('decisions/dc001-fares-api.yaml'));
  assert.ok(!fs.existsSync(abs('decisions/dc001-fares-api.yaml')), 'the server wrote nothing');
  applyTextEdits(dir, set.edit);
  assert.ok(!stateOf(dir).s.diags.some(d => d.code === 'DC001' && d.loc.line === 82 && !d.suppressed));
  applyTextEdits(dir, rec.edit);
  assert.match(fs.readFileSync(abs('decisions/dc001-fares-api.yaml'), 'utf8'), /^id: dc001-fares-api\nstatus: minted/);
  // a client without resourceOperations gets no "Record a decision"
  const c2 = start([path.join(APP, 'lsp/server.js'), '--stdio']);
  t.after(() => c2.close());
  const dir2 = renameRegistry();
  await c2.request('initialize', { processId: process.pid, rootUri: pathToFileURL(dir2).href, workspaceFolders: [{ uri: pathToFileURL(dir2).href, name: 'r' }], capabilities: { textDocument: { publishDiagnostics: {} } } });
  c2.notify('initialized', {});
  const u2 = pathToFileURL(path.join(dir2, W)).href;
  const dg2 = (await c2.waitFor('textDocument/publishDiagnostics', p => p.uri === u2 && p.diagnostics.length > 0, 10000)).diagnostics.find(d => d.code === 'DC001');
  const a2 = await c2.request('textDocument/codeAction', { textDocument: { uri: u2 }, range: dg2.range, context: { diagnostics: [dg2] } });
  assert.deepEqual(a2.map(a => a.title), ['Set d.idempotent: yes', 'Set d.idempotent: no']);
  assert.ok(a2[0].edit.changes, 'plain changes when documentChanges is not declared');
});

test('LSP rename with nothing to re-bind sends no showMessage', async t => {
  const dir = sampleCopy();
  const c = start([path.join(APP, 'lsp/server.js'), '--stdio']);
  t.after(() => c.close());
  await c.request('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).href, workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'r' }], capabilities: { workspace: { workspaceEdit: { documentChanges: true } } } });
  c.notify('initialized', {});
  const uri = pathToFileURL(path.join(dir, W)).href;
  await c.waitFor('textDocument/publishDiagnostics', p => p.uri === uri, 10000);
  const ws = fs.readFileSync(path.join(dir, W), 'utf8').split('\n'), l = ws.findIndex(x => x.includes('"Escalation Worker"') && /^\s*\w+ = /.test(x));
  const from = c.seen.length;
  const ed = await c.request('textDocument/rename', { textDocument: { uri }, position: { line: l, character: ws[l].indexOf('"Escalation Worker"') + 3 }, newName: 'Escalation Runner' });
  assert.ok(ed.documentChanges);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(c.seen.slice(from).filter(m => m.method === 'window/showMessage').length, 0);
});
