const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const yaml = require('js-yaml');
const Policy = require('../renderer/policy.js');

const model = Core.parse('workspace {\n model {\n  a = softwareSystem "A"\n }\n}');
const reqs = [{ id: 'HRE-1', title: 't', version: 3, elements: ['A'] }];
const ledger = id => [{ kind: 'check', decision: id, outcome: 'pass', _ts: 1 }];
const biz = (o = {}) => ({ id: 'b1', status: 'bound', kind: 'business', requirement: 'HRE-1', checks: [], binds: [], evidence: 'https://wiki.example.com/p/1',
  promoted_against: [{ requirement: 'HRE-1', version: 3 }], ...o });
const tech = (o = {}) => ({ id: 't1', status: 'bound', kind: 'technical', effect: 'accept', checks: ['x'], binds: [], resolves: [], promoted_against: [], relies_on: ['b1'], ...o });
const gate = (decisions, o = {}) => Core.gate({ model, diags: [], decisions, requirements: reqs, ledger: [...ledger('t1')], evidenceHosts: ['wiki.example.com'], ...o });
const texts = g => g.clauses.map(c => c.text);

test('a sound business decision plus a technical accept relying on it is ready', () => {
  assert.deepEqual(texts(gate([biz(), tech()])), []);
});

test('business decision: no check needed, but evidence is mandatory and must be https on an allowed host', () => {
  assert.deepEqual(texts(gate([biz()])), []);
  assert.deepEqual(texts(gate([biz({ evidence: undefined })])), ['b1 is a business decision without evidence']);
  assert.match(texts(gate([biz({ evidence: 'http://wiki.example.com/p' })]))[0], /b1: evidence must be an https URL/);
  assert.match(texts(gate([biz({ evidence: 'https://evil.example.org/p' })]))[0], /b1: evidence host evil\.example\.org is not allowed/);
  assert.match(texts(gate([biz()], { evidenceHosts: [] }))[0], /not allowed/);
});

test('business decision is promoted against its requirement version', () => {
  assert.match(texts(gate([biz({ promoted_against: [{ requirement: 'HRE-1', version: 2 }] })]))[0], /b1: HRE-1 changed since promotion/);
  assert.match(texts(gate([biz({ promoted_against: [{ requirement: 'HRE-9', version: 1 }] })]))[0], /b1: binding HRE-9 does not resolve/);
  assert.match(texts(gate([biz({ promoted_against: undefined })]))[0], /b1 is bound without a fingerprint/);
});

test('technical accept must rely on a bound business decision', () => {
  assert.match(texts(gate([biz(), tech({ relies_on: [] })])).join('|'), /t1 accepts a risk without a bound business decision/);
  assert.match(texts(gate([biz(), tech({ relies_on: ['nope'] })])).join('|'), /t1 accepts a risk without a bound business decision/);
  assert.match(texts(gate([biz({ status: 'minted' }), tech()])).join('|'), /t1 accepts a risk without a bound business decision/);
  assert.match(texts(gate([tech({ relies_on: ['t2'] }), tech({ id: 't2' })])).join('|'), /without a bound business decision/);
  assert.equal(texts(gate([biz(), tech({ effect: 'fix', relies_on: [], resolves: [] })])).filter(t => /business decision/.test(t)).length, 0);
});

test('a kind other than business or technical blocks; no kind means technical', () => {
  assert.match(texts(gate([biz(), tech({ kind: 'strategic' })])).join('|'), /t1 has kind strategic, expected business or technical/);
  assert.equal(texts(gate([biz(), tech({ kind: undefined })])).filter(t => /kind/.test(t)).length, 0);
});

const yl = c => Policy.writeVerdict('grill', 'decisions/a.yaml', c, yaml.load);
test('policy: agents never write agreed_by or evidence on a decision', () => {
  assert.match(yl('id: a\nstatus: minted\nkind: business\nagreed_by: [mike]\n').error || '', /human/);
  assert.match(yl('id: a\nstatus: minted\nkind: business\nevidence: https://x\n').error || '', /human/);
  assert.deepEqual(yl('id: a\nstatus: minted\nkind: business\nstatement: "PROPOSED: x"\n'), { ok: true });
});

test('a technical accept needs no check; a TODO placeholder is not a check; listed checks still count', () => {
  const noLedger = { ledger: [] };
  assert.deepEqual(texts(gate([biz(), tech({ checks: [] })], noLedger)), []);
  assert.deepEqual(texts(gate([biz(), tech({ checks: undefined })], noLedger)), []);
  assert.deepEqual(texts(gate([biz(), tech({ checks: ['TODO command that proves it'] })], noLedger)), []);
  assert.deepEqual(texts(gate([biz(), tech({ checks: ['x'] })], noLedger)), ['t1: no check result recorded yet']);
  assert.deepEqual(texts(gate([biz(), tech({ effect: 'fix', relies_on: [], checks: [] })], noLedger)), ['t1 has no check']);
});
