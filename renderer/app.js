/* designc desktop renderer. File system and processes live in main.js behind window.host. */
'use strict';

// ---------------------------------------------------------------- reference data
const PROPS = [
  ['d.interaction', 'relationship', ['sync', 'async'], 'Call style. Undeclared counts as sync for DC003.'],
  ['d.delivery', 'relationship', ['at-most-once', 'at-least-once', 'exactly-once'], 'Delivery guarantee of an async interaction (DC001).'],
  ['d.idempotent', 'relationship', ['yes', 'no'], 'Whether the receiver handles this interaction idempotently (DC001, DC004).'],
  ['d.retry', 'relationship', ['none', 'fixed', 'backoff'], 'Caller retry policy (DC004).'],
  ['d.retry.max', 'relationship', null, 'Maximum retry attempts, a whole number.'],
  ['d.timeout', 'relationship', null, 'Caller timeout in milliseconds. Must cover the callee\'s worst case (DC007).'],
  ['d.encrypted', 'relationship', ['yes', 'no'], 'Encrypted in transit (DC006).'],
  ['d.authenticated', 'relationship', ['yes', 'no'], 'Caller is authenticated (DC006).'],
  ['d.writes', 'relationship', null, 'Comma-separated entities written to the destination store (DC002).'],
  ['d.concurrency', 'relationship', ['none', 'optimistic', 'pessimistic'], 'Concurrency control on those writes (DC002).'],
  ['d.latency.max', 'element', null, 'Worst-case own processing time in milliseconds, not counting its calls (DC007).'],
  ['d.fanout', 'element', ['sequential', 'parallel'], 'Whether the element makes its outgoing sync calls one after another or together. Default sequential (DC007).'],
  ['d.retry.budget', 'element', null, 'Retry amplification this receiver tolerates; overrides retryAmplification in designc.json (DC008).'],
  ['d.instances', 'element', null, 'Running instances, a whole number (DC002, DC005).'],
  ['d.critical', 'element', ['yes', 'no'], 'On a critical path (DC005).'],
  ['d.zone', 'element', null, 'Trust zone name; children inherit it (DC006).'],
  ['d.availability', 'element', null, 'Availability as a fraction, e.g. 0.999 (DC003).'],
  ['d.owns', 'element', null, 'Comma-separated entities this element owns writes to (DC002).'],
  ['d.store', 'element', ['yes', 'no'], 'Treat as a data store. Default: the Database tag.'],
  ['d.aka', 'element', null, 'Other names, used to match code in the as-built diff.'],
  ['d.code', 'element', null, 'Repo paths or globs where this element\'s code lives, comma-separated: * and ? within a folder name, ** as a whole folder (src/Api is one file; write src/Api/**). A coding agent keeps task writes inside them. Needs d.risk; areas must not overlap or nest (DC009).'],
  ['d.risk', 'element', ['low', 'medium', 'high'], 'How risky a change here is. A coding agent may use it to gate merges.'],
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
const ORIGIN_LABEL = { spec_gap: 'Spec gap', design_error: 'Design error', translation_error: 'Translation error', gate_gap: 'Gate gap' };
const STAGES = [['S1-lint', 'S1 lint'], ['S1-p', 'S1 behaviour (P)'], ['S1-grill', 'S1 grill-me / gate'], ['pipeline', 'Pipeline']];
if (typeof Ledger !== 'undefined') {
  const stageKeys = STAGES.map(([k]) => k).sort().join(',');
  const caughtBy = Ledger.CAUGHT_BY.slice().sort().join(',');
  if (stageKeys !== caughtBy) throw new Error(`STAGES keys must equal Ledger.CAUGHT_BY: [${stageKeys}] vs [${caughtBy}]`);
}
const REG_DIRS = ['decisions', 'requirements', 'proposals', 'handovers', 'scenarios', 'evals', 'acceptance'];
// Files whose change reloads the registry: the gate's inputs plus work items (which never reach the gate).
const isRegPath = p => REG_DIRS.some(d => p.startsWith(d + '/')) || p.startsWith('work/');

// ---------------------------------------------------------------- state
const A = {
  root: null, user: 'you', recent: [], tree: [], expanded: new Set(['model', 'decisions', 'requirements']),
  cfg: { model: 'model/workspace.dsl', chainHops: 4, retryAmplification: 4, llm: {} },
  buffers: new Map(),        // path -> {model, dirty, disk}
  tabs: [], active: null,    // tab ids: file paths or 'special:build' / 'special:improve'
  activity: 'explorer', sidebarOpen: true, panel: 'problems', panelOpen: true, sheetOpen: true,
  modelText: '', model: null, diags: [], gate: null,
  decisions: [], requirements: [], proposals: [], handovers: [], scenarios: [], evals: [], acceptance: [], tokens: null, yamlErrors: [],
  work: null, workErrors: [], workWarnings: [],   // work/*.yaml (renderer/workview.js); its problems never reach the gate
  ledgerRaw: [], ledger: [], ledgerErrors: [], ledgerFiles: [],
  output: '', running: false, collapsed: new Set(), suiteOpen: new Set(),
  grill: { busy: false, questions: [], error: null }, drafting: false,
  selected: null, zoom: 'fit', cursor: null,
  asbuilt: null, facts: null, drift: null, extracting: false, cmSel: null, cmZoom: 'fit', showGhost: true,
  cmLevel: 'container', cmScope: null, asbuiltFull: null, cdrift: null,
  tel: { runs: [], meta: null, error: null, loading: false }, badges: 'findings',
  canvasApi: null, canvasLayout: null,
  regs: { loaded: false, loading: false, rows: [], problems: [] },
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
// In-app replacement for window.prompt, which Electron does not support: resolves to the text, or null on Cancel.
function askText(message, value = '') {
  return new Promise(resolve => {
    const el = document.createElement('div'); el.className = 'askbox';
    el.innerHTML = `<form class="askcard"><label>${esc(message)}</label><input value="${esc(value)}" spellcheck="false"><div class="ta"><button type="button" class="btn" data-ask="no">Cancel</button><button class="btn primary">OK</button></div></form>`;
    const input = el.querySelector('input'), done = v => { el.remove(); resolve(v); };
    el.querySelector('form').addEventListener('submit', e => { e.preventDefault(); done(input.value); });
    el.querySelector('[data-ask=no]').addEventListener('click', e => { e.stopPropagation(); done(null); });
    el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
    document.body.appendChild(el); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  });
}
// One button per option plus Cancel; resolves to the chosen value, or null on Cancel or Escape.
function askChoice(message, options) {
  return new Promise(resolve => {
    const el = document.createElement('div'); el.className = 'askbox';
    el.innerHTML = `<div class="askcard"><label>${esc(message)}</label><div class="choices">${options.map((o, i) => `<button type="button" class="btn${o.primary ? ' primary' : ''}" data-choice="${i}">${esc(o.label)}</button>`).join('')}</div><div class="ta"><button type="button" class="btn" data-ask="no">Cancel</button></div></div>`;
    const done = v => { el.remove(); resolve(v); };
    el.addEventListener('click', e => { const b = e.target.closest('[data-choice],[data-ask]'); if (!b) return; e.stopPropagation(); done(b.dataset.choice != null ? options[+b.dataset.choice].value : null); });
    el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
    document.body.appendChild(el); el.querySelector('button').focus();
  });
}

// ---------------------------------------------------------------- registry loading
function textOf(path) { const b = A.buffers.get(path); return b ? b.model.getValue() : null; }
// Optional files (settings, model, as-built) are probed with exists first: a rejected fs:read is logged by Electron in the main process.
async function readText(path) { const t = textOf(path); if (t != null) return t; try { return (await host.exists(path)) ? await host.read(path) : null; } catch { return null; } }

async function loadSettings() {
  A.cfg = { model: 'model/workspace.dsl', chainHops: 4, retryAmplification: 4, llm: {} };
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
  [A.decisions, A.requirements, A.proposals, A.handovers, A.scenarios, A.evals, A.acceptance] = await Promise.all(REG_DIRS.map(d => loadYamlDir(d, d === 'evals' || d === 'acceptance')));
  A.tokens = await host.exists(TOKENS) ? await host.read(TOKENS) : null;
  // Folder handovers (handovers/<id>/handover.yaml) sit beside the older flat files.
  const hv = ((Array.isArray(A.tree) ? A.tree : []).find(n => n.dir && n.name === 'handovers')) || { children: [] };
  for (const c of hv.children.filter(n => n.dir)) A.handovers.push(...await loadYamlDir(`handovers/${c.name}`));
  A.handovers.sort((a, b) => (+new Date(a.created) || 0) - (+new Date(b.created) || 0) || String(a.id).localeCompare(String(b.id)));
  A.decisions.forEach(d => { d.status = d.status || 'minted'; d.effect = d.effect || 'fix'; });
  await loadTaxonomy(); await loadFactoryTasks(); await loadLabels(); await loadWork();
}
// factory/tasks/*.yaml: eval tasks for the Build pipeline. Their hash is of the text on disk (or in an open buffer), so
// binding pins exactly what was read. Not a gate input.
async function loadFactoryTasks() {
  A.ftasks = []; A.ftaskErrors = [];
  for (const f of await host.list('factory/tasks', ['.yaml', '.yml'])) {
    const text = textOf(f.path) ?? f.text;
    try {
      const o = jsyaml.load(text) || {};
      if (typeof o !== 'object' || Array.isArray(o)) throw new Error('expected a mapping at the top level');
      A.ftasks.push({ ...o, id: o.id || f.path.split('/').pop().replace(/\.ya?ml$/, ''), hash: Core.evalHash({ _text: text }), _path: f.path });
    } catch (e) { A.ftaskErrors.push(`${f.path} does not parse: ${e.reason || e.message}`); }
  }
}
async function bindFactoryTask(id) {
  const r = Ledger.factoryTasks(A.ledger, { tasks: A.ftasks, taxonomy: A.taxonomy }), t = r.tasks.find(x => x.id === id), src = A.ftasks.find(x => String(x.id) === id);
  if (!t || !src) return;
  if (!t.bindable) return toast(t.bindProblem || `${id} cannot be bound while it is ${t.status}.`, 'warning');
  const b = A.buffers.get(src._path);
  if (b && b.dirty) return toast(`${src._path} has unsaved edits. Save it first, so the hash recorded is the file you reviewed.`, 'warning');
  if (!confirm(`${t.status === 'changed' ? 'Re-bind' : 'Bind'} eval task ${id}? Binding means you, ${A.user}, accept this definition: suite runs that use a different version of it will be flagged.`)) return;
  await recordEvent('factory_task_bound', { task_id: id, hash: src.hash });
  toast(`Bound ${id}.`, 'info');
}
// factory/labels/<dimension>.yaml: rounds of a judge scored against a person's labels. Shown in Improve, never gating.
async function loadLabels() {
  A.labels = []; A.labelErrors = [];
  for (const f of await host.list('factory/labels', ['.yaml', '.yml'])) {
    try {
      const o = jsyaml.load(textOf(f.path) ?? f.text) || {};
      if (typeof o !== 'object' || Array.isArray(o)) throw new Error('expected a mapping at the top level');
      A.labels.push({ ...o, dimension: o.dimension || f.path.split('/').pop().replace(/\.ya?ml$/, ''), _path: f.path });
    } catch (e) { A.labelErrors.push(`${f.path} does not parse: ${e.reason || e.message}`); }
  }
}
const CAL_TAG = { ok: 'bound', below: 'fail', stale: 'warning', uncalibrated: 'minted' };
function calibrationHtml() {
  if (!A.labels || (!A.labels.length && !A.labelErrors.length)) return '';
  const r = Ledger.calibrationStatus(A.labels, { threshold: (A.cfg.factory || {}).calibrationThreshold });
  const pct = x => `${Math.round(x * 100)}%`;
  const notes = [...A.labelErrors, ...r.problems.map(p => `factory/labels: ${p}`)];
  return `<div class="block"><h3>Judge calibration<span class="spacer"></span><span class="note-i">${plural(r.dimensions.filter(d => d.status === 'ok').length, 'dimension')} calibrated</span></h3>
    <div class="note">How well each judge agrees with your labels, from <code>factory/labels/</code>. A judge's verdicts are trustworthy while its latest round has precision and recall of at least ${pct(r.threshold)} and is no more than ${r.maxAgeDays} days old. This is shown, not enforced.</div>
    ${notes.map(w => `<div class="note" style="color:var(--warn)">${esc(w)}</div>`).join('')}
    ${r.dimensions.length ? `<div class="tw2"><table class="t"><tr><th>Dimension</th><th>Judge</th><th class="num">Precision</th><th class="num">Recall</th><th class="num">Labelled</th><th>Latest round</th><th>Status</th><th></th></tr>${r.dimensions.map(d => `<tr><td><span class="id">${esc(d.dimension)}</span></td>${d.latest ? `<td>${esc(d.latest.judge_version)}</td><td class="num">${pct(d.latest.precision)}</td><td class="num">${pct(d.latest.recall)}</td><td class="num">${fmtN(d.latest.n)}</td><td>${esc(d.latest.date)} (${esc(plural(d.ageDays, 'day'))} ago)</td>` : '<td colspan="5" style="color:var(--fg3)">No valid round yet</td>'}<td><span class="tag ${CAL_TAG[d.status] || ''}">${esc(d.status)}</span>${d.short.length ? `<div style="color:var(--warn);font-size:11.5px">${esc(d.short.join(' and '))} under ${pct(r.threshold)}</div>` : ''}</td><td><button class="lnk" data-file="${esc((A.labels.find(x => String(x.dimension) === d.dimension) || {})._path || '')}">Open</button></td></tr>`).join('')}</table></div>` : ''}</div>`;
}
const TASK_TAG = { minted: 'minted', checked: 'checked', bound: 'bound', changed: 'warning', retired: 'superseded', invalid: 'fail' };
function factoryTasksHtml() {
  if (!A.ftasks || (!A.ftasks.length && !A.ftaskErrors.length)) return '';
  const runs = Ledger.suiteRuns(A.ledger, { k: (A.cfg.factory || {}).k || 3 });
  const r = Ledger.factoryTasks(A.ledger, { tasks: A.ftasks, taxonomy: A.taxonomy, runs });
  const notes = [...A.ftaskErrors, ...r.problems.map(p => `factory/tasks: ${p}`), ...r.tasks.flatMap(t => [...t.problems.map(p => `${t.id}: ${p}`), ...t.warnings])];
  return `<div class="block"><h3>Eval tasks<span class="spacer"></span><span class="note-i">${plural(r.tasks.filter(t => t.status === 'bound').length, 'bound task')}</span></h3>
    <div class="note">Regression tests for the Build pipeline, from <code>factory/tasks/</code>. A task is minted, checked by running its reference solution, then bound by you; binding pins the file's hash. Editing a bound task makes it changed until you bind it again, and suite runs that used another version are flagged.</div>
    ${notes.map(w => `<div class="note" style="color:var(--warn)">${esc(w)}</div>`).join('')}
    ${r.tasks.length ? `<div class="tw2"><table class="t"><tr><th>Task</th><th>Failure mode</th><th>Status</th><th class="num">Suite runs</th><th></th></tr>${r.tasks.map(t => `<tr><td><span class="id">${esc(t.id)}</span>${t.title ? ` ${esc(t.title)}` : ''}</td><td>${t.failureMode ? esc(t.failureMode) : '<span style="color:var(--fg3)">none</span>'}</td><td><span class="tag ${TASK_TAG[t.status] || ''}">${esc(t.status)}</span>${t.offDefinition.length ? `<div style="color:var(--warn);font-size:11.5px">${esc(plural(t.offDefinition.length, 'run'))} used a different definition</div>` : ''}</td><td class="num">${t.runs.length}</td><td>${t.bindable ? `<button class="btn" data-bindtask="${esc(t.id)}">${t.status === 'changed' ? 'Re-bind' : 'Bind'}</button>` : t.bindProblem && t.status !== 'bound' && t.status !== 'retired' && t.status !== 'invalid' ? `<span style="color:var(--fg3);font-size:11.5px" title="${esc(t.bindProblem)}">needs a failure mode</span>` : ''}<button class="lnk" data-file="${esc((A.ftasks.find(x => String(x.id) === t.id) || {})._path || '')}">Open</button></td></tr>`).join('')}</table></div>` : ''}</div>`;
}
// factory/taxonomy.yaml: the failure modes escapes are classified against. Not a gate input (the CLI never reads it),
// so a parse error is shown in Improve rather than blocking the gate.
const TAXONOMY = 'factory/taxonomy.yaml';
const TOKENS = 'design-tokens/tokens.json';
const TOKENS_STARTER = JSON.stringify({ font: { size: { body: { $value: '16px', $type: 'dimension' }, small: { $value: '12px', $type: 'dimension' } } }, color: { text: { $value: '#1a1a1a', $type: 'color' } } }, null, 2) + '\n';
async function loadTaxonomy() {
  A.taxonomy = null; A.taxonomyError = null;
  const t = await readText(TAXONOMY); if (t == null) return;
  try { A.taxonomy = jsyaml.load(t) || {}; } catch (e) { A.taxonomyError = `${e.reason || e.message} (line ${(e.mark && e.mark.line + 1) || 1})`; }
}
const TAXONOMY_STARTER = `# Failure modes of the Build pipeline, from reading its traces (error analysis). Each escape in a design
# registry can be classified as one of these in Improve. triage: spec (the handover should have said),
# fix (the factory must change) or grader (an eval must catch it).
modes:
  - id: FM-01
    name: Test gaming
    description: The agent changed or weakened a test to make it pass.
    triage: grader
  - id: FM-02
    name: Spec gap
    description: The handover did not say something the code needed.
    triage: spec
`;
async function loadLedger() {
  const files = await host.list('ledger', ['.jsonl']); A.ledgerFiles = files; A.ledgerRaw = []; A.ledgerErrors = [];
  for (const f of files) {
    const { events, errors } = Ledger.parse(f.text, f.path);
    A.ledgerRaw.push(...events); A.ledgerErrors.push(...errors);
  }
  A.ledgerRaw = Ledger.order(A.ledgerRaw);
  deriveLedger();
}
// Escapes recorded in the sibling registries named in designc.json `registries` (read-only: main has no write
// handler for them). Each registry's ledger is parsed and derived the same way as this one's.
async function loadRegistries() {
  A.regs = { ...A.regs, loading: true }; const rows = [], problems = [];
  let keys = []; try { keys = await host.registries(); } catch (e) { problems.push({ key: '', msg: e.message }); }
  for (const r of keys) {
    if (!r.exists) { problems.push({ key: r.key, msg: `${r.path} does not exist. Check the path in designc.json registries.` }); continue; }
    try {
      let evs = [], bad = 0;
      for (const f of await host.registryList(r.key, 'ledger', ['.jsonl'])) { const { events, errors } = Ledger.parse(f.text, f.path); evs.push(...events); bad += errors.length; }
      if (bad) problems.push({ key: r.key, msg: `${plural(bad, 'ledger line')} could not be read and ${bad === 1 ? 'was' : 'were'} skipped.` });
      for (const e of Ledger.derive(Ledger.order(evs))) if (e.kind === 'escape') rows.push({ ...e, registry: r.key });
    } catch (e) { problems.push({ key: r.key, msg: e.message }); }
  }
  rows.sort((a, b) => (b._ts || 0) - (a._ts || 0));
  A.regs = { loaded: true, loading: false, keys, rows, problems };
  if (A.active === 'special:improve') renderAll();
}
function otherRegistriesHtml() {
  const R = A.regs, keys = R.keys || [];
  if (!keys.length && !R.problems.length) return '';
  const stage = k => (STAGES.find(([s]) => s === k) || [k, k ? k : 'Not classified'])[1];
  const fm = Ledger.failureModes(A.ledger, { taxonomy: A.taxonomy }), modes = fm.modes;
  const fmCell = e => { const cur = fm.byEscape.get(`${e.registry}/${e.id}`) || '';
    return `<td><select class="inline" data-fm-reg="${esc(e.registry)}" data-fm-esc="${esc(e.id)}" aria-label="Failure mode of ${esc(e.id)}"><option value="">Not classified</option>${modes.map(m => `<option value="${esc(m.id)}" ${cur === m.id ? 'selected' : ''}>${esc(m.id)} ${esc(m.name)}</option>`).join('')}${cur && !modes.some(m => m.id === cur) ? `<option value="${esc(cur)}" selected>${esc(cur)} (not in the taxonomy)</option>` : ''}</select></td>`; };
  const probs = R.problems.map(p => `<div class="note" style="color:var(--err)">${p.key ? `<b>${esc(p.key)}</b>: ` : ''}${esc(p.msg)}</div>`).join('');
  return `<div class="block"><h3>Escapes in other registries<span class="spacer"></span><button class="btn" data-regs-refresh ${R.loading ? 'disabled' : ''}>${R.loading ? 'Reading…' : 'Refresh'}</button></h3>
    <div class="note">Read-only, from the registries listed in <code>designc.json</code> <code>registries</code> (${keys.map(k => esc(k.key)).join(', ')}). The stage is classified in their own registry; the failure mode is recorded here.</div>${probs}
    ${R.rows.length ? `<div class="tw2"><table class="t"><tr><th>Registry</th><th>When</th><th>Where</th><th>What happened</th><th>Should have been caught by</th>${modes.length ? '<th>Failure mode</th>' : ''}</tr>${R.rows.map(e => `<tr><td>${esc(e.registry)}</td><td>${esc(when(e.ts))}</td><td>${esc(e.element || '')}</td><td>${esc(e.description || '')}${e.code ? ` <span class="code">${esc(e.code)}</span>` : ''}</td><td>${esc(stage(e.caught_by))}</td>${modes.length ? fmCell(e) : ''}</tr>`).join('')}</table></div>` : `<div class="note">${R.loaded ? 'No escapes recorded there.' : 'Not read yet.'}</div>`}</div>`;
}
// Escapes per failure mode (Ledger.failureModes). Shown once there is a taxonomy, a classification or another registry.
const TRIAGE_LABEL = { spec: 'Spec: the handover should have said', fix: 'Fix: the factory must change', grader: 'Grader: an eval must catch it' };
function failureModesHtml() {
  const has = A.taxonomy || A.taxonomyError || A.ledger.some(e => e.kind === 'failure_mode_classified') || (A.regs.keys || []).length;
  if (!has) return '';
  const fm = Ledger.failureModes(A.ledger, { taxonomy: A.taxonomy, escapes: A.regs.rows.map(e => ({ registry: e.registry, id: e.id })) });
  const exists = A.taxonomy != null || A.taxonomyError;
  const warn = [...(A.taxonomyError ? [`${TAXONOMY} does not parse: ${A.taxonomyError}`] : []), ...fm.problems.map(p => `${TAXONOMY}: ${p}`),
    ...fm.unknown.map(u => `${u.registry} ${u.escape} is classified as ${u.failure_mode}, which ${TAXONOMY} does not list. Add it there or reclassify the escape.`)];
  const max = Math.max(1, ...fm.modes.map(m => m.count));
  return `<div class="block"><h3>Failure modes<span class="spacer"></span>${exists ? `<button class="btn" data-file="${TAXONOMY}">Open taxonomy</button>` : '<button class="btn" data-a="newtaxonomy">Create factory/taxonomy.yaml</button>'}</h3>
    <div class="note">Escapes from other registries, grouped by failure mode from <code>${TAXONOMY}</code>. Classify each one in the table below. Triage says where the fix belongs. ${fm.unclassified.length ? `${plural(fm.unclassified.length, 'escape')} not classified yet.` : ''}</div>
    ${warn.map(w => `<div class="note" style="color:var(--warn)">${esc(w)}</div>`).join('')}
    ${fm.modes.length ? `<div class="tw2"><table class="t"><tr><th>Mode</th><th>Name</th><th>Triage</th><th class="num">Escapes</th><th style="width:30%"></th></tr>${fm.modes.map(m => `<tr title="${esc(m.description)}"><td><span class="id">${esc(m.id)}</span></td><td>${esc(m.name)}${m.description ? `<div style="color:var(--fg3);font-size:11.5px">${esc(m.description)}</div>` : ''}</td><td>${m.triage ? esc(TRIAGE_LABEL[m.triage]) : '<span style="color:var(--fg3)">Not triaged</span>'}</td><td class="num">${m.count}</td><td><div class="bartrack"><div class="barfill" style="width:${(m.count / max) * 100}%"></div></div></td></tr>`).join('')}</table></div>` : `<div class="note">${exists ? 'The taxonomy lists no failure modes yet.' : 'No taxonomy yet. Create one from what you see in the traces, then classify escapes against it.'}</div>`}</div>`;
}
// The ledger is append-only: classification and resolution are later events, folded in here.
function deriveLedger() { A.ledger = Ledger.derive(A.ledgerRaw); if (typeof refreshDigest === 'function') refreshDigest(); }
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
  if (A.cmLevel === 'code' && !cmHasCode()) { A.cmLevel = 'container'; A.cmScope = null; }
}
// Code quality (QC rules): warnings only, judged from designc.json `quality`. Never reaches the gate.
let QMEMO = null;
function qualityNow() {
  const code = A.facts && A.facts.code, key = A.cfg.quality;
  if (QMEMO && QMEMO.code === code && QMEMO.key === key) return QMEMO.out;
  QMEMO = { code, key, out: Quality.judge(code, key) };
  return QMEMO.out;
}
// badge for one Code map box: the number of breaches under it, red-amber, nothing when clean
function cmQualityBadge(e) {
  const r = qualityNow().rollup, hit = (A.cmLevel === 'code' ? r.type.get(e.id) : e.kind === 'component' ? r.component.get(e.id) : e.kind === 'container' ? r.container.get(e.name) : null);
  return hit && hit.breaches ? { badge: hit.breaches, badgeColor: 'var(--warn)' } : {};
}
function recompile() {
  A.model = Core.parse(A.modelText);
  A.diags = A.model.elements.size || A.model.errors.length ? Core.check(A.model, { chainHops: A.cfg.chainHops || 4, retryAmplification: A.cfg.retryAmplification || 4 }) : [];
  A.gate = Core.gate({ model: A.model, diags: A.diags, decisions: A.decisions, requirements: A.requirements, ledger: A.ledger, registryErrors: A.yamlErrors.map(e => ({ path: e.path, message: e.msg })), evidenceHosts: A.cfg.evidenceHosts || [], businessOwners: A.cfg.businessOwners || [], scenarios: A.scenarios, evals: A.evals, acceptance: A.acceptance, tokens: A.tokens, minTextSize: (A.cfg.ux && A.cfg.ux.minTextSize) || Core.DEFAULT_MIN_TEXT });
  A.drift = A.asbuilt && A.model.elements.size ? Core.driftModels(Core.atLevel(A.model, 'container'), A.asbuilt) : null;
  A.cdrift = A.asbuiltFull && A.model.elements.size ? Core.driftComponents(A.model, A.asbuiltFull) : null;
  A.areas = A.facts ? Core.codeAreaDrift(A.model, A.facts.files) : null;
  setMarkers();
}
async function reloadAll() {
  await loadSettings(); await loadModel(); await loadRegistry(); await loadLedger(); await loadAsbuilt(); recompile(); renderAll(); loadTelemetry(); loadRegistries();
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
function designNameFor(name) {
  if (!name || !A.model) return null;
  const e = Core.resolveElement(A.model, name);
  return e ? e.name : null;
}
// what a pipeline's element reference (an elements.json id, or a name) is called in the design; the raw text when it matches nothing
const elementLabel = ref => designNameFor(ref) || ref || '';
// runs → per task (attempts, final outcome) and per design element
function telAgg() {
  const runs = Ledger.pipelineRuns(A.tel.runs);
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
  const total = Ledger.runTotals(runs);
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
    const f = A.diags.find(d => d.code === code && d.loc.line === line && !d.suppressed); if (f) decisionForFinding(f);
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
  $('#special').style.display = !id || isFile ? 'none' : id === 'special:canvas' ? 'grid' : 'block'; // the canvas lays out as a grid (.dcv)
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
  if (b) { b.model.dispose(); A.buffers.delete(id); if (id === A.cfg.model) { await loadModel(); recompile(); } else if (isRegPath(id)) { await loadRegistry(); recompile(); } }
  if (id === 'special:canvas' && A.canvasApi) { A.canvasApi.destroy(); A.canvasApi = null; }
  activate(A.active === id ? A.tabs[A.tabs.length - 1] || null : A.active);
  renderAll();
}
async function save(id = A.active) {
  if (id === 'special:canvas') id = A.cfg.model;   // the canvas edits the model buffer
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
  else if (isRegPath(path)) registrySoon();
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
  if (REG_DIRS.some(any) || any('factory') || any('work')) await loadRegistry();
  if (any('ledger')) await loadLedger();
  if (any('asbuilt')) await loadAsbuilt();
  recompile(); renderAll({ keepEditor: true });
}

// ---------------------------------------------------------------- registry actions
async function createAndOpen(path, text, selectLine) { await host.write(path, text); A.tree = await host.tree(); await openFile(path, selectLine); await loadRegistry(); recompile(); renderAll({ keepEditor: true }); }
const yamlList = a => `[${(a || []).map(x => /[:,\[\]{}#&*!|>'"%@`]/.test(x) ? JSON.stringify(x) : x).join(', ')}]`;
const yamlStr = s => JSON.stringify(String(s || ''));
async function recordDecision({ finding, statement = '', effect = 'fix', binds, resolves, checks = [], rationale = '', kind = 'technical', relies_on = [], open = true, idFrom } = {}) {
  if (!A.root) return;
  const id = Core.slugId(idFrom || statement || (finding ? `${finding.code} ${(finding.loc.names || [])[0] || ''}` : 'decision'), A.decisions.map(d => d.id));
  if (finding) { binds = binds || finding.loc.names.slice(0, finding.loc.kind === 'element' ? 1 : 2); resolves = resolves || [finding.code]; }
  const business = kind === 'business';
  if (business && statement) statement = `PROPOSED: ${statement}`;
  const text = `id: ${id}
status: minted          # minted | checked | bound | superseded
kind: ${business ? 'business' : 'technical'}          # business | technical
effect: ${effect}             # fix (the model changes) | accept (keep the risk)
${relies_on.length ? `relies_on: ${yamlList(relies_on)}\n` : ''}${business ? 'evidence: ""             # https URL on a host in designc.json evidenceHosts; not needed when one of businessOwners binds it\n' : ''}requirement: null
binds: ${yamlList(binds || [])}
resolves: ${yamlList(resolves || [])}
statement: ${statement ? yamlStr(statement) : 'TODO what was decided'}
${!checks.length && (business || effect === 'accept') ? `checks: []          # optional: ${business ? 'a business decision needs evidence, not a check' : 'an accepted risk rests on its business decision'}` : `checks:
${(checks.length ? checks : ['TODO command that proves it, e.g. p check -tc tcOptimistic']).map(c => `  - ${yamlStr(c)}`).join('\n')}`}
rationale: ${rationale ? yamlStr(rationale) : '""'}
assumptions: []          # [{"text": "what must stay true", "review_by": "YYYY-MM-DD"}]; past the date the gate blocks until you review it
`;
  const path = `decisions/${id}.yaml`;
  if (open) await createAndOpen(path, text, statement ? null : 8);
  else { await host.write(path, text); A.tree = await host.tree(); await loadRegistry(); }
  return { id, path };
}
// A pipeline names elements by elements.json id; a decision binds by name. Asks first, like newDecision.
async function answerNeedsDecision(n) {
  if (!n) return;
  const statement = await askText(`What was decided for ${n.id}? (leave blank to fill in later)`); if (statement == null) return;
  const check = await askCheck(); if (check == null) return;
  const el = n.element && A.model ? Core.resolveElement(A.model, String(n.element)) : null;
  const r = await recordDecision({ statement: statement.trim(), binds: el ? [el.name] : n.element ? [String(n.element)] : [], resolves: [], checks: check ? [check] : [],
    rationale: `Pipeline asked (${n.id}): ${n.question}` });
  if (r && r.id) await recordEvent('needs_decision_resolved', { id: n.id, decision: r.id });
  return r;
}
// The options a pipeline offered with a needs-decision, each with a Choose button (the recommended one tagged).
function ndOptionsHtml(id) {
  const nd = A.ledger.find(x => x.kind === 'needs_decision' && x.id === id);
  const { options, recommended } = Ledger.ndOptions(nd);
  return options.map(o => `<div class="l2"><button class="lnk" data-ndopt="${esc(id)}" data-opt="${esc(o.id)}">Choose ${esc(o.id)}</button> ${esc(o.summary)}${o.id === recommended ? ' <span class="tag pass">recommended</span>' : ''}${o.consequence ? ` <span class="desc">${esc(o.consequence)}</span>` : ''}</div>`).join('');
}
// How a resolved needs-decision was answered, for the rows that show it.
function ndAnswerText(r) {
  if (!r) return '';
  return [r.option ? `chose ${r.option}` : '', r.decision ? `answered by ${r.decision}` : '', r.note ? `"${r.note}"` : '', r.by ? `by ${r.by}` : ''].filter(Boolean).join(', ') || 'resolved';
}
// A person picks one of the options the pipeline offered; the note travels with it to the agent that asked.
async function chooseNdOption(id, opt) {
  const nd = A.ledger.find(x => x.kind === 'needs_decision' && x.id === id);
  const o = Ledger.ndOptions(nd).options.find(x => x.id === opt); if (!o) return;
  const note = await askText(`${id}: choose ${o.id}, ${o.summary}${o.consequence ? ` (${o.consequence})` : ''}. Anything the agent should know? (optional)`); if (note == null) return;
  await recordEvent('needs_decision_resolved', { id, payload: { option: o.id, ...(note.trim() ? { note: note.trim() } : {}) } });
  toast(`${id}: chose ${o.id}. Resume the run to continue.`);
}
async function resolveNd(id) {
  const note = await askText(`${id}: what should the agent know? It reads this when the run resumes. (optional)`); if (note == null) return;
  await recordEvent('needs_decision_resolved', { id, ...(note.trim() ? { payload: { note: note.trim() } } : {}) });
}
// A bound fix decision needs a passing check, so ask for the command now; blank leaves a TODO, Cancel is null.
async function askCheck() {
  let why = '', value = '';
  for (;;) {
    const c = await askText(`${why}What command proves it? It runs in ${A.root.name} and exits 0 when the decision holds. (leave blank to fill in later)`, value);
    if (c == null || !c.trim()) return c == null ? null : '';
    const problem = Policy.checkProblem(c);
    if (!problem) return c.trim();
    why = `${problem} `; value = c;
  }
}
// The + on Decisions and Record decision on a problem ask first, so a stray click creates nothing.
async function newDecision() {
  const statement = await askText('What was decided? (leave blank to fill in later)'); if (statement == null) return;
  return recordDecision({ statement: statement.trim() });
}
async function decisionForFinding(f) {
  if (!f) return;
  const statement = await askText(`${f.code} on ${f.loc.label}: ${f.msg.replace(/\.?$/, '.')} What was decided? (leave blank to fill in later)`); if (statement == null) return;
  return recordDecision({ finding: f, statement: statement.trim() });
}
// What the decision answering a finding is waiting for, in Problems.
function decisionNote(d) {
  if (d.effect === 'accept') return d.status === 'bound' ? `Accepted by ${d.id}` : `Accept decision ${d.id} is ${d.status || 'minted'}: bind it`;
  return `Fix decision ${d.id} (${d.status || 'minted'}): goes when the model changes`;
}
// Writes a technical accept decision that relies on a business decision, drafting that one if asked. Nothing is
// bound here: the business decision still needs evidence, and a person binds both.
async function acceptRisk(f) {
  if (!f) return;
  const why = await askText(`${f.code} on ${f.loc.label}: ${f.msg.replace(/\.?$/, '.')}\n\nWhy is it acceptable to keep this risk?`); if (why == null) return;
  if (!why.trim()) { toast('Nothing was recorded: say why the risk is acceptable, that becomes the decision.', 'warning'); return; }
  const biz = A.decisions.filter(d => d.kind === 'business' && d.status !== 'superseded');
  const pick = await askChoice('Which business decision does this rely on? An accepted risk needs one, bound by a person with evidence.',
    [...biz.map(d => ({ value: d.id, label: `${d.id} (${d.status}): ${trunc(d.statement || 'no statement', 60)}` })), { value: '', label: 'Draft a new business decision', primary: !biz.length }]);
  if (pick == null) return;
  const rationale = `Accepts ${f.code} on ${f.loc.label}: ${f.msg}`;
  const b = pick ? null : await recordDecision({ kind: 'business', effect: 'accept', statement: why.trim(), binds: [], resolves: [], rationale, open: false });
  const t = await recordDecision({ finding: f, effect: 'accept', statement: why.trim(), relies_on: [pick || b.id], rationale, idFrom: `accept ${f.code} ${(f.loc.names || [])[0] || ''}`, open: !b });
  if (b) { await openFile(b.path); renderAll({ keepEditor: true }); toast(`Drafted ${b.id} and ${t.id}. Add evidence to ${b.id}, then bind both.`); }
}
// A proposal made by mistake can go while nobody has acted on it; a bound, rejected or superseded one stays as the record.
const propDeletable = p => !!p._path && ['minted', 'checked', undefined].includes(p.status);
// Human only, from the Explorer, the Decisions list and the Proposals lists. The ledger and handovers are refused by the main process as well.
async function deleteFile(path) {
  if (/^(ledger|handovers)\//.test(path)) { toast(`${path} cannot be deleted: the ledger is append-only and handovers are frozen.`, 'warning'); return; }
  const b = A.buffers.get(path);
  if (!confirm(`Delete ${path}?${b && b.dirty ? ' It has unsaved changes.' : ''} Git history keeps it if it was committed.`)) return;
  if (typeof AG !== 'undefined') AG.approved.set(path, Date.now() + 2000);
  try { await host.remove(path); } catch (err) { toast(`${path} was not deleted: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error'); return; }
  if (b) { b.model.dispose(); A.buffers.delete(path); }
  A.tabs = A.tabs.filter(t => t !== path); if (A.active === path) activate(A.tabs[A.tabs.length - 1] || null);
  A.tree = await host.tree();
  if (path === A.cfg.model) await loadModel(); else await loadRegistry();
  recompile(); renderAll({ keepEditor: A.active !== null }); toast(`Deleted ${path}.`);
}
async function newRequirement() {
  const id = (await askText('Jira key for the requirement', 'HRE-')) || ''; if (!id.trim() || id.trim() === 'HRE-') return;
  await createAndOpen(`requirements/${id.trim()}.yaml`, `id: ${id.trim()}\ntitle: TODO\nsource: ""\nversion: 1\nelements: []\n`, 2);
}
// Requirement import (slice 36): a folder of exported pages becomes requirements/*.yaml stubs. Only id, title,
// source and version are written; page text never reaches the registry. A changed page needs the person's yes.
function importReview(plan, skipped) {
  return new Promise(resolve => {
    const el = document.createElement('div'); el.className = 'askbox';
    const row = i => `<div class="item"><div class="l1"><span class="id">${esc(i.id || i.file)}</span><span class="tag ${i.status === 'invalid' ? 'open' : ''}">${esc(i.status)}</span></div>`
      + `<div class="l2">${esc(i.status === 'invalid' ? i.problems.join(' ') : `${i.title}${i.status === 'changed' ? ` (version ${i.from} to ${i.version}: bound business decisions will need re-binding)` : ''}`)}</div></div>`;
    const s = plan.summary;
    const sk = skipped.length ? `<div class="hint">Skipped: ${esc(skipped.map(k => `${k.name} (${k.reason})`).join(', '))}</div>` : '';
    el.innerHTML = `<div class="askcard" style="width:620px"><label>${esc(`${s.new} new, ${s.changed} changed, ${s.unchanged} unchanged, ${s.invalid} not importable.`)}</label>`
      + `<div style="max-height:46vh;overflow:auto">${plan.items.filter(i => i.status !== 'unchanged').map(row).join('') || '<div class="hint">Nothing to import.</div>'}</div>${sk}`
      + `<div class="ta"><button type="button" class="btn" data-ask="no">Cancel</button>`
      + (s.changed ? `<button type="button" class="btn" data-go="new" ${s.new ? '' : 'disabled'}>Import ${s.new} new only</button>` : '')
      + `<button type="button" class="btn primary" data-go="all" ${s.new + s.changed ? '' : 'disabled'}>${s.changed ? `Import ${s.new} new and update ${s.changed}` : `Import ${s.new} new`}</button></div></div>`;
    const done = v => { el.remove(); resolve(v); };
    el.addEventListener('click', e => { const b = e.target.closest('[data-go],[data-ask]'); if (!b || b.disabled) return; e.stopPropagation(); done(b.dataset.go || null); });
    el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
    document.body.appendChild(el); el.querySelector('.primary').focus();
  });
}
async function importRequirements() {
  const dir = await host.chooseImportFolder(); if (!dir) return;
  A.importDir = dir;
  const r = await host.readImportFolder(dir);
  if (r.error) return toast(r.error, 'warning');
  if (!r.pages.length) return toast('That folder has no .html or .md files. Export the pages as HTML, or convert them first (docs/requirement-import.md).', 'warning');
  const existing = A.requirements.map(q => ({ id: q.id, version: q.version, source: q.source }));
  const plan = RequirementImport.plan(r.pages, { existing });
  const choice = await importReview(plan, r.skipped || []); if (!choice) return;
  let n = 0;
  for (const i of plan.items) {
    if (i.status === 'new' || (i.status === 'changed' && choice === 'all')) {
      const prev = A.requirements.find(q => String(q.id).toLowerCase() === i.id.toLowerCase());
      await host.write(prev && prev._path ? prev._path : `requirements/${i.id}.yaml`, RequirementImport.toYaml(i, { elements: prev && Array.isArray(prev.elements) ? prev.elements : [] }));
      n++;
    }
  }
  A.tree = await host.tree(); await loadRegistry(); recompile(); renderAll({ keepEditor: true });
  toast(`${plural(n, 'requirement')} written. Each is untraced until you map it to elements.`);
}
async function newScenario() {
  const id = (await askText('Scenario id', 'QAS-')) || ''; if (!id.trim() || id.trim() === 'QAS-') return;
  const text = `id: ${id.trim()}\ntitle: TODO\nattribute: availability   # availability, latency, ...\nartifact: TODO          # an element name in the model\nstimulus: TODO\nresponse: TODO\nmeasure: { metric: availability, op: ">=", value: 99.9, unit: "%" }\nimportance: medium       # high, medium or low: how much the business cares\ndifficulty: medium       # high, medium or low: how hard it is to achieve\nrequirement: ""\nfitness: []             # shell commands; a pass or fail is recorded in the ledger\n`;
  await createAndOpen(`scenarios/${id.trim()}.yaml`, text, 3);
}
async function newAcceptance() {
  const ui = [...A.model.elements.values()].filter(e => e.tags.has('UI'));
  const pick = ui.length ? await askChoice('Which UI element does this criterion cover?', ui.map(e => ({ label: A.model.label(e.id), value: e.id }))) : null;
  if (ui.length && !pick) return;
  const el = pick ? A.model.elements.get(pick) : null;
  const elPath = e => { const parts = []; for (let c = e; c; c = c.parent ? A.model.elements.get(c.parent) : null) parts.unshift(c.name); return parts.join('/'); };
  const req = A.requirements.find(r => el && (r.elements || []).includes(el.name));
  const id = (await askText('Acceptance criterion id', 'AC-')) || ''; if (!id.trim() || id.trim() === 'AC-') return;
  const cases = ['ready', 'loading', 'empty', 'error'].map(st => `  - state: ${st}\n    given: TODO\n    then: TODO\n`).join('');
  const text = `id: ${id.trim()}\nrequirement: ${req ? req.id : 'TODO'}\nelement: ${el ? yamlStr(elPath(el)) : 'TODO'}   # elements.json id, e.g. System/Container/Component\nstates: [ready, loading, empty, error]   # add forbidden behind a sign-in\nlocators:\n  heading: { role: heading, name: TODO }\n# ux:                       # optional: keyboard, focus and breakpoint checks in the generated spec\n#   keyboard: true\n#   focus_order: [heading]   # locator names in tab order\n#   breakpoints: [375, 768]\ncases:\n${cases}`;
  await createAndOpen(`acceptance/${id.trim()}.yaml`, text, 3);
}
async function runFitness() {
  if (A.running) { toast('Checks are already running.'); return; }
  const targets = A.scenarios.filter(s => (s.fitness || []).some(c => c && !/^TODO/.test(c)));
  if (!targets.length) {
    const todo = A.scenarios.filter(s => (s.fitness || []).length).length;
    toast(todo ? `${plural(todo, 'scenario')} ${todo === 1 ? 'has' : 'have'} only TODO fitness functions. Replace a TODO with the shell command that measures it, then run again.`
      : 'No scenario has a fitness function yet. Add a shell command under fitness in a scenario.', 'warning');
    return;
  }
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
  const id = (await askText('Eval id', 'EV-')) || ''; if (!id.trim() || id.trim() === 'EV-') return;
  const agent = await askText('Name of the agent element this eval judges (leave blank to fill in later)'); if (agent == null) return;
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
statement: ${p.statement ? yamlStr(p.statement) : 'TODO the change to Design or Build'}
check: ${yamlStr(p.check || '')}
${p.drafted ? 'drafted_by: llm\n' : ''}`, p.statement ? null : 5);
}
async function editYaml(path, fn) {
  const b = A.buffers.get(path);
  const text = b ? b.model.getValue() : await host.read(path);
  const next = fn(text);
  if (next == null) return null;
  if (b) { b.model.pushEditOperations([], [{ range: b.model.getFullModelRange(), text: next }], () => null); await save(path); }
  else await host.write(path, next);
  await loadRegistry(); recompile(); renderAll({ keepEditor: true });
  return true;
}
function setField(text, key, value) {
  const re = new RegExp(`^${key}:.*$`, 'm');
  return re.test(text) ? text.replace(re, `${key}: ${value}`) : text.replace(/\s*$/, `\n${key}: ${value}\n`);
}
// Assumptions whose review date is before today, as {i, text, review_by}. A YAML date reads as a Date, so both spellings count.
function overdueAssumptions(d, today = new Date().toISOString().slice(0, 10)) {
  if (!Array.isArray(d.assumptions)) return [];
  return d.assumptions.map((a, i) => ({ i, text: a && a.text, review_by: a && (a.review_by instanceof Date ? a.review_by.toISOString().slice(0, 10) : a.review_by) }))
    .filter(a => typeof a.review_by === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.review_by) && a.review_by < today);
}
// Human-only, like bindDecision: records that you looked at the overdue assumptions and sets the next review date.
async function reviewAssumptions(d) {
  const due = overdueAssumptions(d); if (!due.length) return;
  const today = new Date().toISOString().slice(0, 10);
  const next = await askText(`${d.id}: ${plural(due.length, 'assumption')} overdue:\n${due.map(a => `- ${a.text} (due ${a.review_by})`).join('\n')}\n\nStill true? Enter the next review date (YYYY-MM-DD). This records that you, ${A.user}, reviewed them.`, new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10));
  if (next == null) return;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(next.trim()) && !isNaN(new Date(next.trim() + 'T00:00:00Z')) && next.trim() > today;
  if (!ok) { toast('Enter a date after today as YYYY-MM-DD. Nothing was changed.', 'warning'); return; }
  const dueAt = new Set(due.map(a => a.i));
  const list = d.assumptions.map((a, i) => dueAt.has(i) ? { ...a, review_by: next.trim(), reviewed_by: A.user, reviewed_at: today } : { ...a, review_by: a.review_by instanceof Date ? a.review_by.toISOString().slice(0, 10) : a.review_by });
  await editYaml(d._path, t => t.replace(/^assumptions:.*(?:\n(?:[ \t]+.*|-.*))*/m, '').replace(/\s*$/, `\nassumptions: ${JSON.stringify(list)}\n`));
  toast(`Reviewed ${plural(due.length, 'assumption')} on ${d.id}.`);
}
// A business decision binds against a requirement: pick one, or create it, and write it into the decision. Null on Cancel.
async function chooseRequirement(d) {
  const title = String(d.statement || '').replace(/^PROPOSED:\s*/, '').trim() || 'TODO';
  const pick = await askChoice(`${d.id} is a business decision and needs the requirement it answers.`,
    [...A.requirements.map(r => ({ label: `${r.id}: ${trunc(String(r.title || ''), 50)}`, value: r.id })), { label: 'New requirement', value: '', primary: !A.requirements.length }]);
  if (pick == null) return null;
  let id = pick;
  if (!id) {
    id = ((await askText('Jira key for the requirement', 'HRE-')) || '').trim(); if (!id || id === 'HRE-') return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) { toast(`${id} is not a usable id. Use letters, digits, dots, dashes or underscores.`, 'warning'); return null; }
    if (A.requirements.some(r => r.id === id) || await host.exists(`requirements/${id}.yaml`)) { toast(`requirements/${id}.yaml already exists. Choose it from the list instead.`, 'warning'); return null; }
    await host.write(`requirements/${id}.yaml`, `id: ${id}\ntitle: ${yamlStr(title)}\nsource: ""\nversion: 1\nelements: []\n`);
  }
  await editYaml(d._path, t => setField(t, 'requirement', id));
  return A.requirements.find(r => r.id === id) || null;
}
async function bindDecision(d, { confirmed = false } = {}) {
  if (!confirmed && !confirm(`${d.status === 'bound' ? 'Re-bind' : 'Bind'} ${d.id}? Binding means you, ${A.user}, accept it as part of the design.`)) return;
  let against;
  if (d.kind === 'business') {
    let req = A.requirements.find(r => r.id === d.requirement);
    if (!req) req = await chooseRequirement(d);
    if (!req) return;
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
// What freezing the model on disk would cost, against the newest handover's model and the recorded spend history.
// Settings: designc.json `currency` (default GBP) and `forecast: { minSamples, window }`.
async function computeForecast(modelText) {
  const base = Core.latestHandoverModel(A.handovers), fc = A.cfg.forecast || {};
  const prev = base ? Core.parse((await host.read(base.path)) || '') : null;
  const forecast = Core.forecast({ before: prev, after: Core.parse(modelText),
    history: Ledger.elementHistory(A.ledgerRaw, { window: fc.window || 10 }), minSamples: fc.minSamples || 3 });
  return { forecast, frozen: Core.freezeForecast(forecast, { currency: A.cfg.currency || 'GBP', baseline: base ? base.id : null }) };
}
// `item` is a work item: freeze only what it touches, against the gate scoped to its elements (ROADMAP slice 24).
async function freezeHandover(item) {
  if (A.freezing) return; // a second click while the first freeze is still writing
  A.freezing = true;
  try { await freezeOnce(item); } finally { A.freezing = false; }
}
async function freezeOnce(item) {
  const scoped = item ? Core.scopedGate(A.gate, { model: A.model, elements: item.elements || [], requirement: item.requirement, decisions: A.decisions }) : null;
  if (item && scoped && !scoped.ready) { toast(`${item.id} is not ready: ${plural(scoped.clauses.length, 'blocking item')} touch its elements. See the gate in Design.`, 'warning', [{ label: 'Show gate', run: () => setActivity('design') }]); return; }
  if (!item && (!A.gate || !A.gate.ready)) { toast(`Not ready: ${plural(A.gate ? A.gate.clauses.length : 0, 'blocking item')}. See the gate in Design.`, 'warning', [{ label: 'Show gate', run: () => setActivity('design') }]); return; }
  if (dirtyBuffers()) { toast('Save your open files before freezing: a handover copies what is on disk.', 'warning'); return; }
  let st = await host.gitStatus();
  if (st.repo && !st.trusted) {
    if (!await host.gitTrust()) { toast('Freezing needs git to check that what you freeze is committed. Trust this folder, or freeze from a registry outside git.', 'warning'); return; }
    st = await host.gitStatus();
  }
  if (st.repo && st.error) { toast(`Cannot read git status: ${st.error}`, 'error'); return; }
  const dirty = st.repo ? Core.dirtyInputs(st.files || [], A.cfg) : [];
  if (dirty.length) { toast(`Commit before freezing: ${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ` and ${dirty.length - 3} more` : ''} ${dirty.length === 1 ? 'has' : 'have'} uncommitted changes. A handover must name a commit.`, 'warning', [{ label: 'Open source control', run: () => setActivity('scm') }]); return; }
  const inScope = new Set(item ? item.elements || [] : []);
  const touches = names => !item || (names || []).some(n => inScope.has(n));
  const boundIds = new Set(A.decisions.filter(d => d.status === 'bound' && touches(d.binds)).map(d => d.id));
  const read = async (dir, exts) => (await host.list(dir, exts)).map(f => ({ path: f.path, text: f.text }));
  const acKeep = a => { if (!item) return true; const el = Core.resolveElement(A.model, a.element); return a.requirement === item.requirement && !!el && touches([el.name]); };
  const only = (files, loaded, keep) => { const ok = new Set(loaded.filter(keep).map(x => x._path)); return files.filter(f => ok.has(f.path)); };
  const decisions = [];
  for (const d of A.decisions.filter(d => boundIds.has(d.id))) decisions.push({ path: d._path, text: (await host.read(d._path)) || '' });
  const modelText = (await host.read(A.cfg.model)) || '';
  const { frozen } = item ? { frozen: null } : await computeForecast(modelText);
  const reqs = await read('requirements', ['.yaml', '.yml']), evs = await read('evals', ['.yaml', '.yml']), scs = await read('scenarios', ['.yaml', '.yml']), acs = await read('acceptance', ['.yaml', '.yml']);
  let plan;
  try {
    plan = Core.handoverPlan({
      date: new Date().toISOString().slice(0, 10), now: new Date().toISOString(), by: A.user, forecast: frozen,
      item: item ? { id: item.id, requirement: item.requirement, elements: item.elements || [] } : null,
      model: { path: A.cfg.model, text: modelText },
      requirements: item ? only(reqs, A.requirements, r => r.id === item.requirement) : reqs,
      decisions,
      behaviour: await read('behaviour', ['.p']),
      vocabulary: await read('vocabulary', ['.yaml', '.yml']),
      evals: item ? only(evs, A.evals, e => touches([e.agent])) : evs,
      scenarios: item ? only(scs, A.scenarios, s => touches([s.artifact])) : scs,
      specs: Core.acceptanceSpecs({ model: A.model, criteria: A.acceptance.filter(acKeep), inScope: item ? item.elements || [] : null }),
      acceptance: item ? only(acs, A.acceptance, acKeep) : acs,
      tokens: A.tokens != null ? { path: TOKENS, text: A.tokens } : null,
      focus: item ? [] : [...new Set([...A.requirements.flatMap(r => r.elements || []), ...A.decisions.filter(d => boundIds.has(d.id)).flatMap(d => d.binds || [])].map(String))],
    });
  } catch (e) { toast(String(e.message || e), 'error'); return; }
  const already = Core.frozenAs(plan.id, A.handovers);
  if (already) { toast(`This design is already frozen as ${already}: nothing a handover copies has changed since. A frozen handover is never rewritten.`, 'info', [{ label: 'Open handover', run: () => openFile(`handovers/${already}/handover.yaml`) }]); return; }
  const priced = Core.forecastSummary({ id: 'this handover', created: '', forecast: frozen, actual: null }).split('\n').filter(l => /^(Forecast|Covers)/.test(l)).join('\n');
  const ask = item
    ? `Freeze work item ${item.id}?\n\nIn scope: ${(item.elements || []).join(', ')}.\nThe handover holds the whole model with these elements marked, and only the requirement, decisions, scenarios and evals they touch. ${scoped.outside} blocking clause${scoped.outside === 1 ? '' : 's'} outside them ${scoped.outside === 1 ? 'is' : 'are'} not counted.`
    : `Freeze a handover of ${A.cfg.model}?\n\n${priced}\n\nThe forecast is written into the handover and compared with the actual spend in Build.`;
  if (!confirm(ask)) return;
  for (const f of plan.files) await host.write(f.path, f.text);
  const rev = plan.files[0].text.match(/^revision: r-(\w+)/m)[1];
  // An item handover follows the gate scoped to that item; recording the whole model's gate would say nothing about it.
  const gitNow = st.repo ? { commit: st.head || null, dirty: false } : null;
  const git = item ? gitNow : await recordGate('local', gitNow);
  await recordEvent('handover', { handover: plan.id, revision: rev, commit: git ? git.commit : null, dirty: false, ...(item ? { item: item.id } : {}) });
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
  // A check written as a description is reported and not run: the shell could only fail it, and that failure would say nothing about the decision.
  const written = d => (d.checks || []).filter(c => c && !/^TODO/.test(String(c)));
  const targets = (list || A.decisions).filter(d => written(d).length);
  if (!targets.length) {
    const todo = (list || A.decisions).filter(d => (d.checks || []).some(c => /^TODO/.test(String(c))));
    toast(todo.length ? `${todo.map(d => d.id).join(', ')} only ${todo.length === 1 ? 'has' : 'have'} a TODO check. Replace it in the decision file with a command that exits 0 when the decision holds.` : 'No decision has a runnable check yet.', 'warning');
    return;
  }
  A.running = true; showPanel('output'); renderStatus();
  appendOutput(`\n── ${new Date().toLocaleTimeString()}  running checks for ${plural(targets.length, 'decision')} in ${A.root.name}\n`);
  let skipped = 0;
  try {
    for (const d of targets) {
      let pass = true, ran = 0;
      for (const cmd of written(d)) {
        const problem = Policy.checkProblem(cmd);
        if (problem) { skipped++; appendOutput(`\n⚠ ${d.id}  ${cmd}\nNot run. ${problem} Rewrite it as a shell command that exits 0 when the decision holds, or start it with TODO until the script exists.\n`); continue; }
        appendOutput(`\n▶ ${d.id}  $ ${cmd}\n`);
        const r = await host.runCheck(`${d.id}-${Date.now()}`, cmd);
        if (r.cancelled) { appendOutput('Cancelled: folder not trusted.\n'); return; }
        const ok = r.code === 0; pass = pass && ok; ran++;
        appendOutput(`${ok ? '✓ passed' : `✗ failed (exit ${r.code})`} in ${(r.ms / 1000).toFixed(1)}s\n`);
        if (r.code === 127) appendOutput(`The shell could not find the program "${String(cmd).trim().split(/\s+/)[0]}". A check runs as a command in ${A.root.name}; check the name and that it is on PATH.\n`);
        await recordEvent('check', { decision: d.id, check: cmd, outcome: ok ? 'pass' : 'fail', source: 'local', ms: r.ms, exit_code: r.code });
      }
      appendOutput(ran ? `${pass ? '●' : '○'} ${d.id} ${pass ? 'passing' : 'failing'}\n` : `○ ${d.id} not checked: no check is a command yet\n`);
    }
  } finally { A.running = false; renderStatus(); }
  if (skipped) toast(`${plural(skipped, 'check')} read as descriptions, not commands, and were not run. See Output.`, 'warning', [{ label: 'Show output', run: () => showPanel('output') }]);
}

// ---------------------------------------------------------------- LLM (grill-me, proposal drafting)
function parseJson(text) { const t = String(text || '').replace(/^[\s\S]*?```(?:json)?\s*/i, m => (m.includes('```') ? '' : m)).replace(/```[\s\S]*$/, ''); const s = t.indexOf('{'), e = t.lastIndexOf('}'); return JSON.parse(t.slice(s, e + 1)); }
function llmError(r) {
  if (r.error === 'not_configured') return ['Grill-me needs a model. Use Set up this folder to choose a model provider, or set llm in designc.json.', [{ label: 'Open designc.json', run: () => openFile('designc.json') }]];
  if (r.error === 'no_key') return [`Set the ${r.env} environment variable to your model key, then restart designc.`, []];
  if (r.error === 'no_gcloud' || r.error === 'no_adc') return [`${r.error === 'no_gcloud' ? 'gcloud is not installed.' : 'Google credentials are not set up.'} ${r.hint}`, []];
  if (r.error === 'no_project') return ['Set llm.project in designc.json (Set up this folder has a field for it), or GOOGLE_CLOUD_PROJECT in your environment.', []];
  if (r.error === 'invalid') return ['The llm settings in designc.json are not valid. Open Set up this folder to check the provider, project, region and model.', []];
  if (r.error === 'http') return [`The model provider answered ${r.status}: ${r.message}`, []];
  return [`Couldn't reach the model provider: ${r.message || r.error}`, []];
}
async function grill() {
  if (!A.root || A.grill.busy) return;
  setActivity('design'); A.grill.busy = true; A.grill.error = null; renderSidebar();
  const live = A.diags.filter(f => !f.suppressed).map(f => `${f.code} ${f.sev} on ${f.loc.label} (line ${f.loc.line}): ${f.msg}`);
  const needs = A.ledger.filter(e => e.kind === 'needs_decision' && e.status === 'open').map(e => `${e.id}: ${e.question} (task ${e.task}, element ${elementLabel(e.element)})`);
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
  if (!Setup.llmReady(A.cfg.llm) && grillInPanel(`Grill me on this design. Ask the 3 to 5 questions I most need to answer before it is handed to the coding pipeline, one at a time, waiting for my answer before the next. Prioritise error findings, undeclared properties on critical paths, open needs-decision items and untraced requirements; say for each why it matters and whether a product owner rather than an engineer must answer. Read the model, findings, gate and decisions with your designc tools. When an answer settles something, offer to mint a decision; never bind one.`)) {
    A.grill.busy = false; renderSidebar(); return;
  }
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
    { role: 'system', content: 'You are the analyst in Improve, the evals and improvement loop of a design-to-code factory. You propose changes to the factory, never to the product, and never apply them.' },
    { role: 'user', content: `Design is the design compiler (lint rules DC001-DC006, P behavioural models, grill-me questions, a definition-of-ready gate). Build is the agentic coding pipeline (planner, executor agents, routing, verify).
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
  if (a === 'topology' && A.sidebarOpen && A.root) openSpecial('special:topology');
  if (a === 'work' && A.sidebarOpen && A.root) openSpecial('special:work');
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
  const wd = typeof WK !== 'undefined' && WK.digest ? WK.digest.needs.length + WK.digest.failed.length : 0;
  const b6 = $('#badge-work'); b6.textContent = wd || ''; b6.className = 'badge' + (wd ? ' on bad' : '');
}
function tabTitle(id) { return id === 'special:setup' ? 'Set up' : id === 'special:compare' ? 'Compare' : id === 'special:build' ? 'Build' : id === 'special:improve' ? 'Improve' : id === 'special:codemap' ? 'Code map' : id === 'special:canvas' ? 'Canvas' : id === 'special:deployment' ? 'Deployment' : id === 'special:topology' ? 'Agent topology' : id === 'special:work' ? 'Work' : id.split('/').pop(); }
function renderTabs() {
  $('#tabs').innerHTML = A.tabs.map(id => {
    const b = A.buffers.get(id); const [cls, ch] = id.startsWith('special:') ? ['special', id === 'special:setup' ? 'SET' : id === 'special:compare' ? 'GIT' : id === 'special:build' ? 'BD' : id === 'special:codemap' ? 'AB' : id === 'special:canvas' ? 'CV' : id === 'special:deployment' ? 'DP' : id === 'special:topology' ? 'AT' : id === 'special:work' ? 'WK' : 'IM'] : iconFor(id.replace(/^code:/, ''));
    return `<div class="tab ${id === A.active ? 'active' : ''} ${b && b.dirty ? 'dirty' : ''}" data-tab="${esc(id)}" title="${esc(id)}" role="tab" aria-selected="${id === A.active}"><span class="ticon ${cls}">${esc(ch)}</span>${esc(tabTitle(id))}<button class="x" data-close="${esc(id)}" aria-label="Close ${esc(tabTitle(id))}">✕</button></div>`;
  }).join('');
  const on = $('#tabs .tab.active'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function renderCrumbs() {
  const id = A.active;
  $('#crumbs').innerHTML = !id ? '' : id.startsWith('special:') ? `<span>${esc(A.root ? A.root.name : '')}</span>›<span>${{ 'special:build': 'Build (coding pipeline)', 'special:improve': 'Improve (evals and improvement)', 'special:codemap': 'Code map (as built)', 'special:canvas': 'Canvas (draw the design)', 'special:deployment': 'Deployment (where it runs)', 'special:topology': 'Agent topology (who calls what)', 'special:work': 'Work (items in progress)', 'special:compare': 'Compare with revision', 'special:setup': 'Set up this folder' }[id]}</span>`
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
  const llm = Setup.llmReady(A.cfg.llm) ? `LLM: ${A.cfg.llm.model}` : 'LLM: not configured';
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
  const titles = { explorer: 'Explorer', design: 'Design', codemap: 'Code map · as built', build: 'Build', improve: 'Improve', scm: 'Source control', deployment: 'Deployment', topology: 'Agent topology', work: 'Work' };
  $('#sbTitle').textContent = titles[A.activity];
  const body = $('#sbBody');
  if (!A.root) { body.innerHTML = `<div class="hint">You have not opened a folder yet.</div><button class="btn primary block" data-a="open">Open Folder</button><button class="btn block" data-a="sample">Open Sample Registry</button>`; return; }
  if (A.activity === 'explorer') body.innerHTML = section('files', A.root.name, treeHTML(A.tree, 0) || '<div class="hint">This folder is empty.</div>');
  else if (A.activity === 'design') body.innerHTML = designSidebar();
  else if (A.activity === 'build') body.innerHTML = buildSidebar();
  else if (A.activity === 'codemap') body.innerHTML = codemapSidebar();
  else if (A.activity === 'scm') body.innerHTML = gitSidebar();
  else if (A.activity === 'deployment') body.innerHTML = deploymentSidebar();
  else if (A.activity === 'topology') body.innerHTML = topologySidebar();
  else if (A.activity === 'work') body.innerHTML = workSidebar();
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
    return `<div class="row ${A.active === n.path ? 'active' : ''}" ${pad} data-file="${esc(n.path)}"><span class="tw"></span><span class="fi">${esc(ch)}</span><span class="lbl" style="${errs ? 'color:var(--err)' : ''}">${esc(n.name)}${b && b.dirty ? ' ●' : ''}</span>${errs ? `<span class="desc" style="color:var(--err)">${errs}</span>` : ''}${/^(ledger|handovers)\//.test(n.path) ? '' : `<button class="rowdel" data-delfile="${esc(n.path)}" title="Delete ${esc(n.name)}">×</button>`}</div>`;
  }).join('');
}
function checkState(id) { const l = Core.latestCheck(A.ledger, id); return l ? (l.outcome === 'pass' ? 'pass' : 'fail') : ''; }
const CLAUSE_LABEL = { parse: 'model', registry: 'file', duplicate: 'duplicate', finding: 'finding', decision: 'decision', evidence: 'evidence', check: 'check', promotion: 'promotion', assumption: 'assumption', requirement: 'requirement', scenario: 'scenario', acceptance: 'acceptance', tokens: 'tokens', eval: 'eval', needs: 'pipeline' };
const CLAUSE_ORDER = Object.keys(CLAUSE_LABEL);
// Blocking items in the order they are best worked through; i stays the index into the gate's clauses.
function gateOrder(clauses) {
  const rank = c => { const r = CLAUSE_ORDER.indexOf(c.kind); return r < 0 ? CLAUSE_ORDER.length : r; };
  return clauses.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i);
}
// What the person does next, for clauses whose text names the problem but not the fix.
function clauseHelp(c) {
  if (c.kind === 'evidence' && / without evidence$/.test(c.text)) return 'A business decision is agreed by whoever owns the business. If that is someone else, link to where they agreed it: a ticket, an issue or meeting notes. If it is you, say so and your bind is the record.';
  if (c.kind === 'decision' && / accepts a risk without a bound business decision$/.test(c.text)) return 'Keeping a risk is a business call, not a technical one. Point this decision at the business decision that agreed the risk, or draft one and get it agreed.';
  if (c.kind === 'acceptance' && / is a UI element with no acceptance criterion$/.test(c.text)) return 'A UI element needs a criterion with one case per state: ready, loading, empty and error (and forbidden behind a sign-in). Use New criterion in the Acceptance section.';
  if (c.kind === 'tokens') return 'Edit design-tokens/tokens.json: raise the text size, or set ux.minTextSize in designc.json to a lower minimum if that is intended.';
  if (c.kind === 'acceptance' && /: no case for state /.test(c.text)) return 'Add a case for that state to the criterion file: what the user sees (given, then).';
  return '';
}
function evidenceHost(c) { const m = c.kind === 'evidence' && /evidence host (\S+) is not allowed/.exec(c.text); return m ? m[1] : null; }
function clauseActions(c) {
  const b = (attr, v, label, title) => `<button class="lnk" ${attr}="${esc(String(v))}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`;
  if (c.kind === 'finding') { const fi = A.diags.indexOf(c.finding), dec = Core.decisionsFor(c.finding, A.decisions)[0]; if (dec) return b('data-file', dec._path, decisionNote(dec), 'Open the decision'); return fi < 0 ? '' : b('data-fixfi', fi, 'Record decision') + (c.finding.sev !== 'note' && !c.finding.unknown ? b('data-accfi', fi, 'Accept risk') : '') + b('data-askfi', fi, 'Ask the tutor'); }
  if (c.kind === 'decision' && / is (minted|checked), not bound$/.test(c.text)) return b('data-bind', c.decision, 'Bind', 'Bind the decision after reading it');
  if (c.kind === 'promotion') return b('data-bind', c.decision, 'Re-bind', 'Records the current state of what the decision binds as accepted');
  if (c.kind === 'check') return b('data-run', c.decision, 'Run check');
  if (c.kind === 'assumption' && / was due for review on /.test(c.text)) return b('data-review', c.decision, 'Mark reviewed');
  if (c.kind === 'evidence' && evidenceHost(c)) return b('data-allowhost', evidenceHost(c), `Allow ${evidenceHost(c)}`, 'Adds the host to evidenceHosts in designc.json');
  if (c.kind === 'evidence' && / without evidence$/.test(c.text)) return b('data-addevidence', c.decision, 'Add evidence', 'Link to where the business agreed this') + b('data-owner', c.decision, "I'm the business", `Adds ${A.user} to businessOwners in designc.json, so a business decision you bind needs no link`);
  if (c.kind === 'decision' && / accepts a risk without a bound business decision$/.test(c.text)) return b('data-relyon', c.decision, 'Choose business decision', 'Pick or draft the business decision this accepted risk rests on');
  if (c.kind === 'requirement' && c.requirement) return b('data-mapreq', c.requirement, 'Map to elements', 'Grill-me reads the imported page and proposes the elements; you approve');
  if (c.kind === 'tokens') return b('data-file', TOKENS, 'Open tokens file');
  if (c.kind === 'acceptance') return b('data-a', 'newacc', 'New criterion', 'Write an acceptance criterion for a UI element: one case per state');
  if (c.kind === 'needs' && c.needs && c.needs.id) return ndOptionsHtml(c.needs.id) + b('data-ndans', c.needs.id, 'Answer with a decision') + b('data-ndres', c.needs.id, 'Mark resolved', 'Closes the question without a decision, for one that is not about the design');
  if (c.kind === 'eval' && c.agent && c.evalId) return b('data-runeval', c.evalId, 'Run eval');
  return '';
}
// Human only: evidence is what a person agreed, so no agent tool writes it.
async function addEvidence(d) {
  if (!d) return;
  const url = ((await askText(`Link to where ${d.id} was agreed (an https page: ticket, issue or meeting notes).`, 'https://')) || '').trim();
  if (!url || url === 'https://') return;
  let u; try { u = new URL(url); } catch { u = null; }
  if (!u || u.protocol !== 'https:') { toast(`${url} is not an https link. Paste the full address, starting with https://.`, 'warning'); return; }
  await editYaml(d._path, t => setField(t, 'evidence', yamlStr(url)));
  const hosts = A.cfg.evidenceHosts || [];
  if (!hosts.includes(u.hostname)) await allowEvidenceHost(u.hostname);
  else toast(`Evidence added to ${d.id}.`);
}
// Human only, like acceptRisk: an accepted risk names the business decision it rests on.
async function chooseBusinessDecision(d) {
  if (!d) return;
  const biz = A.decisions.filter(x => x.kind === 'business' && x.status !== 'superseded');
  const pick = await askChoice(`${d.id} keeps a risk. Which business decision agreed it?`,
    [...biz.map(x => ({ value: x.id, label: `${x.id} (${x.status}): ${trunc(String(x.statement || 'no statement'), 60)}` })), { value: '', label: 'Draft a new business decision', primary: !biz.length }]);
  if (pick == null) return;
  let id = pick, drafted = null;
  if (!id) {
    const what = ((await askText('What risk does the business accept? Say it so someone outside the team can agree to it.', String(d.statement || '').replace(/^PROPOSED:\s*/, ''))) || '').trim();
    if (!what) return;
    drafted = await recordDecision({ kind: 'business', effect: 'accept', statement: what, binds: d.binds || [], resolves: [], rationale: `Agreed risk behind ${d.id}`, open: false });
    id = drafted.id;
  }
  const relies = [...new Set([...(Array.isArray(d.relies_on) ? d.relies_on : []), id])];
  await editYaml(d._path, t => setField(t, 'relies_on', yamlList(relies)));
  const b = A.decisions.find(x => x.id === id);
  if (drafted) { await openFile(drafted.path); toast((A.cfg.businessOwners || []).includes(A.user) ? `Drafted ${id}. Read it, then bind it.` : `Drafted ${id}. Bind it, then add evidence or say you are the business.`); }
  else toast(b && b.status === 'bound' ? `${d.id} now rests on ${id}.` : `${d.id} now rests on ${id}. Bind ${id} to clear the gate.`);
}
// Human only: the person says they are the business, so their binds need no evidence link (Core.gate businessOwners).
async function becomeBusinessOwner(d) {
  if (!confirm(`Record ${A.user} as a business owner? This adds ${A.user} to businessOwners in designc.json. A business decision you bind then needs no evidence link: your bind is the record.`)) return;
  let cfg = {}; const t = await readText('designc.json');
  if (t) { try { cfg = JSON.parse(t); } catch { toast('designc.json is not valid JSON; fix it first.', 'error'); return; } }
  const owners = Array.isArray(cfg.businessOwners) ? cfg.businessOwners : [];
  if (!owners.includes(A.user)) cfg.businessOwners = [...owners, A.user];
  await host.write('designc.json', JSON.stringify(cfg, null, 2) + '\n');
  A.cfg.businessOwners = cfg.businessOwners; recompile();
  toast(d && d.promoted_by && d.promoted_by !== A.user ? `${A.user} is a business owner. ${d.id} was bound by ${d.promoted_by}; re-bind it yourself to clear it.` : `${A.user} is a business owner.`);
}
async function allowEvidenceHost(h) {
  if (!h || !confirm(`Allow evidence links on ${h}? This adds it to evidenceHosts in designc.json, so any decision may cite a page there.`)) return;
  let cfg = {}; const t = await readText('designc.json');
  if (t) { try { cfg = JSON.parse(t); } catch { toast('designc.json is not valid JSON; fix it first.', 'error'); return; } }
  const hosts = Array.isArray(cfg.evidenceHosts) ? cfg.evidenceHosts : [];
  if (!hosts.includes(h)) cfg.evidenceHosts = [...hosts, h];
  await host.write('designc.json', JSON.stringify(cfg, null, 2) + '\n');
  A.cfg.evidenceHosts = cfg.evidenceHosts; recompile(); toast(`${h} is now an allowed evidence host.`);
}
// Since last look: the design snapshot kept per registry at the last Mark as seen (the first one is kept on sight).
const designLookKey = () => `designc.designLook:${A.root ? (A.root.root || A.root.name) : ''}`;
const designSnapshot = () => Look.snapshot({ gate: A.gate, diags: A.diags, decisions: A.decisions, drift: A.drift, ledger: A.ledger });
function keepDesignLook() { try { localStorage.setItem(designLookKey(), JSON.stringify(designSnapshot())); } catch { /* no storage: every look is a first look */ } }
function lookHtml() {
  let prev = null;
  try { prev = JSON.parse(localStorage.getItem(designLookKey()) || 'null'); } catch { prev = null; }
  const d = Look.diff(prev, designSnapshot());
  if (d.first) keepDesignLook();
  const row = (cls, text) => `<div class="item"><div class="l1"><span class="dot ${cls}"></span><span>${text}</span></div></div>`;
  const status = s => s ? esc(s) : 'gone';
  const all = [
    d.gate ? row(d.gate.to ? 'pass' : 'fail', d.gate.to ? 'The gate is now ready' : 'The gate is no longer ready') : '',
    ...d.clauses.added.map(t => row('fail', `New blocking item: ${esc(t)}`)),
    ...d.clauses.removed.map(t => row('pass', `Cleared: ${esc(t)}`)),
    ...d.findings.added.map(t => row('fail', `New finding: ${esc(t)}`)),
    ...d.findings.removed.map(t => row('pass', `Resolved: ${esc(t)}`)),
    ...d.decisions.map(x => row('', `${esc(x.id)}: ${x.from ? esc(x.from) : 'new'} → ${status(x.to)}`)),
    d.drift ? row('', `Drift: ${d.drift.undeclared.from} → ${d.drift.undeclared.to} in code only, ${d.drift.unrealised.from} → ${d.drift.unrealised.to} not built`) : '',
  ].filter(Boolean);
  const lines = all.slice(0, 8).join('') + (all.length > 8 ? `<div class="hint">and ${all.length - 8} more; the Ready gate and Problems below have the detail.</div>` : '');
  const extraction = d.extraction && d.extraction.stale
    ? `<div class="hint">The code map was extracted ${plural(d.extraction.days, 'day')} ago, so drift may be out of date. <button class="lnk" data-a="extract">Re-extract</button></div>` : '';
  const body = (d.first ? '<div class="hint">First look at this design. Changes show here from now on.</div>'
    : lines || '<div class="hint">Nothing changed since you last looked.</div>') + extraction;
  return { count: d.count, body };
}

// Dispatch the newest whole-model handover (designc.json dispatch); item handovers are dispatched from their Work card.
function dispatchButton() {
  const s = dispatchSetting(), h = A.handovers.filter(x => !x.work_item).pop();
  if (!s || !h) return '';
  return s.error ? `<button class="btn block" disabled title="${esc(s.error)}">${esc('Dispatch')}</button>`
    : `<button class="btn block" data-a="dispatch" data-id="${esc(h.id)}" title="${esc(dispatchTitle(s, h.id))}">${esc(s.label)} ${esc(h.id)}</button>`;
}
// A new project: no element says where its code goes, so a coding agent would have nowhere it may write.
function codeAreasButton() {
  if (!A.model || A.model.errors.length || ![...A.model.elements.values()].some(e => e.kind === 'container')) return '';
  if ([...A.model.elements.values()].some(e => e.props['d.code'] !== undefined)) return '';
  return `<div class="hint">No element says where its code goes (d.code), so a coding agent has nowhere it may write.</div>
    <button class="btn block" data-a="suggestcode" title="Suggests one folder per container; you see them before anything is written">Suggest code areas</button>`;
}
async function suggestCodeAreas() {
  const b = A.buffers.get(A.cfg.model);
  if (b && b.dirty) return toast(`Save ${A.cfg.model} first. Suggesting code areas writes to the file and would overwrite your unsaved edits.`, 'error');
  const r = Core.suggestCodeAreas(A.modelText);
  if (r.error) return toast(r.error, 'error');
  const names = new Set(r.areas.map(a => a.name));
  const bound = A.decisions.filter(d => d.status === 'bound' && (d.binds || []).some(n => names.has(n))).length;
  if (!confirm(`Add these code areas to ${A.cfg.model}?\n\n${r.areas.map(a => `${a.name}: ${a.pattern} (risk ${a.risk})`).join('\n')}\n\nEdit or remove any of them in the model afterwards; a container you will not build can lose its d.code and d.risk.` +
    (bound ? `\n\nA code area is part of the design, so ${plural(bound, 'bound decision')} on these containers will say changed since promotion until you re-bind them (Re-bind in the gate).` : ''))) return;
  await host.write(A.cfg.model, r.text); await loadModel(); recompile(); await openFile(A.cfg.model); renderAll();
  toast(`Added ${plural(r.areas.length, 'code area')}. Review them in the model before you freeze.`);
}
function designSidebar() {
  const g = A.gate, hasModel = A.model && A.model.elements.size;
  let gate;
  if (!hasModel) gate = `<div class="hint">No model at <b>${esc(A.cfg.model)}</b>.</div><button class="btn block" data-a="newmodel">Create ${esc(A.cfg.model)}</button>`;
  else gate = `<div class="verdict ${g.ready ? 'ok' : 'no'}">${g.ready ? '✓ Ready to hand over' : `✗ ${plural(g.clauses.length, 'blocking item')}`}</div>` +
    gateOrder(g.clauses).map(({ c, i }, n) => `<div class="clause" data-clause="${i}"><span class="k">${n === 0 ? 'next · ' : ''}${CLAUSE_LABEL[c.kind] || esc(c.kind)}</span><span>${esc(c.text)}${clauseHelp(c) ? `<span class="help">${esc(clauseHelp(c))}</span>` : ''}</span>${clauseActions(c)}</div>`).join('') +
    (Core.rebindable(g).length ? `<button class="btn block" data-a="rebindall" title="Records the current state of what each decision binds as accepted">Re-bind ${plural(Core.rebindable(g).length, 'decision')}</button>` : '') +
    codeAreasButton() + (g.ready ? '<button class="btn primary block" data-a="freeze">Freeze handover</button>' : '') + dispatchButton();
  const decs = A.decisions.map(d => `<div class="item" data-open="${esc(d._path)}">
      <div class="l1"><span class="dot ${checkState(d.id)}" title="${checkState(d.id) === 'pass' ? 'Last check passed' : checkState(d.id) === 'fail' ? 'Last check failed' : 'No check result yet'}"></span><span class="id">${esc(d.id)}</span><span class="tag ${esc(d.status)}">${esc(d.status)}</span>${d.effect === 'accept' ? '<span class="tag">accepted risk</span>' : ''}</div>
      <div class="l2">${esc(d.statement || 'No statement yet')}${Array.isArray(d.assumptions) && d.assumptions.length ? ` · ${plural(d.assumptions.length, 'assumption')}${overdueAssumptions(d).length ? `, ${overdueAssumptions(d).length} overdue` : ''}` : ''}</div>
      <div class="acts">${overdueAssumptions(d).length ? `<button class="lnk" data-review="${esc(d.id)}">Mark reviewed</button>` : ''}${d.status !== 'bound' ? `<button class="lnk" data-bind="${esc(d.id)}">Bind</button>` : Core.rebindable(A.gate).includes(d.id) ? `<button class="lnk" data-bind="${esc(d.id)}">Re-bind</button>` : ''}${(d.checks || []).some(c => c && !/^TODO/.test(c)) ? `<button class="lnk" data-run="${esc(d.id)}">Run check</button>` : ''}${d.status === 'minted' || d.status === 'checked' ? `<button class="lnk" data-delfile="${esc(d._path)}" title="Delete this decision file. A bound decision is superseded instead.">Delete</button>` : ''}</div></div>`).join('')
    || '<div class="hint">No decisions yet. Use the lightbulb on a problem in the model, or the + above.</div>';
  const reqs = A.requirements.map(r => `<div class="item" data-open="${esc(r._path)}"><div class="l1"><span class="id">${esc(r.id)}</span>${(r.elements || []).length ? '' : `<button class="lnk" data-mapreq="${esc(r.id)}" title="Grill-me reads the imported page and proposes the elements; you approve">Map to elements</button>`}</div><div class="l2">${esc(r.title || '')}${(r.elements || []).length ? ` → ${esc(r.elements.join(', '))}` : ''}</div></div>`).join('')
    || '<div class="hint">No requirements yet. Add the Jira keys this design answers.</div>';
  const rows = Core.scenarioReport({ model: A.model, scenarios: A.scenarios, ledger: A.ledger });
  rows.forEach((r, i) => { r._path = A.scenarios[i]._path; });
  const scnItem = r => {
    const an = r.analytic;
    const state = r.status === 'unresolved' ? 'fail' : an.status === 'not-met' || r.fitness.status === 'failing' ? 'fail' : an.status === 'met' || r.fitness.status === 'passing' ? 'pass' : '';
    const note = r.status === 'unresolved' ? `artifact "${esc(r.artifact)}" is not in the model` : an.status === 'met' || an.status === 'not-met' ? `availability ≈ ${an.value.toFixed(2)}%` : an.status === 'unknown' ? `declare d.availability on ${esc(an.missing.join(', '))}` : '';
    return `<div class="item" data-open="${esc(r._path)}"><div class="l1"><span class="dot ${state}"></span><span class="id">${esc(r.id)}</span><span class="tag">${esc(r.attribute || '')}</span>${r.importance ? `<span class="tag" title="Importance">imp ${esc(r.importance)}</span>` : ''}${r.difficulty ? `<span class="tag" title="Difficulty">diff ${esc(r.difficulty)}</span>` : ''}</div><div class="l2">${esc(r.title)}${note ? ` · ${note}` : ''}${r.fitness.status !== 'none' ? ` · fitness ${r.fitness.status}` : ''}</div></div>`;
  };
  const rated = rows.some(r => r.importance || r.difficulty);
  const scn = (rated ? Core.utilityTree(rows).map(g => `<div class="hint"><b>${esc(g.attribute || 'no attribute')}</b></div>${g.scenarios.map(scnItem).join('')}`) : rows.map(scnItem)).join('') || '<div class="hint">No scenarios yet. A scenario states a stimulus, the artifact it hits, the response and a measure.</div>';
  const acc = A.acceptance.map(a => `<div class="item" data-open="${esc(a._path)}"><div class="l1"><span class="id">${esc(a.id)}</span><span class="tag">${esc(a.requirement || '')}</span></div><div class="l2">${esc(a.element || '')} · ${(a.cases || []).length} case${(a.cases || []).length === 1 ? '' : 's'}</div></div>`).join('') || '<div class="hint">No acceptance criteria. A UI element needs one case per state.</div>';
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
      <textarea data-ans="${i}" placeholder="Your answer">${esc(q.answer || '')}</textarea><div style="margin-top:6px"><button class="lnk" data-qdraft="${i}">Draft decision from answer</button> <button class="lnk" data-qbiz="${i}">Draft business decision</button> <button class="lnk" data-qdk="${i}" title="Grill-me researches it with you in the agent panel">I don't know</button></div></div>`).join('')}`;
  const look = hasModel ? lookHtml() : null;
  return (look ? section('look', `Since last look${look.count ? ` (${look.count})` : ''}`, look.body,
      look.count ? '<button title="Mark as seen: changes start again from now" data-a="lookseen">✓</button>' : '') : '')
    + section('gate', 'Ready gate', gate)
    + section('decisions', `Decisions (${A.decisions.length})`, decs, `<button title="New decision" data-a="newdec">+</button><button title="Run all checks" data-a="runall">▶</button>`)
    + section('reqs', `Requirements (${A.requirements.length})`, reqs, `<button title="Import requirements from exported pages" data-a="importreq">⇩</button><button title="New requirement" data-a="newreq">+</button>`)
    + section('scenarios', `Scenarios (${A.scenarios.length})`, scn, `<button title="New scenario" data-a="newscn">+</button><button title="Run all fitness functions" data-a="runfit">▶</button>`)
    + section('acceptance', `Acceptance (${A.acceptance.length})`, acc, `<button title="New criterion" data-a="newacc">+</button>`)
    + section('tokens', 'Design tokens', `<div class="item" ${A.tokens != null ? `data-open="${TOKENS}"` : ''}><div class="l1"><span class="id">${TOKENS}</span></div><div class="l2">${A.tokens != null ? 'W3C design tokens, copied into every handover. Text sizes below the minimum block the gate.' : 'None yet. A tokens file gives the build one set of sizes and colours, and the gate a minimum text size.'}</div></div>`, A.tokens == null ? `<button title="New design tokens file" data-a="newtokens">+</button>` : '')
    + section('evals', `Evals (${A.evals.length})`, evs, `<button title="New eval" data-a="neweval">+</button><button title="Run all evals" data-a="runevals">▶</button>`)
    + section('grill', 'Grill-me', grillBody);
}
function buildSidebar() {
  const tasks = A.ledger.filter(e => e.kind === 'task'), passed = tasks.filter(t => t.status === 'passed');
  const tokens = tasks.reduce((a, t) => a + Ledger.totalTokens(t), 0);
  const needs = A.ledger.filter(e => e.kind === 'needs_decision' && e.status === 'open');
  const summary = tasks.length ? `<div class="hint">${passed.length} of ${plural(tasks.length, 'task')} passed. ${passed.length ? `${fmtN(tokens / passed.length)} tokens per passing task.` : ''}</div>` : '<div class="hint">No pipeline events in ledger/*.jsonl yet.</div>';
  const nd = needs.map(n => `<div class="item"><div class="l1"><span class="id">${esc(n.id)}</span><span class="tag open">open</span><span class="desc">${esc(elementLabel(n.element))}</span></div><div class="l2">${esc(n.question)}</div>${ndOptionsHtml(n.id)}
      <div class="acts"><button class="lnk" data-ndans="${esc(n.id)}">Answer with a decision</button><button class="lnk" data-ndres="${esc(n.id)}">Mark resolved</button></div></div>`).join('') || '<div class="hint">Nothing is waiting on the design.</div>';
  return section('bsum', 'Summary', summary) + section('needs', `Waiting on a decision (${needs.length})`, nd);
}
function escapeMetricsHtml(L) {
  const ui = A.model ? [...A.model.elements.values()].filter(e => e.tags && e.tags.has('UI')).map(e => e.name) : [];
  const m = Ledger.escapeMetrics(L, { uiElements: ui, items: A.work ? A.work.filter(w => (A.acceptance || []).some(c => c.requirement === w.requirement)).map(w => w.id) : null });
  if (!m.escapes && !m.acceptance.done && !m.tamper) return '';
  const max = Math.max(1, ...Object.values(m.byOrigin), m.unclassified);
  const bar = (l, n, un) => `<div class="barrow"><span>${esc(l)}</span><div class="bartrack"><div class="barfill ${un ? 'un' : ''}" style="width:${(n / max) * 100}%"></div></div><span class="c">${n}</span></div>`;
  const fp = m.acceptance.done ? `${m.acceptance.firstPass} of ${m.acceptance.done}` : 'n/a';
  return `<div class="grid2"><div class="block"><h3>Escapes by origin</h3><div class="bars">${Ledger.ORIGINS.map(o => bar(ORIGIN_LABEL[o], m.byOrigin[o])).join('')}${bar('Not classified', m.unclassified, true)}</div><div class="note">Origin says where the escape came from; the stage above says what should have caught it.</div></div>
    <div class="block"><h3>UI and acceptance</h3><div class="stats"><div class="stat"><div class="v">${m.uiEscapes} of ${m.escapes}</div><div class="l">Escapes on UI elements</div></div><div class="stat"><div class="v">${m.uiEscapeRate == null ? 'n/a' : m.uiEscapeRate.toFixed(2)}</div><div class="l">UI escapes per done item</div></div><div class="stat"><div class="v">${fp}</div><div class="l">Done items with no acceptance failure</div></div><div class="stat"><div class="v">${m.tamper}</div><div class="l">Unapproved changes to acceptance files</div></div></div></div></div>`;
}
function improveSidebar() {
  const escapes = A.ledger.filter(e => e.kind === 'escape'), un = escapes.filter(e => !e.caught_by);
  const uh = un.map(e => `<div class="item"><div class="l1"><span class="id">${esc(e.id)}</span><span class="desc">${esc(e.element || '')}</span></div><div class="l2">${esc(e.description || '')}</div>
      <div class="acts"><select class="inline" data-classify="${esc(e.id)}" aria-label="Stage that should have caught ${esc(e.id)}"><option value="">Should have been caught by…</option>${STAGES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div></div>`).join('') || '<div class="hint">Every escape is classified.</div>';
  const props = A.proposals.map(p => `<div class="item" data-open="${esc(p._path)}"><div class="l1"><span class="id">${esc(p.id)}</span><span class="tag ${esc(p.status || 'minted')}">${esc(p.status || 'minted')}</span><span class="desc">${esc(p.kind || '')}</span></div><div class="l2">${esc(p.statement || '')}</div>${propDeletable(p) ? `<div class="acts"><button class="lnk" data-delfile="${esc(p._path)}" title="Delete this proposal file. A bound proposal is superseded instead.">Delete</button></div>` : ''}</div>`).join('') || '<div class="hint">No proposals yet.</div>';
  const sug = telSuggestions();
  const sh = sug.map(t => `<div class="item"><div class="l1"><span class="id">${esc(t.task)}</span><span class="desc">${esc(elementLabel(t.element))}</span></div><div class="l2">${esc(t.why)}</div><div class="acts"><button class="lnk" data-telesc="${esc(t.task)}">Record as escape</button></div></div>`).join('');
  return (sug.length ? section('telsug', `Suggested by telemetry (${sug.length})`, sh) : '') + section('unclass', `Unclassified escapes (${un.length})`, uh)
    + section('props', `Proposals (${A.proposals.length})`, props + `<button class="btn block" data-a="draftprops" ${A.drafting ? 'disabled' : ''}>${A.drafting ? 'Drafting…' : 'Draft proposals from escapes'}</button>`, `<button title="New proposal" data-a="newprop">+</button>`);
}

// ---------------------------------------------------------------- panel
function renderPanel() {
  const live = A.diags.filter(d => !d.suppressed);
  const qual = A.root ? qualityNow() : { findings: [], problems: [] };
  const total = live.length + A.model.errors.length + A.yamlErrors.length + A.ledgerErrors.length + A.workErrors.length + A.workWarnings.length + qual.findings.length + qual.problems.length;
  $('#probCount').textContent = A.root ? total : '';
  document.querySelectorAll('[data-panel]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.panel === A.panel)));
  $('#panelClear').style.display = A.panel === 'output' ? '' : 'none';
  const body = $('#panelBody'), term = A.panel === 'terminal';
  body.hidden = term; $('#termBody').hidden = !term;
  if (term) { termShow(); return; }
  if (A.panel === 'output') { body.innerHTML = `<pre class="out">${esc(A.output || 'Check runs appear here. Run > Run All Decision Checks (Ctrl+Shift+B).')}</pre>`; body.scrollTop = 1e9; return; }
  if (!A.root) { body.innerHTML = '<div class="pempty">No problems have been detected in the workspace.</div>'; return; }
  const groups = [];
  const mrows = [...A.model.errors.map(e => ({ sev: 'error', msg: e.msg, code: 'parse', line: e.line })),
    ...live.map((f, i) => ({ sev: f.sev, msg: `${f.loc.label}: ${f.msg}`, code: f.code, line: f.loc.line, fi: A.diags.indexOf(f), unknown: f.unknown, dec: Core.decisionsFor(f, A.decisions)[0] }))];
  if (mrows.length) groups.push([A.cfg.model, mrows]);
  const byPath = new Map();
  for (const e of [...A.yamlErrors, ...A.ledgerErrors, ...A.workErrors]) { if (!byPath.has(e.path)) byPath.set(e.path, []); byPath.get(e.path).push({ sev: 'error', msg: e.msg, code: 'yaml', line: e.line }); }
  for (const w of A.workWarnings) { if (!byPath.has(w.path)) byPath.set(w.path, []); byPath.get(w.path).push({ sev: 'warning', msg: w.msg, code: 'work', line: 1 }); }
  const seenP = new Set();
  for (const x of A.proposals) { if (seenP.has(x.id) && x._path) { if (!byPath.has(x._path)) byPath.set(x._path, []); byPath.get(x._path).push({ sev: 'error', msg: `duplicate id ${x.id}`, code: 'id', line: 1 }); } seenP.add(x.id); }
  groups.push(...byPath);
  const qrows = new Map();
  for (const f of qual.findings) { if (!qrows.has(f.file)) qrows.set(f.file, []); qrows.get(f.file).push({ sev: 'warning', msg: f.msg, code: f.code, line: f.line, codeFile: true }); }
  for (const [file, rows] of qrows) groups.push([file, rows]);
  if (qual.problems.length) groups.push(['designc.json', qual.problems.map(m => ({ sev: 'warning', msg: m, code: 'quality', line: 1 }))]);
  if (!groups.length) { body.innerHTML = '<div class="pempty">No problems have been detected in the workspace.</div>'; return; }
  const supp = A.diags.length - live.length;
  body.innerHTML = groups.map(([path, rows]) => `<div class="pfile" data-open="${esc(path)}"><span class="fi">${esc(iconFor(path)[1])}</span>${esc(path.split('/').pop())}<span class="desc">${esc(path)}</span><span class="count">${rows.length}</span></div>` +
    rows.map(r => `<div class="prow" ${r.codeFile ? 'data-code' : 'data-open'}="${esc(path)}" data-line="${r.line || ''}"><span class="ic ${r.sev}">${r.sev === 'error' ? '⊗' : r.sev === 'warning' ? '⚠' : 'ⓘ'}</span><span class="m">${esc(r.msg)}${r.unknown ? ' <span class="src">(undeclared property)</span>' : ''}</span>
      ${r.fi != null ? `<button class="lnk fix" data-askfi="${r.fi}">Ask the tutor</button>` : ''}${r.dec ? `<button class="lnk fix" data-file="${esc(r.dec._path)}" title="Open the decision">${esc(decisionNote(r.dec))}</button>` : `${r.fi != null && r.code !== 'DC000' ? `<button class="lnk fix" data-fixfi="${r.fi}">Record decision</button>` : ''}${r.fi != null && r.code !== 'DC000' && r.sev !== 'note' && !r.unknown ? `<button class="lnk fix" data-accfi="${r.fi}">Accept risk</button>` : ''}`}<span class="src">designc(${esc(r.code)}) [Ln ${r.line || 1}]</span></div>`).join('')).join('')
    + (supp ? `<div class="pempty">${plural(supp, 'finding')} suppressed in the model with a reason.</div>` : '');
}

// ---------------------------------------------------------------- welcome
function renderWelcome() {
  const w = $('#welcome');
  if (A.root) {
    w.innerHTML = `<div class="wl"><h1>${esc(A.root.name)}<small>${esc(A.root.root)}</small></h1>
      <div><h2>Start</h2>${A.model && A.model.elements.size ? `<button class="l" data-file="${esc(A.cfg.model)}">Open the model (${esc(A.cfg.model)})</button>` : `<button class="l" data-a="newmodel">Create ${esc(A.cfg.model)}</button>`}
        <button class="l" data-a="design">Show the ready gate</button><button class="l" data-a="codemapopen">Code map of ${A.cfg.codebase ? esc(String(A.cfg.codebase).split('/').pop()) : 'a codebase'}</button><button class="l" data-a="builddash">Build dashboard</button><button class="l" data-a="improvedash">Improve dashboard</button></div>
      <div><h2>Keys</h2><table><tr><td>Ctrl+S</td><td>Save</td></tr><tr><td>Ctrl+Shift+B</td><td>Run all decision checks</td></tr><tr><td>Ctrl+Shift+G</td><td>Ask grill-me</td></tr><tr><td>Ctrl+Alt+V</td><td>Toggle the C4 sheet</td></tr><tr><td>Ctrl+.</td><td>Record a decision for a problem</td></tr><tr><td>Backspace, in the Code map</td><td>Up one level</td></tr></table></div></div>`;
    return;
  }
  w.innerHTML = `<div class="wl"><h1>designc<small>System design IDE: the design is the source, code is the build output.</small></h1>
    <div><h2>Start</h2><button class="l" data-a="open">Open Folder…</button><button class="l" data-a="sample">Open Sample Registry</button>
      ${A.recent.length ? `<h2 style="margin-top:22px">Recent</h2>${A.recent.map(r => `<button class="l" data-recent="${esc(r)}" title="${esc(r)}">${esc(r.split(/[\\/]/).pop())} <span style="color:var(--fg3)">${esc(r)}</span></button>`).join('')}` : ''}</div>
    <div><h2>A registry folder holds</h2><table>
      <tr><td>model/workspace.dsl</td><td>C4 model with d.* design properties</td></tr><tr><td>behaviour/*.p</td><td>P models, one per protocol</td></tr>
      <tr><td>requirements/*.yaml</td><td>Jira keys the design answers</td></tr><tr><td>decisions/*.yaml</td><td>Decisions, each with checks</td></tr>
      <tr><td>proposals/*.yaml</td><td>Improve proposals</td></tr><tr><td>ledger/*.jsonl</td><td>Events from every system</td></tr>
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
    const kind = e.kindLabel || (person ? 'Person' : e.kind === 'softwareSystem' ? 'Software System' : e.kind === 'component' ? 'Component' : 'Container');
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
  // Timing badges: every sync rel shows its timeout against the callee's worst case; a selected box shows the retry multiplier it puts on what it reaches.
  const tim = A.badges === 'timing' ? Core.timing(m, { retryAmplification: A.cfg.retryAmplification || 4 }) : null;
  const amp = tim && A.selected && m.elements.has(A.selected) ? Core.amplificationFrom(m, A.selected) : new Map();
  const TIM_COL = { ok: 'var(--ink3)', violation: 'var(--err)', unknown: 'var(--warn)' };
  const timLabel = (r, t) => [r.description, t.timeout == null ? '' : t.status === 'unknown' ? t.timeout + ' ms vs ?' : `${t.timeout} ms vs ${t.worst} ms`, t.factor > 1 ? '×' + t.factor : ''].filter(Boolean).join(' · ');
  const BLAST_BADGE = { down: ['down', 'var(--err)'], degraded: ['deg', 'var(--warn)'], unknown: ['?', 'var(--ink3)'] };
  host_.innerHTML = drawModel(m, L, {
    attr: 'el', zoom: fitZoom(host_, L, A.zoom),
    edgeStyle: r => { const t = tim && tim.rels.get(r.id);
      if (t) return { color: TIM_COL[t.status], width: t.status === 'ok' ? 1.3 : 2, dash: '', marker: t.status === 'violation' ? 'error' : t.status === 'unknown' ? 'warning' : 'n', labelColor: t.status === 'ok' ? null : TIM_COL[t.status], label: timLabel(r, t) };
      if (tim) return { color: col(null), width: 1, dash: Core.interaction(r) === 'async' ? '6 4' : '', marker: 'n', labelColor: null, label: '' };
      const sev = relSev.get(r.id), hot = A.selected && (r.src === A.selected || r.dst === A.selected), as = Core.interaction(r) === 'async';
      return { color: col(sev), width: hot ? 2.4 : sev ? 1.8 : 1.3, dash: as ? '6 4' : '', marker: sev || 'n', labelColor: sev ? col(sev) : null, label: r.description ? r.description + (as ? ' (async)' : '') : '' }; },
    nodeStyle: e => {
      const base = { stroke: A.selected === e.id ? 'var(--accent)' : 'var(--ink)', sw: A.selected === e.id ? 2.6 : 1.5 };
      if (tim) { const x = amp.get(e.id); return x > 1 ? { ...base, badge: '×' + x, badgeColor: x > (A.cfg.retryAmplification || 4) ? 'var(--err)' : 'var(--ink3)' } : base; }
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
      + ((d.uiUntagged || []).length ? `<div class="hint" style="padding-bottom:2px"><b>Single-page app not tagged UI</b></div>` + d.uiUntagged.map(n => row(esc(n), 'add the UI tag so acceptance criteria apply', '')).join('') : '')
      || '<div class="hint">The code matches the design.</div>';
    h += section('drift', `Drift (${d.undeclared.length + d.unknownEls.length + d.unrealised.length + d.missingEls.length + (d.uiUntagged || []).length})`, body);
  } else if (A.asbuilt) h += section('drift', 'Drift', `<div class="hint">Drift appears once ${esc(A.cfg.model)} has elements to compare against.</div>`);
  if (A.cdrift && cmHasComponents()) h += section('cdrift', 'Components', cmDriftBody());
  if (f) h += codeAreasSection();
  if (f && f.unresolved.length) h += section('unres', `Unresolved (${f.unresolved.length})`, `<div class="hint">Extraction saw these but could not tie them to an element, so they are not on the map.</div>` +
    f.unresolved.map(u => `<div class="item" data-code="${esc(u.file)}" data-line="${u.line}"><div class="l1"><span class="id">${esc(u.where)}</span></div><div class="l2">${esc(u.what)}</div><div class="l2" style="font-family:var(--mono);font-size:11px">${esc(u.file)}:${u.line}</div></div>`).join(''));
  return h;
}
// d.code against the files in the codebase. Display only: not in Problems, the gate or the CLI.
function codeAreasSection() {
  const ar = A.areas;
  if (!ar) return section('areas', 'Code areas', '<div class="hint">Re-extract to see code areas: this map was extracted before designc kept the file list.</div>');
  if (!ar.areas.length) return section('areas', 'Code areas', '<div class="hint">No element declares d.code. Set it on a container or its components to say where that code lives; a coding agent confines each task to it.</div>');
  const row = (label, desc, attrs) => `<div class="row" style="--indent:20px;height:auto;min-height:22px;white-space:normal;padding-top:3px;padding-bottom:3px" ${attrs}><span class="lbl">${label}</span>${desc ? `<span class="desc">${desc}</span>` : ''}</div>`;
  const empty = ar.areas.filter(a => !a.matched).length, MAX = 50;
  const body = `<div class="hint">Code areas cover ${ar.files - ar.unclaimed.length} of the ${plural(ar.files, 'file')} in the codebase.</div>`
    + ar.areas.map(a => row(`${esc(a.name)}: <code>${esc(a.pattern)}</code>`, a.matched ? plural(a.matched, 'file') : esc(a.hint || 'matches no file in the codebase'), `data-open="${esc(A.cfg.model)}" data-line="${A.model.elements.get(a.id).line}"`)).join('')
    + (ar.unclaimed.length ? `<div class="hint" style="padding-bottom:2px"><b>In no code area</b></div>` + ar.unclaimed.slice(0, MAX).map(x => row(esc(x), '', `data-code="${esc(x)}" data-line="1"`)).join('')
      + (ar.unclaimed.length > MAX ? `<div class="hint">and ${ar.unclaimed.length - MAX} more</div>` : '') : '');
  return section('areas', `Code areas (${empty + ar.unclaimed.length})`, body);
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
function cmHasCode() { return !!(A.facts && A.facts.code && A.facts.code.types && A.facts.code.types.length); }
// The component the Code level opens on: the scope if it is one, else the selected component, else the first with types.
function cmCodeScope() {
  const has = id => id && A.facts.code.types.some(t => t.component === id);
  if (has(A.cmScope)) return A.cmScope;
  if (has(A.cmSel)) return A.cmSel;
  const t = A.facts.code.types[0]; return t ? t.component : null;
}
function cmModel() {
  if (A.cmLevel === 'code') return cmHasCode() ? CodeLevel.model(A.facts.code, A.cmScope) : A.asbuilt;
  return A.asbuiltFull ? Core.view(A.asbuiltFull, { level: A.cmLevel, scope: A.cmScope }) : A.asbuilt;
}
function cmGo(level, scope) {
  if (level === 'component' && !cmHasComponents()) return;
  if (level === 'code') { if (!cmHasCode()) return; if (scope === undefined || scope === null) scope = cmCodeScope(); }
  A.cmLevel = level; if (scope !== undefined) A.cmScope = scope;
  A.cmZoom = 'fit';
  const m = cmModel(); if (A.cmSel && !(m && m.elements.has(A.cmSel))) A.cmSel = null;
  renderCodemap();
}
function cmUp() {
  if (A.cmLevel === 'code') { const c = A.asbuiltFull && A.asbuiltFull.elements.get(A.cmScope); A.cmSel = null; return cmGo('component', c ? c.parent : null); }
  if (A.cmLevel === 'component') cmGo('container'); else if (A.cmLevel === 'container') cmGo('context'); }
function cmSeg() {
  const has = cmHasComponents();
  const hasCode = cmHasCode();
  const b = (lv, name) => `<button class="${A.cmLevel === lv ? 'on' : ''}" data-a="cmlevel" data-level="${lv}" ${lv === 'component' && !has ? 'disabled title="No components were found"' : ''} ${lv === 'code' && !hasCode ? 'disabled title="No types were found. Re-extract to read them."' : ''}>${name}</button>`;
  const sc = A.cmScope && A.asbuiltFull && A.asbuiltFull.elements.get(A.cmScope);
  const cc = A.cmLevel === 'code' && A.asbuiltFull && A.asbuiltFull.elements.get(A.cmScope), cp = cc && A.asbuiltFull.elements.get(cc.parent);
  const crumb = A.cmLevel === 'code' ? `<span class="cm-crumb"><button class="cm-all" data-a="cmscope">All</button>${cp ? ` ▸ <button class="cm-all" data-a="cmcontainer" data-id="${esc(cp.id)}">${esc(cp.name)}</button>` : ''}${cc ? ` ▸ <b>${esc(cc.name)}</b>` : ''}</span>` : A.cmLevel === 'component' ? `<span class="cm-crumb"><button class="cm-all" data-a="cmscope">All</button>${sc ? ` ▸ <b>${esc(sc.name)}</b>` : ''}</span>` : '';
  return `<span class="cm-seg">${b('context', 'Context')}${b('container', 'Containers')}${b('component', 'Components')}${b('code', 'Code')}</span>${crumb}`;
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
      ${A.cmLevel === 'code' ? '<span class="legend"><i class="lg ghost"></i>type in another component</span>' : ''}
      ${A.cmLevel !== 'context' && A.cmLevel !== 'code' ? `<span class="legend"><i class="lg ok"></i>in the design <i class="lg warn"></i>not in the design ${A.drift ? '<i class="lg ghost"></i>designed, not in code' : ''}</span>` : ''}
      <span class="spacer"></span>${A.drift && A.cmLevel !== 'context' && A.cmLevel !== 'code' ? `<label class="chk"><input type="checkbox" data-a="ghost" ${A.showGhost ? 'checked' : ''}> Show designed-only edges</label>` : ''}
      <button class="btn" data-a="cmfit">Fit</button><button class="btn" data-a="extract" ${A.extracting ? 'disabled' : ''}>${A.extracting ? 'Extracting…' : 'Re-extract'}</button></div>
    <div class="cm-main"><div class="cm-canvas sheetscroll" id="cmcanvas"></div><aside class="cm-side" id="cmside"></aside></div></div>`;
  requestAnimationFrame(drawCodemap);
}
function drawCodemap() {
  const host_ = $('#cmcanvas'); if (!host_ || !A.asbuilt) return;
  if (A.cmLevel === 'code') return drawCode(host_);
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
      const q = cmQualityBadge(e);
      if (e.kind === 'component') {
        const warn = cd && full && cd.scored.has(e.parent) && !cd.toDesign.has(e.id), ink = cd && cd.toDesign.has(e.id);
        return { ...q, stroke: on ? 'var(--accent)' : warn ? 'var(--warn)' : ink ? 'var(--ink)' : 'var(--ink3)', sw: on ? 2.8 : warn ? 2.2 : 1.5, dash: warn ? '6 3' : '', note: warn ? 'not in design' : '' };
      }
      const mapped = !d || d.toDesign.has(e.id);
      return { ...q, stroke: on ? 'var(--accent)' : mapped ? 'var(--ink)' : 'var(--warn)', sw: on ? 2.8 : mapped ? 1.5 : 2.2, dash: mapped ? '' : '6 3', note: mapped ? '' : 'not in design' };
    },
  });
  renderCmSide();
}
// The Code level: the types of one component and what they refer to, drawn with the shared layout and drawing.
function drawCode(host_) {
  const m = cmModel(), L = layout(m);
  host_.innerHTML = drawModel(m, L, {
    attr: 'cm', zoom: fitZoom(host_, L, A.cmZoom),
    edgeStyle: r => { const hot = A.cmSel && (r.src === A.cmSel || r.dst === A.cmSel); return { color: hot ? 'var(--accent)' : 'var(--ink3)', width: hot ? 2.2 : 1.3, dash: r.description === 'uses' ? '6 4' : '', label: r.description }; },
    nodeStyle: e => { const on = A.cmSel === e.id; return { ...cmQualityBadge(e), stroke: on ? 'var(--accent)' : e.outside ? 'var(--ink3)' : 'var(--ink)', sw: on ? 2.8 : 1.5, dash: e.outside ? '6 3' : '', note: e.outside ? cmCompName(e.component) : '' }; },
  });
  renderCmSide();
}
const cmCompName = id => { const c = A.asbuiltFull && A.asbuiltFull.elements.get(id); return c ? c.name : ''; };
function cmTypeSide(t) {
  const code = A.facts.code, rows = CodeLevel.methodsOf(code, t.id).sort((a, b) => b.cc - a.cc || a.name.localeCompare(b.name));
  const edges = dir => code.typeEdges.filter(x => (dir === 'out' ? x.from : x.to) === t.id).map(x => { const o = code.types.find(y => y.id === (dir === 'out' ? x.to : x.from)); return `<div class="evrow" data-code="${esc(x.evidence.file)}" data-line="${x.evidence.line}"><b>${dir === 'out' ? '→ ' : '← '}${esc(o ? o.name : '?')}</b> <span class="tag">${esc(x.via)}</span><div class="evfile">${esc(x.evidence.file)}:${x.evidence.line}</div></div>`; }).join('');
  const qf = qualityNow().findings.filter(f => f.typeId === t.id), hot = new Set(qf.filter(f => f.method).map(f => f.method));
  rows.forEach(x => { x.warn = hot.has(x.name); });
  return `<h3>${esc(t.name)}</h3><div class="muted">${esc(CodeLevel.LABEL[t.kind] || t.kind)} in ${esc(cmCompName(t.component))}</div>
    ${qf.length ? `<h4>Quality (${qf.length})</h4>${qf.map(f => `<div class="evrow" data-code="${esc(f.file)}" data-line="${f.line}"><span class="tag warning">${esc(f.code)}</span> ${esc(f.msg)}</div>`).join('')}` : ''}
    <h4>Methods (${rows.length})</h4>${rows.map(x => `<div class="evrow" data-code="${esc(x.file)}" data-line="${x.line}"><b>${esc(x.name)}</b> <span class="tag${x.warn ? ' warning' : ''}">cc ${x.cc}</span> <span class="tag">${x.lines} lines</span> ${x.coverage == null ? '<span class="tag" title="No coverage report covers this method">cov ?</span>' : `<span class="tag">cov ${Math.round(x.coverage * 100)}%</span> <span class="tag">CRAP ${Math.round(Quality.crap(x.cc, x.coverage) * 10) / 10}</span>`}<div class="evfile">${esc(x.file)}:${x.line}</div></div>`).join('') || '<p class="muted">No methods with a body.</p>'}
    <h4>Files</h4>${t.files.map(x => `<div class="evrow" data-code="${esc(x.file)}" data-line="${x.line}"><div class="evfile">${esc(x.file)}:${x.line}</div></div>`).join('')}
    ${edges('out') ? `<h4>Depends on</h4>${edges('out')}` : ''}${edges('in') ? `<h4>Used by</h4>${edges('in')}` : ''}`;
}
function renderCmSide() {
  const side = $('#cmside'); if (!side) return;
  const f = A.facts; const d = A.cmLevel === 'container' ? A.drift : null;
  if (A.cmLevel === 'code') {
    const t = A.cmSel && f.code.types.find(x => x.id === A.cmSel);
    side.innerHTML = t ? cmTypeSide(t) : `<h3>${esc(cmCompName(A.cmScope))}</h3><p class="muted">Select a type to see its methods. Dashed boxes belong to other components.</p>`;
    return;
  }
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

// ---------------------------------------------------------------- dashboards (Build / Improve)
function renderSpecial() { const el = $('#special'); if (A.active === 'special:setup') return renderSetup(); if (A.active === 'special:codemap') return renderCodemap(); if (A.active === 'special:canvas') return renderCanvasView(); if (A.active === 'special:deployment') return renderDeployment(); if (A.active === 'special:topology') return renderTopology(); if (A.active === 'special:work') return renderWork(); if (A.active === 'special:compare') return renderCompare(); el.innerHTML = A.active === 'special:build' ? buildDash() : improveDash(); }

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
    onAsk: (question) => askTutor(question),
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
// Agent topology: read-only. The agents, what they call and who calls them, with tool effect and approval on each edge.
const TOPO_EFFECT = { irreversible: 'var(--err)', write: 'var(--warn)', read: 'var(--ink3)' };
function topologySidebar() {
  const t = Core.agentTopology(A.model);
  const rows = t.nodes.filter(n => n.agent).map(n => `<div class="item" data-topo="${esc(n.id)}"><div class="l1"><span class="id">${esc(n.name)}</span>${n.autonomy ? `<span class="tag">${esc(n.autonomy)}</span>` : ''}</div><div class="l2">${n.pattern ? esc(n.pattern) : 'pattern not declared'}</div></div>`).join('');
  return section('agents', `Agents (${t.agents})`, rows || '<div class="hint">No element is tagged Agent or declares d.agent.autonomy.</div>') +
    '<div class="hint">Read-only. Red edges are irreversible calls with no human approval. Edit the model in the Design view.</div>';
}
function renderTopology() {
  const el = $('#special'), t = Core.agentTopology(A.model);
  if (!t.agents) { el.innerHTML = '<div class="note">No element in this model is an agent. Give one the Agent tag or d.agent.autonomy in the Design view to see who it calls and who approves.</div>'; return; }
  const sub = { elements: new Map(t.nodes.map(n => [n.id, { ...A.model.elements.get(n.id), parent: null }])), rels: t.edges.map(e => A.model.rels.find(r => r.id === e.id)) };
  const by = new Map(t.edges.map(e => [e.id, e])), nodeBy = new Map(t.nodes.map(n => [n.id, n]));
  const L = layout(sub), zoom = 1;
  const edgeLabel = e => [e.description, e.effect].filter(Boolean).join(' · ');
  const svg = drawModel(sub, L, {
    attr: 'tp', zoom,
    edgeStyle: r => { const e = by.get(r.id); return { color: e.unguarded ? 'var(--err)' : TOPO_EFFECT[e.effect] || 'var(--ink3)', width: e.unguarded ? 2.4 : 1.4, dash: e.approval === 'human' ? '' : e.approval === 'policy' ? '6 4' : '', marker: e.unguarded ? 'error' : 'n', labelColor: e.unguarded ? 'var(--err)' : null, label: edgeLabel(e) }; },
    nodeStyle: n => { const x = nodeBy.get(n.id); return { stroke: 'var(--ink)', sw: x.agent ? 2.2 : 1.2, badge: x.agent ? (x.pattern || 'no pattern') : null, badgeColor: x.agent && !x.pattern ? 'var(--warn)' : 'var(--accent)' }; },
  });
  const table = `<table class="tp-table"><tr><th>From</th><th>To</th><th>Call</th><th>Effect</th><th>Approval</th></tr>${t.edges.map(e => `<tr class="${e.unguarded ? 'bad' : ''}"><td>${esc(nodeBy.get(e.src).name)}</td><td>${esc(nodeBy.get(e.dst).name)}</td><td>${esc(e.description)}</td><td>${esc(e.effect || '–')}</td><td>${esc(e.approval || '–')}${e.unguarded ? ' · unguarded' : ''}</td></tr>`).join('')}</table>`;
  el.innerHTML = `<div class="dp"><h2>Agent topology</h2><div class="note">${plural(t.agents, 'agent')}, ${plural(t.edges.length, 'call')}${t.unguarded ? `, ${t.unguarded} irreversible without human approval` : ''}. Solid line: human approval. Dashed: policy approval. Red: irreversible with no human approval.</div><div style="overflow:auto">${svg}</div>${table}</div>`;
  el.querySelectorAll('.node').forEach(g => g.addEventListener('click', () => { const e = A.model.elements.get(g.dataset.tp); if (e) openFile(A.cfg.model, e.line); }));
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
// Forecast against actual per frozen handover, newest first. The forecast is the one frozen into handover.yaml;
// the actual is every `task` event naming the handover, final once a `handover_closed` event exists.
function summaryFor(h) {
  return Core.forecastSummary({ id: h.id, created: h.created, requirements: h.requirements || [], forecast: h.forecast || null, actual: Ledger.handoverActuals(A.ledgerRaw, h.id) });
}
function handoversBlock() {
  const list = A.handovers.slice().reverse();
  if (!list.length) return '';
  const rows = list.map(h => {
    const f = h.forecast, a = Ledger.handoverActuals(A.ledgerRaw, h.id), cur = (f && f.currency) || A.cfg.currency || 'GBP';
    const m = n => `${esc(cur)} ${n.toFixed(2)}`;
    const diff = f && a.tasks ? `${a.tokens - f.tokens.expected >= 0 ? '+' : '-'}${fmtN(Math.abs(a.tokens - f.tokens.expected))}` : '';
    const state = a.closed ? `<span class="tag ${a.closed === 'delivered' ? 'pass' : 'fail'}">${esc(a.closed)}</span>` : `<span class="tag open">in progress</span>`;
    const act = a.closed ? '' : `<button class="btn" data-hvclose="${esc(h.id)}" data-outcome="delivered">Close as delivered</button> <button class="btn" data-hvclose="${esc(h.id)}" data-outcome="abandoned">Abandon</button>`;
    return `<tr><td><span class="id">${esc(h.id)}</span></td><td class="num">${f ? `${fmtN(f.tokens.expected)} <span style="color:var(--fg3)">up to ${fmtN(f.tokens.high)}</span>` : '<span style="color:var(--fg3)">not recorded</span>'}</td><td class="num">${f ? `${m(f.cost.expected)}` : ''}</td><td>${f ? esc(`${f.coverage.priced} of ${f.coverage.changed}`) : ''}</td><td class="num">${a.tasks ? fmtN(a.tokens) : 'n/a'}</td><td class="num">${a.tasks ? m(a.cost) : ''}</td><td class="num">${diff}</td><td>${state}${a.afterClose ? ` <span class="tag open">${esc(plural(a.afterClose, 'task'))} after close</span>` : ''}</td><td>${act} <button class="btn" data-hvcopy="${esc(h.id)}">Copy summary</button></td></tr>`;
  }).join('');
  return `<div class="block"><h3>Handovers: forecast against actual</h3><div class="note">The forecast is frozen with the handover and priced from past spend on the elements it changes; an element needs ${esc(String((A.cfg.forecast || {}).minSamples || 3))} past handovers to count. The actual is every task recorded against the handover, reruns and failures included, and is final once the handover is closed.</div><div class="tw2"><table class="t"><tr><th>Handover</th><th class="num">Forecast tokens</th><th class="num">Forecast cost</th><th>Elements priced</th><th class="num">Actual tokens</th><th class="num">Actual cost</th><th class="num">Difference</th><th>State</th><th></th></tr>${rows}</table></div></div>`;
}
const LIVE_RUN_TAG = { running: 'open', succeeded: 'pass', failed: 'fail', parked: 'open', cancelled: 'open' };
const runSpan = ms => (ms == null ? '' : ms < 60000 ? `${Math.round(ms / 1000)} s` : ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`);
// Build's Runs: what a pipeline said about each run (run_started, run_ended) and its handover's tasks since it started.
// A task's usage, one entry per model it used: "frontier 1 · 84k, standard 2 · 134k", the model on hover.
function usageCell(usage) {
  return usage.map(u => `<span title="${esc(u.model)}">${esc(`${u.tier || u.model} ${u.turns} · ${fmtN((u.tokens_in || 0) + (u.tokens_out || 0))}`)}</span>`).join(', ');
}
// A run's spend per tier, with its share of the run's tokens and, when the pipeline reports it, its input split into cache reads, cache writes and uncached.
function runUsageNote(usage) {
  if (!usage || !usage.length) return '';
  const all = usage.reduce((a, u) => a + u.tokens, 0);
  const cached = u => (u.cache_read || u.cache_write ? `, input ${fmtN(u.tokens_in)}: cache read ${fmtN(u.cache_read)}, cache write ${fmtN(u.cache_write)}, uncached ${fmtN(u.tokens_in - u.cache_read - u.cache_write)}` : '');
  return `<div class="note">By tier: ${usage.map(u => `<span title="${esc(u.models.join(', '))}">${esc(`${u.tier} ${plural(u.turns, 'turn')} · ${fmtN(u.tokens)}${all ? ` (${Math.round(100 * u.tokens / all)}%${cached(u)})` : cached(u)}`)}</span>`).join(', ')}</div>`;
}
function runsBlock() {
  const runs = Ledger.liveRuns(A.ledger).slice(0, 5);
  if (!runs.length) return '';
  return `<div class="block" id="buildRuns"><h3>Runs</h3><div class="note">Reported by the pipeline as it works. A run with no end is shown as running; if the pipeline stopped without saying so, it stays that way.</div>${runs.map(r => {
    const done = r.tasks.filter(t => t.status === 'passed').length;
    const head = `<div class="runhead"><span class="id">${esc(r.run)}</span> · handover <span class="code">${esc(r.handover)}</span> · <span class="tag ${LIVE_RUN_TAG[r.status] || 'open'}">${esc(r.status)}</span>${r.started != null ? ` · started ${esc(new Date(r.started).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}` : ''} ${esc(runSpan(r.ms))}${r.tasks.length ? ` · ${esc(`${done} of ${plural(r.tasks.length, 'task')} passed`)}` : ''}</div>${r.reason ? `<div class="note">${esc(r.reason)}</div>` : ''}${runUsageNote(r.usage)}`;
    const rows = r.tasks.map(t => `<tr><td><span class="id">${esc(t.task)}</span> ${esc(t.title || '')}</td><td>${esc(elementLabel(t.element))}</td><td><span class="tag ${t.status === 'passed' ? 'pass' : t.status === 'failed' ? 'fail' : 'open'}">${esc(t.status)}</span></td><td>${t.usage && t.usage.length ? usageCell(t.usage) : esc(t.tier || '')}</td><td class="num">${t.tokens ? fmtN(t.tokens) : ''}</td></tr>`).join('');
    return head + (rows ? `<div class="tw2"><table class="t"><tr><th>Task</th><th>Element</th><th>Status</th><th>Tier</th><th class="num">Tokens</th></tr>${rows}</table></div>` : '<div class="note">No task reported yet.</div>');
  }).join('')}</div>`;
}
async function closeHandover(id, outcome) {
  if (!confirm(`Close ${id} as ${outcome}? The actual spend becomes final and later tasks are flagged as after close.`)) return;
  await recordEvent('handover_closed', { handover: id, outcome });
  toast(`${id} closed as ${outcome}.`);
}
function buildDash() {
  const L = A.ledger, tasks = L.filter(e => e.kind === 'task'), passed = tasks.filter(t => t.status === 'passed');
  const tokens = tasks.reduce((a, t) => a + Ledger.totalTokens(t), 0), reruns = tasks.reduce((a, t) => a + (t.reruns || 0), 0);
  const taskCosts = tasks.map(t => t.cost).filter(c => typeof c === 'number');
  const totalCost = taskCosts.length ? taskCosts.reduce((a, c) => a + c, 0) : null;
  const needs = L.filter(e => e.kind === 'needs_decision');
  let h = `<div class="dash"><h1>Build</h1><p class="lede">What the coding pipeline did with the handed-over design, from <span class="code">ledger/*.jsonl</span>. The checks are the decisions' own checks, so a failure here is a design question, not only a red build.</p>`;
  h += runsBlock();
  h += telemetryBlock();
  if (L.some(e => e.sample)) h += `<span class="samplenote">Includes sample events from ledger/pipeline.jsonl</span>`;
  if (!L.length) return h + `<div class="block"><h3>No pipeline events yet</h3><div class="note">The pipeline appends one JSON object per line to <span class="code">ledger/*.jsonl</span>, each with a <span class="code">kind</span>: run_started, run_ended, task, check, needs_decision, asbuilt_edge, escape or false_positive. This view updates as the files change.</div></div></div>`;
  h += `<div class="stats"><div class="stat"><div class="v">${passed.length ? fmtN(tokens / passed.length) : 'n/a'}</div><div class="l">Tokens per passing task</div></div><div class="stat"><div class="v">${passed.length} of ${tasks.length}</div><div class="l">Tasks passed</div></div><div class="stat"><div class="v">${tasks.length ? (reruns / tasks.length).toFixed(1) : '0'}</div><div class="l">Reruns per task</div></div><div class="stat"><div class="v">${needs.filter(n => n.status === 'open').length}</div><div class="l">Waiting on a decision</div></div>${totalCost != null ? `<div class="stat"><div class="v">${money(totalCost)}</div><div class="l">Total task cost</div></div>` : ''}</div>`;
  h += handoversBlock();
  const decs = A.decisions.filter(d => d.status === 'bound' || Core.latestCheck(L, d.id));
  h += `<div class="grid2"><div class="block"><h3>Decision checks</h3>${decs.length ? `<div class="tw2"><table class="t"><tr><th>Decision</th><th>Check</th><th>Latest</th></tr>${decs.map(d => `<tr><td><span class="id">${esc(d.id)}</span> ${esc(trunc(d.statement || '', 56))}</td><td><span class="code">${esc((d.checks || [])[0] || '')}</span></td><td>${latestTag(d.id)}</td></tr>`).join('')}</table></div>` : '<div class="note">No bound decisions have results yet.</div>'}</div>`;
  h += `<div class="block"><h3>Waiting on a decision</h3>${needs.length ? `<div class="tw2"><table class="t"><tr><th>Item</th><th>Question</th><th>Status</th></tr>${needs.map(n => `<tr><td><span class="id">${esc(n.id)}</span><div style="color:var(--fg3)">${esc(n.task || '')} · ${esc(elementLabel(n.element))}</div></td><td>${esc(n.question)}${n.status === 'open' ? ndOptionsHtml(n.id) : ''}</td><td><span class="tag ${n.status === 'open' ? 'open' : 'pass'}">${esc(n.status)}</span>${n.resolution ? `<div style="color:var(--fg3)">${esc(ndAnswerText(n.resolution))}</div>` : ''}</td></tr>`).join('')}</table></div>` : '<div class="note">Nothing is blocked.</div>'}</div></div>`;
  const acFail = [...L.filter(e => e.kind === 'ui_acceptance_failed').reduce((m, e) => m.set(`${e.task}\0${e.ac}`, e), new Map()).values()];
  if (acFail.length) h += `<div class="block"><h3>UI acceptance failures</h3><div class="tw2"><table class="t"><tr><th>Criterion</th><th>Element</th><th>Task</th><th>Commit</th></tr>${acFail.map(f => `<tr><td><span class="id">${esc(f.ac)}</span></td><td>${esc(elementLabel(f.element))}</td><td>${esc(f.task)}</td><td><span class="code">${esc(String(f.commit).slice(0, 7))}</span>${f.trace_id ? ` · trace ${esc(f.trace_id)}` : ''}</td></tr>`).join('')}</table></div><div class="note">Reported by the pipeline. The spec is generated from the criterion, so fix the code, not the spec.</div></div>`;
  const byEl = new Map(); for (const t of tasks) { const k = elementLabel(t.element) || 'unassigned'; if (!byEl.has(k)) byEl.set(k, []); byEl.get(k).push(t); }
  const names = new Set(A.model ? [...A.model.elements.values()].map(e => e.name) : []);
  h += `<div class="block"><h3>Tasks by element</h3><div class="tw2"><table class="t"><tr><th>Element</th><th class="num">Tasks</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Reruns</th><th class="num">Tokens</th><th class="num">Tokens per pass</th></tr>${[...byEl].map(([el, ts]) => { const p = ts.filter(t => t.status === 'passed').length, tk = ts.reduce((a, t) => a + Ledger.totalTokens(t), 0); return `<tr><td>${esc(el)}${names.has(el) || el === 'unassigned' ? '' : ' <span class="tag open">not in design</span>'}</td><td class="num">${ts.length}</td><td class="num">${p}</td><td class="num">${ts.filter(t => t.status === 'failed').length}</td><td class="num">${ts.reduce((a, t) => a + (t.reruns || 0), 0)}</td><td class="num">${fmtN(tk)}</td><td class="num">${p ? fmtN(tk / p) : 'n/a'}</td></tr>`; }).join('')}</table></div></div>`;
  const dr = A.drift || (A.model && A.model.elements.size ? Core.drift(A.model, L) : null);
  h += `<div class="block"><h3>As built vs designed</h3>${!dr ? '<div class="note">No asbuilt_edge events yet.</div>' : (!dr.undeclared.length && !dr.unrealised.length && !dr.unknownEls.length) ? '<div class="note">No drift.</div>' : `<div class="tw2"><table class="t"><tr><th>Drift</th><th>Detail</th></tr>${dr.undeclared.map(d => `<tr><td><span class="code warning">DC100</span> Undeclared dependency</td><td>${esc(d.from)} → ${esc(d.to)} is in code but not in the design</td></tr>`).join('')}${dr.unknownEls.map(n => `<tr><td><span class="code warning">DC102</span> Not in design</td><td>${esc(n)} appears in code only</td></tr>`).join('')}${dr.unrealised.map(d => `<tr><td><span class="code">DC101</span> Not built yet</td><td>${esc(d.from)} → ${esc(d.to)} is designed but not in code</td></tr>`).join('')}</table></div>`}</div>`;
  const order = { failed: 0, blocked: 1, running: 2, passed: 3 };
  h += `<div class="block"><h3>Tasks</h3><div class="tw2"><table class="t"><tr><th>Task</th><th>Element</th><th>Status</th><th class="num">Reruns</th><th class="num">Turns</th><th class="num">Tokens</th><th>Model</th></tr>${tasks.slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)).map(t => `<tr><td><span class="id">${esc(t.task || '')}</span> ${esc(t.title || '')}</td><td>${esc(elementLabel(t.element))}</td><td><span class="tag ${t.status === 'passed' ? 'pass' : t.status === 'failed' ? 'fail' : 'open'}">${esc(t.status)}</span></td><td class="num">${t.reruns || 0}</td><td class="num">${t.turns || ''}</td><td class="num">${fmtN(Ledger.totalTokens(t))}</td><td>${esc(t.model || '')}</td></tr>`).join('')}</table></div></div></div>`;
  return h;
}
function ledgerIntegrityHtml() {
  const r = Ledger.verify(A.ledgerFiles, { handovers: A.handovers.map(h => h.id), decisions: A.decisions.map(d => ({ id: d.id, kind: d.kind, effect: d.effect, checks: d.checks })), handoverEvals: Object.fromEntries(A.handovers.filter(h => h.evals && typeof h.evals === 'object').map(h => [h.id, h.evals])) });
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
  if (sug.length) h += `<div class="block"><h3>Suggested by telemetry</h3><div class="note">Pipeline tasks that needed three or more attempts, failed, or escalated. Recording one makes it an escape you can classify.</div><div class="tw2"><table class="t"><tr><th>Task</th><th>Element</th><th>Why</th><th class="num">Tokens</th><th>Last error</th><th></th></tr>${sug.map(t => `<tr><td><span class="id">${esc(t.task)}</span></td><td>${esc(elementLabel(t.element))}</td><td>${esc(t.why)}</td><td class="num">${fmtN(t.tokens)}</td><td>${esc((t.runs.filter(r => r.firstError).pop() || {}).firstError || '')}</td><td><button class="btn" data-telesc="${esc(t.task)}">Record as escape</button></td></tr>`).join('')}</table></div></div>`;
  if (escapes.length) h += `<div class="block"><h3>Escapes</h3><div class="tw2"><table class="t"><tr><th>When</th><th>Where</th><th>What happened</th><th>Should have been caught by</th><th>Origin</th></tr>${escapes.slice().sort((a, b) => (b._ts || 0) - (a._ts || 0)).map(e => `<tr><td>${when(e.ts)}</td><td>${esc(e.element || '')}</td><td>${esc(e.description || '')}${e.code ? ` <span class="code">${esc(e.code)}</span>` : ''}</td><td><select class="inline" data-classify="${esc(e.id)}"><option value="">Not classified</option>${STAGES.map(([k, l]) => `<option value="${k}" ${e.caught_by === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td><td><select class="inline" data-origin="${esc(e.id)}" aria-label="Origin of ${esc(e.id)}"><option value="">Not classified</option>${Ledger.ORIGINS.map(o => `<option value="${o}" ${e.origin === o ? 'selected' : ''}>${ORIGIN_LABEL[o]}</option>`).join('')}</select></td></tr>`).join('')}</table></div></div>`;
  h += escapeMetricsHtml(L);
  h += failureModesHtml() + otherRegistriesHtml() + factoryTasksHtml() + calibrationHtml();
  const acts = Ledger.agentActivity(L), unap = Ledger.unapprovedChanges(L);
  if (acts.length) h += `<div class="block"><h3>Agent activity</h3><div class="note">What agents did through designc, from <code>ledger/agents.jsonl</code>. Declined means a person said no to a write. Unapproved means a registry file changed during an agent turn without an approval.</div><div class="tw2"><table class="t"><tr><th>Agent</th><th>Role</th><th>Via</th><th class="num">Turns</th><th class="num">Tokens</th><th class="num">Tool calls</th><th class="num">Asked</th><th class="num">Declined</th><th class="num">Denied</th><th class="num">Permissions</th><th class="num">Approvals</th><th class="num">Unapproved</th><th>Last</th></tr>${acts.map(r => `<tr><td>${esc(r.agent)}</td><td>${esc(r.role)}</td><td>${esc(r.via || '')}</td><td class="num">${fmtN(r.turns)}</td><td class="num">${fmtN(r.tokens)}</td><td class="num">${fmtN(r.tools)}</td><td class="num">${fmtN(r.asked)}</td><td class="num">${fmtN(r.declined)}</td><td class="num">${fmtN(r.denied)}</td><td class="num">${fmtN(r.permissions)}</td><td class="num">${fmtN(r.approvals)}</td><td class="num">${r.unapproved ? `<b>${fmtN(r.unapproved)}</b>` : '0'}</td><td>${esc(when(r.last))}</td></tr>`).join('')}</table></div></div>`;
  const trends = Ledger.evalTrends(L);
  if (trends.length) h += `<div class="block"><h3>Agent evals</h3><div class="note">Every recorded result, from <code>ledger/checks.jsonl</code>. Change is against the run before the latest.</div><div class="tw2"><table class="t"><tr><th>Eval</th><th>Agent</th><th class="num">Runs</th><th class="num">Passed</th><th>Latest</th><th>Metrics</th></tr>${trends.map(r => `<tr><td><span class="id">${esc(r.eval)}</span></td><td>${esc(r.agent)}</td><td class="num">${fmtN(r.runs)}</td><td class="num">${fmtN(r.passed)}</td><td>${esc(r.latest.outcome)} · ${esc(r.latest.source)} · ${esc(when(r.latest.ts))}</td><td>${Object.entries(r.metrics).map(([k, m]) => `${esc(k)} ${esc(String(m.latest))}${m.change === null ? '' : ` (${m.change > 0 ? '+' : ''}${esc(String(+m.change.toFixed(4)))})`}`).join(', ')}</td></tr>`).join('')}</table></div></div>`;
  h += suiteRunsHtml(L);
  if (unap.length) h += `<div class="block"><h3>Unapproved changes</h3><div class="tw2"><table class="t"><tr><th>When</th><th>Agent</th><th>Role</th><th>File</th></tr>${unap.slice().sort((a, b) => (b._ts || 0) - (a._ts || 0)).map(e => `<tr><td>${esc(when(e._ts))}</td><td>${esc(e.agent)}</td><td>${esc(e.role)}</td><td>${esc(e.path)}</td></tr>`).join('')}</table></div></div>`;
  h += ledgerIntegrityHtml();
  h += `<div class="block"><h3>Proposals</h3>${A.proposals.length ? `<div class="tw2"><table class="t"><tr><th>Proposal</th><th>Kind</th><th>Change</th><th>Evidence</th><th>How we'll know</th><th>Status</th><th></th></tr>${A.proposals.map(p => `<tr data-open="${esc(p._path)}" style="cursor:pointer"><td><span class="id">${esc(p.id)}</span></td><td>${esc(p.kind || '')}</td><td>${esc(p.statement || '')}</td><td>${esc(p.evidence || '')}</td><td>${p.check ? esc(p.check) : '<span style="color:var(--err)">no check</span>'}</td><td><span class="tag ${esc(p.status || 'minted')}">${esc(p.status || 'minted')}</span></td><td>${propDeletable(p) ? `<button class="lnk" data-delfile="${esc(p._path)}" title="Delete this proposal file">Delete</button>` : ''}</td></tr>`).join('')}</table></div>` : '<div class="note">No proposals yet. Each should cite an escape and say how you will know the change works.</div>'}</div></div>`;
  return h;
}

// Factory evals: suite runs recorded by an eval harness through `designc record` (ledger/factory.jsonl).
const pct = x => (x === null ? '—' : `${Math.round(x * 100)}%`);
const TRIAL_TAG = { pass: 'pass', fail: 'fail', incomplete: 'checked', harness: 'warning' };
const RUN_TAG = { running: 'checked', completed: 'pass', aborted: 'fail' };
// A Langfuse trace link needs the project id, which only comes back with telemetry; without it the id is shown as text.
function traceUrl(id) {
  const base = ((A.cfg.langfuse || {}).baseUrl || '').replace(/\/$/, ''), run = A.tel.runs.find(r => r.projectId);
  return id && base && run ? `${base}/project/${encodeURIComponent(run.projectId)}/traces/${encodeURIComponent(id)}` : null;
}
// A score change in percentage points, signed; the class colours it.
const pts = x => (x === null || x === undefined ? '—' : `<span class="delta ${x > 0 ? 'up' : x < 0 ? 'down' : ''}">${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(Math.round(x * 100))} pts</span>`);
const TASK_CMP = { changed: 'Task edited since the baseline, not compared', new: 'New task, not in the baseline', unscored: 'No judged trial on one side' };
function suiteRunsHtml(L) {
  const k = ((A.cfg.factory || {}).k) || 3, all = Ledger.suiteRuns(L, { k });
  if (!all.length) return '';
  const cmp = Ledger.suiteCompare(all), byId = new Map(all.map(r => [r.suite_run_id, r]));
  const trialChip = x => {
    const url = traceUrl(x.trace_id), title = `Trial ${x.trial}: ${x.outcome}${Object.keys(x.gates).length ? ' · ' + Object.entries(x.gates).map(([g, v]) => `${g} ${v}`).join(', ') : ''}${Object.keys(x.gradients).length ? ' · ' + Object.entries(x.gradients).map(([g, v]) => `${g} ${v}`).join(', ') : ''}${x.trace_id ? ' · trace ' + x.trace_id : ''}`;
    const gradFails = Object.values(x.gradients).filter(v => v === 'fail').length;
    const chip = `<span class="tag ${TRIAL_TAG[x.outcome]}" title="${esc(title)}">#${x.trial} ${esc(x.outcome)}${gradFails ? ` · ${plural(gradFails, 'gradient')} failed` : ''}</span>`;
    return url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${chip}</a>` : chip;
  };
  const taskCmp = (c, id) => { const x = c.tasks[id]; if (!c.baseline || !x) return '—'; return x.status === 'compared' ? `${pts(x.passAt1)} / ${pts(x.passK)}` : `<span class="note-i">${esc(TASK_CMP[x.status])}</span>`; };
  const change = (r, c) => {
    const rep = c.repeatOf ? ` <span class="tag" title="${esc(`Same harness version as the run started ${when(byId.get(c.repeatOf).started)}`)}">repeat</span>` : '';
    if (!c.baseline) return `<span class="note-i">First version</span>${rep}`;
    const vs = `vs <span class="code">${esc(c.baselineVersion)}</span>`;
    if (!c.compared) return `<span class="note-i">No task to compare ${vs}</span>${rep}`;
    return `${pts(c.passAt1)} pass@1 · ${pts(c.passK)} pass^${k} ${vs} <span class="note-i">(${plural(c.compared, 'task')})</span>${rep}`;
  };
  const detail = (r, c) => `<tr><td colspan="10"><div class="tw2"><table class="t"><tr><th>Eval task</th><th>Trials</th><th class="num">pass@1</th><th class="num">pass^${k}</th><th>Change (pass@1 / pass^${k})</th><th>Gates</th><th>Gradients</th></tr>${r.tasks.map(t => `<tr><td><span class="id">${esc(t.task_id)}</span></td><td>${t.trials.map(trialChip).join(' ')}</td><td class="num">${pct(t.passAt1)}</td><td class="num">${pct(t.passK)}</td><td>${taskCmp(c, t.task_id)}</td><td>${esc(t.gates.join(', '))}</td><td>${esc(t.gradients.join(', '))}</td></tr>`).join('')}</table></div>${c.dropped.length ? `<div class="note">Not in this run but in the baseline: ${c.dropped.map(esc).join(', ')}.</div>` : ''}${r.stray ? `<div class="note">${plural(r.stray, 'grader event')} named a task, trial or grader this run did not declare and were left out.</div>` : ''}${r.finished && r.finished.reason ? `<div class="note">Aborted: ${esc(r.finished.reason)}</div>` : ''}</td></tr>`;
  const suites = [...new Set(all.map(r => r.suite))];
  const table = suite => `<h4 class="su-h">${esc(suite)}</h4><div class="tw2"><table class="t"><tr><th>Started</th><th>Harness</th><th>Model</th><th>Prompt</th><th class="num">pass@1</th><th class="num">pass^${k}</th><th>Change</th><th class="num">Every trial passed</th><th>Trials</th><th>Status</th></tr>${all.filter(r => r.suite === suite).reverse().map(r => {
    const open = A.suiteOpen.has(r.suite_run_id), c = cmp.get(r.suite_run_id);
    return `<tr data-suite="${esc(r.suite_run_id)}" style="cursor:pointer"><td>${open ? '▾' : '▸'} ${esc(when(r.started))}</td><td><span class="code">${esc(r.harness_version)}</span></td><td>${esc(r.model)}</td><td>${esc(r.prompt_version)}</td><td class="num">${pct(r.passAt1)}</td><td class="num">${pct(r.passK)}</td><td>${change(r, c)}</td><td class="num">${r.allPassed} of ${r.tasks.length}</td><td>${['pass', 'fail', 'harness', 'incomplete'].filter(o => r.counts[o]).map(o => `<span class="tag ${TRIAL_TAG[o]}">${r.counts[o]} ${o}</span>`).join(' ')}</td><td><span class="tag ${RUN_TAG[r.status]}">${esc(r.status)}</span></td></tr>${open ? detail(r, c) : ''}`;
  }).join('')}</table></div>`;
  return `<div class="block"><h3>Suite runs</h3><div class="note">Eval harness runs of the Build pipeline, from <code>ledger/factory.jsonl</code>, by suite, newest first. A trial passes when every gate grader passed. Harness means the run finished before a gate reported, so the harness failed, not the agent; it is left out of pass@1. pass^${k} is pass@1 to the power ${k}, averaged over eval tasks. Change compares each run with the latest earlier run on a different harness version, only over eval tasks whose hash is unchanged and judged on both sides; a repeat is a run on a harness version already run. Click a run to see its trials; hover a trial for each grader's verdict. Gradients are shown but never decide a trial.</div>${suites.map(table).join('')}</div>`;
}

// ---------------------------------------------------------------- events
document.addEventListener('click', async e => {
  const t = e.target.closest('button, input[data-a], [data-file], [data-dir], [data-open], [data-tab], [data-clause], [data-toggle], [data-code], [data-cmsel], [data-dppick], [data-suite], .node, [data-s]'); if (!t) return;
  const d = t.dataset;
  if (d.suite) { A.suiteOpen.has(d.suite) ? A.suiteOpen.delete(d.suite) : A.suiteOpen.add(d.suite); return renderSpecial(); }
  if (d.dppick) return pickDeployment(d.dppick);
  if (d.close) { e.stopPropagation(); closeTab(d.close); return; }
  if (d.tab) return activate(d.tab);
  if (d.toggle && !e.target.closest('.acts')) { A.collapsed.has(d.toggle) ? A.collapsed.delete(d.toggle) : A.collapsed.add(d.toggle); renderSidebar(); return; }
  if (d.dir) { A.expanded.has(d.dir) ? A.expanded.delete(d.dir) : A.expanded.add(d.dir); renderSidebar(); return; }
  if (d.delfile) { e.stopPropagation(); return deleteFile(d.delfile); }
  if (d.file) return openFile(d.file);
  if (d.askfi) { e.stopPropagation(); const f = A.diags[+d.askfi]; return f && askTutor(`Explain finding ${f.code} on ${f.loc.label}: "${f.msg}". Why does it matter, and what does a good answer look like?`); }
  if (d.fixfi) { e.stopPropagation(); return decisionForFinding(A.diags[+d.fixfi]); }
  if (d.accfi) { e.stopPropagation(); return acceptRisk(A.diags[+d.accfi]); }
  if (d.bind) { e.stopPropagation(); return bindDecision(A.decisions.find(x => x.id === d.bind)); }
  if (d.topo) { const e = A.model.elements.get(d.topo); if (e) openFile(A.cfg.model, e.line); return; }
  if (d.review) { e.stopPropagation(); return reviewAssumptions(A.decisions.find(x => x.id === d.review)); }
  if (d.run) { e.stopPropagation(); return runChecks(A.decisions.filter(x => x.id === d.run)); }
  if (d.qdraft) { const q = A.grill.questions[+d.qdraft]; return recordDecision({ statement: q.suggested_decision || '', effect: q.suggested_effect === 'accept' ? 'accept' : 'fix', binds: q.element ? [q.element] : [], resolves: /^DC\d{3}$/.test(q.code || '') ? [q.code] : [], checks: q.suggested_check ? [q.suggested_check] : [], rationale: `${q.question} Answer: ${q.answer || ''}` }); }
  if (d.qdk) { const q = A.grill.questions[+d.qdk]; return dontKnow(q.question || '', q.why || ''); }
  if (d.qbiz) { const q = A.grill.questions[+d.qbiz]; return recordDecision({ kind: 'business', statement: q.suggested_decision || q.question || '', effect: 'accept', binds: [], resolves: [], rationale: `${q.question} Answer: ${q.answer || ''}` }); }
  if (d.ndans) return answerNeedsDecision(A.ledger.find(x => x.kind === 'needs_decision' && x.id === d.ndans));
  if (d.telesc) {
    const t = telAgg().tasks.get(d.telesc); if (!t) return;
    const id = Ledger.escapeId(crypto.randomUUID());
    const err = (t.runs.filter(r => r.firstError).pop() || {}).firstError;
    await recordEvent('escape', { id, element: designNameFor(t.element) || t.element || null, task: t.task,
      description: `${t.task}: ${t.runs.length} attempt${t.runs.length === 1 ? '' : 's'}, last ${t.final}${err ? ` (${err})` : ''}`, source: 'langfuse', traces: t.runs.map(r => r.traceId) });
    toast(`Recorded ${id}. Classify it in Improve.`); return;
  }
  if (d.bindtask) { e.stopPropagation(); return bindFactoryTask(d.bindtask); }
  if ('regsRefresh' in d) return loadRegistries();
  if (d.ndres) { e.stopPropagation(); return resolveNd(d.ndres); }
  if (d.ndopt) { e.stopPropagation(); return chooseNdOption(d.ndopt, d.opt); }
  if (d.runeval) return runEvals(d.runeval);
  if (d.mapreq) { e.stopPropagation(); return mapRequirement(d.mapreq); }
  if (d.allowhost) { e.stopPropagation(); return allowEvidenceHost(d.allowhost); }
  if (d.owner) { e.stopPropagation(); return becomeBusinessOwner(A.decisions.find(x => x.id === d.owner)); }
  if (d.addevidence) { e.stopPropagation(); return addEvidence(A.decisions.find(x => x.id === d.addevidence)); }
  if (d.relyon) { e.stopPropagation(); return chooseBusinessDecision(A.decisions.find(x => x.id === d.relyon)); }
  if (d.hvclose) return closeHandover(d.hvclose, d.outcome);
  if (d.hvcopy) { const h = A.handovers.find(x => x.id === d.hvcopy); if (!h) return; try { await navigator.clipboard.writeText(summaryFor(h)); toast('Summary copied.'); } catch { toast('Could not copy. Select the text in the Output panel instead.', 'warning'); } return; }
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
    if (d.s === 'llm') return Setup.llmReady(A.cfg.llm) ? openFile('designc.json') : openSetup();
    if (d.s === 'tel') { if (A.tel.error && A.tel.error.error === 'not_configured') return openSetup(); if (A.tel.error) toast(telErrorText(A.tel.error), 'warning'); return loadTelemetry(); }
    if (d.s === 'folder') return setActivity('explorer');
  }
  if (d.panel) return showPanel(d.panel);
  if (d.act) return setActivity(d.act);
  const a = d.a;
  if (a === 'open') return host.openFolder();
  if (a === 'sample') { const i = await host.openSample(); return onFolder(i); }
  if (a === 'freeze') return freezeHandover();
  if (a === 'suggestcode') return suggestCodeAreas();
  if (a === 'dispatch') return dispatchHandover(d.id);
  if (a === 'rebindall') return rebindAll();
  if (a === 'newdec') return newDecision();
  if (a === 'newreq') return newRequirement();
  if (a === 'importreq') return importRequirements();
  if (a === 'newprop') return newProposal();
  if (a === 'runall') return runChecks();
  if (a === 'newscn') return newScenario();
  if (a === 'newacc') return newAcceptance();
  if (a === 'newtokens') return createAndOpen(TOKENS, TOKENS_STARTER, 1);
  if (a === 'runfit') return runFitness();
  if (a === 'neweval') return newEval();
  if (a === 'runevals') return runEvals();
  if (a === 'grill') return grill();
  if (a === 'lookseen') { keepDesignLook(); return renderSidebar(); }
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
  if (a === 'cmcontainer') return cmGo('component', d.id);
  if (a === 'ghost') { A.showGhost = t.checked; return drawCodemap(); }
  if (a === 'codemapopen') return setActivity('codemap');
  if (a === 'newtaxonomy') return createAndOpen(TAXONOMY, TAXONOMY_STARTER, 4);
  if (a === 'newmodel') return createAndOpen(A.cfg.model, `workspace "${A.root.name}" {\n  model {\n    \n  }\n}\n`, 3);
});
document.addEventListener('change', async e => {
  const d = e.target.dataset;
  if (d.classify) await recordEvent('escape_classified', { escape: d.classify, caught_by: e.target.value || null });
  if (d.origin) {
    const esc0 = A.ledger.find(x => x.kind === 'escape' && x.id === d.origin);
    await recordEvent('escape_classified', { escape: d.origin, caught_by: (esc0 && esc0.caught_by) || null, origin: e.target.value || null });
  }
  if (d.fmReg) await recordEvent('failure_mode_classified', { registry: d.fmReg, escape: d.fmEsc, failure_mode: e.target.value || null });
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
  if (el.kind === 'component') { if (cmHasCode()) { A.cmSel = null; return cmGo('code', id); } A.cmSel = id; return drawCodemap(); }
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
  if (cmd === 'panel:terminal') return A.panelOpen && A.panel === 'terminal' ? ($('#panelClose').click()) : showPanel('terminal');
  if (cmd === 'run-checks') return runChecks();
  if (cmd === 'grill') return grill();
  if (cmd === 'freeze') return freezeHandover();
  if (cmd === 'open-settings') return A.root && host.exists('designc.json').then(has => (has ? openFile('designc.json') : openSetup()));
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
  SU.draft = null;
  if (!(await host.exists('designc.json'))) await openSetup(); // a new folder starts at Set up
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
  A.user = info.user; A.recent = info.recent; A.platform = info.platform;
  A.model = Core.parse(''); A.diags = []; A.gate = Core.gate({ model: A.model, diags: [], decisions: [], requirements: [], ledger: [] });
  document.querySelectorAll('#activity button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.act === 'explorer')));
  if (info.root) await onFolder(info.root); else { activate(null); renderAll(); }
});
