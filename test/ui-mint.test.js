// The pure side of the compose and catalogue stages: what they read, and what a mint must pass before a card is shown.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Ui = require('../renderer/ui.js');
const { ROOT, load } = require('./helpers/ui.js');

const L = load();
const groups = Ui.tokenGroups(L.tokens);
const pack = Ui.readPack(L.pack, groups);
const specText = fs.readFileSync(path.join(ROOT, 'ui/specs/bordereaux.json'), 'utf8');
const spec = () => JSON.parse(specText);
const mint = (over = {}) => Ui.mintSpec({ screen: 'bordereaux', spec: { ...spec(), status: 'minted' }, pack, groups, ...over });

test('specList: one row per spec, an unparsable file is flagged', () => {
  const rows = Ui.specList([...L.specs, { path: 'ui/specs/bad.json', text: '{' }]);
  assert.ok(rows.find(r => r.screen === 'bordereaux' && Array.isArray(r.states)));
  assert.deepEqual(rows.find(r => r.path === 'ui/specs/bad.json'), { path: 'ui/specs/bad.json', unreadable: true });
});

test('packView: components, templates and the closed token groups, nothing else', () => {
  const v = Ui.packView(L.pack, groups);
  assert.ok(v.components.length && v.templates.length);
  assert.deepEqual(v.problems, []);
  assert.deepEqual(Object.keys(v.tokens).sort(), Ui.CLOSED_TOKEN_GROUPS.filter(g => groups[g]).sort());
});

test('specRows: slot, component, data bound, why', () => {
  const rows = Ui.specRows(spec());
  assert.ok(rows.length);
  for (const r of rows) assert.deepEqual(Object.keys(r), ['slot', 'component', 'data', 'why']);
  assert.deepEqual(Ui.specRows(null), []);
});

test('mintSpec: a minted spec that passes its checks gets a path and text', () => {
  const r = mint();
  assert.equal(r.error, undefined);
  assert.equal(r.path, 'ui/specs/bordereaux.json');
  assert.ok(r.text.endsWith('}\n'));
});

test('mintSpec: refused, with clauses, when the checks fail (no card)', () => {
  const bad = spec(); bad.status = 'minted'; bad.template = 'no-such-template';
  const r = Ui.mintSpec({ screen: 'bordereaux', spec: bad, pack, groups });
  assert.match(r.error, /fails its checks/);
  assert.match(r.error, /Unknown template/);
});

test('mintSpec: bound is never an agent status', () => {
  assert.match(mint({ spec: { ...spec(), status: 'bound' } }).error, /status must be "minted"/);
});

test('mintSpec: the file is named by the screen, which must be a plain name', () => {
  assert.match(mint({ screen: 'other' }).error, /spec.screen is/);
  assert.match(Ui.mintSpec({ screen: '../x', spec: { ...spec(), screen: '../x', status: 'minted' }, pack, groups }).error, /lower case/);
  assert.match(mint({ spec: '{' }).error, /does not parse/);
});

test('mintSpec: a bound spec is replaced only by naming it in supersedes', () => {
  const existing = JSON.stringify({ ...spec(), status: 'bound' });
  assert.match(mint({ existing }).error, /supersedes/);
  assert.equal(mint({ existing, supersedes: 'bordereaux' }).supersedes, true);
  assert.match(mint({ supersedes: 'bordereaux' }).error, /names no bound spec/);
  assert.equal(mint({ existing: JSON.stringify({ status: 'minted' }) }).error, undefined);
});

test('mintCatalogue: minted components and templates, named after the file; bound is refused', () => {
  const comp = { ...[...pack.components.values()][0].m, status: 'minted', name: 'NewThing' };
  const ok = Ui.mintCatalogue({ kind: 'component', doc: comp });
  assert.equal(ok.path, 'ui/components/NewThing.json');
  assert.match(Ui.mintCatalogue({ kind: 'component', doc: { ...comp, status: 'bound' } }).error, /minted/);
  assert.match(Ui.mintCatalogue({ kind: 'component', doc: { ...comp, name: '../x' } }).error, /name/);
  assert.match(Ui.mintCatalogue({ kind: 'component', doc: { name: 'X', status: 'minted' } }).error, /fails its schema/);
  const tpl = { ...[...pack.templates.values()][0].t, status: 'minted', name: 'new-layout' };
  assert.equal(Ui.mintCatalogue({ kind: 'template', doc: tpl }).path, 'ui/templates/new-layout.json');
  assert.match(Ui.mintCatalogue({ kind: 'widget', doc: tpl }).error, /kind must be/);
  assert.match(Ui.mintCatalogue({ kind: 'component', doc: comp, existing: JSON.stringify({ status: 'bound' }) }).error, /bound/);
});
