const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../renderer/contracts.js');

const doc = { agents: [{ id: 'S/A', name: 'A' }, { id: 'S/B', name: 'B' }, { id: 'S/C', name: 'C' }] };

test('settings: absent is null; a command is needed', () => {
  assert.equal(C.settings(undefined), null);
  assert.match(C.settings({}).error, /needs a command/);
  assert.deepEqual(C.settings({ command: 'x {agents}' }), { label: 'Compile contracts', command: 'x {agents}' });
});

test('command: fills agents, out and registry quoted; refuses unknown placeholders and newlines', () => {
  assert.equal(C.command('c {agents} {out}', { agents: "a b/it's.json", out: 'o' }), "c 'a b/it'\\''s.json' 'o'");
  assert.match(C.command('c {handover}', {}).error, /does not fill/);
  assert.match(C.command('a\nb', {}).error, /one line/);
});

test('readResult: one row per agent, a missing one says so, an invented id is a problem, a non-compiled row needs a reason', () => {
  const r = C.readResult(JSON.stringify({ schema: 'designc.contracts.result/1', agents: [
    { id: 'S/A', status: 'compiled', files: ['contracts/out/a.yaml'] },
    { id: 'S/B', status: 'needs_input', reasons: ['no goal type'] },
    { id: 'S/X', status: 'compiled' },
    { id: 'S/C', status: 'failed' }] }), doc);
  assert.deepEqual(r.agents.map(a => [a.id, a.status]), [['S/A', 'compiled'], ['S/B', 'needs_input'], ['S/C', 'missing']]);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /S\/X/);
  assert.match(r.problems[1], /failed needs a reason/);
});

test('readResult: not JSON, or the wrong schema, is an error', () => {
  assert.match(C.readResult('nope', doc).error, /not JSON/);
  assert.match(C.readResult('{"schema":"x","agents":[]}', doc).error, /must be/);
});
