const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const f = { code: 'DC002', loc: { names: ['Quotes DB'] } };
const rel = { code: 'DC004', loc: { names: ['Api', 'Vendor'] } };

test('decisionsFor lists the decisions that resolve this code on this element, bound first', () => {
  const decs = [
    { id: 'a', status: 'minted', effect: 'fix', binds: ['Quotes DB'], resolves: ['DC002'] },
    { id: 'b', status: 'bound', effect: 'accept', binds: ['Quotes DB'], resolves: ['DC002'] },
    { id: 'c', status: 'bound', effect: 'accept', binds: ['Other'], resolves: ['DC002'] },
    { id: 'd', status: 'bound', effect: 'accept', binds: ['Quotes DB'], resolves: ['DC005'] },
    { id: 'e', status: 'superseded', effect: 'fix', binds: ['Quotes DB'], resolves: ['DC002'] },
    { id: 'g', status: 'minted', binds: 'Quotes DB', resolves: 'DC002' },
  ];
  assert.deepEqual(Core.decisionsFor(f, decs).map(d => d.id), ['b', 'a']);
  assert.deepEqual(Core.decisionsFor(rel, [{ id: 'r', status: 'minted', binds: ['Vendor'], resolves: ['DC004'] }]).map(d => d.id), ['r']);
  assert.deepEqual(Core.decisionsFor(f, []), []);
});
