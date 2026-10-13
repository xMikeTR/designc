/* designc desktop: since last look. Pure, no I/O, no dependencies.
   Dual-load like renderer/work.js: <script src="look.js"> in the renderer, require('./renderer/look.js')
   from tests. `snapshot` keeps what the design says now (gate, findings, decisions, drift, last extraction);
   `diff` says what changed since the snapshot kept at the last look. Display only: never a gate input. */
const Look = (() => {
  const STALE_DAYS = 7;
  const DAY = 86400000;

  function snapshot({ gate, diags = [], decisions = [], drift = null, ledger = [] } = {}) {
    const extractions = ledger.filter(e => e.kind === 'extraction').map(e => e._ts || 0);
    return {
      ready: !!(gate && gate.ready),
      clauses: ((gate && gate.clauses) || []).map(c => c.text),
      findings: [...new Set(diags.filter(d => !d.suppressed).map(d => `${d.code} on ${(d.loc && d.loc.label) || 'the model'}`))],
      decisions: Object.fromEntries(decisions.filter(d => d.id != null).map(d => [String(d.id), d.status || null])),
      drift: drift ? { undeclared: (drift.undeclared || []).length, unrealised: (drift.unrealised || []).length } : null,
      extractedAt: extractions.length ? Math.max(...extractions) : null,
    };
  }

  const valid = s => !!s && typeof s.ready === 'boolean' && Array.isArray(s.clauses) && Array.isArray(s.findings)
    && !!s.decisions && typeof s.decisions === 'object';
  const sets = (before, after) => ({ added: after.filter(x => !before.includes(x)), removed: before.filter(x => !after.includes(x)) });

  function diff(prev, cur, { now = Date.now(), staleDays = STALE_DAYS } = {}) {
    const extraction = cur.extractedAt == null ? null
      : { at: cur.extractedAt, days: Math.floor((now - cur.extractedAt) / DAY), stale: now - cur.extractedAt > staleDays * DAY };
    if (!valid(prev)) return { first: true, gate: null, clauses: sets([], []), findings: sets([], []), decisions: [], drift: null, extraction, count: 0 };
    const gate = prev.ready !== cur.ready ? { from: prev.ready, to: cur.ready } : null;
    const clauses = sets(prev.clauses, cur.clauses), findings = sets(prev.findings, cur.findings);
    const ids = [...new Set([...Object.keys(prev.decisions), ...Object.keys(cur.decisions)])].sort();
    const decisions = ids.map(id => ({ id, from: id in prev.decisions ? prev.decisions[id] : null, to: id in cur.decisions ? cur.decisions[id] : null }))
      .filter(d => d.from !== d.to);
    const p = prev.drift || { undeclared: 0, unrealised: 0 }, c = cur.drift || { undeclared: 0, unrealised: 0 };
    const drift = p.undeclared !== c.undeclared || p.unrealised !== c.unrealised
      ? { undeclared: { from: p.undeclared, to: c.undeclared }, unrealised: { from: p.unrealised, to: c.unrealised } } : null;
    const count = (gate ? 1 : 0) + clauses.added.length + clauses.removed.length + findings.added.length + findings.removed.length
      + decisions.length + (drift ? 1 : 0);
    return { first: false, gate, clauses, findings, decisions, drift, extraction, count };
  }

  return { STALE_DAYS, snapshot, diff };
})();
if (typeof module !== 'undefined') module.exports = Look;
