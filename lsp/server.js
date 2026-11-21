#!/usr/bin/env node
/* designc language server: transport only. `node lsp/server.js --stdio [--registry <dir>]`.
   Read-only: it never writes the registry, never records a gate event, never opens .designc/index.sqlite.
   The pure half is lsp/providers.js; the findings are headless checkState + renderer/problems.js, with unsaved buffers as an overlay. */
'use strict';
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind, DidChangeWatchedFilesNotification, ResponseError, LSPErrorCodes } = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const Headless = require('../headless/index.js');
const Problems = require('../renderer/problems.js');
const Core = require('../renderer/core.js');
const Refactor = require('../renderer/refactor.js');
const DslAssist = require('../renderer/dsl-assist.js');
const Vocabulary = require('../renderer/canvas/vocabulary.js');
const P = require('./providers.js');

const argv = process.argv.slice(2);
const ri = argv.indexOf('--registry');
const cliRegistry = ri >= 0 && argv[ri + 1] ? path.resolve(argv[ri + 1]) : null;
const envRegistry = process.env.DESIGNC_REGISTRY ? path.resolve(process.env.DESIGNC_REGISTRY) : null;
const PROPS = DslAssist.props(Vocabulary), PROP = DslAssist.byKey(PROPS);

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const roots = new Map(); // root -> {timer, published: Set<uri>}
let folders = [], initRegistry = null, related = false, watch = false, docChanges = false, canCreate = false;
const exists = p => fs.existsSync(p);
const fsPathOf = uri => { try { return fileURLToPath(uri); } catch { return null; } };
const isDsl = uri => /\.dsl$/i.test(uri);
const log = m => connection.console.log(String(m));

connection.onInitialize(params => {
  folders = (params.workspaceFolders || (params.rootUri ? [{ uri: params.rootUri }] : [])).map(f => fsPathOf(f.uri)).filter(Boolean);
  const io = params.initializationOptions;
  if (io && typeof io.registry === 'string') initRegistry = path.resolve(io.registry);
  const td = params.capabilities && params.capabilities.textDocument, ws = params.capabilities && params.capabilities.workspace;
  related = !!(td && td.publishDiagnostics && td.publishDiagnostics.relatedInformation);
  watch = !!(ws && ws.didChangeWatchedFiles && ws.didChangeWatchedFiles.dynamicRegistration);
  docChanges = !!(ws && ws.workspaceEdit && ws.workspaceEdit.documentChanges);
  canCreate = docChanges && ((ws.workspaceEdit.resourceOperations) || []).includes('create');
  return { capabilities: {
    textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: { includeText: false } },
    hoverProvider: true,
    completionProvider: { triggerCharacters: ['"', '.'] },
    definitionProvider: true,
    referencesProvider: true,
    renameProvider: { prepareProvider: true },
    codeActionProvider: { codeActionKinds: ['quickfix'] },
  } };
});

const explicit = () => [cliRegistry, envRegistry, initRegistry];
const rootOf = uri => { const p = fsPathOf(uri); return p ? P.rootFor(p, { exists, fallback: { explicit: explicit(), folders } }) : null; };
const entry = root => { let e = roots.get(root); if (!e) roots.set(root, e = { timer: null, published: new Set() }); return e; };

function recompute(root) {
  const e = entry(root);
  try {
    const overlay = {};
    for (const d of documents.all()) { const rel = P.relOf(root, d.uri); if (rel) overlay[rel] = d.getText(); }
    const s = Headless.checkState(root, { overlay });
    let next = new Map();
    if (s.error) log(s.error);
    else {
      const groups = Problems.rows({ model: s.model, diags: s.diags, cfgModel: s.cfg.model, decisions: s.assembled.gateInputs.decisions, yamlErrors: s.assembled.yamlErrors, ledgerErrors: s.assembled.ledgerErrors, proposals: s.assembled.proposals });
      const textOf = rel => (rel in overlay ? overlay[rel] : s.files[rel] != null ? s.files[rel] : readDisk(root, rel));
      next = P.toDiagnostics(groups, { root, textOf, cfgModel: s.cfg.model, related });
    }
    for (const [uri, diagnostics] of P.withClears(next, e.published)) connection.sendDiagnostics({ uri, diagnostics });
    e.published = new Set(next.keys());
  } catch (err) { log(`designc lsp: ${err && err.stack || err}`); }
}
const readDisk = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };
function schedule(root, ms = 200) {
  const e = entry(root);
  clearTimeout(e.timer);
  e.timer = setTimeout(() => { e.timer = null; recompute(root); }, ms);
}

connection.onInitialized(() => {
  const set = new Set([...folders.filter(f => P.isRegistry(f, exists)), ...explicit().filter(Boolean)]);
  for (const r of set) schedule(r, 0);
  if (watch) connection.client.register(DidChangeWatchedFilesNotification.type, { watchers: [{ globPattern: '**/*.{dsl,yaml,yml,jsonl,json}' }] }).catch(e => log(e));
});

const touch = uri => { const r = rootOf(uri); if (r) schedule(r); };
documents.onDidOpen(e => touch(e.document.uri));
documents.onDidChangeContent(e => touch(e.document.uri));
documents.onDidSave(e => touch(e.document.uri));
documents.onDidClose(e => touch(e.document.uri));
connection.onDidChangeWatchedFiles(({ changes }) => {
  const hit = new Set();
  for (const c of changes) { const r = rootOf(c.uri); if (r) hit.add(r); }
  for (const r of hit) schedule(r);
});

const lineOf = (uri, line) => { const d = documents.get(uri); return d && isDsl(uri) ? d.getText({ start: { line, character: 0 }, end: { line, character: 1e6 } }).replace(/\r?\n$/, '') : null; };
connection.onHover(({ textDocument, position }) => {
  const t = lineOf(textDocument.uri, position.line);
  return t == null ? null : P.toHover(DslAssist.hoverAt(t, position.character, PROP), position.line);
});
connection.onCompletion(({ textDocument, position }) => {
  const t = lineOf(textDocument.uri, position.line);
  return t == null ? null : P.toCompletion(DslAssist.completeAt(t, position.character, PROP, PROPS), position.line);
});

// ---- L2: definition, references, rename, code actions. Read-only: every change is a WorkspaceEdit the client applies.
const failed = msg => new ResponseError(LSPErrorCodes.RequestFailed, msg);
function stateFor(uri) {
  const root = rootOf(uri), rel = root && P.relOf(root, uri);
  if (!rel) return null;
  const overlay = {}, versions = {};
  for (const d of documents.all()) { const r = P.relOf(root, d.uri); if (r) { overlay[r] = d.getText(); versions[d.uri] = d.version; } }
  const s = Headless.checkState(root, { overlay });
  if (s.error) return null;
  return { root, rel, s, versions, state: { files: s.files, cfgModel: s.cfg.model, model: s.model } };
}
const guarded = fn => (...a) => { try { return fn(...a); } catch (err) { log(`designc lsp: ${err && err.stack || err}`); return null; } };
connection.onDefinition(guarded(({ textDocument, position }) => {
  const st = stateFor(textDocument.uri); if (!st) return null;
  const d = Refactor.definition(st.state, Refactor.symbolAt(st.state, st.rel, position.line, position.character));
  return d ? P.toLocation(st.root, d) : null;
}));
connection.onReferences(guarded(({ textDocument, position, context }) => {
  const st = stateFor(textDocument.uri); if (!st) return null;
  const sym = Refactor.symbolAt(st.state, st.rel, position.line, position.character);
  if (!sym || !sym.element) return null;
  return Refactor.references(st.state, sym.element.id, { includeDeclaration: !!(context && context.includeDeclaration) }).map(r => P.toLocation(st.root, r));
}));
connection.onPrepareRename(({ textDocument, position }) => {
  const st = stateFor(textDocument.uri); if (!st) return null;
  const sym = Refactor.symbolAt(st.state, st.rel, position.line, position.character);
  if (!sym || !sym.element) throw failed('nothing to rename here: put the cursor on an element identifier or name');
  const from = sym.kind === 'ident' ? sym.element.ident : sym.element.name;
  const plan = Refactor.renamePlan({ ...st.state, at: { path: st.rel, line0: position.line, character: position.character }, newName: from || '' });
  if (plan.error) throw failed(plan.error);
  const at = /\.dsl$/.test(st.rel) && sym.kind === 'name' && sym.role === 'def' ? { ...sym.at, c: sym.at.c + 1, n: sym.at.n - 2 } : sym.at;
  return { range: P.rangeFromPos(at), placeholder: from };
});
connection.onRenameRequest(({ textDocument, position, newName }) => {
  const st = stateFor(textDocument.uri); if (!st) return null;
  const plan = Refactor.renamePlan({ ...st.state, at: { path: st.rel, line0: position.line, character: position.character }, newName });
  if (plan.error) throw failed(plan.error);
  log(`designc rename ${plan.kind} "${plan.from}" -> "${plan.to}": ${plan.edits.length} edits${plan.rebind.length ? `; decisions to re-bind: ${plan.rebind.map(r => r.decision).join(', ')}` : ''}`);
  if (plan.rebind.length) connection.sendNotification('window/showMessage', { type: 3, message: `Rename changes the fingerprint of bound decisions: ${plan.rebind.map(r => r.decision).join(', ')}. Re-bind them (Rebind all) once the rename is saved.` });
  return P.toWorkspaceEdit(plan, { root: st.root, versions: st.versions, documentChanges: docChanges });
});
connection.onCodeAction(guarded(({ textDocument, context }) => {
  const mine = (context.diagnostics || []).filter(d => d.source === 'designc' && d.code);
  if (!mine.length) return [];
  const st = stateFor(textDocument.uri); if (!st) return null;
  const out = [];
  for (const dg of mine) {
    const f = st.s.diags.find(x => !x.suppressed && x.code === dg.code && x.loc && Core.locFile(x.loc, st.state.cfgModel) === st.rel && x.loc.line === dg.range.start.line + 1);
    if (!f) continue;
    for (const a of Refactor.fixesFor(st.state, f, PROP)) out.push({ title: a.title, kind: a.kind, diagnostics: [dg], edit: P.toWorkspaceEdit({ edits: a.edits }, { root: st.root, versions: st.versions, documentChanges: docChanges }) });
    const rec = canCreate ? Refactor.recordAction(st.state, f) : null;
    if (rec) out.push({ title: rec.title, kind: rec.kind, diagnostics: [dg], edit: P.toWorkspaceEdit({ creates: [{ path: rec.path, text: rec.text }] }, { root: st.root, documentChanges: true }) });
  }
  return out;
}));

documents.listen(connection);
if (argv.includes('--node-ipc')) process.on('disconnect', () => process.exit(0));
else process.stdin.on('end', () => process.exit(0));
connection.listen();
