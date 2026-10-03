/* designc desktop renderer. File system and processes live in main.js behind window.host. */
'use strict';

// ---------------------------------------------------------------- reference data
const PROPS = [
  ['d.interaction', 'relationship', ['sync', 'async'], 'Call style. Undeclared counts as sync for DC003.'],
  ['d.delivery', 'relationship', ['at-most-once', 'at-least-once', 'exactly-once'], 'Delivery guarantee of an async interaction (DC001).'],
  ['d.idempotent', 'relationship', ['yes', 'no'], 'Whether the receiver handles this interaction idempotently (DC001, DC004).'],
  ['d.retry', 'relationship', ['none', 'fixed', 'backoff'], 'Caller retry policy (DC004).'],
  ['d.retry.max', 'relationship', null, 'Maximum retry attempts, a whole number.'],
  ['d.encrypted', 'relationship', ['yes', 'no'], 'Encrypted in transit (DC006).'],
  ['d.authenticated', 'relationship', ['yes', 'no'], 'Caller is authenticated (DC006).'],
  ['d.writes', 'relationship', null, 'Comma-separated entities written to the destination store (DC002).'],
  ['d.concurrency', 'relationship', ['none', 'optimistic', 'pessimistic'], 'Concurrency control on those writes (DC002).'],
  ['d.instances', 'element', null, 'Running instances, a whole number (DC002, DC005).'],
  ['d.critical', 'element', ['yes', 'no'], 'On a critical path (DC005).'],
  ['d.zone', 'element', null, 'Trust zone name; children inherit it (DC006).'],
  ['d.availability', 'element', null, 'Availability as a fraction, e.g. 0.999 (DC003).'],
  ['d.owns', 'element', null, 'Comma-separated entities this element owns writes to (DC002).'],
  ['d.store', 'element', ['yes', 'no'], 'Treat as a data store. Default: the Database tag.'],
  ['d.aka', 'element', null, 'Other names, used to match code in the as-built diff.'],
  ['d.suppress', 'both', null, 'Accept findings here: "DCnnn: reason; DCnnn: reason". A reason is required.'],
];
if (typeof DesigncCanvas !== 'undefined' && DesigncCanvas.vocabulary) {
  PROPS.push(...DesigncCanvas.vocabulary.propsList());
  // Register the canvas's extra properties and agentic rules up front, so linting and completion
  // see them even if the Canvas view is never opened. canvas.js does the same check before mounting.
  if (!Core.__dcvRegistered) {
    Core.registerProperties(DesigncCanvas.vocabulary.coreSpecs());
    Core.registerRules(DesigncCanvas.agenticRules.makeRules(Core));
    Core.__dcvRegistered = true;
  }
}
const PROP = new Map(PROPS.map(p => [p[0], { key: p[0], target: p[1], values: p[2], doc: p[3] }]));
const STAGES = [['S1-lint', 'S1 lint'], ['S1-p', 'S1 behaviour (P)'], ['S1-grill', 'S1 grill-me / gate'], ['S2-runtime', 'S2 runtime'], ['S2-config', 'S2 configurator']];
if (typeof Ledger !== 'undefined') {
  const stageKeys = STAGES.map(([k]) => k).sort().join(',');
  const caughtBy = Ledger.CAUGHT_BY.slice().sort().join(',');
  if (stageKeys !== caughtBy) throw new Error(`STAGES keys must equal Ledger.CAUGHT_BY: [${stageKeys}] vs [${caughtBy}]`);
}
const REG_DIRS = ['decisions', 'requirements', 'proposals', 'handovers', 'scenarios', 'evals'];

// ---------------------------------------------------------------- state
const A = {
  root: null, user: 'you', recent: [], tree: [], expanded: new Set(['model', 'decisions', 'requirements']),
  cfg: { model: 'model/workspace.dsl', chainHops: 4, llm: {} },
  buffers: new Map(),        // path -> {model, dirty, disk}
  tabs: [], active: null,    // tab ids: file paths or 'special:build' / 'special:improve'
  activity: 'explorer', sidebarOpen: true, panel: 'problems', panelOpen: true, sheetOpen: true,
  modelText: '', model: null, diags: [], gate: null,
  decisions: [], requirements: [], proposals: [], handovers: [], scenarios: [], evals: [], yamlErrors: [],
  ledgerRaw: [], ledger: [], ledgerErrors: [], ledgerFiles: [],
  output: '', running: false, collapsed: new Set(),
  grill: { busy: false, questions: [], error: null }, drafting: false,
  selected: null, zoom: 'fit', cursor: null,
  asbuilt: null, facts: null, drift: null, extracting: false, cmSel: null, cmZoom: 'fit', showGhost: true,
  cmLevel: 'container', cmScope: null, asbuiltFull: null, cdrift: null,
  tel: { runs: [], meta: null, error: null, loading: false }, badges: 'findings',
  canvasApi: null, canvasLayout: null,
};
let editor = null, monacoRef = null;

// ---------------------------------------------------------------- helpers
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${n === 1 ? w : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : w + 's'}`;
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16).slice(0, 7); };
const fmtN = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const when = ts => (ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const extOf = p => (p.match(/\.([^.\/]+)$/) || [, ''])[1].toLowerCase();
const nextId = (prefix, list) => {
  const nums = list.map(x => parseInt(String(x.id || '').split('-')[1], 10)).filter(n => !isNaN(n));
  return `${prefix}-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, '0')}`;
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function toast(msg, kind = 'info', actions = []) {
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = `<div class="tm"><span class="ic ${kind}">${kind === 'error' ? '⊗' : kind === 'warning' ? '⚠' : 'ⓘ'}</span><span>${esc(msg)}</span></div>${actions.length ? `<div class="ta">${actions.map((a, i) => `<button class="btn ${i === 0 ? 'primary' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}`;
  el.addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) { actions[+b.dataset.i].run(); el.remove(); } });
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), actions.length ? 12000 : 5000);
}

// ---------------------------------------------------------------- registry loading
function textOf(path) { const b = A.buffers.get(path); return b ? b.model.getValue() : null; }
async function readText(path) { const t = textOf(path); if (t != null) return t; try { return await host.read(path); } catch { return null; } }

async function loadSettings() {
  A.cfg = { model: 'model/workspace.dsl', chainHops: 4, llm: {} };
  const t = await readText('designc.json');
  if (t) { try { Object.assign(A.cfg, JSON.parse(t)); } catch (e) { toast('designc.json is not valid JSON: ' + e.message, 'error'); } }
}
async function loadYamlDir(dir, keepText = false) {
  const files = await host.list(dir, ['.yaml', '.yml']); const out = [];
  for (const f of files) {
    const text = textOf(f.path) ?? f.text;
    try {
      const o = jsyaml.load(text) || {};
      if (typeof o !== 'object' || Array.isArray(o)) throw new Error('expected a mapping at the top level');
      for (const k of ['binds', 'resolves', 'checks', 'elements']) if (o[k] != null && !Array.isArray(o[k])) o[k] = [o[k]];
      out.push({ ...o, id: o.id || f.path.split('/').pop().replace(/\.ya?ml$/, ''), _path: f.path, ...(keepText ? { _text: text } : {}) });
    } catch (e) { A.yamlErrors.push({ path: f.path, line: (e.mark && e.mark.line + 1) || 1, msg: e.reason || e.message }); }
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
async function loadRegistry() {
  A.yamlErrors = [];
  [A.decisions, A.requirements, A.proposals, A.handovers, A.scenarios, A.evals] = await Promise.all(REG_DIRS.map(d => loadYamlDir(d, d === 'evals')));
  // Folder handovers (handovers/<id>/handover.yaml) sit beside the older flat files.
  const hv = ((Array.isArray(A.tree) ? A.tree : []).find(n => n.dir && n.name === 'handovers')) || { children: [] };
  for (const c of hv.children.filter(n => n.dir)) A.handovers.push(...await loadYamlDir(`handovers/${c.name}`));
  A.handovers.sort((a, b) => (+new Date(a.created) || 0) - (+new Date(b.created) || 0) || String(a.id).localeCompare(String(b.id)));
  A.decisions.forEach(d => { d.status = d.status || 'minted'; d.effect = d.effect || 'fix'; });
}
async function loadLedger() {
  const files = await host.list('ledger', ['.jsonl']); A.ledgerFiles = files; A.ledgerRaw = []; A.ledgerErrors = [];
  for (const f of files) {
    const { events, errors } = Ledger.parse(f.text, f.path);
    A.ledgerRaw.push(...events); A.ledgerErrors.push(...errors);
  }
  A.ledgerRaw = Ledger.order(A.ledgerRaw);
  deriveLedger();
}
// The ledger is append-only: classification and resolution are later events, folded in here.
function deriveLedger() { A.ledger = Ledger.derive(A.ledgerRaw); }
// The only call of host.appendLedgerEvent (test/ledger-guard.test.js, LS-05): every writer goes
// through recordEvent, never a raw literal.
// OWN_APPENDS remembers when the app last appended to each ledger file, so a change to the ledger
// that the app did not make during an agent turn can be told apart (Policy.unapprovedChanges).
const OWN_APPENDS = new Map();
const ledgerFileFor = kind => `ledger/${Ledger.KINDS[kind] ? Ledger.KINDS[kind].stream : Ledger.HARNESS_STREAM}`;
async function sendLedgerEvent(ev) {
  OWN_APPENDS.set(ledgerFileFor(ev.kind), Date.now());
  const r = await host.appendLedgerEvent(ev);
  OWN_APPENDS.set(ledgerFileFor(ev.kind), Date.now());
  if (!r.ok) toast(`Ledger event not recorded: ${r.errors.join('; ')}`, 'error');
  return r;
}
async function recordEvent(kind, fields) { return sendLedgerEvent({ kind, by: A.user, ...fields }); }
// Harness envelope v1 (LS-02): grill-me session/charter kinds, routed by Ledger.HARNESS_STREAM.
async function recordSessionEvent(kind, { session_id, payload, parent_session_id, agent_id, acting_as }) {
  return sendLedgerEvent({ kind, project: A.cfg.project || (A.root ? A.root.name : ''), session_id, payload, parent_session_id, agent_id, acting_as });
}
const layoutPathFor = p => p.replace(/\.dsl$/, '') + '.layout.json';
async function loadModel() { A.modelText = (await readText(A.cfg.model)) ?? ''; await loadCanvasLayout(); }
async function loadCanvasLayout() {
  const t = await readText(layoutPathFor(A.cfg.model));
  try { A.canvasLayout = t ? JSON.parse(t) : null; } catch { A.canvasLayout = null; }
}
async function loadAsbuilt() {
  const dsl = await readText('asbuilt/workspace.dsl'), facts = await readText('asbuilt/facts.json');
  A.asbuiltFull = dsl ? Core.parse(dsl) : null;
  A.asbuilt = A.asbuiltFull ? Core.atLevel(A.asbuiltFull, 'container') : null;
  try { A.facts = facts ? JSON.parse(facts) : null; } catch { A.facts = null; }
  if (A.cmSel && (!A.asbuilt || !A.asbuilt.elements.has(A.cmSel))) A.cmSel = null;
  if (A.cmScope && !(A.asbuiltFull && A.asbuiltFull.elements.has(A.cmScope))) A.cmScope = null;
  if (A.cmLevel === 'component' && !cmHasComponents()) { A.cmLevel = 'container'; A.cmScope = null; }
}
function recompile() {
  A.model = Core.parse(A.modelText);
  A.diags = A.model.elements.size || A.model.errors.length ? Core.check(A.model, { chainHops: A.cfg.chainHops || 4 }) : [];
  A.gate = Core.gate({ model: A.model, diags: A.diags, decisions: A.decisions, requirements: A.requirements, ledger: A.ledger, registryErrors: A.yamlErrors.map(e => ({ path: e.path, message: e.msg })), evidenceHosts: A.cfg.evidenceHosts || [], scenarios: A.scenarios, evals: A.evals });
  A.drift = A.asbuilt && A.model.elements.size ? Core.driftModels(Core.atLevel(A.model, 'container'), A.asbuilt) : null;
  A.cdrift = A.asbuiltFull && A.model.elements.size ? Core.driftComponents(A.model, A.asbuiltFull) : null;
  setMarkers();
}
async function reloadAll() {
  await loadSettings(); await loadModel(); await loadRegistry(); await loadLedger(); await loadAsbuilt(); recompile(); renderAll(); loadTelemetry();
}

// ---------------------------------------------------------------- telemetry (Langfuse)
async function loadTelemetry() {
  if (!A.root || A.tel.loading) return;
  A.tel.loading = true; renderStatus();
  const r = await host.telemetry();
  A.tel.loading = false;
  if (r.error) { A.tel = { runs: [], meta: null, error: r, loading: false }; }
  else A.tel = { runs: r.runs, meta: r.meta, error: null, loading: false };
  renderStatus(); renderSheet(); renderBadges();
  if (A.active === 'special:build' || A.active === 'special:improve') renderSpecial();
  if (A.activity === 'build' || A.activity === 'improve') renderSidebar();
}
setInterval(() => { if (A.root && A.tel.meta && A.tel.meta.source === 'langfuse' && document.visibilityState === 'visible') loadTelemetry(); }, 5 * 60 * 1000);
const nkey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function designNameFor(name) {
  if (!name || !A.model) return null;
  for (const e of A.model.elements.values()) if ([e.name, ...(Core.get(e, 'd.aka') || [])].some(n => nkey(n) === nkey(name))) return e.name;
  return null;
}
// runs → per task (attempts, final outcome) and per design element
function telAgg() {
  const runs = A.tel.runs.filter(r => (r.system || 'S2') === 'S2');
  const tasks = new Map();
  for (const r of runs.slice().sort((a, b) => a.start - b.start)) {
    if (!r.task) continue;
    const t = tasks.get(r.task) || { task: r.task, element: r.element, runs: [], tokens: 0, cost: 0 };
    t.runs.push(r); t.tokens += r.tokens; t.cost += r.cost; t.element = t.element || r.element; t.final = r.outcome; t.last = r;
    tasks.set(r.task, t);
  }
  const passedTasks = [...tasks.values()].filter(t => t.final === 'passed');
  const byEl = new Map();
  for (const r of runs) {
    const k = designNameFor(r.element) || r.element || '(no element)';
    const e = byEl.get(k) || { element: k, known: !!designNameFor(r.element), runs: 0, failed: 0, tokens: 0, cost: 0, tasks: new Set() };
    e.runs++; e.tokens += r.tokens; e.cost += r.cost; if (['failed', 'error'].includes(r.outcome)) e.failed++; if (r.task) e.tasks.add(r.task);
    byEl.set(k, e);
  }
  const total = { runs: runs.length, tokens: runs.reduce((a, r) => a + r.tokens, 0), cost: A.tel.runs.reduce((a, r) => a + r.cost, 0),
    failed: runs.filter(r => ['failed', 'error'].includes(r.outcome)).length };
  const gaps = { noElement: runs.filter(r => !r.element).length, noTask: runs.filter(r => !r.task).length, unknownElement: runs.filter(r => r.element && !designNameFor(r.element)).length };
  return { runs, tasks, passedTasks, byEl, total, gaps, tpp: passedTasks.length ? total.tokens / passedTasks.length : null };
}
function telSuggestions() {
  const { tasks } = telAgg();
  const recorded = new Set(A.ledger.filter(e => e.kind === 'escape' && e.task).map(e => e.task));
  return [...tasks.values()].filter(t => !recorded.has(t.task) && (t.runs.length >= 3 || ['failed', 'error', 'escalated'].includes(t.final)))
    .map(t => ({ ...t, why: t.final === 'escalated' ? 'escalated to a human' : t.runs.length >= 3 ? `${t.runs.length} attempts${t.final === 'passed' ? ' before passing' : ''}` : `last run ${t.final}` }));
}
const money = n => (n >= 100 ? '$' + n.toFixed(0) : n >= 1 ? '$' + n.toFixed(2) : '$' + n.toFixed(3));
function telErrorText(e) {
  if (!e) return '';
  if (e.error === 'not_configured') return 'Langfuse is not configured. Add a "langfuse" block to designc.json.';
  if (e.error === 'no_keys') return `Set ${e.env.join(' and ')} in your environment, then refresh.`;
  return e.message || e.error;
}

// ---------------------------------------------------------------- monaco setup
function setupMonaco(monaco) {
  monacoRef = monaco;
  monaco.languages.register({ id: 'structurizr', extensions: ['.dsl'] });
  monaco.languages.setMonarchTokensProvider('structurizr', {
    keywords: ['workspace', 'model', 'views', 'person', 'softwareSystem', 'container', 'component', 'properties', 'tags', 'description', 'technology',
      'styles', 'element', 'relationship', 'systemContext', 'systemLandscape', 'include', 'exclude', 'autoLayout', 'deploymentEnvironment', 'deploymentNode',
      'infrastructureNode', 'containerInstance', 'softwareSystemInstance', 'group', 'theme', 'themes', 'this', 'perspectives', 'url', 'dynamic', 'filtered', 'configuration'],
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'], [/#.*$/, 'comment'], [/\/\*/, 'comment', '@comment'],
        [/"d\.[\w.]+"/, 'type'],
        [/"DC\d{3}:[^"]*"/, 'string.escape'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/->/, 'operator'], [/=/, 'operator'], [/[{}]/, '@brackets'],
        [/![\w]+/, 'keyword'],
        [/[A-Za-z_][\w.]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
      ],
      comment: [[/[^/*]+/, 'comment'], [/\*\//, 'comment', '@pop'], [/[/*]/, 'comment']],
    },
  });
  monaco.languages.setLanguageConfiguration('structurizr', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] }, brackets: [['{', '}']],
    autoClosingPairs: [{ open: '{', close: '}' }], surroundingPairs: [{ open: '"', close: '"' }, { open: '{', close: '}' }],
  });
  monaco.languages.register({ id: 'p', extensions: ['.p'] });
  monaco.languages.setMonarchTokensProvider('p', {
    keywords: ['machine', 'spec', 'observes', 'state', 'start', 'hot', 'cold', 'event', 'type', 'var', 'entry', 'exit', 'on', 'do', 'goto', 'send', 'announce',
      'raise', 'new', 'if', 'else', 'while', 'return', 'assert', 'assume', 'test', 'main', 'in', 'module', 'fun', 'this', 'true', 'false', 'format', 'halt', 'defer', 'ignore', 'receive', 'case', 'with'],
    typeKeywords: ['int', 'bool', 'float', 'string', 'machine', 'event', 'seq', 'map', 'set', 'any'],
    tokenizer: { root: [[/\/\/.*$/, 'comment'], [/"([^"\\]|\\.)*"/, 'string'], [/\d+/, 'number'],
      [/[A-Za-z_]\w*/, { cases: { '@keywords': 'keyword', '@typeKeywords': 'type', '@default': 'identifier' } }]] },
  });

  // completions for d.* keys and their values
  monaco.languages.registerCompletionItemProvider('structurizr', {
    triggerCharacters: ['"', '.'],
    provideCompletionItems(model, pos) {
      const line = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
      const val = /"(d\.[\w.]+)"\s+"([^"]*)$/.exec(line);
      if (val) {
        const p = PROP.get(val[1]); if (!p || !p.values) return { suggestions: [] };
        const range = new monaco.Range(pos.lineNumber, pos.column - val[2].length, pos.lineNumber, pos.column);
        return { suggestions: p.values.map(v => ({ label: v, kind: monaco.languages.CompletionItemKind.EnumMember, insertText: v, range, documentation: p.doc })) };
      }
      const key = /"(d\.?[\w.]*)$/.exec(line) || (/"$/.test(line) ? ['', ''] : null);
      if (!key) return { suggestions: [] };
      const range = new monaco.Range(pos.lineNumber, pos.column - key[1].length, pos.lineNumber, pos.column);
      return { suggestions: PROPS.map(([k, target, values, doc]) => ({
        label: k, kind: monaco.languages.CompletionItemKind.Property, detail: target === 'both' ? 'element or relationship' : target,
        documentation: doc, range, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        insertText: values ? `${k}" "\${1|${values.join(',')}|}` : `${k}" "\${1}`,
      })) };
    },
  });
  monaco.languages.registerHoverProvider('structurizr', {
    provideHover(model, pos) {
      const line = model.getLineContent(pos.lineNumber); const re = /"(d\.[\w.]+)"/g; let m;
      while ((m = re.exec(line))) {
        if (pos.column > m.index && pos.column <= m.index + m[0].length + 1) {
          const p = PROP.get(m[1]);
          return { range: new monaco.Range(pos.lineNumber, m.index + 1, pos.lineNumber, m.index + m[0].length + 1),
            contents: p ? [{ value: `**${p.key}** · ${p.target === 'both' ? 'element or relationship' : p.target}` }, { value: p.doc + (p.values ? `\n\nValues: \`${p.values.join('` | `')}\`` : '') }]
              : [{ value: `**${m[1]}** is not a design property` }] };
        }
      }
      return null;
    },
  });
  monaco.editor.registerCommand('designc.recordDecision', (_a, code, line) => {
    const f = A.diags.find(d => d.code === code && d.loc.line === line && !d.suppressed); if (f) recordDecision({ finding: f });
  });
  monaco.languages.registerCodeActionProvider('structurizr', {
    provideCodeActions(model, _range, context) {
      const actions = context.markers.filter(m => /^DC00[1-9]$/.test(String(m.code))).map(m => ({
        title: `Record a decision for ${m.code}`, kind: 'quickfix', diagnostics: [m],
        command: { id: 'designc.recordDecision', title: 'Record a decision', arguments: [String(m.code), m.startLineNumber] },
      }));
      return { actions, dispose() {} };
    },
  });

  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  monaco.editor.defineTheme('designc-dark', { base: 'vs-dark', inherit: true, rules: [{ token: 'type', foreground: '7fb8e6' }, { token: 'string.escape', foreground: 'd7ba7d' }], colors: { 'editor.background': '#1e2227' } });
  monaco.editor.defineTheme('designc-light', { base: 'vs', inherit: true, rules: [{ token: 'type', foreground: '2c5aa0', fontStyle: 'bold' }, { token: 'string.escape', foreground: '8a5a00' }], colors: {} });
  const theme = () => monaco.editor.setTheme(dark.matches ? 'designc-dark' : 'designc-light');
  theme(); dark.addEventListener('change', () => { theme(); renderSheet(); });

  editor = monaco.editor.create($('#monaco'), {
    automaticLayout: true, fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, Menlo, DejaVu Sans Mono, monospace', fontSize: 13, lineHeight: 20,
    minimap: { enabled: true, scale: 1 }, renderWhitespace: 'selection', scrollBeyondLastLine: false, tabSize: 2, insertSpaces: true,
    fixedOverflowWidgets: true, lightbulb: { enabled: 'on' }, quickSuggestions: { strings: true, other: true, comments: false },
  });
  editor.onDidChangeCursorPosition(e => { A.cursor = e.position; renderStatus(); });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
}
function langFor(path) {
  const x = extOf(path); if (/proj$/.test(x)) return 'xml';
  return { dsl: 'structurizr', yaml: 'yaml', yml: 'yaml', json: 'json', md: 'markdown', p: 'p', cs: 'csharp', fs: 'fsharp', py: 'python', ts: 'typescript', js: 'javascript', sql: 'sql', rego: 'plaintext' }[x] || 'plaintext';
}
function iconFor(path) { const x = extOf(path); if (x === 'cs') return ['cs', 'C#']; if (x === 'fs') return ['fs', 'F#']; if (/proj$/.test(x)) return ['json', '<>']; return x === 'dsl' ? ['dsl', 'C4'] : x === 'yaml' || x === 'yml' ? ['yaml', 'Y'] : x === 'p' ? ['p', 'P'] : x === 'md' ? ['md', 'M'] : x === 'json' || x === 'jsonl' ? ['json', '{}'] : ['', '·']; }

function setMarkers() {
  if (!monacoRef) return;
  const S = monacoRef.MarkerSeverity;
  for (const [path, b] of A.buffers) {
    const markers = [];
    if (path === A.cfg.model) {
      for (const e of A.model.errors) markers.push({ severity: S.Error, message: e.msg, startLineNumber: e.line, endLineNumber: e.line, startColumn: 1, endColumn: b.model.getLineMaxColumn(Math.min(e.line, b.model.getLineCount())), source: 'designc' });
      for (const f of A.diags) {
        if (f.suppressed || !f.loc.line || f.loc.line > b.model.getLineCount()) continue;
        const ln = f.loc.line, text = b.model.getLineContent(ln), first = text.search(/\S/) + 1 || 1;
        markers.push({ severity: f.sev === 'error' ? S.Error : f.sev === 'warning' ? S.Warning : S.Info, code: f.code, source: 'designc',
          message: `${f.loc.label}: ${f.msg}${f.hint ? `\n${f.hint}` : ''}`, startLineNumber: ln, endLineNumber: ln, startColumn: first, endColumn: b.model.getLineMaxColumn(ln) });
      }
    }
    for (const e of [...A.yamlErrors, ...A.ledgerErrors].filter(e => e.path === path)) {
      const ln = Math.min(e.line, b.model.getLineCount());
      markers.push({ severity: S.Error, message: e.msg, startLineNumber: ln, endLineNumber: ln, startColumn: 1, endColumn: b.model.getLineMaxColumn(ln), source: 'designc' });
    }
    monacoRef.editor.setModelMarkers(b.model, 'designc', markers);
  }
}

// ---------------------------------------------------------------- tabs & files
async function openFile(path, line) {
  if (!A.buffers.has(path)) {
    let text; try { text = await host.read(path); } catch (e) { toast(`Can't open ${path}: ${e.message}`, 'error'); return; }
    const model = monacoRef.editor.createModel(text, langFor(path), monacoRef.Uri.parse('file:///' + encodeURI(path)));
    const b = { model, dirty: false, disk: text, view: null };
    model.onDidChangeContent(() => onBufferChange(path));
    A.buffers.set(path, b);
  }
  if (!A.tabs.includes(path)) A.tabs.push(path);
  activate(path);
  if (line) revealLine(line);
  setMarkers();
}
async function openCode(rel, line) {
  const id = 'code:' + rel;
  if (!A.buffers.has(id)) {
    let text; try { text = await host.readCode(A.cfg.codebase, rel); } catch (e) { toast(`Can't open ${rel}: ${e.message}`, 'error'); return; }
    const model = monacoRef.editor.createModel(text, langFor(rel), monacoRef.Uri.parse('code:///' + encodeURI(rel)));
    A.buffers.set(id, { model, dirty: false, disk: text, view: null, ro: true });
  }
  if (!A.tabs.includes(id)) A.tabs.push(id);
  activate(id); if (line) revealLine(line);
}
function openSpecial(id) { if (!A.tabs.includes(id)) A.tabs.push(id); activate(id); }
function activate(id) {
  const prev = A.active && A.buffers.get(A.active);
  if (prev && editor) prev.view = editor.saveViewState();
  A.active = id;
  const isFile = id && !id.startsWith('special:');
  $('#monaco').style.visibility = isFile ? 'visible' : 'hidden';
  $('#special').style.display = id && !isFile ? 'block' : 'none';
  $('#welcome').style.display = id ? 'none' : 'block';
  if (isFile) { const b = A.buffers.get(id); editor.updateOptions({ readOnly: !!b.ro }); editor.setModel(b.model); if (b.view) editor.restoreViewState(b.view); editor.focus(); }
  else if (id) renderSpecial();
  else renderWelcome();
  renderTabs(); renderCrumbs(); renderStatus(); renderSheet(); if (A.activity === 'explorer') renderSidebar();
}
function revealLine(line) {
  if (!editor) return;
  editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 });
  editor.setSelection(new monacoRef.Selection(line, 1, line, editor.getModel().getLineMaxColumn(line))); editor.focus();
}
async function closeTab(id) {
  const b = A.buffers.get(id);
  if (b && b.dirty) {
    if (!confirm(`${id} has unsaved changes. Close it and lose them?`)) return;
  }
  A.tabs = A.tabs.filter(t => t !== id);
  if (b) { b.model.dispose(); A.buffers.delete(id); if (id === A.cfg.model) { await loadModel(); recompile(); } else if (REG_DIRS.some(d => id.startsWith(d + '/'))) { await loadRegistry(); recompile(); } }
  if (id === 'special:canvas' && A.canvasApi) { A.canvasApi.destroy(); A.canvasApi = null; }
  activate(A.active === id ? A.tabs[A.tabs.length - 1] || null : A.active);
  renderAll();
}
async function save(id = A.active) {
  const b = A.buffers.get(id); if (!b || b.ro) return;
  const text = b.model.getValue();
  try { await host.write(id, text); b.dirty = false; b.disk = text; renderTabs(); } catch (e) { toast(`Couldn't save ${id}: ${e.message}`, 'error'); }
}
const recompileSoon = debounce(() => { recompile(); renderAll({ keepEditor: true }); }, 200);
const registrySoon = debounce(async () => { await loadRegistry(); recompile(); renderAll({ keepEditor: true }); }, 250);
const settingsSoon = debounce(async () => { await loadSettings(); await loadModel(); recompile(); renderAll({ keepEditor: true }); }, 300);
function onBufferChange(path) {
  const b = A.buffers.get(path); if (!b) return;
  const dirty = b.model.getValue() !== b.disk;
  if (dirty !== b.dirty) { b.dirty = dirty; renderTabs(); }
  if (path === A.cfg.model) { A.modelText = b.model.getValue(); recompileSoon(); }
  else if (REG_DIRS.some(d => path.startsWith(d + '/'))) registrySoon();
  else if (path === 'designc.json') settingsSoon();
}
async function onDiskChanged(paths) {
  for (const p of paths) {
    const b = A.buffers.get(p);
    if (b && !b.dirty) { try { const t = await host.read(p); if (t !== b.model.getValue()) { b.disk = t; b.model.setValue(t); b.dirty = false; } } catch { /* deleted */ } }
  }
  const any = pre => paths.some(p => p === pre || p.startsWith(pre + '/'));
  if (paths.length) A.tree = await host.tree();
  if (paths.includes('designc.json')) { await loadSettings(); loadTelemetry(); }
  if (any('telemetry')) loadTelemetry();
  if (paths.includes(A.cfg.model) && !(A.buffers.get(A.cfg.model) || {}).dirty) await loadModel();
  if (REG_DIRS.some(any)) await loadRegistry();
  if (any('ledger')) await loadLedger();
  if (any('asbuilt')) await loadAsbuilt();
  recompile(); renderAll({ keepEditor: true });
}

// ---------------------------------------------------------------- registry actions
async function createAndOpen(path, text, selectLine) { await host.write(path, text); A.tree = await host.tree(); await openFile(path, selectLine); await loadRegistry(); recompile(); renderAll({ keepEditor: true }); }
const yamlList = a => `[${(a || []).map(x => /[:,\[\]{}#&*!|>'"%@`]/.test(x) ? JSON.stringify(x) : x).join(', ')}]`;
const yamlStr = s => JSON.stringify(String(s || ''));
async function recordDecision({ finding, statement = '', effect = 'fix', binds, resolves, checks = [], rationale = '', kind = 'technical', relies_on = [] } = {}) {
  if (!A.root) return;
  const id = Core.slugId(statement || (finding ? `${finding.code} ${(finding.loc.names || [])[0] || ''}` : 'decision'), A.decisions.map(d => d.id));
  if (finding) { binds = binds || finding.loc.names.slice(0, finding.loc.kind === 'element' ? 1 : 2); resolves = resolves || [finding.code]; }
  const business = kind === 'business';
  if (business && statement) statement = `PROPOSED: ${statement}`;
  const text = `id: ${id}
status: minted          # minted | checked | bound | superseded
kind: ${business ? 'business' : 'technical'}          # business | technical
effect: ${effect}             # fix (the model changes) | accept (keep the risk)
${relies_on.length ? `relies_on: ${yamlList(relies_on)}\n` : ''}${business ? 'evidence: ""             # https URL on a host in designc.json evidenceHosts\n' : ''}requirement: null
binds: ${yamlList(binds || [])}
resolves: ${yamlList(resolves || [])}
statement: ${statement ? yamlStr(statement) : 'TODO what was decided'}
checks:
${(checks.length ? checks : ['TODO command that proves it, e.g. p check -tc tcOptimistic']).map(c => `  - ${yamlStr(c)}`).join('\n')}
rationale: ${rationale ? yamlStr(rationale) : '""'}
`;
  await createAndOpen(`decisions/${id}.yaml`, text, statement ? null : 8);
}
async function newRequirement() {
  const id = prompt('Jira key for the requirement', 'HRE-') || ''; if (!id.trim()) return;
  await createAndOpen(`requirements/${id.trim()}.yaml`, `id: ${id.trim()}\ntitle: TODO\nsource: ""\nversion: 1\nelements: []\n`, 2);
}
async function newScenario() {
  const id = prompt('Scenario id', 'QAS-') || ''; if (!id.trim()) return;
  const text = `id: ${id.trim()}\ntitle: TODO\nattribute: availability   # availability, latency, ...\nartifact: TODO          # an element name in the model\nstimulus: TODO\nresponse: TODO\nmeasure: { metric: availability, op: ">=", value: 99.9, unit: "%" }\nrequirement: ""\nfitness: []             # shell commands; a pass or fail is recorded in the ledger\n`;
  await createAndOpen(`scenarios/${id.trim()}.yaml`, text, 3);
}
async function runFitness() {
  if (A.running) { toast('Checks are already running.'); return; }
  const targets = A.scenarios.filter(s => (s.fitness || []).some(c => c && !/^TODO/.test(c)));
  if (!targets.length) { toast('No scenario has a fitness function yet.', 'warning'); return; }
  A.running = true; showPanel('output'); renderStatus();
  appendOutput(`\n── ${new Date().toLocaleTimeString()}  running fitness functions for ${plural(targets.length, 'scenario')}\n`);
  try {
    for (const s of targets) for (const cmd of s.fitness.filter(c => c && !/^TODO/.test(c))) {
      appendOutput(`\n▶ ${s.id}  $ ${cmd}\n`);
      const r = await host.runCheck(`${s.id}-${Date.now()}`, cmd);
      if (r.cancelled) { appendOutput('Cancelled: folder not trusted.\n'); return; }
      const ok = r.code === 0;
      appendOutput(`${ok ? '✓ passed' : `✗ failed (exit ${r.code})`} in ${(r.ms / 1000).toFixed(1)}s\n`);
      await recordEvent('fitness', { scenario: s.id, check: cmd, outcome: ok ? 'pass' : 'fail', source: 'local', ms: r.ms, exit_code: r.code });
    }
  } finally { A.running = false; renderStatus(); }
}
async function newEval() {
  const id = prompt('Eval id', 'EV-') || ''; if (!id.trim()) return;
  const agent = prompt('Name of the agent element this eval judges', '') || '';
  const text = `id: ${id.trim()}\nagent: ${yamlStr(agent.trim() || 'TODO')}   # an element name in the model\ncommand: TODO               # shell command that writes the results file\nresults: evals/results/${id.trim()}.json   # {"metrics": {...}, "cases": N}\nthresholds:\n  - task_success >= 0.85\n# maxAge: 7d\n`;
  await createAndOpen(`evals/${id.trim()}.yaml`, text, 3);
}
// Runs one eval's command, reads its results file, scores it with the thresholds and records the verdict.
async function runEval(def) {
  const el = [...A.model.elements.values()].find(e => e.name === def.agent);
  if (!el) { toast(`Eval ${def.id}: "${def.agent}" is not in the model. Fix the agent name in ${def._path}.`, 'warning'); return; }
  appendOutput(`\n▶ ${def.id}  $ ${def.command}\n`);
  const r = await host.runCheck(`${def.id}-${Date.now()}`, def.command);
  if (r.cancelled) { appendOutput('Cancelled: folder not trusted.\n'); return false; }
  let results = null, why = '';
  try { results = JSON.parse(await host.read(def.results)); } catch (e) { why = `${def.results} could not be read as JSON: ${e.message}`; }
  const scored = results ? Core.scoreEval(def, results) : { error: why };
  const base = { eval: String(def.id), agent: def.agent, source: 'local', ms: r.ms, fingerprint: Core.fingerprint(A.model, el.id).hash, eval_hash: Core.evalHash(def) };
  let ev;
  if (scored.error) ev = { ...base, outcome: 'fail', metrics: {}, cases: 0, reason: scored.error, exit_code: r.code };
  else {
    ev = { ...base, outcome: scored.outcome === 'pass' && r.code === 0 ? 'pass' : 'fail', metrics: scored.metrics, cases: scored.cases, exit_code: r.code };
    if (ev.outcome === 'fail') ev.reason = scored.reason || `the command exited with ${r.code}`;
  }
  appendOutput(`${ev.outcome === 'pass' ? '✓ passed' : `✗ failed: ${ev.reason}`} in ${(r.ms / 1000).toFixed(1)}s\n`);
  await recordEvent('eval', ev);
  return true;
}
async function runEvals(only) {
  if (A.running) { toast('Checks are already running.'); return; }
  if (dirtyBuffers()) { toast('Save your open files first: an eval result is recorded against what is on disk.', 'warning'); return; }
  const rows = Core.evalReport({ model: A.model, evals: A.evals, ledger: A.ledger });
  const ids = new Set(rows.filter(r => !r.defInvalid && r.evalId && (!only || String(r.evalId) === String(only))).map(r => String(r.evalId)));
  const targets = A.evals.filter(e => ids.has(String(e.id)));
  if (!targets.length) { toast('No agent names a valid eval yet.', 'warning'); return; }
  A.running = true; showPanel('output'); renderStatus();
  appendOutput(`\n── ${new Date().toLocaleTimeString()}  running ${plural(targets.length, 'eval')}\n`);
  try { for (const d of targets) if (await runEval(d) === false) return; } finally { A.running = false; renderStatus(); }
}
async function newProposal(p = {}) {
  const id = Core.slugId(p.statement || p.kind || 'proposal', A.proposals.map(x => x.id));
  await createAndOpen(`proposals/${id}.yaml`, `id: ${id}
status: minted          # minted | checked | bound | rejected
kind: ${p.kind || 'lint rule'}         # lint rule | P property | grill-me question | gate clause | eval case | routing
evidence: ${yamlStr(p.evidence || '')}
statement: ${p.statement ? yamlStr(p.statement) : 'TODO the change to System 1 or System 2'}
check: ${yamlStr(p.check || '')}
${p.drafted ? 'drafted_by: llm\n' : ''}`, p.statement ? null : 5);
}
async function editYaml(path, fn) {
  const b = A.buffers.get(path);
  const text = b ? b.model.getValue() : await host.read(path);
  const next = fn(text);
  if (b) { b.model.pushEditOperations([], [{ range: b.model.getFullModelRange(), text: next }], () => null); await save(path); }
  else await host.write(path, next);
  await loadRegistry(); recompile(); renderAll({ keepEditor: true });
}
function setField(text, key, value) {
  const re = new RegExp(`^${key}:.*$`, 'm');
  return re.test(text) ? text.replace(re, `${key}: ${value}`) : text.replace(/\s*$/, `\n${key}: ${value}\n`);
}
async function bindDecision(d, { confirmed = false } = {}) {
  if (!confirmed && !confirm(`${d.status === 'bound' ? 'Re-bind' : 'Bind'} ${d.id}? Binding means you, ${A.user}, accept it as part of the design.`)) return;
  let against;
  if (d.kind === 'business') {
    const req = A.requirements.find(r => r.id === d.requirement);
    if (!req) { toast(`${d.id} is a business decision; set requirement to an existing requirement id before binding.`, 'warning'); return; }
    against = [{ requirement: req.id, version: req.version }];
  } else against = (d.binds || []).map(n => [...A.model.elements.values()].find(e => e.name === n)).filter(Boolean)
    .map(e => ({ element: e.ident || '', name: e.name, hash: Core.fingerprint(A.model, e.id).hash }));
  await editYaml(d._path, t => setField(setField(setField(setField(t, 'status', 'bound          # minted | checked | bound | superseded'), 'promoted_by', A.user), 'promoted_at', new Date().toISOString().slice(0, 10)), 'promoted_against', JSON.stringify(against)));
  await recordEvent('decision_promoted', { decision: d.id, fingerprints: against });
  if (!confirmed) toast(`${d.id} is bound.`);
}
// Human-only, like bindDecision: one confirmation for every decision the gate blocks on promotion.
async function rebindAll() {
  const ids = Core.rebindable(A.gate), list = ids.map(id => A.decisions.find(d => d.id === id)).filter(Boolean);
  if (!list.length) return;
  if (!confirm(`Re-bind ${list.map(d => d.id).join(', ')}?\n\nThis records the current state of what each one binds as accepted, as you, ${A.user}. Check the Compare tab first if the design changed on purpose or by accident.`)) return;
  for (const d of list) { await bindDecision(d, { confirmed: true }); await loadRegistry(); recompile(); }
  toast(`Re-bound ${plural(list.length, 'decision')}.`);
}
// Git facts for a gate event, or null with no usable repository. `commit` is null before the first commit.
async function gateGit() {
  let s; try { s = await host.gitStatus(); } catch { return null; }
  if (!s || !s.repo || !s.trusted || s.error) return null;
  return { commit: s.head || null, dirty: Core.dirtyInputs(s.files || [], A.cfg).length > 0 };
}
// Record what the gate says now, unless the latest event from this source already says the same. Returns the git facts used.
async function recordGate(source, git) {
  if (git === undefined) git = await gateGit();
  const modelText = (await host.read(A.cfg.model)) || '';
  const ev = Core.gateRecord({ modelText, diags: A.diags, gate: A.gate, source, git });
  if (!Ledger.gateUnchanged(A.ledgerRaw, ev)) await recordEvent('gate', ev);
  return git;
}
async function freezeHandover() {
  if (!A.gate || !A.gate.ready) { toast(`Not ready: ${plural(A.gate ? A.gate.clauses.length : 0, 'blocking item')}. See the gate in Design.`, 'warning', [{ label: 'Show gate', run: () => setActivity('design') }]); return; }
  if (dirtyBuffers()) { toast('Save your open files before freezing: a handover copies what is on disk.', 'warning'); return; }
  let st = await host.gitStatus();
  if (st.repo && !st.trusted) {
    if (!await host.gitTrust()) { toast('Freezing needs git to check that what you freeze is committed. Trust this folder, or freeze from a registry outside git.', 'warning'); return; }
    st = await host.gitStatus();
  }
  if (st.repo && st.error) { toast(`Cannot read git status: ${st.error}`, 'error'); return; }
  const dirty = st.repo ? Core.dirtyInputs(st.files || [], A.cfg) : [];
  if (dirty.length) { toast(`Commit before freezing: ${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ` and ${dirty.length - 3} more` : ''} ${dirty.length === 1 ? 'has' : 'have'} uncommitted changes. A handover must name a commit.`, 'warning', [{ label: 'Open source control', run: () => setActivity('scm') }]); return; }
  const boundIds = new Set(A.decisions.filter(d => d.status === 'bound').map(d => d.id));
  const read = async (dir, exts) => (await host.list(dir, exts)).map(f => ({ path: f.path, text: f.text }));
  const decisions = [];
  for (const d of A.decisions.filter(d => boundIds.has(d.id))) decisions.push({ path: d._path, text: (await host.read(d._path)) || '' });
  const plan = Core.handoverPlan({
    date: new Date().toISOString().slice(0, 10), now: new Date().toISOString(), by: A.user,
    model: { path: A.cfg.model, text: (await host.read(A.cfg.model)) || '' },
    requirements: await read('requirements', ['.yaml', '.yml']),
    decisions,
    behaviour: await read('behaviour', ['.p']),
    vocabulary: await read('vocabulary', ['.yaml', '.yml']),
    evals: await read('evals', ['.yaml', '.yml']),
  });
  for (const f of plan.files) await host.write(f.path, f.text);
  const rev = plan.files[0].text.match(/^revision: r-(\w+)/m)[1];
  const git = await recordGate('local', st.repo ? { commit: st.head || null, dirty: false } : null);
  await recordEvent('handover', { handover: plan.id, revision: rev, commit: git ? git.commit : null, dirty: false });
  A.tree = await host.tree(); await loadRegistry(); recompile(); renderAll({ keepEditor: true });
  toast(`Handover ${plan.id} frozen at r-${rev}.`);
  if (G.state.repo && G.state.trusted) { // pre-fill the commit: staged, message written, review in Source control
    await host.gitStage([`handovers/${plan.id}`]); G.msg = `Freeze handover ${plan.id}`; await gitRefresh(); setActivity('scm');
  }
}

// ---------------------------------------------------------------- checks
function appendOutput(s) { A.output += s; if (A.panel === 'output' && A.panelOpen) { const pre = $('#panelBody pre'); if (pre) { pre.textContent = A.output; $('#panelBody').scrollTop = 1e9; } else renderPanel(); } }
async function runChecks(list) {
  if (A.running) { toast('Checks are already running.'); return; }
  const targets = (list || A.decisions).filter(d => (d.checks || []).some(c => c && !/^TODO/.test(c)));
  if (!targets.length) { toast('No decision has a runnable check yet.', 'warning'); return; }
  A.running = true; showPanel('output'); renderStatus();
  appendOutput(`\n── ${new Date().toLocaleTimeString()}  running checks for ${plural(targets.length, 'decision')} in ${A.root.name}\n`);
  try {
    for (const d of targets) {
      let pass = true;
      for (const cmd of d.checks.filter(c => c && !/^TODO/.test(c))) {
        appendOutput(`\n▶ ${d.id}  $ ${cmd}\n`);
        const r = await host.runCheck(`${d.id}-${Date.now()}`, cmd);
        if (r.cancelled) { appendOutput('Cancelled: folder not trusted.\n'); return; }
        const ok = r.code === 0; pass = pass && ok;
        appendOutput(`${ok ? '✓ passed' : `✗ failed (exit ${r.code})`} in ${(r.ms / 1000).toFixed(1)}s\n`);
        await recordEvent('check', { decision: d.id, check: cmd, outcome: ok ? 'pass' : 'fail', source: 'local', ms: r.ms, exit_code: r.code });
      }
      appendOutput(`${pass ? '●' : '○'} ${d.id} ${pass ? 'passing' : 'failing'}\n`);
    }
  } finally { A.running = false; renderStatus(); }
}

// ---------------------------------------------------------------- LLM (grill-me, proposal drafting)
function parseJson(text) { const t = String(text || '').replace(/^[\s\S]*?```(?:json)?\s*/i, m => (m.includes('```') ? '' : m)).replace(/```[\s\S]*$/, ''); const s = t.indexOf('{'), e = t.lastIndexOf('}'); return JSON.parse(t.slice(s, e + 1)); }
function llmError(r) {
  if (r.error === 'not_configured') return ['Grill-me needs a model. Set llm.baseUrl and llm.model in designc.json (your LiteLLM gateway, OpenAI-compatible).', [{ label: 'Open designc.json', run: () => openFile('designc.json') }]];
  if (r.error === 'no_key') return [`Set the ${r.env} environment variable to your gateway key, then restart designc.`, []];
  if (r.error === 'http') return [`The gateway answered ${r.status}: ${r.message}`, []];
  return [`Couldn't reach the gateway: ${r.message || r.error}`, []];
}
async function grill() {
  if (!A.root || A.grill.busy) return;
  setActivity('design'); A.grill.busy = true; A.grill.error = null; renderSidebar();
  const live = A.diags.filter(f => !f.suppressed).map(f => `${f.code} ${f.sev} on ${f.loc.label} (line ${f.loc.line}): ${f.msg}`);
  const needs = A.ledger.filter(e => e.kind === 'needs_decision' && e.status === 'open').map(e => `${e.id}: ${e.question} (task ${e.task}, element ${e.element})`);
  const sys = 'You are grill-me, the interrogation step of a system design compiler at a reinsurance company. The design (Structurizr DSL with d.* design properties) is the source of truth; code is generated from it. You ask questions; you never decide.';
  const user = `Ask the 3 to 5 questions the designer most needs to answer before this design is handed to the coding pipeline. Prioritise error findings, undeclared properties on critical paths, open needs-decision items from the pipeline, and untraced requirements. Each question must be concrete and about this design. Set business=true only when a product owner, not an engineer, must answer.

MODEL:
${A.modelText.slice(0, 30000)}

OPEN FINDINGS:
${live.join('\n') || 'none'}

DECISIONS:
${A.decisions.map(d => `${d.id} [${d.status}, ${d.effect}] ${d.statement}`).join('\n') || 'none'}

REQUIREMENTS:
${A.requirements.map(r => `${r.id}: ${r.title} -> ${(r.elements || []).join(', ')}`).join('\n') || 'none'}

WAITING ON A DECISION:
${needs.join('\n') || 'none'}

Reply with JSON only:
{"questions":[{"question":"...","why":"one sentence tying it to a finding, requirement or pipeline item","code":"DC00n or null","element":"exact element name or null","business":false,"suggested_decision":"...","suggested_effect":"fix or accept","suggested_check":"command that proves it"}]}`;
  const r = await host.chat([{ role: 'system', content: sys }, { role: 'user', content: user }]);
  A.grill.busy = false;
  if (r.error) { const [msg, acts] = llmError(r); A.grill.error = msg; toast(msg, 'warning', acts); }
  else { try { A.grill.questions = (parseJson(r.text).questions || []).slice(0, 5); } catch { A.grill.error = 'Grill-me replied without usable JSON. Try again.'; } }
  renderSidebar();
}
async function draftProposals() {
  if (A.drafting) return;
  const escapes = A.ledger.filter(e => e.kind === 'escape').map(e => ({ id: e.id, element: e.element, description: e.description, caught_by: e.caught_by || null, code: e.code || null }));
  if (!escapes.length) { toast('There are no escapes to learn from yet.'); return; }
  A.drafting = true; renderSidebar();
  const r = await host.chat([
    { role: 'system', content: 'You are the analyst in the improvement system (System 4) of a design-to-code factory. You propose changes to the factory, never to the product, and never apply them.' },
    { role: 'user', content: `System 1 is a design compiler (lint rules DC001-DC006, P behavioural models, grill-me questions, a definition-of-ready gate). System 2 is an agentic coding pipeline (planner, executor agents, routing, verify).
RULES: ${JSON.stringify(Core.RULES.map(x => ({ code: x.code, title: x.title, source: x.source })))}
ESCAPES: ${JSON.stringify(escapes)}
EXISTING PROPOSALS: ${JSON.stringify(A.proposals.map(p => p.statement))}
Propose up to 3 changes. Each cites one escape id, targets the stage that should have caught it, does not duplicate an existing proposal, and says how to prove it works.
Reply with JSON only: {"proposals":[{"kind":"lint rule|P property|grill-me question|gate clause|eval case|routing","statement":"...","evidence":"escape id","check":"..."}]}` }]);
  A.drafting = false;
  if (r.error) { const [msg, acts] = llmError(r); toast(msg, 'warning', acts); renderSidebar(); return; }
  let list = []; try { list = parseJson(r.text).proposals || []; } catch { toast('The analyst replied without usable JSON. Try again.', 'warning'); }
  for (const p of list.slice(0, 3)) await newProposal({ ...p, drafted: true });
  renderSidebar();
}

// ---------------------------------------------------------------- views: shell
function setActivity(a) {
  if (A.activity === a && A.sidebarOpen) { A.sidebarOpen = false; }
  else { A.activity = a; A.sidebarOpen = true; }
  $('#shell').classList.toggle('nosidebar', !A.sidebarOpen);
  document.querySelectorAll('#activity button').forEach(b => b.setAttribute('aria-selected', String(A.sidebarOpen && b.dataset.act === a)));
  if (a === 'build' && A.sidebarOpen && A.root) openSpecial('special:build');
  if (a === 'improve' && A.sidebarOpen && A.root) openSpecial('special:improve');
  if (a === 'codemap' && A.sidebarOpen && A.root) openSpecial('special:codemap');
  if (a === 'canvas' && A.sidebarOpen && A.root) openSpecial('special:canvas');
  if (a === 'deployment' && A.sidebarOpen && A.root) openSpecial('special:deployment');
  renderSidebar();
}
function showPanel(p) { A.panel = p; A.panelOpen = true; $('#workbench').classList.remove('nopanel'); renderPanel(); }
function renderAll() {
  renderTabs(); renderCrumbs(); renderSidebar(); renderSheet(); renderPanel(); renderStatus(); renderBadges();
  if (A.active && A.active.startsWith('special:')) renderSpecial();
  if (!A.active) renderWelcome();
}
function renderBadges() {
  const g = A.gate && A.model && A.model.elements.size ? A.gate.clauses.length : 0;
  const b1 = $('#badge-design'); b1.textContent = g; b1.className = 'badge' + (g ? ' on bad' : '');
  const nd = A.ledger.filter(e => e.kind === 'needs_decision' && e.status === 'open').length;
  const b2 = $('#badge-build'); b2.textContent = nd; b2.className = 'badge' + (nd ? ' on' : '');
  const un = A.ledger.filter(e => e.kind === 'escape' && !e.caught_by).length;
  const un2 = un + (A.tel.runs.length ? telSuggestions().length : 0);
  const b3 = $('#badge-improve'); b3.textContent = un2; b3.className = 'badge' + (un2 ? ' on' : '');
  const nf = G.state && G.state.trusted && G.state.files ? G.state.files.length : 0;
  const b5 = $('#badge-scm'); b5.textContent = nf; b5.className = 'badge' + (nf ? ' on' : '');
  const dc = A.drift ? A.drift.undeclared.length + A.drift.unknownEls.length : 0;
  const b4 = $('#badge-codemap'); b4.textContent = dc; b4.className = 'badge' + (dc ? ' on' : '');
}
function tabTitle(id) { return id === 'special:compare' ? 'Compare' : id === 'special:build' ? 'Build' : id === 'special:improve' ? 'Improve' : id === 'special:codemap' ? 'Code map' : id === 'special:canvas' ? 'Canvas' : id === 'special:deployment' ? 'Deployment' : id.split('/').pop(); }
function renderTabs() {
  $('#tabs').innerHTML = A.tabs.map(id => {
    const b = A.buffers.get(id); const [cls, ch] = id.startsWith('special:') ? ['special', id === 'special:compare' ? 'GIT' : id === 'special:build' ? 'S2' : id === 'special:codemap' ? 'AB' : id === 'special:canvas' ? 'CV' : id === 'special:deployment' ? 'DP' : 'S4'] : iconFor(id.replace(/^code:/, ''));
    return `<div class="tab ${id === A.active ? 'active' : ''} ${b && b.dirty ? 'dirty' : ''}" data-tab="${esc(id)}" title="${esc(id)}" role="tab" aria-selected="${id === A.active}"><span class="ticon ${cls}">${esc(ch)}</span>${esc(tabTitle(id))}<button class="x" data-close="${esc(id)}" aria-label="Close ${esc(tabTitle(id))}">✕</button></div>`;
  }).join('');
}
function renderCrumbs() {
  const id = A.active;
  $('#crumbs').innerHTML = !id ? '' : id.startsWith('special:') ? `<span>${esc(A.root ? A.root.name : '')}</span>›<span>${{ 'special:build': 'Build (System 2)', 'special:improve': 'Improve (System 4)', 'special:codemap': 'Code map (as built)', 'special:canvas': 'Canvas (draw the design)', 'special:deployment': 'Deployment (where it runs)', 'special:compare': 'Compare with revision' }[id]}</span>`
    : id.startsWith('code:') ? [String(A.cfg.codebase || '').split('/').pop(), ...id.slice(5).split('/')].map(esc).join(' › ') + ' <span style="margin-left:8px">(read-only)</span>'
    : [A.root ? A.root.name : '', ...id.split('/')].map(esc).join(' › ');
}
function renderStatus() {
  const st = $('#status');
  if (!A.root) { st.className = 'statusbar nofolder'; st.innerHTML = `<button data-s="open">No folder open</button>`; return; }
  st.className = 'statusbar';
  const live = A.diags.filter(d => !d.suppressed);
  const e = live.filter(d => d.sev === 'error').length + A.model.errors.length + A.yamlErrors.length + A.ledgerErrors.length, w = live.filter(d => d.sev === 'warning').length;
  const g = A.gate; const hasModel = A.model && A.model.elements.size;
  const pos = A.cursor && A.active && !A.active.startsWith('special:') ? `Ln ${A.cursor.lineNumber}, Col ${A.cursor.column}` : '';
  const lang = A.active && !A.active.startsWith('special:') ? ({ structurizr: 'Structurizr DSL', yaml: 'YAML', p: 'P', json: 'JSON', markdown: 'Markdown', csharp: 'C#', fsharp: 'F#', xml: 'XML', python: 'Python', typescript: 'TypeScript', javascript: 'JavaScript', sql: 'SQL' }[langFor(A.active)] || 'Plain Text') : '';
  const llm = A.cfg.llm && A.cfg.llm.baseUrl && A.cfg.llm.model ? `LLM: ${A.cfg.llm.model}` : 'LLM: not configured';
  st.innerHTML = `<button data-s="folder" title="${esc(A.root.root)}">${esc(A.root.name)}</button>
    <button data-s="problems" title="Problems"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></svg>${e}<svg viewBox="0 0 16 16"><path d="M8 2l6.5 12h-13z"/><path d="M8 6.5v3.5M8 12v.5"/></svg>${w}</button>
    ${A.running ? '<button data-s="output">Running checks…</button>' : ''}
    ${gitStatusButton()}
    <div class="spacer"></div>
    ${pos ? `<button>${pos}</button>` : ''}${lang ? `<button>${lang}</button>` : ''}
    <button data-s="tel" title="Langfuse telemetry (click to refresh)">${A.tel.loading ? 'Langfuse: loading…' : A.tel.error ? (A.tel.error.error === 'not_configured' ? 'Langfuse: off' : 'Langfuse: error') : A.tel.meta ? `Langfuse${A.tel.meta.source === 'sample' ? ' (sample)' : ''}: ${plural(A.tel.runs.length, 'run')}` : 'Langfuse: off'}</button>
    <button data-s="llm" title="Model gateway for grill-me and drafting">${esc(llm)}</button>
    ${hasModel ? `<button>r-${hash(A.modelText)}</button><button data-s="gate" class="${g.ready ? '' : 'gate-no'}" title="Definition of ready">${g.ready ? 'Gate: ready to hand over' : `Gate: ${g.clauses.length} blocking`}</button>` : ''}`;
}

// ---------------------------------------------------------------- sidebar
function section(key, title, body, actions = '') {
  const closed = A.collapsed.has(key);
  return `<div class="sec ${closed ? 'closed' : ''}" data-sec="${key}"><div class="sec-h" data-toggle="${key}"><span class="tw">${closed ? '▸' : '▾'}</span>${esc(title)}<span class="acts">${actions}</span></div><div class="sec-b">${body}</div></div>`;
}
function renderSidebar() {
  const titles = { explorer: 'Explorer', design: 'Design · System 1', codemap: 'Code map · as built', build: 'Build · System 2', improve: 'Improve · System 4', scm: 'Source control', deployment: 'Deployment' };
  $('#sbTitle').textContent = titles[A.activity];
  const body = $('#sbBody');
  if (!A.root) { body.innerHTML = `<div class="hint">You have not opened a folder yet.</div><button class="btn primary block" data-a="open">Open Folder</button><button class="btn block" data-a="sample">Open Sample Registry</button>`; return; }
  if (A.activity === 'explorer') body.innerHTML = section('files', A.root.name, treeHTML(A.tree, 0) || '<div class="hint">This folder is empty.</div>');
  else if (A.activity === 'design') body.innerHTML = designSidebar();
  else if (A.activity === 'build') body.innerHTML = buildSidebar();
  else if (A.activity === 'codemap') body.innerHTML = codemapSidebar();
  else if (A.activity === 'scm') body.innerHTML = gitSidebar();
  else if (A.activity === 'deployment') body.innerHTML = deploymentSidebar();
  else body.innerHTML = improveSidebar();
  if (A.activity === 'explorer') body.innerHTML += gitHistorySection();
  if (A.activity === 'explorer') body.innerHTML += handoverCompareSection();
}
function treeHTML(nodes, depth) {
  return nodes.map(n => {
    const pad = `style="--indent:${12 + depth * 12}px"`;
    if (n.dir) {
      const open = A.expanded.has(n.path);
      return `<div class="row" ${pad} data-dir="${esc(n.path)}"><span class="tw">${open ? '▾' : '▸'}</span><span class="lbl">${esc(n.name)}</span></div>${open ? treeHTML(n.children, depth + 1) : ''}`;
    }
    const [, ch] = iconFor(n.path); const b = A.buffers.get(n.path);
    const errs = n.path === A.cfg.model ? A.diags.filter(d => !d.suppressed && d.sev === 'error').length + A.model.errors.length : [...A.yamlErrors, ...A.ledgerErrors].filter(e => e.path === n.path).length;
    return `<div class="row ${A.active === n.path ? 'active' : ''}" ${pad} data-file="${esc(n.path)}"><span class="tw"></span><span class="fi">${esc(ch)}</span><span class="lbl" style="${errs ? 'color:var(--err)' : ''}">${esc(n.name)}${b && b.dirty ? ' ●' : ''}</span>${errs ? `<span class="desc" style="color:var(--err)">${errs}</span>` : ''}</div>`;
  }).join('');
}
function checkState(id) { const l = Core.latestCheck(A.ledger, id); return l ? (l.outcome === 'pass' ? 'pass' : 'fail') : ''; }
function designSidebar() {
  const g = A.gate, hasModel = A.model && A.model.elements.size;
  let gate;
  if (!hasModel) gate = `<div class="hint">No model at <b>${esc(A.cfg.model)}</b>.</div><button class="btn block" data-a="newmodel">Create ${esc(A.cfg.model)}</button>`;
  else gate = `<div class="verdict ${g.ready ? 'ok' : 'no'}">${g.ready ? '✓ Ready to hand over' : `✗ ${plural(g.clauses.length, 'blocking item')}`}</div>` +
    g.clauses.map((c, i) => `<div class="clause" data-clause="${i}"><span class="k">${{ parse: 'model', finding: 'finding', decision: 'decision', check: 'check', requirement: 'requirement', needs: 'pipeline', scenario: 'scenario', promotion: 'promotion', eval: 'eval', duplicate: 'duplicate' }[c.kind]}</span><span>${esc(c.text)}</span>${c.kind === 'eval' && c.agent && c.evalId ? `<button class="lnk" data-runeval="${esc(String(c.evalId))}">Run eval</button>` : ''}</div>`).join('') +
    (Core.rebindable(g).length ? `<button class="btn block" data-a="rebindall" title="Records the current state of what each decision binds as accepted">Re-bind ${plural(Core.rebindable(g).length, 'decision')}</button>` : '') +
    (g.ready ? '<button class="btn primary block" data-a="freeze">Freeze handover</button>' : '');
  const decs = A.decisions.map(d => `<div class="item" data-open="${esc(d._path)}">
      <div class="l1"><span class="dot ${checkState(d.id)}" title="${checkState(d.id) === 'pass' ? 'Last check passed' : checkState(d.id) === 'fail' ? 'Last check failed' : 'No check result yet'}"></span><span class="id">${esc(d.id)}</span><span class="tag ${esc(d.status)}">${esc(d.status)}</span>${d.effect === 'accept' ? '<span class="tag">accepted risk</span>' : ''}</div>
      <div class="l2">${esc(d.statement || 'No statement yet')}</div>
      <div class="acts">${d.status !== 'bound' ? `<button class="lnk" data-bind="${esc(d.id)}">Bind</button>` : Core.rebindable(A.gate).includes(d.id) ? `<button class="lnk" data-bind="${esc(d.id)}">Re-bind</button>` : ''}${(d.checks || []).some(c => c && !/^TODO/.test(c)) ? `<button class="lnk" data-run="${esc(d.id)}">Run check</button>` : ''}</div></div>`).join('')
    || '<div class="hint">No decisions yet. Use the lightbulb on a problem in the model, or the + above.</div>';
  const reqs = A.requirements.map(r => `<div class="item" data-open="${esc(r._path)}"><div class="l1"><span class="id">${esc(r.id)}</span></div><div class="l2">${esc(r.title || '')}${(r.elements || []).length ? ` → ${esc(r.elements.join(', '))}` : ''}</div></div>`).join('')
    || '<div class="hint">No requirements yet. Add the Jira keys this design answers.</div>';
  const scn = Core.scenarioReport({ model: A.model, scenarios: A.scenarios, ledger: A.ledger }).map((r, i) => {
    const s = A.scenarios[i], an = r.analytic;
    const state = r.status === 'unresolved' ? 'fail' : an.status === 'not-met' || r.fitness.status === 'failing' ? 'fail' : an.status === 'met' || r.fitness.status === 'passing' ? 'pass' : '';
    const note = r.status === 'unresolved' ? `artifact "${esc(r.artifact)}" is not in the model` : an.status === 'met' || an.status === 'not-met' ? `availability ≈ ${an.value.toFixed(2)}%` : an.status === 'unknown' ? `declare d.availability on ${esc(an.missing.join(', '))}` : '';
    return `<div class="item" data-open="${esc(s._path)}"><div class="l1"><span class="dot ${state}"></span><span class="id">${esc(r.id)}</span><span class="tag">${esc(r.attribute || '')}</span></div><div class="l2">${esc(r.title)}${note ? ` · ${note}` : ''}${r.fitness.status !== 'none' ? ` · fitness ${r.fitness.status}` : ''}</div></div>`;
  }).join('') || '<div class="hint">No scenarios yet. A scenario states a stimulus, the artifact it hits, the response and a measure.</div>';
  const evr = Core.evalReport({ model: A.model, evals: A.evals, ledger: A.ledger });
  const evs = evr.map(r => {
    const dot = r.status === 'passing' ? 'pass' : r.status === 'failing' || r.status === 'invalid' ? 'fail' : '';
    const def = A.evals.find(e => String(e.id) === String(r.evalId));
    const metrics = r.thresholds.map(t => `${esc(t.metric)} ${t.actual === null ? '–' : esc(String(t.actual))} (${esc(t.op)} ${esc(String(t.value))})`).join(', ');
    return `<div class="item" ${def ? `data-open="${esc(def._path)}"` : ''}><div class="l1"><span class="dot ${dot}"></span><span class="id">${esc(r.agent)}</span><span class="tag">${esc(r.autonomy)}</span><span class="tag ${r.status === 'passing' ? '' : 'open'}">${esc(r.status)}</span></div>
      <div class="l2">${r.reason ? esc(r.reason) : metrics}${r.autonomy === 'suggest' && r.status !== 'passing' ? ' · suggest agents are not blocked' : ''}</div>
      ${def && !r.defInvalid ? `<div class="acts"><button class="lnk" data-runeval="${esc(String(def.id))}">Run eval</button></div>` : ''}</div>`;
  }).join('') || '<div class="hint">No agent declares d.agent.autonomy yet. An agent that approves writes or acts alone needs an eval with thresholds.</div>';
  const G = A.grill;
  const grillBody = `<div class="hint">Reads the model, open findings, decisions and anything the pipeline is waiting on, then asks what most needs an answer.</div>
    <button class="btn block ${G.questions.length ? '' : 'primary'}" data-a="grill" ${G.busy || !hasModel ? 'disabled' : ''}>${G.busy ? 'Reading the design…' : G.questions.length ? 'Ask again' : 'Start grill-me'}</button>
    ${G.error ? `<div class="hint" style="color:var(--warn)">${esc(G.error)}</div>` : ''}
    ${G.questions.map((q, i) => `<div class="q"><div class="qq">${esc(q.question)}</div><div class="why">${q.code ? `<span class="code">${esc(q.code)}</span> ` : ''}${q.element ? `<b>${esc(q.element)}</b>. ` : ''}${esc(q.why || '')}</div>
      ${q.business ? '<div class="biz">For the business: post it on the Jira issue.</div>' : ''}
      <textarea data-ans="${i}" placeholder="Your answer">${esc(q.answer || '')}</textarea><div style="margin-top:6px"><button class="lnk" data-qdraft="${i}">Draft decision from answer</button> <button class="lnk" data-qbiz="${i}">Draft business decision</button></div></div>`).join('')}`;
  return section('gate', 'Ready gate', gate)
    + section('decisions', `Decisions (${A.decisions.length})`, decs, `<button title="New decision" data-a="newdec">+</button><button title="Run all checks" data-a="runall">▶</button>`)
    + section('reqs', `Requirements (${A.requirements.length})`, reqs, `<button title="New requirement" data-a="newreq">+</button>`)
    + section('scenarios', `Scenarios (${A.scenarios.length})`, scn, `<button title="New scenario" data-a="newscn">+</button><button title="Run all fitness functions" data-a="runfit">▶</button>`)
    + section('evals', `Evals (${A.evals.length})`, evs, `<button title="New eval" data-a="neweval">+</button><button title="Run all evals" data-a="runevals">▶</button>`)
    + section('grill', 'Grill-me', grillBody);
}
function buildSidebar() {
  const tasks = A.ledger.filter(e => e.kind === 'task'), passed = tasks.filter(t => t.status === 'passed');
  const tokens = tasks.reduce((a, t) => a + Ledger.totalTokens(t), 0);
  const needs = A.ledger.filter(e => e.kind === 'needs_decision' && e.status === 'open');
  const summary = tasks.length ? `<div class="hint">${passed.length} of ${plural(tasks.length, 'task')} passed. ${passed.length ? `${fmtN(tokens / passed.length)} tokens per passing task.` : ''}</div>` : '<div class="hint">No pipeline events in ledger/*.jsonl yet.</div>';
  const nd = needs.map(n => `<div class="item"><div class="l1"><span class="id">${esc(n.id)}</span><span class="tag open">open</span><span class="desc">${esc(n.element || '')}</span></div><div class="l2">${esc(n.question)}</div>
      <div class="acts"><button class="lnk" data-ndans="${esc(n.id)}">Answer with a decision</button><button class="lnk" data-ndres="${esc(n.id)}">Mark resolved</button></div></div>`).join('') || '<div class="hint">Nothing is waiting on the design.</div>';
  return section('bsum', 'Summary', summary + '<button class="btn block" data-a="builddash">Open Build dashboard</button>') + section('needs', `Waiting on a decision (${needs.length})`, nd);
}
function improveSidebar() {
  const escapes = A.ledger.filter(e => e.kind === 'escape'), un = escapes.filter(e => !e.caught_by);
  const uh = un.map(e => `<div class="item"><div class="l1"><span class="id">${esc(e.id)}</span><span class="desc">${esc(e.element || '')}</span></div><div class="l2">${esc(e.description || '')}</div>
      <div class="acts"><select class="inline" data-classify="${esc(e.id)}" aria-label="Stage that should have caught ${esc(e.id)}"><option value="">Should have been caught by…</option>${STAGES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div></div>`).join('') || '<div class="hint">Every escape is classified.</div>';
  const props = A.proposals.map(p => `<div class="item" data-open="${esc(p._path)}"><div class="l1"><span class="id">${esc(p.id)}</span><span class="tag ${esc(p.status || 'minted')}">${esc(p.status || 'minted')}</span><span class="desc">${esc(p.kind || '')}</span></div><div class="l2">${esc(p.statement || '')}</div></div>`).join('') || '<div class="hint">No proposals yet.</div>';
  const sug = telSuggestions();
  const sh = sug.map(t => `<div class="item"><div class="l1"><span class="id">${esc(t.task)}</span><span class="desc">${esc(t.element || '')}</span></div><div class="l2">${esc(t.why)}</div><div class="acts"><button class="lnk" data-telesc="${esc(t.task)}">Record as escape</button></div></div>`).join('');
  return (sug.length ? section('telsug', `Suggested by telemetry (${sug.length})`, sh) : '') + section('unclass', `Unclassified escapes (${un.length})`, uh)
    + section('props', `Proposals (${A.proposals.length})`, props + `<button class="btn block" data-a="draftprops" ${A.drafting ? 'disabled' : ''}>${A.drafting ? 'Drafting…' : 'Draft proposals from escapes'}</button>`, `<button title="New proposal" data-a="newprop">+</button>`)
    + section('idash', 'Dashboard', '<button class="btn block" data-a="improvedash">Open Improve dashboard</button>');
}

// ---------------------------------------------------------------- panel
function renderPanel() {
  const live = A.diags.filter(d => !d.suppressed);
  const total = live.length + A.model.errors.length + A.yamlErrors.length + A.ledgerErrors.length;
  $('#probCount').textContent = A.root ? total : '';
  document.querySelectorAll('[data-panel]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.panel === A.panel)));
  $('#panelClear').style.display = A.panel === 'output' ? '' : 'none';
  const body = $('#panelBody');
  if (A.panel === 'output') { body.innerHTML = `<pre class="out">${esc(A.output || 'Check runs appear here. Run > Run All Decision Checks (Ctrl+Shift+B).')}</pre>`; body.scrollTop = 1e9; return; }
  if (!A.root) { body.innerHTML = '<div class="pempty">No problems have been detected in the workspace.</div>'; return; }
  const groups = [];
  const mrows = [...A.model.errors.map(e => ({ sev: 'error', msg: e.msg, code: 'parse', line: e.line })),
    ...live.map((f, i) => ({ sev: f.sev, msg: `${f.loc.label}: ${f.msg}`, code: f.code, line: f.loc.line, fi: A.diags.indexOf(f), unknown: f.unknown }))];
  if (mrows.length) groups.push([A.cfg.model, mrows]);
  const byPath = new Map();
  for (const e of [...A.yamlErrors, ...A.ledgerErrors]) { if (!byPath.has(e.path)) byPath.set(e.path, []); byPath.get(e.path).push({ sev: 'error', msg: e.msg, code: 'yaml', line: e.line }); }
  const seenP = new Set();
  for (const x of A.proposals) { if (seenP.has(x.id) && x._path) { if (!byPath.has(x._path)) byPath.set(x._path, []); byPath.get(x._path).push({ sev: 'error', msg: `duplicate id ${x.id}`, code: 'id', line: 1 }); } seenP.add(x.id); }
  groups.push(...byPath);
  if (!groups.length) { body.innerHTML = '<div class="pempty">No problems have been detected in the workspace.</div>'; return; }
  const supp = A.diags.length - live.length;
  body.innerHTML = groups.map(([path, rows]) => `<div class="pfile" data-open="${esc(path)}"><span class="fi">${esc(iconFor(path)[1])}</span>${esc(path.split('/').pop())}<span class="desc">${esc(path)}</span><span class="count">${rows.length}</span></div>` +
    rows.map(r => `<div class="prow" data-open="${esc(path)}" data-line="${r.line || ''}"><span class="ic ${r.sev}">${r.sev === 'error' ? '⊗' : r.sev === 'warning' ? '⚠' : 'ⓘ'}</span><span class="m">${esc(r.msg)}${r.unknown ? ' <span class="src">(undeclared property)</span>' : ''}</span>
      ${r.fi != null && r.code !== 'DC000' ? `<button class="lnk fix" data-fixfi="${r.fi}">Record decision</button>` : ''}<span class="src">designc(${esc(r.code)}) [Ln ${r.line || 1}]</span></div>`).join('')).join('')
    + (supp ? `<div class="pempty">${plural(supp, 'finding')} suppressed in the model with a reason.</div>` : '');
}

// ---------------------------------------------------------------- welcome
function renderWelcome() {
  const w = $('#welcome');
  if (A.root) {
    w.innerHTML = `<div class="wl"><h1>${esc(A.root.name)}<small>${esc(A.root.root)}</small></h1>
      <div><h2>Start</h2>${A.model && A.model.elements.size ? `<button class="l" data-file="${esc(A.cfg.model)}">Open the model (${esc(A.cfg.model)})</button>` : `<button class="l" data-a="newmodel">Create ${esc(A.cfg.model)}</button>`}
        <button class="l" data-a="design">Show the ready gate</button><button class="l" data-a="codemapopen">Code map of ${A.cfg.codebase ? esc(String(A.cfg.codebase).split('/').pop()) : 'a codebase'}</button><button class="l" data-a="builddash">Build dashboard (System 2)</button><button class="l" data-a="improvedash">Improve dashboard (System 4)</button></div>
      <div><h2>Keys</h2><table><tr><td>Ctrl+S</td><td>Save</td></tr><tr><td>Ctrl+Shift+B</td><td>Run all decision checks</td></tr><tr><td>Ctrl+Shift+G</td><td>Ask grill-me</td></tr><tr><td>Ctrl+Alt+V</td><td>Toggle the C4 sheet</td></tr><tr><td>Ctrl+.</td><td>Record a decision for a problem</td></tr><tr><td>Backspace, in the Code map</td><td>Up one level</td></tr></table></div></div>`;
    return;
  }
  w.innerHTML = `<div class="wl"><h1>designc<small>System design IDE: the design is the source, code is the build output.</small></h1>
    <div><h2>Start</h2><button class="l" data-a="open">Open Folder…</button><button class="l" data-a="sample">Open Sample Registry</button>
      ${A.recent.length ? `<h2 style="margin-top:22px">Recent</h2>${A.recent.map(r => `<button class="l" data-recent="${esc(r)}" title="${esc(r)}">${esc(r.split(/[\\/]/).pop())} <span style="color:var(--fg3)">${esc(r)}</span></button>`).join('')}` : ''}</div>
    <div><h2>A registry folder holds</h2><table>
      <tr><td>model/workspace.dsl</td><td>C4 model with d.* design properties</td></tr><tr><td>behaviour/*.p</td><td>P models, one per protocol</td></tr>
      <tr><td>requirements/*.yaml</td><td>Jira keys the design answers</td></tr><tr><td>decisions/*.yaml</td><td>Decisions, each with checks</td></tr>
      <tr><td>proposals/*.yaml</td><td>System 4 proposals</td></tr><tr><td>ledger/*.jsonl</td><td>Events from every system</td></tr>
      <tr><td>designc.json</td><td>Settings and model gateway</td></tr></table></div></div>`;
}

// ---------------------------------------------------------------- C4 sheet
// opts.groupEdges: also return rels with a grouped (container) end, resolved to node or group rects.
// They stay out of layering, so node and group geometry is the same with or without it.
function layout(m, opts = {}) {
  const all = [...m.elements.values()];
  const hasChild = new Set(all.filter(e => e.parent).map(e => e.parent));
  const leaves = all.filter(e => !hasChild.has(e.id)), leafSet = new Set(leaves.map(e => e.id));
  const edges = m.rels.filter(r => leafSet.has(r.src) && leafSet.has(r.dst) && r.src !== r.dst);
  // A unit is what gets layered and placed: a leaf, or (clustered) all leaves of one container, kept together in a grid.
  const unitOf = new Map(leaves.map(e => [e.id, e.id]));
  if (opts.groupEdges) for (const e of leaves) {
    let u = e; while (u.parent && !['softwareSystem', 'person'].includes(m.elements.get(u.parent).kind)) u = m.elements.get(u.parent);
    unitOf.set(e.id, u.id);
  }
  const units = [...new Set(leaves.map(e => unitOf.get(e.id)))];
  const members = new Map(units.map(u => [u, leaves.filter(e => unitOf.get(e.id) === u)]));
  const uedges = edges.filter(r => unitOf.get(r.src) !== unitOf.get(r.dst)).map(r => ({ src: unitOf.get(r.src), dst: unitOf.get(r.dst) }));
  const out = new Map(units.map(u => [u, []])); uedges.forEach(r => out.get(r.src).push(r));
  const st = new Map(), back = new Set();
  const dfs = u => { st.set(u, 1); for (const r of out.get(u)) { const s = st.get(r.dst); if (s === 1) back.add(r); else if (!s) dfs(r.dst); } st.set(u, 2); };
  const inc = new Set(uedges.map(r => r.dst));
  [...units.filter(u => !inc.has(u)), ...units].forEach(u => { if (!st.get(u)) dfs(u); });
  const dag = uedges.filter(r => !back.has(r));
  const layer = new Map(units.map(u => [u, 0]));
  for (let k = 0; k <= units.length; k++) { let ch = false; for (const r of dag) { const v = layer.get(r.src) + 1; if (layer.get(r.dst) < v) { layer.set(r.dst, v); ch = true; } } if (!ch) break; }
  const nL = units.length ? Math.max(...layer.values()) + 1 : 0;
  const layers = Array.from({ length: nL }, () => []); units.forEach(u => layers[layer.get(u)].push(u));
  const pos = new Map();
  layers.forEach(l => { l.sort((a, b) => (m.elements.get(a).parent || '').localeCompare(m.elements.get(b).parent || '')); l.forEach((id, j) => pos.set(id, j)); });
  const preds = new Map(units.map(u => [u, []])), succs = new Map(units.map(u => [u, []]));
  dag.forEach(r => { preds.get(r.dst).push(r.src); succs.get(r.src).push(r.dst); });
  const sweep = (i, nb) => { const bc = id => { const p = nb.get(id); return p.length ? p.reduce((a, x) => a + pos.get(x), 0) / p.length : pos.get(id); }; layers[i].sort((a, b) => bc(a) - bc(b)); layers[i].forEach((id, j) => pos.set(id, j)); };
  for (let it = 0; it < 4; it++) { for (let i = 1; i < nL; i++) sweep(i, preds); for (let i = nL - 2; i >= 0; i--) sweep(i, succs); }
  const W = 176, H = 66, GX = 112, GY = opts.groupEdges ? 84 : 44, PAD = 60, IX = 28, IY = 28;
  const cols = u => opts.groupEdges ? Math.ceil(Math.sqrt(members.get(u).length)) : 1;
  const uw = u => cols(u) * W + (cols(u) - 1) * IX, uh = u => Math.ceil(members.get(u).length / cols(u)) * H + (Math.ceil(members.get(u).length / cols(u)) - 1) * IY;
  const colW = layers.map(l => Math.max(0, ...l.map(uw))), colH = layers.map(l => l.reduce((a, u) => a + uh(u), 0) + Math.max(0, l.length - 1) * GY);
  const maxH = Math.max(H, ...colH);
  const nodes = new Map();
  let x0_ = PAD;
  layers.forEach((l, i) => {
    let y = PAD + (maxH - colH[i]) / 2;
    l.forEach(u => {
      members.get(u).forEach((e, j) => { const c = cols(u); nodes.set(e.id, { id: e.id, el: e, x: x0_ + (j % c) * (W + IX), y: y + Math.floor(j / c) * (H + IY), w: W, h: H }); });
      y += uh(u) + GY;
    });
    x0_ += colW[i] + GX;
  });
  const groups = [];
  for (const g of all.filter(e => hasChild.has(e.id) && !(opts.groupEdges && e.kind === 'softwareSystem'))) {
    const mem = [...nodes.values()].filter(n => m.isAncestor(g.id, n.id)); if (!mem.length) continue;
    const x0 = Math.min(...mem.map(n => n.x)) - 20, y0 = Math.min(...mem.map(n => n.y)) - 34, x1 = Math.max(...mem.map(n => n.x + n.w)) + 20, y1 = Math.max(...mem.map(n => n.y + n.h)) + 20;
    groups.push({ el: g, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  const groupEdges = [];
  if (opts.groupEdges) {
    const rect = id => nodes.get(id) || groups.find(g => g.el.id === id);
    for (const r of m.rels) {
      if (r.src === r.dst || !(hasChild.has(r.src) || hasChild.has(r.dst))) continue;
      if (m.isAncestor(r.src, r.dst) || m.isAncestor(r.dst, r.src)) continue; // structural
      const a = rect(r.src), b = rect(r.dst);
      if (a && b) groupEdges.push({ rel: r, a, b });
    }
  }
  return { nodes, edges, groups, groupEdges, width: PAD * 2 + colW.reduce((a, b) => a + b, 0) + Math.max(0, nL - 1) * GX, height: PAD * 2 + maxH + 110 };
}
function clip(cx, cy, tx, ty, w, h) { const dx = tx - cx, dy = ty - cy; if (!dx && !dy) return [cx, cy]; const s = Math.min((w / 2) / Math.abs(dx || 1e-9), (h / 2) / Math.abs(dy || 1e-9)); return [cx + dx * s, cy + dy * s]; }
function fitZoom(el, L, zoom) {
  if (zoom !== 'fit') return zoom;
  const box = el.getBoundingClientRect();
  return box.width > 50 ? Math.max(0.35, Math.min(1, (box.width - 24) / L.width, (box.height - 24) / L.height)) : 1;
}
// One renderer for every C4 drawing: the design sheet and the as-built code map.
function drawModel(m, L, o) {
  const mk = { n: 'var(--ink3)', error: 'var(--err)', warning: 'var(--warn)' };
  let svg = `<svg width="${L.width * o.zoom}" height="${L.height * o.zoom}" viewBox="0 0 ${L.width} ${L.height}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,Segoe UI,sans-serif"><defs>${Object.entries(mk).map(([k, c]) => `<marker id="mk-${o.attr}-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`).join('')}</defs>`;
  for (const g of L.groups) svg += `<g data-${o.attr}g="${esc(g.el.id)}"><rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="4" fill="none" stroke="var(--ink3)" stroke-width="1.2" stroke-dasharray="7 5"/><text x="${g.x + 12}" y="${g.y + 20}" font-size="12.5" font-weight="700" fill="var(--ink)">${esc(g.el.name)} <tspan font-weight="400" fill="var(--ink3)" font-size="11">[${g.el.kind === 'softwareSystem' ? 'Software System' : 'Container'}]</tspan></text></g>`;
  const edge = (a, b, st, label) => {
    const ac = [a.x + a.w / 2, a.y + a.h / 2], bc = [b.x + b.w / 2, b.y + b.h / 2];
    const p1 = clip(ac[0], ac[1], bc[0], bc[1], a.w + 6, a.h + 6), p2 = clip(bc[0], bc[1], ac[0], ac[1], b.w + 10, b.h + 10);
    let h = `<line x1="${p1[0]}" y1="${p1[1]}" x2="${p2[0]}" y2="${p2[1]}" stroke="${st.color}" stroke-width="${st.width}" ${st.dash ? `stroke-dasharray="${st.dash}"` : ''} marker-end="url(#mk-${o.attr}-${st.marker || 'n'})"/>`;
    if (label) h += `<text x="${(p1[0] + p2[0]) / 2}" y="${(p1[1] + p2[1]) / 2 - 5}" text-anchor="middle" font-size="11" fill="${st.labelColor || 'var(--ink2)'}" style="paint-order:stroke;stroke:var(--paper);stroke-width:5px;stroke-linejoin:round">${esc(trunc(label, 34))}</text>`;
    return h;
  };
  for (const x of o.extra || []) { const a = L.nodes.get(x.src), b = L.nodes.get(x.dst); if (a && b) svg += edge(a, b, { color: 'var(--ink3)', width: 1.2, dash: '2 4', labelColor: 'var(--ink3)' }, x.label); }
  for (const x of L.groupEdges || []) { const st = o.edgeStyle(x.rel); svg += edge(x.a, x.b, st, st.label); }
  for (const r of L.edges) { const st = o.edgeStyle(r); svg += edge(L.nodes.get(r.src), L.nodes.get(r.dst), st, st.label); }
  for (const n of L.nodes.values()) {
    const e = n.el, st = o.nodeStyle(e), store = Core.isStore(e), person = e.kind === 'person', ext = e.tags.has('External');
    const fill = ext ? 'var(--paper)' : 'var(--node)', dash = st.dash || (ext ? '5 3' : ''), da = dash ? `stroke-dasharray="${dash}"` : '';
    const shape = store
      ? `<path d="M${n.x} ${n.y + 8} V${n.y + n.h - 8} A${n.w / 2} 8 0 0 0 ${n.x + n.w} ${n.y + n.h - 8} V${n.y + 8}" fill="${fill}" stroke="${st.stroke}" stroke-width="${st.sw}" ${da}/><ellipse cx="${n.x + n.w / 2}" cy="${n.y + 8}" rx="${n.w / 2}" ry="8" fill="${fill}" stroke="${st.stroke}" stroke-width="${st.sw}" ${da}/>`
      : `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${person ? n.h / 2 : 3}" fill="${fill}" stroke="${st.stroke}" stroke-width="${st.sw}" ${da}/>`;
    const kind = person ? 'Person' : e.kind === 'softwareSystem' ? 'Software System' : e.kind === 'component' ? 'Component' : 'Container';
    const ty = store ? n.y + 35 : n.y + 28;
    const bw = st.badge ? Math.max(22, String(st.badge).length * 7 + 10) : 0;
    const badge = st.badge ? `<rect x="${n.x + n.w + 9 - bw}" y="${n.y - 9}" width="${bw}" height="22" rx="11" fill="${st.badgeColor}"/><text x="${n.x + n.w + 9 - bw / 2}" y="${n.y + 6}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--node)">${esc(st.badge)}</text>` : '';
    svg += `<g class="node" data-${o.attr}="${esc(e.id)}"><title>${esc(e.name)}</title>${shape}<text x="${n.x + n.w / 2}" y="${ty}" text-anchor="middle" font-size="13" font-weight="700" fill="var(--ink)">${esc(trunc(e.name, 22))}</text><text x="${n.x + n.w / 2}" y="${ty + 16}" text-anchor="middle" font-size="10.5" fill="var(--ink2)">${esc(trunc(`[${kind}${e.technology ? ': ' + e.technology : ''}]`, 30))}</text>${st.note ? `<text x="${n.x + n.w / 2}" y="${n.y + n.h + 14}" text-anchor="middle" font-size="10.5" font-weight="600" fill="var(--warn)">${esc(st.note)}</text>` : ''}${badge}</g>`;
  }
  return svg + '</svg>';
}
function renderSheet() {
  const host_ = $('#sheetscroll'), m = A.model;
  const special = A.active && A.active.startsWith('special:');
  $('#editors').classList.toggle('nosheet', !A.sheetOpen || special);
  if (!A.sheetOpen || special) return;
  if (!A.root || !m || !m.elements.size) { host_.innerHTML = `<div class="empty">${A.root ? `The sheet draws ${esc(A.cfg.model)} once it has elements.` : 'Open a registry folder to see its C4 sheet.'}</div>`; $('#titleblock').style.display = 'none'; return; }
  const L = layout(m); const elSev = new Map(), elN = new Map(), relSev = new Map();
  const bump = (map, id, sev) => { if (map.get(id) !== 'error') map.set(id, sev); };
  for (const f of A.diags) {
    if (f.suppressed) continue;
    if (f.loc.kind === 'element') { bump(elSev, f.loc.id, f.sev); elN.set(f.loc.id, (elN.get(f.loc.id) || 0) + 1); }
    else { bump(relSev, f.loc.id, f.sev); const r = m.relById.get(f.loc.id); if (r) { bump(elSev, r.src, f.sev); elN.set(r.src, (elN.get(r.src) || 0) + 1); } }
  }
  const col = s => (s === 'error' ? 'var(--err)' : s === 'warning' ? 'var(--warn)' : 'var(--ink3)');
  const telByEl = A.badges === 'findings' ? new Map() : telAgg().byEl;
  // Blast radius badges: select a box, pick "Badges: blast radius" to see who is hurt if it misbehaves.
  const blast = new Map();
  if (A.badges === 'blast' && A.selected && m.elements.has(A.selected)) {
    const br = Core.blastRadius(m, A.selected, { mode: 'misbehaves' });
    for (const [kind, list] of [['down', br.down], ['degraded', br.degraded], ['unknown', br.unknown]]) for (const x of list) blast.set(x.id, kind);
  }
  const BLAST_BADGE = { down: ['down', 'var(--err)'], degraded: ['deg', 'var(--warn)'], unknown: ['?', 'var(--ink3)'] };
  host_.innerHTML = drawModel(m, L, {
    attr: 'el', zoom: fitZoom(host_, L, A.zoom),
    edgeStyle: r => { const sev = relSev.get(r.id), hot = A.selected && (r.src === A.selected || r.dst === A.selected), as = Core.interaction(r) === 'async';
      return { color: col(sev), width: hot ? 2.4 : sev ? 1.8 : 1.3, dash: as ? '6 4' : '', marker: sev || 'n', labelColor: sev ? col(sev) : null, label: r.description ? r.description + (as ? ' (async)' : '') : '' }; },
    nodeStyle: e => {
      const base = { stroke: A.selected === e.id ? 'var(--accent)' : 'var(--ink)', sw: A.selected === e.id ? 2.6 : 1.5 };
      if (A.badges === 'blast') { const b = BLAST_BADGE[blast.get(e.id)]; return b ? { ...base, badge: b[0], badgeColor: b[1] } : base; }
      if (A.badges === 'findings') return { ...base, badge: elN.get(e.id), badgeColor: col(elSev.get(e.id)) };
      const t = telByEl.get(e.name); if (!t) return base;
      return A.badges === 'cost' ? { ...base, badge: money(t.cost), badgeColor: 'var(--accent)' } : { ...base, badge: t.failed || null, badgeColor: 'var(--err)' };
    },
  });
  const live = A.diags.filter(d => !d.suppressed), last = A.handovers[A.handovers.length - 1];
  const tb = $('#titleblock'); tb.style.display = host_.clientWidth < 560 ? 'none' : '';
  tb.innerHTML = `<table><tr><td colspan="2" class="t">${esc(m.name)}</td></tr><tr><td class="k">Revision</td><td>r-${hash(A.modelText)}</td></tr>
    <tr><td class="k">Findings</td><td>${plural(live.filter(d => d.sev === 'error').length, 'error')}, ${plural(live.filter(d => d.sev === 'warning').length, 'warning')}</td></tr>
    <tr><td class="k">Gate</td><td class="${A.gate.ready ? 'ok' : 'no'}">${A.gate.ready ? 'Ready to hand over' : `${A.gate.clauses.length} blocking`}</td></tr>
    <tr><td class="k">As built</td><td>${A.drift ? (A.drift.undeclared.length + A.drift.unknownEls.length ? `<span class="no">${plural(A.drift.undeclared.length + A.drift.unknownEls.length, 'difference')}</span>` : '<span class="ok">matches the design</span>') : 'not mapped'}</td></tr>
    <tr><td class="k">Handover</td><td>${last ? `${esc(last.id)} at ${esc(last.revision)}` : 'none yet'}</td></tr></table>`;
}

// ---------------------------------------------------------------- code map (as built)
async function chooseCodebase() {
  const p = await host.chooseCodebase(); if (!p) return false;
  let cfg = {}; const t = await readText('designc.json');
  if (t) { try { cfg = JSON.parse(t); } catch { toast('designc.json is not valid JSON; fix it first.', 'error'); return false; } }
  cfg.model = cfg.model || A.cfg.model; cfg.codebase = p;
  await host.write('designc.json', JSON.stringify(cfg, null, 2) + '\n'); A.cfg.codebase = p; return true;
}
async function extractCodebase() {
  if (!A.root || A.extracting) return;
  if (!A.cfg.codebase && !(await chooseCodebase())) return;
  A.extracting = true; renderSidebar(); if (A.active === 'special:codemap') renderCodemap();
  const r = await host.extract(A.cfg.codebase);
  A.extracting = false;
  if (r.error) { toast(r.error, 'error'); renderSidebar(); renderCodemap(); return; }
  await host.write('asbuilt/workspace.dsl', r.dsl);
  await host.write('asbuilt/facts.json', JSON.stringify(r.facts, null, 2) + '\n');
  {
    const { projects, deployables, tests, elements, edges, unresolved, ...extraStats } = r.stats;
    await recordEvent('extraction', { repo: r.facts.repo, revision: hash(r.dsl), projects, deployables, tests, elements, edges, unresolved,
      ...(Object.keys(extraStats).length ? { payload: { stats: extraStats } } : {}) });
  }
  await loadAsbuilt(); recompile(); openSpecial('special:codemap'); renderAll();
  toast(`Mapped ${plural(r.stats.deployables, 'deployable')}, ${plural(r.stats.edges, 'dependency', )} from ${plural(r.stats.projects, 'project')}${r.stats.unresolved ? `; ${r.stats.unresolved} could not be resolved` : ''}.`);
}
async function adoptAsDesign() {
  if (A.model.elements.size && !confirm(`Replace ${A.cfg.model} with the as-built map? Your current design is overwritten.`)) return;
  const dsl = Core.containerLevelText(await readText('asbuilt/workspace.dsl')).replace(/^\/\/.*\n/gm, '').replace(/\(as built\)/, '');
  await host.write(A.cfg.model, dsl); await loadModel(); recompile(); await openFile(A.cfg.model); renderAll();
  toast('The design now starts from the code as it is. Add d.* properties where they matter.');
}
async function adoptComponents(builtId, designId) {
  const b = A.buffers.get(A.cfg.model);
  if (b && b.dirty) return toast(`Save ${A.cfg.model} first. Adopting writes to the file and would overwrite your unsaved edits.`, 'error');
  const built = A.asbuiltFull.elements.get(builtId), want = A.model.elements.get(designId);
  const r = Core.spliceComponents(A.modelText, A.model, designId, A.asbuiltFull, builtId);
  if (r.error) return toast(r.error, 'error');
  const n = [...A.asbuiltFull.elements.values()].filter(e => e.kind === 'component' && e.parent === builtId).length;
  if (!confirm(`Add ${plural(n, 'component')} from ${built.name} to ${want.name} in ${A.cfg.model}?`)) return;
  await host.write(A.cfg.model, r.text); await loadModel(); recompile(); await openFile(A.cfg.model, want.line); renderAll();
  toast(`Adopted ${plural(n, 'component')} into ${want.name}.`);
}
function codemapSidebar() {
  const cb = A.cfg.codebase, f = A.facts, d = A.drift;
  let h = section('cb', 'Codebase', cb
    ? `<div class="hint"><b>${esc(cb)}</b>${f ? `<br>Extracted ${esc(new Date(f.extractedAt).toLocaleString())}` : '<br>Not extracted yet'}</div>
       <button class="btn ${A.asbuilt ? '' : 'primary'} block" data-a="extract" ${A.extracting ? 'disabled' : ''}>${A.extracting ? 'Extracting…' : A.asbuilt ? 'Re-extract' : 'Extract the as-built map'}</button>
       <div style="padding:0 20px 8px"><button class="lnk" data-a="choosecode">Change folder</button></div>`
    : `<div class="hint">Point designc at a repository to map what exists today. It only reads the folder.</div><button class="btn primary block" data-a="choosecode">Choose codebase folder</button>`);
  if (f) h += section('cbstats', 'Found', `<div class="hint">${plural(f.projects.length, 'project')}: ${plural(f.projects.filter(p => ['web', 'worker', 'app'].includes(p.kind)).length, 'deployable')}, ${plural(f.projects.filter(p => p.kind === 'library').length, 'library')}, ${plural(f.projects.filter(p => p.kind === 'test').length, 'test project')} (not mapped). ${plural(f.edges.length, 'dependency', )} with evidence.</div>`);
  if (A.asbuilt && !A.model.elements.size) h += `<button class="btn primary block" data-a="adopt">Start the design from this map</button>`;
  if (d) {
    const row = (label, desc, attrs) => `<div class="row" style="--indent:20px;height:auto;min-height:22px;white-space:normal;padding-top:3px;padding-bottom:3px" ${attrs}><span class="lbl">${label}</span>${desc ? `<span class="desc">${desc}</span>` : ''}</div>`;
    const byName = n => { const e = [...A.asbuilt.elements.values()].find(x => x.name === n); return e ? `data-cmsel="${esc(e.id)}"` : ''; };
    const body = (d.undeclared.length ? `<div class="hint" style="padding-bottom:2px"><b>In code, not in the design</b></div>` + d.undeclared.map(u => row(`${esc(u.from)} → ${esc(u.to)}`, 'dependency', `data-cmsel="${esc(A.asbuilt.relById.get(u.builtRel).src)}"`)).join('') + d.unknownEls.map(n => row(esc(n), 'element', byName(n))).join('') : d.unknownEls.map(n => row(esc(n), 'element in code only', byName(n))).join(''))
      + (d.unrealised.length || d.missingEls.length ? `<div class="hint" style="padding-bottom:2px"><b>Designed, not found in code</b></div>` + d.unrealised.map(u => row(`${esc(u.from)} → ${esc(u.to)}`, 'dependency', `data-cmsel="${esc(u.src)}"`)).join('') + d.missingEls.map(n => row(esc(n), 'element', '')).join('') : '')
      || '<div class="hint">The code matches the design.</div>';
    h += section('drift', `Drift (${d.undeclared.length + d.unknownEls.length + d.unrealised.length + d.missingEls.length})`, body);
  } else if (A.asbuilt) h += section('drift', 'Drift', `<div class="hint">Drift appears once ${esc(A.cfg.model)} has elements to compare against.</div>`);
  if (A.cdrift && cmHasComponents()) h += section('cdrift', 'Components', cmDriftBody());
  if (f && f.unresolved.length) h += section('unres', `Unresolved (${f.unresolved.length})`, `<div class="hint">Extraction saw these but could not tie them to an element, so they are not on the map.</div>` +
    f.unresolved.map(u => `<div class="item" data-code="${esc(u.file)}" data-line="${u.line}"><div class="l1"><span class="id">${esc(u.where)}</span></div><div class="l2">${esc(u.what)}</div><div class="l2" style="font-family:var(--mono);font-size:11px">${esc(u.file)}:${u.line}</div></div>`).join(''));
  return h;
}
function cmDriftBody() {
  const c = A.cdrift, M = A.asbuiltFull, row = (label, desc, attrs) => `<div class="row" style="--indent:20px;height:auto;min-height:22px;white-space:normal;padding-top:3px;padding-bottom:3px" ${attrs}><span class="lbl">${label}</span>${desc ? `<span class="desc">${desc}</span>` : ''}</div>`;
  const kids = id => [...M.elements.values()].filter(e => e.kind === 'component' && e.parent === id);
  let h = '';
  for (const id of c.scored) {
    const cont = M.elements.get(id), dc = c.toDesign.get(id);
    const rows = kids(id).filter(e => !c.toDesign.has(e.id)).map(e => row(esc(e.name), 'component in code only', `data-cmsel="${esc(e.id)}"`)).join('')
      + M.rels.filter(r => c.relStatus.get(r.id) === 'undeclared' && M.elements.get(r.src).parent === id || c.relStatus.get(r.id) === 'undeclared' && M.elements.get(r.dst).parent === id)
        .map(r => row(`${esc(M.elements.get(r.src).name)} → ${esc(M.elements.get(r.dst).name)}`, 'dependency', `data-cmsel="${esc(r.src)}"`)).join('')
      + [...A.model.elements.values()].filter(x => x.kind === 'component' && x.parent === dc.id && !c.toBuilt.has(x.id)).map(x => row(esc(x.name), 'designed, not found in code', '')).join('');
    h += `<div class="hint" style="padding-bottom:2px"><b>${esc(cont.name)}</b></div>${rows || '<div class="hint">The components match the design.</div>'}`;
  }
  for (const a of c.adoptable) h += row(`${esc(M.elements.get(a.built).name)}: design has no components (${kids(a.built).length} found)`, '', `data-cmsel="${esc(a.built)}"`) + cmAdoptBtn(a.built);
  return h || '<div class="hint">No container in the design has components to compare.</div>';
}
const BASIS_WORDS = { anchor: 'function class, controller or endpoint class', 'output-binding': 'function output-binding type', library: 'library', 'first-folder': 'folder', 'app-shell': 'App shell', shared: 'Shared', override: 'designc.json override' };
function cmComponentSide(e) {
  const f = A.facts || {}, M = A.asbuiltFull, c = (f.components || []).find(x => x.id === e.id), cd = A.cdrift;
  const evRows = list => list.map(v => `<div class="evrow" data-code="${esc(v.file)}" data-line="${v.line}"><div class="evfile">${esc(v.file)}:${v.line}</div><code>${esc(v.text)}</code></div>`).join('');
  const edges = dir => (f.componentEdges || []).filter(x => (dir === 'out' ? x.from : x.to) === e.id).map(x => {
    const other = M.elements.get(dir === 'out' ? x.to : x.from), r = M.rels.find(y => y.src === x.from && y.dst === x.to);
    const st = cd && r ? cd.relStatus.get(r.id) : '';
    const tag = st === 'matched' ? '<span class="tag pass">in design</span>' : st === 'undeclared' ? '<span class="tag warning">not in design</span>' : '';
    return `<div class="evgroup"><div><b>${dir === 'out' ? '→ ' : '← '}${esc(other ? other.name : '?')}</b> ${esc(x.label)} <span class="desc">${esc(x.tech || '')}</span> ${tag}</div>${evRows(x.evidence || [])}</div>`;
  }).join('');
  const match = cd && cd.toDesign.get(e.id), parent = M.elements.get(e.parent);
  const status = !cd ? '' : match ? `<p>Design: <b>${esc(match.name)}</b></p>` : cd.scored.has(e.parent) ? `<p style="color:var(--warn)"><b>Not in the design.</b> Add it under ${esc(parent.name)}, or put <span class="code">"d.aka" "${esc(e.name)}"</span> on the designed component if it is the same thing.</p>` : '';
  return `<h3>${esc(e.name)}</h3><div class="muted">Component of ${esc(parent ? parent.name : '')}${c ? ` · ${esc(BASIS_WORDS[c.basis] || c.basis)}` : ''}</div>${status}
    ${c && c.files.length ? `<h4>Files</h4>${c.files.map(x => `<div class="evrow" data-code="${esc(x)}" data-line="1"><div class="evfile">${esc(x)}</div></div>`).join('')}` : ''}
    <h4>Why it's on the map</h4>${c ? evRows(c.evidence) : '<p class="muted">No evidence recorded.</p>'}
    ${edges('out') ? `<h4>Depends on</h4>${edges('out')}` : ''}${edges('in') ? `<h4>Used by</h4>${edges('in')}` : ''}`;
}
function cmAdoptBtn(builtId) {
  const a = A.cdrift && A.cdrift.adoptable.find(x => x.built === builtId);
  return a ? `<div style="padding:0 20px 8px"><button class="btn block" data-a="adoptcomp" data-built="${esc(a.built)}" data-design="${esc(a.design)}">Adopt these components</button></div>` : '';
}
function cmHasComponents() { return !!A.asbuiltFull && [...A.asbuiltFull.elements.values()].some(e => e.kind === 'component'); }
function cmModel() { return A.asbuiltFull ? Core.view(A.asbuiltFull, { level: A.cmLevel, scope: A.cmScope }) : A.asbuilt; }
function cmGo(level, scope) {
  if (level === 'component' && !cmHasComponents()) return;
  A.cmLevel = level; if (scope !== undefined) A.cmScope = scope;
  A.cmZoom = 'fit';
  const m = cmModel(); if (A.cmSel && !(m && m.elements.has(A.cmSel))) A.cmSel = null;
  renderCodemap();
}
function cmUp() { if (A.cmLevel === 'component') cmGo('container'); else if (A.cmLevel === 'container') cmGo('context'); }
function cmSeg() {
  const has = cmHasComponents();
  const b = (lv, name) => `<button class="${A.cmLevel === lv ? 'on' : ''}" data-a="cmlevel" data-level="${lv}" ${lv === 'component' && !has ? 'disabled title="No components were found"' : ''}>${name}</button>`;
  const sc = A.cmScope && A.asbuiltFull && A.asbuiltFull.elements.get(A.cmScope);
  const crumb = A.cmLevel === 'component' ? `<span class="cm-crumb"><button class="cm-all" data-a="cmscope">All</button>${sc ? ` ▸ <b>${esc(sc.name)}</b>` : ''}</span>` : '';
  return `<span class="cm-seg">${b('context', 'Context')}${b('container', 'Containers')}${b('component', 'Components')}</span>${crumb}`;
}
function renderCodemap() {
  const el = $('#special');
  if (A.active !== 'special:codemap') return;
  if (!A.asbuilt) {
    el.innerHTML = `<div class="dash"><h1>Code map</h1><p class="lede">A C4 map of the codebase as it exists, extracted from project files, configuration and code. Every box and arrow links to the lines that prove it. Once there is a design, the map shows where code and design disagree.</p>
      ${A.cfg.codebase ? `<p>Codebase: <span class="code">${esc(A.cfg.codebase)}</span></p><button class="btn primary" data-a="extract" ${A.extracting ? 'disabled' : ''}>${A.extracting ? 'Extracting…' : 'Extract the as-built map'}</button>` : '<button class="btn primary" data-a="choosecode">Choose codebase folder</button>'}
      <div class="block" style="margin-top:22px"><h3>What the extractor reads</h3><div class="tw2"><table class="t">
      <tr><td>Web, Worker and Exe projects, and SPA/Node package.json</td><td>Containers. Libraries fold into the deployables that reference them; test projects are skipped.</td></tr>
      <tr><td>EF Core <span class="code">DbContext</span> classes</td><td>Stores, with the provider from <span class="code">UseSqlServer</span> and friends, linked to the deployables that use them.</td></tr>
      <tr><td>Redis, Blob and Cosmos clients</td><td>Stores, named by their connection string.</td></tr>
      <tr><td><span class="code">AddHttpClient</span> + base address in appsettings</td><td>Sync edges, matched to projects by launch port or name; other hosts become external systems.</td></tr>
      <tr><td>Service Bus senders and processors</td><td>Async edges, matched on queue or topic name.</td></tr>
      <tr><td>JS/TS <span class="code">package.json</span> dependencies</td><td>SPA and Node API containers; routers and dev-proxy config give their ports and provided routes.</td></tr>
      <tr><td>Function classes, controllers and endpoint classes, libraries, first folders (override: <span class="code">designc.json</span> <span class="code">extract.components</span>)</td><td>Components inside each container, with edges where one type references another.</td></tr>
      <tr><td>The Context · Containers · Components switcher</td><td>Zoom the map. Double-click a container to drill into its components; Backspace goes up. "Adopt these components" copies them into the design.</td></tr>
      <tr><td>HTTP and hub calls (fetch/axios/withUrl) across languages</td><td>Sync/realtime edges, matched to providers by route; a dev-proxy port breaks ties between multiple candidates.</td></tr>
      <tr><td><span class="code">designc.json</span> bindings</td><td>Env-only calls (no literal target in code) linked to a named element you declare, instead of staying unresolved.</td></tr>
      </table></div></div></div>`;
    return;
  }
  const f = A.facts || { repo: '', extractedAt: null };
  el.innerHTML = `<div class="cm"><div class="cm-bar"><b>${esc(f.repo)}</b><span class="desc">${f.extractedAt ? 'extracted ' + esc(new Date(f.extractedAt).toLocaleString()) : ''}</span>
      ${cmSeg()}
      ${A.cmLevel !== 'context' ? `<span class="legend"><i class="lg ok"></i>in the design <i class="lg warn"></i>not in the design ${A.drift ? '<i class="lg ghost"></i>designed, not in code' : ''}</span>` : ''}
      <span class="spacer"></span>${A.drift && A.cmLevel !== 'context' ? `<label class="chk"><input type="checkbox" data-a="ghost" ${A.showGhost ? 'checked' : ''}> Show designed-only edges</label>` : ''}
      <button class="btn" data-a="cmfit">Fit</button><button class="btn" data-a="extract" ${A.extracting ? 'disabled' : ''}>${A.extracting ? 'Extracting…' : 'Re-extract'}</button></div>
    <div class="cm-main"><div class="cm-canvas sheetscroll" id="cmcanvas"></div><aside class="cm-side" id="cmside"></aside></div></div>`;
  requestAnimationFrame(drawCodemap);
}
function drawCodemap() {
  const host_ = $('#cmcanvas'); if (!host_ || !A.asbuilt) return;
  const lvl = A.cmLevel, m = cmModel(), L = layout(m, { groupEdges: lvl === 'component' });
  const d = lvl === 'context' ? null : A.drift, cd = lvl === 'component' ? A.cdrift : null;
  const full = A.asbuiltFull;
  const compOf = id => { const e = m.elements.get(id); return e && e.kind === 'component' ? e : null; };
  const ghosts = lvl === 'container' && d ? d.unrealised.map(u => ({ src: u.src, dst: u.dst, label: 'designed, not in code' }))
    : cd ? cd.unrealised.filter(u => m.elements.has(u.src) && m.elements.has(u.dst)).map(u => ({ src: u.src, dst: u.dst, label: 'designed, not in code' })) : [];
  host_.innerHTML = drawModel(m, L, {
    attr: 'cm', zoom: fitZoom(host_, L, A.cmZoom),
    extra: A.showGhost ? ghosts : [],
    edgeStyle: r => {
      const as = Core.interaction(r) === 'async', hot = A.cmSel && (r.src === A.cmSel || r.dst === A.cmSel);
      const compRel = compOf(r.src) || compOf(r.dst);
      const st = compRel ? (cd ? cd.relStatus.get(r.id) : null) : d ? d.relStatus.get(r.id) : 'matched';
      if (st === 'undeclared' || (!compRel && d && st !== 'matched')) return { color: 'var(--warn)', width: hot ? 2.8 : 2.1, dash: as ? '6 4' : '', marker: 'warning', labelColor: 'var(--warn)', label: `${r.description}${st === 'undeclared' ? ' (not in design)' : ''}` };
      return { color: hot ? 'var(--accent)' : 'var(--ink3)', width: hot ? 2.2 : 1.3, dash: as ? '6 4' : '', label: r.description };
    },
    nodeStyle: e => {
      const on = A.cmSel === e.id;
      if (e.kind === 'component') {
        const warn = cd && full && cd.scored.has(e.parent) && !cd.toDesign.has(e.id), ink = cd && cd.toDesign.has(e.id);
        return { stroke: on ? 'var(--accent)' : warn ? 'var(--warn)' : ink ? 'var(--ink)' : 'var(--ink3)', sw: on ? 2.8 : warn ? 2.2 : 1.5, dash: warn ? '6 3' : '', note: warn ? 'not in design' : '' };
      }
      const mapped = !d || d.toDesign.has(e.id);
      return { stroke: on ? 'var(--accent)' : mapped ? 'var(--ink)' : 'var(--warn)', sw: on ? 2.8 : mapped ? 1.5 : 2.2, dash: mapped ? '' : '6 3', note: mapped ? '' : 'not in design' };
    },
  });
  renderCmSide();
}
function renderCmSide() {
  const side = $('#cmside'); if (!side) return;
  const f = A.facts; const d = A.cmLevel === 'container' ? A.drift : null;
  if (!A.cmSel) {
    side.innerHTML = `<h3>Projects</h3>${f ? f.projects.map(p => `<div class="evrow" data-code="${esc(p.file)}" data-line="1"><b>${esc(p.name)}</b> <span class="tag">${esc(p.kind)}</span> <span class="tag">${esc(p.lang)}</span><div class="evfile">${esc(p.file)}</div></div>`).join('') : ''}<p class="muted">Select a box to see the evidence behind it.</p>`;
    return;
  }
  const e = (A.asbuiltFull || A.asbuilt).elements.get(A.cmSel); if (!e) { side.innerHTML = ''; return; }
  if (e.kind === 'component') { side.innerHTML = cmComponentSide(e); return; }
  const fe = f && f.elements.find(x => x.name === e.name) || { evidence: [] };
  const match = d && d.toDesign.get(e.id);
  const evRows = list => list.map(v => `<div class="evrow" data-code="${esc(v.file)}" data-line="${v.line}"><div class="evfile">${esc(v.file)}:${v.line}</div><code>${esc(v.text)}</code></div>`).join('');
  const relStatus = (from, to) => { if (!d) return ''; const r = A.asbuilt.rels.find(x => A.asbuilt.elements.get(x.src).name === from && A.asbuilt.elements.get(x.dst).name === to); const s_ = r && d.relStatus.get(r.id); return s_ && s_ !== 'matched' ? '<span class="tag warning">not in design</span>' : s_ === 'matched' ? '<span class="tag pass">in design</span>' : ''; };
  const edgesOf = (dir) => (f ? f.edges.filter(x => (dir === 'out' ? x.from : x.to) === e.name) : []).map(x => `<div class="evgroup"><div><b>${dir === 'out' ? '→ ' + esc(x.to) : '← ' + esc(x.from)}</b> ${esc(x.label)} <span class="desc">${esc(x.tech)}</span> ${relStatus(x.from, x.to)}</div>${evRows(x.evidence)}</div>`).join('');
  side.innerHTML = `<h3>${esc(e.name)}</h3><div class="muted">${esc(e.technology || '')}${fe.project ? ` · <span class="lnk" data-code="${esc(fe.project)}" data-line="1">${esc(fe.project)}</span>` : ''}</div>
    ${d ? (match ? `<p>Design: <b>${esc(match.name)}</b></p>` : `<p style="color:var(--warn)"><b>Not in the design.</b> Add it to ${esc(A.cfg.model)}, or put <span class="code">"d.aka" "${esc(e.name)}"</span> on the designed element if it's the same thing under another name.</p>`) : ''}
    ${cmAdoptBtn(e.id)}
    <h4>Why it's on the map</h4>${evRows(fe.evidence) || '<p class="muted">No evidence recorded.</p>'}
    ${edgesOf('out') ? `<h4>Depends on</h4>${edgesOf('out')}` : ''}${edgesOf('in') ? `<h4>Used by</h4>${edgesOf('in')}` : ''}`;
}

// ---------------------------------------------------------------- dashboards (System 2 / System 4)
function renderSpecial() { const el = $('#special'); if (A.active === 'special:codemap') return renderCodemap(); if (A.active === 'special:canvas') return renderCanvasView(); if (A.active === 'special:deployment') return renderDeployment(); if (A.active === 'special:compare') return renderCompare(); el.innerHTML = A.active === 'special:build' ? buildDash() : improveDash(); }

// ---------------------------------------------------------------- views: canvas (designc-canvas)
function ensureModelBuffer() {
  let b = A.buffers.get(A.cfg.model);
  if (!b) {
    const model = monacoRef.editor.createModel(A.modelText, langFor(A.cfg.model), monacoRef.Uri.parse('file:///' + encodeURI(A.cfg.model)));
    b = { model, dirty: false, disk: A.modelText, view: null };
    model.onDidChangeContent(() => onBufferChange(A.cfg.model));
    A.buffers.set(A.cfg.model, b);
  }
  return b;
}
function canvasHostFor() {
  return {
    core: Core,
    getText: () => A.modelText,
    setText: (text) => { const b = ensureModelBuffer(); if (b.model.getValue() !== text) b.model.setValue(text); },
    getLayout: () => A.canvasLayout,
    setLayout: (lay) => { A.canvasLayout = lay; host.write(layoutPathFor(A.cfg.model), JSON.stringify(lay)).catch(() => {}); },
    onReveal: (line) => openFile(A.cfg.model, line),
    saveReview: async (markdown) => {
      const path = `reviews/${new Date().toISOString().slice(0, 10)}-design-review.md`;
      try { await host.write(path, markdown); A.tree = await host.tree(); renderSidebar(); toast(`Saved ${path}`); }
      catch (e) { toast(`Couldn't save the review: ${e.message}`, 'error'); }
    },
  };
}
// ---------------------------------------------------------------- deployment (read-only)
const deployKey = () => `designc.deployPick:${A.root ? (A.root.root || A.root.name) : ''}`;
function deployMemory(id) {
  try { if (id === undefined) return localStorage.getItem(deployKey()); if (id) localStorage.setItem(deployKey(), id); else localStorage.removeItem(deployKey()); } catch (e) { /* no storage: the pick lasts for this session */ }
  return null;
}
// The picker's current choice: this session's pick, the remembered one, the designc.json default, else the first.
// `list` is empty when the model declares no environment; `error` says a configured default names nothing.
function deploymentChoice() {
  const list = Core.deploymentChoices(A.model);
  if (!list.length) return { list, current: null };
  const byId = id => list.find(c => c.id === id);
  const dv = A.cfg.deployment ? Core.deploymentView(A.model, A.cfg.deployment) : null;
  const fromCfg = dv && !dv.error ? byId(dv.view ? `view:${dv.view.key || dv.view.scope}` : `env:${dv.env.name}`) : null;
  const current = byId(A.deployPick) || byId(deployMemory()) || fromCfg || list[0];
  return { list, current, error: !A.deployPick && dv && dv.error ? dv.error : null };
}
const deployPicker = d => d.list.some(c => c.view) || d.list.filter(c => !c.view).length > 1;
function deploymentSidebar() {
  const d = deploymentChoice();
  const rows = d.list.map(c => `<div class="row ${d.current && d.current.id === c.id ? 'active' : ''}" data-dppick="${esc(c.id)}"><span class="tw"></span><span class="lbl">${esc(c.label)}</span></div>`).join('');
  return section('deploy', 'Views', rows || '<div class="hint">This model declares no deploymentEnvironment.</div>') +
    '<div class="hint">Read-only. Pick a declared view or a whole environment; the default is "deployment" in designc.json. Edit the model in the Design view.</div>';
}
function deployInstHtml(n) {
  const missing = !n.ref;
  return `<div class="dp-inst ${missing ? 'dp-bad' : ''}"><b>${esc(n.name)}</b><span>${missing ? 'unknown element' : esc(n.kind === 'containerInstance' ? 'container instance' : 'system instance')}</span></div>`;
}
function deployNodeHtml(sn) {
  const n = sn.node;
  const meta = [n.technology, n.instances && n.instances !== '1' ? `${n.instances} instances` : ''].filter(Boolean).join(' · ');
  const shared = sn.shared.map(x => `<div class="dp-shared">+ ${x.count} from ${esc(x.system)}</div>`).join('');
  return `<div class="dp-node ${n.kind === 'infrastructureNode' ? 'dp-infra' : ''}"><div class="dp-h" data-dpnode="${esc(sn.path)}" title="Show what fails if this node is unavailable"><b>${esc(n.name)}</b>${meta ? `<span>${esc(meta)}</span>` : ''}</div>${sn.insts.map(deployInstHtml).join('')}${shared}${sn.children.map(deployNodeHtml).join('')}</div>`;
}
function unavailableHtml(path, env, view) {
  const r = Core.blastRadius(A.model, path, { mode: 'unavailable', environment: env });
  if (r.error) return `<div class="note">${esc(r.error)}</div>`;
  const sys = view && view.system ? view.system : null;
  const row = (label, l) => {
    if (!l.length) return '';
    if (!sys) return `<div><b>${label}</b> ${l.map(x => esc(x.name)).join(', ')}</div>`;
    return Core.splitBySystem(A.model, l, sys).map(side => `<div><b>${label}</b> <i>${side.here ? 'this view' : 'also affected (other systems)'}</i>: ${side.groups.map(g => `${g.system ? `${esc(g.system)}: ` : ''}${g.items.map(x => esc(x.name)).join(', ')}`).join('; ')}</div>`).join('');
  };
  return `<div class="dp-impact"><h3>If ${esc(path)} is unavailable</h3>${row('Lost', r.lost) || '<div>No element loses all its instances.</div>'}${row('Still running, reduced', r.survivors)}${row('Down (sync callers)', r.down)}${row('Degraded (async)', r.degraded)}${row('Unknown (undeclared interaction)', r.unknown)}</div>`;
}
function deployLinksHtml(rels) {
  if (!rels.length) return '';
  return `<div class="block"><h3>Links</h3><div class="tw2"><table class="t"><tr><th>From</th><th>To</th><th>What</th><th>Technology</th></tr>${rels.map(r => `<tr><td>${esc(r.src)}</td><td>${esc(r.dst)}</td><td>${esc(r.description || '')}</td><td>${esc(r.technology || '')}</td></tr>`).join('')}</table></div></div>`;
}
function renderDeployment() {
  const d = deploymentChoice(); const el = $('#special');
  if (!d.current) { el.innerHTML = '<div class="note">This model declares no deploymentEnvironment. Add one in the Design view to see where containers run.</div>'; return; }
  const c = d.current, sc = Core.deploymentScope(A.model, c.env, c.view);
  const picker = deployPicker(d) ? `<label class="dp-pick">View <select id="dpPick">${d.list.map(x => `<option value="${esc(x.id)}" ${x.id === c.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>` : '';
  const hidden = sc.scoped && sc.hidden ? `<div class="note">${sc.hidden} node${sc.hidden === 1 ? '' : 's'} outside ${esc(sc.system)} not shown. Pick "All of ${esc(c.env.name)}" to see them.</div>` : '';
  el.innerHTML = `<div class="dp"><h2>${esc(c.label)}</h2>${d.error ? `<div class="note">${esc(d.error)}</div>` : ''}${picker}${sc.nodes.map(deployNodeHtml).join('') || '<div class="note">This environment has no deployment nodes.</div>'}${hidden}${deployLinksHtml(sc.rels)}<div id="dpImpact"></div></div>`;
  el.querySelectorAll('[data-dpnode]').forEach(h => h.addEventListener('click', ev => { ev.stopPropagation(); $('#dpImpact').innerHTML = unavailableHtml(h.dataset.dpnode, c.env.name, c.view); }));
  const sel = $('#dpPick'); if (sel) sel.addEventListener('change', () => pickDeployment(sel.value));
}
function pickDeployment(id) { A.deployPick = id; deployMemory(id); renderSidebar(); renderSpecial(); }
function renderCanvasView() {
  const el = $('#special');
  if (A.canvasApi && el.querySelector('.dcv-stage')) { A.canvasApi.refresh(); return; }
  A.canvasApi = DesigncCanvas.canvas.mount(el, canvasHostFor());
}
function latestTag(id) { const l = Core.latestCheck(A.ledger, id); return l ? `<span class="tag ${l.outcome === 'pass' ? 'pass' : 'fail'}">${l.outcome === 'pass' ? 'passing' : 'failing'} · ${when(l.ts)} · ${esc(l.source || '')}</span>` : '<span class="tag">no result</span>'; }
function telemetryBlock() {
  const T = A.tel;
  if (T.error || !T.meta) {
    return `<div class="block"><h3>Agent runs from Langfuse<span class="spacer"></span><button class="btn" data-s="tel">Refresh</button></h3><div class="note">${esc(T.error ? telErrorText(T.error) : 'Loading…')} ${T.error && T.error.error === 'not_configured' ? '<button class="lnk" data-s="llm">Open designc.json</button>' : ''}</div></div>`;
  }
  const g = telAgg();
  let h = `<div class="block"><h3>Agent runs from Langfuse${T.meta.source === 'sample' ? ' <span class="samplenote" style="margin:0">sample data</span>' : ''}<span class="spacer"></span><span class="muted" style="font-weight:400;font-size:12px">last ${T.meta.lookbackDays} days · fetched ${new Date(T.meta.fetchedAt).toLocaleTimeString()}${T.meta.truncated ? ' · truncated' : ''}</span><button class="btn" data-s="tel">Refresh</button></h3>
    <div class="stats" style="border:0;border-bottom:1px solid var(--edge);margin:0"><div class="stat"><div class="v">${g.tpp != null ? fmtN(g.tpp) : 'n/a'}</div><div class="l">Tokens per passing task</div></div><div class="stat"><div class="v">${g.passedTasks.length} of ${g.tasks.size}</div><div class="l">Tasks passed</div></div><div class="stat"><div class="v">${g.total.runs ? Math.round(100 * g.total.failed / g.total.runs) + '%' : 'n/a'}</div><div class="l">Runs failed</div></div><div class="stat"><div class="v">${money(g.total.cost)}</div><div class="l">Model cost, all systems</div></div></div>`;
  h += `<div class="tw2"><table class="t"><tr><th>Element</th><th class="num">Tasks</th><th class="num">Runs</th><th class="num">Failed runs</th><th class="num">Tokens</th><th class="num">Cost</th></tr>${[...g.byEl.values()].sort((a, b) => b.cost - a.cost).map(e => `<tr><td>${esc(e.element)}${e.known || e.element === '(no element)' ? '' : ' <span class="tag open">not in design</span>'}</td><td class="num">${e.tasks.size}</td><td class="num">${e.runs}</td><td class="num">${e.failed}</td><td class="num">${fmtN(e.tokens)}</td><td class="num">${money(e.cost)}</td></tr>`).join('')}</table></div>`;
  const bad = g.runs.filter(r => ['failed', 'error', 'escalated'].includes(r.outcome)).slice(0, 8);
  if (bad.length) h += `<div class="note" style="border-top:1px solid var(--edge)"><b>Recent failed or escalated runs</b></div><div class="tw2"><table class="t"><tr><th>When</th><th>Task</th><th>Element</th><th>Attempt</th><th>What went wrong</th><th></th></tr>${bad.map(r => `<tr><td>${when(r.start)}</td><td><span class="id">${esc(r.task || '')}</span></td><td>${esc(r.element || '')}</td><td class="num">${r.attempt || ''}</td><td>${esc(r.firstError || r.outcome)}</td><td>${r.url ? `<a class="lnk" href="${esc(r.url)}" target="_blank" rel="noreferrer">Open in Langfuse</a>` : ''}</td></tr>`).join('')}</table></div>`;
  if (g.gaps.noElement || g.gaps.noTask || g.gaps.unknownElement) h += `<div class="note" style="border-top:1px solid var(--edge)"><b>Tagging gaps.</b> ${[g.gaps.noElement && `${plural(g.gaps.noElement, 'pipeline run')} with no <span class="code">element</span>`, g.gaps.noTask && `${plural(g.gaps.noTask, 'run')} with no <span class="code">task</span>`, g.gaps.unknownElement && `${plural(g.gaps.unknownElement, 'run')} naming an element the design doesn't have`].filter(Boolean).join('; ')}. These can't be tied to the design; see the tagging convention in the README.</div>`;
  return h + '</div>';
}
function buildDash() {
  const L = A.ledger, tasks = L.filter(e => e.kind === 'task'), passed = tasks.filter(t => t.status === 'passed');
  const tokens = tasks.reduce((a, t) => a + Ledger.totalTokens(t), 0), reruns = tasks.reduce((a, t) => a + (t.reruns || 0), 0);
  const taskCosts = tasks.map(t => t.cost).filter(c => typeof c === 'number');
  const totalCost = taskCosts.length ? taskCosts.reduce((a, c) => a + c, 0) : null;
  const needs = L.filter(e => e.kind === 'needs_decision');
  let h = `<div class="dash"><h1>Build</h1><p class="lede">What the coding pipeline did with the handed-over design, from <span class="code">ledger/*.jsonl</span>. The checks are the decisions' own checks, so a failure here is a design question, not only a red build.</p>`;
  h += telemetryBlock();
  if (L.some(e => e.sample)) h += `<span class="samplenote">Includes sample events from ledger/pipeline.jsonl</span>`;
  if (!L.length) return h + `<div class="block"><h3>No pipeline events yet</h3><div class="note">The pipeline appends one JSON object per line to <span class="code">ledger/*.jsonl</span>, each with a <span class="code">kind</span>: task, check, needs_decision, asbuilt_edge, escape or false_positive. This view updates as the files change.</div></div></div>`;
  h += `<div class="stats"><div class="stat"><div class="v">${passed.length ? fmtN(tokens / passed.length) : 'n/a'}</div><div class="l">Tokens per passing task</div></div><div class="stat"><div class="v">${passed.length} of ${tasks.length}</div><div class="l">Tasks passed</div></div><div class="stat"><div class="v">${tasks.length ? (reruns / tasks.length).toFixed(1) : '0'}</div><div class="l">Reruns per task</div></div><div class="stat"><div class="v">${needs.filter(n => n.status === 'open').length}</div><div class="l">Waiting on a decision</div></div>${totalCost != null ? `<div class="stat"><div class="v">${money(totalCost)}</div><div class="l">Total task cost</div></div>` : ''}</div>`;
  const decs = A.decisions.filter(d => d.status === 'bound' || Core.latestCheck(L, d.id));
  h += `<div class="grid2"><div class="block"><h3>Decision checks</h3>${decs.length ? `<div class="tw2"><table class="t"><tr><th>Decision</th><th>Check</th><th>Latest</th></tr>${decs.map(d => `<tr><td><span class="id">${esc(d.id)}</span> ${esc(trunc(d.statement || '', 56))}</td><td><span class="code">${esc((d.checks || [])[0] || '')}</span></td><td>${latestTag(d.id)}</td></tr>`).join('')}</table></div>` : '<div class="note">No bound decisions have results yet.</div>'}</div>`;
  h += `<div class="block"><h3>Waiting on a decision</h3>${needs.length ? `<div class="tw2"><table class="t"><tr><th>Item</th><th>Question</th><th>Status</th></tr>${needs.map(n => `<tr><td><span class="id">${esc(n.id)}</span><div style="color:var(--fg3)">${esc(n.task || '')} · ${esc(n.element || '')}</div></td><td>${esc(n.question)}</td><td><span class="tag ${n.status === 'open' ? 'open' : 'pass'}">${esc(n.status)}</span></td></tr>`).join('')}</table></div>` : '<div class="note">Nothing is blocked.</div>'}</div></div>`;
  const byEl = new Map(); for (const t of tasks) { const k = t.element || 'unassigned'; if (!byEl.has(k)) byEl.set(k, []); byEl.get(k).push(t); }
  const names = new Set(A.model ? [...A.model.elements.values()].map(e => e.name) : []);
  h += `<div class="block"><h3>Tasks by element</h3><div class="tw2"><table class="t"><tr><th>Element</th><th class="num">Tasks</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Reruns</th><th class="num">Tokens</th><th class="num">Tokens per pass</th></tr>${[...byEl].map(([el, ts]) => { const p = ts.filter(t => t.status === 'passed').length, tk = ts.reduce((a, t) => a + Ledger.totalTokens(t), 0); return `<tr><td>${esc(el)}${names.has(el) || el === 'unassigned' ? '' : ' <span class="tag open">not in design</span>'}</td><td class="num">${ts.length}</td><td class="num">${p}</td><td class="num">${ts.filter(t => t.status === 'failed').length}</td><td class="num">${ts.reduce((a, t) => a + (t.reruns || 0), 0)}</td><td class="num">${fmtN(tk)}</td><td class="num">${p ? fmtN(tk / p) : 'n/a'}</td></tr>`; }).join('')}</table></div></div>`;
  const dr = A.drift || (A.model && A.model.elements.size ? Core.drift(A.model, L) : null);
  h += `<div class="block"><h3>As built vs designed</h3>${!dr ? '<div class="note">No asbuilt_edge events yet.</div>' : (!dr.undeclared.length && !dr.unrealised.length && !dr.unknownEls.length) ? '<div class="note">No drift.</div>' : `<div class="tw2"><table class="t"><tr><th>Drift</th><th>Detail</th></tr>${dr.undeclared.map(d => `<tr><td><span class="code warning">DC100</span> Undeclared dependency</td><td>${esc(d.from)} → ${esc(d.to)} is in code but not in the design</td></tr>`).join('')}${dr.unknownEls.map(n => `<tr><td><span class="code warning">DC102</span> Not in design</td><td>${esc(n)} appears in code only</td></tr>`).join('')}${dr.unrealised.map(d => `<tr><td><span class="code">DC101</span> Not built yet</td><td>${esc(d.from)} → ${esc(d.to)} is designed but not in code</td></tr>`).join('')}</table></div>`}</div>`;
  const order = { failed: 0, blocked: 1, running: 2, passed: 3 };
  h += `<div class="block"><h3>Tasks</h3><div class="tw2"><table class="t"><tr><th>Task</th><th>Element</th><th>Status</th><th class="num">Reruns</th><th class="num">Turns</th><th class="num">Tokens</th><th>Model</th></tr>${tasks.slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)).map(t => `<tr><td><span class="id">${esc(t.task || '')}</span> ${esc(t.title || '')}</td><td>${esc(t.element || '')}</td><td><span class="tag ${t.status === 'passed' ? 'pass' : t.status === 'failed' ? 'fail' : 'open'}">${esc(t.status)}</span></td><td class="num">${t.reruns || 0}</td><td class="num">${t.turns || ''}</td><td class="num">${fmtN(Ledger.totalTokens(t))}</td><td>${esc(t.model || '')}</td></tr>`).join('')}</table></div></div></div>`;
  return h;
}
function ledgerIntegrityHtml() {
  const r = Ledger.verify(A.ledgerFiles, { handovers: A.handovers.map(h => h.id), decisions: A.decisions.map(d => ({ id: d.id, kind: d.kind })), handoverEvals: Object.fromEntries(A.handovers.filter(h => h.evals && typeof h.evals === 'object').map(h => [h.id, h.evals])) });
  const rows = [...r.errors.map(x => ({ ...x, sev: 'Error' })), ...r.warnings.map(x => ({ ...x, sev: 'Warning' }))];
  const summary = rows.length ? `${plural(r.errors.length, 'error')}, ${plural(r.warnings.length, 'warning')}.` : 'The ledger is consistent.';
  return `<div class="block"><h3>Ledger integrity</h3><div class="note">${esc(summary)}${r.skipped ? ` ${esc(plural(r.skipped, 'sample event'))} skipped.` : ''} Checks that each handover follows a ready gate event at its revision, each promotion follows a passing check, every line is valid and the handovers folder matches the ledger. <code>designc verify-ledger</code> gives the same answer in CI.</div>${rows.length ? `<div class="tw2"><table class="t"><tr><th>Rule</th><th>Level</th><th>What</th></tr>${rows.map(x => `<tr><td>${esc(x.rule)}</td><td>${esc(x.sev)}</td><td>${esc(x.msg)}</td></tr>`).join('')}</table></div>` : ''}</div>`;
}
function improveDash() {
  const L = A.ledger, escapes = L.filter(e => e.kind === 'escape'), fps = L.filter(e => e.kind === 'false_positive'), un = escapes.filter(e => !e.caught_by);
  let h = `<div class="dash"><h1>Improve</h1><p class="lede">Where problems got past the factory, which stage should have caught them, and what should change in the design compiler or the pipeline. Proposals follow the decision lifecycle: nothing changes until you bind one.</p>`;
  const noSrc = Core.RULES.filter(r => /not yet/.test(r.source)).length;
  h += `<div class="stats"><div class="stat"><div class="v">${escapes.length}</div><div class="l">Escapes recorded</div></div><div class="stat"><div class="v">${un.length}</div><div class="l">Not yet classified</div></div><div class="stat"><div class="v">${A.proposals.filter(p => !['bound', 'rejected', 'superseded'].includes(p.status)).length}</div><div class="l">Open proposals</div></div><div class="stat"><div class="v">${noSrc} of ${Core.RULES.length}</div><div class="l">Rules with no incident behind them</div></div></div>`;
  const rows = STAGES.map(([k, l]) => [l, escapes.filter(e => e.caught_by === k).length]).concat([['Not classified', un.length]]); const max = Math.max(1, ...rows.map(r => r[1]));
  h += `<div class="grid2"><div class="block"><h3>Escapes by the stage that should have caught them</h3>${escapes.length ? `<div class="bars">${rows.map(([l, n], i) => `<div class="barrow"><span>${esc(l)}</span><div class="bartrack"><div class="barfill ${i === rows.length - 1 ? 'un' : ''}" style="width:${(n / max) * 100}%"></div></div><span class="c">${n}</span></div>`).join('')}</div>` : '<div class="note">No escapes yet.</div>'}</div>`;
  h += `<div class="block"><h3>Rule health</h3><div class="tw2"><table class="t"><tr><th>Rule</th><th class="num">Firing</th><th class="num">Suppressed</th><th class="num">Escapes</th><th class="num">False +</th></tr>${Core.RULES.map(r => { const f = A.diags.filter(d => d.code === r.code); return `<tr><td><span class="code">${r.code}</span> ${esc(r.title)}<div style="color:var(--fg3);font-size:11.5px">${esc(r.source)}</div></td><td class="num">${f.filter(d => !d.suppressed).length}</td><td class="num">${f.filter(d => d.suppressed).length}</td><td class="num">${escapes.filter(e => e.code === r.code).length}</td><td class="num">${fps.filter(e => e.code === r.code).length}</td></tr>`; }).join('')}</table></div></div></div>`;
  const sug = telSuggestions();
  if (sug.length) h += `<div class="block"><h3>Suggested by telemetry</h3><div class="note">Pipeline tasks that needed three or more attempts, failed, or escalated. Recording one makes it an escape you can classify.</div><div class="tw2"><table class="t"><tr><th>Task</th><th>Element</th><th>Why</th><th class="num">Tokens</th><th>Last error</th><th></th></tr>${sug.map(t => `<tr><td><span class="id">${esc(t.task)}</span></td><td>${esc(t.element || '')}</td><td>${esc(t.why)}</td><td class="num">${fmtN(t.tokens)}</td><td>${esc((t.runs.filter(r => r.firstError).pop() || {}).firstError || '')}</td><td><button class="btn" data-telesc="${esc(t.task)}">Record as escape</button></td></tr>`).join('')}</table></div></div>`;
  if (escapes.length) h += `<div class="block"><h3>Escapes</h3><div class="tw2"><table class="t"><tr><th>When</th><th>Where</th><th>What happened</th><th>Should have been caught by</th></tr>${escapes.slice().sort((a, b) => (b._ts || 0) - (a._ts || 0)).map(e => `<tr><td>${when(e.ts)}</td><td>${esc(e.element || '')}</td><td>${esc(e.description || '')}${e.code ? ` <span class="code">${esc(e.code)}</span>` : ''}</td><td><select class="inline" data-classify="${esc(e.id)}"><option value="">Not classified</option>${STAGES.map(([k, l]) => `<option value="${k}" ${e.caught_by === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td></tr>`).join('')}</table></div></div>`;
  const acts = Ledger.agentActivity(L), unap = Ledger.unapprovedChanges(L);
  if (acts.length) h += `<div class="block"><h3>Agent activity</h3><div class="note">What agents did through designc, from <code>ledger/agents.jsonl</code>. Declined means a person said no to a write. Unapproved means a registry file changed during an agent turn without an approval.</div><div class="tw2"><table class="t"><tr><th>Agent</th><th>Role</th><th>Via</th><th class="num">Turns</th><th class="num">Tokens</th><th class="num">Tool calls</th><th class="num">Asked</th><th class="num">Declined</th><th class="num">Denied</th><th class="num">Permissions</th><th class="num">Approvals</th><th class="num">Unapproved</th><th>Last</th></tr>${acts.map(r => `<tr><td>${esc(r.agent)}</td><td>${esc(r.role)}</td><td>${esc(r.via || '')}</td><td class="num">${fmtN(r.turns)}</td><td class="num">${fmtN(r.tokens)}</td><td class="num">${fmtN(r.tools)}</td><td class="num">${fmtN(r.asked)}</td><td class="num">${fmtN(r.declined)}</td><td class="num">${fmtN(r.denied)}</td><td class="num">${fmtN(r.permissions)}</td><td class="num">${fmtN(r.approvals)}</td><td class="num">${r.unapproved ? `<b>${fmtN(r.unapproved)}</b>` : '0'}</td><td>${esc(when(r.last))}</td></tr>`).join('')}</table></div></div>`;
  if (unap.length) h += `<div class="block"><h3>Unapproved changes</h3><div class="tw2"><table class="t"><tr><th>When</th><th>Agent</th><th>Role</th><th>File</th></tr>${unap.slice().sort((a, b) => (b._ts || 0) - (a._ts || 0)).map(e => `<tr><td>${esc(when(e._ts))}</td><td>${esc(e.agent)}</td><td>${esc(e.role)}</td><td>${esc(e.path)}</td></tr>`).join('')}</table></div></div>`;
  h += ledgerIntegrityHtml();
  h += `<div class="block"><h3>Proposals</h3>${A.proposals.length ? `<div class="tw2"><table class="t"><tr><th>Proposal</th><th>Kind</th><th>Change</th><th>Evidence</th><th>How we'll know</th><th>Status</th></tr>${A.proposals.map(p => `<tr data-open="${esc(p._path)}" style="cursor:pointer"><td><span class="id">${esc(p.id)}</span></td><td>${esc(p.kind || '')}</td><td>${esc(p.statement || '')}</td><td>${esc(p.evidence || '')}</td><td>${p.check ? esc(p.check) : '<span style="color:var(--err)">no check</span>'}</td><td><span class="tag ${esc(p.status || 'minted')}">${esc(p.status || 'minted')}</span></td></tr>`).join('')}</table></div>` : '<div class="note">No proposals yet. Each should cite an escape and say how you will know the change works.</div>'}</div></div>`;
  return h;
}

// ---------------------------------------------------------------- events
document.addEventListener('click', async e => {
  const t = e.target.closest('button, input[data-a], [data-file], [data-dir], [data-open], [data-tab], [data-clause], [data-toggle], [data-code], [data-cmsel], [data-dppick], .node, [data-s]'); if (!t) return;
  const d = t.dataset;
  if (d.dppick) return pickDeployment(d.dppick);
  if (d.close) { e.stopPropagation(); closeTab(d.close); return; }
  if (d.tab) return activate(d.tab);
  if (d.toggle && !e.target.closest('.acts')) { A.collapsed.has(d.toggle) ? A.collapsed.delete(d.toggle) : A.collapsed.add(d.toggle); renderSidebar(); return; }
  if (d.dir) { A.expanded.has(d.dir) ? A.expanded.delete(d.dir) : A.expanded.add(d.dir); renderSidebar(); return; }
  if (d.file) return openFile(d.file);
  if (d.fixfi) { e.stopPropagation(); return recordDecision({ finding: A.diags[+d.fixfi] }); }
  if (d.bind) { e.stopPropagation(); return bindDecision(A.decisions.find(x => x.id === d.bind)); }
  if (d.run) { e.stopPropagation(); return runChecks(A.decisions.filter(x => x.id === d.run)); }
  if (d.qdraft) { const q = A.grill.questions[+d.qdraft]; return recordDecision({ statement: q.suggested_decision || '', effect: q.suggested_effect === 'accept' ? 'accept' : 'fix', binds: q.element ? [q.element] : [], resolves: /^DC\d{3}$/.test(q.code || '') ? [q.code] : [], checks: q.suggested_check ? [q.suggested_check] : [], rationale: `${q.question} Answer: ${q.answer || ''}` }); }
  if (d.qbiz) { const q = A.grill.questions[+d.qbiz]; return recordDecision({ kind: 'business', statement: q.suggested_decision || q.question || '', effect: 'accept', binds: [], resolves: [], rationale: `${q.question} Answer: ${q.answer || ''}` }); }
  if (d.ndans) { const n = A.ledger.find(x => x.id === d.ndans); return recordDecision({ binds: n && n.element ? [n.element] : [], resolves: [], rationale: n ? `Pipeline asked (${n.id}): ${n.question}` : '' }); }
  if (d.telesc) {
    const t = telAgg().tasks.get(d.telesc); if (!t) return;
    const id = Ledger.escapeId(crypto.randomUUID());
    const err = (t.runs.filter(r => r.firstError).pop() || {}).firstError;
    await recordEvent('escape', { id, element: designNameFor(t.element) || t.element || null, task: t.task,
      description: `${t.task}: ${t.runs.length} attempt${t.runs.length === 1 ? '' : 's'}, last ${t.final}${err ? ` (${err})` : ''}`, source: 'langfuse', traces: t.runs.map(r => r.traceId) });
    toast(`Recorded ${id}. Classify it in Improve.`); return;
  }
  if (d.ndres) { await recordEvent('needs_decision_resolved', { id: d.ndres }); return; }
  if (d.runeval) return runEvals(d.runeval);
  if (d.open) return openFile(d.open, d.line ? +d.line : undefined);
  if (d.clause) {
    const c = A.gate.clauses[+d.clause];
    if (c.line) return openFile(A.cfg.model, c.line);
    if (c.decision) { const x = A.decisions.find(y => y.id === c.decision); if (x) return openFile(x._path); }
    if (c.requirement) { const x = A.requirements.find(y => y.id === c.requirement); if (x) return openFile(x._path); }
    if (c.kind === 'needs') return setActivity('build');
    if (c.kind === 'eval' && c.evalId != null) { const x = A.evals.find(y => String(y.id) === String(c.evalId)); if (x) return openFile(x._path); }
    return;
  }
  if (d.code) return openCode(d.code, d.line ? +d.line : undefined);
  if (d.cmsel && A.asbuiltFull) { const x = A.asbuiltFull.elements.get(d.cmsel); if (x && x.kind === 'component' && A.cmLevel !== 'component') { A.cmLevel = 'component'; A.cmScope = x.parent; A.cmZoom = 'fit'; } }
  if (d.cmsel) { A.cmSel = d.cmsel; if (A.active !== 'special:codemap') openSpecial('special:codemap'); else drawCodemap(); return; }
  if (d.cm) { A.cmSel = A.cmSel === d.cm ? null : d.cm; return drawCodemap(); }
  if (t.classList.contains('node')) { A.selected = t.dataset.el; const el = A.model.elements.get(A.selected); renderSheet(); if (el) openFile(A.cfg.model, el.line); return; }
  if (d.recent) { const i = await host.openPath(d.recent); return onFolder(i); }
  if (d.s) {
    if (d.s === 'open') return host.openFolder();
    if (d.s === 'problems') return showPanel('problems');
    if (d.s === 'output') return showPanel('output');
    if (d.s === 'gate') return setActivity('design');
    if (d.s === 'llm') return openFile('designc.json');
    if (d.s === 'tel') { if (A.tel.error && A.tel.error.error === 'not_configured') return openFile('designc.json'); if (A.tel.error) toast(telErrorText(A.tel.error), 'warning'); return loadTelemetry(); }
    if (d.s === 'folder') return setActivity('explorer');
  }
  if (d.panel) return showPanel(d.panel);
  if (d.act) return setActivity(d.act);
  const a = d.a;
  if (a === 'open') return host.openFolder();
  if (a === 'sample') { const i = await host.openSample(); return onFolder(i); }
  if (a === 'freeze') return freezeHandover();
  if (a === 'rebindall') return rebindAll();
  if (a === 'newdec') return recordDecision();
  if (a === 'newreq') return newRequirement();
  if (a === 'newprop') return newProposal();
  if (a === 'runall') return runChecks();
  if (a === 'newscn') return newScenario();
  if (a === 'runfit') return runFitness();
  if (a === 'neweval') return newEval();
  if (a === 'runevals') return runEvals();
  if (a === 'grill') return grill();
  if (a === 'draftprops') return draftProposals();
  if (a === 'builddash') return openSpecial('special:build');
  if (a === 'improvedash') return openSpecial('special:improve');
  if (a === 'design') return setActivity('design');
  if (a === 'extract') return extractCodebase();
  if (a === 'choosecode') { if (await chooseCodebase()) return extractCodebase(); return; }
  if (a === 'adopt') return adoptAsDesign();
  if (a === 'adoptcomp') return adoptComponents(d.built, d.design);
  if (a === 'cmfit') { A.cmZoom = 'fit'; return drawCodemap(); }
  if (a === 'cmlevel') return cmGo(d.level, null);
  if (a === 'cmscope') return cmGo('component', null);
  if (a === 'ghost') { A.showGhost = t.checked; return drawCodemap(); }
  if (a === 'codemapopen') return setActivity('codemap');
  if (a === 'newmodel') return createAndOpen(A.cfg.model, `workspace "${A.root.name}" {\n  model {\n    \n  }\n}\n`, 3);
});
document.addEventListener('change', async e => {
  const d = e.target.dataset;
  if (d.classify) await recordEvent('escape_classified', { escape: d.classify, caught_by: e.target.value || null });
});
document.addEventListener('input', e => { if (e.target.dataset.ans != null) A.grill.questions[+e.target.dataset.ans].answer = e.target.value; });
$('#panelClose').addEventListener('click', () => { A.panelOpen = false; $('#workbench').classList.add('nopanel'); });
$('#panelClear').addEventListener('click', () => { A.output = ''; renderPanel(); });
$('#sheetClose').addEventListener('click', () => { A.sheetOpen = false; renderSheet(); });
$('#sheetFit').addEventListener('click', () => { A.zoom = 'fit'; renderSheet(); });
$('#sheetBadges').addEventListener('change', e => { A.badges = e.target.value; renderSheet(); });
document.addEventListener('wheel', e => {
  const c = e.target.closest && e.target.closest('#cmcanvas'); if (!c || (!e.ctrlKey && !e.metaKey)) return; e.preventDefault();
  const svg = c.querySelector('svg'); const cur = A.cmZoom === 'fit' && svg ? svg.width.baseVal.value / svg.viewBox.baseVal.width : A.cmZoom;
  A.cmZoom = Math.max(0.3, Math.min(2, cur * (e.deltaY < 0 ? 1.1 : 0.9))); drawCodemap();
}, { passive: false });
// double-click is read from the click event's detail in the capture phase: the first click redraws the
// canvas, which can swallow the native dblclick, and the plain click handler would toggle the selection
document.addEventListener('click', e => {
  if (e.detail !== 2 || !A.asbuiltFull) return;
  const t = e.target, c = t.closest && t.closest('#cmcanvas'); if (!c) return;
  const node = t.closest('.node[data-cm]'), grp = t.closest('[data-cmg]');
  const id = node ? node.dataset.cm : grp ? grp.dataset.cmg : null;
  const el = id && A.asbuiltFull.elements.get(id);
  if (id && !el) return;
  e.stopPropagation();
  if (!el) return cmUp();
  if (el.kind === 'container') return cmGo('component', id);
  if (el.kind === 'component') { A.cmSel = id; return drawCodemap(); }
}, true);
document.addEventListener('keydown', e => {
  if (e.key !== 'Backspace' || A.active !== 'special:codemap' || !A.asbuiltFull) return;
  const t = e.target; if (t && t.closest && t.closest('input, textarea, select, [contenteditable], .monaco-editor')) return;
  e.preventDefault(); cmUp();
});
$('#sheetscroll').addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return; e.preventDefault();
  const svg = $('#sheetscroll svg'); const cur = A.zoom === 'fit' && svg ? svg.width.baseVal.value / svg.viewBox.baseVal.width : A.zoom;
  A.zoom = Math.max(0.3, Math.min(2, cur * (e.deltaY < 0 ? 1.1 : 0.9))); renderSheet();
}, { passive: false });
new ResizeObserver(debounce(() => { if (A.zoom === 'fit') renderSheet(); if (A.active === 'special:codemap' && A.cmZoom === 'fit') drawCodemap(); }, 120)).observe($('#workbench'));

// resizable sidebar and panel
function drag(sashId, onMove) {
  const s = $(sashId);
  s.addEventListener('mousedown', ev => {
    ev.preventDefault(); s.classList.add('drag');
    const mv = e => onMove(e); const up = () => { s.classList.remove('drag'); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  });
}
drag('#sash', e => document.documentElement.style.setProperty('--sbw', Math.max(180, Math.min(600, e.clientX - 48)) + 'px'));
drag('#psash', e => { const r = $('#workbench').getBoundingClientRect(); $('#workbench').style.setProperty('--ph', Math.max(80, Math.min(r.height - 120, r.bottom - e.clientY)) + 'px'); });

// ---------------------------------------------------------------- commands from the menu
host.onCmd(cmd => {
  if (cmd === 'save') return save();
  if (cmd === 'close-tab') return A.active && closeTab(A.active);
  if (cmd === 'extract') return extractCodebase();
  if (cmd.startsWith('view:')) { const v = cmd.slice(5); if (A.activity !== v || !A.sidebarOpen) setActivity(v); return; }
  if (cmd === 'toggle-sheet') { A.sheetOpen = !A.sheetOpen; return renderSheet(); }
  if (cmd === 'panel:problems') return showPanel('problems');
  if (cmd === 'panel:output') return showPanel('output');
  if (cmd === 'run-checks') return runChecks();
  if (cmd === 'grill') return grill();
  if (cmd === 'freeze') return freezeHandover();
  if (cmd === 'open-settings') return A.root && openFile('designc.json');
  if (cmd === 'help:props') { showPanel('output'); A.output += '\nDesign properties\n' + PROPS.map(([k, t, v, d]) => `  ${k.padEnd(18)} ${t.padEnd(13)} ${v ? v.join(' | ') : ''}\n  ${' '.repeat(18)} ${d}`).join('\n') + '\n'; renderPanel(); }
});
host.onChanged(paths => { if (A.root) { gitRefreshSoon(); if (typeof agentSawChange === 'function') agentSawChange(paths); onDiskChanged(paths); } });
host.onFolder(info => onFolder(info));
host.onCheckOutput((_id, chunk) => appendOutput(chunk));

async function onFolder(info) {
  if (!info) return;
  for (const [, b] of A.buffers) b.model.dispose();
  A.buffers.clear(); A.tabs = []; A.active = null; A.selected = null; A.zoom = 'fit'; A.cmSel = null; A.cmZoom = 'fit'; A.grill = { busy: false, questions: [], error: null };
  A.canvasApi = null; A.canvasLayout = null;
  A.cmLevel = 'container'; A.cmScope = null; A.asbuiltFull = null;
  A.root = info; A.tree = await host.tree();
  await reloadAll();
  if (A.model.elements.size || A.model.errors.length) await openFile(A.cfg.model); else activate(null);
  if (A.activity !== 'explorer' || !A.sidebarOpen) { A.activity = 'explorer'; A.sidebarOpen = true; $('#shell').classList.remove('nosidebar'); }
  document.querySelectorAll('#activity button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.act === 'explorer')));
  renderAll();
  gitRefresh();
}

// ---------------------------------------------------------------- boot
window.MonacoEnvironment = { getWorkerUrl: () => '../node_modules/monaco-editor/min/vs/base/worker/workerMain.js' };
require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
require(['vs/editor/editor.main'], async () => {
  setupMonaco(window.monaco);
  const info = await host.boot();
  A.user = info.user; A.recent = info.recent;
  A.model = Core.parse(''); A.diags = []; A.gate = Core.gate({ model: A.model, diags: [], decisions: [], requirements: [], ledger: [] });
  document.querySelectorAll('#activity button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.act === 'explorer')));
  if (info.root) await onFolder(info.root); else { activate(null); renderAll(); }
});
