'use strict';
// Headless core (intelligence plane phase 3): the registry read from disk with no Electron, for agents and pipelines.
// Reached as a Node module or through scripts/designc-core.js (--json). No MCP is needed; a wrapper may sit on top.
// Read-only on the registry: the only file it writes is the derived index (headless/store.js, .designc/index.sqlite).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');
const Ledger = require('../renderer/ledger.js');
const Records = require('../renderer/records.js');
const Verdicts = require('../renderer/verdicts.js');
const Memory = require('../renderer/memory.js');
const ProcLoop = require('../renderer/procloop.js');
const Knowledge = require('../renderer/knowledge.js');
const GateInputs = require('../renderer/gate-inputs.js');
const Work = require('../renderer/work.js');
const Paths = require('../paths.js');

const BUNDLE_SCHEMA = 'designc.context.bundle/1';
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function readYamlDir(dir, rel) {
  const d = path.join(dir, rel);
  if (!fs.existsSync(d)) return { recs: [], errors: [] };
  const recs = [], errors = [];
  for (const f of fs.readdirSync(d).filter(n => /\.ya?ml$/i.test(n)).sort()) {
    const p = `${rel}/${f}`;
    try {
      const text = fs.readFileSync(path.join(d, f), 'utf8');
      const rec = yaml.load(text);
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) recs.push({ rec, path: p, text });
      else errors.push({ path: p, msg: 'not a mapping' });
    } catch (e) { errors.push({ path: p, msg: `does not parse: ${String(e.message).split('\n')[0]}` }); }
  }
  return { recs, errors };
}

function readLedger(dir) {
  const d = path.join(dir, 'ledger');
  if (!fs.existsSync(d)) return { events: [], errors: [] };
  const events = [], errors = [];
  for (const f of fs.readdirSync(d).filter(n => n.endsWith('.jsonl')).sort()) {
    const r = Ledger.parse(fs.readFileSync(path.join(d, f), 'utf8'), `ledger/${f}`);
    events.push(...r.events); errors.push(...r.errors);
  }
  return { events: Ledger.order(events), errors };
}

// The registry as files say it is now, or, with handover, as that handover froze it (decisions, requirements and the
// model are read from its copies; verdicts, work items and the ledger always from the registry).
function open(dir, { handover = null } = {}) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { error: `no folder ${dir}` };
  let settings = {};
  const sp = path.join(dir, 'designc.json');
  if (fs.existsSync(sp)) { try { settings = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch (e) { return { error: `designc.json does not parse: ${e.message}` }; } }
  let base = dir, frozen = null;
  if (handover != null) {
    if (!SAFE_ID.test(handover) || handover.startsWith('.')) return { error: `handover id ${handover} is not a handover id` };
    base = path.join(dir, 'handovers', handover);
    const hy = path.join(base, 'handover.yaml');
    if (!fs.existsSync(hy)) return { error: `no handover ${handover} (handovers/${handover}/handover.yaml)` };
    try { frozen = yaml.load(fs.readFileSync(hy, 'utf8')) || {}; } catch (e) { return { error: `handovers/${handover}/handover.yaml does not parse: ${e.message}` }; }
  }
  const modelRel = (frozen && frozen.model) || settings.model || 'model/workspace.dsl';
  const mp = path.join(base, modelRel);
  const modelText = fs.existsSync(mp) ? fs.readFileSync(mp, 'utf8') : null;
  const model = modelText != null ? Core.parse(modelText, { path: modelRel, resolve: p => { try { return fs.readFileSync(path.join(base, p), 'utf8'); } catch { return null; } } }) : null;
  const decisions = readYamlDir(base, 'decisions');
  const requirements = readYamlDir(base, 'requirements');
  const verdicts = readYamlDir(dir, 'verdicts');
  const work = readYamlDir(dir, 'work');
  const procedures = readYamlDir(dir, 'procedures');
  const ledger = readLedger(dir);
  return {
    dir, settings, handover: frozen ? { id: handover, ...frozen } : null, modelText, model,
    revision: modelText != null ? Core.modelRevision(modelText, model.sources.slice(1)) : null,
    decisions: decisions.recs, requirements: requirements.recs, verdicts: verdicts.recs, procedures: procedures.recs, items: work.recs.map(r => r.rec),
    ledger: ledger.events,
    problems: [...decisions.errors, ...requirements.errors, ...verdicts.errors, ...procedures.errors, ...work.errors, ...ledger.errors],
  };
}

// Element refs by hierarchical id (System/Container/Component, the elements.json id) or by a name no other element
// shares (Core.resolveElement). null when the model is missing or the ref is unknown or ambiguous.
function resolver(reg) {
  if (!reg.model) return null;
  const m = reg.model;
  const f = ref => { const e = Core.resolveElement(m, ref); return e ? m.label(e.id) : null; };
  f.nameOf = id => { const e = Core.resolveElement(m, id); return e ? e.name : null; };
  return f;
}

function verdicts(reg, opts) {
  return Verdicts.query({ verdicts: reg.verdicts, items: reg.items }, { ...opts, resolve: resolver(reg) });
}

// Episodes (Memory.episodes) about the scope's elements, newest first: {episodes, summary} or {error}.
function episodes(reg, { work_item = null, elements = null, limit = 20 } = {}) {
  let els = elements;
  if (!els && work_item != null) {
    const it = reg.items.find(i => i && i.id === work_item);
    if (!it) return { error: `no work item ${work_item}` };
    els = list(it.elements).map(String);
  }
  if (!els || !els.length) return { error: 'name the elements: give elements or a work item' };
  const res = resolver(reg);
  const eps = Memory.recall(Memory.episodes(reg.ledger, { items: reg.items }), els, { resolve: res, limit: Number(limit) || 20 });
  return { episodes: eps, summary: Memory.summary(eps) };
}

const procedureStats = reg => Memory.procedureStats(Memory.episodes(reg.ledger, { items: reg.items }));

// System 3 (ProcLoop.review): each procedure file's version judged from the traces that were given it, plus problems
// in designc.json improve.procedures. Suggestions only.
function procedureReview(reg) {
  const s = ProcLoop.settings(reg.settings);
  return { ...ProcLoop.review({ procedures: reg.procedures || [], stats: procedureStats(reg), settings: s }), problems: s.problems };
}

// Canonical JSON: keys sorted at every level, no whitespace. The bundle id is the sha256 of the bundle without its id.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const list = v => v == null ? [] : Array.isArray(v) ? v : [v];
const live = r => !['superseded', 'retired'].includes(Records.status(r.rec.status));

// Context bundle (docs/context-bundle.schema.json): what a coding agent in one role needs for one task, built from
// files only, deterministic, so the same inputs give the same bundle_id. Elements come from the key, else the work
// item, else the handover's in_scope. Governance (which role may see what) belongs to mlang/ACS and is not applied
// here: governance is null until that interface exists. Procedures are the bound procedures/*.yaml whose scope names one of the
// elements, each with the {id, version, hash} a trace row echoes back (Memory.procedures).
function bundle(reg, { work_item = null, task = null, role = null, elements = null, jira = null, commit = null } = {}) {
  if (!role || !SAFE_ID.test(role)) return { error: 'role is required (letters, digits, ".", "_" or "-")' };
  let els = elements;
  if (!els && work_item != null) {
    const it = reg.items.find(i => i && i.id === work_item);
    if (!it) return { error: `no work item ${work_item}` };
    els = list(it.elements).map(String);
  }
  if (!els && reg.handover && Array.isArray(reg.handover.in_scope)) els = reg.handover.in_scope.map(String);
  if (!els) return { error: 'name the elements: give elements, a work item, or an item handover' };
  const res = resolver(reg);
  if (!res) return { error: 'the model is missing, so elements cannot be resolved' };
  const unknown = els.filter(n => !res(String(n)));
  if (unknown.length) return { error: `not elements of the model (give the id System/Container when a name is shared): ${unknown.join(', ')}` };
  els = [...new Set(els.map(n => res(String(n))))].sort();
  const elSet = new Set(els);
  const has = n => { const r = res(String(n)); return r != null && elSet.has(r); };
  const touches = rec => list(rec.binds).some(has) || list(rec.scope).some(s => typeof s === 'string' && s.startsWith('el:') && has(s.slice(3)));
  const asRef = s => { if (typeof s !== 'string' || !s.startsWith('el:')) return s; const r = res(s.slice(3)); return r ? `el:${r}` : s; };
  const decisions = reg.decisions.filter(r => live(r) && Records.status(r.rec.status) === 'bound' && touches(r.rec))
    .map(({ rec }) => ({
      id: String(rec.id), kind: rec.kind || 'technical', effect: rec.effect || null, statement: rec.statement || '',
      scope: [...list(rec.binds).map(n => `el:${n}`), ...list(rec.scope)].map(asRef).filter((s, i, a) => a.indexOf(s) === i),
      checks: Records.checks(rec), enforced_by: list(rec.enforced_by).map(String),
      ...(typeof rec.rationale === 'string' ? { rationale: rec.rationale } : {}),
    })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const reqIds = new Set([
    ...reg.requirements.filter(r => live(r) && list(r.rec.elements).some(has)).map(r => String(r.rec.id)),
    ...reg.decisions.filter(r => decisions.some(d => d.id === String(r.rec.id))).flatMap(r => list(r.rec.requirement).map(String)),
  ]);
  const requirements = reg.requirements.filter(r => reqIds.has(String(r.rec.id))).map(({ rec }) => ({
    id: String(rec.id), title: rec.title || '', ...(rec.source != null ? { source: String(rec.source) } : {}), ...(rec.version != null ? { version: String(rec.version) } : {}),
  })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const procs = Memory.procedures(reg.procedures || [], els, res);
  const vq = Verdicts.query({ verdicts: reg.verdicts, items: reg.items }, { scope: { elements: els }, commit, resolve: res });
  const body = {
    schema: BUNDLE_SCHEMA,
    key: { handover: reg.handover ? reg.handover.id : null, work_item, task, role, elements: els },
    revision: reg.handover ? String(reg.handover.revision || '') || null : reg.revision,
    commit,
    ...(jira ? { jira: list(jira).map(String) } : {}),
    decisions, requirements, verdicts: vq.nodes || [], procedures: procs.procedures, governance: null,
  };
  return { bundle_id: `sha256:${sha256(canonical(body))}`, ...body };
}

// System 3 knowledge health (Knowledge.health): the live decision set per area, graduation and retirement
// candidates, recurring failure causes and tokens per bundle. Display only.
function knowledge(reg) {
  return Knowledge.health({ decisions: reg.decisions.map(r => r.rec), episodes: Memory.episodes(reg.ledger, { items: reg.items }), events: reg.ledger, resolve: resolver(reg) });
}

// Write-time conflict check (Knowledge.overlaps) for an agent or pipeline about to mint a decision: {overlaps} or {error}.
function conflicts(reg, draft = {}) {
  if (!list(draft.binds).length && !list(draft.scope).length && draft.requirement == null) return { error: 'name what the decision is about: elements, or a requirement for a business decision' };
  return { overlaps: Knowledge.overlaps(draft, reg.decisions.map(r => r.rec), { resolve: resolver(reg) }) };
}

// The spec text for one acceptance case marked `holdout: true`, built by the code that builds the handover's generated specs
// (Core.holdoutSpec), so the Factory can judge a case that is never in a handover. Reads acceptance/ in the registry; writes
// nothing. {spec, sha256, state, element} or {error}. `case` is the case's index in the criterion's cases list.
function holdoutSpec(reg, { criterion, case: index } = {}) {
  if (!reg.model) return { error: 'the model is missing: nothing to name the element by' };
  const crit = readYamlDir(reg.dir, 'acceptance').recs.map(r => r.rec);
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return { error: `--case must be a case index (0 is the first), not ${index}` };
  try { return Core.holdoutSpec({ model: reg.model, criteria: crit, criterion, index: n }); } catch (e) { return { error: e.message }; }
}

// ---------------------------------------------------------------- check (the compiler as a library)
// The registry folder's text files, keyed as renderer/gate-inputs.js expects (the app's host.list, from disk).
const GATE_EXTS = { yaml: ['.yaml', '.yml'], json: ['.json'], jsonl: ['.jsonl'], p: ['.p'] };
function readFilesInto(files, dir, rel, exts) {
  let names = []; try { names = fs.readdirSync(path.join(dir, rel)); } catch { return; }
  for (const n of names.sort()) {
    if (!exts.some(x => n.endsWith(x))) continue;
    try { files[`${rel}/${n}`] = fs.readFileSync(path.join(dir, rel, n), 'utf8'); } catch { /* skipped, as host.list does */ }
  }
}
function gateFiles(dir, cfg) {
  const files = {};
  const modelRel = cfg.model || 'model/workspace.dsl';
  try { files[modelRel] = fs.readFileSync(path.join(dir, modelRel), 'utf8'); } catch { /* missing: the caller says so */ }
  // The model's folder: every .dsl under it, so `!include` resolves from the same map the app has.
  const mdir = path.dirname(modelRel) === '.' ? '' : path.dirname(modelRel);
  const walk = rel => {
    let ents = []; try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return []; }
    const skip = e => e.name === 'node_modules' || e.name === '.git' || (!rel && (e.name === 'handovers' || e.name === 'asbuilt'));
    return ents.flatMap(e => e.isDirectory() ? (skip(e) ? [] : walk(rel ? `${rel}/${e.name}` : e.name)) : [rel ? `${rel}/${e.name}` : e.name]);
  };
  for (const p of Core.modelFiles(walk(mdir), modelRel)) if (!(p in files)) { try { files[p] = fs.readFileSync(path.join(dir, p), 'utf8'); } catch { /* skipped */ } }
  for (const d of GateInputs.REG_DIRS) readFilesInto(files, dir, d, GATE_EXTS.yaml);
  const hv = path.join(dir, 'handovers');
  if (fs.existsSync(hv)) for (const n of fs.readdirSync(hv).sort()) if (fs.statSync(path.join(hv, n)).isDirectory()) readFilesInto(files, dir, `handovers/${n}`, GATE_EXTS.yaml);
  readFilesInto(files, dir, 'ledger', GATE_EXTS.jsonl);
  readFilesInto(files, dir, 'work', GATE_EXTS.yaml);
  readFilesInto(files, dir, 'domain', GATE_EXTS.yaml);
  readFilesInto(files, dir, 'behaviour', GATE_EXTS.p);
  for (const d of ['ui/pack/components', 'ui/pack/templates', 'ui/specs', 'ui/holdout', 'ui/legacy']) readFilesInto(files, dir, d, GATE_EXTS.json);
  readFilesInto(files, dir, 'parity/scenarios', GATE_EXTS.yaml);
  readFilesInto(files, dir, 'test-scenarios', GATE_EXTS.yaml);
  readFilesInto(files, dir, 'contracts/openapi', GATE_EXTS.yaml);
  for (const f of ['contracts/out/result.json', 'design-tokens/tokens.json']) { try { files[f] = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { /* optional */ } }
  return files;
}
// Sibling registries (designc.json registries): only what a pin is read from, as the app's registryRead/registryList do.
function siblingRegistries(dir, cfg) {
  const out = {};
  for (const key of Object.keys(cfg.registries && typeof cfg.registries === 'object' ? cfg.registries : {})) {
    let base; try { base = Paths.registryDir(dir, cfg.registries, key); } catch { continue; }
    const r = {};
    readFilesInto(r, base, 'domain', GATE_EXTS.yaml); readFilesInto(r, base, 'ui/components', GATE_EXTS.json); readFilesInto(r, base, 'ui/templates', GATE_EXTS.json);
    out[key] = r;
  }
  return out;
}
function uiHashes(dir, files) {
  const hashes = { previews: {}, specHashes: {} };
  for (const p of Object.keys(files)) {
    const m = /^ui\/specs\/([^/]+)\.json$/.exec(p);
    if (!m || !/^[a-z0-9-]+$/.test(m[1])) continue;
    try { hashes.previews[m[1]] = Paths.previewHashes(dir, m[1]); hashes.specHashes[m[1]] = Paths.specHash(dir, m[1]); } catch { /* the gate then says the previews are not rendered */ }
  }
  return hashes;
}
function readSettings(dir) {
  const sp = path.join(dir, 'designc.json');
  if (!fs.existsSync(sp)) return { cfg: {} };
  try { return { cfg: JSON.parse(fs.readFileSync(sp, 'utf8')) }; } catch (e) { return { error: `designc.json does not parse: ${e.message}` }; }
}

// Everything one check run computes for a registry folder on disk: {cfg, modelText, model, diags, gate, ledgerRaw, files, assembled} or {error}.
// What `python -m designc check` did, on the one front end: the assembly is renderer/gate-inputs.js.
// L1: unsaved buffers. `overlay` is {registryRelPath: text}. A key gateFiles read is replaced; a model-folder .dsl is added (a new unsaved
// include resolves); any other key is ignored (a brand-new unsaved YAML file counts once it is saved). Returns a new map.
function applyOverlay(files, overlay, modelRel) {
  const out = { ...files };
  for (const [p, text] of Object.entries(overlay || {})) {
    if (typeof text !== 'string') continue;
    if (p in out || Core.modelFiles([p], modelRel).length) out[p] = text;
  }
  return out;
}
function checkState(dir, { overlay = {} } = {}) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { error: `designc: ${dir} is not a folder. Open a registry folder.` };
  const s = readSettings(dir);
  if (s.error) return { error: `designc: ${s.error}` };
  const files = applyOverlay(gateFiles(dir, { model: 'model/workspace.dsl', ...s.cfg }), overlay, s.cfg.model || 'model/workspace.dsl');
  const a = GateInputs.assemble({ cfg: s.cfg, files, registries: siblingRegistries(dir, { ...s.cfg }), hashes: uiHashes(dir, files), yamlLoad: yaml.load });
  if (a.modelText == null) return { error: `designc: cannot read ${a.cfg.model || 'model/workspace.dsl'} in ${dir}. Open a registry folder, or set "model" in designc.json.` };
  const { diags, gate } = GateInputs.run(a, Core);
  return { cfg: a.cfg, modelText: a.modelText, model: a.model, diags, gate, assembled: a, files };
}

// The report `python -m designc check --json` printed (cli.py report_of), key order included.
function reportOf(s) {
  const g = s.gate;
  return {
    errors: s.model.errors.map(e => ({ line: e.line, file: e.file, msg: e.msg })),
    findings: s.diags.map(d => ({ code: d.code, sev: d.sev, msg: d.msg, label: d.loc.label, line: d.loc.line, file: d.loc.file, unknown: !!d.unknown, suppressed: d.suppressed || null })),
    gate: { ready: g.ready, clauses: g.clauses.map(c => ({ kind: c.kind, text: c.text })), ...(g.notes && g.notes.length ? { notes: [...g.notes] } : {}), ...(g.coverage && g.coverage.length ? { coverage: [...g.coverage] } : {}) },
  };
}

// check(dir): {report, state} or {error}. gate(dir, {item}): the same for one work item (clauses that touch its elements; no notes),
// plus {item, outside, warnings}. Neither writes anything.
function check(dir) {
  const state = checkState(dir);
  return state.error ? { error: state.error } : { state, report: reportOf(state) };
}
function gate(dir, { item } = {}) {
  const state = checkState(dir);
  if (state.error) return { error: state.error };
  if (item == null) return { state, report: reportOf(state) };
  const it = state.assembled.work.find(i => String(i.id) === String(item));
  if (!it || !Work.isRepo(it)) return { error: `designc: no repo work item ${item} in work/. Check the id; an item with a target has no scope.` };
  const scoped = Core.scopedGate(state.gate, { model: state.model, elements: it.elements || [], requirement: Work.reqs(it), decisions: state.assembled.gateInputs.decisions });
  const scopedState = { ...state, gate: scoped };
  return { state: scopedState, report: { ...reportOf(scopedState), item: String(item), outside: scoped.outside, warnings: scoped.warnings.map(c => c.text) } };
}

// ---------------------------------------------------------------- MCP tools without the app (designc-mcp.js headless mode)
// The four read tools the app serves from its own state, served from the registry on disk, fresh on every call. Names,
// descriptions and schemas are copies of renderer/agent.js TOOLS (test/mcp-headless.test.js asserts they are equal), and the
// text shapes are the app handlers' (READERS in agent.js).
const mcpObj = (props, req = []) => ({ type: 'object', properties: props, required: req, additionalProperties: false });
const MCP_TOOLS = {
  read_model: { d: 'Read the design model (Structurizr DSL) with line numbers. Optional line range.', p: mcpObj({ from: { type: 'integer' }, to: { type: 'integer' } }) },
  get_findings: { d: 'Current lint findings on the model (code, severity, location, line, message, hint, suppressed).', p: mcpObj({}) },
  get_gate: { d: 'Definition-of-ready verdict and every blocking clause.', p: mcpObj({}) },
  get_code_map: { d: 'The as-built map extracted from the codebase: elements, dependencies with evidence, drift against the design, d.code areas against the files in the codebase, unresolved items.', p: mcpObj({}) },
};
const mcpCap = (s, n = 24000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);
const mcpNumbered = (text, from = 1, to = Infinity) => text.split('\n').map((l, i) => [i + 1, l]).filter(([n]) => n >= from && n <= to).map(([n, l]) => `${String(n).padStart(4)}  ${l}`).join('\n');
const mcpRead = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; } };
function mcpTools() {
  return Object.entries(MCP_TOOLS).map(([name, t]) => ({ name, description: t.d, inputSchema: t.p }));
}
function mcpCodeMap(dir, s) {
  const dsl = mcpRead(dir, 'asbuilt/workspace.dsl'), factsRaw = mcpRead(dir, 'asbuilt/facts.json');
  let facts = null; try { facts = factsRaw ? JSON.parse(factsRaw) : null; } catch { facts = null; }
  if (!facts) return s.cfg.codebase ? 'The codebase has not been extracted yet. Ask the user to run Extract Code Map.' : 'No codebase is configured.';
  const asbuiltFull = dsl ? Core.parse(dsl) : null;
  const asbuilt = asbuiltFull ? Core.atLevel(asbuiltFull, 'container') : null;
  const hasModel = s.model && s.model.elements.size;
  const d = asbuilt && hasModel ? Core.driftModels(Core.atLevel(s.model, 'container'), asbuilt) : null;
  const areas = Core.codeAreaDrift(s.model, facts.files), intent = Core.intentDrift(s.model, facts.intent);
  const designNameFor = name => { if (!name || !s.model) return null; const e = Core.resolveElement(s.model, name); return e ? e.name : null; };
  return mcpCap(JSON.stringify({
    repo: facts.repo, extractedAt: facts.extractedAt,
    elements: facts.elements.map(e => ({ name: e.name, kind: e.kind, tech: e.tech, inDesign: d ? d.toDesign.has('e_' + e.key) || !!designNameFor(e.name) : null })),
    dependencies: facts.edges.map(e => ({ from: e.from, to: e.to, kind: e.kind, label: e.label, evidence: e.evidence.slice(0, 2).map(v => `${v.file}:${v.line}`) })),
    drift: d ? { inCodeNotDesign: d.undeclared.map(u => `${u.from} -> ${u.to}`), elementsInCodeOnly: d.unknownEls, designedNotInCode: d.unrealised.map(u => `${u.from} -> ${u.to}`), designElementsNotFound: d.missingEls } : 'no design to compare',
    declaredIntent: intent ? (intent.error ? `${intent.file}: ${intent.error}` : { file: intent.file, declared: intent.declared, missingFromDesign: intent.missing }) : 'none configured (designc.json extract.intent)',
    codeAreas: areas ? { areas: areas.areas.map(a => ({ element: a.name, pattern: a.pattern, files: a.matched, ...(a.hint ? { hint: a.hint } : {}) })), filesInCodebase: areas.files, inNoArea: areas.unclaimed.length, inNoAreaFirst: areas.unclaimed.slice(0, 50), ...(areas.areas.length ? {} : { note: 'no areas defined, drift is container-level only' }) } : 're-extract to see code areas',
    unresolved: facts.unresolved.map(u => `${u.where}: ${u.what} (${u.file}:${u.line})`),
  }));
}
// callTool(dir, name, args): {text, isError}. Reads the registry fresh; no state between calls.
function callTool(dir, name, args = {}) {
  if (!Object.prototype.hasOwnProperty.call(MCP_TOOLS, name)) return { isError: true, text: `designc app not running: ${name} needs the designc app open on this registry` };
  const s = checkState(dir);
  if (s.error) return { isError: true, text: s.error };
  if (name === 'read_model') return { isError: false, text: s.modelText ? mcpCap(mcpNumbered(s.modelText, args.from || 1, args.to || Infinity)) + (s.model.sources.length > 1 ? `\n(this model also includes: ${s.model.sources.slice(1).map(f => f.path).join(', ')}; read them as files)` : '') : `No model at ${s.cfg.model} yet.` };
  if (name === 'get_findings') return { isError: false, text: JSON.stringify(s.diags.map(f => ({ code: f.code, severity: f.sev, where: f.loc.label, line: f.loc.line, file: f.loc.file, message: f.msg, hint: f.hint, unknownProperty: f.unknown || undefined, suppressed: f.suppressed || undefined }))) };
  if (name === 'get_gate') return { isError: false, text: JSON.stringify({ ready: s.gate.ready, blocking: s.gate.clauses.map(c => ({ kind: c.kind, text: c.text, line: c.line, file: c.file })) }) };
  return { isError: false, text: mcpCodeMap(dir, s) };
}

module.exports = { applyOverlay, mcpTools, callTool, MCP_TOOLS, check, gate, checkState, reportOf, open, holdoutSpec, verdicts, episodes, procedureStats, procedureReview, knowledge, conflicts, bundle, canonical, resolver, BUNDLE_SCHEMA };
