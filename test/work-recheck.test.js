const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

// Slice 25: has the design moved under a frozen work item?
const dsl = (apiProps = '', mailProps = '') => `workspace "Quotes" {
  model {
    s = softwareSystem "Quotes" {
      api = container "Quotes API" "" "C#" {
        properties { d.code "src/Api/**"
          d.risk medium
          ${apiProps} }
      }
      db = container "Quotes DB"
      mail = container "Mail" {
        properties { d.code "src/Mail/**"
          d.risk low
          ${mailProps} }
      }
    }
    api -> db "writes" { properties { d.interaction sync } }
  }
}`;
const before = Core.parse(dsl());
const item = { id: 'W-q', requirement: 'R-1', elements: ['Quotes API', 'Quotes DB'] };
const frozen = { model: before, inScope: ['Quotes API', 'Quotes DB'], requirement: 'R-1' };
const bound = (id, binds) => ({ id, status: 'bound', effect: 'fix', binds, requirement: 'R-1' });

test('nothing moved: not stale', () => {
  const r = Core.workRecheck({ item, frozen, model: Core.parse(dsl()), decisions: [], requirements: [] });
  assert.deepEqual(r, { stale: false, reasons: [] });
});

test('an in-scope element changed since freeze', () => {
  const after = Core.parse(dsl('d.availability "0.99"'));
  const r = Core.workRecheck({ item, frozen, model: after, decisions: [], requirements: [] });
  assert.equal(r.stale, true);
  assert.deepEqual(r.reasons.map(x => x.kind), ['element']);
  assert.match(r.reasons[0].text, /Quotes API changed/);
});

test('a change outside the item does not make it stale', () => {
  const after = Core.parse(dsl('', 'd.availability "0.9"'));
  assert.equal(Core.workRecheck({ item, frozen, model: after, decisions: [], requirements: [] }).stale, false);
});

test('a bound decision on an in-scope element that changed is named', () => {
  const after = Core.parse(dsl('d.availability "0.99"'));
  const r = Core.workRecheck({ item, frozen, model: after, decisions: [bound('D-1', ['Quotes API']), bound('D-2', ['Mail'])], requirements: [] });
  assert.deepEqual(r.reasons.filter(x => x.kind === 'decision').map(x => x.text.split(' ')[0]), ['D-1']);
});

test('the item scope edited after freeze is stale, naming what was added and removed', () => {
  const edited = { ...item, elements: ['Quotes API', 'Mail'] };
  const r = Core.workRecheck({ item: edited, frozen, model: before, decisions: [], requirements: [] });
  assert.equal(r.stale, true);
  assert.deepEqual(r.reasons.map(x => x.kind), ['scope']);
  assert.match(r.reasons[0].text, /added Mail/);
  assert.match(r.reasons[0].text, /removed Quotes DB/);
});

test('an element removed from the model is stale', () => {
  const after = Core.parse(dsl().replace(/db = container "Quotes DB"\n/, '').replace(/    api -> db.*\n/, ''));
  const r = Core.workRecheck({ item, frozen, model: after, decisions: [], requirements: [] });
  assert.ok(r.reasons.some(x => x.kind === 'element' && /Quotes DB removed/.test(x.text)), JSON.stringify(r));
});

test('the item moved to another requirement is a scope change', () => {
  const r = Core.workRecheck({ item: { ...item, requirement: 'R-2' }, frozen, model: before, decisions: [], requirements: [] });
  assert.ok(r.reasons.some(x => x.kind === 'scope' && /R-1/.test(x.text) && /R-2/.test(x.text)));
});
