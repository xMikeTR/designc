const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Ledger = require('../renderer/ledger.js');
const Core = require('../renderer/core.js');
const store = require('../ledger-store.js');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-harness-')); }

const HARNESS_15 = [
  'SessionStarted', 'SessionEnded', 'ContextCompiled', 'ProposalMade', 'GatePassed',
  'GateFailed', 'NeedsDecision', 'ActionExecuted', 'ActionErrored', 'VerifyResult',
  'BudgetExceeded', 'HumanDecision', 'Done', 'NoteRecorded', 'WorkRecorded',
];

test('harness kinds match event.py and are disjoint from designc kinds', () => {
  assert.deepEqual(Ledger.HARNESS_KINDS.slice().sort(), HARNESS_15.slice().sort());
  for (const k of Ledger.HARNESS_KINDS) assert.equal(Ledger.KINDS[k], undefined);
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const eventPy = path.join(home, '.claude', 'harness', 'event.py');
  if (fs.existsSync(eventPy)) {
    const text = fs.readFileSync(eventPy, 'utf8');
    const found = new Set([...text.matchAll(/^[A-Z_]+\s*=\s*"([A-Za-z]+)"/gm)].map(m => m[1]));
    for (const k of Ledger.HARNESS_KINDS) assert.ok(found.has(k), `event.py should define ${k}`);
  }
});

test('a harness record is stamped, null-filled, key-sorted and routed to sessions.jsonl', async () => {
  const root = tmpRoot();
  const ev = { kind: 'NeedsDecision', project: 'p', session_id: 'iv-1', payload: { interview: 'iv-1', subject: 'finding:DC003:a', stage: 'S1-grill', question: 'q?' } };
  const r = await store.appendEvent(root, ev, { uuid: () => 'u-2', now: () => Date.UTC(2026, 8, 26, 10, 0, 0) });
  assert.equal(r.ok, true);
  const dir = path.join(root, 'ledger');
  assert.deepEqual(fs.readdirSync(dir), ['sessions.jsonl']);
  const line = fs.readFileSync(path.join(dir, 'sessions.jsonl'), 'utf8').trim();
  const parsed = JSON.parse(line);
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(parsed));
  assert.deepEqual(Object.keys(parsed).sort(), Ledger.HARNESS_FIELDS.slice().sort());
  assert.equal(parsed.envelope_version, 1);
  assert.equal(parsed.event_id, 'u-2');
  assert.equal(parsed.ts, '2026-09-26T10:00:00+00:00');
  for (const f of ['pack_id', 'pack_version', 'harness_version', 'image_digest', 'snapshot_hash', 'parent_session_id', 'agent_id', 'acting_as']) assert.equal(parsed[f], null);
  assert.deepEqual(parsed.payload, ev.payload);
});

test('invalid harness records are rejected as event.py would, and nothing is written', async () => {
  const base = { kind: 'NeedsDecision', project: 'p', session_id: 's1', payload: { question: 'q?' } };
  const cases = [
    { ...base, kind: 'needs_decision', envelope_version: 1 },
    { ...base, schema_version: 1 },
    { ...base, project: '' },
    { ...base, session_id: undefined },
    { ...base, payload: 'x' },
    { ...base, question: 'q?' },
    { ...base, envelope_version: 2 },
    { ...base, ts: 'yesterday' },
    { kind: 'GateFailed', project: 'p', session_id: 's1', payload: {} },
    { kind: 'VerifyResult', project: 'p', session_id: 's1', payload: { verdict: 'FAIL', verify_failures: [] } },
    { kind: 'VerifyResult', project: 'p', session_id: 's1', payload: { verdict: 'pass', exit_code: 2 } },
  ];
  for (const ev of cases) {
    const root = tmpRoot();
    const r = await store.appendEvent(root, ev);
    assert.equal(r.ok, false, JSON.stringify(ev));
    assert.ok(r.errors.length);
    assert.equal(fs.existsSync(path.join(root, 'ledger')), false);
  }
  const accepted = [
    { kind: 'GateFailed', project: 'p', session_id: 's1', payload: { reason_unavailable: 'migrated' } },
    { kind: 'VerifyResult', project: 'p', session_id: 's1', payload: { verdict: 'pass', exit_code: 0 } },
  ];
  for (const ev of accepted) {
    const root = tmpRoot();
    const r = await store.appendEvent(root, ev);
    assert.equal(r.ok, true, JSON.stringify(ev));
  }
});

test('parse dispatches on the version key and sets _ts on both envelopes', () => {
  const lines = [
    JSON.stringify({ kind: 'check', by: 'u', decision: 'DEC-001', check: 'x', outcome: 'pass', source: 'local', ts: 1000 }),
    JSON.stringify({ kind: 'SessionStarted', envelope_version: 1, project: 'p', session_id: 's1', event_id: 'e1', ts: '2026-09-26T10:00:00+00:00', parent_session_id: null, agent_id: null, acting_as: null, pack_id: null, pack_version: null, harness_version: null, image_digest: null, snapshot_hash: null, payload: {} }),
    JSON.stringify({ kind: 'check', by: 'u', decision: 'DEC-001', check: 'x', outcome: 'pass', source: 'local', schema_version: 1, envelope_version: 1 }),
    JSON.stringify({ kind: 'SessionStarted', envelope_version: 2, project: 'p', session_id: 's1', payload: {} }),
  ];
  const { events, errors } = Ledger.parse(lines.join('\n'), 'sessions.jsonl');
  assert.equal(events.length, 2);
  assert.equal(events[0]._ts, 1000);
  assert.equal(events[1]._ts, 1790416800000);
  assert.equal(errors.length, 2);
  assert.match(errors[0].msg, /both schema_version and envelope_version/);
  assert.match(errors[1].msg, /unknown envelope_version 2/);
});

test('only pipeline needs_decision blocks the gate; grill NeedsDecision resolves by HumanDecision', () => {
  const nd = { kind: 'needs_decision', by: 'pipeline', id: 'ND-0001', question: 'q?', status: 'open', schema_version: 1, event_id: 'nd1', ts: 1 };
  const e1 = { kind: 'NeedsDecision', envelope_version: 1, project: 'p', session_id: 's1', event_id: 'E1', ts: '2026-09-26T10:00:00+00:00', payload: {} };
  const derived = Ledger.derive([nd, e1]);
  assert.deepEqual(derived, [nd, e1]);
  const gate1 = Core.gate({ model: { errors: [] }, diags: [], decisions: [], requirements: [], ledger: derived });
  assert.equal(gate1.clauses.filter(c => c.kind === 'needs').length, 1);
  assert.equal(gate1.clauses.find(c => c.kind === 'needs').needs.id, 'ND-0001');

  const resolved = { kind: 'needs_decision_resolved', by: 'u', id: 'ND-0001', schema_version: 1, event_id: 'r1', ts: 2 };
  const derived2 = Ledger.derive([nd, e1, resolved]);
  const gate2 = Core.gate({ model: { errors: [] }, diags: [], decisions: [], requirements: [], ledger: derived2 });
  assert.equal(gate2.clauses.filter(c => c.kind === 'needs').length, 0);

  const hd = { kind: 'HumanDecision', envelope_version: 1, project: 'p', session_id: 's1', event_id: 'HD1', ts: '2026-09-26T11:00:00+00:00', payload: { cites_event_id: 'E1', outcome: 'answer' } };
  assert.ok(Ledger.resolvedEventIds([e1, hd]).has('E1'));
  assert.deepEqual(Ledger.derive([e1, hd]), [e1, hd]);
});

test('latestCheck orders by _ts', () => {
  const pass = { kind: 'check', by: 'u', decision: 'DEC-001', check: 'x', outcome: 'pass', source: 'local', _ts: 2000 };
  const fail = { kind: 'check', by: 'u', decision: 'DEC-001', check: 'x', outcome: 'fail', source: 'local', exit_code: 1, _ts: 1000 };
  assert.equal(Core.latestCheck([pass, fail], 'DEC-001').outcome, 'pass');
  assert.equal(Core.latestCheck([fail, pass], 'DEC-001').outcome, 'pass');
  const noTs = { kind: 'check', by: 'u', decision: 'DEC-001', check: 'x', outcome: 'fail', source: 'local', exit_code: 1 };
  assert.equal(Core.latestCheck([noTs, fail], 'DEC-001'), fail);
});
