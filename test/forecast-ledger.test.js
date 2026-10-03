// Slice 17: task.handover, the handover_closed kind, per-element spend history and per-handover actuals.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

let n = 0;
const task = (f = {}) => ({ schema_version: 1, event_id: `t${++n}`, ts: 1000 + n, _ts: 1000 + n, kind: 'task', by: 'p', task: `T-${n}`, status: 'passed', ...f });
const closed = (f = {}) => ({ schema_version: 1, event_id: `c${++n}`, ts: 1000 + n, _ts: 1000 + n, kind: 'handover_closed', by: 'me', handover: 'H-1', outcome: 'delivered', ...f });

test('a task may name its handover; handover_closed needs a handover and an outcome', () => {
  assert.deepEqual(Ledger.validate({ kind: 'task', by: 'p', task: 'T', status: 'passed', handover: 'H-1', element: 'Api', tokens_in: 10, tokens_out: 5, cost: 0.2 }), []);
  assert.deepEqual(Ledger.validate({ kind: 'handover_closed', by: 'me', handover: 'H-1', outcome: 'abandoned' }), []);
  assert.ok(Ledger.validate({ kind: 'handover_closed', by: 'me', handover: 'H-1', outcome: 'done' }).length);
  assert.ok(Ledger.validate({ kind: 'handover_closed', by: 'me', outcome: 'delivered' }).length);
  assert.equal(Ledger.KINDS.handover_closed.stream, 'designc.jsonl');
});

test('elementHistory sums spend per element and handover, failures and reruns included', () => {
  const ev = [
    task({ handover: 'H-1', element: 'Api', tokens_in: 100, tokens_out: 50, cost: 1 }),
    task({ handover: 'H-1', element: 'Api', status: 'failed', tokens: 30, cost: 0.5 }),
    task({ handover: 'H-1', element: 'Db', tokens: 10 }),
    task({ handover: 'H-2', element: 'Api', tokens: 200, cost: 2 }),
    task({ element: 'Api', tokens: 999 }),
    task({ handover: 'H-2', tokens: 999 }),
  ];
  const h = Ledger.elementHistory(ev);
  assert.deepEqual(h.get('Api'), [{ handover: 'H-1', tokens: 180, cost: 1.5 }, { handover: 'H-2', tokens: 200, cost: 2 }]);
  assert.deepEqual(h.get('Db'), [{ handover: 'H-1', tokens: 10, cost: 0 }]);
  assert.equal(h.size, 2);
});

test('elementHistory keeps only the last window of handovers, oldest first', () => {
  const ev = ['A', 'B', 'C', 'D'].map((id, i) => task({ handover: id, element: 'Api', tokens: i + 1 }));
  assert.deepEqual(Ledger.elementHistory(ev, { window: 2 }).get('Api').map(x => x.handover), ['C', 'D']);
});

test('handoverActuals totals a handover and marks it final once closed', () => {
  const ev = [
    task({ handover: 'H-1', element: 'Api', tokens: 100, cost: 1 }),
    task({ handover: 'H-2', element: 'Api', tokens: 7 }),
    task({ handover: 'H-1', element: 'Db', tokens_in: 20, tokens_out: 5, cost: 0.25 }),
  ];
  assert.deepEqual(Ledger.handoverActuals(ev, 'H-1'), { tokens: 125, cost: 1.25, tasks: 2, closed: null, afterClose: 0 });
  const done = [...ev, closed(), task({ handover: 'H-1', element: 'Api', tokens: 50, cost: 9 })];
  assert.deepEqual(Ledger.handoverActuals(done, 'H-1'), { tokens: 125, cost: 1.25, tasks: 2, closed: 'delivered', afterClose: 1 });
  assert.equal(Ledger.handoverActuals(ev, 'H-9').tasks, 0);
});
