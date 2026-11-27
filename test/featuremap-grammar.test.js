'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FM = require('../renderer/featuremap.js');
const Parity = require('../renderer/parity.js');
const { ctx, clean, run } = require('./helpers/featuremap.js');

const fm3 = (rec, c) => run(FM, rec, c || ctx(), 'FM003');
const step = (f, s) => { f.journeys[0].steps.push(s); return fm3(f); };

test('FM003: a clean feature has none', () => assert.deepEqual(fm3(clean()), []));

test('FM003: journeys is a non-empty list of {id, from, steps}; ids are slugs and unique', () => {
  for (const bad of [undefined, [], 'x']) { const f = clean(); f.journeys = bad; if (bad === undefined) delete f.journeys; assert.match(fm3(f)[0].msg, /^orders-tag: journeys must be a non-empty list/); }
  let f = clean(); f.journeys[0].id = 'Bad Id'; assert.match(fm3(f)[0].msg, /^orders-tag: journey "Bad Id" needs an id that is a slug/);
  f = clean(); f.journeys.push(JSON.parse(JSON.stringify(f.journeys[0]))); assert.match(fm3(f)[0].msg, /^orders-tag: journey "apply-tag" repeats an id/);
  f = clean(); delete f.journeys[0].from; assert.match(fm3(f)[0].msg, /^orders-tag: journey "apply-tag" needs from/);
  f = clean(); delete f.journeys[0].steps; assert.match(fm3(f)[0].msg, /^orders-tag: journey "apply-tag" needs steps/);
});

test('FM003: entry_points are {id, from?, via}; ids are slugs and unique; via is one step that is not entry', () => {
  let f = clean(); f.entry_points = {}; assert.match(fm3(f)[0].msg, /entry_points must be a list/);
  f = clean(); f.entry_points[0].id = 'Bad Id'; assert.match(fm3(f)[0].msg, /^orders-tag: entry point "Bad Id" needs an id that is a slug/);
  f = clean(); f.entry_points[1].id = 'deep-link'; assert.match(fm3(f)[0].msg, /^orders-tag: entry point "deep-link" repeats an id/);
  f = clean(); delete f.entry_points[0].via; assert.match(fm3(f)[0].msg, /^orders-tag: entry point "deep-link" needs via/);
  f = clean(); f.entry_points[0].via = 'entry';
  const p = fm3(f); assert.equal(p.length, 1); assert.match(p[0].msg, /^orders-tag: entry point "deep-link" via: an entry point goes through one real step, not the word entry/);
  f = clean(); f.entry_points[0].via = { click: { role: 'button' } };
  assert.match(fm3(f)[0].msg, /^orders-tag: entry point "deep-link" via: click needs a name/);
  f = clean(); f.entry_points[0].via = { goto: { path: '/a' }, click: { role: 'button', name: 'x' } };
  assert.match(fm3(f)[0].msg, /via: a step needs exactly one of goto, click, fill, select, press, wait/);
});

test('FM003: goto, click, fill and select go through Parity.stepProblem unchanged', () => {
  const bad = { click: { role: 'button' } };   // no name
  const want = Parity.stepProblem(bad);
  assert.ok(want);
  const p = step(clean(), bad);
  assert.equal(p.length, 1);
  assert.equal(p[0].msg, `orders-tag: journey "apply-tag" step 7: ${want}.`);
  for (const s of [{ goto: {} }, { fill: { role: 'textbox', name: 'x' } }, { select: { role: 'combobox', name: 'x', index: -1, value: 'v' } }, { click: { role: 'button', name: 'x' }, state: ' ' }]) {
    assert.ok(Parity.stepProblem(s));
    assert.ok(step(clean(), s)[0].msg.endsWith(`step 7: ${Parity.stepProblem(s)}.`));
  }
  assert.deepEqual(Parity.ACTIONS, ['goto', 'click', 'fill', 'select'], 'parity\'s grammar is not widened');
});

test('FM003: press is a non-empty string; a step is entry or exactly one action', () => {
  assert.deepEqual(step(clean(), { press: 'Control+E', state: 'ready' }), []);
  for (const s of [{ press: '' }, { press: { key: 'a' } }, { press: 'a', state: '' }]) assert.equal(step(clean(), s).length, 1, JSON.stringify(s));
  assert.match(step(clean(), { press: 'a', click: { role: 'button', name: 'x' } })[0].msg, /step 7: a step needs exactly one of/);
  assert.match(step(clean(), {})[0].msg, /step 7: a step needs exactly one of/);
  assert.match(step(clean(), 'click')[0].msg, /step 7: a step is the word entry or a mapping/);
});

test('FM003: wait is {role, name} or {text}; at least one of name or text; text is not name', () => {
  assert.deepEqual(step(clean(), { wait: { role: 'status', name: 'Done' } }), []);
  assert.deepEqual(step(clean(), { wait: { text: 'Export ready' } }), []);
  assert.match(step(clean(), { wait: { role: 'status' } })[0].msg, /^orders-tag: journey "apply-tag" step 7: wait needs a name or a text/);
  assert.match(step(clean(), { wait: {} })[0].msg, /wait needs a name or a text/);
  assert.match(step(clean(), { wait: 'status' })[0].msg, /wait needs a mapping/);
  assert.match(step(clean(), { wait: { role: 'status', name: 'a', text: 'b' } })[0].msg, /not both/);
  assert.match(step(clean(), { wait: { name: 'a' } })[0].msg, /wait with a name needs a role/);
});

test('FM003: entry at most once per journey', () => {
  const p = step(clean(), 'entry'); assert.equal(p.length, 1);
  assert.match(p[0].msg, /^orders-tag: journey "apply-tag" has the entry marker more than once/);
});

test('FM003: every {param: x} in steps or via names a key of preconditions.data', () => {
  let p = step(clean(), { fill: { role: 'textbox', name: 'x', value: { param: 'ghost' } } });
  assert.equal(p.length, 1); assert.match(p[0].msg, /^orders-tag: journey "apply-tag" steps uses \{param: ghost\}, which preconditions\.data does not declare/);
  const f = clean(); f.entry_points[0].via = { fill: { role: 'textbox', name: 'x', value: { param: 'ghost' } } };
  p = fm3(f); assert.equal(p.length, 1); assert.match(p[0].msg, /^orders-tag: entry point "deep-link" via uses \{param: ghost\}/);
  const g = clean(); delete g.preconditions; assert.match(fm3(g)[0].msg, /uses \{param: tag\}/);
  const h = clean(); h.preconditions = { data: { tag: 'x' } }; assert.match(fm3(h)[0].msg, /preconditions\.data\.tag must be \{param: name\}/);
  const i = clean(); i.preconditions = 'clerk'; assert.match(fm3(i)[0].msg, /preconditions must be a mapping/);
});
