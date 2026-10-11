// Ledger.verify: the trail checks V1 to V8, one fixture per rule.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

let n = 0;
const ev = (kind, fields = {}) => ({ schema_version: 1, event_id: `e${++n}`, ts: 1000 + n, kind, by: 'me', ...fields });
const gate = (fields = {}) => ev('gate', { source: 'local', revision: 'r-aaaa1111', ready: true, verdict: 'v', clauses: [], findings: [], ...fields });
const handover = (fields = {}) => ev('handover', { handover: 'H-1', revision: 'aaaa1111', ...fields });
const check = (fields = {}) => ev('check', { decision: 'D-1', check: 'p check', outcome: 'pass', source: 'local', ...fields });
const promoted = (fields = {}) => ev('decision_promoted', { decision: 'D-1', ...fields });
const file = (path, events) => ({ path, text: events.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + '\n' });
const run = (events, opts = { handovers: [], decisions: [] }, path = 'ledger/checks.jsonl') =>
  Ledger.verify([file(path, events)], opts);
const rules = r => ({ e: r.errors.map(x => x.rule), w: r.warnings.map(x => x.rule) });

test('a clean trail has no errors or warnings', () => {
  const r = run([gate(), handover()], { handovers: ['H-1'], decisions: [] });
  assert.deepEqual(rules(r), { e: [], w: [] });
});

test('V1: a handover needs a green gate event at the same revision before it', () => {
  assert.deepEqual(rules(run([gate({ revision: 'r-other' }), handover()], { handovers: ['H-1'] })).e, ['V1']);
  const red = run([gate({ ready: false }), handover()], { handovers: ['H-1'] });
  assert.deepEqual(rules(red).e, ['V1']);
  assert.match(red.errors[0].msg, /H-1/);
  const later = run([handover({ ts: 1 }), gate({ ts: 5 }), ev('handover', { handover: 'H-2', revision: 'aaaa1111', ts: 9 })], { handovers: ['H-1', 'H-2'] });
  assert.deepEqual(rules(later), { e: [], w: ['V1'] }, 'H-1 predates the first gate event: a warning; H-2 is fine');
  const flipped = run([gate({ ts: 5 }), gate({ ts: 6, ready: false }), handover({ ts: 7 })], { handovers: ['H-1'] });
  assert.deepEqual(rules(flipped).e, ['V1'], 'the latest gate before the handover decides');
  const tie = run([handover({ ts: 5 }), gate({ ts: 5 })], { handovers: ['H-1'] });
  assert.deepEqual(rules(tie), { e: [], w: [] }, 'same millisecond counts as before');
});

test('V1 accepts the revision with or without its r- prefix', () => {
  assert.deepEqual(rules(run([gate({ revision: 'r-abc12345' }), handover({ revision: 'r-abc12345' })], { handovers: ['H-1'] })), { e: [], w: [] });
  assert.deepEqual(rules(run([gate({ revision: 'r-abc12345' }), handover({ revision: 'abc12345' })], { handovers: ['H-1'] })), { e: [], w: [] });
});

test('V2: a handover marked dirty is an error', () => {
  assert.deepEqual(rules(run([gate(), handover({ dirty: true })], { handovers: ['H-1'] })).e, ['V2']);
  assert.deepEqual(rules(run([gate(), handover({ dirty: false, commit: null })], { handovers: ['H-1'] })).e, []);
});

test('V3: a technical decision is promoted after a passing check; business and unknown decisions are not judged', () => {
  const tech = { handovers: [], decisions: [{ id: 'D-1', kind: 'technical' }] };
  assert.deepEqual(rules(run([promoted()], tech)).e, ['V3']);
  assert.deepEqual(rules(run([check({ outcome: 'fail', exit_code: 1 }), promoted()], tech)).e, ['V3']);
  assert.deepEqual(rules(run([check({ ts: 5 }), promoted({ ts: 6 })], tech)).e, []);
  assert.deepEqual(rules(run([promoted({ ts: 5 }), check({ ts: 6 })], tech)).e, ['V3'], 'a check after the promotion does not count');
  assert.deepEqual(rules(run([check({ ts: 5 }), check({ ts: 6, outcome: 'fail', reason: 'x' }), promoted({ ts: 7 })], tech)).e, ['V3'], 'the latest check decides');
  assert.deepEqual(rules(run([promoted()], { handovers: [], decisions: [{ id: 'D-1', kind: 'business' }] })).e, []);
  assert.deepEqual(rules(run([promoted()], { handovers: [], decisions: [] })).e, [], 'a decision no longer in the registry cannot be judged');
  assert.deepEqual(rules(run([promoted()], { handovers: [], decisions: [{ id: 'D-1' }] })).e, ['V3'], 'no kind means technical');
  assert.deepEqual(rules(run([promoted()], { handovers: [], decisions: [{ id: 'D-1', effect: 'accept', checks: ['TODO x'] }] })).e, [], 'an accepted risk with no real check needs none');
  assert.deepEqual(rules(run([promoted()], { handovers: [], decisions: [{ id: 'D-1', effect: 'accept', checks: ['run it'] }] })).e, ['V3'], 'a listed check on an accept still counts');
});

test('V4: every line must validate', () => {
  const r = run(['not json', '[1]', JSON.stringify({ ...gate(), verdict: undefined }), JSON.stringify({ schema_version: 2, kind: 'gate' }),
    JSON.stringify({ schema_version: 1, envelope_version: 1, kind: 'gate' }), gate()]);
  assert.deepEqual(rules(r).e, ['V4', 'V4', 'V4', 'V4', 'V4']);
  assert.match(r.errors[0].msg, /^checks\.jsonl:1 not valid JSON/);
  assert.match(r.errors[1].msg, /^checks\.jsonl:2 not a JSON object/);
  assert.match(r.errors[2].msg, /^checks\.jsonl:3 gate\.verdict/);
  assert.match(r.errors[3].msg, /schema_version 2/);
  assert.match(r.errors[4].msg, /both schema_version and envelope_version/);
});

test('V4 leaves legacy lines and harness events alone', () => {
  const r = run([JSON.stringify({ kind: 'task', task: 'T', status: 'passed', ts: 5 }), JSON.stringify({ envelope_version: 1, kind: 'SessionStarted' })]);
  assert.deepEqual(rules(r), { e: [], w: [] });
});

test('V5: a repeated event_id with different content is an error; an identical repeat is a union merge', () => {
  const a = gate({ event_id: 'dup' });
  assert.deepEqual(rules(run([a, { ...a }])).e, [], 'identical');
  const r = Ledger.verify([file('ledger/a.jsonl', [a]), file('ledger/b.jsonl', [{ ...a, ready: false }])], { handovers: [], decisions: [] });
  assert.deepEqual(rules(r).e, ['V5']);
  assert.match(r.errors[0].msg, /dup.*a\.jsonl:1.*b\.jsonl:1/);
});

test('V6: open unapproved changes are warnings', () => {
  const r = run([ev('unapproved_change', { agent: 'claude', role: 'architect', path: 'model/workspace.dsl', via: 'acp' })]);
  assert.deepEqual(rules(r), { e: [], w: ['V6'] });
  assert.match(r.warnings[0].msg, /claude.*model\/workspace\.dsl/);
});

test('V7: handover folders and handover events agree, in both directions', () => {
  const r = run([gate(), handover()], { handovers: ['H-1', 'H-9'], decisions: [] });
  assert.deepEqual(rules(r).e, ['V7']);
  assert.match(r.errors[0].msg, /H-9/);
  const r2 = run([gate(), handover(), ev('handover', { handover: 'H-2', revision: 'aaaa1111' })], { handovers: ['H-1'], decisions: [] });
  assert.deepEqual(rules(r2).e, ['V7']);
  assert.match(r2.errors[0].msg, /H-2/);
});

test('sample events are skipped and counted', () => {
  const r = run([gate({ sample: true }), handover({ sample: true, dirty: true }), promoted({ sample: true }), ev('unapproved_change', { agent: 'a', role: 'r', path: 'p', via: 'acp', sample: true })],
    { handovers: [], decisions: [{ id: 'D-1' }] });
  assert.deepEqual(rules(r), { e: [], w: [] });
  assert.equal(r.skipped, 4);
});

test('files are read in path order so the report does not depend on listing order', () => {
  const a = file('ledger/a.jsonl', ['bad']), b = file('ledger/b.jsonl', ['worse']);
  const one = Ledger.verify([a, b], { handovers: [], decisions: [] }), two = Ledger.verify([b, a], { handovers: [], decisions: [] });
  assert.deepEqual(one, two);
});

const evalEv = (fields = {}) => ev('eval', { eval: 'EV-1', agent: 'A', outcome: 'pass', metrics: { m: 1 }, cases: 1, source: 'pipeline', fingerprint: 'f', eval_hash: 'new', ...fields });

test('V8: a pipeline eval after the latest handover must run the eval file the handover froze', () => {
  const opts = { handovers: ['H-1'], decisions: [], handoverEvals: { 'H-1': { 'EV-1': 'old' } } };
  const r = run([gate(), handover(), evalEv()], opts);
  assert.deepEqual(rules(r).e, ['V8']);
  assert.match(r.errors[0].msg, /EV-1.*H-1/);
  assert.deepEqual(rules(run([gate(), handover(), evalEv({ eval_hash: 'old' })], opts)).e, [], 'same file');
  assert.deepEqual(rules(run([gate(), handover(), evalEv({ source: 'local' })], opts)).e, [], 'local runs are not judged');
  assert.deepEqual(rules(run([evalEv({ ts: 1 }), gate(), handover()], opts)).e, [], 'before the handover');
  assert.deepEqual(rules(run([gate(), handover(), evalEv({ eval: 'EV-9' })], opts)).e, [], 'an eval the handover did not freeze');
  assert.deepEqual(rules(run([gate(), handover(), evalEv()], { handovers: ['H-1'], decisions: [] })).e, [], 'no recorded hashes');
  assert.equal(run([gate(), handover(), evalEv(), evalEv()], opts).errors.length, 1, 'said once per eval file');
});
