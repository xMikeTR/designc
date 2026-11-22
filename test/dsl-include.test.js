// C6 slice 1: `!include` at token level, loc.file, includePath, modelFiles.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Core = require('../renderer/core.js');

const rd = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const snap = require('./data/c6-parse-snapshot.json');
const mk = files => p => (p in files ? files[p] : null);
const flat = m => ({
  elements: [...m.elements.values()].map(e => [e.id, e.ident, e.name, e.kind, e.parent]),
  rels: m.rels.map(r => [r.id, r.src, r.dst, r.description]),
});

test('includePath joins from the including folder and normalises', () => {
  assert.deepEqual(Core.includePath('model/workspace.dsl', 'fares/a.dsl'), { path: 'model/fares/a.dsl' });
  assert.deepEqual(Core.includePath('model/fares/a.dsl', './b.dsl'), { path: 'model/fares/b.dsl' });
  assert.deepEqual(Core.includePath('workspace.dsl', 'a//b.dsl'), { path: 'a/b.dsl' });
  assert.deepEqual(Core.includePath(null, 'a.dsl'), { path: 'a.dsl' });
});

test('includePath refuses escapes, absolutes, URLs and non-.dsl', () => {
  for (const raw of ['../x.dsl', 'a/../x.dsl', '/etc/x.dsl', 'C:/x.dsl', 'a\\b.dsl', 'https://h/x.dsl', 'http://h/x.dsl', 'parts', 'a.json']) {
    assert.ok(Core.includePath('model/w.dsl', raw).error, raw);
  }
  assert.match(Core.includePath('w.dsl', 'https://h/x.dsl').error, /does not fetch included URLs/);
  assert.match(Core.includePath('w.dsl', 'dir').error, /include a \.dsl file/);
});

test('modelFiles lists .dsl files under the model folder', () => {
  const ps = ['model/workspace.dsl', 'model/fares/a.dsl', 'model/notes.md', 'other/x.dsl', 'handovers/h/model/workspace.dsl', 'model/node_modules/x.dsl'];
  assert.deepEqual(Core.modelFiles(ps, 'model/workspace.dsl'), ['model/fares/a.dsl', 'model/workspace.dsl']);
  assert.deepEqual(Core.modelFiles(ps, 'workspace.dsl'), ['model/fares/a.dsl', 'model/workspace.dsl', 'other/x.dsl']);
});

const B = 'b = softwareSystem "B"\n\n!include sub/c.dsl\n';
const C = 'c = container "C"\n';

test('a two-file model parses like its flat twin and locations carry file and line', () => {
  const files = { 'm/b.dsl': 'b = softwareSystem "B"\n\n  b2 = softwareSystem "B2"\n', 'm/c.dsl': C };
  const root = 'workspace "W" {\n model {\n  a = person "A"\n  !include b.dsl\n  a -> b "uses"\n }\n}\n';
  const m = Core.parse(root, { path: 'm/w.dsl', resolve: mk(files) });
  const flatM = Core.parse(root.replace('  !include b.dsl\n', '  b = softwareSystem "B"\n\n  b2 = softwareSystem "B2"\n'));
  assert.deepEqual(m.errors, []);
  assert.deepEqual(flat(m), flat(flatM));
  const b2 = m.elements.get('b2');
  assert.deepEqual([b2.file, b2.line], ['m/b.dsl', 3]);
  assert.deepEqual(m.locEl(b2).file, 'm/b.dsl');
  assert.deepEqual([m.locRel(m.rels[0]).file, m.locRel(m.rels[0]).line], ['m/w.dsl', 5]);
  assert.deepEqual(m.sources.map(s => s.path), ['m/w.dsl', 'm/b.dsl']);
});

test('auto ids and rel ids match the flat file; nesting and dedup of sources', () => {
  const files = { 'b.dsl': B, 'sub/c.dsl': C, 'd.dsl': 'x -> y\n' };
  const root = 'model {\n  person "P"\n  !include b.dsl\n  person "Q"\n}\n';
  const m = Core.parse(root, { path: 'w.dsl', resolve: mk(files) });
  const flatM = Core.parse('model {\n  person "P"\n  b = softwareSystem "B"\n\n  c = container "C"\n\n  person "Q"\n}\n');
  assert.deepEqual(flat(m), flat(flatM));
  assert.deepEqual(m.sources.map(s => s.path), ['w.dsl', 'b.dsl', 'sub/c.dsl']);
  assert.equal(m.elements.get('c').file, 'sub/c.dsl');
  assert.equal(m.elements.get('_e2').file, 'w.dsl');
});

test('a quoted path, and tokens keep inclusion anywhere (inside an element block)', () => {
  const m = Core.parse('model {\n  s = softwareSystem "S" {\n    !include "in side.dsl"\n  }\n}\n', { path: 'w.dsl', resolve: mk({ 'in side.dsl': 'k = container "K"\n' }) });
  assert.deepEqual(m.errors, []);
  assert.equal(m.elements.get('k').parent, 's');
});

test('include errors carry the including file and line', () => {
  const res = (root, files, rootPath = 'a.dsl') => Core.parse(root, { path: rootPath, resolve: mk(files) }).errors;
  assert.deepEqual(Core.parse('\n!include x.dsl\n').errors, [{ line: 2, file: null, msg: '!include is not available here: the model was read without its folder' }]);
  assert.deepEqual(res('model {\n!include nope.dsl\n}', {}), [{ line: 2, file: 'a.dsl', msg: 'cannot read included file "nope.dsl" (nope.dsl)' }]);
  assert.deepEqual(res('!include b.dsl\n', { 'b.dsl': '\n\n!include a.dsl\n' }), [{ line: 3, file: 'b.dsl', msg: 'include cycle: a.dsl → b.dsl → a.dsl' }]);
  assert.deepEqual(res('!include a.dsl\n', {}), [{ line: 1, file: 'a.dsl', msg: 'include cycle: a.dsl → a.dsl' }]);
  assert.deepEqual(res('!include\nmodel {}', {}), [{ line: 1, file: 'a.dsl', msg: '!include needs a path' }]);
  assert.deepEqual(res('!include ../x.dsl\n', {})[0].file, 'a.dsl');
});

test('depth: 8 nested files are fine, 9 is an error', () => {
  const chain = n => { const f = {}; for (let i = 1; i <= n; i++) f[`f${i}.dsl`] = i < n ? `!include f${i + 1}.dsl\n` : '';  return f; };
  assert.deepEqual(Core.parse('!include f1.dsl\n', { path: 'a.dsl', resolve: mk(chain(8)) }).errors, []);
  const e = Core.parse('!include f1.dsl\n', { path: 'a.dsl', resolve: mk(chain(9)) }).errors;
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].file, e[0].msg], ['f8.dsl', 'includes nest deeper than 8 files']);
});

test('a parse error inside an included file reports that file and line', () => {
  const m = Core.parse('model {\n!include b.dsl\n}\n', { path: 'w.dsl', resolve: mk({ 'b.dsl': '\n\nbogus "x"\na -> zz\n' }) });
  assert.ok(m.errors.some(e => e.file === 'b.dsl' && e.line === 3 && /unknown keyword "bogus"/.test(e.msg)), JSON.stringify(m.errors));
  assert.ok(m.errors.some(e => e.file === 'b.dsl' && e.line === 4 && /unknown element "a"/.test(e.msg)));
});

test('the same file included twice gives the duplicate-identifier error', () => {
  const m = Core.parse('!include b.dsl\n!include b.dsl\n', { path: 'w.dsl', resolve: mk({ 'b.dsl': 'x = person "X"\n' }) });
  assert.deepEqual(m.errors.map(e => [e.file, e.line, e.msg]), [['b.dsl', 1, 'identifier "x" is already used']]);
  assert.equal(m.sources.length, 2);
});

test('models without !include parse as at 44a7fe2, plus file: null', () => {
  for (const [k, f] of [['sample', 'sample-registry/model/workspace.dsl'], ['split', 'fixtures/split-registry/model/workspace.dsl']]) {
    const m = Core.parse(rd(f));
    const want = snap[k];
    assert.deepEqual([...m.elements.values()].map(e => [e.id, e.ident, e.name, e.kind, e.parent, e.line]), want.elements);
    assert.deepEqual(m.rels.map(r => [r.id, r.src, r.dst, r.line]), want.rels);
    assert.deepEqual(m.errors, want.errors.map(e => ({ ...e, file: null })));
    assert.ok([...m.elements.values()].every(e => e.file === null) && m.rels.every(r => r.file === null));
    assert.deepEqual(m.sources, [{ path: null, text: rd(f) }]);
  }
});

test('the include-model fixture flattens to the sample-registry model', () => {
  const dir = 'fixtures/include-model/';
  const m = Core.parse(rd(dir + 'workspace.dsl'), { path: 'model/workspace.dsl', resolve: p => { try { return rd(dir + p.replace(/^model\//, '')); } catch { return null; } } });
  const single = Core.parse(rd('sample-registry/model/workspace.dsl'));
  assert.deepEqual(m.errors, single.errors);
  assert.deepEqual(flat(m), flat(single));
  assert.deepEqual(m.sources.map(s => s.path), ['model/workspace.dsl', 'model/fares.dsl', 'model/fares/workers.dsl', 'model/relationships.dsl']);
});

test('locFile groups a model row under its file, falling back to the root', () => {
  assert.equal(Core.locFile({ file: 'model/a.dsl' }, 'model/workspace.dsl'), 'model/a.dsl');
  assert.equal(Core.locFile({ file: null }, 'model/workspace.dsl'), 'model/workspace.dsl');
  assert.equal(Core.locFile({}, 'model/workspace.dsl'), 'model/workspace.dsl');
});

test('the handover helpers take a text or a source object', () => {
  const root = 'model {\n  !include a.dsl\n}\n', a = 'x = softwareSystem "X" {\n properties {\n  "d.agent.autonomy" "supervised"\n }\n}\n';
  const flatDoc = Core.handoverAgents(root.replace('  !include a.dsl\n', a));
  const doc = Core.handoverAgents({ text: root, path: 'w.dsl', resolve: p => (p === 'a.dsl' ? a : null) });
  assert.deepEqual(doc, flatDoc);
  assert.throws(() => Core.handoverAgents({ text: root, path: 'w.dsl', resolve: () => 'bogus "x"\n' }), /does not parse \(a\.dsl line 1: /);
});
