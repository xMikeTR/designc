// S4 A and C: approval is a UI action that stores the note's content hash and a ledger row; an edit voids it. A corrected agent
// note cannot be approved until the correction is a principle in the model or a lint rule proposal. All pure.
const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');
const Landing = require('../renderer/landing.js');

const DSL = `workspace "T" { model {
 s = softwareSystem "S" {
  api = container "Api" "" ".NET" {
    orders = component "Orders"
  }
  db = container "Db" "" "SQL" "Database"
 }
 orders -> db "w" "SQL" { properties { "d.interaction" "sync" } }
}}`;
const model = Core.parse(DSL);
const idx = Landing.buildIndex(model, {});
const BASE = { requirement: 'R-1', author: 'human', status: 'proposed', entry: { kind: 'action', node: 'Api' }, path: [{ stage: 'api', node: 'Api' }], changes: [{ node: 'Api/Orders', what: 'filter' }], principle: null, proposed: {}, correction: {}, approved: {} };
const AGENT = { ...BASE, author: 'agent', proposed: { entry: BASE.entry, path: BASE.path, changes: BASE.changes, principle: null } };
const ctx = (over = {}) => ({ by: 'mike', at: '2026-11-23T10:00:00Z', mapCommit: null, effects: { callers: 0, readers: 1, consumers: 0, unknown: 0 }, ...over });
const FILE = 'landings/R-1.yaml';
const saved = rec => yaml.dump(rec, { lineWidth: -1, noRefs: true });
function approveIt(rec, over = {}) {
  const text = saved(rec);
  return Landing.prepareApprove({ rec, loadedText: text, currentText: text, yaml, file: FILE, ...ctx(), model, proposals: [], ...over });
}

test('contentHash is stable under key order and ignores author, status and approved', () => {
  const a = Landing.contentHash(BASE);
  const shuffled = { changes: BASE.changes, path: [{ node: 'Api', stage: 'api' }], requirement: 'R-1', entry: { node: 'Api', kind: 'action' } };
  assert.equal(Landing.contentHash(shuffled), a, 'missing optional parts count as empty');
  assert.equal(Landing.contentHash({ ...BASE, author: 'agent', status: 'approved', approved: { by: 'x' } }), a);
  assert.notEqual(Landing.contentHash({ ...BASE, changes: [{ node: 'Api/Orders', what: 'other' }] }), a);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('approve: the file says approved with the hash, the ledger row matches, approvalState says approved', () => {
  const r = approveIt(BASE);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.path, FILE);
  assert.equal(r.record.status, 'approved');
  assert.deepEqual(Object.keys(r.record.approved).sort(), ['at', 'by', 'effects', 'hash', 'map_commit']);
  assert.equal(r.record.approved.hash, Landing.contentHash(BASE));
  assert.equal(r.record.approved.map_commit, null);
  assert.deepEqual(r.ledgerRow, { requirement: 'R-1', hash: r.record.approved.hash, author: 'human', corrected: false });
  const row = { kind: 'landing_approved', ...r.ledgerRow };
  assert.deepEqual(Landing.approvalState(r.record, [row]), { state: 'approved', reason: null });
  assert.deepEqual(yaml.load(r.text), r.record);
});

test('approve refuses a note that is not saved, or changed on disk', () => {
  const text = saved(BASE);
  assert.equal(Landing.prepareApprove({ rec: BASE, loadedText: null, currentText: null, yaml, file: null, ...ctx(), model, proposals: [] }).ok, false);
  assert.equal(approveIt(BASE, { currentText: text + '# x\n' }).ok, false);
  assert.equal(approveIt({ ...BASE, requirement: '../x' }).ok, false, 'invalid note');
});

test('an edit after approval returns the note to proposed, edited after approval', () => {
  const r = approveIt(BASE), row = { kind: 'landing_approved', ...r.ledgerRow };
  const edited = Landing.addChange(r.record, 'Api', 'one more');
  assert.equal(edited.status, 'proposed');
  assert.deepEqual(edited.approved, {});
  // the file as a person might hand-edit it: content changed, status and approved left as they were
  const hand = { ...r.record, changes: [...r.record.changes, { node: 'Api', what: 'sneaky' }] };
  assert.deepEqual(Landing.approvalState(hand, [row]), { state: 'proposed', reason: 'edited after approval' });
});

test('a hand-written approved note with a correct hash but no ledger row is not approved', () => {
  const r = approveIt(BASE);
  assert.deepEqual(Landing.approvalState(r.record, []), { state: 'proposed', reason: 'no approval recorded' });
  assert.deepEqual(Landing.approvalState(r.record, [{ kind: 'landing_approved', requirement: 'R-2', hash: r.record.approved.hash }]), { state: 'proposed', reason: 'no approval recorded' });
});

test('a ledger row with another hash does not approve it', () => {
  const r = approveIt(BASE);
  assert.deepEqual(Landing.approvalState(r.record, [{ kind: 'landing_approved', requirement: 'R-1', hash: 'f'.repeat(64) }]), { state: 'proposed', reason: 'no approval recorded' });
});

test('a proposed note is proposed with no reason; statusText takes the ledger', () => {
  assert.deepEqual(Landing.approvalState(BASE, []), { state: 'proposed', reason: null });
  const r = approveIt(BASE), row = { kind: 'landing_approved', ...r.ledgerRow };
  assert.equal(Landing.statusText(r.record, [row]), 'human, approved');
  assert.match(Landing.statusText(r.record, []), /proposed \(no approval recorded\)/);
  assert.doesNotMatch(Landing.statusText(r.record, []), /approval not verified/);
});

// ---------- correction ----------
test('corrected: proposed non-empty and different from the current content', () => {
  assert.equal(Landing.corrected(BASE), false, 'no proposed');
  assert.equal(Landing.corrected(AGENT), false, 'same as proposed');
  const human = Landing.correct(AGENT);
  assert.equal(human.author, 'human');
  assert.deepEqual(human.proposed, AGENT.proposed, 'proposed is kept');
  assert.equal(Landing.corrected(human), false, 'a fresh copy is not yet corrected');
  const moved = Landing.addChange(human, 'Api', 'one step over');
  assert.equal(Landing.corrected(moved), true);
});

test('correct keeps proposed if set, and fills it from the agent content when not', () => {
  const noProposed = Landing.correct({ ...AGENT, proposed: {} });
  assert.deepEqual(noProposed.proposed, { entry: AGENT.entry, path: AGENT.path, changes: AGENT.changes, principle: null });
  const keep = Landing.correct({ ...AGENT, proposed: { entry: null, path: [], changes: [], principle: null } });
  assert.deepEqual(keep.proposed.changes, [], 'an existing proposed is not overwritten');
});

function corrected() { return Landing.addChange(Landing.correct(AGENT), 'Api', 'one step over'); }

test('a corrected note cannot be approved without a correction', () => {
  const rec = corrected();
  const r = approveIt(rec);
  assert.equal(r.ok, false);
  assert.match(r.error, /correction/);
  assert.equal(Landing.approvable(rec, { model, proposals: [] }).ok, false);
});

test('a principle correction is invalid until the model has the principle on that element', () => {
  const rec = { ...corrected(), correction: { principle: { prop: 'd.api', element: 'S' } } };
  assert.equal(approveIt(rec).ok, false, 'the model has no d.api on S');
  const m2 = Core.parse(DSL.replace('s = softwareSystem "S" {', 's = softwareSystem "S" {\n  properties { "d.api" "api-first" }'));
  const ok = approveIt(rec, { model: m2 });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.ledgerRow.corrected, true);
  assert.deepEqual(ok.ledgerRow.correction, { principle: { prop: 'd.api', element: 'S' } });
  // inherited from the parent counts: Orders inherits d.api from S
  assert.equal(approveIt({ ...rec, correction: { principle: { prop: 'd.api', element: 'Orders' } } }, { model: m2 }).ok, true);
  assert.equal(approveIt({ ...rec, correction: { principle: { prop: 'd.zone', element: 'S' } } }, { model: m2 }).ok, false, 'only d.style, d.api, d.ui');
  assert.equal(approveIt({ ...rec, correction: { principle: { prop: 'd.api', element: 'Nope' } } }, { model: m2 }).ok, false);
});

test('a proposal correction needs proposals/<id>.yaml of kind lint rule', () => {
  const rec = { ...corrected(), correction: { proposal: 'move-it' } };
  assert.equal(approveIt(rec).ok, false);
  assert.equal(approveIt(rec, { proposals: [{ id: 'move-it', kind: 'P property' }] }).ok, false);
  const ok = approveIt(rec, { proposals: [{ id: 'move-it', kind: 'lint rule' }] });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.ledgerRow.correction, { proposal: 'move-it' });
});

test('draftProposal: a lint rule from the diff, same shape as mint_proposal, with a fresh id', () => {
  const rec = corrected();
  const d = Landing.draftProposal(rec, { taken: [] });
  assert.match(d.id, /^[a-z0-9-]+$/);
  assert.equal(d.path, `proposals/${d.id}.yaml`);
  const o = yaml.load(d.text);
  assert.equal(o.id, d.id); assert.equal(o.status, 'minted'); assert.equal(o.kind, 'lint rule'); assert.equal(o.check, 'TODO'); assert.equal(o.drafted_by, 'designc');
  assert.match(o.statement, /R-1/); assert.match(o.evidence, /one step over/);
  assert.notEqual(Landing.draftProposal(rec, { taken: [d.id] }).id, d.id);
  assert.equal(Landing.draftProposal(AGENT, { taken: [] }), null, 'nothing to draft from an uncorrected note');
});

test('an uncorrected agent note approves without a correction; the ledger row carries author agent and corrected false', () => {
  const r = approveIt(AGENT);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.ledgerRow, { requirement: 'R-1', hash: Landing.contentHash(AGENT), author: 'agent', corrected: false });
  assert.equal(r.record.author, 'agent');
});

test('effects counts in the approval are counts of the effects result', () => {
  const e = Landing.effects(idx, model, BASE);
  assert.deepEqual(Landing.effectCounts(e), { callers: e.callers.length, readers: e.readers.length, consumers: e.consumers.length, unknown: e.unknown.length });
});
