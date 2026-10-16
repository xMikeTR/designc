'use strict';
// A pipeline's needs_decision may offer options (payload.options, payload.recommended); a person answers in designc
// with needs_decision_resolved carrying the chosen option and a note under payload, or the decision that answers it.
// The pipeline reads them back when it resumes. Any pipeline: no names here.
const test = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

const nd = (payload, f = {}) => ({ kind: 'needs_decision', by: 'p', id: 'ND-0002', question: 'Which rule?', status: 'open', _ts: 1, ...(payload ? { payload } : {}), ...f });
const A = { id: 'A', summary: 'Keep the literal check', consequence: 'Stringly typed' };
const B = { id: 'B', summary: 'Narrow the check', consequence: 'Weaker test' };

test('ndOptions reads the offered options and the recommended one', () => {
  assert.deepEqual(Ledger.ndOptions(nd({ options: [A, B], recommended: 'B' })), { options: [A, B], recommended: 'B' });
});

test('ndOptions is empty for a question with no options, and drops options without an id or summary', () => {
  assert.deepEqual(Ledger.ndOptions(nd(null)), { options: [], recommended: null });
  assert.deepEqual(Ledger.ndOptions(nd({ options: [{ summary: 'no id' }, { id: 'X' }, 'text', B] })).options, [{ ...B }]);
});

test('ndOptions ignores a recommendation that is not one of the options', () => {
  assert.equal(Ledger.ndOptions(nd({ options: [A], recommended: 'Z' })).recommended, null);
});

test('needs_decision_resolved may carry the decision, and the option and note under payload', () => {
  assert.deepEqual(Ledger.validate({ kind: 'needs_decision_resolved', by: 'me', id: 'ND-0002', decision: 'narrow-the-check', payload: { option: 'B', note: 'fine' } }), []);
});

test('derive marks the question resolved and keeps the latest answer on it', () => {
  const r = (ts, f) => ({ kind: 'needs_decision_resolved', by: 'me', id: 'ND-0002', _ts: ts, ...f });
  const out = Ledger.derive([nd({ options: [A, B] }), r(2, { payload: { option: 'A' } }), r(3, { decision: 'd-1', payload: { option: 'B', note: 'why' } })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'resolved');
  assert.deepEqual(out[0].resolution, { by: 'me', ts: 3, option: 'B', note: 'why', decision: 'd-1' });
});

test('a plain resolution has no option, note or decision', () => {
  const out = Ledger.derive([nd(null), { kind: 'needs_decision_resolved', by: 'me', id: 'ND-0002', _ts: 2 }]);
  assert.deepEqual(out[0].resolution, { by: 'me', ts: 2, option: null, note: null, decision: null });
});
