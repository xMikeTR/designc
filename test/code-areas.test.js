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
