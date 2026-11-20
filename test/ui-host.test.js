// B2: a spec with `host {screen, state, anchor}` is an overlay (hosted spec). hostRules (renderer/ui.js) checks it against the host spec.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ui = require('../renderer/ui.js');

const spec = (o = {}) => ({
  screen: 'orders', component: 'OrdersList', intent: 'Clerks browse orders and tag the matching ones.', template: 'list-detail', data: {},
  slots: { 'header.actions': [{ id: 'tag', component: 'Button', props: { label: 'Tag orders' }, locator: { role: 'button', name: 'Tag orders' } }] },
  states: { ready: { initial: true }, 'tag-popover': {}, tagged: {} },
  transitions: [{ from: 'ready', to: 'tag-popover', on: { click: { role: 'button', name: 'Tag orders' } } }],
  status: 'minted', ...o,
});
const hosted = (host = {}) => spec({ screen: 'orders-tag', component: 'OrdersTagPopover', template: 'popover-form', slots: {}, states: { editing: { initial: true } }, transitions: [], host: { screen: 'orders', state: 'tag-popover', anchor: 'tag', ...host } });
const files = list => list.map(s => ({ path: `ui/specs/${s.screen}.json`, text: JSON.stringify(s) }));
const hostClauses = list => Ui.clauses({ specs: files(list) }).clauses.filter(c => /\/host/.test(c.text));

test('a hosted spec whose host, state, anchor and opening transition exist gets no host clause', () => {
  assert.deepEqual(hostClauses([spec(), hosted()]), []);
});
test('a spec without host gets no host clause', () => {
  assert.deepEqual(hostClauses([spec()]), []);
});
test('host.screen that is not a spec is a clause', () => {
  const r = hostClauses([spec(), hosted({ screen: 'nowhere' })]);
  assert.equal(r.length, 1);
  assert.match(r[0].text, /^ui\/specs\/orders-tag\.json \/host\/screen: .*nowhere.* is not a spec in ui\/specs/);
  assert.equal(r[0].kind, 'ui'); assert.equal(r[0].screen, 'orders-tag');
});
test('host.screen naming the spec itself is a clause', () => {
  const r = hostClauses([spec(), hosted({ screen: 'orders-tag' })]);
  assert.equal(r.length, 1);
  assert.match(r[0].text, /\/host\/screen: .*cannot host itself/);
});
test('host.state that the host spec does not have is a clause naming the states it has', () => {
  const r = hostClauses([spec(), hosted({ state: 'open' })]);
  assert.equal(r.length, 1);
  assert.match(r[0].text, /\/host\/state: State 'open' is not in spec orders\. The spec has: ready, tag-popover, tagged/);
});
test('an anchor that is not a placement id of the host is a clause', () => {
  const r = hostClauses([spec(), hosted({ anchor: 'nope' })]);
  assert.equal(r.length, 1);
  assert.match(r[0].text, /\/host\/anchor: 'nope' is not a placement id in spec orders/);
});
test('an anchor placement with no locator is a clause', () => {
  const s = spec(); delete s.slots['header.actions'][0].locator;
  const r = hostClauses([s, hosted()]);
  assert.equal(r.length, 1);
  assert.match(r[0].text, /\/host\/anchor: placement 'tag' in spec orders has no locator/);
});
test('a host with no click transition into the state on the anchor locator is a clause, saying what does lead there', () => {
  const s = spec({ transitions: [{ from: 'ready', to: 'tag-popover', on: { click: { role: 'button', name: 'Other' } } }] });
  const r = hostClauses([s, hosted()]);
  assert.equal(r.length, 1);
  assert.match(r[0].text, /\/host: spec orders has no transition into 'tag-popover' that clicks button 'Tag orders'/);
  assert.match(r[0].text, /Transitions into it: ready → tag-popover on click button 'Other'/);
  const none = hostClauses([spec({ transitions: [] }), hosted()]);
  assert.equal(none.length, 1);
  assert.match(none[0].text, /no transition into 'tag-popover'.*No transition leads into it/);
});
test('a host that is itself hosted is a clause (one level only)', () => {
  const outer = spec({ host: { screen: 'base', state: 'x', anchor: 'y' } });
  const base = spec({ screen: 'base', component: 'Base', states: { x: { initial: true } }, slots: { main: [{ id: 'y', component: 'Button', props: {}, locator: { role: 'button', name: 'Y' } }] }, transitions: [] });
  const r = hostClauses([base, outer, hosted()]);
  assert.ok(r.some(c => /ui\/specs\/orders-tag\.json \/host\/screen: .*orders.* is itself hosted/.test(c.text)), r.map(c => c.text).join('\n'));
});
test('an unknown key inside host is refused by the schema', () => {
  const s = hosted(); s.host.extra = 1;
  const r = Ui.clauses({ specs: files([spec(), s]) }).clauses;
  assert.ok(r.some(c => /host/.test(c.text) && /extra|additional/i.test(c.text)), r.map(c => c.text).join('\n'));
});
