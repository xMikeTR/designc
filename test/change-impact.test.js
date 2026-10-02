const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const dsl = ({ tech = 'SQL', desc = 'x', extra = '' } = {}) => `workspace {
 model {
  sys = softwareSystem "Pricing" {
   api = container "Pricing API" "${desc}" "C#"
   db = container "Quotes DB" "d" "${tech}"
   other = container "Other"
   ${extra}
  }
  api -> db "writes" "TDS"
 }
}`;
const impact = (a, b, o = {}) => Core.changeImpact(Core.parse(a), Core.parse(b), { decisions: [], requirements: [], ...o });
const dec = (o = {}) => ({ id: 'd1', status: 'bound', binds: ['Quotes DB'], requirement: 'R-1', ...o });
const req = (o = {}) => ({ id: 'R-1', elements: [], ...o });

test('no meaningful change gives an empty impact', () => {
  const i = impact(dsl(), dsl({ desc: 'other words' }), { decisions: [dec()], requirements: [req()] });
  assert.deepEqual([i.decisions, i.requirements, i.introduced, i.resolved], [[], [], [], []]);
  assert.equal(i.changed, 0);
});

test('a decision whose bound element changed is affected, with the reason', () => {
  const i = impact(dsl(), dsl({ tech: 'Postgres' }), { decisions: [dec(), dec({ id: 'd2', binds: ['Other'] })] });
  assert.deepEqual(i.decisions.map(d => d.id), ['d1']);
  assert.equal(i.decisions[0].element, 'Quotes DB');
  assert.match(i.decisions[0].reason, /changed/);
});

test('a change to a rel touching the bound element affects its decision', () => {
  const i = impact(dsl(), dsl().replace('"TDS"', '"JDBC"'), { decisions: [dec(), dec({ id: 'd2', binds: ['Other'] })] });
  assert.deepEqual(i.decisions.map(d => d.id), ['d1']);
});

test('a removed bound element is affected as removed', () => {
  const i = impact(dsl(), dsl().replace(/ *db = container.*\n/, '').replace('api -> db "writes" "TDS"', ''), { decisions: [dec()] });
  assert.match(i.decisions[0].reason, /removed/);
});

test('requirements follow affected decisions and elements they list', () => {
  const i = impact(dsl(), dsl({ tech: 'Postgres' }), { decisions: [dec()], requirements: [req(), req({ id: 'R-2', elements: ['Quotes DB'] }), req({ id: 'R-3', elements: ['Other'] })] });
  assert.deepEqual(i.requirements.sort(), ['R-1', 'R-2']);
});

test('findings introduced and resolved are keyed by code and element', () => {
  const clean = dsl({ extra: '' });
  const bad = dsl().replace('api -> db "writes" "TDS"', 'api -> db "writes" "TDS" {\n properties {\n "d.interaction" "async"\n }\n }');
  const i = impact(clean, bad);
  const j = impact(bad, clean);
  assert.ok(i.introduced.some(f => f.code === 'DC001'));
  assert.deepEqual(i.introduced.map(f => f.code), j.resolved.map(f => f.code));
});
