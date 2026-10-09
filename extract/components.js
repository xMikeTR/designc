// The component seam: aggregates scanner Units into per-container components and pins container
// edges to them. Owns key/id precedence and delegates language-specific assignment to
// components-cs.js and components-js.js (interface: assign(unit, index) -> { name, basis,
// evidence } | null, optional async prepare(units, read) -> index, plus edges(ctx) -> []). A unit
// that no language module can classify becomes an unresolved entry instead of being dropped.
//
// componentEdges layers built here: (a) every container edge pinned end to end, (b) same-container
// queue links. Rollup invariant: folding each end to its container and dropping self-loops gives
// exactly the (from, to, kind) set of facts.edges, so a pinned end that can't be resolved falls
// back to the container element itself rather than disappearing.
const path = require('path');
const cs = require('./components-cs');
const js = require('./components-js');
const glob = require('./glob');

const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const CS_RE = /\.(cs|fs)$/i;
const JS_RE = /\.(js|jsx|ts|tsx|mjs|cjs)$/i;
const moduleFor = file => CS_RE.test(file) ? cs : JS_RE.test(file) ? js : null;
const APP_SHELL = 'App shell';
const dirOf = f => path.posix.dirname(f);

async function build(facts, opts = {}) {
  const { elements, units, read } = facts;
  const edges = facts.edges || [];
  const internal = facts.internal || [];
  const csIndex = await cs.prepare(units || [], read);
  const unresolved = [];

  // ---- assignment: "ownerKey|name" -> { name, owner, basis, evidence: [] }
  const byName = new Map();
  const fileComp = new Map(); // "ownerKey|file" -> component entry
  const projects = new Map(); // ownerKey -> [{ root, kind, comp }] for pinning non-source files
  const entry = (owner, name, basis) => {
    const k = `${owner}|${name}`;
    if (!byName.has(k)) byName.set(k, { name, owner, basis, evidence: [] });
    return byName.get(k);
  };
  // rule 1: designc.json extract.components overrides, first matching entry wins
  const specs = [], globHit = new Set();
  const OVR = (what) => ({ where: 'designc.json', what, file: 'designc.json', line: 1, text: 'extract.components' });
  (Array.isArray(opts.components) ? opts.components : []).forEach((o, i) => {
    const ok = o && typeof o.name === 'string' && o.name.trim() && Array.isArray(o.paths) && o.paths.length && o.paths.every(g => typeof g === 'string' && g);
    if (!ok) { unresolved.push(OVR(`extract.components entry ${i + 1} needs a string "name" and a non-empty "paths" array of globs`)); return; }
    for (const g of o.paths) { const why = glob.problem(g); if (why) unresolved.push(OVR(`extract.components "${o.name.trim()}": ${why}`)); }
    specs.push({ name: o.name.trim(), paths: o.paths });
  });
  const deferred = []; // output-binding results follow their function class, wherever it ended up
  for (const u of units || []) {
    for (const s of specs) for (const g of s.paths) if (glob.match(g, u.file)) globHit.add(`${s.name}\n${g}`);
    const spec = specs.find(s => s.paths.some(g => glob.match(g, u.file)));
    const mod = moduleFor(u.file);
    const relFromRoot = u.file.startsWith(u.root + '/') ? u.file.slice(u.root.length + 1) : u.file.split('/').pop();
    const evidence = { file: u.file, line: 1, text: u.file.split('/').pop() };
    for (const owner of u.owners) {
      const unit = { ...u, owner, relFromRoot, evidence };
      const where = elements.get(owner).name;
      // rule 4: a library project/package is one component, named after it, inside each owner
      const result = spec ? { name: spec.name, basis: 'override', evidence } : u.projectKind === 'library' ? { name: u.project, basis: 'library', evidence } : mod && mod.assign(unit, mod === cs ? csIndex : undefined);
      if (!result) { unresolved.push({ where, what: `no component rule matched "${u.file}"`, ...evidence }); continue; }
      if (result.basis === 'output-binding' && result.anchorFile) { deferred.push({ owner, u, result }); }
      else { const comp = entry(owner, result.name, result.basis); comp.evidence.push(result.evidence); fileComp.set(`${owner}|${u.file}`, comp); }
      if (!projects.has(owner)) projects.set(owner, []);
      if (u.projectKind === 'library') projects.get(owner).push({ root: u.root, library: fileComp.get(`${owner}|${u.file}`) });
      else projects.get(owner).push({ root: u.root, library: null });
    }
  }

  for (const { owner, u, result } of deferred) {
    const anchor = fileComp.get(`${owner}|${result.anchorFile}`);
    const comp = anchor || entry(owner, result.name, result.basis);
    comp.evidence.push(result.evidence);
    fileComp.set(`${owner}|${u.file}`, comp);
  }
  for (const s of specs) for (const g of s.paths) if (!globHit.has(`${s.name}\n${g}`) && !glob.problem(g)) unresolved.push(OVR(`extract.components "${s.name}": "${g}" matches no source file`));

  // ---- keys: components sort by name per container; a key collision gets _2, _3 in that order
  const components = new Map();
  const sorted = [...byName.values()].sort((a, b) => a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : a.name.localeCompare(b.name, 'en'));
  const taken = new Set();
  for (const c of sorted) {
    const base = keyOf(c.name) || 'component';
    let key = base, n = 1;
    while (taken.has(`${c.owner}|${key}`)) key = `${base}_${++n}`;
    taken.add(`${c.owner}|${key}`);
    c.key = key;
    components.set(`${c.owner}|${key}`, c);
  }
  const idOf = c => `c_${c.owner}_${c.key}`;
  const elementId = key => 'e_' + key;

  // ---- ends: where a piece of evidence lands inside a container
  const appShell = owner => {
    const existing = [...components.values()].find(c => c.owner === owner && c.name === APP_SHELL);
    if (existing) return existing;
    const c = { name: APP_SHELL, owner, basis: 'app-shell', evidence: [], key: APP_SHELL_KEY(owner, taken) };
    taken.add(`${owner}|${c.key}`);
    components.set(`${owner}|${c.key}`, c);
    return c;
  };
  // a file that isn't a source unit (.csproj, package.json, appsettings, designc.json) maps to the
  // deepest project it sits in: a library to its library component, a deployable to App shell
  const componentFor = (owner, file) => {
    const hit = fileComp.get(`${owner}|${file}`);
    if (hit) return hit;
    const projs = projects.get(owner) || [];
    if (!projs.length) return null;
    const d = dirOf(file);
    const match = projs.filter(p => p.root === d || dirOf(p.root) === d).sort((a, b) => b.root.length - a.root.length)[0];
    return match && match.library ? match.library : appShell(owner);
  };
  const isDeployable = key => elements.get(key) && elements.get(key).kind === 'container';

  const keyOfName = new Map([...elements].map(([k, e]) => [e.name, k]));
  const out = new Map(); // "from|to|kind" -> componentEdge
  const calls = new Map(); // same key -> Set of distinct pair.call values
  const addOut = (from, to, kind, label, tech, via, evidence, call) => {
    if (from === to) return;
    const k = `${from}|${to}|${kind}`;
    if (!out.has(k)) out.set(k, { from, to, kind, label, tech, via, evidence: [] });
    for (const ev of evidence) {
      const dup = out.get(k).evidence.some(x => x.file === ev.file && x.line === ev.line && x.text === ev.text);
      if (!dup) out.get(k).evidence.push(ev);
    }
    if (call != null) { if (!calls.has(k)) calls.set(k, new Set()); calls.get(k).add(call); }
  };

  // (a) pinned container edges
  for (const e of edges) {
    const fromKey = typeof e.from === 'string' && elements.has(e.from) ? e.from : keyOfName.get(e.from);
    const toKey = typeof e.to === 'string' && elements.has(e.to) ? e.to : keyOfName.get(e.to);
    const pairs = e.pairs || e.evidence.map(ev => ({ from: ev, to: null }));
    const routed = /^Calls \d+ endpoint\(s\)$/.test(e.label);
    for (const p of pairs) {
      const f = isDeployable(fromKey) ? componentFor(fromKey, p.from.file) : null;
      const t = p.to && isDeployable(toKey) ? componentFor(toKey, p.to.file) : null;
      const ev = [p.from, ...(p.to ? [p.to] : [])];
      const fromId = f ? idOf(f) : elementId(fromKey), toId = t ? idOf(t) : elementId(toKey);
      addOut(fromId, toId, e.kind, e.label, e.tech, 'container-edge', ev, routed ? p.call : null);
    }
  }
  for (const [k, set] of calls) out.get(k).label = `Calls ${set.size} endpoint(s)`;

  // (b) same-container queue links
  for (const l of internal) {
    const owner = keyOfName.get(l.owner);
    const f = componentFor(owner, l.send.file), t = componentFor(owner, l.receive.file);
    if (!f || !t) continue;
    addOut(idOf(f), idOf(t), 'async', `Sends via "${l.key}"`, 'Azure Service Bus', 'queue-internal', [l.send, l.receive]);
  }

  // (c) C# type/DI references and (d) TS/JS imports: intra-container, resolved per language from the units
  const addRef = (from, to, via, evidence) => {
    const candidate = via === 'di-candidate', existing = out.get(`${from}|${to}|sync`);
    if (existing && existing.via === 'di-candidate' && !candidate) { existing.label = 'Uses'; existing.via = via; }
    addOut(from, to, 'sync', candidate ? 'Uses (DI candidate)' : 'Uses', 'in-process', via, evidence);
  };
  for (const lang of [cs, js]) {
    const r = await lang.edges({ units: units || [], read: facts.read, elements });
    for (const x of r.refs) {
      const f = fileComp.get(`${x.owner}|${x.from}`), t = fileComp.get(`${x.owner}|${x.to}`);
      if (f && t) addRef(idOf(f), idOf(t), x.via, x.evidence);
    }
    unresolved.push(...r.unresolved);
  }
  const componentEdges = [...out.values()];

  return { components, componentEdges, unresolved };
}

// App shell created on demand needs a key that doesn't collide with an existing component
function APP_SHELL_KEY(owner, taken) {
  let key = 'appshell', n = 1;
  while (taken.has(`${owner}|${key}`)) key = `appshell_${++n}`;
  return key;
}

module.exports = { build };
