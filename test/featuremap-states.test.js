'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FM = require('../renderer/featuremap.js');
const { orders, ctx, clean, run } = require('./helpers/featuremap.js');

const fm2 = (rec, c) => run(FM, rec, c || ctx(), 'FM002');

test('FM002: a clean feature has none', () => assert.deepEqual(fm2(clean()), []));

test('FM002: a from must be <screen>:<state> on one of the feature screens', () => {
  let f = clean(); f.journeys[0].from = 'ready';
  assert.match(fm2(f)[0].msg, /^orders-tag: journey "apply-tag" from must be <screen>:<state>/);
  f = clean(); f.journeys[0].from = 'billing:ready';
  assert.match(fm2(f)[0].msg, /^orders-tag: journey "apply-tag" from names screen "billing", which is not one of this feature's screens/);
  f = clean(); f.entry_points[1].from = 'billing:ready';
  assert.match(fm2(f)[0].msg, /^orders-tag: entry point "header-button" from names screen "billing"/);
});

test('FM002: a from state must be a state of the spec, and reachable from the initial state', () => {
  let f = clean(); f.journeys[0].from = 'orders:ghost';
  const p = fm2(f); assert.equal(p.length, 1);
  assert.match(p[0].msg, /^orders-tag: journey "apply-tag" from names state "ghost", which the orders spec does not have\. Its states are loading, ready/);
  const cut = JSON.parse(JSON.stringify(orders)); cut.transitions = cut.transitions.filter(t => t.to !== 'tag-popover' && t.from !== 'tag-popover');
  f = clean(); f.journeys[0].from = 'orders:tag-popover';
  const u = fm2(f, ctx({ specs: { orders: cut } }));
  assert.ok(u.some(x => /^orders-tag: journey "apply-tag" from "orders:tag-popover" cannot be reached from the orders spec's initial state/.test(x.msg)), JSON.stringify(u));
  // reachable over any transition, commits included: tagged is only reachable through the commits one
  f = clean(); f.journeys[0].from = 'orders:tagged';
  assert.deepEqual(fm2(f).filter(x => /cannot be reached/.test(x.msg)), []);
});

test('FM002: reachability is skipped when the spec has not exactly one initial state', () => {
  const two = JSON.parse(JSON.stringify(orders)); two.states.ready.initial = true;
  const none = JSON.parse(JSON.stringify(orders)); delete none.states.loading.initial;
  const cut = (s) => { s.transitions = s.transitions.filter(t => t.to !== 'tag-popover'); return s; };
  const f = clean(); f.journeys[0].from = 'orders:tag-popover';
  for (const s of [two, none]) assert.deepEqual(fm2(f, ctx({ specs: { orders: cut(s) } })).filter(x => /cannot be reached/.test(x.msg)), []);
});

test('FM002: every step state and proves.ui.state is a state of the screen; bare means the current screen', () => {
  let f = clean(); f.journeys[0].steps[1].state = 'ghost';
  let p = fm2(f); assert.equal(p.length, 1);
  assert.match(p[0].msg, /^orders-tag: journey "apply-tag" step 2 names state "ghost", which the orders spec does not have/);
  f = clean(); f.journeys[0].proves.ui.state = 'ghost';
  p = fm2(f); assert.match(p[0].msg, /^orders-tag: journey "apply-tag" proves\.ui names state "ghost"/);
  f = clean(); f.journeys[0].steps[1].state = 'billing:ready';
  assert.match(fm2(f)[0].msg, /step 2 names screen "billing", which is not one of this feature's screens/);
});

test('FM002: a bare state after a <screen>:<state> step resolves to that screen', () => {
  const second = { screen: 'billing', states: { start: { initial: true }, paid: {} }, transitions: [{ from: 'start', to: 'paid' }] };
  const c = ctx({ specs: { orders, billing: second } });
  const f = clean(); f.screens = ['orders', 'billing'];
  f.journeys[0].steps = [{ click: { role: 'button', name: 'Pay' }, state: 'billing:start' }, { click: { role: 'button', name: 'Go' }, state: 'paid' }];
  f.journeys[0].proves = { ui: { state: 'paid' } };
  assert.deepEqual(fm2(f, c), [], 'paid is billing\'s, not orders\'');
  f.journeys[0].steps[1].state = 'tagged';   // an orders state, but the current screen is billing now
  const p = fm2(f, c);
  assert.ok(p.some(x => /step 2 names state "tagged", which the billing spec does not have/.test(x.msg)), JSON.stringify(p));
});

test('FM002: no entry marker and an entry point from another state is a problem; with the marker, or the same from, it is not', () => {
  const f = clean(); f.journeys[0].steps = f.journeys[0].steps.slice(1);
  assert.deepEqual(fm2(f), [], 'the entry point from orders:ready matches the journey from');
  f.entry_points[1].from = 'orders:loading';
  const p = fm2(f); assert.equal(p.length, 1);
  assert.match(p[0].msg, /^orders-tag: journey "apply-tag" has no entry marker, but entry point "header-button" starts from "orders:loading", not "orders:ready"/);
  const g = clean(); g.entry_points[1].from = 'orders:loading';
  assert.deepEqual(fm2(g), [], 'with the entry marker there is no such problem');
  const h = clean(); h.journeys[0].steps = h.journeys[0].steps.slice(1); h.entry_points[1].from = 'orders:loading'; h.entry_points.splice(0, 1);
  h.entry_points.push({ id: 'deep', via: { goto: { path: '/o' } } });
  assert.equal(fm2(h).length, 1, 'an entry point with no from never differs');
});

test('FM002: a null or missing spec skips the state checks (a missing spec is FM001\'s)', () => {
  const f = clean(); f.journeys[0].from = 'orders:ghost'; f.journeys[0].steps[1].state = 'ghost'; f.journeys[0].proves.ui.state = 'ghost';
  assert.equal(fm2(f).length, 3);
  assert.deepEqual(fm2(f, ctx({ specs: null })), []);
  assert.deepEqual(fm2(f, ctx({ specs: {} })), []);
});
