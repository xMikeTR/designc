// ===== designc core: forecast =====
// Part of Core, split out of core.js with no behaviour change. Dual-loaded like core.js: a classic script in the
// renderer (after core.js) and required by core.js under Node. It reads what it needs from Core and adds its functions to it.
(Core => {
  const { parse, diffModels, resolveElement } = Core;
  // ---------- forecast ----------
  // What a handover is likely to cost, priced by the elements it changes against the previous handover's model
  // (`before` null means the first handover: everything counts as added). `history` is
  // Map(element id or name -> [{handover, tokens, cost}]) from Ledger.elementHistory, passed in as plain data so
  // Core does not depend on Ledger. An element with at least `minSamples` handovers of history is measured:
  // the median is the expected figure and the nearest-rank p90 the high end. Otherwise it is "no basis" and
  // adds nothing, and `coverage` says how many changed elements were priced. Containers and components only.
  function forecast({ before, after, history, minSamples = 3 }) {
    const diff = diffModels(before || parse('workspace { model { } }'), after);
    const priced = new Map(); // name -> why
    const mark = (name, why) => { if (name != null && !priced.has(name)) priced.set(name, why); };
    for (const e of diff.elements.filter(x => x.change === 'added')) mark(e.name, 'added');
    for (const e of diff.elements.filter(x => x.change === 'changed')) mark(e.name, 'changed');
    for (const r of diff.rels) for (const n of r.ends || []) mark(n, 'relationship');
    // History keys are elements.json ids or names. Each is resolved against `after`; keys that reach the same
    // element are merged per handover. A key that resolves to no single element (an ambiguous name) is dropped.
    const raw = history instanceof Map ? history : new Map(Object.entries(history || {}));
    const hasHistory = new Map();
    for (const [k, rowsFor] of raw) {
      const el = resolveElement(after, k);
      if (!el) continue;
      const byHandover = hasHistory.get(el.id) || new Map();
      for (const r of rowsFor) {
        const cur = byHandover.get(r.handover);
        byHandover.set(r.handover, cur ? { ...cur, tokens: cur.tokens + r.tokens, cost: cur.cost + r.cost } : { ...r });
      }
      hasHistory.set(el.id, byHandover);
    }
    const rows = [];
    for (const [name, why] of priced) {
      const same = [...after.elements.values()].filter(x => x.name === name && (x.kind === 'container' || x.kind === 'component'));
      if (!same.length) continue;
      // The changed set is judged by name, so a name two elements share cannot be told apart: no basis.
      const ambiguous = same.length > 1;
      const h = ambiguous ? [] : [...(hasHistory.get(same[0].id) || new Map()).values()];
      const row = { name, kind: same[0].kind, why, samples: h.length, status: 'no basis', expected: null, high: null };
      if (ambiguous) row.ambiguous = true;
      if (h.length >= minSamples) {
        const pick = key => {
          const v = h.map(x => x[key]).sort((a, b) => a - b), mid = v.length >> 1;
          return { expected: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, high: v[Math.ceil(0.9 * v.length) - 1] };
        };
        const t = pick('tokens'), c = pick('cost');
        Object.assign(row, { status: 'measured', expected: { tokens: t.expected, cost: c.expected }, high: { tokens: t.high, cost: c.high } });
      }
      rows.push(row);
    }
    const sum = (key, f) => rows.reduce((s, r) => s + (r[key] ? r[key][f] : 0), 0);
    const round = x => Math.round(x * 1e6) / 1e6;
    const total = { expected: { tokens: sum('expected', 'tokens'), cost: round(sum('expected', 'cost')) }, high: { tokens: sum('high', 'tokens'), cost: round(sum('high', 'cost')) } };
    return { rows, removed: diff.elements.filter(x => x.change === 'removed').map(x => x.name), total, coverage: { priced: rows.filter(r => r.status === 'measured').length, changed: rows.length } };
  }

  // The part of a forecast that is frozen into handover.yaml: the figures, how many elements they cover and
  // one row per priced element. `baseline` is the id of the handover it was compared against (null for the first).
  function freezeForecast(f, { currency = 'GBP', baseline = null } = {}) {
    return {
      currency, baseline,
      tokens: { expected: f.total.expected.tokens, high: f.total.high.tokens },
      cost: { expected: f.total.expected.cost, high: f.total.high.cost },
      coverage: f.coverage,
      elements: f.rows.map(r => ({ name: r.name, why: r.why, status: r.status, samples: r.samples,
        tokens: r.expected ? { expected: r.expected.tokens, high: r.high.tokens } : null,
        cost: r.expected ? { expected: r.expected.cost, high: r.high.cost } : null })),
      removed: f.removed,
    };
  }

  // Plain text for a leadership update: the frozen forecast against what was actually spent. Nothing is sent
  // anywhere; the Build view copies it to the clipboard. `forecast` is the frozen block (or null), `actual`
  // is Ledger.handoverActuals (or null).
  function forecastSummary({ id, created, requirements = [], forecast, actual }) {
    const num = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const cur = forecast && forecast.currency || 'GBP';
    const money = n => `${cur} ${n.toFixed(2)}`;
    const signed = (n, f) => (n < 0 ? '-' : '+') + f(Math.abs(n));
    const lines = [`Handover ${id} (${String(created).slice(0, 10)})`];
    if (requirements.length) lines.push(`Requirements: ${requirements.join(', ')}`);
    if (!forecast) lines.push('Forecast: not recorded (frozen before forecasts existed)');
    else {
      lines.push(`Forecast: ${num(forecast.tokens.expected)} tokens, ${money(forecast.cost.expected)} (up to ${num(forecast.tokens.high)} tokens, ${money(forecast.cost.high)})`);
      const { priced, changed } = forecast.coverage;
      lines.push(priced === changed ? `Covers all ${changed} changed elements` : `Covers ${priced} of ${changed} changed elements; ${changed - priced} has no history yet`.replace(/; (\d+) has/, (m, n) => `; ${n} ${n === '1' ? 'has' : 'have'}`));
    }
    if (!actual || (!actual.tasks && !actual.closed)) lines.push('Actual: none recorded yet');
    else {
      lines.push(`Actual ${actual.closed ? `(${actual.closed})` : 'so far (in progress)'}: ${num(actual.tokens)} tokens, ${money(actual.cost)} across ${actual.tasks} ${actual.tasks === 1 ? 'task' : 'tasks'}`);
      if (forecast) {
        const dt = actual.tokens - forecast.tokens.expected, dc = actual.cost - forecast.cost.expected;
        lines.push(`Difference: ${signed(dt, num)} tokens${forecast.tokens.expected ? ` (${signed(dt, x => Math.round(100 * x / forecast.tokens.expected) + '%')})` : ''}, ${signed(dc, money)}`);
      }
      if (actual.afterClose) lines.push(`${actual.afterClose} ${actual.afterClose === 1 ? 'task' : 'tasks'} recorded after close, not counted`);
    }
    return lines.join('\n');
  }


  Object.assign(Core, { forecast, freezeForecast, forecastSummary });
})(typeof module === 'object' && typeof require === 'function' ? require('./core.js') : Core);
