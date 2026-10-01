const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { extract } = require('../extract.js');
const Core = require('../renderer/core.js');

const FULLSTACK = path.join(__dirname, '..', 'fixtures', 'fullstack');
const names = m => [...m.elements.values()].map(e => e.name);
const byName = (m, n) => [...m.elements.values()].find(e => e.name === n);
const relPairs = m => m.rels.map(r => `${m.elements.get(r.src).name}>${m.elements.get(r.dst).name}`);
const fullstack = async () => Core.parse((await extract(FULLSTACK)).dsl);

test('view returns each level with rollup rels pruned when their parts are visible', async () => {
  const m = await fullstack();
  const sig = x => JSON.stringify([names(x), x.rels.map(r => [r.id, r.src, r.dst])]);
  assert.equal(sig(Core.view(m, { level: 'container' })), sig(Core.atLevel(m, 'container')));

  const ctx = Core.view(m, { level: 'context' });
  assert.deepEqual([...ctx.elements.values()].filter(e => e.kind === 'container' || e.kind === 'component'), []);
  assert.ok(names(ctx).includes('fullstack'));

  const full = Core.view(m, { level: 'component' });
  const comps = [...m.elements.values()].filter(e => e.kind === 'component');
  assert.ok(comps.length > 0);
  for (const c of comps) assert.ok(full.elements.has(c.id), `component ${c.name} present`);
  for (const r of full.rels) {
    const s = full.elements.get(r.src), d = full.elements.get(r.dst);
    const bothContainers = s.kind === 'container' && d.kind === 'container';
    const hasKids = e => [...full.elements.values()].some(x => x.parent === e.id);
    assert.ok(!(bothContainers && hasKids(s) && hasKids(d)), `rollup ${s.name} -> ${d.name} should be pruned`);
  }
  assert.ok(!relPairs(full).includes('ui>Shop.Api'));
});

test('a scoped component view shows one container\'s components and its neighbours folded', async () => {
  const m = await fullstack();
  const api = byName(m, 'Shop.Api');
  const v = Core.view(m, { level: 'component', scope: api.id });
  const n = names(v);
  for (const want of ['Shop.Api', 'CustomersController', 'OrderEndpoints', 'Shop.Infrastructure', 'ui', 'Snowflake']) assert.ok(n.includes(want), `${want} present`);
  assert.equal([...v.elements.values()].filter(e => e.parent === byName(m, 'ui').id).length, 0, 'ui is folded to one element');
  for (const gone of ['OrderFunctions', 'node-api']) assert.ok(!n.includes(gone), `${gone} absent`);
  assert.equal([...v.elements.values()].filter(e => e.kind === 'component').every(c => c.parent === api.id), true, 'only Shop.Api components');
  for (const r of v.rels) assert.ok(m.relById.has(r.id), 'rel ids come from the underlying model');
  assert.ok(relPairs(v).includes('ui>OrderEndpoints'));
  assert.ok(relPairs(v).includes('ui>CustomersController'));
});

const INLINE = `workspace "x" {
  model {
    sys = softwareSystem "S" {
      a = container "A" "" "t" {
        a1 = component "A1" "" ""
      }
      b = container "B" "" "t" {
        b1 = component "B1" "" ""
      }
    }
    a -> b "rollup" "HTTP"
    a1 -> b "calls" "HTTP"
  }
}`;

test('a component to container rel survives pruning', () => {
  const m = Core.parse(INLINE);
  const id = n => byName(m, n).id;
  for (const scope of [undefined, id('A'), id('B1'), 'nope']) {
    const v = Core.view(m, { level: 'component', scope });
    assert.ok(relPairs(v).includes('A1>B'), `component -> container kept (scope ${scope})`);
    assert.ok(!relPairs(v).includes('A>B'), `rollup dropped (scope ${scope})`);
  }
  assert.deepEqual(names(Core.view(m, { level: 'component', scope: id('B1') })), names(Core.view(m, { level: 'component' })), 'a non-container scope gives the unscoped view');
});
