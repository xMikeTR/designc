// L2 slice 2: Refactor.yamlRefs, symbolAt, definition, references.
const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const Refactor = require('../renderer/refactor.js');
const { sampleCopy, includeCopy, write, stateOf } = require('./helpers/l2-registry.js');

const scan = (path, text) => Refactor.yamlRefs(path, text, yaml.load(text));
const at = (text, line, needle) => { const l = text.split('\n')[line - 1]; return [line, l.indexOf(needle), needle.length]; };

test('yamlRefs reads flow, quoted-flow, block lists, a scalar artifact and one-line JSON promoted_against', () => {
  let t = 'id: d\nbinds: [Bookings DB, "Fares: API", \'It\'\'s\']\nresolves: [DC002]\n';
  let r = scan('decisions/d.yaml', t);
  assert.deepEqual(r.map(x => [x.key, x.index, x.value]), [['binds', 0, 'Bookings DB'], ['binds', 1, 'Fares: API'], ['binds', 2, "It's"]]);
  assert.deepEqual([r[0].line, r[0].c, r[0].n], at(t, 2, 'Bookings DB'));
  assert.deepEqual([r[1].line, r[1].c, r[1].n], at(t, 2, '"Fares: API"'));
  t = 'id: R\nelements:\n  - Bookings DB   # why\n  - "Escalation Worker"\nversion: 1\n';
  r = scan('requirements/R.yaml', t);
  assert.deepEqual(r.map(x => [x.key, x.index, x.value, x.line, x.c, x.n]), [['elements', 0, 'Bookings DB', 3, 4, 11], ['elements', 1, 'Escalation Worker', 4, 4, 19]]);
  t = 'id: s1\nartifact: Bookings DB\nattribute: availability\n';
  r = scan('scenarios/s1.yaml', t);
  assert.deepEqual(r.map(x => [x.key, x.value, x.line, x.c, x.n]), [['artifact', 'Bookings DB', 2, 10, 11]]);
  t = 'id: d\nstatus: bound\npromoted_against: [{"element":"bookings","name":"Bookings DB","hash":"abc"},{"requirement":"R","version":7},{"name":"Fares API","element":"api","hash":"d"}]\n';
  r = scan('decisions/d.yaml', t);
  assert.deepEqual(r.map(x => [x.key, x.index, x.value]), [['promoted_against.element', 0, 'bookings'], ['promoted_against.name', 0, 'Bookings DB'], ['promoted_against.name', 2, 'Fares API'], ['promoted_against.element', 2, 'api']]);
  assert.deepEqual([r[1].line, r[1].c, r[1].n], at(t, 3, '"Bookings DB"'));
});

test('a form that does not match js-yaml is refused with a reason; handovers are ignored', () => {
  for (const [p, t] of [
    ['decisions/a.yaml', 'binds:\n  - &x Bookings DB\n'],
    ['decisions/a.yaml', 'binds: [Bookings DB,\n  Fares API]\n'],
    ['decisions/a.yaml', 'binds: &b [Bookings DB]\n'],
    ['decisions/a.yaml', 'promoted_against:\n  - element: x\n    name: y\n    hash: z\n'],
  ]) {
    const r = scan(p, t);
    assert.match(r.error, new RegExp(`^${p}: (binds|promoted_against) is written in a form designc cannot edit safely; edit it by hand$`), t);
  }
  assert.deepEqual(scan('handovers/h1/decisions/a.yaml', 'binds: &b [Bookings DB]\n'), []);
  assert.deepEqual(scan('ledger/x.yaml', 'binds: [A]\n'), []);
  assert.deepEqual(scan('decisions/a.yaml', 'id: a\nbinds: []\n'), []);
});

test('sample-registry: references of Bookings DB are the same from the name, an identifier use and a binds entry', () => {
  const dir = sampleCopy(), st = stateOf(dir);
  const W = 'model/workspace.dsl';
  const el = st.model.elements.get('bookings');
  const want = [[W, 53, 6], [W, 53, 27], [W, 76, 11], [W, 103, 19], ['decisions/D-0001.yaml', 5, 8], ['requirements/DEMO-1234.yaml', 5, 11]];
  const key = refs => refs.map(r => [r.path, r.at.line, r.at.c]);
  assert.deepEqual(key(Refactor.references(st, el.id, { includeDeclaration: true })), want);
  assert.deepEqual(key(Refactor.references(st, el.id, { includeDeclaration: false })), want.slice(2));
  for (const [rel, line0, ch] of [[W, 52, 30], [W, 75, 13], ['decisions/D-0001.yaml', 4, 10], ['requirements/DEMO-1234.yaml', 4, 12]]) {
    const sym = Refactor.symbolAt(st, rel, line0, ch);
    assert.equal(sym.element.id, 'bookings', `${rel}:${line0}`);
    assert.deepEqual(key(Refactor.references(st, sym.element.id, { includeDeclaration: true })), want);
  }
  assert.equal(Refactor.symbolAt(st, W, 52, 6).kind, 'ident');
  assert.equal(Refactor.symbolAt(st, W, 52, 30).kind, 'name');
  assert.equal(Refactor.symbolAt(st, 'decisions/D-0001.yaml', 4, 10).kind, 'name');
  assert.equal(Refactor.symbolAt(st, W, 0, 0), null);
});

test('definition: a name in requirements/ lands on the identifier line; a name in a decision lands on the name when there is no identifier', () => {
  const dir = sampleCopy(), st = stateOf(dir);
  const sym = Refactor.symbolAt(st, 'requirements/DEMO-1234.yaml', 4, 25);
  assert.equal(sym.element.name, 'Escalation Worker');
  const d = Refactor.definition(st, sym);
  assert.deepEqual([d.path, d.at.line, d.at.c], ['model/workspace.dsl', 48, 6]);
});

test('a name two elements share resolves to nothing', () => {
  const dir = sampleCopy();
  write(dir, 'model/workspace.dsl', require('fs').readFileSync(dir + '/model/workspace.dsl', 'utf8').replace('"Escalation Worker"', '"Bookings DB"'));
  const st = stateOf(dir);
  assert.equal(Refactor.symbolAt(st, 'decisions/D-0001.yaml', 4, 10), null);
});

test('include registry: definition across files, and an include line', () => {
  const dir = includeCopy(), st = stateOf(dir);
  const rel = 'model/relationships.dsl';
  const line = st.files[rel].split('\n').findIndex(l => /-> bookings/.test(l));
  const col = st.files[rel].split('\n')[line].indexOf('bookings');
  const sym = Refactor.symbolAt(st, rel, line, col + 2);
  const d = Refactor.definition(st, sym);
  assert.deepEqual([d.path, d.at.c], ['model/fares/workers.dsl', 6]);
  const inc = Refactor.symbolAt(st, 'model/fares.dsl', 32, 10);
  assert.deepEqual(inc, { include: 'model/fares/workers.dsl', at: inc.at });
  const dd = Refactor.definition(st, inc);
  assert.deepEqual([dd.path, dd.at.line], ['model/fares/workers.dsl', 1]);
});
