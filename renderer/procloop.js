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
   External entries: ids with a colon (the pipeline's own prompt:<name>, policy:<name>, target:policy) have no file here;
   their source of truth is the pipeline's repository. They are judged the same way in `external`, grouped by id, the
   most recently given hash being the current version (a new hash is a new version even when the declared version is
   unchanged). A struggling one gets action `propose`: a change proposed in the pipeline's repository, never Bind or
   Retire here. Other ids that name no file are counted in `ignored`. Suggestions only: binding and retiring are a
   person's actions in Improve. Never a gate input. Thresholds: designc.json improve.procedures {minUses, proven, struggling}. */
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

  // Where an external entry's source of truth lives (the pipeline's repository, or the target repository).
  function sourceOf(id) {
    const [kind, name] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    if (kind === 'prompt') return `prompts/${name}.md in the pipeline's repository`;
    if (kind === 'target' && name === 'policy') return '.factory/policy.yaml in the target repository';
    if (kind === 'policy') return `policies/s2/${name}.yaml in the pipeline's repository`;
    return 'outside designc';
  }

  // bound status, current stats and settings to {judgement, action, reason}; external entries propose, never retire.
  function judge(cur, s, external) {
    const r = rate(cur);
    if (cur.uses < s.minUses) return { judgement: 'untested', action: null, reason: `given in ${cur.uses} finished task${cur.uses === 1 ? '' : 's'} on this version; judged from ${s.minUses}` };
    if (r >= s.proven) return { judgement: 'proven', action: null, reason: `passed ${cur.passed} of ${cur.uses} tasks it was given in` };
    if (r <= s.struggling) return external
      ? { judgement: 'struggling', action: 'propose', reason: `passed ${cur.passed} of ${cur.uses} tasks it was given in; propose a change in the pipeline's repository (promotion is a git change there)` }
      : { judgement: 'struggling', action: 'retire', reason: `passed ${cur.passed} of ${cur.uses} tasks it was given in; retire it or write a new version` };
    return { judgement: 'mixed', action: null, reason: `passed ${cur.passed} of ${cur.uses} tasks it was given in` };
  }

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
      const { judgement, action, reason } = status === 'proposed' ? { judgement: 'proposed', action: 'bind', reason: 'not given to agents until a person binds it' }
        : status !== 'bound' ? { judgement: 'retired', action: null, reason: `${status}: not given to agents` }
        : judge(cur, s, false);
      rows.push({ id: ref.id, path: p.path || null, title: p.rec.title, version: ref.version, hash: ref.hash, status, uses: cur.uses, passed: cur.passed, failed: cur.failed, delivered: cur.success, causes: cur.causes, rate: r, older, judgement, action, reason });
    }
    rows.sort((a, b) => byStr(a.id, b.id));
    const outside = stats.filter(x => !ids.has(x.id));
    const groups = new Map();
    for (const x of outside.filter(x => String(x.id).includes(':'))) {
      if (!groups.has(x.id)) groups.set(x.id, []);
      groups.get(x.id).push(x);
    }
    const external = [...groups.entries()].map(([id, xs]) => {
      const cur = xs.reduce((a, b) => ((b.last ?? -1) > (a.last ?? -1) ? b : a));
      const older = xs.filter(x => x !== cur).sort((a, b) => (b.last ?? -1) - (a.last ?? -1))
        .map(x => ({ version: x.version, hash: x.hash, uses: x.uses, passed: x.passed, failed: x.failed, success: x.success, rate: rate(x) }));
      return { id, external: true, source: sourceOf(id), version: cur.version, hash: cur.hash, uses: cur.uses, passed: cur.passed, failed: cur.failed, delivered: cur.success, causes: cur.causes, rate: rate(cur), older, ...judge(cur, s, true) };
    }).sort((a, b) => byStr(a.id, b.id));
    const ignored = outside.filter(x => !String(x.id).includes(':')).length;
    return { rows, external, invalid, ignored };
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
