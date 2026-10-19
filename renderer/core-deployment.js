// ===== designc core: deployment views =====
// Part of Core, split out of core.js with no behaviour change. Dual-loaded like core.js: a classic script in the
// renderer (after core.js) and required by core.js under Node. It reads what it needs from Core and adds its functions to it.
(Core => {
  // Everything the picker offers: each declared view, then "All of <environment>". `id` is `view:<key>` or `env:<name>`.
  function deploymentChoices(model) {
    const dep = model.deployment || { environments: [], views: [] };
    const views = dep.views.map(v => ({ id: `view:${v.key || v.scope}`, label: `${v.key || v.scope} \u00b7 ${v.scope === '*' ? '*' : (model.elements.get(v.system) || { name: v.scope }).name} \u00b7 ${v.environment}`, env: dep.environments.find(e => e.name === v.environment), view: v }));
    return [...views, ...dep.environments.map(e => ({ id: `env:${e.name}`, label: `All of ${e.name}`, env: e, view: null }))];
  }

  // What the Deployment view shows: `wanted` (from `designc.json`) is a view key first, then an environment name; a view wins a
  // clash. With nothing wanted, the only environment. `view` is null when the whole environment is meant.
  function deploymentView(model, wanted) {
    const envs = (model.deployment && model.deployment.environments) || [];
    const views = (model.deployment && model.deployment.views) || [];
    const choices = envs.map(e => e.name);
    if (wanted) {
      const view = views.find(v => (v.key || v.scope) === wanted);
      if (view) return { env: envs.find(e => e.name === view.environment), view, choices };
      const env = envs.find(e => e.name === wanted);
      if (env) return { env, view: null, choices };
      const keys = views.map(v => v.key || v.scope);
      return { error: `designc.json deployment names "${wanted}", which this model does not declare. Choose one of: ${[...keys, ...choices].join(', ') || 'none declared'}.`, choices };
    }
    return envs.length === 1 ? { env: envs[0], view: null, choices } : { choices };
  }

  // The software system an element belongs to (itself, for a system), or null for a person.
  function systemOf(model, id) {
    for (let e = model.elements.get(id); e; e = e.parent ? model.elements.get(e.parent) : null) if (e.kind === 'softwareSystem') return e;
    return null;
  }

  // Group `[{id, name}]` by software system, sorted by system name; elements outside any system come last.
  function bySystem(model, items) {
    const groups = new Map();
    for (const it of items) {
      const sys = systemOf(model, it.id), key = sys ? sys.id : null;
      if (!groups.has(key)) groups.set(key, { system: sys ? sys.name : null, id: key, items: [] });
      groups.get(key).items.push(it);
    }
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    return [...groups.values()].sort((a, b) => (a.system === null) - (b.system === null) || cmp(a.system, b.system));
  }

  // Split impact into the viewed system and the rest: [{here, groups}], an empty side left out. No system means all of it is "here".
  function splitBySystem(model, items, systemId) {
    const groups = bySystem(model, items);
    if (!systemId) return groups.length ? [{ here: true, groups }] : [];
    return [{ here: true, groups: groups.filter(g => g.id === systemId) }, { here: false, groups: groups.filter(g => g.id !== systemId) }].filter(x => x.groups.length);
  }

  // What a deployment view keeps of an environment. Scoped to a system: nodes holding its instances (and their ancestors),
  // infrastructure nodes inside a shown node or linked to a shown instance; other systems' instances in shown nodes collapse
  // to `shared` counts. `*` or no view keeps everything. Returns {scoped, system, nodes, rels, hidden}; each node is
  // {node, path, insts, shared, children}, with `insts` the instance nodes shown and `children` the sub-nodes shown.
  function deploymentScope(model, env, view) {
    const sysId = view && view.system ? view.system : null;
    const scoped = !!sysId;
    const sysName = scoped ? (model.elements.get(sysId) || {}).name : null;
    const isInst = n => n.kind === 'containerInstance' || n.kind === 'softwareSystemInstance';
    const mine = n => { if (!n.ref) return true; const s = systemOf(model, n.ref); return !!s && s.id === sysId; };
    const paths = new Map();
    (function walk(nodes, prefix) { nodes.forEach(n => { const p = prefix ? `${prefix}/${n.name}` : n.name; paths.set(n, p); if (!isInst(n)) walk(n.children, p); }); })(env.nodes, '');
    const shown = new Set(), ancestors = n => { for (let p = paths.get(n); p; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') shown.add(p); };
    const all = [...paths.keys()];
    if (!scoped) all.forEach(n => shown.add(paths.get(n)));
    else {
      for (const n of all) if (isInst(n) && mine(n)) ancestors(n);
      const shownInst = new Set(all.filter(n => isInst(n) && shown.has(paths.get(n))).map(n => paths.get(n)).filter(p => all.some(n => paths.get(n) === p && mine(n))));
      for (const n of all) {
        if (n.kind !== 'infrastructureNode') continue;
        const p = paths.get(n), parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null;
        if ((parent && shown.has(parent)) || (env.rels || []).some(r => (r.src === p && shownInst.has(r.dst)) || (r.dst === p && shownInst.has(r.src)))) ancestors(n);
      }
    }
    const build = nodes => nodes.filter(n => !isInst(n) && shown.has(paths.get(n))).map(n => {
      const insts = n.children.filter(c => isInst(c) && (!scoped || mine(c)));
      const counts = new Map();
      if (scoped) for (const c of n.children.filter(c => isInst(c) && !mine(c))) { const nm = systemOf(model, c.ref).name; counts.set(nm, (counts.get(nm) || 0) + 1); }
      const shared = [...counts].map(([system, count]) => ({ system, count })).sort((a, b) => (a.system < b.system ? -1 : a.system > b.system ? 1 : 0));
      return { node: n, path: paths.get(n), insts, shared, children: build(n.children) };
    });
    const instShown = new Set(all.filter(n => isInst(n) && shown.has(paths.get(n)) && (!scoped || mine(n))).map(n => paths.get(n)));
    const end = p => shown.has(p) || instShown.has(p);
    const nodes = build(env.nodes);
    const rels = (env.rels || []).filter(r => !scoped || end(r.src) || end(r.dst));
    return { scoped, system: sysName, nodes, rels, hidden: all.filter(n => !isInst(n) && !shown.has(paths.get(n))).length };
  }

  Object.assign(Core, { deploymentChoices, deploymentView, deploymentScope, bySystem, splitBySystem });
})(typeof module === 'object' && typeof require === 'function' ? require('./core.js') : Core);
