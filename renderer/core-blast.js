// ===== designc core: blast radius, change impact and work re-check =====
// Part of Core, split out of core.js with no behaviour change. Dual-loaded like core.js: a classic script in the
// renderer (after core.js) and required by core.js under Node. It reads what it needs from Core and adds its functions to it.
(Core => {
  const { structural } = Core._shared;
  const { interaction } = Core;
  // Called at run time, after every part has loaded.
  const check = (...a) => Core.check(...a);
  const diffModels = (...a) => Core.diffModels(...a);
  const fingerprint = (...a) => Core.fingerprint(...a);
  // ---------- blast radius ----------
  // Who is hurt when one element misbehaves (fails, stalls or answers wrongly). Callers are found by
  // walking relationships backwards. A sync caller goes `down` and the damage continues through it; an
  // async caller is `degraded` (decoupled, so its backlog grows but it stays up) and stops there; a caller
  // whose interaction is undeclared is `unknown` and stops there, because nothing is guessed. An element
  // reached several ways keeps the worst class. `paths` holds one shortest route per affected element.
  const BLAST_RANK = { unknown: 1, degraded: 2, down: 3 };
  // Mode 'unavailable': `ref` is a deployment node path ("Azure/Zone A") in `environment`. An element is
  // lost when every one of its instances in that environment sits under the node; each lost element then
  // spreads as in 'misbehaves', the worst class winning. Lost elements are listed as lost, not as down.
  function unavailableRadius(model, nodePath, environment) {
    const envs = (model.deployment && model.deployment.environments) || [];
    if (!envs.length) return { error: 'This model has no deploymentEnvironment, so unavailability cannot be assessed.' };
    const env = envs.find(e => e.name === environment) || (environment == null && envs.length === 1 ? envs[0] : null);
    if (!env) return { error: `Environment "${environment}" is not declared. Choose one of: ${envs.map(e => e.name).join(', ')}.` };
    const segs = String(nodePath).split('/');
    let list = env.nodes, hit = null;
    for (const s of segs) { hit = list.find(n => n.kind !== 'containerInstance' && n.name === s); if (!hit) break; list = hit.children; }
    if (!hit) return { error: `No deployment node "${nodePath}" in ${env.name}.` };
    const instances = (nodes, out = []) => { for (const n of nodes) { if (n.ref) out.push(n.ref); instances(n.children, out); } return out; };
    const inside = new Set(instances([hit]));
    // an instance counts as outside when it is not under `hit`
    const rest = new Set(); (function walk(nodes) { for (const n of nodes) { if (n === hit) continue; if (n.ref) rest.add(n.ref); walk(n.children); } })(env.nodes);
    const lost = [...inside].filter(id => !rest.has(id));
    const survivors = [...inside].filter(id => rest.has(id));
    const rank = { down: 3, degraded: 2, unknown: 1 };
    const best = new Map(), paths = [];
    for (const id of lost) {
      const r = blastRadius(model, id, { mode: 'misbehaves' });
      for (const p of r.paths) { const eid = [...model.elements.values()].find(e => e.name === p.to).id; if (lost.includes(eid)) continue; const cur = best.get(eid); if (!cur || rank[cur.kind] < rank[p.kind]) best.set(eid, p); }
    }
    const nm = id => model.elements.get(id).name;
    const pick = kind => [...best].filter(([, p]) => p.kind === kind).map(([id]) => ({ id, name: nm(id) }));
    return { node: nodePath, environment: env.name, lost: lost.map(id => ({ id, name: nm(id) })), survivors: survivors.map(id => ({ id, name: nm(id) })),
      down: pick('down'), degraded: pick('degraded'), unknown: pick('unknown'), paths: [...best.values()] };
  }

  function blastRadius(model, elementId, { mode, environment } = {}) {
    if (mode === 'unavailable') return unavailableRadius(model, elementId, environment);
    if (mode !== 'misbehaves') return { error: `Unknown blast radius mode: ${mode}. Supported: misbehaves, unavailable.` };
    if (!model.elements.has(elementId)) return { error: 'No such element' };
    const best = new Map(); // id -> { kind, via: [ids] }
    const queue = [{ id: elementId, via: [elementId] }];
    for (let i = 0; i < queue.length; i++) {
      const { id, via } = queue[i];
      for (const r of model.rels) {
        if (r.dst !== id || r.src === elementId || structural(model, r)) continue;
        const i2 = interaction(r), kind = i2 === 'sync' ? 'down' : i2 === 'async' ? 'degraded' : 'unknown';
        const cur = best.get(r.src);
        if (cur && BLAST_RANK[cur.kind] >= BLAST_RANK[kind]) continue;
        const path = [...via, r.src];
        best.set(r.src, { kind, via: path });
        if (kind === 'down') queue.push({ id: r.src, via: path });
      }
    }
    const pick = kind => [...best].filter(([, v]) => v.kind === kind).map(([id]) => ({ id, name: model.elements.get(id).name }));
    const nm = id => model.elements.get(id).name;
    return {
      down: pick('down'), degraded: pick('degraded'), unknown: pick('unknown'),
      paths: [...best].map(([id, v]) => ({ to: nm(id), kind: v.kind, via: v.via.map(nm) })),
    };
  }

  // ---------- change impact ----------
  // What a model change touches beyond the model: bound decisions whose element (or a rel touching it)
  // changed or went away, requirements tied to those decisions or listing a changed element, and the
  // findings introduced or resolved. Built on diffModels and fingerprint, so it shares their notion of
  // "changed". `decisions` and `requirements` are the registry's parsed files.
  function changeImpact(before, after, { decisions = [], requirements = [], chainHops = 4 } = {}) {
    const diff = diffModels(before, after);
    const touched = new Set();
    for (const e of diff.elements) { touched.add(e.name); if (e.renamedFrom) touched.add(e.renamedFrom); }
    const byName = (m, n) => [...m.elements.values()].find(e => e.name === n) || null;
    const hits = [];
    for (const d of decisions) {
      if (d.status !== 'bound' && d.status !== 'checked') continue;
      for (const name of d.binds || []) {
        const b = byName(before, name), a = byName(after, name);
        let reason = null;
        if (b && !a) reason = 'removed';
        else if (!b && a) reason = 'added';
        else if (b && a && fingerprint(before, b.id).hash !== fingerprint(after, a.id).hash) reason = 'changed';
        if (reason) { hits.push({ id: d.id, element: name, reason: `${name} ${reason}`, requirement: d.requirement || null }); break; }
      }
    }
    const reqIds = new Set(hits.map(h => h.requirement).filter(Boolean));
    for (const r of requirements) if ((r.elements || []).some(n => touched.has(n))) reqIds.add(r.id);
    const keyed = m => new Map(check(m, { chainHops }).filter(f => !f.suppressed && f.sev !== 'note').map(f => [`${f.code}|${f.loc.label}`, { code: f.code, label: f.loc.label, sev: f.sev, msg: f.msg }]));
    const kb = keyed(before), ka = keyed(after);
    return {
      changed: diff.summary.added + diff.summary.removed + diff.summary.changed + diff.summary.relsAdded + diff.summary.relsRemoved + diff.summary.relsChanged,
      decisions: hits.map(({ id, element, reason }) => ({ id, element, reason })),
      requirements: [...reqIds],
      introduced: [...ka].filter(([k]) => !kb.has(k)).map(([, v]) => v),
      resolved: [...kb].filter(([k]) => !ka.has(k)).map(([, v]) => v),
    };
  }

  // ---------- work re-check ----------
  // Has the design moved under a frozen work item? `frozen` is what the item handover recorded: its parsed
  // model copy, `inScope` names and requirement. Reasons: the item's own scope or requirement edited since
  // (`scope`), an in-scope element added, removed or changed by fingerprint (`element`), a bound decision on
  // one of them touched (`decision`), a finding introduced on one (`finding`). Names are compared, as
  // fingerprints are by `changeImpact`; nothing outside the item's elements counts.
  function workRecheck({ item, frozen, model, decisions = [], requirements = [], chainHops = 4 }) {
    const reasons = [];
    const then = new Set(frozen.inScope || []), now = new Set(item.elements || []);
    const added = [...now].filter(n => !then.has(n)), removed = [...then].filter(n => !now.has(n));
    if (added.length || removed.length) {
      const parts = [added.length ? `added ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : ''].filter(Boolean);
      reasons.push({ kind: 'scope', text: `The item's elements changed since it was frozen: ${parts.join('; ')}.` });
    }
    if (frozen.requirement && item.requirement && frozen.requirement !== item.requirement) {
      reasons.push({ kind: 'scope', text: `The item moved from requirement ${frozen.requirement} to ${item.requirement} since it was frozen.` });
    }
    const scope = new Set([...then, ...now]);
    const byName = (m, n) => [...m.elements.values()].find(e => e.name === n) || null;
    for (const n of scope) {
      const b = byName(frozen.model, n), a = byName(model, n);
      if (!b && !a) continue;
      const why = b && !a ? 'removed' : !b && a ? 'added' : fingerprint(frozen.model, b.id).hash !== fingerprint(model, a.id).hash ? 'changed' : null;
      if (why) reasons.push({ kind: 'element', text: `${n} ${why} since the design was frozen.` });
    }
    const imp = changeImpact(frozen.model, model, { decisions, requirements, chainHops });
    for (const d of imp.decisions) if (scope.has(d.element)) reasons.push({ kind: 'decision', text: `${d.id} binds ${d.element}, which ${d.reason.replace(d.element + ' ', '')} since the design was frozen.` });
    for (const f of imp.introduced) if (scope.has(f.label)) reasons.push({ kind: 'finding', text: `${f.code} appeared on ${f.label} since the design was frozen: ${f.msg}` });
    return { stale: reasons.length > 0, reasons };
  }

  Object.assign(Core, { blastRadius, changeImpact, workRecheck });
})(typeof module === 'object' && typeof require === 'function' ? require('./core.js') : Core);
