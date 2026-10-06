#!/usr/bin/env node
// Appends a person's binds of the factory fixture's eval tasks, through the one append path (ledger-store.js).
// S2-0001 is bound at its current hash; S2-0002 was bound at an earlier hash, so it shows as changed.
//   node dev/mock-task-binds.js fixtures/factory-registry
const fs = require('fs'), path = require('path');
const { appendEvent } = require('../ledger-store.js');
const Core = require('../renderer/core.js');
const root = process.argv[2] || 'fixtures/factory-registry';
const hashOf = id => Core.evalHash({ _text: fs.readFileSync(path.join(root, 'factory', 'tasks', `${id}.yaml`), 'utf8') });
const T0 = Date.UTC(2026, 9, 5, 15, 0, 0);
(async () => {
  let n = 0;
  for (const [task_id, hash] of [['S2-0001', hashOf('S2-0001')], ['S2-0002', '0000000000000000']]) {
    n++;
    const r = await appendEvent(root, { kind: 'factory_task_bound', by: 'mike', task_id, hash }, { now: () => T0 + n * 60000, uuid: () => `mock-bind-${String(n).padStart(3, '0')}` });
    if (!r.ok) { console.error(r.errors.join('\n')); process.exit(1); }
  }
})();
