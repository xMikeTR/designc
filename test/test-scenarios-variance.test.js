// C5: variance between two extractions of one requirement page. Record part (slice 1).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const yaml = require('js-yaml');
const Rec = require('../renderer/records.js');
const TS = require('../renderer/test-scenarios.js');
const { BOUND, MINTED } = require('./helpers/scenario-handover.js');
const dump = (o, op) => yaml.dump(o, op);
const FLAT = { id: 'x-ts-01', requirement: 'x', title: 't', source: 's', given: ['a'], when: ['b'], then: ['c'], by: 'grill', status: 'minted' };
const errs = rec => Rec.validate('test_scenario', rec);

test('run: valid tags validate, bad ones give the message', () => {
  assert.deepEqual(errs({ ...BOUND, run: 'a' }), []);
  assert.deepEqual(errs({ ...BOUND, run: 'b-2.x_y' }), []);
  const msg = 'run: a run tag is letters, digits, ".", "_" or "-", at most 32';
  for (const bad of ['', 'a b', 'x'.repeat(33), '-a', 5]) assert.ok(errs({ ...BOUND, run: bad }).includes(msg), JSON.stringify(bad));
  assert.deepEqual(errs(BOUND), []);
});
test('run: build writes run between by and status (structured) and after by (flat)', () => {
  const req = { id: 'ORD-1' };
  const { files } = TS.build(req, [{ title: 't', quote: 'q', screen: BOUND.screen, steps: BOUND.steps, effect: BOUND.effect }], { by: 'grill', needQuote: true, dump, run: 'a' });
  assert.equal(files[0].rec.run, 'a');
  assert.match(files[0].text, /\nby: grill\nrun: a\nstatus: minted\n$/);
  assert.match(TS.fileText({ ...FLAT, run: 'a' }, dump), /\nby: grill\nrun: a\nstatus: minted\n$/);
  const plain = TS.build(req, [{ title: 't', quote: 'q', screen: BOUND.screen, steps: BOUND.steps, effect: BOUND.effect }], { by: 'grill', needQuote: true, dump });
  assert.equal(plain.files[0].rec.run, undefined);
  assert.doesNotMatch(plain.files[0].text, /run:/);
});
test('run: without run, fileText bytes are unchanged', () => {
  const want = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'variance', 'filetext-baseline.json'), 'utf8'));
  assert.deepEqual([BOUND, MINTED, FLAT].map(r => TS.fileText(r, dump)), want);
});
test('run: records.schema.json describes run', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'docs', 'records.schema.json'), 'utf8');
  assert.match(s, /"run":/);
});

// ---- pure diff (slice 2) ----
const { PAGE, run, ENTITIES, ctx, S1, S2 } = require('./helpers/variance-fixtures.js');
const clone = x => JSON.parse(JSON.stringify(x));
const built = (args, taken = []) => {
  const r = TS.build({ id: args.requirement }, args.scenarios, { by: 'grill', needQuote: true, dump, run: args.run, taken });
  assert.ok(r.files, r.error); return r.files;
};
const side = args => ({ run: args.run, scenarios: built(args).map(f => f.rec) });
const A = side(run('ORD-1.a')), BSAME = side(run('ORD-1.b-same')), BDIFF = side(run('ORD-1.b-differ'));
const diff = (a, b) => TS.diffRuns(a, b, { pageText: PAGE, entities: ENTITIES });
// b = a with one edit applied to a clone of a's records
const edit = fn => { const b = { run: 'b', scenarios: clone(A.scenarios) }; fn(b.scenarios); return b; };

test('fixtures: the recorded runs pass the strict mint refusals', () => {
  for (const n of ['ORD-1.a', 'ORD-1.b-same', 'ORD-1.b-differ']) {
    assert.equal(TS.refusal(built(run(n)), ctx()), null, n);
  }
});
test('diffRuns: a vs b-same (equivalent, written differently) gives none; a vs a gives none', () => {
  assert.deepEqual(diff(A, BSAME), []);
  assert.deepEqual(diff(A, A), []);
  assert.deepEqual(diff(A, { run: 'b', scenarios: clone(A.scenarios) }), []);
});
test('diffRuns: a vs b-differ gives exactly one question naming sentence 1', () => {
  const d = diff(A, BDIFF);
  assert.equal(d.length, 1);
  assert.equal(d[0].sentence, S1);
  assert.deepEqual(d[0].fields, ['examples']);
  assert.ok(d[0].question.includes(`"${S1}"`));
  assert.ok(d[0].question.includes('a different outcome for the same input'));
  assert.equal(d[0].question, `Variance: two extractions of "${S1}" disagree on examples (a different outcome for the same input). Which does the page mean?`);
  assert.deepEqual(d[0].targets, { a: ['ORD-1-ts-01'], b: [] });
});
test('diffRuns: one edit per field', () => {
  let d = diff(A, edit(s => { s[0].screen = 'orders'; }));
  assert.deepEqual(d.map(x => x.fields), [['screen']]);
  assert.ok(d[0].question.includes('screen (orders-tag or orders)'));
  d = diff(A, edit(s => { s[0].steps[0].fill.name = 'Pattern'; }));
  assert.deepEqual(d.map(x => x.fields), [['steps']]);
  assert.ok(d[0].question.includes('disagree on steps.'));
  d = diff(A, edit(s => { s[0].effect.operation = 'tagAll'; }));
  assert.deepEqual(d.map(x => x.fields), [['operation']]);
  assert.ok(d[0].question.includes('operation (tagOrders or tagAll)'));
  d = diff(A, edit(s => { delete s[0].examples; }));
  assert.deepEqual(d.map(x => x.fields), [['examples']]);
  assert.ok(d[0].question.includes('examples (one run has none)'));
  d = diff(A, edit(s => { s[0].examples[0].then = { Customer: [{ id: 1 }] }; }));
  assert.ok(d[0].question.includes('rows on different entities'));
  d = diff(A, edit(s => { s[0].examples[0].then.Order[0].tag = 'Hold'; }));
  assert.ok(d[0].question.includes('a different outcome for the same input'));
});
test('diffRuns: placeholder names, row order, id typing and example order do not matter', () => {
  const b = edit(s => { s[0].examples[0].given.Order.reverse(); s[0].examples[0].then.Order[0].id = '1'; s[0].examples[0].title = 'other'; });
  assert.deepEqual(diff(A, b), []);
});
test('diffRuns: two fields are named in the fixed order', () => {
  const d = diff(A, edit(s => { s[0].effect.operation = 'tagAll'; s[0].screen = 'orders'; }));
  assert.deepEqual(d[0].fields, ['screen', 'operation']);
  assert.ok(d[0].question.indexOf('screen (') < d[0].question.indexOf('operation ('));
});
test('diffRuns: the number of cases is used alone', () => {
  const b = edit(s => { s.splice(0, 0, clone(s[0])); s[0].screen = 'orders'; });
  const d = diff(A, b);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].fields, ['cases']);
  assert.ok(d[0].question.includes('disagree on the number of cases (1 and 2).'));
  assert.deepEqual(d[0].targets.a, ['ORD-1-ts-01']);
});
test('diffRuns: a sentence only A covers, and only B covers', () => {
  let d = diff(A, edit(s => { s.pop(); }));
  assert.equal(d.length, 1);
  assert.equal(d[0].sentence, S2);
  assert.ok(d[0].question.includes('the number of cases (1 and 0)'));
  assert.deepEqual(d[0].targets, { a: ['ORD-1-ts-02'], b: [] });
  d = diff({ run: 'a', scenarios: [A.scenarios[0]] }, { run: 'b', scenarios: A.scenarios });
  assert.equal(d.length, 1);
  assert.equal(d[0].sentence, S2);
  assert.deepEqual(d[0].targets, { a: [], b: [1] });
});
test('diffRuns: a source across a sentence boundary is keyed by the source', () => {
  const src = 'the string entered. An order that does';
  const a = { run: 'a', scenarios: [{ ...A.scenarios[0], source: src }] };
  const b = { run: 'b', scenarios: [{ ...A.scenarios[0], source: src, screen: 'orders' }] };
  const d = diff(a, b);
  assert.equal(d.length, 1);
  assert.equal(d[0].sentence, src);
  assert.ok(d[0].question.includes(`two extractions of "${src}" disagree on screen (orders-tag or orders)`));
});
test('diffRuns: flat scenarios are ignored; scenario order does not matter', () => {
  const flat = { id: 'ORD-1-ts-09', requirement: 'ORD-1', title: 'f', source: S1, given: ['a'], when: ['b'], then: ['c'], by: 'grill', status: 'minted' };
  assert.deepEqual(diff({ run: 'a', scenarios: [flat, ...A.scenarios] }, { run: 'b', scenarios: [...BSAME.scenarios, flat] }), []);
  const rev = x => ({ run: x.run, scenarios: [...x.scenarios].reverse() });
  assert.deepEqual(diff(rev(A), rev(BDIFF)), diff(A, BDIFF));
  assert.deepEqual(diff(rev(A), rev(BSAME)), []);
});
test('earlierRun: none, same tag, one other tag, two other tags; bound, flat and other requirements ignored', () => {
  const mk = (id, runTag, over = {}) => ({ ...A.scenarios[0], id, run: runTag, ...over });
  assert.deepEqual(TS.earlierRun([], 'ORD-1', 'a'), { tag: null });
  assert.deepEqual(TS.earlierRun([mk('x1', undefined)], 'ORD-1', 'a'), { tag: null });
  assert.match(TS.earlierRun([mk('x1', 'a')], 'ORD-1', 'a').error, /^run a already has minted scenarios for ORD-1: give the second extraction a different run tag$/);
  assert.deepEqual(TS.earlierRun([mk('x1', 'a'), mk('x2', 'a')], 'ORD-1', 'b'), { tag: 'a' });
  assert.match(TS.earlierRun([mk('x1', 'a'), mk('x2', 'b')], 'ORD-1', 'c').error, /^ORD-1 has minted scenarios from more than one earlier run \(a, b\): variance compares two runs; bind or delete one set first$/);
  assert.deepEqual(TS.earlierRun([mk('x1', 'a'), mk('x2', 'z', { status: 'bound' }), mk('x3', 'q', { requirement: 'OTHER-1' }), { ...FLAT, run: 'y' }], 'ORD-1', 'b'), { tag: 'a' });
});
test('coverage: sentences are shared, results unchanged', () => {
  const c = TS.coverage(PAGE, [{ ...A.scenarios[0] }]);
  assert.equal(c.total, 3); assert.equal(c.covered, 1);
  assert.ok(c.uncovered.includes(S2));
});

// ---- writes (slice 3) ----
const earlierOf = side0 => side0.scenarios.map(rec => ({ path: `test-scenarios/${rec.id}.yaml`, rec }));
const listOf = args => args.scenarios;
test('varianceWrites: one question on run a sentence-1 scenario; bind and the gate block on it', () => {
  const d = diff(A, BDIFF);
  const w = TS.varianceWrites(d, earlierOf(A), listOf(run('ORD-1.b-differ')));
  assert.equal(w.updates.length, 1);
  assert.deepEqual(w.mint, []);
  assert.equal(w.updates[0].path, 'test-scenarios/ORD-1-ts-01.yaml');
  assert.deepEqual(w.updates[0].added, [d[0].question]);
  const rec = w.updates[0].rec;
  assert.deepEqual(rec.questions, [d[0].question]);
  assert.match(TS.bindProblem(rec), /^1 open question: /);
  assert.ok(TS.clauses({ specs: [], testScenarios: [{ ...rec, _path: w.updates[0].path }] }).some(c => c.text === 'ORD-1-ts-01: 1 open question(s) block binding'));
  assert.deepEqual(yaml.load(TS.fileText(rec, dump)).questions, [d[0].question]);
});
test('varianceWrites: running again adds nothing; a hand-written question stays first', () => {
  const d = diff(A, BDIFF);
  const first = TS.varianceWrites(d, earlierOf(A), listOf(run('ORD-1.b-differ')));
  const A2 = { run: 'a', scenarios: [first.updates[0].rec, A.scenarios[1]] };
  assert.deepEqual(TS.varianceWrites(diff(A2, BDIFF), earlierOf(A2), listOf(run('ORD-1.b-differ'))).updates, []);
  const hand = { run: 'a', scenarios: [{ ...A.scenarios[0], questions: ['Is it case sensitive?'] }, A.scenarios[1]] };
  const w = TS.varianceWrites(diff(hand, BDIFF), earlierOf(hand), listOf(run('ORD-1.b-differ')));
  assert.deepEqual(w.updates[0].rec.questions, ['Is it case sensitive?', d[0].question]);
  assert.deepEqual(w.updates[0].added, [d[0].question]);
});
test('varianceWrites: a sentence only b covers is minted with the question', () => {
  const a1 = { run: 'a', scenarios: [A.scenarios[0]] };
  const args = run('ORD-1.a');
  const d = diff(a1, side(args));
  assert.equal(d.length, 1);
  const w = TS.varianceWrites(d, earlierOf(a1), args.scenarios);
  assert.deepEqual(w.updates, []);
  assert.equal(w.mint.length, 1);
  assert.equal(w.mint[0].quote, S2);
  assert.deepEqual(w.mint[0].questions, [d[0].question]);
});
