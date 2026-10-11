const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Core = require('../renderer/core.js');
const D = require('../renderer/canvas/dsl-edit.js');
const SRC = fs.readFileSync(path.join(__dirname, 'pricing.dsl'), 'utf8');
const ok = text => { const m = Core.parse(text); assert.deepEqual(m.errors, [], 'DSL must still parse:\n' + text); return m; };
const byName = (m, n) => [...m.elements.values()].find(e => e.name === n);

test('locate lines up with Core.parse', () => {
  const loc = D.locate(SRC), m = Core.parse(SRC);
  assert.equal(loc.elements.length, m.elements.size);
  assert.deepEqual(loc.elements.map(e => e.id), [...m.elements.keys()]);
  assert.equal(loc.relationships.length, m.rels.length);
  assert.ok(loc.model && loc.model.open && loc.model.close);
});

test('add a container inside a system', () => {
  const r = D.addElement(SRC, { kind: 'container', name: 'Quote Agent', technology: 'MAF', tags: ['Agent'], parent: 'pricing', props: { 'd.agent.autonomy': 'approve-writes' } });
  const m = ok(r.text); const el = byName(m, 'Quote Agent');
  assert.equal(el.parent, 'pricing'); assert.equal(el.technology, 'MAF'); assert.ok(el.tags.has('Agent'));
  assert.equal(el.props['d.agent.autonomy'], 'approve-writes'); assert.equal(r.ident, 'quoteAgent');
});

test('people and systems go before the first relationship', () => {
  const r = D.addElement(SRC, { kind: 'person', name: 'Broker' });
  const m = ok(r.text); const broker = byName(m, 'Broker');
  assert.ok(broker.line < Math.min(...m.rels.map(x => x.line)));
});

test('adding a container to a system without a body creates the body', () => {
  const r = D.addElement(SRC, { kind: 'container', name: 'Vendor API', parent: 'catVendor' });
  const m = ok(r.text); assert.equal(byName(m, 'Vendor API').parent, 'catVendor');
  const src2 = 'workspace { model {\n  s = softwareSystem "S"\n} }';
  const m2 = ok(D.addElement(src2, { kind: 'container', name: 'C', parent: 's' }).text);
  assert.equal(byName(m2, 'C').parent, 's');
});

test('relationships get identifiers added when missing', () => {
  const src = 'workspace {\n  model {\n    softwareSystem "Legacy Core"\n    a = softwareSystem "A"\n  }\n}\n';
  const r = D.addRelationship(src, { src: 'a', dst: 'Legacy Core', description: 'Reads', props: { 'd.interaction': 'sync' } });
  const m = ok(r.text); assert.equal(r.dst, 'legacyCore');
  const rel = m.rels.find(x => x.src === 'a'); assert.equal(rel.dst, 'legacyCore'); assert.equal(rel.props['d.interaction'], 'sync');
});

test('set, update and remove properties on elements', () => {
  let t = D.setProperty(SRC, { kind: 'element', ref: 'quotes' }, 'd.owner', 'Pricing team').text;   // no body yet
  assert.equal(byName(ok(t), 'Quotes DB').props['d.owner'], 'Pricing team');
  t = D.setProperty(t, { kind: 'element', ref: 'quotes' }, 'd.owner', 'Platform').text;
  assert.equal(byName(ok(t), 'Quotes DB').props['d.owner'], 'Platform');
  t = D.setProperty(t, { kind: 'element', ref: 'quotes' }, 'd.owner', '').text;
  const q = byName(ok(t), 'Quotes DB'); assert.equal(q.props['d.owner'], undefined);
  assert.ok(!/quotes = container[^\n]*\{\s*properties \{\s*\}/.test(t), 'empty properties block removed');
  t = D.setProperty(SRC, { kind: 'element', ref: 'api' }, 'd.instances', '4').text;
  assert.equal(byName(ok(t), 'Pricing API').props['d.instances'], '4');
});

test('set properties on relationships, found by line', () => {
  const m = Core.parse(SRC); const rel = m.rels.find(r => r.src === 'referrals' && r.dst === 'quotes');
  let t = D.setProperty(SRC, { kind: 'relationship', ref: { line: rel.line, src: 'referrals', dst: 'quotes' } }, 'd.concurrency', 'optimistic').text;
  const m2 = ok(t); assert.equal(m2.rels.find(r => r.src === 'referrals' && r.dst === 'quotes').props['d.concurrency'], 'optimistic');
  const r0 = m.rels.find(r => r.src === 'portal');
  t = D.setProperty(SRC, { kind: 'relationship', ref: { line: r0.line } }, 'd.encrypted', 'yes').text;
  assert.equal(ok(t).rels.find(r => r.src === 'portal').props['d.encrypted'], 'yes');
});

test('header fields', () => {
  let t = D.setField(SRC, { kind: 'element', ref: 'quotes' }, 'name', 'Quote Store').text;
  assert.ok(byName(ok(t), 'Quote Store'));
  t = D.setField(SRC, { kind: 'element', ref: 'underwriter' }, 'description', 'Prices risks').text;
  assert.equal(byName(ok(t), 'Underwriter').description, 'Prices risks');
  t = D.setField(SRC, { kind: 'element', ref: 'rating' }, 'technology', 'F# 9').text;
  assert.equal(byName(ok(t), 'Rating Engine').technology, 'F# 9');
  const rel = Core.parse(SRC).rels.find(r => r.src === 'api' && r.dst === 'rating');
  t = D.setField(SRC, { kind: 'relationship', ref: { line: rel.line } }, 'description', 'Rates the layer').text;
  assert.equal(ok(t).rels.find(r => r.src === 'api' && r.dst === 'rating').description, 'Rates the layer');
});

test('delete an element removes its relationships; delete a system removes its children', () => {
  let t = D.deleteElement(SRC, 'referrals').text; let m = ok(t);
  assert.equal(byName(m, 'Referral Worker'), undefined);
  assert.ok(!m.rels.some(r => r.src === 'referrals' || r.dst === 'referrals'));
  assert.equal(m.rels.length, Core.parse(SRC).rels.length - 2);
  t = D.deleteElement(SRC, 'pricing').text; m = ok(t);
  assert.deepEqual([...m.elements.values()].map(e => e.name).sort(), ['Cat Model Vendor', 'Underwriter']);
  assert.equal(m.rels.length, 0);
});

test('delete a relationship', () => {
  const rel = Core.parse(SRC).rels.find(r => r.src === 'catAdapter');
  const m = ok(D.deleteRelationship(SRC, { line: rel.line }).text);
  assert.ok(!m.rels.some(r => r.src === 'catAdapter'));
});

test('tags', () => {
  const t = D.addTag(SRC, 'rating', 'Agent').text;
  const el = byName(ok(t), 'Rating Engine'); assert.ok(el.tags.has('Agent')); assert.equal(el.technology, 'F#');
  assert.ok(byName(ok(D.addTag(SRC, 'underwriter', 'VIP').text), 'Underwriter').tags.has('VIP'));
});

test('comments and formatting survive edits', () => {
  const src = '// header comment\nworkspace "X" {\n  model {\n    # people\n    u = person "U"   // trailing\n    s = softwareSystem "S"\n    u -> s "Uses"\n  }\n}\n';
  const t = D.setProperty(src, { kind: 'element', ref: 's' }, 'd.owner', 'Team A').text;
  assert.ok(t.includes('// header comment') && t.includes('# people') && t.includes('// trailing'));
  const t2 = D.addElement(t, { kind: 'person', name: 'Admin' }).text; ok(t2);
  assert.ok(t2.indexOf('admin = person') < t2.indexOf('u -> s'));
});

test('snippets get a unique prefix', () => {
  const snip = { elements: '{p}_agent = softwareSystem "Agent {p}"', relationships: '{p}_agent -> pricing "Uses"' };
  let r = D.insertSnippet(SRC, snip, 'rag'); ok(r.text); assert.equal(r.prefix, 'rag');
  r = D.insertSnippet(r.text, snip, 'rag'); const m = ok(r.text); assert.equal(r.prefix, 'rag2');
  assert.ok(byName(m, 'Agent rag2'));
});

test('identFor avoids keywords and collisions', () => {
  assert.equal(D.identFor('Quotes DB', new Set()), 'quotesDB');
  assert.equal(D.identFor('Quotes DB', new Set(['quotesDB'])), 'quotesDB2');
  assert.equal(D.identFor('model', new Set()), 'model2');
  assert.equal(D.identFor('3rd party', new Set()), 'e3rdParty');
});

test('a property added to a one-line properties block goes inside it', () => {
  const src = 'workspace "W" {\n  model {\n    a = softwareSystem "A"\n    b = softwareSystem "B"\n    a -> b "Calls" {\n      properties { "d.interaction" "sync" }\n    }\n  }\n}\n';
  const rel = Core.parse(src).rels[0];
  let t = D.setProperty(src, { kind: 'relationship', ref: { line: rel.line, src: 'a', dst: 'b' } }, 'd.tool.effect', 'read').text;
  let m = ok(t);
  assert.equal(m.rels[0].props['d.tool.effect'], 'read'); assert.equal(m.rels[0].props['d.interaction'], 'sync');
  t = D.setProperty(t, { kind: 'relationship', ref: { line: rel.line, src: 'a', dst: 'b' } }, 'd.tool.effect', 'write').text;
  m = ok(t); assert.equal(m.rels[0].props['d.tool.effect'], 'write');
  assert.equal((t.match(/d\.tool\.effect/g) || []).length, 1);
});

test('readBack says whether a property landed inside the block', () => {
  const landed = 'workspace "W" {\n  model {\n    a = softwareSystem "A"\n    b = softwareSystem "B"\n    a -> b "Calls" {\n      properties { "d.interaction" "sync" "d.tool.effect" "read" }\n    }\n  }\n}\n';
  const stray = 'workspace "W" {\n  model {\n    a = softwareSystem "A"\n    b = softwareSystem "B"\n    a -> b "Calls" {\n      "d.tool.effect" "read"\n      properties { "d.interaction" "sync" }\n    }\n  }\n}\n';
  const tgt = { kind: 'relationship', ref: { line: 5, src: 'a', dst: 'b' } };
  assert.equal(D.readBack(landed, tgt, 'd.tool.effect', 'read'), true);
  assert.equal(D.readBack(stray, tgt, 'd.tool.effect', 'read'), false);
  assert.equal(D.readBack(landed, tgt, 'd.interaction', ''), false);
  assert.equal(D.readBack(stray, tgt, 'd.approval', ''), true);
});
