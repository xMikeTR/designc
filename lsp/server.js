#!/usr/bin/env node
/* designc language server: transport only. `node lsp/server.js --stdio [--registry <dir>]`.
   Read-only: it never writes the registry, never records a gate event, never opens .designc/index.sqlite.
   The pure half is lsp/providers.js; the findings are headless checkState + renderer/problems.js, with unsaved buffers as an overlay. */
'use strict';
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind, DidChangeWatchedFilesNotification } = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const Headless = require('../headless/index.js');
const Problems = require('../renderer/problems.js');
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
let folders = [], initRegistry = null, related = false, watch = false;
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
  return { capabilities: {
    textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: { includeText: false } },
    hoverProvider: true,
    completionProvider: { triggerCharacters: ['"', '.'] },
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

documents.listen(connection);
process.stdin.on('end', () => process.exit(0));
connection.listen();
