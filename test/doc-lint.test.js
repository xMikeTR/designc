// Doc lint (R7): keeps the docs from claiming things the code contradicts.
//
// Check 1. No term under "Agreed, not yet built" in UBIQUITOUS_LANGUAGE.md may already exist in code.
//   A term (the first cell of a table row; "A / B" lists several) counts as built when
//   - its camelCase form equals an exported Core name, ignoring case ("Semantic diff" -> semanticDiff), or
//   - its kebab-case form, or its first word alone, equals the stem of a renderer/core-*.js file
//     ("Blast radius" -> core-blast-radius.js, or core-blast.js through "blast").
//   - or it has an entry in SYNONYMS below (Semantic diff is built as Core.diffModels).
//   Matching is exact and deliberately simple. When a term trips the rule but is truly unbuilt,
//   reword the term; do not loosen the rule.
// Check 2. The Electron major version in AGENTS.md ("plain Electron NN") equals package.json's.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const SYNONYMS = { 'semantic diff': 'diffModels' };
const camel = t => t.toLowerCase().split(/\s+/).map((w, i) => i ? w[0].toUpperCase() + w.slice(1) : w).join('');
const kebab = t => t.toLowerCase().split(/\s+/).join('-');

function unbuiltTerms() {
  const text = read('UBIQUITOUS_LANGUAGE.md');
  const m = text.match(/^## Agreed, not yet built\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m);
  assert.ok(m, 'UBIQUITOUS_LANGUAGE.md has no "Agreed, not yet built" section');
  return m[1].split('\n')
    .filter(l => l.startsWith('|') && !/^\|\s*(Term\b|-)/.test(l))
    .flatMap(l => l.split('|')[1].split('/').map(s => s.trim()).filter(Boolean));
}

test('no term agreed-but-not-built already exists in code', () => {
  const Core = require('../renderer/core.js');
  const names = new Set(Object.keys(Core).map(k => k.toLowerCase()));
  const stems = fs.readdirSync(path.join(ROOT, 'renderer'))
    .map(f => f.match(/^core-(.+)\.js$/)).filter(Boolean).map(m => m[1]);
  const terms = unbuiltTerms();
  assert.ok(terms.length > 0, 'found no terms to lint');
  const stale = [];
  for (const t of terms) {
    const hitName = names.has(camel(t).toLowerCase()) || names.has((SYNONYMS[t.toLowerCase()] || '').toLowerCase());
    const hitFile = stems.includes(kebab(t)) || stems.includes(t.toLowerCase().split(/\s+/)[0]);
    if (hitName || hitFile) stale.push(`"${t}" already exists in code (${hitName ? 'Core.' + (SYNONYMS[t.toLowerCase()] || camel(t)) : 'renderer/core-' + (stems.includes(kebab(t)) ? kebab(t) : t.toLowerCase().split(/\s+/)[0]) + '.js'}); move it to a built section`);
  }
  assert.deepStrictEqual(stale, []);
});

test('AGENTS.md states the Electron major version package.json installs', () => {
  const pkg = JSON.parse(read('package.json'));
  const range = (pkg.devDependencies || {}).electron || (pkg.dependencies || {}).electron;
  assert.ok(range, 'package.json has no electron dependency');
  const actual = range.match(/\d+/)[0];
  const doc = read('AGENTS.md').match(/plain Electron (\d+)/);
  assert.ok(doc, 'AGENTS.md has no "plain Electron <major>" statement');
  assert.strictEqual(doc[1], actual, `AGENTS.md says Electron ${doc[1]}, package.json has ${range}`);
});
