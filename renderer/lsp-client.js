/* designc desktop: the editor's side of the language server. Protocol only: it knows LSP and Monaco, and nothing about designc
   (no Core, DslAssist, Refactor or Problems; test/l3-one-source.test.js enforces it).
   Dual-load like renderer/problems.js: <script src="lsp-client.js"> in the renderer (after Monaco's loader, before app.js),
   require('./renderer/lsp-client.js') from tests. The transport is whatever {send, subscribe} the caller passes (Electron IPC in the app).
   The pure converters take Monaco's enums as arguments; bindMonaco is the only part that touches a Monaco object. */
const LspClient = (() => {
  const OWNER = 'designc-lsp', CMD = 'designc.lsp.applyEdit';

  // ---- JSON-RPC 2.0 over message objects
  const SILENT = new Set(['client/registerCapability', 'client/unregisterCapability', 'window/workDoneProgress/create']);
  function connection({ send, subscribe }) {
    let id = 0, disposed = false;
    const pending = new Map(), notes = new Map(), reqs = new Map();
    const reply = o => { if (!disposed) send({ jsonrpc: '2.0', ...o }); };
    const unsubscribe = subscribe(m => {
      if (disposed || !m) return;
      if (m.method !== undefined && m.id !== undefined) {
        const h = reqs.get(m.method);
        if (h) Promise.resolve().then(() => h(m.params)).then(result => reply({ id: m.id, result: result === undefined ? null : result }), e => reply({ id: m.id, error: { code: -32603, message: String(e && e.message || e) } }));
        else if (SILENT.has(m.method)) reply({ id: m.id, result: null });
        else reply({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
      } else if (m.method !== undefined) {
        const h = notes.get(m.method); if (h) { try { h(m.params); } catch (e) { console.error('lsp notification handler', e); } }
      } else if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result === undefined ? null : m.result);
      }
    });
    return {
      request: (method, params) => new Promise((resolve, reject) => {
        if (disposed) return reject(new Error('The language server connection is closed'));
        const i = ++id; pending.set(i, { resolve, reject }); send({ jsonrpc: '2.0', id: i, method, params });
      }),
      notify: (method, params) => { if (!disposed) send({ jsonrpc: '2.0', method, params }); },
      onNotification: (method, fn) => { notes.set(method, fn); },
      onRequest: (method, fn) => { reqs.set(method, fn); },
      dispose() {
        if (disposed) return; disposed = true;
        if (typeof unsubscribe === 'function') unsubscribe();
        for (const p of pending.values()) p.reject(new Error('The language server connection is closed'));
        pending.clear();
      },
    };
  }

  // ---- pure converters
  const trimSlash = s => String(s).replace(/\/+$/, '');
  const uriOf = (rootUri, rel) => `${trimSlash(rootUri)}/${String(rel).split('/').map(encodeURIComponent).join('/')}`;
  function relOfUri(rootUri, uri) {
    const root = trimSlash(rootUri) + '/';
    if (typeof uri !== 'string' || !uri.startsWith(root)) return null;
    try {
      const parts = uri.slice(root.length).split('/').map(decodeURIComponent);
      return parts.length && parts.every(p => p && p !== '..' && p !== '.') ? parts.join('/') : null;
    } catch { return null; }
  }
  // Registry-relative path of a Monaco model (URI `file:///` + encodeURI(rel)); null for code:, inmemory: and the like.
  function modelRel(model) {
    const u = model && model.uri;
    if (!u || u.scheme !== 'file') return null;
    try { return decodeURI(String(u.path).slice(1)); } catch { return null; }
  }
  const toLspPosition = ({ lineNumber, column }) => ({ line: lineNumber - 1, character: column - 1 });
  const toLspRange = r => ({ start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 } });
  const toMonacoRange = r => ({ startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 });
  function toMarker(d, S, resourceOf) {
    const severity = { 1: S.Error, 2: S.Warning, 3: S.Info, 4: S.Hint }[d.severity] || S.Info;
    const m = { severity, message: d.message, ...toMonacoRange(d.range) };
    if (d.code != null) m.code = String(d.code);
    if (d.source) m.source = d.source;
    if (d.relatedInformation && d.relatedInformation.length) m.relatedInformation = d.relatedInformation.map(r => ({ resource: resourceOf(r.location.uri), message: r.message, ...toMonacoRange(r.location.range) }));
    return m;
  }
  const KIND_NAMES = ['', 'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];
  const docOf = d => (d == null ? undefined : typeof d === 'string' ? d : { value: d.value });
  function toSuggestions(items, K, snippetRule, fallbackRange) {
    return (items || []).map(i => {
      const edit = i.textEdit && i.textEdit.range ? i.textEdit : null;
      const s = { label: i.label, kind: K[KIND_NAMES[i.kind]] != null ? K[KIND_NAMES[i.kind]] : K.Text, insertText: edit ? edit.newText : (i.insertText || i.label), range: edit ? toMonacoRange(edit.range) : fallbackRange };
      if (i.detail) s.detail = i.detail;
      if (i.documentation != null) s.documentation = docOf(i.documentation);
      if (i.insertTextFormat === 2) s.insertTextRules = snippetRule;
      return s;
    });
  }
  function toMonacoHover(h) {
    if (!h || h.contents == null) return null;
    const list = Array.isArray(h.contents) ? h.contents : [h.contents];
    const contents = list.map(c => ({ value: typeof c === 'string' ? c : c.value }));
    return { ...(h.range ? { range: toMonacoRange(h.range) } : {}), contents };
  }
  // A WorkspaceEdit -> [{rel, create, version, edits}] (first-seen order; a create carries the edits that fill it), or {error}.
  function editTargets(edit, relOf) {
    const order = [], by = new Map();
    let error = null;
    const target = uri => {
      const rel = relOf(uri);
      if (!rel) { error = error || `The edit touches a file outside the open folder: ${uri}`; return null; }
      if (rel === 'handovers' || rel.startsWith('handovers/')) { error = error || `The edit would change a frozen handover file: ${rel}`; return null; }
      let t = by.get(rel); if (!t) { t = { rel, create: false, version: null, edits: [] }; by.set(rel, t); order.push(t); }
      return t;
    };
    for (const c of (edit && edit.documentChanges) || []) {
      if (c.kind === 'create') { const t = target(c.uri); if (t) t.create = true; }
      else if (c.kind) { error = error || `Unsupported file operation: ${c.kind}`; }
      else if (c.textDocument) { const t = target(c.textDocument.uri); if (t) { if (c.textDocument.version != null) t.version = c.textDocument.version; t.edits.push(...c.edits); } }
    }
    for (const [uri, edits] of Object.entries((edit && edit.changes) || {})) { const t = target(uri); if (t) t.edits.push(...edits); }
    if (error) return { error };
    return order;
  }
  // LSP ranges on text; descending start order so earlier offsets stay valid; \r\n kept as it is.
  function applyTextEdits(text, edits) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const off = p => Math.min((starts[p.line] != null ? starts[p.line] : text.length) + p.character, text.length);
    const sorted = edits.map((e, k) => ({ e, k })).sort((a, b) => b.e.range.start.line - a.e.range.start.line || b.e.range.start.character - a.e.range.start.character || b.k - a.k);
    let out = text;
    for (const { e } of sorted) out = out.slice(0, off(e.range.start)) + e.newText + out.slice(off(e.range.end));
    return out;
  }
  function initializeParams(rootUri, name) {
    return {
      processId: null, rootUri, workspaceFolders: [{ uri: rootUri, name: name || 'registry' }],
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ['markdown'] },
          completion: { completionItem: { snippetSupport: true } },
          rename: { prepareSupport: true },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix'] } } },
        },
        workspace: { workspaceEdit: { documentChanges: true, resourceOperations: ['create'] }, didChangeWatchedFiles: { dynamicRegistration: true } },
      },
    };
  }

  // ---- Monaco binding. Called once; every provider answers null or empty while detached.
  function bindMonaco(monaco, { languages = ['structurizr', 'yaml'], onApplyEdit, onShowMessage, onOpen } = {}) {
    let conn = null, rootUri = null, init = null;
    const stored = new Map();       // rel -> LSP diagnostics
    const watchers = new Map();     // model -> disposable list
    const versionsSent = new Map(); // model -> true once opened
    const resourceOf = u => { const rel = relOfUri(rootUri, u); return monaco.Uri.parse('file:///' + encodeURI(rel == null ? '' : rel)); };
    const docUri = model => { const rel = modelRel(model); return rel == null || !rootUri ? null : uriOf(rootUri, rel); };
    const modelFor = rel => monaco.editor.getModels().find(m => modelRel(m) === rel) || null;
    const applyMarkers = (model, rel) => monaco.editor.setModelMarkers(model, OWNER, (stored.get(rel) || []).map(d => toMarker(d, monaco.MarkerSeverity, resourceOf)));
    const locOf = l => { const rel = relOfUri(rootUri, l.uri); return rel == null ? null : { uri: monaco.Uri.parse('file:///' + encodeURI(rel)), range: toMonacoRange(l.range) }; };

    function openModel(model) {
      const uri = docUri(model); if (!uri || !conn || versionsSent.has(model)) return;
      const c = conn;
      versionsSent.set(model, true);
      c.notify('textDocument/didOpen', { textDocument: { uri, languageId: model.getLanguageId(), version: model.getVersionId(), text: model.getValue() } });
      const sub = model.onDidChangeContent(() => { if (conn === c) c.notify('textDocument/didChange', { textDocument: { uri, version: model.getVersionId() }, contentChanges: [{ text: model.getValue() }] }); });
      watchers.set(model, [sub]);
      const rel = modelRel(model); if (stored.has(rel)) applyMarkers(model, rel);
    }
    function closeModel(model) {
      for (const d of watchers.get(model) || []) d.dispose();
      watchers.delete(model);
      if (versionsSent.delete(model) && conn) { const uri = docUri(model); if (uri) conn.notify('textDocument/didClose', { textDocument: { uri } }); }
    }
    const modelSubs = [
      monaco.editor.onDidCreateModel(m => openModel(m)),
      monaco.editor.onWillDisposeModel(m => closeModel(m)),
    ];
    void modelSubs;

    const guard = fn => async (...a) => { if (!conn) return null; try { return await fn(...a); } catch { return null; } };
    const posParams = (model, pos) => ({ textDocument: { uri: docUri(model) }, position: toLspPosition(pos) });
    for (const lang of languages) {
      monaco.languages.registerHoverProvider(lang, {
        provideHover: guard(async (model, pos) => (docUri(model) ? toMonacoHover(await conn.request('textDocument/hover', posParams(model, pos))) : null)),
      });
      monaco.languages.registerCompletionItemProvider(lang, {
        get triggerCharacters() { return (init && init.capabilities && init.capabilities.completionProvider && init.capabilities.completionProvider.triggerCharacters) || []; },
        provideCompletionItems: async (model, pos) => {
          if (!conn || !docUri(model)) return { suggestions: [] };
          try {
            const r = await conn.request('textDocument/completion', posParams(model, pos));
            const items = Array.isArray(r) ? r : (r && r.items) || [];
            const w = model.getWordUntilPosition ? model.getWordUntilPosition(pos) : { startColumn: pos.column, endColumn: pos.column };
            return { suggestions: toSuggestions(items, monaco.languages.CompletionItemKind, monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn }) };
          } catch { return { suggestions: [] }; }
        },
      });
      monaco.languages.registerDefinitionProvider(lang, {
        provideDefinition: guard(async (model, pos) => {
          if (!docUri(model)) return null;
          const r = await conn.request('textDocument/definition', posParams(model, pos));
          const list = (Array.isArray(r) ? r : r ? [r] : []).map(locOf).filter(Boolean);
          return list.length ? list : null;
        }),
      });
      monaco.languages.registerRenameProvider(lang, {
        async resolveRenameLocation(model, pos) {
          const here = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: pos.column, endColumn: pos.column };
          if (!conn || !docUri(model)) return { range: here, text: '', rejectReason: 'The language server is not running' };
          try {
            const r = await conn.request('textDocument/prepareRename', posParams(model, pos));
            if (!r) return { range: here, text: '', rejectReason: 'nothing to rename here' };
            const range = r.range || r;
            return { range: toMonacoRange(range), text: r.placeholder != null ? r.placeholder : model.getValueInRange(toMonacoRange(range)) };
          } catch (e) { return { range: here, text: '', rejectReason: e.message }; }
        },
        async provideRenameEdits(model, pos, newName) {
          if (!conn || !docUri(model)) return { edits: [], rejectReason: 'The language server is not running' };
          try {
            const edit = await conn.request('textDocument/rename', { ...posParams(model, pos), newName });
            if (!edit) return { edits: [] };
            const res = await onApplyEdit(edit);
            return res && res.error ? { edits: [], rejectReason: res.error } : { edits: [] };
          } catch (e) { return { edits: [], rejectReason: e.message }; }
        },
      });
      monaco.languages.registerCodeActionProvider(lang, {
        provideCodeActions: async (model, range) => {
          const none = { actions: [], dispose() {} };
          if (!conn || !docUri(model)) return none;
          try {
            const rel = modelRel(model), lr = toLspRange(range);
            const diagnostics = (stored.get(rel) || []).filter(d => d.range.start.line <= lr.end.line && d.range.end.line >= lr.start.line);
            if (!diagnostics.length) return none;
            const acts = await conn.request('textDocument/codeAction', { textDocument: { uri: docUri(model) }, range: lr, context: { diagnostics } });
            const actions = (acts || []).filter(a => a.edit).map(a => ({ title: a.title, kind: a.kind || 'quickfix', command: { id: CMD, title: a.title, arguments: [a.edit] } }));
            return { actions, dispose() {} };
          } catch { return none; }
        },
      });
    }
    monaco.editor.registerCommand(CMD, (_accessor, edit) => onApplyEdit(edit));

    function attach(c, root, initResult) {
      detach();
      conn = c; rootUri = root; init = initResult || null;
      c.onNotification('textDocument/publishDiagnostics', p => {
        if (conn !== c) return;
        const rel = relOfUri(rootUri, p.uri); if (rel == null) return;
        if (p.diagnostics && p.diagnostics.length) stored.set(rel, p.diagnostics); else stored.delete(rel);
        const m = modelFor(rel); if (m) applyMarkers(m, rel);
      });
      const msg = p => { if (conn === c && onShowMessage) onShowMessage(p.type, p.message); };
      c.onNotification('window/showMessage', msg);
      c.onNotification('window/logMessage', p => { if (p.type === 1) msg(p); });
      for (const m of monaco.editor.getModels()) openModel(m);
    }
    function detach() {
      for (const m of [...watchers.keys()]) { for (const d of watchers.get(m)) d.dispose(); }
      watchers.clear(); versionsSent.clear();
      const had = [...stored.keys()];
      stored.clear();
      for (const m of monaco.editor.getModels()) if (modelRel(m) != null || had.length) monaco.editor.setModelMarkers(m, OWNER, []);
      conn = null; rootUri = null; init = null;
    }
    return { attach, detach };
  }

  return { OWNER, connection, uriOf, relOfUri, modelRel, toLspPosition, toLspRange, toMonacoRange, toMarker, toSuggestions, toMonacoHover, editTargets, applyTextEdits, initializeParams, bindMonaco };
})();
if (typeof module !== 'undefined') module.exports = LspClient;
