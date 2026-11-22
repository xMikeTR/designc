// S2 retry 1: the behaviour of renderer/landingview.js (classic script) run in a vm with stubs for the renderer's globals.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');
const Landing = require('../renderer/landing.js');
const { extract } = require('../extract.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'fullstack');
let cached = null;
async function world() { if (!cached) { const r = await extract(FIX); cached = { facts: r.facts, model: Core.parse(r.dsl) }; } return cached; }

const HUMAN = req => `requirement: ${req}\nauthor: human\nstatus: proposed\nentry: null\npath: []\nchanges: []\n`;
// files: Map path -> text. Returns the context with spies.
async function setup(files, w) {
  const { facts, model } = w || await world();
  const handlers = {}, toasts = [], writes = [];
  const host = {
    list: async () => [...files.keys()].filter(p => /\.ya?ml$/.test(p)).map(p => ({ path: p, text: files.get(p) })),
    exists: async p => files.has(p), read: async p => files.get(p),
    write: async (p, t) => { writes.push(p); files.set(p, t); },
  };
  const ctx = vm.createContext({
    Landing, jsyaml: yaml, host, textOf: () => undefined, esc: s => String(s), toast: (m, k) => toasts.push([m, k]), confirm: () => true,
    renderCodemap: () => {}, renderCmSide: () => {}, $: () => null,
    document: { addEventListener: (t, f) => { handlers[t] = f; }, querySelector: () => null, querySelectorAll: () => [] },
    A: { root: { r: 1 }, active: 'x', cmLevel: 'component', cmSel: null, asbuiltFull: model, asbuilt: model, facts, requirements: [] },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'landingview.js'), 'utf8'), ctx);
  await vm.runInContext('loadLandings()', ctx);
  return { ctx, A: ctx.A, L: ctx.A.layer, handlers, toasts, writes, files, run: s => vm.runInContext(s, ctx) };
}
const typeInto = (h, sel, value) => h.input({ target: { matches: s => s === sel, value } });

test('item 6: selecting a box or row clears the typed node and the stage chosen for the previous target', async () => {
  const s = await setup(new Map());
  s.run("lyOpen('R-1')"); s.A.cmSel = 'e_shopapi'; s.run('lyTarget()');
  typeInto(s.handlers, '[data-ly-node]', 'Shop.Api/Typed');
  assert.equal(s.run('lyTarget()').node, 'Shop.Api/Typed');
  s.handlers.change({ target: { matches: x => x === '[data-ly-stage]', value: 'store' } });
  s.A.cmSel = 'e_ui';
  assert.equal(s.run('lyTarget()').node, 'ui', 'the box the person clicked, not the typed node');
  assert.equal(s.L.typed, ''); assert.equal(s.L.stage, '');
  s.A.cmSel = 'e_shopapi';
  assert.equal(s.run('lyTarget()').node, 'Shop.Api', 'the old typed node does not come back');
  typeInto(s.handlers, '[data-ly-node]', 'Shop.Api/Again');
  s.handlers.click({ target: { closest: () => ({ dataset: { a: 'ly-pick', node: 'Shop.Api/GET /x' }, disabled: false }) } });
  assert.equal(s.run('lyTarget()').node, 'Shop.Api/GET /x', 'a row clears the typed node too');
});

test('item 2 in the panel: a box whose name is shared has no target, the buttons are disabled and it says why', async () => {
  const model = Core.parse('workspace "w" { model { sys = softwareSystem "w" { api = container "Api" "" "x" { a = component "Orders" b = component "Billing" } } } }');
  const facts = { code: { types: [{ id: 't2', key: 'Billing', name: 'Billing', kind: 'class', component: 'a', container: 'Api' }] }, endpoints: [] };
  const s = await setup(new Map(), { facts, model });
  s.run("lyOpen('R-1')");
  s.A.cmSel = 't2';
  assert.equal(s.run('lyTarget()').node, null);
  const html = s.run('lyPanel()');
  assert.match(html, /name is shared: select its component/);
  assert.match(html, /data-a="ly-step" disabled/);
});

test('item 7: a registry reload while the layer is clean keeps what the person is typing', async () => {
  const s = await setup(new Map());
  s.run("lyOpen('R-1')"); s.A.cmSel = 'e_shopapi'; s.run('lyTarget()');
  typeInto(s.handlers, '[data-ly-node]', 'Shop.Api/Typed');
  typeInto(s.handlers, '[data-ly-what]', 'half a sentence');
  await s.run('loadLandings()');
  assert.equal(s.L.typed, 'Shop.Api/Typed'); assert.equal(s.L.what, 'half a sentence');
  s.files.set('landings/R-1.yaml', HUMAN('R-1'));   // the registry changed: the layer is reopened from it, the typing stays
  await s.run('loadLandings()');
  assert.equal(s.L.typed, 'Shop.Api/Typed'); assert.equal(s.L.what, 'half a sentence');
  assert.equal(s.L.req, 'R-1'); assert.ok(s.L.loadedText, 'reopened from the file');
});

test('item 8: a failed write shows the error and the layer stays dirty', async () => {
  const s = await setup(new Map());
  s.run("lyOpen('R-1')"); s.run("lyEdit(r => Landing.addChange(r, 'Shop.Api', 'a'))");
  assert.equal(s.L.dirty, true);
  s.ctx.host.write = async () => { throw new Error('disk full'); };
  await s.run('lySave()');
  assert.equal(s.L.dirty, true);
  assert.ok(s.toasts.some(([m, k]) => /disk full/.test(m) && k === 'error'), JSON.stringify(s.toasts));
});

test('item 8: an edit made while the write is in flight is not marked saved', async () => {
  const s = await setup(new Map());
  s.run("lyOpen('R-1')"); s.run("lyEdit(r => Landing.addChange(r, 'Shop.Api', 'first'))");
  s.ctx.host.write = async (p, t) => { s.run("lyEdit(r => Landing.addChange(r, 'Shop.Api', 'second'))"); s.files.set(p, t); s.writes.push(p); };
  await s.run('lySave()');
  assert.equal(s.L.dirty, true, 'the second change is not on disk');
  assert.equal(s.L.draft.changes.length, 2);
  assert.equal(yaml.load(s.files.get('landings/R-1.yaml')).changes.length, 1);
  s.ctx.host.write = async (p, t) => { s.writes.push(p); s.files.set(p, t); };
  await s.run('lySave()');
  assert.equal(s.L.dirty, false); assert.equal(yaml.load(s.files.get('landings/R-1.yaml')).changes.length, 2, 'the next save succeeds against what was written');
});

test('item 8: a failed read of an existing file refuses the save', async () => {
  const s = await setup(new Map([['landings/R-1.yaml', HUMAN('R-1')]]));
  s.run("lyOpen('R-1')"); s.run("lyEdit(r => Landing.addChange(r, 'Shop.Api', 'a'))");
  s.ctx.host.read = async () => { throw new Error('EACCES'); };
  await s.run('lySave()');
  assert.equal(s.writes.length, 0, 'nothing written');
  assert.equal(s.L.dirty, true);
  assert.ok(s.toasts.some(([, k]) => k === 'error'));
});

test('item 5: a .yml landing saves to the .yml it came from', async () => {
  const s = await setup(new Map([['landings/R-2.yml', HUMAN('R-2')]]));
  s.run("lyOpen('R-2')"); assert.equal(s.L.draft.requirement, 'R-2');
  s.run("lyEdit(r => Landing.addChange(r, 'Shop.Api', 'a'))");
  await s.run('lySave()');
  assert.deepEqual(s.writes, ['landings/R-2.yml']); assert.equal(s.files.has('landings/R-2.yaml'), false);
});

test('item 5: both .yaml and .yml for one requirement are named in the panel and neither is editable', async () => {
  const s = await setup(new Map([['landings/R-3.yaml', HUMAN('R-3')], ['landings/R-3.yml', HUMAN('R-3')]]));
  assert.ok(s.A.landingErrors.some(b => /R-3\.yaml/.test(b.path) && /R-3\.yml/.test(b.path)), JSON.stringify(s.A.landingErrors));
  s.run("lyOpen('R-3')");
  assert.ok(s.L.bad); assert.equal(s.L.draft, null);
  const html = s.run('lyPanel()');
  assert.match(html, /R-3\.yaml/); assert.match(html, /R-3\.yml/); assert.doesNotMatch(html, /data-a="ly-save"/);
  await s.run('lySave()'); assert.equal(s.writes.length, 0);
});

test('item 4 in the panel: lines that are not drawn say so', async () => {
  const text = yaml.dump({ requirement: 'R-4', author: 'human', status: 'proposed', entry: { kind: 'action', node: 'Shop.Api/Nothing' }, path: [{ stage: 'api', node: 'Shop.Api' }], changes: [{ node: 'Shop.Api/Nothing', what: 'x' }] });
  const s = await setup(new Map([['landings/R-4.yaml', text]]));
  s.run("lyOpen('R-4')");
  s.run('lyPrepare')(Core.view((await world()).model, { level: 'component' }));
  const html = s.run('lyPanel()');
  assert.match(html, /data-ly-mark[^>]*>not on the map/);
});

// S2 retry 2, item 1: the landing's text is data, never a replacement pattern.
test('item 1: "$&", "$`", "$$" and "$\'" in a what come out as literal text with the markup intact', async () => {
  for (const what of ['cost $& tax', 'cost $` tax', 'price in $$', "cost $' tax"]) {
    const text = yaml.dump({ requirement: 'R-9', author: 'human', status: 'proposed', entry: null,
      path: [{ stage: 'ui', node: 'ui' }, { stage: 'api', node: 'Shop.Api' }], changes: [{ node: 'Shop.Api', what }] });
    const s = await setup(new Map([['landings/R-9.yaml', text]]));
    s.run("lyOpen('R-9')");
    s.run('lyPrepare')(Core.view((await world()).model, { level: 'component' }));
    const lay = s.run('lyCache').layer;
    const ids = [...lay.boxes.keys()];
    assert.ok(ids.length >= 2, 'the layer has boxes');
    const nodes = new Map(ids.map((id, i) => [id, { x: i * 100, y: 0, w: 80, h: 40 }]));
    const svg = '<svg>' + ids.map(id => `<g class="node" data-cm="${id}"><title>T</title><rect/></g>`).join('') + '</svg>';
    const out = s.run('lyDecorate')(svg, { nodes, groups: [] });
    assert.ok(out.includes(what), 'literal text kept: ' + what + '\n' + out);
    assert.equal((out.match(/<title>/g) || []).length, (out.match(/<\/title>/g) || []).length, 'titles balanced');
    assert.ok(out.endsWith('</svg>'));
    assert.equal((out.match(/<svg>/g) || []).length, 1);
  }
});

// S2 retry 2, item 2: only a name that is really shared says so.
test('item 2: a software system, an external system, a person or a vanished box cannot be a node, and it says that', async () => {
  const model = Core.parse('workspace "w" { model { u = person "Shopper" ext = softwareSystem "Pay" "" "External" sys = softwareSystem "w" { api = container "Api" "" "x" { a = component "Orders" } } } }');
  const facts = { code: { types: [] }, endpoints: [] };
  const s = await setup(new Map(), { facts, model });
  s.run("lyOpen('R-1')");
  const ids = [...model.elements.values()].filter(e => e.kind !== 'container' && e.kind !== 'component').map(e => e.id).concat(['gone_box']);
  assert.ok(ids.length >= 3);
  for (const id of ids) {
    s.A.cmSel = id;
    const html = s.run('lyPanel()');
    assert.match(html, /this box can't be a node: select a container, component or type/, id);
    assert.doesNotMatch(html, /name is shared/, id);
    assert.match(html, /data-a="ly-step" disabled/, id);
    let inner = null;
    s.ctx.document.querySelector = q => q === '[data-ly-target]' ? { set innerHTML(v) { inner = v; }, get innerHTML() { return inner; } } : null;
    s.run('lyTypedRefresh()');
    assert.match(inner, /this box can't be a node/, id); assert.doesNotMatch(inner, /name is shared/, id);
  }
});
