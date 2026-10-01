const { test } = require('node:test');
const assert = require('node:assert/strict');
const { match } = require('../extract/glob');

test('glob matcher handles double star, star and question mark', () => {
  const T = [
    ['a/b/c.ts', 'a/b/c.ts', true],
    ['a/b/c.ts', 'a/b/d.ts', false],
    ['a/b/c.ts', 'a/**', true],
    ['a/b/c.ts', 'b/**', false],
    ['a/b/c.ts', '**/c.ts', true],
    ['c.ts', '**/c.ts', true],
    ['a/b/c.ts', '**/b/*.ts', true],
    ['a/b/x/c.ts', 'a/*/c.ts', false],
    ['a/b/x/c.ts', 'a/**/c.ts', true],
    ['a/c.ts', 'a/**/c.ts', true],
    ['a/b/c.ts', 'a/b/?.ts', true],
    ['a/b/cc.ts', 'a/b/?.ts', false],
    ['a/b/c.ts', 'a/b/*', true],
    ['a/bxc.ts', 'a/b.c.ts', false],
    ['a/b.c', 'a/b.c', true],
    ['a/[x].ts', 'a/[x].ts', true],
    ['a/x.ts', 'a/[x].ts', false],
    ['A/b.ts', 'a/b.ts', false],
    ['api/src/Endpoints/X.cs', 'api/src/Endpoints/**', true],
    ['api/src/EndpointsX/X.cs', 'api/src/Endpoints/**', false],
  ];
  for (const [p, g, want] of T) assert.equal(match(g, p), want, `${g} vs ${p}`);
});

const path = require('path');
const { extract } = require('../extract.js');
const FULLSTACK = path.join(__dirname, '..', 'fixtures', 'fullstack');
const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const compOf = (r, file, container) => r.facts.components.find(c => c.container === container && c.files.includes(file));

test('overrides win over conventions and are scoped per container', async () => {
  const r = await extract(FULLSTACK, { components: [{ name: 'Ordering', paths: ['api/src/Shop.Api/Endpoints/**', 'ui/src/api/orders.ts'] }] });
  const api = compOf(r, 'api/src/Shop.Api/Endpoints/OrderEndpoints.cs', 'Shop.Api');
  const ui = compOf(r, 'ui/src/api/orders.ts', 'ui');
  assert.equal(api.name, 'Ordering'); assert.equal(api.basis, 'override');
  assert.equal(ui.name, 'Ordering');
  assert.notEqual(api.id, ui.id);
  assert.equal(compOf(r, 'api/src/Shop.Api/Controllers/CustomersController.cs', 'Shop.Api').name, 'CustomersController');
  assert.equal(compOf(r, 'ui/src/api/client.ts', 'ui').name, 'api');
  const owner = new Map(r.facts.components.map(c => [c.id, c.container]));
  const container = id => owner.get(id) || r.facts.elements.find(e => 'e_' + e.key === id).name;
  const folded = new Set(r.facts.componentEdges.map(e => `${container(e.from)}|${container(e.to)}|${e.kind}`).filter(k => { const [a, b] = k.split('|'); return a !== b; }));
  assert.deepEqual(folded, new Set(r.facts.edges.map(e => `${e.from}|${e.to}|${e.kind}`)));
});

test('the first matching override wins', async () => {
  const r = await extract(FULLSTACK, { components: [
    { name: 'First', paths: ['api/src/Shop.Api/Endpoints/*.cs'] },
    { name: 'Second', paths: ['api/src/Shop.Api/**'] }] });
  assert.equal(compOf(r, 'api/src/Shop.Api/Endpoints/OrderEndpoints.cs', 'Shop.Api').name, 'First');
  assert.equal(compOf(r, 'api/src/Shop.Api/Program.cs', 'Shop.Api').name, 'Second');
});

test('bad or empty overrides go to unresolved and never throw', async () => {
  const base = await extract(FULLSTACK);
  const bad = await extract(FULLSTACK, { components: [{ paths: ['x/**'] }, { name: 'N' }, { name: 'M', paths: [] }, null, { name: 'Z', paths: ['nothing/here/**'] }] });
  const mine = bad.facts.unresolved.filter(u => u.where === 'designc.json');
  assert.equal(mine.length, 5);
  assert.ok(mine.some(u => /Z/.test(u.what) && /nothing\/here\/\*\*/.test(u.what) && /matches no source file/.test(u.what)));
  assert.deepEqual(bad.facts.components, base.facts.components);
  for (const opts of [{}, { components: 'x' }, { components: {} }, { components: null }]) {
    const r = await extract(FULLSTACK, opts);
    assert.deepEqual(r.facts.components, base.facts.components);
    assert.equal(r.facts.unresolved.length, base.facts.unresolved.length);
  }
});

test('an output-binding file follows its function class when the class is overridden', async () => {
  const { withRepo, JOBS_REPO } = require('./helpers/with-repo');
  await withRepo(JOBS_REPO, async dir => {
    const r = await extract(dir, { components: [{ name: 'Reporting', paths: ['**/ReportJobFunction.cs'] }] });
    const rep = r.facts.components.find(c => c.name === 'Reporting');
    assert.ok(rep.files.some(f => /ReportJobFunction\.cs$/.test(f)));
    assert.ok(rep.files.some(f => /ReportJobOutput\.cs$/.test(f)), rep.files.join());
  });
});
