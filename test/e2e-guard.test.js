// Guards the @critical end-to-end journeys (e2e/) against being skipped, focused or removed.
// Removing a journey means editing CRITICAL here too, which shows in review (AGENTS.md).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'e2e');
const CRITICAL = [
  'user can open a registry @critical',
  'user sees the model findings @critical',
  'user can bind a decision @critical',
  'user can freeze a handover @critical',
  'user can extract the code map @critical',
  'user can track a work item @critical',
  'user can study a topic and decide from it @critical',
  'user can pin a domain pack and see it checked @critical',
  'user can see legacy parity and what it holds a work item to @critical',
];
const specs = () => fs.readdirSync(DIR).filter(f => f.endsWith('.spec.js'))
  .map(f => ({ f, text: fs.readFileSync(path.join(DIR, f), 'utf8') }));

test('no e2e spec is skipped, focused or marked fixme', () => {
  for (const { f, text } of specs()) {
    const hit = text.match(/\btest\s*\.\s*(skip|only|fixme|fail)\s*\(|\bdescribe\s*\.\s*(skip|only|fixme)\s*\(/);
    assert.equal(hit, null, `${f} uses ${hit && hit[0]}: fix the app or the journey instead`);
  }
});

test('every critical journey is still there', () => {
  const all = specs().map(s => s.text).join('\n');
  for (const title of CRITICAL) assert.ok(all.includes(`test('${title}'`), `missing e2e journey: ${title}`);
});
