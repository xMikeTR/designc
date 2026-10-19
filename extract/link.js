// Cross-scanner linking: matches consumes against provides to produce edges, and reports
// anything that couldn't be matched.
// - queue: exact key match only (unchanged since slice 1).
// - http/hub: a consume matches a provide of the same kind when the normalised keys are equal,
//   or when the provide is a whole-segment prefix of the consume (longest wins). Matches are
//   grouped by provider deployable: exactly one -> one sync/realtime edge; more than one ->
//   tie-break by the consume's devTarget port against each candidate's element.ports, else one
//   unresolved entry naming every candidate and no edge; no match -> unresolved.
// - bindings: a consume with no key (env-only: a hub/http var, or an unresolved "%Name%" queue
//   setting) whose env matches a key in opts.bindings links to the element with that binding's
//   name (created if it doesn't exist yet), with synthetic evidence pointing at designc.json.
function link(facts, opts = {}) {
  const { elements, consumes, provides } = facts;
  const nameOf = k => (elements.get(k) || { name: String(k) }).name;
  const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const edges = [];
  // pair = { from: evidence, to: evidence|null, call?: string } pins the edge end to end for the
  // component layer; it is collected on e.pairs and never reaches facts.edges.
  const addEdge = (from, to, kind, label, tech, evidence, pair) => {
    let e = edges.find(x => x.from === from && x.to === to && x.kind === kind);
    if (!e) { e = { from, to, kind, label, tech, evidence: [] }; edges.push(e); }
    e.evidence.push(evidence);
    if (pair) (e.pairs = e.pairs || []).push(pair);
    return e;
  };
  const unresolved = [];
  const internal = []; // queue links whose send and receive sit in the same deployable
  const bindings = opts.bindings || {};

  const segsOf = k => String(k).split('/').filter(Boolean);
  const isProperPrefix = (provideKey, consumeKey) => {
    const pSegs = segsOf(provideKey), cSegs = segsOf(consumeKey);
    if (pSegs.length >= cSegs.length) return false;
    return pSegs.every((seg, i) => seg === cSegs[i]);
  };

  // ---- http (sync) and hub (realtime) route linking, keyed consumes only
  function linkRouted(kind, edgeKind, tech) {
    const cs = consumes.filter(c => c.kind === kind && c.key != null);
    const ps = provides.filter(p => p.kind === kind && p.key != null);
    const agg = new Map(); // `${from}|${to}` -> Set of matched consume keys

    for (const c of cs) {
      const exact = ps.filter(p => p.key === c.key);
      let matches = exact;
      if (!matches.length) {
        const prefixed = ps.filter(p => isProperPrefix(p.key, c.key));
        if (prefixed.length) {
          const maxLen = Math.max(...prefixed.map(p => segsOf(p.key).length));
          matches = prefixed.filter(p => segsOf(p.key).length === maxLen);
        }
      }
      if (!matches.length) {
        unresolved.push({ where: nameOf(c.owner), what: `calls "${c.key}" but no provider of it was found in this repo`, ...c.evidence });
        continue;
      }
      const owners = [...new Set(matches.map(p => p.owner))];
      let targetOwner = owners.length === 1 ? owners[0] : null;
      if (targetOwner == null && c.devTarget) {
        let port; try { port = new URL(c.devTarget).port; } catch { port = null; }
        if (port) {
          const byPort = owners.filter(o => ((elements.get(o) || {}).ports || []).includes(port));
          if (byPort.length === 1) targetOwner = byPort[0];
        }
      }
      if (targetOwner == null) {
        const names = owners.map(nameOf).join(', ');
        unresolved.push({ where: nameOf(c.owner), what: `calls "${c.key}", which is provided by more than one deployable (${names}) and could not be disambiguated`, ...c.evidence });
        continue;
      }
      const aggKey = `${c.owner}|${targetOwner}`;
      if (!agg.has(aggKey)) agg.set(aggKey, new Set());
      agg.get(aggKey).add(c.key);
      const provider = matches.find(p => p.owner === targetOwner);
      const e = addEdge(c.owner, targetOwner, edgeKind, 'Calls', tech, c.evidence, { from: c.evidence, to: provider.evidence, call: c.key });
      e.label = `Calls ${agg.get(aggKey).size} endpoint(s)`;
    }
  }
  linkRouted('http', 'sync', 'HTTP');
  linkRouted('hub', 'realtime', 'SignalR');

  // ---- queue (unchanged): exact key match only
  const sends = consumes.filter(c => c.kind === 'queue');
  const receives = provides.filter(p => p.kind === 'queue');
  for (const snd of sends) {
    if (snd.key == null) continue; // env-only: deferred to the bindings pass below
    const same = receives.filter(r => r.key === snd.key && r.owner === snd.owner);
    for (const r of same) internal.push({ owner: nameOf(snd.owner), kind: 'queue', key: snd.key, send: snd.evidence, receive: r.evidence });
    const rcv = receives.filter(r => r.key === snd.key && r.owner !== snd.owner);
    if (!rcv.length && !same.length) unresolved.push({ where: nameOf(snd.owner), what: `publishes to "${snd.key}" but no consumer of it was found in this repo`, ...snd.evidence });
    for (const r of rcv) addEdge(snd.owner, r.owner, 'async', `Sends via "${snd.key}"`, 'Azure Service Bus',
      { ...snd.evidence, text: `send to "${snd.key}" (${snd.evidence.file}:${snd.evidence.line}), received at ${r.evidence.file}:${r.evidence.line}` },
      { from: snd.evidence, to: r.evidence });
  }
  for (const r of receives) {
    if (r.key == null) { if (r.env) unresolved.push({ where: nameOf(r.owner), what: `provides a queue whose name depends on unbound setting "${r.env}"`, ...r.evidence }); continue; }
    if (!sends.some(s => s.key === r.key)) unresolved.push({ where: nameOf(r.owner), what: `consumes "${r.key}" but no publisher was found in this repo`, ...r.evidence });
  }

  // ---- designc.json bindings: any env-only consume (key === null, env set), regardless of kind
  const envOnly = consumes.filter(c => c.key == null && c.env);
  for (const c of envOnly) {
    const targetName = bindings[c.env];
    if (!targetName) {
      unresolved.push({ where: nameOf(c.owner), what: `needs "${c.env}" but no binding for it was found in designc.json`, ...c.evidence });
      continue;
    }
    const targetKey = keyOf(targetName);
    if (!elements.has(targetKey)) elements.set(targetKey, { name: targetName, kind: 'external', tech: 'External system', evidence: [] });
    const edgeKind = c.kind === 'hub' ? 'realtime' : c.kind === 'queue' ? 'async' : 'sync';
    const tech = c.kind === 'hub' ? 'SignalR' : c.kind === 'queue' ? 'Azure Service Bus' : 'HTTP';
    const evidence = { file: 'designc.json', line: 1, text: `binding ${c.env} -> ${targetName} (declared in designc.json, not extracted)` };
    addEdge(c.owner, targetKey, edgeKind, 'Calls', tech, evidence, { from: c.evidence, to: null, call: c.key || c.env });
  }

  return { edges, unresolved, internal };
}

module.exports = { link };
