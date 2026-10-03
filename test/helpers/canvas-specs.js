// Builds python/designc/canvas_specs.json from renderer/canvas/vocabulary.js, the one source of the agentic and quality d.* properties.
// `node test/helpers/canvas-specs.js --write` regenerates it; test/canvas-specs.test.js fails when it is stale.
const fs = require('fs');
const path = require('path');
const V = require('../../renderer/canvas/vocabulary.js');

const FILE = path.join(__dirname, '..', '..', 'python', 'designc', 'canvas_specs.json');

function build() {
  const specs = V.coreSpecs();
  const sorted = {};
  for (const target of ['element', 'relationship']) {
    sorted[target] = {};
    for (const key of Object.keys(specs[target]).sort()) sorted[target][key] = specs[target][key];
  }
  const out = { note: 'Generated from renderer/canvas/vocabulary.js by test/helpers/canvas-specs.js --write. Do not edit by hand.', ...sorted };
  return JSON.stringify(out, null, 2) + '\n';
}

if (require.main === module && process.argv.includes('--write')) { fs.writeFileSync(FILE, build()); console.log(`wrote ${FILE}`); }
module.exports = { build, FILE };
