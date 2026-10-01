const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../ledger-store.js');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-store-')); }

test('a valid check is stamped, routed by kind and appended', async () => {
  const root = tmpRoot();
  const ev = { kind: 'check', by: 'u', decision: 'DEC-001', check: 'npm test', outcome: 'pass', source: 'local' };
  const r1 = await store.appendEvent(root, ev, { now: () => 1700000000000, uuid: () => 'u-1' });
  assert.equal(r1.ok, true);
  const file = path.join(root, 'ledger', 'checks.jsonl');
  const lines1 = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines1.length, 1);
  const parsed = JSON.parse(lines1[0]);
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.event_id, 'u-1');
  assert.equal(parsed.ts, 1700000000000);
  assert.equal(parsed.kind, 'check');

  const r2 = await store.appendEvent(root, ev, { now: () => 1700000001000, uuid: () => 'u-2' });
  assert.equal(r2.ok, true);
  const lines2 = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines2.length, 2);
  assert.equal(lines2[0], lines1[0]);
});

test('an invalid event writes nothing', async () => {
  const root = tmpRoot();
  const dir = path.join(root, 'ledger');
  const r = await store.appendEvent(root, { kind: 'check', by: 'u' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length);
  assert.equal(fs.existsSync(dir), false);
});

test('the caller cannot choose the file', async () => {
  const root = tmpRoot();
  const r = await store.appendEvent(root, { kind: 'check', by: 'u', decision: 'DEC-001', check: 'x', outcome: 'pass', source: 'local', file: '../model/workspace.dsl' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /^file:/.test(e)));
  assert.equal(fs.existsSync(path.join(root, 'ledger')), false);
});
