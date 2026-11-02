/* Procedure loop (intelligence plane phase 6, System 3), pure and dual-loaded after records.js and memory.js.
   Attribution: Memory.procedureStats gives, per procedure id, version and hash, the final outcomes of the tasks whose
   trace row named it. A trace row names the procedures a coding agent was GIVEN in its context bundle, not the ones it
   followed, so every figure here means "given in N tasks", never "followed".
   review() joins those stats with procedures/*.yaml and judges the version in the file now (by hash):
     proposed   not given to agents until a person binds it (action: bind)
     untested   bound, fewer than minUses final tasks on this version
     proven     bound, passed share >= proven
     struggling bound, passed share <= struggling (action: retire, or edit to a new version)
     mixed      bound, in between
     retired    retired or superseded
   Stats for earlier hashes of the same id are kept as `older`, so a new version can be compared with the old one.
   Trace entries whose id names no procedure file (S2's own prompt:, policy:, target: entries) are counted in
   `ignored` and never judged. Suggestions only: binding and retiring are a person's actions in Improve. Never a gate
   input. Thresholds: designc.json improve.procedures {minUses, proven, struggling}. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./records.js'), require('./memory.js'));
  else root.ProcLoop = factory(root.Records, root.Memory);
})(typeof self !== 'undefined' ? self : this, function (Records, Memory) {
  'use strict';
  const DEFAULTS = { minUses: 5, proven: 0.8, struggling: 0.4 };
  const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

  // {minUses, proven, struggling, problems[]}: a bad value keeps its default and is named.
  function settings(cfg) {
    const s = { ...DEFAULTS, problems: [] };
    const c = cfg && isObj(cfg.improve) && cfg.improve.procedures;
    if (c == null) return s;
    if (!isObj(c)) { s.problems.push('improve.procedures must be an object {minUses, proven, struggling}'); return s; }
    if (c.minUses != null) { if (Number.isInteger(c.minUses) && c.minUses >= 1) s.minUses = c.minUses; else s.problems.push('improve.procedures.minUses must be a whole number of at least 1'); }
    for (const k of ['proven', 'struggling']) {
      if (c[k] == null) continue;
      if (typeof c[k] === 'number' && c[k] >= 0 && c[k] <= 1) s[k] = c[k]; else s.problems.push(`improve.procedures.${k} must be a number from 0 to 1`);
    }
    if (s.struggling >= s.proven) { s.problems.push('improve.procedures.struggling must be below proven; using the defaults'); s.proven = DEFAULTS.proven; s.struggling = DEFAULTS.struggling; }
    return s;
  }

  const zero = { uses: 0, passed: 0, failed: 0, success: 0, causes: {} };
  const rate = st => st.uses ? st.passed / st.uses : null;

  // procedures: [{rec, path, text}]; stats: Memory.procedureStats(...); s: settings(...)
  function review({ procedures = [], stats = [], settings: s = DEFAULTS } = {}) {
    const rows = [], invalid = [];
    const ids = new Set();
    for (const p of procedures) {
      if (!p || !p.rec) continue;
      const errors = Records.validate('procedure', p.rec);
      if (errors.length) { invalid.push({ id: p.rec.id == null ? null : String(p.rec.id), path: p.path || null, errors }); continue; }
      const ref = Memory.ref(p.rec, p.text == null ? '' : p.text);
      ids.add(ref.id);
      const mine = stats.filter(x => x.id === ref.id);
      const cur = mine.find(x => x.hash === ref.hash) || { ...zero, causes: {} };
      const older = mine.filter(x => x.hash !== ref.hash).map(x => ({ version: x.version, hash: x.hash, uses: x.uses, passed: x.passed, failed: x.failed, success: x.success, rate: rate(x) }));
      const status = Records.status(p.rec.status);
      const r = rate(cur);
      let judgement, action = null, reason;
      if (status === 'proposed') { judgement = 'proposed'; action = 'bind'; reason = 'not given to agents until a person binds it'; }
      else if (status !== 'bound') { judgement = 'retired'; reason = `${status}: not given to agents`; }
      else if (cur.uses < s.minUses) { judgement = 'untested'; reason = `given in ${cur.uses} finished task${cur.uses === 1 ? '' : 's'} on this version; judged from ${s.minUses}`; }
      else if (r >= s.proven) { judgement = 'proven'; reason = `passed ${cur.passed} of ${cur.uses} tasks it was given in`; }
      else if (r <= s.struggling) { judgement = 'struggling'; action = 'retire'; reason = `passed ${cur.passed} of ${cur.uses} tasks it was given in; retire it or write a new version`; }
      else { judgement = 'mixed'; reason = `passed ${cur.passed} of ${cur.uses} tasks it was given in`; }
      rows.push({ id: ref.id, path: p.path || null, title: p.rec.title, version: ref.version, hash: ref.hash, status, uses: cur.uses, passed: cur.passed, failed: cur.failed, delivered: cur.success, causes: cur.causes, rate: r, older, judgement, action, reason });
    }
    rows.sort((a, b) => byStr(a.id, b.id));
    const ignored = stats.filter(x => !ids.has(x.id)).length;
    return { rows, invalid, ignored };
  }

  // The one edit Improve makes on a person's say: the top-level status line, nothing else. null when there is no
  // single top-level `status:` line to change.
  function setStatus(text, status) {
    const lines = String(text).split('\n');
    const at = lines.map((l, i) => /^status:/.test(l) ? i : -1).filter(i => i >= 0);
    if (at.length !== 1) return null;
    lines[at[0]] = `status: ${status}`;
    return lines.join('\n');
  }

  return { DEFAULTS, settings, review, setStatus };
});
