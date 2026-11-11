const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const model = { path: 'model/workspace.dsl', text: 'workspace {\n  model {\n    s = softwareSystem "S" {\n      a = container "A" "x" {\n      }\n    }\n  }\n}\n' };
const req = (id, extra = '') => ({ path: `requirements/${id}.yaml`, text: `id: ${id}\ntitle: T\nversion: 1\n${extra}elements: []\n` });
const head = requirements => Core.handoverPlan({ date: '2026-11-11', now: 'n', by: 'm', model, requirements }).files[0].text;

test('no risk or data class on the requirements: the handover has neither key', () => {
  const h = head([req('R1')]);
  assert.ok(!/requirement_risk/.test(h));
  assert.ok(!/requirement_data_class/.test(h));
});

test('one requirement: its risk and data class are carried', () => {
  const h = head([req('R1', 'risk: high\ndata_class: regulated\n')]);
  assert.match(h, /^requirement_risk: "high"$/m);
  assert.match(h, /^requirement_data_class: "regulated"$/m);
});

test('several requirements: highest risk wins, first data class wins', () => {
  const h = head([req('R1', 'risk: low\ndata_class: internal\n'), req('R2', 'risk: critical\ndata_class: regulated\n'), req('R3', 'risk: medium\n')]);
  assert.match(h, /^requirement_risk: "critical"$/m);
  assert.match(h, /^requirement_data_class: "internal"$/m);
});

test('unknown risk values are not carried; quoted values and comments are read', () => {
  assert.ok(!/requirement_risk/.test(head([req('R1', 'risk: bogus\n')])));
  assert.match(head([req('R1', 'risk: "Medium"  # note\n')]), /^requirement_risk: "medium"$/m);
});

test('the keys come from files already hashed, so the handover id is unchanged by reading them', () => {
  const a = Core.handoverPlan({ date: '2026-11-11', now: 'n', by: 'm', model, requirements: [req('R1', 'risk: high\n')] });
  const b = Core.handoverPlan({ date: '2026-11-11', now: 'n', by: 'm', model, requirements: [req('R1', 'risk: low\n')] });
  assert.notEqual(a.id, b.id);
});
