'use strict';
// Parity diff: the contract cases in docs/parity-cases.json, exceptions, and a scenario's outcome.
const test = require('node:test');
const assert = require('node:assert');
const Parity = require('../renderer/parity.js');
const cases = require('../docs/parity-cases.json');

const norm = (side, masks) => Parity.normalise(side.tree, { masks, expect: side.expect, viewport: side.viewport });

for (const c of cases.diff) {
  test(`diff case ${c.id}: ${c.about}`, () => {
    const { findings } = Parity.diff(norm(c.legacy, c.masks), norm(c.next, c.masks), { exceptions: Parity.exceptions(c.exceptions) });
    const got = findings.map(f => `${f.kind}/${f.severity}`).sort();
    assert.deepStrictEqual(got, c.findings.map(f => `${f.kind}/${f.severity}`).sort(), findings.map(f => f.msg).join('; '));
  });
}

test('every finding kind is a known kind, and the cases cover each kind', () => {
  const seen = new Set(cases.diff.flatMap(c => c.findings.map(f => f.kind)));
  for (const k of seen) assert.ok(Parity.KINDS.includes(k), k);
  for (const k of Parity.KINDS.filter(k => k !== 'step')) assert.ok(seen.has(k), `no case for ${k}`);
});

test('exceptions: acceptance locators add, only bound business decisions remove', () => {
  const exc = Parity.exceptions({
    acceptance: [{ id: 'AC-1', locators: { save: { role: 'button', name: 'Save all' }, bad: { role: 'button' } } }],
    decisions: [
      { id: 'drop-export', status: 'bound', kind: 'business', removes: [{ role: 'button', name: 'Export', screen: 'tags' }] },
      { id: 'minted-one', status: 'minted', kind: 'business', removes: [{ role: 'button', name: 'Refresh' }] },
      { id: 'tech', status: 'bound', removes: [{ role: 'button', name: 'Print' }] },
    ],
  });
  assert.deepStrictEqual(exc.added, [{ role: 'button', name: 'Save all', by: 'AC-1' }]);
  assert.deepStrictEqual(exc.removed, [{ role: 'button', name: 'Export', screen: 'tags', by: 'drop-export' }]);
  assert.deepStrictEqual(Parity.removesProblems({ id: 'tech', removes: [{ role: 'button', name: 'Print' }] }), ['tech: only a business decision can remove a legacy element']);
  assert.deepStrictEqual(Parity.removesProblems({ id: 'b', kind: 'business', removes: [{ role: 'button' }] }), ['b: removes entry 1 needs a role and a name']);
});

test('a removal is covered only on the screen the decision names', () => {
  const page = names => ({ viewport: null, elements: names.map(name => ({ key: `button:${name}`, role: 'button', name, enabled: true, children: [] })) });
  const exc = { added: [], removed: [{ role: 'button', name: 'Export', screen: 'tags', by: 'drop-export' }] };
  assert.strictEqual(Parity.diff(page(['Export']), page([]), { exceptions: exc, screen: 'tags' }).findings[0].severity, 'covered');
  assert.strictEqual(Parity.diff(page(['Export']), page([]), { exceptions: exc, screen: 'programs' }).findings[0].severity, 'fail');
});

const step = (n, status, elements = [], extra = {}) => ({ n, action: 'goto', status, viewport: null, elements, ...extra });
const btn = name => ({ key: `button:${name}`, role: 'button', name, enabled: true, children: [] });

test('compare: pass, fail, and could not run, which is never a failure', () => {
  const legacy = { scenario: 's', side: 'legacy', steps: [step(1, 'ok', [btn('Save')]), step(2, 'ok', [btn('Edit')])] };
  const same = Parity.compare({ scenario: { id: 's' }, legacy, next: { side: 'next', steps: [step(1, 'ok', [btn('Save')]), step(2, 'ok', [btn('Edit')])] } });
  assert.strictEqual(same.outcome, 'pass');
  const differs = Parity.compare({ scenario: { id: 's' }, legacy, next: { side: 'next', steps: [step(1, 'ok', [btn('Save')]), step(2, 'ok', [btn('Change')])] } });
  assert.strictEqual(differs.outcome, 'fail');
  assert.deepStrictEqual(Parity.failures(differs), [{ step: 2, key: 'button:Change', kind: 'text', msg: 'button "Edit" reads "Change"' }]);
  const notRun = Parity.compare({ scenario: { id: 's' }, legacy, next: { side: 'next', steps: [step(1, 'ok', [btn('Save')]), step(2, 'could_not_run', [], { reason: 'no button named "Edit"' })] } });
  assert.strictEqual(notRun.outcome, 'could_not_run');
  assert.strictEqual(notRun.steps[1].reason, 'new app: no button named "Edit"');
  const legacyOnly = Parity.compare({ scenario: { id: 's' }, legacy: { steps: [step(1, 'blocked', [], { reason: 'writes' })] }, next: { steps: [step(1, 'ok')] } });
  assert.strictEqual(legacyOnly.outcome, 'could_not_run');
});

test('compare: a step that ran on legacy but errored or was blocked on the new app fails', () => {
  const r = Parity.compare({ scenario: { id: 's' }, legacy: { steps: [step(1, 'ok')] }, next: { steps: [step(1, 'error', [], { reason: 'timeout' })] } });
  assert.strictEqual(r.outcome, 'fail');
  assert.strictEqual(r.steps[0].findings[0].kind, 'step');
});

test('a fail with every difference covered passes; failures are bounded for the ledger', () => {
  const exc = { added: [{ role: 'button', name: 'Share', by: 'AC-2' }], removed: [] };
  const r = Parity.compare({ scenario: { id: 's' }, legacy: { steps: [step(1, 'ok', [])] }, next: { steps: [step(1, 'ok', [btn('Share')])] }, exceptions: exc });
  assert.strictEqual(r.outcome, 'pass');
  assert.strictEqual(r.counts.covered, 1);
  const many = Parity.compare({ scenario: { id: 's' }, legacy: { steps: [step(1, 'ok', [])] }, next: { steps: [step(1, 'ok', Array.from({ length: 60 }, (_, i) => btn(`B${i}`)))] } });
  const ev = Parity.resultEvent(many, { commit: 'abc123', item: 'W-1' });
  assert.strictEqual(ev.kind, 'parity_result');
  assert.strictEqual(ev.failures.length, Parity.MAX_FAILURES);
  assert.deepStrictEqual([ev.scenario, ev.commit, ev.outcome, ev.item], ['s', 'abc123', 'fail', 'W-1']);
});
