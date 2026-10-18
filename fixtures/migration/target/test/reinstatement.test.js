const test = require('node:test');
const assert = require('node:assert/strict');
const { reinstatementPremium } = require('../src/pricing/reinstatement');

test('reinstatement is pro rata by days, rounded to whole pounds', () => {
  assert.equal(reinstatementPremium(50012, 100), 13702);
  assert.equal(reinstatementPremium(31250, 365), 31250);
});
