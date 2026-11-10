// Health overlay: the five-status rule as a pure function of claim, evidence and the current state of the element's paths.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../renderer/health-status.js');

const unchanged = () => false;                       // nothing under the element's paths changed since any commit
const changedAfter = c => commit => commit !== c;    // only evidence made at commit `c` is fresh
const staticEv = (result, extra) => ({ kind: 'static', by: 'review-skill', result, commit: 'a1', ...extra });
const checkEv = (result, extra) => ({ kind: 'check', by: 'T.SameRequestTwice', result, commit: 'a1', ...extra });

test('unknown: no claim and no evidence', () => {
  assert.equal(H.compute({ claim: false, evidence: [], changedSince: unchanged }), H.UNKNOWN);
  assert.equal(H.compute({}), H.UNKNOWN);
});

test('inferred: no claim, static evidence exists, whichever way it points', () => {
  assert.equal(H.compute({ claim: false, evidence: [staticEv('supports')], changedSince: unchanged }), H.INFERRED);
  assert.equal(H.compute({ claim: false, evidence: [staticEv('contradicts')], changedSince: unchanged }), H.INFERRED);
});

test('inference never promotes itself: no claim means never declared or verified, even with a passing check', () => {
  const s = H.compute({ claim: false, evidence: [checkEv('pass')], changedSince: unchanged });
  assert.equal(s, H.UNKNOWN); // a check is not static evidence, and nothing claims the property
});

test('declared: claim in the model, no passing check', () => {
  assert.equal(H.compute({ claim: true, evidence: [], changedSince: unchanged }), H.DECLARED);
  assert.equal(H.compute({ claim: true, evidence: [staticEv('supports')], changedSince: unchanged }), H.DECLARED);
});

test('an agent reading the code stays inferred/declared however it is worded: static evidence alone never verifies', () => {
  assert.equal(H.compute({ claim: true, evidence: [staticEv('supports'), staticEv('supports')], changedSince: unchanged }), H.DECLARED);
});

test('verified: claim plus a check that passes at a commit whose paths have not changed', () => {
  assert.equal(H.compute({ claim: true, evidence: [checkEv('pass')], changedSince: unchanged }), H.VERIFIED);
});

test('violated: claim plus a failing fresh check', () => {
  assert.equal(H.compute({ claim: true, evidence: [checkEv('fail')], changedSince: unchanged }), H.VIOLATED);
});

test('violated: claim plus contradicting static evidence', () => {
  assert.equal(H.compute({ claim: true, evidence: [staticEv('contradicts')], changedSince: unchanged }), H.VIOLATED);
});

test('violated beats verified: one failing check outweighs a passing one', () => {
  const ev = [checkEv('pass'), checkEv('fail', { by: 'T.Other' })];
  assert.equal(H.compute({ claim: true, evidence: ev, changedSince: unchanged }), H.VIOLATED);
});

test('stale: verified falls back to declared when files under the paths changed after the evidence commit', () => {
  assert.equal(H.compute({ claim: true, evidence: [checkEv('pass')], changedSince: changedAfter('a1') }), H.VERIFIED);
  assert.equal(H.compute({ claim: true, evidence: [checkEv('pass')], changedSince: changedAfter('b2') }), H.DECLARED);
});

test('stale: a failing check at an old commit does not call the current code violated', () => {
  assert.equal(H.compute({ claim: true, evidence: [checkEv('fail')], changedSince: changedAfter('b2') }), H.DECLARED);
});

test('stale: a fresh pass is not undone by a stale fail, and a fresh fail is not undone by a stale pass', () => {
  const stalePass = checkEv('pass', { commit: 'old' }), freshFail = checkEv('fail', { commit: 'new', by: 'T.B' });
  assert.equal(H.compute({ claim: true, evidence: [stalePass, freshFail], changedSince: changedAfter('new') }), H.VIOLATED);
  const staleFail = checkEv('fail', { commit: 'old' }), freshPass = checkEv('pass', { commit: 'new', by: 'T.B' });
  assert.equal(H.compute({ claim: true, evidence: [staleFail, freshPass], changedSince: changedAfter('new') }), H.VERIFIED);
});

test('evidence with no commit, or no way to ask what changed, cannot verify: it counts as stale', () => {
  assert.equal(H.compute({ claim: true, evidence: [checkEv('pass', { commit: undefined })], changedSince: unchanged }), H.DECLARED);
  assert.equal(H.compute({ claim: true, evidence: [checkEv('pass')] }), H.DECLARED);
  assert.equal(H.compute({ claim: true, evidence: [checkEv('pass')], changedSince: () => undefined }), H.DECLARED);
});

test('not applicable: left off the map whatever else is there', () => {
  assert.equal(H.compute({ claim: true, applicable: false, evidence: [checkEv('pass')], changedSince: unchanged }), H.NOT_APPLICABLE);
});

test('evidence the schema does not allow is ignored, never guessed at', () => {
  const junk = [{ kind: 'check', result: 'supports', commit: 'a1' }, { kind: 'static', result: 'pass' }, { kind: 'mystery', result: 'fail' }, null];
  assert.equal(H.compute({ claim: true, evidence: junk, changedSince: unchanged }), H.DECLARED);
  assert.equal(H.compute({ claim: true, evidence: 'not a list', changedSince: unchanged }), H.DECLARED);
});

test('unverified: the headline number counts applicable properties that are not verified', () => {
  const s = [H.VERIFIED, H.DECLARED, H.UNKNOWN, H.VIOLATED, H.INFERRED, H.NOT_APPLICABLE];
  assert.equal(H.unverified(s), 4);
  assert.equal(H.unverified([]), 0);
});
