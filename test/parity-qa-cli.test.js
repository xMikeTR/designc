'use strict';
// scripts/parity-qa.js on scratch copies of fixtures/parity-registry: read-only, buckets each QA bug, copies no bug text.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CLI = require('../scripts/parity-qa.js');

const SRC = path.join(__dirname, '..', 'fixtures', 'parity-registry');
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-qa-cli-'));
  fs.cpSync(SRC, dir, { recursive: true });
  return dir;
}
async function run(args) {
  const out = [];
  const err = [];
  const code = await CLI.main(args, { log: s => out.push(s), err: s => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const listing = dir => fs.readdirSync(dir, { recursive: true }).sort().join('\n');

test('reports the four buckets for a screen and writes nothing', async () => {
  const reg = scratch();
  const before = listing(reg);
  const r = await run(['--registry', reg, '--screen', 'tags']);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /tags: 6 QA bugs; 1 caught, 1 not captured by this layer, 2 state not recorded, 1 captured but not flagged, 1 need triage/);
  assert.match(r.out, /TAG-1 caught: tags-list step 1 \(list\)/);
  assert.match(r.out, /TAG-5 captured but not flagged/);
  assert.ok(!/year first|wrong colour|2026-01-15/.test(r.out), 'no bug text in the output');
  assert.strictEqual(listing(reg), before);
});

test('--json gives the report per screen; all reads every QA file', async () => {
  const reg = scratch();
  const r = await run(['--registry', reg, '--screen', 'all', '--json']);
  assert.strictEqual(r.code, 0, r.err);
  const [rep] = JSON.parse(r.out);
  assert.strictEqual(rep.screen, 'tags');
  assert.deepStrictEqual(rep.counts, { caught: 1, not_captured: 1, state_not_recorded: 2, not_flagged: 1, triage: 1 });
  assert.strictEqual(rep.file, 'parity/qa/tags.yaml');
});

test('file problems exit 1, still reporting; screenshots need an ignored shots folder', async () => {
  const reg = scratch();
  fs.rmSync(path.join(reg, 'parity/qa/shots'), { recursive: true });
  fs.appendFileSync(path.join(reg, 'parity/qa/tags.yaml'), '  - key: TAG-7\n    kind: colour\n    screenshots: [shots/tag-7.png]\n');
  const r = await run(['--registry', reg, '--screen', 'tags']);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /kind must be one of/);
  assert.match(r.out, /parity\/qa\/shots\/\.gitignore is missing/);
  assert.match(r.out, /tags: 7 QA bugs/);
});

test('errors exit 2: no folder, no QA file, bad arguments', async () => {
  const reg = scratch();
  assert.strictEqual((await run(['--registry', path.join(reg, 'nope'), '--screen', 'tags'])).code, 2);
  const none = await run(['--registry', reg, '--screen', 'orders']);
  assert.strictEqual(none.code, 2);
  assert.match(none.err, /no parity\/qa\/orders\.yaml/);
  assert.strictEqual((await run(['--registry', reg])).code, 2);
  assert.strictEqual((await run(['--registry', reg, '--screen', '../x'])).code, 2);
  fs.rmSync(path.join(reg, 'parity/qa'), { recursive: true });
  assert.match((await run(['--registry', reg, '--screen', 'all'])).err, /no QA files/);
});
