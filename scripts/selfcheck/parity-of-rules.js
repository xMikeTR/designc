// parity-of-rules: the Python gate (`designc check --json`) and renderer/core.js must give the same report on every
// fixture registry that stands alone. Skipped: kind study/domain (no rule report), registries that pin domains
// (they need the setup in test/domain-parity.test.js) and folders without a model. Exit 1 on any difference.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, nodeReport, pyReport } = require('../../test/helpers/parity.js');

const base = path.join(ROOT, 'fixtures');
let checked = 0, skipped = 0, failed = 0;
for (const name of fs.readdirSync(base).sort()) {
  const root = path.join(base, name);
  const cfgPath = path.join(root, 'designc.json');
  if (!fs.existsSync(cfgPath)) continue;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const why = cfg.kind === 'study' || cfg.kind === 'domain' ? `kind ${cfg.kind}`
    : cfg.domains ? 'pins domains (test/domain-parity.test.js sets that up)'
    : !fs.existsSync(path.join(root, cfg.model || 'model/workspace.dsl')) ? 'no model: not a whole registry' : '';
  if (why) { skipped++; console.log(`skip  ${name} (${why})`); continue; }
  try { assert.deepEqual(pyReport(root), nodeReport(root)); checked++; console.log(`same  ${name}`); }
  catch (e) { failed++; console.log(`DIFF  ${name}\n${String(e.message).slice(0, 800)}`); }
}
console.log(`parity-of-rules: ${checked} same, ${failed} different, ${skipped} skipped`);
process.exit(failed || !checked ? 1 : 0);
