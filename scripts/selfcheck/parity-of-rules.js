// parity-of-rules: the Python gate (`designc check --json`) and renderer/core.js must give the same report on every
// fixture registry. Registries of kind study/domain have no rule report and are skipped. Exit 1 on any difference.
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
  const kind = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).kind;
  if (kind === 'study' || kind === 'domain') { skipped++; console.log(`skip  ${name} (kind ${kind})`); continue; }
  try { assert.deepEqual(pyReport(root), nodeReport(root)); checked++; console.log(`same  ${name}`); }
  catch (e) { failed++; console.log(`DIFF  ${name}\n${String(e.message).slice(0, 800)}`); }
}
console.log(`parity-of-rules: ${checked} same, ${failed} different, ${skipped} skipped`);
process.exit(failed || !checked ? 1 : 0);
