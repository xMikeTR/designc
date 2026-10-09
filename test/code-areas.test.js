// d.code is System 2's scope guard: a pattern it rejects, an empty list or a missing d.risk fails the
// handover in System 2, so designc reports them before the freeze (DC000).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const el = (name, props) => `${name.toLowerCase().replace(/\W/g, '')} = container "${name}" {
        properties { ${Object.entries(props).map(([k, v]) => `"${k}" "${v}"`).join(' ')} }
      }`;
const model = (...els) => `workspace { model { s = softwareSystem "S" {
      ${els.join('\n      ')}
} } }`;
const findings = (text, code) => Core.check(Core.parse(text), { chainHops: 4 }).filter(d => d.code === code);

test('valid patterns with a d.risk give no DC000', () => {
  assert.deepEqual(findings(model(el('Api', { 'd.code': 'src/Api/**, ./tests\\Api.Tests/', 'd.risk': 'low' })), 'DC000'), []);
});

test('a pattern System 2 rejects is a DC000 error naming the pattern', () => {
  const ds = findings(model(el('Api', { 'd.code': 'src/Api/**, ../shared/**', 'd.risk': 'low' })), 'DC000');
  assert.equal(ds.length, 1);
  assert.equal(ds[0].sev, 'error');
  assert.match(ds[0].msg, /^"d\.code" = "src\/Api\/\*\*, \.\.\/shared\/\*\*": invalid segment '\.\.' in \.\.\/shared\/\*\*$/);
  assert.equal(ds[0].loc.label, 'Api');
});

test('every rejected pattern is reported, not only the first', () => {
  assert.equal(findings(model(el('Api', { 'd.code': 'src/[ab], /abs, src/a**b', 'd.risk': 'low' })), 'DC000').length, 3);
});

test('an empty d.code or a blank entry is an error', () => {
  const empty = findings(model(el('Api', { 'd.code': ' ', 'd.risk': 'low' })), 'DC000');
  assert.equal(empty.length, 1);
  assert.match(empty[0].msg, /lists no paths/);
  const blank = findings(model(el('Api', { 'd.code': 'src/A/**, , src/B/**', 'd.risk': 'low' })), 'DC000');
  assert.equal(blank.length, 1);
  assert.match(blank[0].msg, /entry 2 is blank/);
});

test('d.code without d.risk is an error', () => {
  const ds = findings(model(el('Api', { 'd.code': 'src/Api/**' })), 'DC000');
  assert.equal(ds.length, 1);
  assert.match(ds[0].msg, /d\.code needs d\.risk/);
  assert.match(ds[0].hint, /low \| medium \| high/);
});

test('d.risk without d.code is fine (System 2 ignores the element)', () => {
  assert.deepEqual(findings(model(el('Api', { 'd.risk': 'low' })), 'DC000'), []);
});

// DC009: System 2 gives a file to the first element whose d.code matches it, and only one level per
// branch may declare d.code, so overlaps and nesting are errors in the design.
test('code areas that may overlap are a DC009 error on the element declared later', () => {
  const ds = findings(model(
    el('Api', { 'd.code': 'src/Api/**', 'd.risk': 'low' }),
    el('Worker', { 'd.code': 'src/Worker/**', 'd.risk': 'low' }),
    el('Handlers', { 'd.code': 'src/Other/**, src/Api/Handlers/*.cs', 'd.risk': 'low' })), 'DC009');
  assert.equal(ds.length, 1);
  assert.equal(ds[0].sev, 'error');
  assert.equal(ds[0].loc.label, 'Handlers');
  assert.match(ds[0].msg, /src\/Api\/Handlers\/\*\.cs/);
  assert.match(ds[0].msg, /src\/Api\/\*\*/);
  assert.deepEqual(ds[0].related.map(r => r.label), ['Api']);
});

test('disjoint code areas give no DC009', () => {
  assert.deepEqual(findings(model(
    el('Api', { 'd.code': 'src/Api/**', 'd.risk': 'low' }),
    el('Worker', { 'd.code': 'src/Worker/**, src/*.props', 'd.risk': 'low' })), 'DC009'), []);
});

test('one DC009 per pair, however many patterns overlap', () => {
  assert.equal(findings(model(
    el('Api', { 'd.code': 'src/Api/**, tests/Api/**', 'd.risk': 'low' }),
    el('Copy', { 'd.code': 'src/Api/**, tests/Api/**', 'd.risk': 'low' })), 'DC009').length, 1);
});

test('d.code on an element inside one that declares it is a DC009 error on the inner element', () => {
  const ds = findings(`workspace { model { s = softwareSystem "S" {
      api = container "Api" {
        properties { "d.code" "src/Api/**" "d.risk" "low" }
        h = component "Handlers" {
          properties { "d.code" "src/Elsewhere/**" "d.risk" "low" }
        }
      }
} } }`, 'DC009');
  assert.equal(ds.length, 1);
  assert.equal(ds[0].loc.label, 'Handlers');
  assert.match(ds[0].msg, /inside "Api"/);
  assert.deepEqual(ds[0].related.map(r => r.label), ['Api']);
});

test('an invalid pattern is left to DC000 and an intended overlap can be suppressed', () => {
  assert.deepEqual(findings(model(
    el('Api', { 'd.code': '../x/**', 'd.risk': 'low' }),
    el('Worker', { 'd.code': '../x/**', 'd.risk': 'low' })), 'DC009'), []);
  const ds = findings(model(
    el('Api', { 'd.code': 'src/**', 'd.risk': 'low' }),
    el('Worker', { 'd.code': 'src/Worker/**', 'd.risk': 'low', 'd.suppress': 'DC009: shared build props, owner agreed' })), 'DC009');
  assert.equal(ds.length, 1);
  assert.ok(ds[0].suppressed);
});

// Code areas against the codebase: display-only drift in the Code map, judged on the files extraction read.
const FILES = ['src/Api/Program.cs', 'src/Api/Orders.cs', 'src/Worker/Job.cs', 'tests/Api.Tests/T.cs', 'README.json'];

test('codeAreaDrift counts the files each pattern matches and lists the files no area claims', () => {
  const m = Core.parse(model(
    el('Api', { 'd.code': 'src/Api/**, tests/Api.Tests/**', 'd.risk': 'low' }),
    el('Docs', { 'd.code': 'docs/**', 'd.risk': 'low' }),
    el('Plain', {})));
  const r = Core.codeAreaDrift(m, FILES);
  assert.deepEqual(r.areas.map(a => [a.name, a.pattern, a.matched]),
    [['Api', 'src/Api/**', 2], ['Api', 'tests/Api.Tests/**', 1], ['Docs', 'docs/**', 0]]);
  assert.equal(r.areas[0].id, 'api');
  assert.deepEqual(r.unclaimed, ['README.json', 'src/Worker/Job.cs']);
  assert.equal(r.files, 5);
});

test('codeAreaDrift is null without a file list, and claims nothing when no element declares d.code', () => {
  const m = Core.parse(model(el('Api', { 'd.risk': 'low' })));
  assert.equal(Core.codeAreaDrift(m, undefined), null);
  assert.deepEqual(Core.codeAreaDrift(m, FILES), { areas: [], unclaimed: [], files: 5 });
});

test('a pattern DC000 rejects is left out of the drift', () => {
  const r = Core.codeAreaDrift(Core.parse(model(el('Api', { 'd.code': 'src/Api/**, ../x/**', 'd.risk': 'low' }))), FILES);
  assert.deepEqual(r.areas.map(a => a.pattern), ['src/Api/**']);
});

test('extraction keeps the repo-relative file list it read as facts.files', async () => {
  const path = require('path');
  const { extract } = require('../extract.js');
  const r = await extract(path.join(__dirname, '..', 'fixtures', 'fullstack'));
  assert.ok(r.facts.files.length > 10);
  assert.ok(r.facts.files.includes('api/src/Shop.Api/Program.cs'));
  assert.ok(r.facts.files.every(f => !f.includes('\\') && !f.startsWith('/') && !/(^|\/)(obj|bin|node_modules)\//.test(f)));
  assert.deepEqual(r.facts.files, [...r.facts.files].sort());
});
