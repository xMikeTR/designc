// parity-of-rules: the command line (`designc-core check --json`, which `python -m designc check` shims) and renderer/core.js
// assembled by hand (test/helpers/parity.js nodeState) must give the same report on every fixture registry that stands alone.
// Skipped: kind study/domain (no rule report), registries that pin domains or hold a ui/ pack (they need the setups in
// test/domain-headless.test.js and test/ui-headless.test.js) and folders without a model. Exit 1 on any difference.
// (Stage name kept from when the other side was the Python port, which is retired.)
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, nodeReport, coreReport } = require('../../test/helpers/parity.js');

const base = path.join(ROOT, 'fixtures');
let checked = 0, skipped = 0, failed = 0;
for (const name of fs.readdirSync(base).sort()) {
  const root = path.join(base, name);
  const cfgPath = path.join(root, 'designc.json');
  if (!fs.existsSync(cfgPath)) continue;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const why = cfg.kind === 'study' || cfg.kind === 'domain' ? `kind ${cfg.kind}`
    : cfg.domains ? 'pins domains (test/domain-headless.test.js sets that up)'
    : fs.existsSync(path.join(root, 'ui')) ? 'has a ui/ pack (test/ui-headless.test.js sets that up)'
    : !fs.existsSync(path.join(root, cfg.model || 'model/workspace.dsl')) ? 'no model: not a whole registry' : '';
  if (why) { skipped++; console.log(`skip  ${name} (${why})`); continue; }
  try { assert.deepEqual(coreReport(root), nodeReport(root)); checked++; console.log(`same  ${name}`); }
  catch (e) { failed++; console.log(`DIFF  ${name}\n${String(e.message).slice(0, 800)}`); }
}
console.log(`parity-of-rules: ${checked} same, ${failed} different, ${skipped} skipped`);
process.exit(failed || !checked ? 1 : 0);
