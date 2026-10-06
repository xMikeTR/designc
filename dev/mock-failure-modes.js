#!/usr/bin/env node
// Appends a person's failure-mode classifications of the design-registry fixture's escapes to the factory fixture,
// through the one append path (ledger-store.js). designc record refuses this kind: classification is the app's.
//   node dev/mock-failure-modes.js fixtures/factory-registry
// Run it after dev/mock-suite-run.js when regenerating the fixture ledger. The last classification names FM-09, which
// the taxonomy does not list, so the warning shows.
const { appendEvent } = require('../ledger-store.js');
const root = process.argv[2] || 'fixtures/factory-registry';
const T0 = Date.UTC(2026, 9, 5, 14, 0, 0);
const CLASSIFY = [['E-1a2b3c4d', 'FM-02'], ['E-9c0d1e2f', 'FM-01'], ['E-5e6f7a8b', 'FM-03'], ['E-5e6f7a8b', 'FM-09']];
(async () => {
  let n = 0;
  for (const [escape, failure_mode] of CLASSIFY) {
    n++;
    const r = await appendEvent(root, { kind: 'failure_mode_classified', by: 'mike', registry: 'design', escape, failure_mode },
      { now: () => T0 + n * 60000, uuid: () => `mock-fm-${String(n).padStart(3, '0')}` });
    if (!r.ok) { console.error(r.errors.join('\n')); process.exit(1); }
  }
})();
