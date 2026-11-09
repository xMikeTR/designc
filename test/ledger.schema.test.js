const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Ledger = require('../renderer/ledger.js');
const Core = require('../renderer/core.js');

test('a valid v1 check validates', () => {
  assert.deepEqual(Ledger.validate({ kind: 'check', by: 'u', decision: 'DEC-001', check: 'npm test', outcome: 'pass', source: 'local', ms: 12 }), []);
  assert.deepEqual(Ledger.validate({ kind: 'check', by: 'u', decision: 'DEC-001', check: 'npm test', outcome: 'fail', source: 'local', ms: 12, exit_code: 1 }), []);
});

test('invalid events are rejected with a reason per defect', () => {
  const base = { by: 'u', decision: 'DEC-001', check: 'npm test', outcome: 'pass', source: 'local' };
  assert.ok(Ledger.validate({ ...base, kind: 'chek' }).length);
  assert.ok(Ledger.validate({ kind: 'check', by: 'u', check: 'npm test', outcome: 'pass', source: 'local' }).length);
  assert.ok(Ledger.validate({ ...base, kind: 'check', outcome: 'passed' }).length);
  assert.ok(Ledger.validate({ ...base, kind: 'check', ts: '2026-09-26T00:00:00Z' }).length);
  assert.ok(Ledger.validate({ ...base, kind: 'check', file: 'x' }).length);
  assert.ok(Ledger.validate({ ...base, kind: 'check', _line: 1 }).length);
  assert.ok(Ledger.validate({ ...base, kind: 'check', schema_version: 2 }).length);
  assert.ok(Ledger.validate({ kind: 'check', by: 'u', decision: 'DEC-001', check: 'npm test', outcome: 'fail', source: 'local' }).length);
});

test('extra data is accepted only under payload', () => {
  const base = { kind: 'check', by: 'u', decision: 'DEC-001', check: 'npm test', outcome: 'pass', source: 'local' };
  assert.deepEqual(Ledger.validate({ ...base, payload: { stdout_tail: 'x', n: [1, 2] } }), []);
  assert.ok(Ledger.validate({ ...base, stdout_tail: 'x', n: [1, 2] }).length);
});

test('the v0 sample ledger upcasts without errors', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'sample-registry', 'ledger', 'pipeline.jsonl'), 'utf8');
  const { events, errors } = Ledger.parse(text, 'pipeline.jsonl');
  assert.equal(events.length, 21);
  assert.equal(errors.length, 0);
  events.forEach((e, i) => {
    assert.equal(e.schema_version, 1);
    assert.equal(e._legacy, true);
    assert.equal(e.event_id, `legacy:pipeline.jsonl:${i + 1}`);
    assert.equal(typeof e.ts, 'number');
  });
});

test('invalid v1, unknown-version and malformed lines go to Problems and are skipped', () => {
  const lines = [
    JSON.stringify({ kind: 'check', by: 'u', decision: 'DEC-001', check: 'x', outcome: 'pass', source: 'local', ts: 1 }),
    JSON.stringify({ kind: 'check', by: 'u', decision: 'DEC-001', check: 'x', outcome: 'fail', source: 'local', schema_version: 1 }),
    JSON.stringify({ kind: 'check', by: 'u', decision: 'DEC-001', check: 'x', outcome: 'pass', source: 'local', schema_version: 2 }),
    'not json',
  ];
  const { events, errors } = Ledger.parse(lines.join('\n'), 'checks.jsonl');
  assert.equal(events.length, 1);
  assert.equal(errors.length, 3);
  assert.deepEqual(errors.map(e => e.line), [2, 3, 4]);
  assert.match(errors[1].msg, /unknown schema_version 2/);
});

test('the gate sees v1 and legacy checks and picks the latest', () => {
  const legacy = JSON.stringify({ kind: 'check', by: 'pipeline', decision: 'DEC-001', check: 'x', outcome: 'fail', source: 'pipeline', ts: 1000 });
  const v1 = JSON.stringify({ kind: 'check', by: 'u', decision: 'DEC-001', check: 'x', outcome: 'pass', source: 'local', schema_version: 1, event_id: 'e1', ts: 2000 });
  const a = Ledger.parse(legacy, 'pipeline.jsonl').events.concat(Ledger.parse(v1, 'checks.jsonl').events);
  assert.equal(Core.latestCheck(Ledger.derive(a), 'DEC-001').outcome, 'pass');

  const legacy2 = JSON.stringify({ kind: 'check', by: 'pipeline', decision: 'DEC-001', check: 'x', outcome: 'fail', source: 'pipeline', ts: 2000 });
  const v1b = JSON.stringify({ kind: 'check', by: 'u', decision: 'DEC-001', check: 'x', outcome: 'pass', source: 'local', schema_version: 1, event_id: 'e1', ts: 1000 });
  const b = Ledger.parse(legacy2, 'pipeline.jsonl').events.concat(Ledger.parse(v1b, 'checks.jsonl').events);
  assert.equal(Core.latestCheck(Ledger.derive(b), 'DEC-001').outcome, 'fail');
});

const gateEv = { kind: 'gate', by: 'u', source: 'local', revision: 'r-3f9a1c2e', ready: false, verdict: 'a1b2c3d4e5f60718',
  clauses: [{ kind: 'finding', text: 'DC002 on Quotes DB is neither fixed nor accepted' }],
  findings: [{ code: 'DC002', sev: 'error', on: 'Quotes DB', loc: 'element', unknown: false, suppressed: false }] };

test('a gate event validates, with or without git fields, and goes to checks.jsonl', () => {
  assert.deepEqual(Ledger.validate(gateEv), []);
  assert.deepEqual(Ledger.validate({ ...gateEv, commit: 'a'.repeat(40), dirty: false }), []);
  assert.deepEqual(Ledger.validate({ ...gateEv, commit: null }), []);
  assert.equal(Ledger.KINDS.gate.stream, 'checks.jsonl');
});

test('a gate event is rejected when a field is missing, mistyped or out of its enum', () => {
  const { verdict, ...noVerdict } = gateEv;
  assert.ok(Ledger.validate(noVerdict).some(e => /gate\.verdict: required/.test(e)));
  assert.ok(Ledger.validate({ ...gateEv, source: 'ci' }).some(e => /gate\.source: must be one of local\|pipeline/.test(e)));
  assert.ok(Ledger.validate({ ...gateEv, ready: 'yes' }).some(e => /gate\.ready: must be a boolean/.test(e)));
  assert.ok(Ledger.validate({ ...gateEv, findings: {} }).some(e => /gate\.findings: must be an array/.test(e)));
  assert.ok(Ledger.validate({ ...gateEv, dirty: 'no' }).some(e => /gate\.dirty: must be a boolean/.test(e)));
});

test('a handover event may carry commit and dirty', () => {
  const h = { kind: 'handover', by: 'u', handover: '20261003-ab12cd34', revision: 'r-ab12cd34' };
  assert.deepEqual(Ledger.validate(h), []);
  assert.deepEqual(Ledger.validate({ ...h, commit: 'b'.repeat(40), dirty: false }), []);
  assert.deepEqual(Ledger.validate({ ...h, commit: null }), []);
  assert.ok(Ledger.validate({ ...h, dirty: 1 }).some(e => /handover\.dirty: must be a boolean/.test(e)));
});

test('python/designc/ledger_schema.json is generated from this schema and up to date', () => {
  const { build, FILE } = require('./helpers/ledger-schema.js');
  assert.equal(fs.readFileSync(FILE, 'utf8'), build(), 'stale: run node test/helpers/ledger-schema.js --write');
});

// item_budget and item_judge: pipeline kinds written by System 2 (docs/pipeline-contract.md).
test('item_budget: within needs only item and status; exceeded and waiting need both token numbers', () => {
  const b = { kind: 'item_budget', by: 'p', item: 'W-a', status: 'within' };
  assert.deepEqual(Ledger.validate(b), []);
  assert.deepEqual(Ledger.validate({ ...b, limit_tokens: 1000, spent_tokens: 200, reason: 'ok' }), []);
  assert.ok(Ledger.validate({ ...b, status: 'exceeded' }).some(e => /item_budget\.limit_tokens: required when status is not 'within'/.test(e)));
  assert.ok(Ledger.validate({ ...b, status: 'waiting', limit_tokens: 10 }).some(e => /spent_tokens/.test(e)));
  assert.deepEqual(Ledger.validate({ ...b, status: 'exceeded', limit_tokens: 10, spent_tokens: 12 }), []);
  assert.ok(Ledger.validate({ ...b, status: 'over' }).length);
  assert.ok(Ledger.validate({ ...b, limit_tokens: 1.5 }).some(e => /limit_tokens: must be a whole number/.test(e)));
});

test('item_judge: score, threshold, outcome and commit are required; commit may be null', () => {
  const j = { kind: 'item_judge', by: 'p', item: 'W-a', judge: 'tone', score: 0.7, threshold: 0.8, outcome: 'fail', commit: null };
  assert.deepEqual(Ledger.validate(j), []);
  assert.deepEqual(Ledger.validate({ ...j, commit: 'b'.repeat(40), judge_version: 'v2', rubric_hash: 'abc', trace_id: 't1' }), []);
  assert.ok(Ledger.validate({ ...j, outcome: 'maybe' }).length);
  assert.ok(Ledger.validate({ ...j, score: '0.7' }).length);
  const { commit, ...noCommit } = j;
  assert.ok(Ledger.validate(noCommit).some(e => /commit/.test(e)));
});

test('item_budget and item_judge are pipeline kinds and route to pipeline.jsonl', () => {
  for (const k of ['item_budget', 'item_judge']) {
    assert.ok(Ledger.PIPELINE_KINDS.includes(k));
    assert.equal(Ledger.KINDS[k].stream, 'pipeline.jsonl');
  }
});

// parity_result: a pipeline kind (docs/parity-contract.md), judged the same in Python.
test('parity_result: outcome is pass, fail or could_not_run; failures are bounded and shaped', () => {
  const r = { kind: 'parity_result', by: 'p', scenario: 'tags-sort', commit: 'c'.repeat(40), outcome: 'pass', failures: [] };
  assert.deepEqual(Ledger.validate(r), []);
  assert.deepEqual(Ledger.validate({ ...r, commit: null, outcome: 'could_not_run', item: 'W-a', report: 'parity/reports/x.json' }), []);
  const f = { step: 2, key: 'button:Change', kind: 'text', msg: 'button "Edit" reads "Change"' };
  assert.deepEqual(Ledger.validate({ ...r, outcome: 'fail', failures: [f] }), []);
  assert.ok(Ledger.validate({ ...r, outcome: 'fail' }).some(e => /name at least one/.test(e)));
  assert.ok(Ledger.validate({ ...r, outcome: 'maybe' }).length);
  assert.ok(Ledger.validate({ ...r, outcome: 'fail', failures: [{ ...f, step: '2' }] }).some(e => /failures\[0\]/.test(e)));
  assert.ok(Ledger.validate({ ...r, outcome: 'fail', failures: Array(51).fill(f) }).some(e => /at most 50/.test(e)));
  assert.ok(Ledger.PIPELINE_KINDS.includes('parity_result'));
  assert.equal(Ledger.KINDS.parity_result.stream, 'pipeline.jsonl');
});

test('parity_result: Python judges the same lines the same way', () => {
  const { execFileSync } = require('node:child_process');
  const f = { step: 1, key: 'k', kind: 'text', msg: 'm' };
  const base = { schema_version: 1, event_id: 'e', ts: 1, kind: 'parity_result', by: 'p', scenario: 's', commit: null };
  const lines = [
    { ...base, outcome: 'pass', failures: [] },
    { ...base, outcome: 'fail', failures: [] },
    { ...base, outcome: 'fail', failures: [{ ...f, step: 1.5 }] },
    { ...base, outcome: 'fail', failures: Array(51).fill(f) },
    { ...base, outcome: 'fail', failures: [f] },
  ];
  const py = 'import json,sys; from designc import ledger; print(json.dumps([len(ledger.validate(json.loads(l))) > 0 for l in sys.stdin.read().splitlines()]))';
  const out = JSON.parse(execFileSync('python3', ['-c', py], { cwd: require('node:path').join(__dirname, '..', 'python'), input: lines.map(l => JSON.stringify(l)).join('\n') }).toString());
  assert.deepEqual(out, lines.map(l => Ledger.validate(l).length > 0));
  assert.deepEqual(out, [false, true, true, true, false]);
});
