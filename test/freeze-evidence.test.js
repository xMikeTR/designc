// S7 P: freezeEvidence(item) in workview.js gathers an item's evidence for handoverPlan (parity report read fresh from disk, inbox entry from A.inbox).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Work = require('../renderer/work.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'workview.js'), 'utf8');
const m = src.match(/async function freezeEvidence\(item\) \{[\s\S]*?\n\}\n/);
const make = (A, host) => new Function('A', 'host', 'Work', `${m ? m[0] : ''}; return freezeEvidence;`)(A, host, Work);

test('freezeEvidence is defined in workview.js', () => assert.ok(m));

test('no item or no evidence gives an empty list and reads nothing', async () => {
  const reads = [];
  const f = make({ inbox: [] }, { read: async p => { reads.push(p); return null; } });
  assert.deepEqual(await f(null), []);
  assert.deepEqual(await f({ id: 'W' }), []);
  assert.deepEqual(await f({ id: 'W', evidence: [] }), []);
  assert.deepEqual(reads, []);
});

test('parity reports are read fresh from disk (unreadable or absent is null); jira takes the inbox entry or null; escape passes through', async () => {
  const reads = [];
  const host = { read: async p => { reads.push(p); if (p.endsWith('good.json')) return '{"result":{"steps":[]}}'; if (p.endsWith('bad.json')) return '{not json'; return null; } };
  const entry = { id: 'ZZ-1', target: { jira: 'ZZ-1' }, title: 't' };
  const f = make({ inbox: [entry, { id: 'ZZ-2' }] }, host);
  const out = await f({ id: 'W', evidence: [{ parity: 'good', step: 1 }, { parity: 'bad', step: 2 }, { parity: 'none', step: 1 }, { jira: 'ZZ-1' }, { jira: 'ZZ-3' }, { escape: 'E-1' }] });
  assert.deepEqual(reads, ['parity/reports/good.json', 'parity/reports/bad.json', 'parity/reports/none.json']);
  assert.deepEqual(out, [
    { parity: 'good', step: 1, report: { result: { steps: [] } } }, { parity: 'bad', step: 2, report: null }, { parity: 'none', step: 1, report: null },
    { jira: 'ZZ-1', inbox: entry }, { jira: 'ZZ-3', inbox: null }, { escape: 'E-1' }]);
});

test('a host.read that throws gives null', async () => {
  const f = make({ inbox: [] }, { read: async () => { throw new Error('x'); } });
  assert.deepEqual(await f({ id: 'W', evidence: [{ parity: 'a', step: 1 }] }), [{ parity: 'a', step: 1, report: null }]);
});
