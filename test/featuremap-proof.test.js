'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FM = require('../renderer/featuremap.js');
const { orders, ctx, clean, run } = require('./helpers/featuremap.js');

const fm4 = (rec, c) => run(FM, rec, c || ctx(), 'FM004');

test('FM004: a clean feature has none', () => assert.deepEqual(fm4(clean()), []));

test('FM004: every journey needs proves.ui.state', () => {
  for (const bad of [undefined, {}, { ui: {} }, { ui: { state: '' } }, 'ok']) {
    const f = clean(); f.journeys[0].proves = bad; if (bad === undefined) delete f.journeys[0].proves;
    const p = fm4(f).filter(x => /needs proves\.ui\.state/.test(x.msg));
    assert.equal(p.length, 1, JSON.stringify(bad)); assert.match(p[0].msg, /^orders-tag: journey "apply-tag" needs proves\.ui\.state/);
  }
});

test('FM004: proves.ui.contains is a list of {role, name} or {role, text}', () => {
  for (const bad of [{ role: 'x' }, [{ role: 'x' }], [{ name: 'x' }], [{ role: 'x', name: 'a', text: 'b' }]]) {
    const f = clean(); f.journeys[0].proves.ui.contains = bad;
    assert.equal(fm4(f).length, 1, JSON.stringify(bad));
  }
  const f = clean(); f.journeys[0].proves.ui.contains = [{ role: 'link', name: 'Download' }, { role: 'status', text: 'Done' }];
  assert.deepEqual(fm4(f), []);
});

test('FM004: crossing a commits transition needs proves.effect; with it there is no problem', () => {
  const f = clean(); delete f.journeys[0].proves.effect;
  const p = fm4(f); assert.equal(p.length, 1);
  assert.match(p[0].msg, /^orders-tag: journey "apply-tag" step 4 crosses the "tag-popover" to "tagged" transition, which commits\. Add proves\.effect/);
  const g = clean(); assert.deepEqual(fm4(g), []);
});

test('FM004: only a step that crosses the commits transition needs an effect', () => {
  const f = clean(); f.journeys[0].steps = [{ click: { role: 'button', name: 'Tag orders' }, state: 'tag-popover' }]; f.journeys[0].proves = { ui: { state: 'tag-popover' } };
  assert.deepEqual(fm4(f), [], 'ready to tag-popover does not commit');
  const g = clean(); g.journeys[0].from = 'orders:tag-popover'; g.journeys[0].steps = [{ click: { role: 'button', name: 'Apply' }, state: 'tagged' }]; delete g.journeys[0].proves.effect;
  assert.equal(fm4(g).length, 1, 'the first step crosses from the journey\'s from state');
  const noCommit = JSON.parse(JSON.stringify(orders)); noCommit.transitions.forEach(t => { delete t.commits; });
  assert.deepEqual(fm4(g, ctx({ specs: { orders: noCommit } })), [], 'no commits flag, no effect needed');
  assert.deepEqual(fm4(g, ctx({ specs: null })), [], 'an unknown spec skips the crossing');
});

test('FM004: effect.api is a read-only call with a path', () => {
  let f = clean(); f.journeys[0].proves.effect.api.method = 'POST';
  let p = fm4(f); assert.equal(p.length, 1); assert.match(p[0].msg, /^orders-tag: journey "apply-tag" proves\.effect\.api\.method must be GET or HEAD.*"POST"/);
  f = clean(); f.journeys[0].proves.effect.api.method = 'HEAD'; assert.deepEqual(fm4(f), []);
  f = clean(); f.journeys[0].proves.effect.api.path = 'api/orders'; assert.match(fm4(f)[0].msg, /api\.path must start with \//);
  f = clean(); f.journeys[0].proves.effect = { expect: {} }; assert.match(fm4(f)[0].msg, /proves\.effect needs api/);
  f = clean(); f.journeys[0].proves.effect.expect = 'ok'; assert.match(fm4(f)[0].msg, /expect must be a mapping/);
});

test('FM004: expect.shape is not checked in slice 1', () => {
  const f = clean(); f.journeys[0].proves.effect.expect = { status: 200, shape: { anything: ['at all', 1, null] } };
  assert.deepEqual(fm4(f), []);
});
