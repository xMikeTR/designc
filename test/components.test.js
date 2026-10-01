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
        assert.ok(!seen.has(ev.file), `${ev.file} assigned twice`);
        assert.ok(fs.existsSync(path.join(dir, ev.file)), `${ev.file} exists`);
        seen.set(ev.file, c.key);
      }
    }
    assert.ok(seen.size > 0);
    assert.deepEqual(r.facts.unresolved.filter(u => /no component rule/.test(u.what)), []);
  }
  const r = await extract(FULLSTACK);
  const names = r.facts.components.map(c => `${keyOf(c.owner)}:${c.name}`);
  for (const want of ['ui:api', 'ui:auth', 'nodeapi:routes', 'shopapi:Controllers', 'ui:App shell']) assert.ok(names.includes(want), `missing ${want}`);
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
