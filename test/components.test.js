const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { extract } = require('../extract.js');
const dsl = require('../extract/dsl.js');

const ROOT = path.join(__dirname, '..');
const FULLSTACK = path.join(ROOT, 'fixtures', 'fullstack');
const SAMPLE = path.join(ROOT, 'sample-codebase');
const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

test('every source file of every deployable lands in exactly one component', async () => {
  for (const dir of [FULLSTACK, SAMPLE]) {
    const r = await extract(dir);
    const seen = new Map();
    for (const c of r.facts.components) {
      assert.ok(r.facts.elements.some(e => e.name === c.owner), `component ${c.name} has a known owner`);
      for (const ev of c.evidence) {
        assert.ok(!seen.has(`${c.owner}|${ev.file}`), `${ev.file} assigned twice in ${c.owner}`);
        assert.ok(fs.existsSync(path.join(dir, ev.file)), `${ev.file} exists`);
        seen.set(`${c.owner}|${ev.file}`, c.key);
      }
    }
    assert.ok(seen.size > 0);
    assert.deepEqual(r.facts.unresolved.filter(u => /no component rule/.test(u.what)), []);
  }
  const r = await extract(FULLSTACK);
  const names = r.facts.components.map(c => `${keyOf(c.owner)}:${c.name}`);
  for (const want of ['ui:api', 'ui:auth', 'nodeapi:routes', 'shopapi:CustomersController', 'ui:App shell', 'shopapi:Shop.Infrastructure', 'shopfunctions:Shop.Infrastructure']) assert.ok(names.includes(want), `missing ${want}`);
});

test('component ids follow the c_ scheme in the nested DSL', async () => {
  const r = await extract(FULLSTACK);
  assert.match(r.dsl, /^ +c_shopapi_customerscontroller = component "CustomersController"/m);
  assert.ok(!/ e_\w+_\w+ = component/.test(r.dsl));
});

test('a container without components renders exactly as in slice 1', async () => {
  const r = await extract(SAMPLE);
  const els = new Map(r.facts.elements.map(e => [e.key, e]));
  const edges = r.facts.edges.map(e => ({ ...e, from: keyOf(e.from), to: keyOf(e.to) }));
  const three = dsl.render('x', els, edges);
  assert.equal(dsl.render('x', els, edges, new Map(), []), three);
  assert.ok(!three.includes(' = component '));
  const partial = new Map([[`${keyOf('Pricing.Api')}|a`, { key: 'a', name: 'A', owner: keyOf('Pricing.Api') }]]);
  const nested = dsl.render('x', els, edges, partial, []);
  assert.equal(nested.match(/ = component /g).length, 1);
  assert.ok(nested.includes('e_rating' + 'engine = container "Rating.Engine" "" "ASP.NET Core (F#)"\n'));
});

const rollupSet = (r, edges) => {
  const owner = new Map(r.facts.components.map(c => [`c_${keyOf(c.owner)}_${c.key}`, c.owner]));
  const container = id => owner.get(id) || r.facts.elements.find(e => 'e_' + e.key === id).name;
  return new Set(edges.map(e => `${container(e.from)}|${container(e.to)}|${e.kind}`));
};

test('component edges roll up to exactly the container edges on the fullstack fixture', async () => {
  const r = await extract(FULLSTACK);
  const compIds = new Set(r.facts.components.map(c => `c_${keyOf(c.owner)}_${c.key}`));
  for (const e of r.facts.componentEdges) {
    for (const end of [e.from, e.to]) assert.ok(compIds.has(end) || r.facts.elements.some(x => 'e_' + x.key === end), `unknown end ${end}`);
    assert.ok(e.evidence.length > 0 && e.via);
  }
  const folded = [...rollupSet(r, r.facts.componentEdges)].filter(k => { const [a, b] = k.split('|'); return a !== b; });
  const want = new Set(r.facts.edges.map(e => `${e.from}|${e.to}|${e.kind}`));
  assert.deepEqual(new Set(folded), want);

  const http = r.facts.componentEdges.filter(e => e.from === 'c_ui_api' && e.kind === 'sync');
  assert.ok(http.length > 0);
  for (const e of http) {
    assert.match(e.to, /^c_shopapi_(orderendpoints|customerscontroller)$/);
    assert.match(e.label, /^Calls \d+ endpoint\(s\)$/);
  }
  const customers = http.find(e => e.to === 'c_shopapi_customerscontroller');
  assert.equal(customers.label, 'Calls 1 endpoint(s)');
  const snow = r.facts.componentEdges.find(e => e.to === 'e_snowflake');
  assert.equal(snow.from, 'c_shopapi_shopinfrastructure');
  assert.equal(new Set(r.facts.componentEdges.map(e => `${e.from}|${e.to}|${e.kind}`)).size, r.facts.componentEdges.length, 'deduplicated by (from, to, kind)');
});

test('an edge whose provider end has no evidence targets the container itself', async () => {
  const r = await extract(SAMPLE);
  const viaClient = r.facts.edges.filter(e => /^Calls via /.test(e.label));
  assert.ok(viaClient.length > 0, 'sample has AddHttpClient edges');
  for (const e of viaClient) {
    const to = r.facts.elements.find(x => x.name === e.to);
    const ce = r.facts.componentEdges.filter(c => c.label === e.label && c.to === 'e_' + to.key);
    assert.ok(ce.length > 0, `component edge for ${e.label} targets e_${to.key}`);
  }
  const folded = new Set(r.facts.componentEdges.map(e => {
    const own = new Map(r.facts.components.map(c => [`c_${keyOf(c.owner)}_${c.key}`, c.owner]));
    const f = id => own.get(id) || r.facts.elements.find(x => 'e_' + x.key === id).name;
    return `${f(e.from)}|${f(e.to)}|${e.kind}`;
  }));
  for (const e of r.facts.edges) assert.ok(folded.has(`${e.from}|${e.to}|${e.kind}`), `${e.from} -> ${e.to} survives rollup`);
  const Core = require('../renderer/core.js');
  assert.equal(Core.parse(r.dsl).errors.length, 0, 'nested DSL parses with zero errors');
});

test('facts.edges keep their slice 1 shape', async () => {
  for (const dir of [FULLSTACK, SAMPLE]) {
    const r = await extract(dir);
    for (const e of r.facts.edges) assert.deepEqual(Object.keys(e).sort(), ['evidence', 'from', 'kind', 'label', 'tech', 'to']);
  }
});
