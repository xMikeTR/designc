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
