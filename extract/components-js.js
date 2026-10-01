// Component assignment for JS/TS units: the same rule 8 (first folder) and rule 5 (App shell) as
// components-cs.js, but a conventional "src/" wrapper folder is stripped first - it is not itself
// a component, the first folder below it is.
function assign(unit) {
  let p = unit.relFromRoot;
  if (p.startsWith('src/')) p = p.slice(4);
  const segs = p.split('/').filter(Boolean);
  if (segs.length <= 1) return { name: 'App shell', basis: 'app-shell', evidence: unit.evidence };
  return { name: segs[0], basis: 'first-folder', evidence: unit.evidence };
}
function edges(ctx) { return []; }

module.exports = { assign, edges };
