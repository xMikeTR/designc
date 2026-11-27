'use strict';
// Per-step request counts (N4 / S9): Parity.stepCalls, the `calls` finding in compare, decisions that cover it,
// and the recorder's act marks (timed).
const test = require('node:test');
const assert = require('node:assert');
const Parity = require('../renderer/parity.js');
const CLI = require('../scripts/parity-record.js');

const BASE = 'http://app.test:8080/';
const T = ms => new Date(Date.UTC(2026, 0, 1, 10, 0, 0, 0) + ms).toISOString();
const entry = (method, p, { at, step, type, mime = 'application/json', origin = 'http://app.test:8080' } = {}) => ({
  ...(at != null ? { startedDateTime: T(at) } : {}),
  ...(step != null ? { _step: step } : {}),
  ...(type ? { _resourceType: type } : {}),
  request: { method, url: origin + p },
  response: { status: 200, content: { mimeType: mime } },
});
const har = (...entries) => ({ log: { entries } });
const MARKS = [Date.UTC(2026, 0, 1, 10, 0, 0, 0), Date.UTC(2026, 0, 1, 10, 0, 1, 0), Date.UTC(2026, 0, 1, 10, 0, 2, 0)];

test('stepCalls places each data request in the step whose mark is the last one before it', () => {
  const r = Parity.stepCalls(har(
    entry('GET', '/api/a', { at: -500 }), // before the first mark: ignored
    entry('GET', '/api/a', { at: 100 }),
    entry('GET', '/api/b/7', { at: 1500 }),
    entry('POST', '/api/b/8', { at: 2500 }),
  ), { baseUrl: BASE, marks: MARKS });
  assert.deepStrictEqual(r, [[{ method: 'GET', path: '/api/a', count: 1 }], [{ method: 'GET', path: '/api/b/:id', count: 1 }], [{ method: 'POST', path: '/api/b/:id', count: 1 }]]);
});

test('stepCalls ignores static and other-origin entries, counts identical calls and caps the count at 3', () => {
  const r = Parity.stepCalls(har(
    entry('GET', '/app.js', { at: 10, type: 'script' }),
    entry('GET', '/api/x', { at: 20, origin: 'http://other.test' }),
    entry('GET', '/api/items/1', { at: 30 }), entry('GET', '/api/items/2', { at: 40 }),
    entry('GET', '/api/items/3', { at: 50 }), entry('GET', '/api/items/4', { at: 60 }), entry('GET', '/api/items/5', { at: 70 }),
    entry('GET', '/api/list', { at: 80 }), entry('GET', '/api/list', { at: 90 }),
  ), { baseUrl: BASE, marks: MARKS });
  assert.deepStrictEqual(r[0], [{ method: 'GET', path: '/api/items/:id', count: 3 }, { method: 'GET', path: '/api/list', count: 2 }]);
  assert.deepStrictEqual(r[1], []);
  assert.deepStrictEqual(r[2], []);
});

test('stepCalls: _step wins over time; an entry with only _step needs no date', () => {
  const r = Parity.stepCalls(har(entry('GET', '/api/a', { at: 100, step: 3 }), entry('GET', '/api/b', { step: 2 })), { baseUrl: BASE, marks: MARKS });
  assert.deepStrictEqual(r, [[], [{ method: 'GET', path: '/api/b', count: 1 }], [{ method: 'GET', path: '/api/a', count: 1 }]]);
});

test('stepCalls is null (unknown, never zero) with no marks, a bad base URL, or one undated data entry', () => {
  const ok = har(entry('GET', '/api/a', { at: 100 }));
  assert.strictEqual(Parity.stepCalls(ok, { baseUrl: BASE, marks: [] }), null);
  assert.strictEqual(Parity.stepCalls(ok, { baseUrl: BASE }), null);
  assert.strictEqual(Parity.stepCalls(ok, { baseUrl: 'nope', marks: MARKS }), null);
  assert.strictEqual(Parity.stepCalls(har(entry('GET', '/api/a', { at: 100 }), entry('GET', '/api/b')), { baseUrl: BASE, marks: MARKS }), null);
  const bad = entry('GET', '/api/b'); bad.startedDateTime = 'yesterday-ish';
  assert.strictEqual(Parity.stepCalls(har(bad), { baseUrl: BASE, marks: MARKS }), null);
  // an undated static entry does not matter
  assert.notStrictEqual(Parity.stepCalls(har(entry('GET', '/a.css', { type: 'stylesheet' })), { baseUrl: BASE, marks: MARKS }), null);
});

test('stepCalls never throws on a garbage HAR', () => {
  for (const h of [null, undefined, {}, { log: {} }, { log: { entries: 'x' } }, { log: { entries: [null, 3, {}, { request: {} }] } }]) {
    const r = Parity.stepCalls(h, { baseUrl: BASE, marks: MARKS });
    assert.ok(r === null || (Array.isArray(r) && r.every(x => Array.isArray(x) && !x.length)), JSON.stringify(h));
  }
  assert.strictEqual(Parity.stepCalls(har(entry('GET', '/api/a', { at: 1 })), { baseUrl: BASE, marks: [NaN, 'x'] }), null);
  assert.doesNotThrow(() => Parity.stepCalls(har(entry('GET', '/api/a', { at: 1 })), undefined));
});

// ---- compare ----

const okStep = (calls) => ({ n: 1, action: 'goto', status: 'ok', elements: [], ...(calls === undefined ? {} : { calls }) });
const snap = (side, calls) => ({ scenario: 's', side, steps: [okStep(calls)] });
const cmp = (l, n, exceptions) => Parity.compare({ scenario: { id: 's' }, legacy: snap('legacy', l), next: snap('next', n), exceptions });
const c = (method, path, count) => ({ method, path, count });
const item = [c('GET', '/api/items/:id', 1)];

test('compare: legacy 1 against next 3 or more fails with a calls finding in plain words', () => {
  const r = cmp(item, [c('GET', '/api/items/:id', 3)]);
  assert.strictEqual(r.outcome, 'fail');
  const f = r.steps[0].findings;
  assert.deepStrictEqual(f.map(x => [x.kind, x.key, x.severity]), [['calls', 'calls:GET /api/items/:id', 'fail']]);
  assert.strictEqual(f[0].msg, 'GET /api/items/:id is called 3 or more times in this step; legacy calls it once');
  assert.deepStrictEqual(Parity.failures(r)[0], { step: 1, key: 'calls:GET /api/items/:id', kind: 'calls', msg: f[0].msg });
});

test('compare: 2 against 1, and 1 against none, are findings with their own words', () => {
  assert.strictEqual(cmp(item, [c('GET', '/api/items/:id', 2)]).steps[0].findings[0].msg, 'GET /api/items/:id is called twice in this step; legacy calls it once');
  const r = cmp([], [c('GET', '/api/items/:id', 1)]);
  assert.strictEqual(r.outcome, 'fail');
  assert.strictEqual(r.steps[0].findings[0].msg, 'GET /api/items/:id is called once in this step; legacy does not call it');
  assert.strictEqual(cmp([], [c('POST', '/api/x', 3)]).steps[0].findings[0].msg, 'POST /api/x is called 3 or more times in this step; legacy does not call it');
});

test('compare: the same, fewer or other-method calls give no calls finding for the same path', () => {
  assert.strictEqual(cmp(item, item).outcome, 'pass');
  assert.strictEqual(cmp([c('GET', '/api/items/:id', 3)], [c('GET', '/api/items/:id', 2)]).outcome, 'pass');
  assert.strictEqual(cmp(item, []).outcome, 'pass');
  assert.strictEqual(cmp([c('GET', '/api/items/:id', 3)], [c('GET', '/api/items/:id', 3)]).outcome, 'pass');
});

test('compare: calls absent on either side is unknown, never a finding', () => {
  const many = [c('GET', '/api/items/:id', 3)];
  assert.strictEqual(cmp(undefined, many).outcome, 'pass');
  assert.strictEqual(cmp(item, undefined).outcome, 'pass');
  assert.strictEqual(cmp(undefined, undefined).outcome, 'pass');
  assert.deepStrictEqual(cmp(undefined, many).steps[0].findings, []);
});

test('compare: calls findings come after the diff findings of the step', () => {
  const l = { n: 1, action: 'goto', status: 'ok', elements: [{ key: 'a', role: 'button', name: 'Save' }], calls: [] };
  const n = { n: 1, action: 'goto', status: 'ok', elements: [], calls: [c('GET', '/api/x', 1)] };
  const r = Parity.compare({ scenario: { id: 's' }, legacy: { steps: [l] }, next: { steps: [n] } });
  assert.deepStrictEqual(r.steps[0].findings.map(f => f.kind), ['missing', 'calls']);
});

test('a bound decision with calls covers the finding; a proposed one does not', () => {
  const many = [c('GET', '/api/items/:id', 3)];
  const bound = Parity.exceptions({ decisions: [{ id: 'batch-gone', status: 'bound', kind: 'technical', calls: [{ method: 'get', path: '/api/items/:id' }] }] });
  assert.deepStrictEqual(bound.calls, [{ method: 'GET', path: '/api/items/:id', by: 'batch-gone' }]);
  assert.deepStrictEqual([bound.added, bound.removed], [[], []]);
  const r = cmp(item, many, bound);
  assert.strictEqual(r.outcome, 'pass');
  assert.strictEqual(r.counts.covered, 1);
  assert.deepStrictEqual([r.steps[0].findings[0].severity, r.steps[0].findings[0].by], ['covered', 'batch-gone']);
  const proposed = Parity.exceptions({ decisions: [{ id: 'maybe', status: 'proposed', calls: [{ method: 'GET', path: '/api/items/:id' }] }] });
  assert.deepStrictEqual(proposed.calls, []);
  assert.strictEqual(cmp(item, many, proposed).outcome, 'fail');
  // another path or method is not covered
  const other = Parity.exceptions({ decisions: [{ id: 'o', status: 'bound', calls: [{ method: 'POST', path: '/api/items/:id' }, { method: 'GET', path: '/api/other' }] }] });
  assert.strictEqual(cmp(item, many, other).outcome, 'fail');
});

test('callsProblems', () => {
  assert.deepStrictEqual(Parity.callsProblems({ id: 'd' }), []);
  assert.deepStrictEqual(Parity.callsProblems({ id: 'd', calls: [{ method: 'GET', path: '/a' }] }), []);
  assert.deepStrictEqual(Parity.callsProblems({ id: 'd', calls: 'GET /a' }), ['d: calls must be a list of {method, path}']);
  assert.deepStrictEqual(Parity.callsProblems({ id: 'd', calls: [{ method: 'GET', path: '/a' }, { method: 'GET', path: 'a' }, { path: '/a' }, null] }),
    ['d: calls entry 2 needs a method and a path starting with /', 'd: calls entry 3 needs a method and a path starting with /', 'd: calls entry 4 needs a method and a path starting with /']);
});

// ---- timed ----

test('timed marks each act in order, passes the result through and leaves other methods alone', async () => {
  const log = [];
  const session = { act: async s => { log.push(['act', s]); return { ok: true, s }; }, capture: async () => 'cap', screenshot: async () => 'png', close: async () => { log.push(['close']); } };
  const adapter = { name: 'x', open: async o => { log.push(['open', o]); return session; } };
  const marks = [];
  const t = CLI.timed(adapter, marks);
  assert.strictEqual(t.name, 'x');
  const s = await t.open({ params: 1 });
  assert.deepStrictEqual(marks, []);
  const r1 = await s.act({ goto: 1 });
  const r2 = await s.act({ click: 2 });
  assert.deepStrictEqual(r1, { ok: true, s: { goto: 1 } });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(marks.length, 2);
  assert.ok(marks.every(Number.isInteger) && marks[0] <= marks[1]);
  assert.strictEqual(await s.capture(), 'cap');
  assert.strictEqual(await s.screenshot(), 'png');
  await s.close();
  assert.deepStrictEqual(log.map(l => l[0]), ['open', 'act', 'act', 'close']);
  assert.deepStrictEqual(log[0][1], { params: 1 });
});

test('timed pushes the mark even when act throws', async () => {
  const marks = [];
  const s = await CLI.timed({ name: 'x', open: async () => ({ act: async () => { throw new Error('boom'); } }) }, marks).open({});
  await assert.rejects(s.act({}), /boom/);
  assert.strictEqual(marks.length, 1);
});
