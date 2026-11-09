const test = require('node:test');
const assert = require('node:assert/strict');
const { renewalFee } = require('../src/fares/renewal');

test('renewal is pro rata by days, rounded to whole pounds', () => {
  assert.equal(renewalFee(50012, 100), 13702);
  assert.equal(renewalFee(31250, 365), 31250);
});
