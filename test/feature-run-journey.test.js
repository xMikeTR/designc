'use strict';
// recorder/journey.js: the feature journey executor, ready probe, and the adapter additions that serve it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const J = require('../recorder/journey.js');
const Recorder = require('../recorder/index.js');
const Parity = require('../renderer/parity.js');
const Fixture = require('../recorder/adapters/fixture.js');

const FX = path.join(__dirname, 'fixtures', 'feature-run');
const app = () => JSON.parse(fs.readFileSync(path.join(FX, 'app.json'), 'utf8'));
const feature = () => yaml.load(fs.readFileSync(path.join(FX, 'registry', 'features', 'orders-export.yaml'), 'utf8'));
const READY = { goto: '/orders', expect: { role: 'heading', name: 'Orders' }, api: { method: 'GET', path: '/health' } };
const node = (role, name, children = []) => ({ role, name, box: null, children });

// An adapter that counts open and close calls, and can throw from act.
function counting(inner, { throwOn } = {}) {
  const c = { opens: 0, closes: 0 };
  return Object.assign(c, {
    name: 'counting',
    async open(o) {
      c.opens++;
      const s = await inner.open(o);
      return { ...s, async act(step) { if (throwOn && throwOn(step)) throw new Error('boom'); return s.act(step); }, async close() { c.closes++; return s.close(); } };
    },
  });
}

test('runs: the marker is replaced by each entry point, step numbers are 1-based over the expansion', () => {
  const r = J.runs(feature());
  assert.deepStrictEqual(r.map(x => [x.journey, x.entry]), [['export-all', 'header-button'], ['export-all', 'shortcut']]);
  assert.deepStrictEqual(r[0].steps, [{ click: { role: 'button', name: 'Export' } }, { wait: { role: 'status', text: 'Export ready' } }]);
  assert.deepStrictEqual(r[1].steps[0], { press: 'Control+E' });
});

test('runs: with no marker the entry point goes before the first step', () => {
  const f = feature();
  f.journeys[0].steps = [{ wait: { role: 'status', text: 'x' } }];
  const r = J.runs(f);
  assert.deepStrictEqual(r[0].steps[0], { click: { role: 'button', name: 'Export' } });
  assert.strictEqual(r[0].steps.length, 2);
});

test('runs: no entry_points gives one run per journey with entry null and drops the marker', () => {
  const f = feature();
  delete f.entry_points;
  const r = J.runs(f);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].entry, null);
  assert.deepStrictEqual(r[0].steps, [{ wait: { role: 'status', text: 'Export ready' } }]);
});

test('runs: journey filter', () => {
  const f = feature();
  f.journeys.push({ id: 'second', from: 'orders:ready', steps: [{ goto: { path: '/orders' } }], proves: { ui: { state: 'ready' } } });
  assert.strictEqual(J.runs(f).length, 4);
  assert.deepStrictEqual(J.runs(f, 'second').map(x => x.journey), ['second', 'second']);
  assert.deepStrictEqual(J.runs(f, 'nope'), []);
});

test('resolveStep: press, wait by name and by text, param in fill, missing param', () => {
  assert.deepStrictEqual(J.resolveStep({ press: 'Control+E' }, {}), { action: 'press', args: 'Control+E' });
  assert.deepStrictEqual(J.resolveStep({ wait: { role: 'status', text: 'Done' } }, {}), { action: 'wait', args: { role: 'status', text: 'Done' } });
  assert.deepStrictEqual(J.resolveStep({ wait: { role: 'dialog', name: 'Hi' } }, {}).args, { role: 'dialog', name: 'Hi' });
  assert.deepStrictEqual(J.resolveStep({ fill: { role: 'combobox', name: 'Cedant', value: { param: 'cedant' } } }, { cedant: 'Acme' }).args.value, 'Acme');
  assert.strictEqual(J.resolveStep({ fill: { role: 'combobox', name: 'Cedant', value: { param: 'cedant' } } }, {}).missingParam, 'cedant');
  assert.deepStrictEqual(J.resolveStep({ goto: { path: '/x' } }, {}), { action: 'goto', args: { path: '/x' } });
});

test('findText: joined subtree names, role must match', () => {
  const t = node('RootWebArea', 'p', [node('status', '', [node('text', 'Export'), node('text', 'ready')]), node('link', 'Export ready')]);
  assert.ok(J.findText(t, 'status', 'Export ready'));
  assert.strictEqual(J.findText(t, 'alert', 'Export ready'), null);
  assert.strictEqual(J.findText(t, 'status', 'nothing'), null);
  assert.ok(J.findText(t, 'link', 'ready'));
});

const ready = (session, cfg) => J.ready(session, cfg);
async function session(fx = app()) { return Fixture.create(fx).open({ params: {} }); }

test('ready probe: pass', async () => {
  assert.deepStrictEqual(await ready(await session(), READY), { ok: true });
});

test('ready probe: every failure carries a message', async () => {
  const bad = async (s, cfg) => { const r = await ready(s, cfg); assert.strictEqual(r.ok, false); assert.ok(r.msg); return r; };
  await bad(await session(), { ...READY, expect: { role: 'heading', name: 'Nope' } });
  const fx = app(); fx.api['GET /health'] = 500;
  await bad(await session(fx), READY);
  let called = false;
  const s = await session();
  s.request = async () => { called = true; return { status: 200 }; };
  await bad(s, { ...READY, api: { method: 'POST', path: '/health' } });
  assert.strictEqual(called, false);
  const none = await bad(await session(), undefined);
  assert.match(none.msg, /verify\.ready/);
  const s2 = await session(); delete s2.request;
  const no = await bad(s2, READY);
  assert.match(no.msg, /request/);
  await bad(await session(), { goto: '/missing' });
});

test('ready probe: text expect', async () => {
  const s = await session();
  assert.strictEqual((await ready(s, { goto: '/orders', expect: { role: 'heading', text: 'Ord' } })).ok, true);
});

test('runFeature: all runs pass', async () => {
  const ad = counting(Fixture.create(app()));
  const r = await J.runFeature({ feature: feature(), adapter: ad, params: {}, ready: READY });
  assert.strictEqual(r.outcome, 'pass');
  assert.strictEqual(r.feature, 'orders-export');
  assert.deepStrictEqual(r.journeys.map(j => [j.entry, j.outcome, j.failures.length]), [['header-button', 'pass', 0], ['shortcut', 'pass', 0]]);
  assert.ok(r.journeys[0].capture.tree);
  assert.ok(r.journeys[0].shot && r.shots[r.journeys[0].shot]);
  assert.deepStrictEqual([ad.opens, ad.closes], [2, 2]);
});

test('runFeature: screenshots off leaves no shot', async () => {
  const r = await J.runFeature({ feature: feature(), adapter: Fixture.create(app()), params: {}, ready: READY, screenshots: false });
  assert.deepStrictEqual(r.shots, {});
  assert.strictEqual(r.journeys[0].shot, undefined);
});

test('runFeature: a dead shortcut fails that run at contains, the other passes', async () => {
  const fx = app(); fx.on = fx.on.filter(o => !o.press);
  const r = await J.runFeature({ feature: feature(), adapter: Fixture.create(fx), params: {}, ready: READY });
  assert.strictEqual(r.outcome, 'fail');
  assert.strictEqual(r.journeys[0].outcome, 'pass');
  // The wait step already fails on the dead shortcut: the status never appears.
  assert.strictEqual(r.journeys[1].outcome, 'fail');
});

test('runFeature: a dead shortcut with no wait fails at contains, kind state', async () => {
  const f = feature(); f.journeys[0].steps = ['entry'];
  const fx = app(); fx.on = fx.on.filter(o => !o.press);
  const r = await J.runFeature({ feature: f, adapter: Fixture.create(fx), params: {}, ready: READY });
  assert.strictEqual(r.outcome, 'fail');
  assert.strictEqual(r.journeys[0].outcome, 'pass');
  assert.deepStrictEqual(r.journeys[1].failures.map(x => x.kind), ['state']);
  assert.match(r.journeys[1].failures[0].msg, /link/);
});

test('runFeature: a missing button is a fail, kind step, with the 1-based step number', async () => {
  const fx = app(); fx.screens.list.children = fx.screens.list.children.filter(c => c.name !== 'Export');
  const r = await J.runFeature({ feature: feature(), adapter: Fixture.create(fx), params: {}, ready: READY, journey: 'export-all' });
  assert.strictEqual(r.journeys[0].outcome, 'fail');
  assert.deepStrictEqual([r.journeys[0].failures[0].step, r.journeys[0].failures[0].kind], [1, 'step']);
});

test('runFeature: a missing param is could_not_run', async () => {
  const f = feature(); f.journeys[0].steps = [{ fill: { role: 'combobox', name: 'Cedant', value: { param: 'cedant' } } }, 'entry'];
  const r = await J.runFeature({ feature: f, adapter: Fixture.create(app()), params: {}, ready: READY });
  assert.strictEqual(r.outcome, 'could_not_run');
  assert.match(r.journeys[0].failures[0].msg, /cedant/);
  assert.strictEqual(r.journeys[0].failures[0].kind, 'step');
});

test('runFeature: a committing click is could_not_run unless allowWrites', async () => {
  const f = feature(); f.entry_points[0].via = { click: { role: 'button', name: 'Save changes' } };
  const r = await J.runFeature({ feature: f, adapter: Fixture.create(app()), params: {}, ready: READY, journey: 'export-all' });
  assert.strictEqual(r.journeys[0].outcome, 'could_not_run');
  assert.strictEqual(r.journeys[0].failures[0].kind, 'step');
  const w = await J.runFeature({ feature: f, adapter: Fixture.create(app()), params: {}, ready: READY, allowWrites: true });
  assert.notStrictEqual(w.journeys[0].failures[0] && w.journeys[0].failures[0].msg.includes('changes data'), true);
});

test('runFeature: failing ready makes every run could_not_run, kind ready, step 0, and runs no steps', async () => {
  const fx = app(); fx.api['GET /health'] = 503;
  const r = await J.runFeature({ feature: feature(), adapter: Fixture.create(fx), params: {}, ready: READY });
  assert.strictEqual(r.outcome, 'could_not_run');
  for (const j of r.journeys) assert.deepStrictEqual([j.outcome, j.failures[0].step, j.failures[0].kind], ['could_not_run', 0, 'ready']);
  const none = await J.runFeature({ feature: feature(), adapter: Fixture.create(app()), params: {}, ready: undefined });
  assert.strictEqual(none.outcome, 'could_not_run');
});

test('runFeature: a wall is could_not_run kind ready; a throw is fail kind step; close runs after a throw', async () => {
  const wall = { name: 'w', async open() { return { async act() { return { wall: 'sso' }; }, async capture() { return { tree: node('RootWebArea', '') }; }, async screenshot() { return null; }, async close() {} }; } };
  const w = await J.runFeature({ feature: feature(), adapter: wall, params: {}, ready: { goto: '/' } });
  assert.deepStrictEqual([w.outcome, w.journeys[0].failures[0].kind], ['could_not_run', 'ready']);
  const ad = counting(Fixture.create(app()), { throwOn: s => s.press || s.click });
  const r = await J.runFeature({ feature: feature(), adapter: ad, params: {}, ready: READY });
  assert.strictEqual(r.outcome, 'fail');
  assert.strictEqual(r.journeys[0].failures[0].kind, 'step');
  assert.match(r.journeys[0].failures[0].msg, /boom/);
  assert.deepStrictEqual([ad.opens, ad.closes], [2, 2]);
});

test('runFeature: a feature with an effect is marked unchecked, never judged', async () => {
  const f = feature(); f.journeys[0].proves.effect = { api: { method: 'GET', path: '/api/x' }, expect: { status: 200 } };
  const r = await J.runFeature({ feature: f, adapter: Fixture.create(app()), params: {}, ready: READY });
  assert.strictEqual(r.outcome, 'pass');
  assert.strictEqual(r.journeys[0].effect, 'unchecked');
});

test('runFeature: failures are capped at 50', async () => {
  const f = feature();
  f.journeys[0].proves.ui.contains = Array.from({ length: 60 }, (_, i) => ({ role: 'link', name: `L${i}` }));
  const r = await J.runFeature({ feature: f, adapter: Fixture.create(app()), params: {}, ready: READY, journey: 'export-all' });
  assert.strictEqual(r.journeys[0].failures.length, 50);
});

test('fixture adapter: press without a matching on entry does nothing; wait and request', async () => {
  const s = await session();
  assert.deepStrictEqual(await s.act({ press: 'Control+Q' }), { ok: true });
  assert.ok((await s.act({ wait: { role: 'status', text: 'Export ready' } })).missing);
  assert.deepStrictEqual(await s.act({ wait: { role: 'button', name: 'Export' } }), { ok: true });
  assert.deepStrictEqual(await s.request({ method: 'GET', path: '/health' }), { status: 200 });
  assert.deepStrictEqual(await s.request({ method: 'GET', path: '/nope' }), { status: 404 });
  await s.act({ press: 'Control+E' });
  assert.deepStrictEqual(await s.act({ wait: { role: 'status', text: 'Export ready' } }), { ok: true });
});

test('web adapter exposes request and the new actions without launching a browser', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'recorder', 'adapters', 'web.js'), 'utf8');
  assert.match(src, /async request\(/);
  assert.match(src, /keyboard\.press/);
});

test('parity is unchanged: press, wait and entry are still rejected, ACTIONS is the four actions', () => {
  assert.deepStrictEqual(Recorder.ACTIONS, ['goto', 'click', 'fill', 'select']);
  const base = { id: 'x', title: 't', steps: [] };
  for (const step of [{ press: 'Control+E' }, { wait: { role: 'status', text: 'x' } }, 'entry']) {
    const p = Parity.scenarioProblems({ ...base, steps: [step] });
    assert.ok(p.length > 0, JSON.stringify(step));
  }
});
