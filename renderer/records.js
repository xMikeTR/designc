/* Records (intelligence plane phase 2): one envelope for decisions, requirements, verdicts and procedures
   (phase 4: procedures/*.yaml, title, version, steps).
   Pure and dual-loaded like pathpattern.js (loaded before core.js; core.js, ledger.js and policy.js read checkRun/runs).
   Mirrored in python/designc/records.py; test/records.test.js compares them. Schema: docs/records.schema.json.

   Envelope: id, status, scope[], supersedes[], evidence[], source. A decision adds statement, enforced_by[], rationale
   and keeps every gate field (effect, kind, binds, resolves, relies_on, assumptions, work, removes, promoted_*,
   agreed_by, checks). minted and checked read as proposed; retired is new: a record nobody uses any more, never counted.
   Nothing here is a gate input: validate and lint feed Problems and the converter's dry run. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Records = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KINDS = ['decision', 'requirement', 'verdict', 'procedure'];
  // Prefixed ids for things a record points at outside itself (Mike's work records): a UI node, a requirement,
  // a design element, a test, a Jira key. A bare id is another record.
  const PREFIXES = ['ui', 'req', 'el', 'test', 'jira'];
  const STATUSES = ['proposed', 'bound', 'superseded', 'retired'];
  const ALIASES = { minted: 'proposed', checked: 'proposed' };
  const VERDICTS = ['matched', 'diverged', 'accepted'];
  // enforced_by: a check id (chk-...), a gate clause kind (gate:<kind>) or an mlang rule id (mlang:<id>).
  const GATE_KINDS = ['parse', 'registry', 'duplicate', 'finding', 'decision', 'evidence', 'check', 'promotion', 'assumption', 'requirement', 'scenario', 'eval', 'needs', 'acceptance', 'tokens', 'domain', 'contracts', 'unpinned_contract'];

  function fnv(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  const hash16 = str => fnv(str, 2166136261) + fnv(str, 2654435769);

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const list = v => v == null ? [] : Array.isArray(v) ? v : [v];
  const str = v => typeof v === 'string' && v.trim() !== '';

  // A check is a command string (as today) or {id, run}. The id of a string check is derived from the command.
  const checkRun = c => isObj(c) ? (typeof c.run === 'string' ? c.run : '') : c == null ? '' : String(c);
  const checkId = run => 'chk-' + hash16(String(run).trim()).slice(0, 8);
  const checks = rec => list(rec && rec.checks).map(c => isObj(c) ? { id: str(c.id) ? c.id : checkId(checkRun(c)), run: checkRun(c) } : { id: checkId(checkRun(c)), run: checkRun(c) });
  const runs = rec => list(rec && rec.checks).map(checkRun);

  const status = s => ALIASES[s] || s;
  const parseRef = s => {
    if (typeof s !== 'string') return null;
    const m = /^([a-z]+):(.+)$/.exec(s);
    return m && PREFIXES.includes(m[1]) ? { prefix: m[1], key: m[2] } : null;
  };

  function validate(kind, rec) {
    const errs = [];
    if (!KINDS.includes(kind)) return [`kind: must be one of ${KINDS.join('|')}`];
    if (!isObj(rec)) return ['record: must be a mapping'];
    if (!str(rec.id)) errs.push('id: required');
    else if (/\s/.test(rec.id)) errs.push('id: must have no spaces');
    if (rec.status == null && kind !== 'requirement') errs.push('status: required');
    else if (rec.status != null && !STATUSES.includes(status(rec.status))) errs.push(`status: must be one of ${STATUSES.join('|')} (minted and checked read as proposed)`);
    for (const f of ['scope', 'supersedes', 'evidence']) {
      if (rec[f] == null) continue;
      if (!list(rec[f]).every(str)) errs.push(`${f}: must be a string or a list of strings`);
    }
    for (const s of list(rec.scope)) if (str(s) && s.includes(':') && !parseRef(s)) errs.push(`scope: ${s} has an unknown prefix; use ${PREFIXES.map(p => p + ':').join(' ')}`);
    if (rec.source != null && typeof rec.source !== 'string') errs.push('source: must be a string');
    if (kind === 'decision') {
      if (!str(rec.statement)) errs.push('statement: required');
      if (rec.rationale != null && typeof rec.rationale !== 'string') errs.push('rationale: must be a string');
      list(rec.checks).forEach((c, i) => {
        if (isObj(c)) {
          if (!str(c.run)) errs.push(`checks[${i}]: run must be a command`);
          if (c.id != null && !/^[A-Za-z0-9._-]+$/.test(String(c.id))) errs.push(`checks[${i}]: id must be letters, digits, ".", "_" or "-"`);
          const extra = Object.keys(c).filter(k => k !== 'id' && k !== 'run');
          if (extra.length) errs.push(`checks[${i}]: unknown field ${extra[0]}`);
        } else if (!str(c)) errs.push(`checks[${i}]: must be a command or {id, run}`);
      });
      for (const e of list(rec.enforced_by)) {
        if (!str(e)) { errs.push('enforced_by: must be a string or a list of strings'); continue; }
        if (e.startsWith('gate:') ? !GATE_KINDS.includes(e.slice(5)) : !(e.startsWith('chk-') || /^mlang:.+/.test(e) || /^[A-Za-z0-9._-]+$/.test(e)))
          errs.push(`enforced_by: ${e} is not a check id, gate:<clause kind> or mlang:<rule id>`);
      }
    }
    if (kind === 'requirement' && !str(rec.title)) errs.push('title: required');
    if (kind === 'verdict') {
      if (!VERDICTS.includes(rec.verdict)) errs.push(`verdict: must be one of ${VERDICTS.join('|')}`);
      if (!list(rec.scope).length) errs.push('scope: a verdict names what it judges');
      if (rec.commit != null && typeof rec.commit !== 'string') errs.push('commit: must be a string');
    }
    if (kind === 'procedure') {
      if (str(rec.id) && !/^[A-Za-z0-9._-]+$/.test(rec.id)) errs.push('id: letters, digits, ".", "_" or "-" (a trace row names it verbatim beside prefixed ids such as prompt:)');
      if (!str(rec.title)) errs.push('title: required');
      if (!(str(rec.version) || (Number.isInteger(rec.version) && rec.version >= 1))) errs.push('version: a whole number of at least 1, or a string');
      if (!list(rec.scope).length) errs.push('scope: a procedure names what it applies to');
      if (!list(rec.steps).length || !list(rec.steps).every(str)) errs.push('steps: a string or a list of strings');
    }
    return errs;
  }

  // Lint across records: `records` are {kind, rec, path}. Finds repeated ids, references to unknown or superseded
  // records (supersedes, relies_on, bare scope ids, req: scope against requirements), enforced_by check ids that the
  // decision does not carry, and superseded records nothing replaces. `opts.elements` (names) checks el: scope.
  function lint(records, opts = {}) {
    const out = [];
    const byId = new Map();
    for (const r of records) {
      if (!r.rec || !str(r.rec.id)) continue;
      if (byId.has(r.rec.id)) out.push({ path: r.path, id: r.rec.id, sev: 'error', msg: `${r.rec.id} is repeated (also ${byId.get(r.rec.id).path})` });
      else byId.set(r.rec.id, r);
    }
    const dead = id => { const t = byId.get(id); return t && ['superseded', 'retired'].includes(status(t.rec.status)); };
    const replaced = new Set();
    for (const r of records) for (const s of list(r.rec && r.rec.supersedes)) replaced.add(s);
    const elements = opts.elements ? new Set(opts.elements) : null;
    for (const r of records) {
      const rec = r.rec; if (!rec || !str(rec.id)) continue;
      const add = (sev, msg) => out.push({ path: r.path, id: rec.id, sev, msg });
      for (const s of list(rec.supersedes)) if (!byId.has(s)) add('error', `supersedes ${s}, which is not a record`);
      for (const s of list(rec.relies_on)) {
        if (!byId.has(s)) add('error', `relies on ${s}, which is not a record`);
        else if (dead(s)) add('warning', `relies on ${s}, which is ${status(byId.get(s).rec.status)}`);
      }
      for (const s of list(rec.scope)) {
        if (typeof s !== 'string') continue;
        const ref = parseRef(s);
        if (!ref) { if (!s.includes(':')) { if (!byId.has(s)) add('error', `scope names ${s}, which is not a record`); else if (dead(s)) add('warning', `scope names ${s}, which is ${status(byId.get(s).rec.status)}`); } continue; }
        if (ref.prefix === 'req') {
          const t = byId.get(ref.key);
          if (!t || t.kind !== 'requirement') add('error', `scope names ${s}, which is not a requirement`);
          else if (dead(ref.key)) add('warning', `scope names ${s}, which is ${status(t.rec.status)}`);
        }
        if (ref.prefix === 'el' && elements && !elements.has(ref.key)) add('error', `scope names ${s}, which is not an element of the model`);
      }
      if (r.kind === 'decision') {
        const ids = new Set(checks(rec).map(c => c.id));
        for (const e of list(rec.enforced_by)) if (typeof e === 'string' && e.startsWith('chk-') && !ids.has(e)) add('error', `enforced by ${e}, which is not one of its checks`);
      }
      if (status(rec.status) === 'superseded' && !replaced.has(rec.id)) add('warning', `${rec.id} is superseded but no record supersedes it`);
    }
    return out;
  }

  // Index the links stored on one side: who supersedes a record, who relies on it, who scopes to it.
  function inverse(records) {
    const inv = {};
    const at = id => inv[id] || (inv[id] = { superseded_by: [], relied_on_by: [], scoped_by: [] });
    for (const { rec } of records) {
      if (!rec || !str(rec.id)) continue;
      for (const s of list(rec.supersedes)) at(s).superseded_by.push(rec.id);
      for (const s of list(rec.relies_on)) at(s).relied_on_by.push(rec.id);
      for (const s of list(rec.scope)) if (typeof s === 'string') at(s).scoped_by.push(rec.id);
    }
    return inv;
  }

  return { KINDS, PREFIXES, STATUSES, ALIASES, VERDICTS, GATE_KINDS, hash16, checkRun, checkId, checks, runs, status, parseRef, validate, lint, inverse };
});
