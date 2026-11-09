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
  const model = modelText != null ? Core.parse(modelText) : null;
  const decisions = readYamlDir(base, 'decisions');
  const requirements = readYamlDir(base, 'requirements');
  const verdicts = readYamlDir(dir, 'verdicts');
  const work = readYamlDir(dir, 'work');
  const procedures = readYamlDir(dir, 'procedures');
  const ledger = readLedger(dir);
  return {
    dir, settings, handover: frozen ? { id: handover, ...frozen } : null, modelText, model,
    revision: modelText != null ? Core.modelRevision(modelText) : null,
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

module.exports = { open, verdicts, episodes, procedureStats, procedureReview, knowledge, conflicts, bundle, canonical, resolver, BUNDLE_SCHEMA };
