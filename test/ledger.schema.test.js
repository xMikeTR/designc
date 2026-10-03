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
