// S5 R: `review: landing` is satisfied by an approved, unchanged landing of every requirement of the item (D7). Pure.
const test = require('node:test');
const assert = require('node:assert/strict');
const Work = require('../renderer/work.js');

const item = (over = {}) => ({ id: 'W-1', requirement: ['RE-1', 'RE-2'], elements: ['A'], done_when: [{ review: 'landing' }], ...over });
const H = 'a'.repeat(64);
const RUN = { commit: 'abc1234', onMain: true };
const dp = (it, o = {}) => Work.doneProblems(it, { ...RUN, ...o });

test('default (no landings option): review landing needs its tick, with today\'s sentence only', () => {
  assert.deepEqual(dp(item()), ['Review by: landing is not ticked.']);
  assert.deepEqual(dp(item(), { landings: {} }), ['Review by: landing is not ticked. Not approved: RE-1, RE-2.']);
  assert.deepEqual(dp(item(), { ticks: ['review:landing'] }), []);
});

test('every requirement has an approved landing: satisfied with no tick', () => {
  assert.deepEqual(dp(item(), { landings: { 'RE-1': H, 'RE-2': H } }), []);
});

test('one of two requirements unapproved: the problem names it and why', () => {
  assert.deepEqual(dp(item(), { landings: { 'RE-1': H }, landingWhy: { 'RE-2': 'edited after approval' } }),
    ['Review by: landing is not ticked. Not approved: RE-2 (edited after approval).']);
  assert.deepEqual(dp(item(), { landings: {}, landingWhy: { 'RE-1': 'no approval recorded' } }),
    ['Review by: landing is not ticked. Not approved: RE-1 (no approval recorded), RE-2.']);
});

test('a tick still satisfies it when a landing is missing', () => {
  assert.deepEqual(dp(item(), { landings: { 'RE-1': H }, ticks: ['review:landing'] }), []);
});

test('other reviews and checklists are unaffected by landings; so is an item with no requirement', () => {
  const it = item({ done_when: [{ review: 'alice' }, { checklist: 'landing' }] });
  assert.deepEqual(dp(it, { landings: { 'RE-1': H, 'RE-2': H } }), ['Review by: alice is not ticked.', 'Checklist: landing is not ticked.']);
  assert.deepEqual(dp(item({ requirement: undefined }), { landings: { 'RE-1': H } }), ['Review by: landing is not ticked.']);
  assert.deepEqual(dp(item({ done_when: [{ review: ' landing ' }] }), { landings: { 'RE-1': H, 'RE-2': H } }), []);
});

test('landingEvidence: landing:<requirement>@<first 12 of hash> per requirement', () => {
  assert.deepEqual(Work.landingEvidence(item(), { 'RE-1': 'abcdef0123456789' + 'f'.repeat(48), 'RE-2': H }), ['landing:RE-1@abcdef012345', `landing:RE-2@${'a'.repeat(12)}`]);
});
