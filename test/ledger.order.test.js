const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

const line = (o) => JSON.stringify({ schema_version: 1, by: 'x', ...o });
const esc = (id, ts, extra = {}) => line({ event_id: id, ts, kind: 'escape', id: 'E-' + id.slice(0, 8), description: 'd', ...extra });
const classify = (id, ts, to) => line({ event_id: id, ts, kind: 'escape_classified', escape: 'E-aaaaaaaa', caught_by: to });
const read = (...texts) => Ledger.order(texts.flatMap((t, i) => Ledger.parse(t, `ledger/f${i}.jsonl`).events));

test('order drops a repeated event_id and keeps the first', () => {
  const a = esc('aaaaaaaa-1', 10), b = esc('bbbbbbbb-2', 20);
  const out = read([a, b].join('\n'), [b, a].join('\n'));
  assert.deepEqual(out.map(e => e.event_id), ['aaaaaaaa-1', 'bbbbbbbb-2']);
});

test('order sorts by _ts and is stable for equal timestamps', () => {
  const out = read([esc('cccccccc-3', 30), esc('aaaaaaaa-1', 10), esc('dddddddd-4', 10)].join('\n'));
  assert.deepEqual(out.map(e => e.event_id), ['aaaaaaaa-1', 'dddddddd-4', 'cccccccc-3']);
});

test('two branches that each appended read back the same state in either merge order', () => {
  const base = esc('aaaaaaaa-1', 10);
  const left = classify('11111111-a', 40, 'S1-lint'), right = classify('22222222-b', 50, 'S2-runtime');
  const one = Ledger.derive(read([base, left, right].join('\n')));
  const two = Ledger.derive(read([base, right, left].join('\n')));
  assert.deepEqual(one, two);
  assert.equal(one[0].caught_by, 'S2-runtime');
});

test('legacy lines keep distinct synthetic ids and are not dropped', () => {
  const legacy = JSON.stringify({ kind: 'escape', id: 'E-0001', description: 'old' });
  assert.equal(read(legacy + '\n' + legacy).length, 2);
});

test('escapeId takes the first 8 hex digits of a uuid, so two branches never mint the same id in sequence', () => {
  assert.equal(Ledger.escapeId('3f2a9c1e-7b44-4d1a-8e0f-aaaaaaaaaaaa'), 'E-3f2a9c1e');
  assert.notEqual(Ledger.escapeId('3f2a9c1e-7b44-4d1a-8e0f-aaaaaaaaaaaa'), Ledger.escapeId('9b00aa11-7b44-4d1a-8e0f-aaaaaaaaaaaa'));
});
