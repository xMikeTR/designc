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
