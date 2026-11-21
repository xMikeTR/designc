// L3 slice 2: LspClient.bindMonaco with a fake Monaco, attached to the real server forked over node-ipc.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const L = require('../renderer/lsp-client.js');
const { ipcClient } = require('./helpers/lsp-ipc.js');

const APP = path.join(__dirname, '..');
const W = 'model/workspace.dsl', Y = 'requirements/DEMO-1234.yaml';
const LITERAL = [[53, 'Error', 'DC002'], [94, 'Error', 'DC004'], [82, 'Warning', 'DC001'], [63, 'Warning', 'DC003'], [33, 'Warning', 'DC005'], [94, 'Warning', 'DC006'], [94, 'Warning', 'DC008'], [94, 'Warning', 'DC011']];
const emitter = () => { const fns = new Set(); return { fire: (...a) => fns.forEach(f => f(...a)), on: f => { fns.add(f); return { dispose: () => fns.delete(f) }; } }; };

function fakeMonaco() {
  const models = new Set(), created = emitter(), disposing = emitter(), markers = new Map(), providers = {}, commands = {};
  const langOf = rel => (rel.endsWith('.dsl') ? 'structurizr' : 'yaml');
  const reg = kind => (lang, p) => { (providers[kind] = providers[kind] || {})[lang] = p; return { dispose() {} }; };
  const monaco = {
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    Uri: { parse: s => ({ scheme: 'file', path: s.replace(/^file:\/\//, ''), toString: () => s }) },
    editor: {
      getModels: () => [...models], onDidCreateModel: created.on, onWillDisposeModel: disposing.on,
      setModelMarkers: (m, owner, list) => { markers.set(`${owner}|${m.rel}`, list); },
      registerCommand: (id, fn) => { commands[id] = fn; },
    },
    languages: {
      CompletionItemKind: { Text: 0, Property: 9, EnumMember: 19 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerHoverProvider: reg('hover'), registerCompletionItemProvider: reg('completion'), registerDefinitionProvider: reg('definition'),
      registerRenameProvider: reg('rename'), registerCodeActionProvider: reg('codeAction'),
    },
  };
  function createModel(rel, text) {
    const changed = emitter(); let value = text, version = 1;
    const m = { rel, uri: { scheme: 'file', path: '/' + encodeURI(rel) }, getValue: () => value, getVersionId: () => version, getLanguageId: () => langOf(rel),
      setValue(v) { value = v; version++; changed.fire(); }, onDidChangeContent: changed.on,
      getWordUntilPosition: p => ({ startColumn: p.column, endColumn: p.column }), getValueInRange: () => '' };
    models.add(m); created.fire(m); return m;
  }
  const disposeModel = m => { disposing.fire(m); models.delete(m); };
  return { monaco, createModel, disposeModel, markers, providers, commands };
}
const until = async (fn, ms = 10000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 25)); } };

test('bindMonaco against the real server: markers, overlay, hover, completion, definition, rename, code actions, detach', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-monaco-'));
  fs.cpSync(path.join(APP, 'sample-registry'), dir, { recursive: true });
  const c = ipcClient(dir, { autoReply: false });
  t.after(() => c.kill());
  const rootUri = pathToFileURL(dir).href;
  const conn = L.connection({ send: c.send, subscribe: c.subscribe });
  const F = fakeMonaco(), applied = [], messages = [];
  const bound = L.bindMonaco(F.monaco, { onApplyEdit: async e => { applied.push(e); return { ok: true }; }, onShowMessage: (type, text) => messages.push([type, text]) });
  const text = rel => fs.readFileSync(path.join(dir, rel), 'utf8');
  const original = text(W);
  const mW = F.createModel(W, original), mY = F.createModel(Y, text(Y));
  const code = F.createModel('x.cs', 'class X {}'); code.uri.scheme = 'code';

  const init = await conn.request('initialize', L.initializeParams(rootUri, 'r'));
  conn.notify('initialized', {});
  bound.attach(conn, rootUri, init);
  const mk = () => F.markers.get(`designc-lsp|${W}`) || [];
  await until(() => mk().length === 8);
  assert.deepEqual(mk().map(m => [m.startLineNumber, m.severity === 8 ? 'Error' : 'Warning', m.code]), LITERAL);
  assert.equal(mk().filter(m => m.severity === 8).length, 2);
  assert.equal(F.markers.get(`designc-lsp|x.cs`), undefined, 'a code: buffer is not synced');

  // an unsaved edit republishes; the disk is untouched
  const lines = original.split('\n');
  assert.match(lines[99], /"d\.idempotent" "no"/);
  lines[99] = lines[99].replace('"no"', '"yes"');
  mW.setValue(lines.join('\n'));
  await until(() => mk().length === 7 && !mk().some(m => m.code === 'DC004' && m.startLineNumber === 94));
  assert.equal(text(W), original);

  // hover
  const col = lines[90].indexOf('d.idempotent') + 3;
  const hv = await F.providers.hover.structurizr.provideHover(mW, { lineNumber: 91, column: col });
  assert.match(hv.contents[0].value, /\*\*d\.idempotent\*\*/);

  // completion after "d.
  const typed = original.split('\n'); typed[99] = '"d.';
  mW.setValue(typed.join('\n'));
  const comp = await F.providers.completion.structurizr.provideCompletionItems(mW, { lineNumber: 100, column: 4 });
  const retry = comp.suggestions.find(s => s.label === 'd.retry');
  assert.ok(retry); assert.equal(retry.insertTextRules, 4); assert.equal(retry.kind, 9);
  assert.deepEqual(F.providers.completion.structurizr.triggerCharacters, ['"', '.']);
  mW.setValue(original);
  await until(() => mk().length === 8);

  // definition from YAML to the DSL
  const ycol = text(Y).split('\n')[4].indexOf('Escalation Worker') + 3;
  const def = await F.providers.definition.yaml.provideDefinition(mY, { lineNumber: 5, column: ycol });
  assert.equal(def[0].uri.toString(), `file:///${W}`);
  assert.equal(def[0].range.startLineNumber, 48);

  // rename
  const dl = lines.findIndex(l => l.includes('"d.interaction"')), dcol = lines[dl].indexOf('d.interaction') + 3;
  const rej = await F.providers.rename.structurizr.resolveRenameLocation(mW, { lineNumber: dl + 1, column: dcol });
  assert.match(rej.rejectReason, /nothing to rename/);
  const bcol = lines[52].indexOf('"Bookings DB"') + 4;
  const loc = await F.providers.rename.structurizr.resolveRenameLocation(mW, { lineNumber: 53, column: bcol });
  assert.equal(loc.text, 'Bookings DB'); assert.equal(loc.rejectReason, undefined);
  const re = await F.providers.rename.structurizr.provideRenameEdits(mW, { lineNumber: 53, column: bcol }, 'Booking Store');
  assert.deepEqual(re, { edits: [] });
  assert.equal(applied.length, 1);
  const tg = L.editTargets(applied[0], u => L.relOfUri(rootUri, u));
  assert.deepEqual(tg.map(x => x.rel).sort(), [W, 'decisions/D-0001.yaml', Y].sort());
  assert.deepEqual(messages, [], 'D-0001 is minted, so nothing to re-bind');
  assert.equal(text(W), original, 'the app, not the binding, applies the edit');

  // code actions on DC001 :82
  const acts = await F.providers.codeAction.structurizr.provideCodeActions(mW, { startLineNumber: 82, endLineNumber: 82, startColumn: 1, endColumn: 1 }, {});
  const set = acts.actions.find(a => a.title === 'Set d.idempotent: yes');
  assert.ok(set); assert.equal(set.command.id, 'designc.lsp.applyEdit');
  await F.commands['designc.lsp.applyEdit'](null, set.command.arguments[0]);
  assert.equal(applied.length, 2);

  // detach clears the markers and silences providers
  bound.detach();
  assert.equal(mk().length, 0);
  assert.equal(await F.providers.hover.structurizr.provideHover(mW, { lineNumber: 91, column: col }), null);
  assert.deepEqual((await F.providers.completion.structurizr.provideCompletionItems(mW, { lineNumber: 100, column: 4 })).suggestions, []);
  conn.dispose();
});
