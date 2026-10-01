// Renders the as-built Facts (elements, edges) as workspace DSL text.
const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function render(repoName, elements, edges, components = new Map(), componentEdges = []) {
  const id = s => 'e_' + keyOf(s);
  const q = s => JSON.stringify(String(s));
  const els = [...elements.values()];
  const compsByOwner = new Map();
  for (const c of components.values()) { if (!compsByOwner.has(c.owner)) compsByOwner.set(c.owner, []); compsByOwner.get(c.owner).push(c); }
  const compId = (ownerKey, compKey) => `c_${ownerKey}_${compKey}`;
  let dsl = `// As-built model, extracted by designc from ${repoName} on ${new Date().toISOString().slice(0, 10)}.\n// Generated file: edit the design, not this.\nworkspace ${q(repoName + ' (as built)')} {\n  model {\n`;
  for (const e of els.filter(e => e.kind === 'external')) dsl += `    ${id(e.name)} = softwareSystem ${q(e.name)} {\n      tags "External"\n    }\n`;
  dsl += `    sys = softwareSystem ${q(repoName)} {\n`;
  for (const e of els.filter(e => e.kind !== 'external')) {
    const head = `      ${id(e.name)} = container ${q(e.name)} "" ${q(e.tech)}${e.kind === 'store' ? ' "Database"' : ''}`;
    const comps = compsByOwner.get(keyOf(e.name)) || [];
    if (!comps.length) { dsl += head + '\n'; continue; }
    dsl += head + ' {\n';
    for (const c of comps) dsl += `        ${compId(keyOf(e.name), c.key)} = component ${q(c.name)} "" ""\n`;
    dsl += `      }\n`;
  }
  dsl += `    }\n\n`;
  for (const e of edges) dsl += `    ${id(elements.get(e.from).name)} -> ${id(elements.get(e.to).name)} ${q(e.label)} ${q(e.tech)} {\n      properties {\n        "d.interaction" ${q(e.kind === 'async' ? 'async' : 'sync')}\n      }\n    }\n`;
  for (const e of componentEdges) dsl += `    ${e.from} -> ${e.to} ${q(e.label)} ${q(e.tech)} { properties { "d.interaction" ${q(e.kind === 'async' ? 'async' : 'sync')} } }\n`;
  dsl += `  }\n}\n`;
  return dsl;
}

module.exports = { render };
