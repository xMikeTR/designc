// S2: the change layer. renderer/landing.js is pure: node index, validation, layer data per level, edits, save rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');
const Landing = require('../renderer/landing.js');
const { extract } = require('../extract.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'fullstack');
let cached = null;
async function world() {
  if (cached) return cached;
  const r = await extract(FIX);
  const model = Core.parse(r.dsl);
  cached = { facts: r.facts, model, idx: Landing.buildIndex(model, r.facts) };
  return cached;
}
const snap = m => JSON.stringify([[...m.elements].map(([k, e]) => [k, { ...e, tags: [...e.tags] }]), m.rels]);

test('resolve: each node form on the fares/shop fixture', async () => {
  const { idx } = await world();
  const c = Landing.resolve(idx, 'Shop.Api');
  assert.equal(c.status, 'mapped'); assert.equal(c.kind, 'container'); assert.equal(c.container, 'e_shopapi');
  const s = Landing.resolve(idx, 'Snowflake');
  assert.equal(s.status, 'mapped'); assert.equal(s.kind, 'container', 'a store is a container');
  const k = Landing.resolve(idx, 'Shop.Api/CustomersController');
  assert.equal(k.status, 'mapped'); assert.equal(k.kind, 'component'); assert.equal(k.component, 'c_shopapi_customerscontroller'); assert.equal(k.container, 'e_shopapi');
  const t = Landing.resolve(idx, 'Shop.Api/OrderRequest');
  assert.equal(t.status, 'mapped'); assert.equal(t.kind, 'type'); assert.equal(t.type, 't_c_shopapi_orderendpoints_orderrequest'); assert.equal(t.component, 'c_shopapi_orderendpoints');
});

test('resolve: a route with slashes is one endpoint; the container is the part before the first slash', async () => {
  const { idx } = await world();
  const e = Landing.resolve(idx, 'Shop.Api/POST /api/v1/orders');
  assert.equal(e.status, 'mapped'); assert.equal(e.kind, 'endpoint'); assert.equal(e.container, 'e_shopapi'); assert.equal(e.component, 'c_shopapi_orderendpoints'); assert.equal(e.endpoint, 'p_shopapi_post_api_v1_orders');
  const n = Landing.resolve(idx, 'node-api/POST /api/v2/invoices');
  assert.equal(n.kind, 'endpoint'); assert.equal(n.container, 'e_nodeapi');
  // the route's parameter spelling does not matter, the stored form is {}
  assert.equal(Landing.resolve(idx, 'Shop.Api/GET /api/v1/customers/{id}').endpoint, 'p_shopapi_get_api_v1_customers');
  assert.equal(Landing.resolve(idx, 'Shop.Api/GET /api/v1/customers/:id').endpoint, 'p_shopapi_get_api_v1_customers');
});

test('resolve: #handler is the inline span, or the named type', async () => {
  const { idx } = await world();
  const inline = Landing.resolve(idx, 'Shop.Api/POST /api/v1/orders#handler');
  assert.equal(inline.status, 'mapped'); assert.equal(inline.kind, 'handler'); assert.equal(inline.endpoint, 'p_shopapi_post_api_v1_orders'); assert.equal(inline.component, 'c_shopapi_orderendpoints');
  const named = Landing.resolve(idx, 'Shop.Api/GET /api/v1/customers/{}#handler');
  assert.equal(named.status, 'mapped'); assert.equal(named.component, 'c_shopapi_customerscontroller');
  assert.equal(Landing.resolve(idx, 'Shop.Api/POST /nope#handler').status, 'new');
});

test('resolve: ANY matches by route; two matches are ambiguous, never a guess', () => {
  const model = Core.parse('workspace "w" { model { sys = softwareSystem "w" { api = container "Api" "" "x" { c = component "Orders" } } } }');
  const facts = { code: { types: [] }, endpoints: [
    { id: 'p1', node: 'Api/GET /x', container: 'Api', component: 'c', method: 'GET', route: '/x', handler: null },
    { id: 'p2', node: 'Api/POST /x', container: 'Api', component: 'c', method: 'POST', route: '/x', handler: null },
    { id: 'p3', node: 'Api/GET /y', container: 'Api', component: 'c', method: 'GET', route: '/y', handler: null }] };
  const idx = Landing.buildIndex(model, facts);
  const amb = Landing.resolve(idx, 'Api/ANY /x');
  assert.equal(amb.status, 'ambiguous'); assert.deepEqual(amb.candidates.sort(), ['Api/GET /x', 'Api/POST /x']);
  assert.equal(Landing.resolve(idx, 'Api/ANY /y').endpoint, 'p3');
  assert.equal(Landing.resolve(idx, 'Api/GET /x').endpoint, 'p1');
});

test('resolve: a component wins over a type of the same name in that component; elsewhere it is ambiguous', () => {
  const model = Core.parse('workspace "w" { model { sys = softwareSystem "w" { api = container "Api" "" "x" { a = component "Orders" b = component "Billing" c = component "Invoices" } } } }');
  const facts = { code: { types: [
    { id: 't1', name: 'Orders', kind: 'class', component: 'a', container: 'Api' },
    { id: 't2', name: 'Ledger', kind: 'class', component: 'b', container: 'Api' },
    { id: 't3', name: 'Ledger', kind: 'class', component: 'c', container: 'Api' },
    { id: 't4', name: 'Invoices', kind: 'class', component: 'b', container: 'Api' }] }, endpoints: [] };
  const idx = Landing.buildIndex(model, facts);
  const r = Landing.resolve(idx, 'Api/Orders');
  assert.equal(r.status, 'mapped'); assert.equal(r.kind, 'component'); assert.equal(r.component, 'a');
  const two = Landing.resolve(idx, 'Api/Ledger');
  assert.equal(two.status, 'ambiguous'); assert.equal(two.candidates.length, 2);
  const clash = Landing.resolve(idx, 'Api/Invoices');
  assert.equal(clash.status, 'ambiguous', 'a component and a type of the same name in different components');
});

test('resolve: not on the map is new, including a new container', async () => {
  const { idx } = await world();
  assert.equal(Landing.resolve(idx, 'Shop.Api/CedantFilter').status, 'new');
  const nc = Landing.resolve(idx, 'Cedants');
  assert.equal(nc.status, 'new'); assert.equal(nc.newContainer, true);
  const nn = Landing.resolve(idx, 'Cedants/Importer');
  assert.equal(nn.status, 'new'); assert.equal(nn.newContainer, true);
  assert.equal(Landing.resolve(idx, 'Shop.Api/CedantFilter').newContainer, false);
  assert.equal(Landing.resolve(idx, '').status, 'new');
});

const GOOD = () => ({
  requirement: 'RE-1', author: 'agent', status: 'proposed', entry: { kind: 'screen', node: 'ui' },
  path: [{ stage: 'ui', node: 'ui' }], changes: [{ node: 'Shop.Api/CustomersController', what: 'accept the cedant filter' }],
  principle: { none: 'plumbing' }, proposed: {}, correction: {}, approved: {},
});

test('validate: a good record passes; each bad field is named', () => {
  assert.deepEqual(Landing.validate(GOOD(), { file: 'landings/RE-1.yaml' }), []);
  const bad = (mut, re) => { const r = GOOD(); mut(r); const e = Landing.validate(r, { file: 'landings/RE-1.yaml' }); assert.ok(e.some(x => re.test(x)), `${re}: ${e.join(' | ')}`); };
  bad(r => { r.author = 'robot'; }, /author/);
  bad(r => { r.status = 'done'; }, /status/);
  bad(r => { r.entry.kind = 'page'; }, /entry/);
  bad(r => { r.entry.node = ' '; }, /entry/);
  bad(r => { r.path[0].stage = 'cache'; }, /stage/);
  bad(r => { r.path[0].node = ''; }, /path/);
  bad(r => { r.changes[0].what = ''; }, /what/);
  bad(r => { r.changes[0].node = ''; }, /changes/);
  bad(r => { r.path = 'x'; }, /path/);
  bad(r => { r.requirement = 'RE-2'; }, /file name|requirement/);
  bad(r => { delete r.requirement; }, /requirement/);
  assert.ok(Landing.validate(GOOD(), { file: 'landings/RE-9.yaml' }).some(x => /RE-9/.test(x)), 'file name must equal the requirement');
  for (const req of ['../x', 'a/b', 'a\\b', '.hidden', '', 'a b']) {
    const r = GOOD(); r.requirement = req;
    assert.ok(Landing.validate(r, { file: `landings/${req}.yaml` }).length, `unsafe name ${JSON.stringify(req)}`);
  }
});

test('validate: absent optional fields are fine, unknown keys are kept, a bad file never throws', () => {
  const min = { requirement: 'RE-1', author: 'human', status: 'proposed' };
  assert.deepEqual(Landing.validate(min, { file: 'landings/RE-1.yaml' }), []);
  const p = Landing.parseFile('landings/RE-1.yaml', 'requirement: RE-1\nauthor: agent\nstatus: proposed\nnotes: keep me\n', yaml.load);
  assert.equal(p.errors.length, 0); assert.equal(p.record.notes, 'keep me');
  assert.deepEqual(p.record.path, []); assert.deepEqual(p.record.changes, []); assert.equal(p.record.entry, null);
  for (const text of ['', ':\n  - [', '- a\n- b\n', '42', 'requirement: [\n']) {
    let r; assert.doesNotThrow(() => { r = Landing.parseFile('landings/RE-1.yaml', text, yaml.load); }, JSON.stringify(text));
    assert.ok(r.errors.length, `reported: ${JSON.stringify(text)}`);
    assert.equal(r.path, 'landings/RE-1.yaml');
  }
  assert.doesNotThrow(() => Landing.validate(null, { file: 'x' }));
  assert.doesNotThrow(() => Landing.validate({ path: [null, 3], changes: [[]], entry: 'x' }, { file: 'x' }));
});

test('layer: highlights and notes per level, nodes without a box show on the parent', async () => {
  const { idx, model } = await world();
  const r = {
    ...GOOD(), requirement: 'RE-1', entry: { kind: 'screen', node: 'ui' },
    path: [{ stage: 'ui', node: 'ui' }, { stage: 'api', node: 'Shop.Api/POST /api/v1/orders' }, { stage: 'handler', node: 'Shop.Api/POST /api/v1/orders#handler' }, { stage: 'store', node: 'Snowflake' }],
    changes: [{ node: 'Shop.Api/OrderRequest', what: 'accept the cedant filter' }, { node: 'Cedants/Importer', what: 'new import job' }],
  };
  const cont = Core.view(model, { level: 'container' });
  const L1 = Landing.layerFor(idx, r, 'container', cont);
  assert.ok(L1.boxes.has('e_ui') && L1.boxes.has('e_shopapi') && L1.boxes.has('e_snowflake'));
  const api = L1.boxes.get('e_shopapi').map(n => n.role).sort();
  assert.deepEqual(api, ['change', 'path', 'path'], 'endpoint, handler and the type all show on their container');
  assert.ok(L1.boxes.get('e_ui').some(n => n.role === 'entry'));
  const newBox = L1.own.find(o => o.kind === 'container');
  assert.ok(newBox && newBox.name === 'Cedants' && newBox.notOnMap, 'a new container gets its own box at Containers level');
  assert.equal(L1.own.length, 1, 'no endpoint boxes at Containers level');

  const comp = Core.view(model, { level: 'component' });
  const L2 = Landing.layerFor(idx, r, 'component', comp);
  assert.ok(L2.boxes.has('c_shopapi_orderendpoints'), 'the type shows on its component');
  const kinds = L2.own.map(o => o.kind).sort();
  assert.deepEqual(kinds, ['container', 'endpoint', 'handler', 'new'], 'endpoint, inline handler and the new node each get a dashed box; the new container too');
  const ep = L2.own.find(o => o.kind === 'endpoint');
  assert.equal(ep.parent, 'e_shopapi'); assert.match(ep.name, /POST \/api\/v1\/orders/);
  assert.ok(L2.own.every(o => o.notOnMap === (o.kind === 'new' || o.kind === 'container')), 'only new nodes say not on the map');
  assert.equal(L2.own.find(o => o.kind === 'new').parent, L2.own.find(o => o.kind === 'container').id, 'a new node of a new container sits in it');

  const ctx = Core.view(model, { level: 'context' });
  const L0 = Landing.layerFor(idx, r, 'context', ctx);
  assert.ok(L0.boxes.has('sys'), 'at Context everything shows on the system');
  assert.equal(L0.own.length, 0);
});

test('layer: path edges join consecutive steps; steps in one box make no edge', async () => {
  const { idx, model } = await world();
  const r = { ...GOOD(), path: [{ stage: 'ui', node: 'ui' }, { stage: 'api', node: 'Shop.Api/POST /api/v1/orders' }, { stage: 'handler', node: 'Shop.Api/POST /api/v1/orders#handler' }, { stage: 'store', node: 'Snowflake' }] };
  const L1 = Landing.layerFor(idx, r, 'container', Core.view(model, { level: 'container' }));
  assert.deepEqual(L1.edges.map(e => [e.from, e.to]), [['e_ui', 'e_shopapi'], ['e_shopapi', 'e_snowflake']]);
  assert.deepEqual(L1.edges.map(e => e.n), [1, 3], 'numbered by the step they leave');
  const L2 = Landing.layerFor(idx, r, 'component', Core.view(model, { level: 'component' }));
  assert.equal(L2.edges.length, 3);
  assert.ok(L2.edges.every(e => e.from !== e.to));
  assert.notEqual(Landing.EDGE_STYLE.dash, '', 'layer edges are dashed and accent coloured so they are not mistaken for a dependency');
});

test('layer: never mutates the model, the facts or the record', async () => {
  const { idx, model, facts } = await world();
  const r = { ...GOOD(), changes: [{ node: 'Cedants/Importer', what: 'x' }, { node: 'Shop.Api/POST /api/v1/orders', what: 'y' }] };
  const before = [snap(model), JSON.stringify(facts), JSON.stringify(r)];
  for (const level of ['context', 'container', 'component']) {
    const view = Core.view(model, { level });
    const vb = snap(view);
    const L = Landing.layerFor(idx, r, level, view);
    const m2 = Landing.augment(view, L);
    assert.notEqual(m2, view); assert.equal(snap(view), vb, `${level}: the view is untouched`);
    assert.ok(m2.elements.size >= view.elements.size);
  }
  assert.deepEqual([snap(model), JSON.stringify(facts), JSON.stringify(r)], before);
});

test('augment: own boxes are elements of a copy, under their container', async () => {
  const { idx, model } = await world();
  const r = { ...GOOD(), changes: [{ node: 'Shop.Api/POST /api/v1/orders', what: 'y' }, { node: 'Cedants', what: 'z' }] };
  const view = Core.view(model, { level: 'component' });
  const m2 = Landing.augment(view, Landing.layerFor(idx, r, 'component', view));
  const ep = [...m2.elements.values()].find(e => /POST \/api\/v1\/orders/.test(e.name));
  assert.ok(ep); assert.equal(ep.parent, 'e_shopapi'); assert.ok(ep.tags instanceof Set); assert.equal(ep.kindLabel, 'Endpoint');
  const nc = [...m2.elements.values()].find(e => e.name === 'Cedants');
  assert.ok(nc); assert.equal(nc.parent, 'sys'); assert.equal(m2.isAncestor('sys', nc.id), true);
});

test('edits: pure, each empties approved, stage and entry defaults', async () => {
  const { idx } = await world();
  const base = { requirement: 'RE-1', author: 'human', status: 'proposed', approved: { by: 'x', hash: 'h' }, extra: 1 };
  const frozen = JSON.stringify(base);
  const a = Landing.addStep(idx, base, 'ui');
  assert.equal(JSON.stringify(base), frozen, 'the input is not changed');
  assert.deepEqual(a.approved, {}); assert.equal(a.extra, 1);
  assert.deepEqual(a.path, [{ stage: 'ui', node: 'ui' }]);
  assert.deepEqual(a.entry, { kind: 'screen', node: 'ui' }, 'the first step becomes the entry when there is none');
  const b = Landing.addStep(idx, a, 'Shop.Api/POST /api/v1/orders');
  assert.deepEqual(b.path[1], { stage: 'api', node: 'Shop.Api/POST /api/v1/orders' });
  assert.deepEqual(b.entry, a.entry, 'a later step does not move the entry');
  const c = Landing.addStep(idx, b, 'Snowflake', 'store');
  assert.equal(c.path[2].stage, 'store');
  const d = Landing.removeStep(c, 1); assert.equal(d.path.length, 2); assert.equal(d.path[1].node, 'Snowflake');
  const e = Landing.setEntry(idx, d, 'Shop.Api/POST /api/v1/orders'); assert.deepEqual(e.entry, { kind: 'endpoint', node: 'Shop.Api/POST /api/v1/orders' });
  assert.equal(Landing.setEntry(idx, d, 'Shop.Api/CustomersController', 'action').entry.kind, 'action');
  const f = Landing.addChange(e, 'Shop.Api/CustomersController', ' accept the cedant filter ');
  assert.deepEqual(f.changes, [{ node: 'Shop.Api/CustomersController', what: 'accept the cedant filter' }]);
  assert.equal((Landing.addChange(e, 'Shop.Api', '  ').changes || []).length, 0, 'an empty what is not added');
  assert.equal(Landing.removeChange(f, 0).changes.length, 0);
  assert.equal(Landing.removeStep(f, 9).path.length, f.path.length, 'out of range is a no-op');
  // defaults
  assert.equal(Landing.defaultStage(idx, 'Snowflake'), 'store');
  assert.equal(Landing.defaultStage(idx, 'ui'), 'ui');
  assert.equal(Landing.defaultStage(idx, 'Shop.Api/POST /api/v1/orders'), 'api');
  assert.equal(Landing.defaultStage(idx, 'Shop.Api/POST /api/v1/orders#handler'), 'handler');
  assert.equal(Landing.defaultStage(idx, 'Shop.Api/CustomersController'), 'handler');
  // a node that is not on the map can be used the same way; its stage follows the last step
  const g = Landing.addStep(idx, { ...base, path: [{ stage: 'api', node: 'Shop.Api' }] }, 'Cedants/Importer');
  assert.equal(g.path[1].stage, 'handler');
  assert.equal(Landing.addStep(idx, { ...base, path: [{ stage: 'store', node: 'Snowflake' }] }, 'Cedants/Importer').path[1].stage, 'store', 'capped at the last stage');
});

test('save: a registry path only, with a validated id', () => {
  assert.equal(Landing.fileFor('RE-1'), 'landings/RE-1.yaml');
  for (const bad of ['', '../x', 'a/b', 'a\\b', '.x', 'a b', null, undefined, 'x'.repeat(200)]) assert.equal(Landing.fileFor(bad), null, JSON.stringify(bad));
});

test('save: writes author human, proposed, empties approved, keeps unknown keys', () => {
  const loaded = yaml.dump({ requirement: 'RE-1', author: 'agent', status: 'approved', approved: { by: 'x', at: 't', hash: 'h' }, proposed: { a: 1 }, note: 'keep', entry: { kind: 'screen', node: 'ui' }, path: [], changes: [] });
  const rec = Landing.parseFile('landings/RE-1.yaml', loaded, yaml.load).record;
  const draft = Landing.addChange(rec, 'Shop.Api', 'accept the filter');
  const r = Landing.prepareSave({ draft, loadedText: loaded, currentText: loaded, yaml });
  assert.equal(r.ok, true); assert.equal(r.path, 'landings/RE-1.yaml');
  const out = yaml.load(r.text);
  assert.equal(out.author, 'human'); assert.equal(out.status, 'proposed'); assert.deepEqual(out.approved, {});
  assert.equal(out.note, 'keep'); assert.deepEqual(out.proposed, { a: 1 }); assert.equal(out.changes.length, 1);
  assert.ok(r.text.endsWith('\n'));
});

test('save: refuses when the file changed since it was loaded, or appeared, or is not valid', () => {
  const loaded = 'requirement: RE-1\nauthor: human\nstatus: proposed\n';
  const draft = { requirement: 'RE-1', author: 'human', status: 'proposed', path: [], changes: [{ node: 'Shop.Api', what: 'x' }] };
  const changed = Landing.prepareSave({ draft, loadedText: loaded, currentText: loaded + 'x: 1\n', yaml });
  assert.equal(changed.ok, false); assert.match(changed.error, /changed|reload/i);
  const gone = Landing.prepareSave({ draft, loadedText: loaded, currentText: null, yaml });
  assert.equal(gone.ok, false, 'it was there when loaded and is gone now');
  const appeared = Landing.prepareSave({ draft, loadedText: null, currentText: loaded, yaml });
  assert.equal(appeared.ok, false, 'a new file that appeared meanwhile is not overwritten');
  const fresh = Landing.prepareSave({ draft, loadedText: null, currentText: null, yaml });
  assert.equal(fresh.ok, true);
  const unsafe = Landing.prepareSave({ draft: { ...draft, requirement: '../evil' }, loadedText: null, currentText: null, yaml });
  assert.equal(unsafe.ok, false);
  const empty = Landing.prepareSave({ draft: { ...draft, changes: [{ node: 'A', what: '' }] }, loadedText: null, currentText: null, yaml });
  assert.equal(empty.ok, false, 'an invalid record is not written');
});

test('review: an agent landing is read-only, approved is never shown as verified', () => {
  assert.equal(Landing.editable({ author: 'agent', status: 'proposed' }), false);
  assert.equal(Landing.editable({ author: 'human', status: 'proposed' }), true);
  assert.equal(Landing.editable({ author: 'human', status: 'approved' }), true, 'editing it empties the approval');
  assert.match(Landing.statusText({ author: 'agent', status: 'approved', approved: { by: 'x' } }), /approval not verified/);
  assert.doesNotMatch(Landing.statusText({ author: 'agent', status: 'proposed' }), /verified/);
});

test('draft: newRecord starts a human proposal for the requirement', () => {
  const r = Landing.newRecord('RE-7');
  assert.deepEqual([r.requirement, r.author, r.status], ['RE-7', 'human', 'proposed']);
  assert.deepEqual(Landing.validate(r, { file: 'landings/RE-7.yaml' }), []);
});

test('index: the real fixture resolves every endpoint and handler it extracts', async () => {
  const { idx, facts } = await world();
  for (const e of facts.endpoints) {
    assert.equal(Landing.resolve(idx, e.node).endpoint, e.id, e.node);
    if (e.handler) assert.equal(Landing.resolve(idx, e.handler.node).status, 'mapped', e.handler.node);
  }
  assert.ok(Landing.endpointsOf(idx, { container: 'e_shopapi' }).length >= 3);
  assert.ok(Landing.endpointsOf(idx, { component: 'c_shopapi_orderendpoints' }).every(e => e.component === 'c_shopapi_orderendpoints'));
});
