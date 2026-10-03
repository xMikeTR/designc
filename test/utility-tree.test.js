// Slice 19: scenario importance and difficulty feed a utility tree. Ranking never blocks; a malformed rating does.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const m = Core.parse(`workspace { model { s = softwareSystem "S" { api = container "Api" "" "" } } }`);
const sc = (id, o = {}) => ({ id, attribute: 'availability', artifact: 'Api', measure: { metric: 'p95', op: '<=', value: 1 }, ...o });
const rep = list => Core.scenarioReport({ model: m, scenarios: list, ledger: [] });
const ids = t => t.map(g => [g.attribute, g.scenarios.map(r => r.id)]);

test('the report carries importance and difficulty when they are valid', () => {
  const [r] = rep([sc('A', { importance: 'high', difficulty: 'low' })]);
  assert.equal(r.importance, 'high');
  assert.equal(r.difficulty, 'low');
  assert.equal(rep([sc('B')])[0].importance, null);
});

test('utilityTree groups by attribute and ranks by importance, then difficulty, unrated last', () => {
  const t = Core.utilityTree(rep([
    sc('A', { attribute: 'latency', importance: 'low', difficulty: 'high' }),
    sc('B', { attribute: 'availability', importance: 'high', difficulty: 'low' }),
    sc('C', { attribute: 'availability', importance: 'high', difficulty: 'high' }),
    sc('D', { attribute: 'availability' }),
    sc('E', { attribute: 'latency', importance: 'medium', difficulty: 'medium' }),
  ]));
  assert.deepEqual(ids(t), [['availability', ['C', 'B', 'D']], ['latency', ['E', 'A']]]);
});

test('the gate ignores ratings but blocks a malformed one', () => {
  const gate = list => Core.gate({ model: m, diags: [], decisions: [], requirements: [], ledger: [], scenarios: list }).clauses.map(c => c.text);
  assert.deepEqual(gate([sc('A', { importance: 'high', difficulty: 'medium' })]), []);
  assert.deepEqual(gate([sc('A', { importance: 'urgent' })]), ['A: importance must be high, medium or low']);
  assert.deepEqual(gate([sc('A', { difficulty: 3 })]), ['A: difficulty must be high, medium or low']);
});
