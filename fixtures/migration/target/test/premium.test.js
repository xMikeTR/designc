const test = require('node:test');
const assert = require('node:assert/strict');
const { cededPremium } = require('../src/pricing/premium');

test('premium is limit times rate on line', () => {
  assert.equal(cededPremium(1250000, 250), 31250);
});
test('a premium under the minimum is raised to 5,000', () => {
  assert.equal(cededPremium(100000, 250), 5000);
});
test('a half pound rounds to the even pound, as the legacy does', () => {
  assert.equal(cededPremium(2000500, 250), 50012);
  assert.equal(cededPremium(2000700, 250), 50018);
});
