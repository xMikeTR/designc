const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { extract } = require('../extract.js');
const dsl = require('../extract/dsl.js');
const Core = require('../renderer/core.js');

const FULLSTACK = path.join(__dirname, '..', 'fixtures', 'fullstack');
const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const strip = t => t.replace(/^\/\/.*\n/gm, '');
const shape = m => ({
  els: [...m.elements.values()].map(e => [e.id, e.kind, e.name, e.technology, e.parent]).sort(),
  rels: m.rels.map(r => [r.src, r.dst, r.description, r.technology, JSON.stringify(r.props)]).sort(),
});

test('atLevel container view of the nested as-built equals the flat container model', async () => {
  const r = await extract(FULLSTACK);
  assert.ok(r.facts.components.length > 0, 'fixture should yield components');
  const els = new Map(r.facts.elements.map(e => [e.key, e]));
  const flat = Core.parse(strip(dsl.render('fullstack', els, r.facts.edges.map(e => ({ ...e, from: keyOf(e.from), to: keyOf(e.to) })))));
  const nested = Core.parse(strip(r.dsl));
  assert.deepEqual(nested.errors, []);
  assert.ok([...nested.elements.values()].some(e => e.kind === 'component'));
  assert.deepEqual(shape(Core.atLevel(nested, 'container')), shape(flat));
  assert.deepEqual(shape(Core.atLevel(nested, 'component')), shape(nested));
});

test('atLevel folds children into ancestors and lifts relationships without duplicates', () => {
  const m = Core.parse(`workspace "w" {
  model {
    sys = softwareSystem "S" {
      a = container "A" "" "x" {
        a1 = component "A1" "" ""
        a2 = component "A2" "" ""
      }
      b = container "B" "" "x" {
        b1 = component "B1" "" ""
      }
    }
    a1 -> b1 "calls" "HTTP"
    a2 -> b1 "calls" "HTTP"
    a -> b "calls" "HTTP"
    a1 -> a2 "uses"
    a1 -> b "pings"
  }
}`);
  assert.deepEqual(m.errors, []);
  const c = Core.atLevel(m, 'container');
  assert.deepEqual([...c.elements.values()].map(e => e.name).sort(), ['A', 'B', 'S']);
  const byName = r => `${c.elements.get(r.src).name}->${c.elements.get(r.dst).name}:${r.description}`;
  assert.deepEqual(c.rels.map(byName).sort(), ['A->B:calls', 'A->B:pings']);
  const explicit = m.rels.find(r => m.elements.get(r.src).name === 'A' && r.description === 'calls');
  assert.equal(c.rels.find(r => r.description === 'calls').id, explicit.id);
  const s = Core.atLevel(m, 'context');
  assert.deepEqual([...s.elements.values()].map(e => e.name), ['S']);
  assert.equal(s.rels.length, 0);
});

test('containerLevelText leaves a container-only design', async () => {
  const containerOnly = `// header\nworkspace "w" {\n  model {\n    sys = softwareSystem "S" {\n      a = container "A" "" "x"\n      b = container "B" "" "y"\n    }\n    a -> b "calls" "HTTP" {\n      properties {\n        "d.interaction" "sync"\n      }\n    }\n  }\n}\n`;
  assert.equal(Core.containerLevelText(containerOnly), containerOnly);

  const r = await extract(FULLSTACK);
  const out = Core.containerLevelText(r.dsl);
  const parsed = Core.parse(out);
  assert.deepEqual(parsed.errors, []);
  assert.ok([...parsed.elements.values()].every(e => e.kind !== 'component'));
  assert.deepEqual(shape(parsed).rels, shape(Core.atLevel(Core.parse(r.dsl), 'container')).rels);

  const withRel = `workspace "w" {\n  model {\n    sys = softwareSystem "S" {\n      a = container "A" {\n        a1 = component "A1"\n      }\n      b = container "B"\n    }\n    a1 -> b "x" "y" {\n      properties {\n        "k" "v"\n      }\n    }\n    a -> b "keep"\n  }\n}\n`;
  const t = Core.containerLevelText(withRel);
  assert.ok(!t.includes('a1') && !t.includes('"k"'));
  assert.ok(t.includes('a -> b "keep"'));
  assert.deepEqual(Core.parse(t).errors, []);
});
