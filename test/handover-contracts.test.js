const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const model = { path: 'model/workspace.dsl', text: 'workspace {\n  model {\n    s = softwareSystem "S" {\n      a = container "A" "x" {\n        tags "Agent"\n      }\n    }\n  }\n}\n' };
const plan = contracts => Core.handoverPlan({ date: '2026-10-19', now: 'n', by: 'm', model, contracts });
const ctr = text => ({ result: { path: 'contracts/result.json', text: '{}\n' }, files: [{ path: 'contracts/a.yaml', text }], agents: { 'S/A': 'contracts/a.yaml' }, uncontracted: [], compiler: { name: 'x', version: '1' } });

test('a handover without contracts is unchanged', () => {
  const p = plan(null);
  assert.ok(!p.files.some(f => f.path.includes('/contracts/')));
  assert.ok(!/^contracts:/m.test(p.files[0].text));
});

test('contracts are copied, listed in handover.yaml and hashed, and a changed policy is a new handover', () => {
  const a = plan(ctr('name: a\n')), b = plan(ctr('name: b\n')), none = plan(null);
  const dir = `handovers/${a.id}/`;
  assert.ok(a.files.some(f => f.path === dir + 'contracts/a.yaml'));
  assert.ok(a.files.some(f => f.path === dir + 'contracts/result.json'));
  assert.match(a.files[0].text, /^contracts: \{"result":"contracts\/result.json","agents":\{"S\/A":"contracts\/a.yaml"\}/m);
  assert.match(a.files[0].text, /path: "contracts\/a.yaml", hash: /);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, none.id);
});
