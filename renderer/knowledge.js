/* Knowledge health (intelligence plane phase 6, System 3), pure and dual-loaded after records.js.
   Keeps the live set of decisions visible so it stays small (SESSION_HANDOFF decision 9), from files and the ledger only:
     live        bound decisions, counted per area (System/Container of the elements they bind; resolve gives the
                 hierarchical id), with how many are enforced
     graduate    live decisions with enforced_by: a check or rule now carries them, so a bundle or a person can cite the
                 id instead of restating them. A suggestion; the decision file stays as it is until a person changes it
     unused      live decisions whose elements no recorded task touched: candidates to retire. null when there are no
                 episodes yet (nothing can be said)
     recurrence  failure causes over finished tasks that did not pass: count, distinct runs and items; recurring at 2 runs
     tokens      latest trace row per run and task, tokens_in + tokens_out, with and without a bundle_id, mean per row
   overlaps(draft, decisions) is the write-time conflict check (phase 5, the part that needs no governance): the live or
   proposed decisions a new one would sit beside. `same` shares an element and a finding code (a second answer to one
   finding: supersede it or change it, the agent writer refuses); `near` shares an element where neither names a code,
   or is a business decision on the same requirement (shown so a person can choose to supersede).
   No parity logic: parity coverage is counted by the Improve view from its own scenarios. Display only, never a gate
   input. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./records.js'));
  else root.Knowledge = factory(root.Records);
})(typeof self !== 'undefined' ? self : this, function (Records) {
  'use strict';
  const list = v => v == null ? [] : Array.isArray(v) ? v : [v];
  const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const NONE = '(no element)';

  // decisions: plain decision objects (id, status, binds, scope, enforced_by). episodes: Memory.episodes(...).
  function health({ decisions = [], episodes = [], events = [], resolve = null } = {}) {
    const el = n => (resolve && resolve(String(n))) || String(n);
    const areaOf = id => id.split('/').slice(0, 2).join('/');
    const elsOf = d => [...list(d.binds).map(String), ...list(d.scope).filter(s => typeof s === 'string' && s.startsWith('el:')).map(s => s.slice(3))].map(el);
    const live = decisions.filter(d => d && d.id != null && Records.status(d.status) === 'bound');

    const areas = new Map();
    for (const d of live) {
      const as = [...new Set(elsOf(d).map(areaOf))];
      for (const a of as.length ? as : [NONE]) {
        if (!areas.has(a)) areas.set(a, { area: a, live: 0, enforced: 0 });
        const r = areas.get(a); r.live++; if (list(d.enforced_by).length) r.enforced++;
      }
    }

    const graduate = live.filter(d => list(d.enforced_by).length).map(d => ({ id: String(d.id), enforced_by: list(d.enforced_by).map(String) })).sort((a, b) => byStr(a.id, b.id));

    const touched = new Set(episodes.flatMap(e => list(e.elements).map(el)));
    const unused = episodes.length
      ? live.filter(d => { const xs = elsOf(d); return xs.length && !xs.some(x => touched.has(x)); }).map(d => String(d.id)).sort(byStr)
      : null;

    const causes = new Map();
    for (const e of episodes) {
      if (!e.final || (e.outcome === 'passed' && !e.ref) || !e.cause) continue;
      if (!causes.has(e.cause)) causes.set(e.cause, { cause: e.cause, count: 0, runs: new Set(), items: new Set() });
      const c = causes.get(e.cause); c.count++; c.runs.add(e.run); if (e.item) c.items.add(e.item);
    }
    const recurrence = [...causes.values()].map(c => ({ cause: c.cause, count: c.count, runs: c.runs.size, items: c.items.size, recurring: c.runs.size >= 2 }))
      .sort((a, b) => b.count - a.count || byStr(a.cause, b.cause));

    const latest = new Map();
    for (const e of events) if (e && e.kind === 'trace' && typeof e.run === 'string' && typeof e.task === 'string') latest.set(`${e.run}\u0000${e.task}`, e);
    const tok = e => (Number(e.tokens_in) || 0) + (Number(e.tokens_out) || 0);
    const side = rows => ({ rows: rows.length, mean: rows.length ? Math.round(rows.reduce((s, e) => s + tok(e), 0) / rows.length) : null });
    const traces = [...latest.values()];
    const withB = traces.filter(e => typeof e.bundle_id === 'string' && e.bundle_id);
    const tokens = { withBundle: side(withB), withoutBundle: side(traces.filter(e => !withB.includes(e))), bundles: new Set(withB.map(e => e.bundle_id)).size };

    return {
      live: live.length,
      areas: [...areas.values()].sort((a, b) => b.live - a.live || byStr(a.area, b.area)),
      graduate, unused, recurrence, tokens,
    };
  }

  // The decisions a draft {binds, scope, resolves, requirement, kind} would overlap; superseded and retired ones never.
  function overlaps(draft, decisions = [], { resolve = null } = {}) {
    const el = n => (resolve && resolve(String(n))) || String(n);
    const elsOf = d => new Set([...list(d.binds).map(String), ...list(d.scope).filter(s => typeof s === 'string' && s.startsWith('el:')).map(s => s.slice(3))].map(el));
    const codes = d => new Set(list(d.resolves).map(c => String(c).toUpperCase()));
    const mine = elsOf(draft || {}), myCodes = codes(draft || {});
    const business = d => d.kind === 'business';
    const out = [];
    for (const d of decisions) {
      if (!d || d.id == null || (draft && draft.id != null && String(d.id) === String(draft.id))) continue;
      const status = Records.status(d.status);
      if (status !== 'bound' && status !== 'proposed') continue;
      const theirs = elsOf(d), tc = codes(d);
      const elements = [...mine].filter(x => theirs.has(x)).sort(byStr);
      const shared = [...myCodes].filter(c => tc.has(c)).sort(byStr);
      let level = null;
      if (elements.length && shared.length) level = 'same';
      else if (elements.length && !myCodes.size && !tc.size) level = 'near';
      else if (business(draft || {}) && business(d) && draft.requirement != null && String(draft.requirement) === String(d.requirement)) level = 'near';
      if (level) out.push({ id: String(d.id), status, level, elements, codes: shared, statement: d.statement == null ? '' : String(d.statement) });
    }
    return out.sort((a, b) => (a.level === b.level ? byStr(a.id, b.id) : a.level === 'same' ? -1 : 1));
  }

  return { health, overlaps };
});
