// Component assignment for C#/F# units: rule 8 (first folder) names the component after the
// first path segment below the project root; rule 5 (App shell) catches files directly in the
// root, where there is no folder to name a component after.
function assign(unit) {
  const segs = unit.relFromRoot.split('/').filter(Boolean);
  if (segs.length <= 1) return { name: 'App shell', basis: 'app-shell', evidence: unit.evidence };
  return { name: segs[0], basis: 'first-folder', evidence: unit.evidence };
}
function edges(ctx) { return []; }

module.exports = { assign, edges };
