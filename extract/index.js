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

const SKIP = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', '.idea', 'packages', 'TestResults', 'artifacts', '.venv',
  'dist', 'build', 'coverage', 'out', '.next', 'playwright-report', 'test-results', 'junit-results']);
const MAX_FILES = 20000;
const FILE_RE = /\.(csproj|fsproj|cs|fs|js|jsx|ts|tsx|mjs|cjs|json)$/i;

async function walk(dir, out, depth = 0) {
  if (depth > 12 || out.length > MAX_FILES) return out;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, depth + 1);
    else if (FILE_RE.test(e.name)) out.push(p);
  }
  return out;
}

const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const SCANNERS = [csharp, js];

async function extract(repo, opts = {}) {
  const files = await walk(repo, []);
  const rel = f => path.relative(repo, f).split(path.sep).join('/');
  const read = async f => { try { return await fsp.readFile(f, 'utf8'); } catch { return ''; } };
  const ctx = { repo, files, rel, read, opts };

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

  for (const scanner of SCANNERS) {
    const facts = await scanner.scan(ctx);
    for (const p of facts.projects || []) projects.push(p);
    for (const e of facts.elements || []) {
      const { name, kind, tech, evidence, ...extra } = e;
      const el = add(name, kind, tech, extra);
      el.evidence.push(...evidence);
    }
    for (const e of facts.edges || []) for (const oneEv of e.evidence) addEdge(e.from, e.to, e.kind, e.label, e.tech, oneEv);
    consumes.push(...(facts.consumes || []));
    provides.push(...(facts.provides || []));
    unresolved.push(...(facts.unresolved || []));
    units.push(...(facts.units || []));
  }

  if (!projects.length) return { error: 'No .NET projects (.csproj, .fsproj) or package.json files found in this folder.' };

  const linked = link.link({ elements, consumes, provides }, opts);
  edges.push(...linked.edges);
  unresolved.push(...linked.unresolved);
  const internal = linked.internal;

  const comp = await components.build({ elements, units, edges, internal, read: f => read(path.join(repo, f)) }, opts);

  const compFacts = [...comp.components.values()].map(c => ({ id: `c_${c.owner}_${c.key}`, container: elements.get(c.owner).name, files: [...new Set(c.evidence.map(v => v.file))].sort() }));
  const codeFacts = await code.build({ components: compFacts, read: f => read(path.join(repo, f)) });

  const repoName = path.basename(repo);
  const renderedDsl = dsl.render(repoName, elements, edges, comp.components, comp.componentEdges);

  const els = [...elements.values()];
  const facts = {
    repo: repoName, extractedAt: new Date().toISOString(),
    projects,
    elements: els.map(e => ({ key: keyOf(e.name), name: e.name, kind: e.kind, tech: e.tech, project: e.project || null,
      ...(e.role ? { role: e.role } : {}), ...(e.ports && e.ports.length ? { ports: e.ports } : {}), evidence: e.evidence })),
    edges: edges.map(e => ({ from: elements.get(e.from).name, to: elements.get(e.to).name, kind: e.kind, label: e.label, tech: e.tech, evidence: e.evidence })),
    unresolved: [...unresolved, ...comp.unresolved, ...codeFacts.unresolved],
    components: [...comp.components.values()].map(c => ({
      id: `c_${c.owner}_${c.key}`, key: c.key, container: elements.get(c.owner).name, name: c.name, owner: elements.get(c.owner).name,
      basis: c.basis, tech: '', files: [...new Set(c.evidence.map(v => v.file))].sort(), evidence: c.evidence,
    })),
    internal,
    componentEdges: comp.componentEdges,
    code: { types: codeFacts.types, typeEdges: codeFacts.typeEdges },
  };
  return { dsl: renderedDsl, facts, stats: { projects: projects.length, deployables: projects.filter(p => ['web', 'worker', 'app'].includes(p.kind)).length, tests: projects.filter(p => p.kind === 'test').length, elements: els.length, edges: edges.length, unresolved: unresolved.length } };
}

module.exports = { extract };
