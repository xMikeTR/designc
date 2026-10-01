// Component assignment for JS/TS units: rule 8 (first folder) and rule 5 (App shell), as in
// components-cs.js. The scanner already roots units at a package's src/ when it has one.
function assign(unit) {
  const segs = unit.relFromRoot.split('/').filter(Boolean);
  if (segs.length <= 1) return { name: 'App shell', basis: 'app-shell', evidence: unit.evidence };
  return { name: segs[0], basis: 'first-folder', evidence: unit.evidence };
}
function edges(ctx) { return []; }

module.exports = { assign, edges };
