const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ui = require('../renderer/ui.js');
const { load, BROKEN, hash } = require('./helpers/ui.js');

const texts = r => r.clauses.map(c => c.text);

test('ui: the bordereaux spec passes with its holdout, no notes, no coverage gap', () => {
  const r = Ui.clauses(load());
  assert.deepEqual(texts(r), []);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.coverage, []);
});
test('ui: nothing is checked with no pack, no spec and no holdout', () => {
  assert.deepEqual(Ui.clauses({ hash }), { clauses: [], notes: [], coverage: [] });
});
test('ui: broken.json fails with the same clauses as the kit validate.ts', () => {
  const inp = load();
  inp.specs.push({ path: 'ui/specs/broken.json', text: BROKEN });
  const r = Ui.clauses(inp);
  const expected = [
    "/data/count/source: schema: must match pattern",
    "/slots/main: Slot 'main' takes at most 1, got 2",
    "/slots/main/0/props/density: 'spacious' is not a density token",
    "/slots/main/0/props/colour: 'DataTable' has no prop 'colour'",
    "/slots/main/0/bind/rows: 'count' is number; 'DataTable.rows' expects table",
    "/slots/main/1/component: 'MetricCard' is a metric; slot 'main' accepts table | list",
    "/slots/main/1/props: 'MetricCard' requires prop 'label'",
    "/slots/main/1/bind/value: No data key 'missing'",
    "/slots/sidebar: Template 'list-detail' has no slot 'sidebar'",
    "/slots/header.actions/0/component: 'PageHeader' is a page-header; slot 'header.actions' accepts action",
    "/slots/header: Slot 'header' needs at least 1, got 0",
    "/states: Exactly one state is initial, found 2: ready, loading",
    "/transitions/0/to: No state 'saved'",
  ];
  const got = texts(r).filter(t => t.startsWith('ui/specs/broken.json'));
  assert.equal(got.length, 13);
  expected.forEach(e => assert.ok(got.some(t => t.startsWith('ui/specs/broken.json ' + e)), e));
  assert.equal(r.clauses.length, 13);
  assert.ok(r.clauses.every(c => c.kind === 'ui'));
  assert.equal(r.notes.length, 4, 'the kit warnings become notes: three missing ids and the missing states');
  assert.ok(r.coverage.some(t => /broken\.json: no holdout/.test(t)));
});
test('ui: a holdout equal to the visible sample fails', () => {
  const inp = load();
  const spec = JSON.parse(inp.specs[0].text);
  const key = Object.keys(spec.data)[0];
  inp.holdouts = [{ path: 'ui/holdout/bordereaux.json', text: JSON.stringify({ [key]: spec.data[key].sample }) }];
  assert.ok(texts(Ui.clauses(inp)).some(t => t.includes(`The holdout for '${key}' equals the visible sample`)));
});
test('ui: a holdout key the spec does not declare fails', () => {
  const inp = load();
  inp.holdouts = [{ path: 'ui/holdout/bordereaux.json', text: '{"nope": []}' }];
  assert.ok(texts(Ui.clauses(inp)).some(t => t.includes("No data key 'nope'")));
});
test('ui: a holdout with no spec fails; a spec with no holdout is coverage, not a clause', () => {
  const inp = load();
  inp.holdouts = [{ path: 'ui/holdout/ghost.json', text: '{"a": 1}' }];
  const r = Ui.clauses(inp);
  assert.ok(texts(r).some(t => /ghost\.json has no spec/.test(t)));
  assert.ok(r.coverage.some(t => /bordereaux\.json: no holdout/.test(t)));
  assert.ok(!texts(r).some(t => /no holdout/.test(t)));
});
test('ui: pack is not pinned, edited after pinning, and changed in its registry', () => {
  const inp = load();
  assert.ok(texts(Ui.clauses({ ...inp, ledger: [] })).some(t => /ui\/pack\/ is not pinned/.test(t)));
  const edited = { ...inp, pack: { ...inp.pack, components: inp.pack.components.map((f, i) => (i ? f : { ...f, text: f.text + ' ' })) } };
  assert.ok(texts(Ui.clauses(edited)).some(t => /edited after it was pinned/.test(t)));
  const src = { components: inp.pack.components.map(f => ({ ...f, path: f.path.replace('ui/pack/', 'ui/') })), templates: inp.pack.templates.map(f => ({ ...f, path: f.path.replace('ui/pack/', 'ui/') })) };
  assert.deepEqual(texts(Ui.clauses({ ...inp, sources: { 'acme-ui': src } })), []);
  src.components[0] = { ...src.components[0], text: src.components[0].text + '\n' + ' ' };
  assert.ok(texts(Ui.clauses({ ...inp, sources: { 'acme-ui': src } })).some(t => /acme-ui changed in its registry since it was pinned/.test(t)));
  const r = Ui.clauses({ ...inp, sources: { 'acme-ui': null } });
  assert.deepEqual(texts(r), []);
  assert.ok(r.notes.some(n => /registry could not be read/.test(n)));
});
test('ui: a spec with no pack pinned says so', () => {
  const inp = load();
  const r = Ui.clauses({ ...inp, pack: { components: [], templates: [] }, ledger: [], holdouts: [] });
  assert.ok(texts(r).some(t => /no UI pack is pinned/.test(t)));
});
test('ui: a token prop whose group is not in tokens.json fails; closed groups are space, color, density, tone', () => {
  assert.deepEqual(Ui.CLOSED_TOKEN_GROUPS, ['space', 'color', 'density', 'tone']);
  const inp = load();
  const r = Ui.clauses({ ...inp, tokens: '{"space":{"s":{"$value":"4px","$type":"dimension"}}}' });
  assert.ok(texts(r).some(t => /Unknown token group/.test(t)));
});
test('ui: tokenGroups reads W3C tokens, nested names joined with dots', () => {
  const g = Ui.tokenGroups('{"color":{"$type":"color","a":{"$value":"#fff"},"b":{"c":{"$value":"#000"}}},"$description":"x"}');
  assert.deepEqual(g, { color: ['a', 'b.c'] });
  assert.equal(Ui.tokenGroups(null), null);
  assert.equal(Ui.tokenGroups('{nope'), null);
});
test('ui: the spec schema accepts an optional file field', () => {
  const spec = JSON.parse(load().specs[0].text);
  assert.deepEqual(Ui.validate('ui-screen-spec', { ...spec, file: 'src/pages/Bordereaux.tsx' }), []);
  assert.ok(Ui.validate('ui-screen-spec', { ...spec, viewports: [1] }).length > 0, 'no viewports field: one viewport');
});
test('ui: locator roles match core.js', () => assert.deepEqual(Ui.LOCATOR_ROLES, require('../renderer/core.js').LOCATOR_ROLES));
test('ui: the pin reader takes the latest pin per pack', () => {
  const p = Ui.pins([{ kind: 'ui_pinned', pack: 'a', hash: '1', _ts: 1 }, { kind: 'ui_pinned', pack: 'a', hash: '2', _ts: 2 }, { kind: 'x' }]);
  assert.equal(p.get('a').hash, '2');
});
test('ui: packDiff lists added, removed and changed files', () => {
  const d = Ui.packDiff([{ path: 'a', text: '1' }, { path: 'b', text: '1' }], [{ path: 'b', text: '2' }, { path: 'c', text: '1' }]);
  assert.deepEqual(d, { added: ['c'], removed: ['a'], changed: ['b'] });
});
test('ui: the generated schemas are up to date with docs/', () => {
  const r = require('node:child_process').spawnSync('node', ['scripts/gen-ui-schemas.js', '--check'], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
