// Deterministic as-built extraction. Walks the repo once, runs every registered scanner over
// the shared context, merges their Facts, links cross-scanner consumes/provides, then renders
// the DSL and stats. Every element and edge carries evidence (file, line, text): nothing is
// guessed, what can't be resolved is reported as "unresolved" instead of becoming an edge.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const csharp = require('./csharp');
const js = require('./js');
const link = require('./link');
const dsl = require('./dsl');
const components = require('./components');
const code = require('./code');
const coverage = require('./coverage');
const intent = require('./intent');
const ui = require('./ui');

const SKIP = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', '.idea', 'packages', 'TestResults', 'artifacts', '.venv',
  'dist', 'build', 'coverage', 'out', '.next', 'playwright-report', 'test-results', 'junit-results']);
// Generated or vendored files that are never the system's own code: MSW's worker, minified and bundled output.
const GENERATED_RE = /(^mockServiceWorker\.js$|\.min\.(js|mjs|cjs)$|\.bundle\.js$|\.generated\.(cs|ts|js)$)/i;
const MAX_FILES = 20000, MAX_LISTED = 100000;
const FILE_RE = /\.(csproj|fsproj|cs|fs|js|jsx|ts|tsx|mjs|cjs|json)$/i;

// `out` holds the source files the scanners read; `all` names every file walked (never read), because
// a coding agent may write any file, so d.code areas are judged against all of them.
async function walk(dir, out, all, depth = 0) {
  if (depth > 12 || out.length > MAX_FILES) return out;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, all, depth + 1);
    else {
      if (all.length < MAX_LISTED) all.push(p);
      if (FILE_RE.test(e.name) && !GENERATED_RE.test(e.name)) out.push(p);
    }
  }
  return out;
}

const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const SCANNERS = [csharp, js];

/* Split repos: `target` is one folder (a string) or a map {Key: folder} of the repos named in designc.json `repos`.
   Each repo is walked and scanned on its own root, so the scanners' absolute-path logic is unchanged; every evidence path
   gets the repo key as a prefix (Api/src/Orders.cs) so the merged facts live in one virtual tree, and one link pass then
   matches what one repo consumes against what another provides. A single folder behaves exactly as before (no prefix). */
async function extract(target, opts = {}) {
  const multi = target !== null && typeof target === 'object';
  const roots = multi ? Object.entries(target).map(([key, root]) => ({ key, root })) : [{ key: null, root: target }];
  if (!roots.length) return { error: 'No repos are declared: add at least one under repos in designc.json.' };
  const relOf = r => f => { const x = path.relative(r.root, f).split(path.sep).join('/'); return r.key ? `${r.key}/${x}` : x; };
  const read = async f => { try { return await fsp.readFile(f, 'utf8'); } catch { return ''; } };
  // A repo-relative path of the merged tree back to a file on disk.
  const diskOf = vrel => {
    if (!multi) return path.join(roots[0].root, vrel);
    const i = vrel.indexOf('/'), r = roots.find(x => x.key === vrel.slice(0, i));
    return r ? path.join(r.root, vrel.slice(i + 1)) : path.join(roots[0].root, vrel);
  };
  const readV = f => read(diskOf(f));
  const listed = [], perRoot = [];
  for (const r of roots) {
    const mine = [], files = await walk(r.root, [], mine);
    listed.push(...mine.map(relOf(r)));
    perRoot.push({ r, files, rel: relOf(r), ctx: { repo: r.root, files, rel: relOf(r), read, opts } });
  }
  const rel = f => relOf(roots[0])(f);

  const projects = [];
  const elements = new Map();
  const add = (name, kind, tech, extra = {}) => { const k = keyOf(name); if (!elements.has(k)) elements.set(k, { name, kind, tech, evidence: [], ...extra }); return elements.get(k); };
  const edges = [];
  const addEdge = (from, to, kind, label, tech, evidence) => {
    let e = edges.find(x => x.from === from && x.to === to && x.kind === kind);
    if (!e) { e = { from, to, kind, label, tech, evidence: [] }; edges.push(e); }
    e.evidence.push(evidence); return e;
  };
  const consumes = [], provides = [];
  const units = [];
  let unresolved = [];

  const scanned = [];
  for (const pr of perRoot) for (const scanner of SCANNERS) scanned.push({ pr, facts: await scanner.scan(pr.ctx) });

  // Two repos that each hold a container of the same name would merge into one element, and every edge would land on the
  // wrong one. Qualify both with their repo ("Orders (Api)") and say so. Stores and external systems merge on purpose:
  // two repos naming the same database or Entra ID mean the same thing.
  const remaps = new Map(); // pr -> Map(oldKey -> { key, name })
  if (multi) {
    const owners = new Map(); // container key -> Set(repo keys)
    for (const { pr, facts } of scanned) for (const e of facts.elements || []) if (e.kind === 'container') {
      const k = keyOf(e.name); if (!owners.has(k)) owners.set(k, new Set()); owners.get(k).add(pr.r.key);
    }
    for (const [k, repos] of owners) if (repos.size > 1) {
      for (const rk of repos) {
        const pr = perRoot.find(x => x.r.key === rk), name = (scanned.flatMap(x => x.facts.elements || []).find(e => keyOf(e.name) === k)).name;
        if (!remaps.has(pr)) remaps.set(pr, new Map());
        remaps.get(pr).set(k, { name: `${name} (${rk})`, key: keyOf(`${name} (${rk})`) });
      }
      unresolved.push({ where: [...repos].join(', '), what: `${repos.size} repos each hold a container named "${(scanned.flatMap(x => x.facts.elements || []).find(e => keyOf(e.name) === k)).name}"; they are kept apart as "<name> (<repo>)"`, file: 'designc.json', line: 1, text: 'repos' });
    }
  }
  const qual = (pr, key) => { const m = remaps.get(pr); return m && m.has(key) ? m.get(key).key : key; };
  for (const { pr, facts } of scanned) {
    const m = remaps.get(pr);
    for (const p of facts.projects || []) projects.push(p);
    for (const e of facts.elements || []) {
      const { name, kind, tech, evidence, ...extra } = e;
      const q = kind === 'container' && m && m.get(keyOf(name));
      const el = add(q ? q.name : name, kind, tech, extra);
      el.evidence.push(...evidence);
    }
    for (const e of facts.edges || []) for (const oneEv of e.evidence) addEdge(qual(pr, e.from), qual(pr, e.to), e.kind, e.label, e.tech, oneEv);
    consumes.push(...(facts.consumes || []).map(c => ({ ...c, owner: qual(pr, c.owner) })));
    provides.push(...(facts.provides || []).map(c => ({ ...c, owner: qual(pr, c.owner) })));
    unresolved.push(...(facts.unresolved || []));
    units.push(...(facts.units || []).map(u => ({ ...u, owners: (u.owners || []).map(o => qual(pr, o)) })));
  }

  if (!projects.length) return { error: 'No .NET projects (.csproj, .fsproj) or package.json files found in this folder.' + (multi ? ' Checked: ' + roots.map(r => r.key).join(', ') + '.' : '') };
  if (![...elements.values()].some(e => e.kind === 'container')) {
    const n = projects.length;
    return { error: `Found ${n} project${n === 1 ? '' : 's'} but nothing that runs: ${projects.map(p => `${p.name} (${p.kind})`).join(', ')}. `
      + 'The code map draws what runs and shows libraries inside the app that references them, so set "codebase" in designc.json to a folder that also holds that app, often the repository root.' };
  }

  const linked = link.link({ elements, consumes, provides }, opts);
  edges.push(...linked.edges);
  unresolved.push(...linked.unresolved);
  const internal = linked.internal;

  const comp = await components.build({ elements, units, edges, internal, read: readV }, opts);

  const compFacts = [...comp.components.values()].map(c => ({ id: `c_${c.owner}_${c.key}`, container: elements.get(c.owner).name, files: [...new Set(c.evidence.map(v => v.file))].sort() }));
  const codeFacts = await code.build({ components: compFacts, read: readV });

  // Coverage reports named by designc.json extract.coverage give each method its `coverage`; without them CRAP stays unknown.
  const cov = multi ? { files: [], problems: opts.coverage ? ['extract.coverage is not supported with repos yet; coverage is not applied'] : [], map: new Map() } : await coverage.load(roots[0].root, opts.coverage);
  const covStats = cov.files.length ? { reports: cov.files, ...coverage.apply({ types: codeFacts.types }, cov.map) } : null;
  const splitNotes = !multi ? [] : [
    ...(opts.ui && opts.ui.screens ? ['ui.screens is not supported with repos yet; no UI graph was built'] : []),
    ...(opts.intent ? ['extract.intent is not supported with repos yet; it was not read'] : []),
  ].map(what => ({ where: 'designc.json', what, file: 'designc.json', line: 1, text: 'repos' }));
  const covProblems = [...splitNotes, ...cov.problems.map(what => ({ where: 'designc.json', what, file: 'designc.json', line: 1, text: 'extract.coverage' }))];

  const repoName = multi ? roots.map(r => r.key).join(' + ') : path.basename(roots[0].root);
  const renderedDsl = dsl.render(repoName, elements, edges, comp.components, comp.componentEdges);

  const els = [...elements.values()];
  const facts = {
    repo: repoName, extractedAt: new Date().toISOString(),
    projects,
    elements: els.map(e => ({ key: keyOf(e.name), name: e.name, kind: e.kind, tech: e.tech, project: e.project || null,
      ...(e.role ? { role: e.role } : {}), ...(e.ports && e.ports.length ? { ports: e.ports } : {}), evidence: e.evidence })),
    edges: edges.map(e => ({ from: elements.get(e.from).name, to: elements.get(e.to).name, kind: e.kind, label: e.label, tech: e.tech, evidence: e.evidence })),
    unresolved: [...unresolved, ...comp.unresolved, ...codeFacts.unresolved, ...covProblems],
    components: [...comp.components.values()].map(c => ({
      id: `c_${c.owner}_${c.key}`, key: c.key, container: elements.get(c.owner).name, name: c.name, owner: elements.get(c.owner).name,
      basis: c.basis, tech: '', files: [...new Set(c.evidence.map(v => v.file))].sort(), evidence: c.evidence,
    })),
    internal,
    componentEdges: comp.componentEdges,
    code: { types: codeFacts.types, typeEdges: codeFacts.typeEdges, ...(covStats ? { coverage: covStats } : {}) },
    ...(multi ? { repos: roots.map(r => r.key) } : {}),
    ...(opts.intent && !multi ? { intent: intent.read(roots[0].root, opts.intent) } : {}),
    // designc.json ui.screens: the UI graph of each named screen (extract/ui.js). Opt-in; absent means no `ui` key.
    ...(opts.ui && opts.ui.screens && !multi ? { ui: ui.build({ repo: roots[0].root, files: perRoot[0].files.map(perRoot[0].rel), ui: opts.ui, keys: opts.uiKeys || [] }) } : {}),
    files: listed.slice().sort(), // every file walked, what d.code areas are judged against (Core.codeAreaDrift)
  };
  return { dsl: renderedDsl, facts, stats: { projects: projects.length, deployables: projects.filter(p => ['web', 'worker', 'app'].includes(p.kind)).length, tests: projects.filter(p => p.kind === 'test').length, elements: els.length, edges: edges.length, unresolved: unresolved.length } };
}

/* The UI graph of one repo and nothing else (phase 7e): a `references` repo (legacy) may hold no project or container,
   so it does not go through extract(). opts: {ui (designc.json ui), key (the references key), keys (all of them)}.
   {ui} or {error}. Read-only, like extract(). */
async function extractUi(repo, opts = {}) {
  const key = opts.key, screens = opts.ui && opts.ui.screens && typeof opts.ui.screens === 'object' ? opts.ui.screens : {};
  if (!Object.values(screens).some(d => d && d[key] != null)) return { error: `no screen names "${key}" in designc.json ui.screens; add its patterns there, for example "${key}": ["src/pages/Tags/**"]` };
  const files = await walk(repo, [], []);
  const rel = f => path.relative(repo, f).split(path.sep).join('/');
  return { ui: { ...ui.build({ repo, files: files.map(rel), ui: opts.ui, key, keys: opts.keys || [] }), extractedAt: new Date().toISOString() } };
}

module.exports = { extract, extractUi };
