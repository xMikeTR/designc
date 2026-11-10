'use strict';
// Audit rollup, pure (no I/O): SARIF + design-model elements + evidence -> health.json (schemaVersion 0.1).
// docs: "designc health overlay: schema and first slice", sections "health.json schema" and "Mapping SARIF findings".
// The mapping itself is renderer/health-map.js (tested alone); this file only shapes its result.
const HealthMap = require('../renderer/health-map.js');

const CONTAINER_LIKE = new Set(['container', 'component']);

/* input:
     sarif       merged SARIF 2.1.0 log (uris repo-relative; `scan` writes it that way)
     elements    [{ id, kind, parent?, paths: [glob], externalRead?: bool }] from the design model (id = hierarchical label)
     config      { exclude, categories } as for HealthMap.mapFindings
     baseline    array of fingerprints, or undefined (then nothing is new)
     evidence    { [elementId]: { [property]: [evidence] } } from executable checks / reviews, or undefined
     repo        { name, commit }, sources [{ tool, sarif }], now Date
     readContext (path, line) => string | undefined
   returns { health, mapped }
   Elements with no paths and no findings are left out: the file says nothing about them. */
function build({ sarif, elements = [], config = {}, baseline, evidence = {}, repo = {}, sources = [], now = new Date(), readContext } = {}) {
  const res = HealthMap.mapFindings({ sarif, elements, config, baseline, readContext });
  const out = {};
  for (const e of elements) {
    const c = res.elements[e.id];
    if (!(e.paths && e.paths.length) && !c.total) continue;
    const props = {};
    if (CONTAINER_LIKE.has(e.kind)) {
      props.idempotent = { applicable: true, evidence: (evidence[e.id] || {}).idempotent || [] };
      // cached only makes sense where extraction finds an edge to an external data source
      props.cached = { applicable: !!e.externalRead, evidence: (evidence[e.id] || {}).cached || [] };
    }
    out[e.id] = {
      kind: e.kind, ...(e.parent ? { parent: e.parent } : {}), paths: e.paths || [],
      findings: { total: c.total, new: c.new, byLevel: c.byLevel, byCategory: c.byCategory },
      properties: props,
    };
  }
  const health = {
    schemaVersion: '0.1', generatedAt: now.toISOString().replace(/\.\d+Z$/, 'Z'),
    repo, sources, elements: out, unmapped: res.unmapped,
  };
  // `mapped` (one row per finding, with its fingerprint) is for the baseline and diff; it is not part of the file.
  return { health, mapped: res.mapped };
}

// SARIF tools named in a log, for `sources`.
const toolsOf = sarif => [...new Set(((sarif && sarif.runs) || []).map(r => r.tool && r.tool.driver && r.tool.driver.name).filter(Boolean))];

module.exports = { build, toolsOf };
