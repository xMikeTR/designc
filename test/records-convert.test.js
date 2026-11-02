'use strict';
// The record converter's dry run: flags what it cannot decide, never guesses, never writes.
// Fixtures in fixtures/records-convert are synthetic and replaceable by redacted work records (see its README).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const RC = require('../renderer/records-convert.js');
const CLI = require('../scripts/records-convert.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'records-convert');
async function run(args) {
  const out = [], err = [];
  const code = await CLI.main(args, { log: s => out.push(s), err: s => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const listing = dir => fs.readdirSync(dir, { recursive: true }).sort().join('\n');

test('the CLI reports each file and its flags, exits 1, writes nothing', async () => {
  const before = listing(FIX);
  const r = await run(['--registry', FIX, '--json']);
  assert.equal(r.code, 1, r.err);
  assert.equal(listing(FIX), before);
  const by = Object.fromEntries(JSON.parse(r.out).map(x => [x.path, x]));
  const codes = p => by[p].flags.map(f => f.code);
  assert.deepEqual(codes('decisions/occ.yaml'), []);
  assert.deepEqual(by['decisions/occ.yaml'].record.scope, ['req:HRE-1', 'el:Pricing API']);
  assert.match(by['decisions/occ.yaml'].record.checks[0].id, /^chk-[0-9a-f]{8}$/);
  assert.deepEqual(by['decisions/occ.yaml'].record.enforced_by, [by['decisions/occ.yaml'].record.checks[0].id]);
  assert.deepEqual(codes('decisions/tags-sort.md'), ['possibly_verdict']);
  assert.equal(by['decisions/tags-sort.md'].record.status, 'proposed');
  assert.equal(by['decisions/tags-sort.md'].record.rationale, 'Users rely on the order they see today.');
  assert.deepEqual(codes('decisions/old-cache.yaml'), ['supersede_without_successor']);
  assert.deepEqual(codes('decisions/no-id.yaml'), ['no_id']);
  assert.deepEqual(codes('decisions/db-owner.yaml'), ['unknown_status', 'unknown_requirement', 'ambiguous_name', 'unknown_element', 'unknown_scope', 'supersedes_unknown', 'check_is_prose']);
  assert.match(by['decisions/db-owner.yaml'].flags[2].msg, /could be any of Quotes DB, Quotes-DB/);
});

test('text output and errors', async () => {
  const r = await run(['--registry', FIX]);
  assert.match(r.out, /^5 decision files; 4 flagged\. Dry run: nothing was written\./);
  assert.match(r.out, /decisions\/occ\.yaml \(occ\): converts cleanly/);
  assert.equal((await run(['--registry', path.join(FIX, 'nope')])).code, 2);
  assert.equal((await run([])).code, 2);
  assert.equal((await run(['--registry', path.join(FIX, 'model')])).code, 2, 'no decisions/ folder');
});

test('convert: one near-miss spelling is ambiguous, not silently mapped; a successor clears supersede; docs as loaded', () => {
  const ctx = { elements: ['Quotes DB'], requirements: [], parseYaml: yaml.load };
  const [a] = RC.convert([{ path: 'decisions/a.yaml', text: 'id: a\nstatus: bound\nbinds: [quotes db]\nstatement: s\n' }], ctx);
  assert.deepEqual(a.flags.map(f => f.code), ['ambiguous_name']);
  assert.deepEqual(a.record.scope, [], 'never guessed into scope');
  const out = RC.convert([
    { path: 'decisions/old.yaml', doc: { id: 'old', status: 'superseded', statement: 's', _path: 'x' } },
    { path: 'decisions/new.yaml', doc: { id: 'new', status: 'minted', statement: 's', supersedes: 'old' } },
  ], ctx);
  assert.deepEqual(out.map(r => r.flags), [[], []]);
  assert.ok(!('_path' in out[0].record));
  const bad = RC.convert([{ path: 'decisions/b.yaml', text: 'id: [' }, { path: 'decisions/c.md', text: 'no front matter' }], ctx);
  assert.deepEqual(bad.map(r => r.flags[0].code), ['invalid', 'invalid']);
});
