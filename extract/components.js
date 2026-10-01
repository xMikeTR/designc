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
    if (!mod) { unresolved.push({ where: elements.get(u.owner).name, what: `no component rule for "${u.file}"`, ...u.evidence }); continue; }
    const result = mod.assign(u);
    if (!result) { unresolved.push({ where: elements.get(u.owner).name, what: `no component rule matched "${u.file}"`, ...u.evidence }); continue; }
    const compKey = keyOf(result.name);
    const mapKey = `${u.owner}|${compKey}`;
    if (!components.has(mapKey)) components.set(mapKey, { key: compKey, name: result.name, owner: u.owner, basis: result.basis, evidence: [] });
    components.get(mapKey).evidence.push(result.evidence);
  }

  const ctx = { components, elements };
  const componentEdges = [...cs.edges(ctx), ...js.edges(ctx)];

  return { components, componentEdges, unresolved };
}

module.exports = { build };
