// D8 slice 1: Ui.legacySkeleton from the UI graph and from a parity baseline (pure).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Ui = require('../renderer/ui.js');
const UiGraph = require('../renderer/uigraph.js');

const ROOT = path.join(__dirname, '..');
const graph = () => UiGraph.screen(JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'ui-graph.example.json'), 'utf8')), 'tags');
const baseline = id => JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'parity-registry', 'parity', 'baselines', id, 'legacy.json'), 'utf8'));

test('skeleton from the tags graph: role and name with file:line; unnamed or role-less controls are notes', () => {
  const sk = Ui.legacySkeleton({ graph: graph() });
  assert.equal(sk.screen, 'tags');
  assert.deepEqual(sk.states, ['initial']);
  const find = (role, name) => sk.placements.find(p => p.role === role && p.name === name);
  assert.deepEqual(find('searchbox', 'Search tags'), { role: 'searchbox', name: 'Search tags', from: 'src/pages/Tags/TagsPage.tsx:19' });
  assert.deepEqual(find('link', 'New tag'), { role: 'link', name: 'New tag', from: 'src/pages/Tags/TagsPage.tsx:31' });
  assert.ok(find('button', 'Refresh'), 'a followed control with a name is a placement');
  assert.equal(sk.placements.some(p => !p.role || !p.name), false);
  // the role-less date input, the library Button and the button whose name is an expression are notes, never guesses
  assert.ok(sk.notes.some(n => n.startsWith('src/pages/Tags/TagsPage.tsx:36:') && /no role/.test(n)));
  assert.ok(sk.notes.some(n => n.startsWith('src/pages/Tags/TagsPage.tsx:42:')));
  assert.ok(sk.notes.some(n => n.startsWith('src/pages/Tags/TagForm.tsx:25:') && /no literal name/.test(n)));
  // 'textbox Tag name' is on the screen twice (TagForm and the followed Field): one locator, first place kept
  assert.equal(sk.placements.filter(p => p.role === 'textbox' && p.name === 'Tag name').length, 1);
  assert.equal(sk.placements.length + sk.notes.length, graph().controls.length - 1);
});

test('skeleton from the tags-list baseline: elements with an acceptance role, from scenario step n; one initial state', () => {
  const sk = Ui.legacySkeleton({ baseline: baseline('tags-list') });
  assert.equal(sk.screen, 'tags-list');
  assert.deepEqual(sk.states, ['initial']);
  assert.deepEqual(sk.placements.map(p => `${p.role}:${p.name}`), ['heading:Adhoc tags', 'textbox:Program', 'table:Programs', 'button:Bulk apply', 'button:Export']);
  assert.ok(sk.placements.every(p => p.from === 'scenario step 1'));
});

test('baseline step states become the skeleton states, in order, once each; repeats of a locator keep the first step', () => {
  const el = (role, name) => ({ role, name, children: [] });
  const sk = Ui.legacySkeleton({ baseline: { scenario: 's', steps: [
    { n: 1, state: 'list', elements: [el('button', 'Go'), { role: 'columnheader', name: 'X', children: [] }] },
    { n: 2, state: 'dialog', elements: [el('button', 'Go'), { role: 'dialog', name: 'Apply', children: [el('textbox', '')] }] },
    { n: 3, state: 'list', elements: [] }] } });
  assert.deepEqual(sk.states, ['list', 'dialog']);
  assert.deepEqual(sk.placements, [{ role: 'button', name: 'Go', from: 'scenario step 1' }, { role: 'dialog', name: 'Apply', from: 'scenario step 2' }]);
});

test('nothing given is a note, not a crash', () => {
  assert.deepEqual(Ui.legacySkeleton({}).placements, []);
  assert.ok(Ui.legacySkeleton().notes.length);
});

// ---- slice 2: ui/legacy/ drafts ----
const { ROOT: FROOT, load } = require('./helpers/ui.js');
const L = load();
const groups = Ui.tokenGroups(L.tokens), pack = Ui.readPack(L.pack, groups);
const bspec = () => ({ ...JSON.parse(fs.readFileSync(path.join(FROOT, 'ui/specs/bordereaux.json'), 'utf8')), status: 'minted' });

test('mintSpec legacy: writes ui/legacy/<screen>.json with the same checks, never asks for supersedes', () => {
  const r = Ui.mintSpec({ screen: 'bordereaux', spec: bspec(), pack, groups, legacy: true });
  assert.equal(r.error, undefined);
  assert.equal(r.path, 'ui/legacy/bordereaux.json');
  assert.equal(r.supersedes, false);
  const bad = Ui.mintSpec({ screen: 'bordereaux', spec: { ...bspec(), template: 'nope' }, pack, groups, legacy: true });
  assert.match(bad.error, /fails its checks/);
  assert.match(Ui.mintSpec({ screen: 'bordereaux', spec: { ...bspec(), status: 'bound' }, pack, groups, legacy: true }).error, /minted/);
});

test('mintSpec legacy: a legacy file is never bound; an existing one is simply replaced; supersedes is refused', () => {
  const old = JSON.stringify(bspec());
  assert.equal(Ui.mintSpec({ screen: 'bordereaux', spec: bspec(), pack, groups, legacy: true, existing: old }).error, undefined);
  assert.match(Ui.mintSpec({ screen: 'bordereaux', spec: bspec(), pack, groups, legacy: true, supersedes: 'bordereaux' }).error, /legacy/);
});

test('legacyDraft: from graph or parity picks the right source and says what is missing', () => {
  const g = graph();
  const sc = [{ id: 'tags-list', screen: 'tags' }, { id: 'tags-apply', screen: 'tags' }];
  const baselines = { 'tags-list': baseline('tags-list'), 'tags-apply': false };
  assert.equal(Ui.legacyDraft({ screen: 'tags', from: 'graph', graph: g }).skeleton.placements.length > 5, true);
  assert.match(Ui.legacyDraft({ screen: 'tags', from: 'graph', graph: null }).error, /no UI graph/);
  const p = Ui.legacyDraft({ screen: 'tags', from: 'parity', scenarios: sc, baselines });
  assert.equal(p.skeleton.screen, 'tags', 'the skeleton names the screen asked for, not the scenario');
  assert.equal(p.skeleton.placements[0].from, 'scenario step 1');
  assert.match(Ui.legacyDraft({ screen: 'tags', from: 'parity', scenarios: [{ id: 'x', screen: 'other' }], baselines }).error, /no parity scenario/);
  assert.match(Ui.legacyDraft({ screen: 'tags', from: 'parity', scenarios: [{ id: 'tags-apply', screen: 'tags' }], baselines }).error, /no recorded baseline/);
  assert.match(Ui.legacyDraft({ screen: 'tags', from: 'x' }).error, /graph or parity/);
});

// ---- slice 3: specDiff, and the Done-when round trip ----
const legacyText = fs.readFileSync(path.join(FROOT, 'ui/legacy/tags.json'), 'utf8');
const legacySpec = () => JSON.parse(legacyText);
const clone = o => JSON.parse(JSON.stringify(o));

test('Done when (D8): tags graph -> skeleton -> the scripted legacy spec passes the checks, and every locator came from the skeleton', () => {
  const sk = Ui.legacySkeleton({ graph: graph() });
  const r = Ui.checkSpec('ui/legacy/tags.json', legacyText, { pack: Ui.readPack(L.pack, groups), groups });
  assert.deepEqual(r.problems, []);
  assert.equal(r.spec.status, 'minted', 'a legacy spec is never bound');
  const known = new Set(sk.placements.map(p => `${p.role}:${p.name}`));
  const locs = Object.values(r.spec.slots).flat().filter(p => p.locator).map(p => `${p.locator.role}:${p.locator.name}`);
  assert.ok(locs.length >= 3);
  for (const l of locs) assert.ok(known.has(l), `${l} is in the skeleton`);
  assert.equal(Ui.mintSpec({ screen: 'tags', spec: r.spec, pack: Ui.readPack(L.pack, groups), groups, legacy: true }).error, undefined);
});

test('Done when (D8): specDiff of an unedited copy is empty; of a copy with 3 edits it lists exactly those 3', () => {
  const none = Ui.specDiff(legacySpec(), legacySpec());
  assert.deepEqual(none, { template: null, placements: { added: [], removed: [], changed: [] }, states: { added: [], removed: [] }, data: { added: [], removed: [], changed: [] } });
  const next = clone(legacySpec());
  next.slots['header.actions'] = next.slots['header.actions'].filter(p => p.id !== 'clear');          // removed
  next.slots['header.actions'].push({ id: 'refresh', component: 'Button', props: { label: 'Refresh', variant: 'ghost', onClick: 'refresh' }, locator: { role: 'button', name: 'Refresh' } }); // added
  next.slots.main[0].props.density = 'compact';                                                         // changed token prop
  const d = Ui.specDiff(legacySpec(), next);
  assert.equal(d.template, null);
  assert.deepEqual(d.placements.added.map(p => p.key), ['button:Refresh']);
  assert.deepEqual(d.placements.removed.map(p => p.key), ['button:Clear']);
  assert.deepEqual(d.placements.changed.map(p => [p.key, p.fields]), [['main/table', ['props.density']]]);
  assert.deepEqual([d.states, d.data], [{ added: [], removed: [] }, { added: [], removed: [], changed: [] }]);
});

test('specDiff: identity is the locator, else slot/id; slot, component, bind, template, states and data are reported, sorted', () => {
  const a = clone(legacySpec()), b = clone(legacySpec());
  b.slots.filters[0].id = 'renamed-handle';                                   // same locator: not a change
  b.slots.aside[0].bind.record = 'tags';                                      // no locator: slot/id identity, bind changed
  b.slots.main[0].component = 'DetailPanel';                                  // component changed
  b.template = 'other'; b.states.filtered = { description: 'x' }; delete b.states.empty;
  b.data.extra = { shape: 'money', source: 'GET /x' }; delete b.data.selected; b.data.tags.shape = 'record';
  const d = Ui.specDiff(a, b);
  assert.deepEqual(d.template, { from: 'list-detail', to: 'other' });
  assert.deepEqual(d.placements.changed.map(p => [p.key, p.fields]), [['aside/detail', ['bind.record']], ['main/table', ['component']]]);
  assert.deepEqual(d.placements.added, []); assert.deepEqual(d.placements.removed, []);
  assert.deepEqual(d.states, { added: ['filtered'], removed: ['empty'] });
  assert.deepEqual(d.data, { added: ['extra'], removed: ['selected'], changed: [{ key: 'tags', fields: ['shape'] }] });
  const m = clone(legacySpec()); m.slots.main[0].props.density = 'compact'; m.slots.aside[0].props.title = 'T';
  assert.deepEqual(Ui.specDiff(a, m).placements.changed.map(p => [p.key, p.fields]), [['aside/detail', ['props.title']], ['main/table', ['props.density']]]);
});
