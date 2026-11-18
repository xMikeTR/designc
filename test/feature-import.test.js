'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const FeatureImport = require('../renderer/feature-import.js');

test('parse: And and But join the previous keyword, and what is not imported is listed', () => {
  const r = FeatureImport.parse(fs.readFileSync(__dirname + '/../fixtures/sample.feature', 'utf8'));
  assert.strictEqual(r.feature, 'Tag sorting');
  assert.strictEqual(r.scenarios.length, 1);
  assert.deepStrictEqual(r.scenarios[0], { title: 'Sort tags by name', given: ['3 tags exist'], when: ['the user sorts by name', 'clicks the header again'], then: ['the tags are in descending order', 'no tag is hidden'], line: 6 });
  const what = r.skipped.map(s => s.what);
  assert.ok(what.includes('Background (not imported)'));
  assert.ok(what.some(w => w.startsWith('Scenario Outline "Filter by <q>"')));
  assert.ok(what.includes('Scenario "No steps" has no when, then step') || what.some(w => w.startsWith('Scenario "No steps" has no')));
  assert.ok(!r.scenarios.some(s => s.title.startsWith('Filter')));
});

test('parse: an unattached And and empty input do not throw', () => {
  assert.deepStrictEqual(FeatureImport.parse(''), { feature: null, scenarios: [], skipped: [] });
  const r = FeatureImport.parse('Feature: x\nScenario: a\n And orphan\n Given g\n When w\n Then t\n');
  assert.strictEqual(r.scenarios.length, 1);
  assert.strictEqual(r.skipped.length, 1);
});
