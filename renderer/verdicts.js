/* Verdict query (intelligence plane phase 3), pure and dual-loaded like work.js (after records.js).
   The headless core (headless/index.js, scripts/designc-core.js verdicts) and the Work card call the same function.

   Verdicts are records of kind verdict in verdicts/*.yaml (docs/records.schema.json): a person's or a recorder's
   judgement that something built matches the reference (matched), differs (diverged) or differs on purpose (accepted).
   Only bound verdicts count. Nothing here knows where a verdict came from: no parity logic.

   query({verdicts, items}, {scope, commit}) -> {nodes: [{node_id, verdict, evidence[], records[], conflict?, stale?}]}
   or {error}. scope is {work_item: id} or {elements: [names]}. The nodes are el:<name> for each element in scope, then
   every other id (ui:, test:, ...) that a bound verdict names beside one of those elements, sorted. With commit, a
   verdict pinned to another commit does not count and is listed in stale; a verdict with no commit counts at any.
   Bound verdicts that agree give that verdict with their evidence; verdicts that disagree give null and conflict.
   A verdict record that does not validate never counts and is listed in invalid with its errors (a YAML number for
   commit is the usual one: booking it).
   With resolve (ref -> canonical element id or null, e.g. the hierarchical id System/Container), every el: ref in the
   scope and in the verdicts is read through it, so el:<name> and el:<System/Container> meet on one node; el: nodes then
   carry name. A ref resolve cannot place (unknown, or a name two elements share) is kept as written. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./records.js'));
  else root.Verdicts = factory(root.Records);
})(typeof self !== 'undefined' ? self : this, function (Records) {
  'use strict';
  const list = v => v == null ? [] : Array.isArray(v) ? v : [v];
  const uniq = xs => [...new Set(xs)];

  function elementsOf({ items = [] }, scope) {
    if (!scope || typeof scope !== 'object') return { error: 'scope is {work_item: id} or {elements: [names]}' };
    if (scope.work_item != null) {
      const it = items.find(i => i && i.id === scope.work_item);
      if (!it) return { error: `no work item ${scope.work_item}` };
      if (!list(it.elements).length) return { error: `${it.id} names no elements` };
      return { elements: list(it.elements).map(String) };
    }
    if (Array.isArray(scope.elements)) return { elements: scope.elements.map(String) };
    return { error: 'scope is {work_item: id} or {elements: [names]}' };
  }

  // verdicts: [{rec, path}] as read from verdicts/*.yaml
  function query(input, { scope, commit = null, resolve = null } = {}) {
    const sc = elementsOf(input, scope);
    if (sc.error) return { error: sc.error };
    const names = new Map();
    const el = x => { const r = resolve ? resolve(x) : null; if (r != null) { names.set(r, names.get(r) || x); return r; } return x; };
    const ref = x => typeof x === 'string' && x.startsWith('el:') ? `el:${el(x.slice(3))}` : x;
    const all = list(input.verdicts).filter(v => v && v.rec).map(v => resolve && v.rec.scope != null ? { ...v, rec: { ...v.rec, scope: list(v.rec.scope).map(ref) } } : v);
    const invalid = all.map(v => ({ id: v.rec.id == null ? null : String(v.rec.id), path: v.path || null, errors: Records.validate('verdict', v.rec) })).filter(x => x.errors.length);
    const bad = new Set(invalid.map(x => x.path));
    const live = all.filter(v => Records.status(v.rec.status) === 'bound' && !bad.has(v.path || null));
    const els = uniq(sc.elements.map(n => `el:${el(n)}`));
    const elSet = new Set(els);
    const extra = uniq(live.flatMap(v => { const s = list(v.rec.scope); return s.some(x => elSet.has(x)) ? s.filter(x => !elSet.has(x)) : []; })).sort();
    const nodes = [...els, ...extra].map(node_id => {
      const about = live.filter(v => list(v.rec.scope).includes(node_id));
      const counts = commit ? about.filter(v => v.rec.commit == null || v.rec.commit === commit) : about;
      const stale = commit ? about.filter(v => v.rec.commit != null && v.rec.commit !== commit).map(v => v.rec.id) : [];
      const kinds = uniq(counts.map(v => v.rec.verdict));
      const out = { node_id, verdict: kinds.length === 1 ? kinds[0] : null, evidence: kinds.length === 1 ? uniq(counts.flatMap(v => list(v.rec.evidence))) : [], records: counts.map(v => v.rec.id) };
      if (resolve && node_id.startsWith('el:') && names.has(node_id.slice(3))) out.name = resolve.nameOf ? resolve.nameOf(node_id.slice(3)) : names.get(node_id.slice(3));
      if (kinds.length > 1) out.conflict = counts.map(v => `${v.rec.id}: ${v.rec.verdict}`);
      if (stale.length) out.stale = stale;
      return out;
    });
    return { nodes, invalid };
  }

  // Counts for a card: how many nodes in scope have each verdict, none, or a conflict.
  function summary(res) {
    const c = { matched: 0, diverged: 0, accepted: 0, none: 0, conflict: 0 };
    for (const n of (res && res.nodes) || []) c[n.conflict ? 'conflict' : n.verdict || 'none']++;
    return c;
  }

  return { query, summary };
});
