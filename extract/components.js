// The component seam: aggregates scanner Units into per-container components. Owns key/id
// precedence and delegates language-specific assignment to components-cs.js and components-js.js
// (interface: assign(unit) -> { name, basis, evidence } | null, plus edges(ctx) -> []). A unit
// that no language module can classify becomes an unresolved entry instead of being dropped
// silently.
const cs = require('./components-cs');
const js = require('./components-js');

const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const CS_RE = /\.(cs|fs)$/i;
const JS_RE = /\.(js|jsx|ts|tsx|mjs|cjs)$/i;
const moduleFor = file => CS_RE.test(file) ? cs : JS_RE.test(file) ? js : null;

function build(facts, opts = {}) {
  const { elements, units } = facts;
  const components = new Map(); // "ownerKey|compKey" -> { key, name, owner, basis, evidence: [] }
  const unresolved = [];

  for (const u of units || []) {
    const mod = moduleFor(u.file);
    const relFromRoot = u.file.startsWith(u.root + '/') ? u.file.slice(u.root.length + 1) : u.file.split('/').pop();
    const evidence = { file: u.file, line: 1, text: u.file.split('/').pop() };
    for (const owner of u.owners) {
      const unit = { ...u, owner, relFromRoot, evidence };
      const where = elements.get(owner).name;
      // rule 4: a library project/package is one component, named after it, inside each owner
      const result = u.projectKind === 'library' ? { name: u.project, basis: 'library', evidence } : mod && mod.assign(unit);
      if (!result) { unresolved.push({ where, what: `no component rule matched "${u.file}"`, ...evidence }); continue; }
      const compKey = keyOf(result.name);
      const mapKey = `${owner}|${compKey}`;
      if (!components.has(mapKey)) components.set(mapKey, { key: compKey, name: result.name, owner, basis: result.basis, evidence: [] });
      components.get(mapKey).evidence.push(result.evidence);
    }
  }

  const ctx = { components, elements };
  const componentEdges = [...cs.edges(ctx), ...js.edges(ctx)];

  return { components, componentEdges, unresolved };
}

module.exports = { build };
