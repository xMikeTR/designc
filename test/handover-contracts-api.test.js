const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const model = { path: 'model/workspace.dsl', text: 'workspace {\n  model {\n    s = softwareSystem "S" {\n      a = container "A" "x" {\n      }\n    }\n  }\n}\n' };
const plan = apiContracts => Core.handoverPlan({ date: '2026-10-19', now: 'n', by: 'm', model, apiContracts });
const api = text => [{ path: 'contracts/openapi/fares.yaml', text }];

test('a handover without API contracts is unchanged', () => {
  const p = plan(undefined), q = plan([]);
  assert.equal(p.id, q.id);
  assert.ok(!/^contracts_api:/m.test(p.files[0].text));
});

test('API contracts are copied, hashed and listed under contracts_api, not contracts', () => {
  const a = plan(api('openapi: 3.0.3\n')), b = plan(api('openapi: 3.1.0\n')), none = plan(null);
  const dir = `handovers/${a.id}/`;
  assert.ok(a.files.some(f => f.path === dir + 'contracts/openapi/fares.yaml'));
  assert.match(a.files[0].text, /^contracts_api: \["contracts\/openapi\/fares.yaml"\]/m);
  assert.ok(!/^contracts:/m.test(a.files[0].text));
  assert.match(a.files[0].text, /path: "contracts\/openapi\/fares.yaml", hash: /);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, none.id);
});
