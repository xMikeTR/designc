// DC010: when designc.json declares repos, every element with d.code lives in one of them (d.repo, inherited from the
// container). With no repos declared nothing changes (single repo).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const model = (containerProps, componentProps = {}) => `workspace { model { s = softwareSystem "S" {
  api = container "Api" { properties { ${Object.entries(containerProps).map(([k, v]) => `"${k}" "${v}"`).join(' ')} }
    ctl = component "Ctl" { properties { ${Object.entries(componentProps).map(([k, v]) => `"${k}" "${v}"`).join(' ')} } }
  }
} } }`;
const REPOS = { Api: '../api', Ui: '../ui' };
const dc010 = (text, repos) => Core.check(Core.parse(text), { chainHops: 4, repos }).filter(d => d.code === 'DC010');

test('no repos declared: no DC010, d.repo or not', () => {
  assert.deepEqual(dc010(model({ 'd.code': 'src/**', 'd.risk': 'low' })), []);
  assert.deepEqual(dc010(model({ 'd.code': 'src/**', 'd.risk': 'low', 'd.repo': 'Nope' })), []);
});

test('a declared repo on the container is fine, and a component inherits it', () => {
  assert.deepEqual(dc010(model({ 'd.repo': 'Api' }, { 'd.code': 'src/**', 'd.risk': 'low' }), REPOS), []);
  assert.deepEqual(dc010(model({ 'd.repo': 'Ui', 'd.code': 'src/**', 'd.risk': 'low' }), REPOS), []);
});

test('d.code with no repo is an error naming the declared repos', () => {
  const ds = dc010(model({ 'd.code': 'src/**', 'd.risk': 'low' }), REPOS);
  assert.equal(ds.length, 1);
  assert.equal(ds[0].sev, 'error');
  assert.match(ds[0].msg, /no d\.repo/);
  assert.match(ds[0].hint, /Api, Ui/);
});

test('an undeclared repo is an error', () => {
  const ds = dc010(model({ 'd.repo': 'Billing', 'd.code': 'src/**', 'd.risk': 'low' }), REPOS);
  assert.equal(ds.length, 1);
  assert.match(ds[0].msg, /"Billing" is not a declared repo/);
});

test('an element without d.code needs no repo', () => {
  assert.deepEqual(dc010(model({}), REPOS), []);
});
