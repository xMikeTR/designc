const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const gate = clauses => ({ ready: false, clauses });

test('rebindable: decisions blocked only by a promotion clause, once each, in order', () => {
  const g = gate([
    { kind: 'promotion', text: 'D-2 is bound without a fingerprint', decision: 'D-2' },
    { kind: 'decision', text: 'D-3 has no check', decision: 'D-3' },
    { kind: 'promotion', text: 'D-1: Quotes DB changed since promotion', decision: 'D-1' },
    { kind: 'promotion', text: 'D-2: Quotes Svc changed since promotion', decision: 'D-2' },
  ]);
  assert.deepEqual(Core.rebindable(g), ['D-2', 'D-1']);
});

test('rebindable: nothing when the gate has no promotion clauses', () => {
  assert.deepEqual(Core.rebindable(gate([{ kind: 'decision', text: 'x', decision: 'D-1' }])), []);
  assert.deepEqual(Core.rebindable(null), []);
});

test('latestHandoverModel: the newest handover that names a model path', () => {
  const hs = [{ id: 'a', model: 'model/workspace.dsl' }, { id: 'b', model: 'model/workspace.dsl' }, { id: 'c' }];
  assert.deepEqual(Core.latestHandoverModel(hs), { id: 'b', path: 'handovers/b/model/workspace.dsl' });
  assert.equal(Core.latestHandoverModel([]), null);
});
