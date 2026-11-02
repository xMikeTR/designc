/* Memory (intelligence plane phase 4), pure and dual-loaded like verdicts.js (after records.js and ledger.js).
   Three kinds of memory, all from files and the ledger, never from a model:
   - verdicts: verdicts.js (what was judged to match the reference);
   - procedures: procedures/*.yaml, records of kind procedure (title, version, scope, steps), written by a person.
     A coding agent receives the bound ones touching its elements in the context bundle and names the ones it used in
     its `trace` row as {id, version, hash}; ref() gives exactly that shape, hash being hash16 of the file text (LF);
   - episodes: Ledger.taskOutcomes (one row per run and task) plus the elements the task was about: the elements of
     the work item its handover was frozen for, else the `element` of the run's `task` rows.
   procedureStats counts final outcomes per procedure version, the input for System 3 (phase 6). Nothing here is a
   gate input. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./records.js'), require('./ledger.js'));
  else root.Memory = factory(root.Records, typeof Ledger !== 'undefined' ? Ledger : root.Ledger); // ledger.js is a top-level const, not on window
})(typeof self !== 'undefined' ? self : this, function (Records, Ledger) {
  'use strict';
  const list = v => v == null ? [] : Array.isArray(v) ? v : [v];
  const uniq = xs => [...new Set(xs)];
  const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  const ref = (rec, text) => ({ id: String(rec.id), version: String(rec.version), hash: Records.hash16(String(text).replace(/\r\n/g, '\n')) });

  // recs: [{rec, path, text}] from procedures/*.yaml. elements: canonical element ids (as resolve gives them).
  function procedures(recs, elements, resolve = null) {
    const el = x => (resolve && resolve(x)) || x;
    const want = new Set(list(elements).map(el));
    const invalid = [], out = [];
    for (const r of list(recs)) {
      if (!r || !r.rec) continue;
      const errors = Records.validate('procedure', r.rec);
      if (errors.length) { invalid.push({ id: r.rec.id == null ? null : String(r.rec.id), path: r.path || null, errors }); continue; }
      if (Records.status(r.rec.status) !== 'bound') continue;
      const touches = list(r.rec.scope).some(s => typeof s === 'string' && s.startsWith('el:') && want.has(el(s.slice(3))));
      if (touches) out.push({ ...ref(r.rec, r.text == null ? '' : r.text), title: r.rec.title, steps: list(r.rec.steps).map(String) });
    }
    out.sort((a, b) => byStr(a.id, b.id) || byStr(a.version, b.version));
    return { procedures: out, invalid };
  }

  function episodes(events, { items = [] } = {}) {
    const itemOf = new Map(), handoverOf = new Map(), taskEls = new Map();
    for (const e of events) {
      if (e.kind === 'handover' && typeof e.item === 'string') itemOf.set(e.handover, e.item);
      else if (e.kind === 'run_started' && typeof e.run === 'string') handoverOf.set(e.run, e.handover);
      else if (e.kind === 'task' && typeof e.run === 'string' && typeof e.element === 'string') {
        const k = `${e.run}\u0000${e.task}`;
        taskEls.set(k, uniq([...(taskEls.get(k) || []), e.element]));
      }
    }
    const els = new Map(list(items).filter(i => i && i.id != null).map(i => [String(i.id), list(i.elements).map(String)]));
    return Ledger.taskOutcomes(events).map(o => {
      const item = itemOf.get(handoverOf.get(o.run)) || null;
      const fromItem = item && els.has(item) ? els.get(item) : [];
      return { ...o, item, elements: uniq(fromItem.length ? fromItem : taskEls.get(`${o.run}\u0000${o.task}`) || []).sort(byStr) };
    });
  }

  const passed = e => e.outcome === 'passed' && !e.ref;

  // The episodes about any of the elements, newest first.
  function recall(eps, elements, { resolve = null, limit = 20 } = {}) {
    const el = x => (resolve && resolve(x)) || x;
    const want = new Set(list(elements).map(el));
    return list(eps).filter(e => e.elements.some(n => want.has(el(n)))).reverse().slice(0, limit);
  }

  function count(eps) {
    const c = { passed: 0, failed: 0, open: 0, causes: {} };
    for (const e of eps) {
      if (!e.final) { c.open++; continue; }
      if (passed(e)) { c.passed++; continue; }
      c.failed++;
      if (e.cause) c.causes[e.cause] = (c.causes[e.cause] || 0) + 1;
    }
    return c;
  }

  function summary(eps) { return { tasks: list(eps).length, ...count(list(eps)) }; }

  // Per procedure id and version (and hash), over final episodes: uses, passed, failed, success (delivered), causes.
  function procedureStats(eps) {
    const rows = new Map();
    list(eps).forEach((e, i) => {
      if (!e.final) return;
      for (const p of list(e.procedures)) {
        const k = `${p.id}\u0000${p.version}\u0000${p.hash}`;
        if (!rows.has(k)) rows.set(k, { id: p.id, version: p.version, hash: p.hash, eps: [], last: i });
        const r = rows.get(k); r.eps.push(e); r.last = i;
      }
    });
    return [...rows.values()].map(r => {
      const c = count(r.eps);
      return { id: r.id, version: r.version, hash: r.hash, uses: r.eps.length, passed: c.passed, failed: c.failed, success: r.eps.filter(e => e.success).length, causes: c.causes, last: r.last };
    }).sort((a, b) => byStr(a.id, b.id) || byStr(a.version, b.version) || byStr(a.hash, b.hash));
  }

  return { ref, procedures, episodes, recall, summary, procedureStats };
});
