'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FM = require('../renderer/featuremap.js');
const { ctx, clean, file, run } = require('./helpers/featuremap.js');

const fm1 = (rec, c, p) => FM.problems([file(rec, p)], c || ctx()).filter(x => x.code === 'FM001');

test('FM001: a clean feature has no problems at all', () => assert.deepEqual(run(FM, clean()), []));

test('FM001: id missing, not a slug, not the file name', () => {
  let f = clean(); delete f.id;
  assert.match(fm1(f, ctx(), 'features/orders-tag.yaml')[0].msg, /^\(no id\): the file has no id/);
  f = clean(); f.id = 'Orders_Tag';
  const p = fm1(f, ctx(), 'features/Orders_Tag.yaml');
  assert.equal(p.length, 1); assert.match(p[0].msg, /^Orders_Tag: the id must be a slug/);
  f = clean(); f.id = 'other-name';
  assert.match(fm1(f, ctx(), 'features/orders-tag.yaml')[0].msg, /^other-name: the id must equal the file name\. Rename the file to other-name\.yaml/);
  assert.deepEqual(fm1(clean(), ctx(), 'features/orders-tag.yml'), [], 'a .yml file name is fine');
});

test('FM001: the same id in two files, and x.yaml with x.yml, name both files', () => {
  const a = file(clean(), 'features/orders-tag.yaml'), b = file(clean(), 'features/orders-tag.yml');
  const p = FM.problems([a, b], ctx()).filter(x => x.code === 'FM001');
  assert.equal(p.length, 2);
  for (const x of p) assert.match(x.msg, /^orders-tag: the id is used by more than one file \(features\/orders-tag\.yaml and features\/orders-tag\.yml\)/);
  assert.deepEqual(p.map(x => x.path).sort(), ['features/orders-tag.yaml', 'features/orders-tag.yml']);
});

test('FM001: title and intent must be non-empty strings', () => {
  for (const k of ['title', 'intent']) {
    for (const bad of [undefined, '', '  ', 5]) {
      const f = clean(); f[k] = bad; if (bad === undefined) delete f[k];
      const p = fm1(f); assert.equal(p.length, 1, `${k}=${bad}`); assert.match(p[0].msg, new RegExp(`^orders-tag: ${k} must be`));
    }
  }
});

test('FM001: screens is a non-empty list of screens that have a spec', () => {
  for (const bad of [undefined, [], 'orders', [5]]) { const f = clean(); f.screens = bad; if (bad === undefined) delete f.screens; assert.match(fm1(f)[0].msg, /^orders-tag: screens must be a non-empty list/, JSON.stringify(bad)); }
  const f = clean(); f.screens = ['orders', 'nope'];
  const p = fm1(f); assert.equal(p.length, 1); assert.match(p[0].msg, /^orders-tag: screen "nope" has no spec/);
});

test('FM001: elements, requirements, acceptance, test_scenarios must be known; aliases a list of strings', () => {
  const cases = [['elements', 'Nope', /elements names "Nope", which is not an element/], ['requirements', 'RE-9', /requirements names "RE-9"/], ['acceptance', 'AC-9', /acceptance names "AC-9"/], ['test_scenarios', 'TS-9', /test_scenarios names "TS-9"/]];
  for (const [k, v, re] of cases) { const f = clean(); f[k] = [v]; const p = fm1(f); assert.equal(p.length, 1, k); assert.match(p[0].msg, re); assert.match(p[0].msg, /^orders-tag: /); }
  const f = clean(); f.requirements = 'ORD-1'; assert.match(fm1(f)[0].msg, /requirements must be a list/);
  const g = clean(); g.aliases = 'bulk'; assert.match(fm1(g)[0].msg, /aliases must be a list/);
  const h = clean(); h.aliases = [1]; assert.match(fm1(h)[0].msg, /aliases must be a list/);
});

test('FM001: a null ctx input skips the check that needs it (unknown is never a problem)', () => {
  const f = clean(); f.screens = ['orders', 'nope']; f.elements = ['Nope']; f.requirements = ['X']; f.acceptance = ['X']; f.test_scenarios = ['X'];
  assert.equal(fm1(f).length, 5);
  assert.deepEqual(fm1(f, ctx({ elements: null })).filter(x => /elements names/.test(x.msg)), []);
  assert.deepEqual(fm1(f, ctx({ requirements: null })).filter(x => /requirements names/.test(x.msg)), []);
  assert.deepEqual(fm1(f, ctx({ acceptance: null })).filter(x => /acceptance names/.test(x.msg)), []);
  assert.deepEqual(fm1(f, ctx({ testScenarios: null })).filter(x => /test_scenarios names/.test(x.msg)), []);
  assert.deepEqual(fm1(f, ctx({ specs: null })).filter(x => /has no spec/.test(x.msg)), []);
  assert.deepEqual(fm1(f, { specs: null, elements: null, requirements: null, acceptance: null, testScenarios: null }).map(x => x.msg), [], 'nothing known: nothing wrong');
});
