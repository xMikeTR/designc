// Slice 16: d.timeout, d.latency.max, d.fanout, d.retry.budget; DC007 (deadline) and DC008 (retry amplification).
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const P = o => `{\n properties {\n${Object.entries(o).map(([k, v]) => `  "${k}" "${v}"`).join('\n')}\n }\n}`;
const SYNC = { 'd.interaction': 'sync' };
const parse = body => { const m = Core.parse(`workspace { model {\n${body}\n} }`); assert.deepEqual(m.errors, []); return m; };
const lint = (body, opts) => Core.check(parse(body), { chainHops: 4, ...opts }).filter(d => !d.suppressed);
const of = (ds, code) => ds.filter(d => d.code === code);

// A -> B -> C with tunable numbers.
const chain = ({ ab = {}, bc = {}, a = {}, b = {}, c = {} } = {}) => `s = softwareSystem "S" {
  a = container "A" "" "" ${P({ ...a })}
  b = container "B" "" "" ${P({ ...b })}
  c = container "C" "" "" ${P({ ...c })}
}
a -> b "calls" ${P({ ...SYNC, ...ab })}
b -> c "calls" ${P({ ...SYNC, ...bc })}`;

test('the timing properties validate: bad values are DC000', () => {
  const ok = lint(chain({ ab: { 'd.timeout': '2000' }, b: { 'd.latency.max': '800', 'd.fanout': 'parallel', 'd.retry.budget': '8' } }));
  assert.deepEqual(of(ok, 'DC000'), []);
  assert.equal(of(lint(chain({ ab: { 'd.timeout': 'soon' } })), 'DC000').length, 1);
  assert.equal(of(lint(chain({ b: { 'd.fanout': 'maybe' } })), 'DC000').length, 1);
  assert.equal(of(lint(chain({ c: { 'd.latency.max': 'fast' } })), 'DC000').length, 1);
});

test('DC007 is an error when the caller times out before the callee can finish', () => {
  // B: 800 own + C 2 attempts x 600 = 2000
  const b = { 'd.latency.max': '800' };
  const bc = { 'd.timeout': '600', 'd.retry': 'fixed', 'd.retry.max': '1', 'd.idempotent': 'yes' };
  const c = { 'd.latency.max': '100' };
  const bad = of(lint(chain({ ab: { 'd.timeout': '1900' }, b, bc, c })), 'DC007');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].sev, 'error');
  assert.equal(bad[0].loc.label, 'A → B');
  assert.match(bad[0].msg, /timeout 1900 ms is less than B's worst case 2000 ms \(800 own \+ C 2 × 600\)/);
  assert.deepEqual(of(lint(chain({ ab: { 'd.timeout': '2000' }, b, bc, c })), 'DC007'), []);
});

test('DC007 treats parallel fan-out as the slowest call instead of the sum', () => {
  const body = fan => `s = softwareSystem "S" {
  a = container "A" "" "" ${P({})}
  b = container "B" "" "" ${P({ 'd.latency.max': '100', ...fan })}
  c = container "C" "" "" ${P({ 'd.latency.max': '10' })}
  d = container "D" "" "" ${P({ 'd.latency.max': '10' })}
}
a -> b "calls" ${P({ ...SYNC, 'd.timeout': '800' })}
b -> c "calls" ${P({ ...SYNC, 'd.timeout': '500' })}
b -> d "calls" ${P({ ...SYNC, 'd.timeout': '400' })}`;
  const seq = of(lint(body({})), 'DC007');
  assert.equal(seq.length, 1);
  assert.match(seq[0].msg, /worst case 1000 ms \(100 own \+ C 500 \+ D 400\)/);
  assert.deepEqual(of(lint(body({ 'd.fanout': 'parallel' })), 'DC007'), []);
});

test('DC007 only judges rels that declare d.timeout, and asks for what is missing', () => {
  assert.deepEqual(of(lint(chain({})), 'DC007'), []);
  const un = of(lint(chain({ ab: { 'd.timeout': '2000' } })), 'DC007');
  assert.equal(un.length, 1);
  assert.equal(un[0].sev, 'warning');
  assert.equal(un[0].unknown, true);
  assert.match(un[0].msg, /d\.latency\.max on B/);
  assert.match(un[0].msg, /d\.timeout on B → C/);
});

test('DC007 ignores async rels and structural pairs', () => {
  const body = `s = softwareSystem "S" {
  a = container "A" "" "" ${P({})}
  b = container "B" "" "" ${P({ 'd.latency.max': '100' })}
  c = container "C" "" "" ${P({ 'd.latency.max': '5000' })}
}
a -> b "calls" ${P({ ...SYNC, 'd.timeout': '300' })}
b -> c "queues" ${P({ 'd.interaction': 'async', 'd.delivery': 'at-least-once', 'd.idempotent': 'yes', 'd.timeout': '1' })}`;
  assert.deepEqual(of(lint(body), 'DC007'), []);
});

test('DC008 warns where retries multiply past the limit, and a receiver can override it', () => {
  const ab = { 'd.retry': 'fixed', 'd.retry.max': '3', 'd.idempotent': 'yes' };
  const bc = { 'd.retry': 'backoff', 'd.retry.max': '1', 'd.idempotent': 'yes' };
  const hit = of(lint(chain({ ab, bc })), 'DC008');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].sev, 'warning');
  assert.equal(hit[0].loc.label, 'B → C');
  assert.match(hit[0].msg, /×8/);
  assert.match(hit[0].msg, /A → B → C/);
  assert.deepEqual(of(lint(chain({ ab, bc, c: { 'd.retry.budget': '10' } })), 'DC008'), []);
  assert.deepEqual(of(lint(chain({ ab, bc }), { retryAmplification: 8 }), 'DC008'), []);
});

test('DC008 stays quiet at exactly the limit and for a lone call', () => {
  const ab = { 'd.retry': 'fixed', 'd.retry.max': '3', 'd.idempotent': 'yes' };
  assert.deepEqual(of(lint(chain({ ab })), 'DC008'), []);
});

test('DC008 asks for d.retry.max when retries are declared without it', () => {
  const un = of(lint(chain({ ab: { 'd.retry': 'fixed', 'd.idempotent': 'yes' } })), 'DC008');
  assert.equal(un.length, 1);
  assert.equal(un[0].unknown, true);
  assert.match(un[0].msg, /d\.retry\.max/);
});

test('DC008 follows a cycle once and does not loop', () => {
  const body = `s = softwareSystem "S" {
  a = container "A" "" "" ${P({})}
  b = container "B" "" "" ${P({})}
}
a -> b "calls" ${P({ ...SYNC, 'd.retry': 'fixed', 'd.retry.max': '9', 'd.idempotent': 'yes' })}
b -> a "calls back" ${P({ ...SYNC })}`;
  assert.ok(of(lint(body), 'DC008').length >= 1);
});

test('Core.timing reports each sync rel for the badges', () => {
  const m = parse(chain({ ab: { 'd.timeout': '2500' }, b: { 'd.latency.max': '800' }, bc: { 'd.timeout': '600', 'd.retry': 'fixed', 'd.retry.max': '1', 'd.idempotent': 'yes' }, c: { 'd.latency.max': '100' } }));
  const t = Core.timing(m, { retryAmplification: 4 });
  const byLabel = Object.fromEntries([...t.rels.values()].map(x => [x.label, x]));
  assert.equal(byLabel['A → B'].timeout, 2500);
  assert.equal(byLabel['A → B'].worst, 2000);
  assert.equal(byLabel['A → B'].status, 'ok');
  assert.equal(byLabel['B → C'].timeout, 600);
  assert.equal(byLabel['B → C'].worst, 100);
  assert.equal(byLabel['B → C'].factor, 2);
  const un = Core.timing(parse(chain({ ab: { 'd.timeout': '1' } })), {});
  assert.equal([...un.rels.values()].find(x => x.label === 'A → B').status, 'unknown');
});

test('Core.amplificationFrom gives the retry multiplier from one element to everything it reaches', () => {
  const m = parse(chain({ ab: { 'd.retry': 'fixed', 'd.retry.max': '3', 'd.idempotent': 'yes' }, bc: { 'd.retry': 'fixed', 'd.retry.max': '1', 'd.idempotent': 'yes' } }));
  const id = n => [...m.elements.values()].find(e => e.name === n).id;
  const amp = Core.amplificationFrom(m, id('A'));
  assert.equal(amp.get(id('B')), 4);
  assert.equal(amp.get(id('C')), 8);
  assert.equal(amp.has(id('A')), false);
});
