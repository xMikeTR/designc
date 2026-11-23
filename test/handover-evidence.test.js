// S7 H/B: a work item's evidence travels in the handover as a derived evidence.json (kinds, keys and counts only) and as "What's wrong" in BUILD.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const Core = require('../renderer/core.js');

const root = path.join(__dirname, '..');
const readDoc = n => JSON.parse(fs.readFileSync(path.join(root, 'docs', n), 'utf8'));
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(readDoc('handover-evidence.schema.json'));

const model = { path: 'model/workspace.dsl', text: `workspace "S" { model { s = softwareSystem "Shop" {
  api = container "Api" { properties { "d.code" "src/Api/**" } }
} } views { container s "C" { include * autoLayout } } }` };
const ITEM = { id: 'W-1', requirement: ['RE-1'], elements: ['Api'] };
const plan = extra => Core.handoverPlan({ date: '2026-11-23', now: '2026-11-23T10:00:00Z', by: 'tester-name', model, item: ITEM, ...extra });
const file = (p, name) => p.files.find(f => f.path.endsWith('/' + name));

// A report built to tempt a leak: every value-bearing field holds a unique marker.
const MSG = 'column "Inception" is date:dddd-0d-dd; legacy shows date:dd/0d/dddd';
const report = () => ({
  commit: 'COMMITMARK1111', item: 'ITEMMARK', next: { scenario: 'tags-list', steps: [{ n: 1, shot: 'SHOTMARKnext', elements: [{ role: 'cell', name: 'ELEMVALUEMARK', data: true }] }] },
  result: {
    scenario: 'tags-list', outcome: 'fail',
    steps: [
      { n: 1, action: 'goto', status: 'compared', reason: 'REASONMARK sk-fake-secret', legacyShot: 'SHOTMARKlegacy', nextShot: 'SHOTMARKnext', findings: [
        { kind: 'shape', key: 'table:Programs/column:Inception', severity: 'fail', msg: MSG, role: 'ROLEMARK', name: 'NAMEMARKshape' },
        { kind: 'text', key: 'heading:Adhoc tags', severity: 'fail', msg: 'MSGMARKtext', was: 'WASMARKtext', name: 'NAMEMARKtext', by: 'BYMARK' },
        { kind: 'missing', key: 'button:Export', severity: 'fail', msg: 'MSGMARKmissing', name: 'NAMEMARKmissing' },
        { kind: 'text', key: 'cell[Program]', severity: 'fail', was: 'x' },
        { kind: 'covered', key: 'textbox:Program', severity: 'covered', msg: 'MSGMARKcovered', name: 'NAMEMARKcovered' }] },
      { n: 2, action: 'click', status: 'compared', findings: [{ kind: 'covered', key: 'button:Bulk apply', severity: 'covered', name: 'NAMEMARKcovered2' }] },
    ],
    counts: { fail: 4, covered: 1, could_not_run: 0 },
  },
});
const inbox = () => ({ id: 'ZZ-9', title: 'Totals wrong `on` **export**', jira: { type: 'Bug', labels: ['LABELMARK'], components: ['COMPMARK'], priority: 'PRIOMARK' }, link: 'https://jira.example/browse/ZZ-9', description: 'DESCMARK', swept: '2026-11-22', surprise: 'UNKNOWNMARK', target: { jira: 'ZZ-9' } });
const EV = () => [
  { parity: 'tags-list', step: 1, report: report() },
  { parity: 'tags-list', step: 2, report: report() },
  { parity: 'tags-list', step: 7, report: report() },
  { parity: 'gone', step: 1, report: null },
  { jira: 'ZZ-9', inbox: inbox() },
  { jira: 'ZZ-8', inbox: null },
  { escape: 'E-0012' },
];

test('without evidence: empty equals absent, byte for byte, and no evidence key, file or section', () => {
  const a = plan({}), b = plan({ evidence: [] });
  assert.equal(a.id, b.id);
  assert.deepEqual(a.files, b.files);
  assert.equal(file(a, 'evidence.json'), undefined);
  assert.doesNotMatch(file(a, 'handover.yaml').text, /^evidence:/m);
  assert.doesNotMatch(file(a, 'BUILD.md').text, /What's wrong/);
});

test('with evidence: evidence.json validates and equals the example, is listed with its hash, keyed right after landing: spot, and the id differs', () => {
  const none = plan({}), p = plan({ evidence: EV() });
  assert.notEqual(p.id, none.id);
  const doc = JSON.parse(file(p, 'evidence.json').text);
  assert.ok(validate(doc), JSON.stringify(validate.errors));
  assert.deepEqual(doc, readDoc('handover-evidence.example.json'));
  assert.equal(file(p, 'evidence.json').text, JSON.stringify(doc, null, 2) + '\n');
  const head = file(p, 'handover.yaml').text;
  assert.match(head, /^evidence: "evidence.json"$/m);
  assert.ok(head.includes(`path: "evidence.json", hash: ${Core._shared.hash16(file(p, 'evidence.json').text)}`));
  const keys = head.split('\n').map(l => /^([a-z_]+):/.exec(l)).filter(Boolean).map(m => m[1]);
  assert.equal(keys[keys.indexOf('evidence') + 1], 'work_item', 'no scenario_tests here: the next key is the item');
  assert.ok(keys.indexOf('evidence') < keys.indexOf('requirements'));
  // with landing and scenario_tests the order is landing, evidence, scenario_tests (checked on the template line)
  const src = fs.readFileSync(path.join(root, 'renderer', 'core-handover.js'), 'utf8');
  assert.ok(src.indexOf('landingFile ? `landing:') < src.indexOf('evidenceFile ? `evidence:') && src.indexOf('evidenceFile ? `evidence:') < src.indexOf('scn ? `scenario_tests:'));
});

test('a changed finding count is a different handover; now and by do not change it', () => {
  const a = plan({ evidence: EV() });
  const ev = EV(); ev[0].report.result.steps[0].findings.pop(); ev[0].report.result.steps[0].findings.pop();
  assert.notEqual(plan({ evidence: ev }).id, a.id);
  const later = Core.handoverPlan({ date: '2026-11-23', now: '2026-11-23T23:00:00Z', by: 'someone-else', model, item: ITEM, evidence: EV() });
  assert.equal(later.id, a.id);
  assert.equal(file(later, 'evidence.json').text, file(a, 'evidence.json').text);
});

test('BUILD.md: What\'s wrong is the first ## section, before What to build, and says what each entry shows', () => {
  const t = file(plan({ evidence: EV() }), 'BUILD.md').text;
  const heads = t.split('\n').filter(l => /^## /.test(l));
  assert.equal(heads[0], "## What's wrong");
  assert.equal(heads[1], '## What to build');
  const wrong = t.slice(t.indexOf("## What's wrong"), t.indexOf('## What to build'));
  assert.match(wrong, /tags-list.*step 1/);
  assert.match(wrong, /3 failing: shape 1, text 2|3 failing: text 2, shape 1|4 failing/);
  assert.ok(wrong.includes('- shape at `table:Programs/column:Inception`: ' + MSG));
  assert.ok(wrong.includes('- text at `heading:Adhoc tags`\n'));
  assert.ok(wrong.includes('- missing at `button:Export`\n'));
  assert.match(wrong, /step 2[^\n]*\n?[^\n]*shows no failure at step 2[^\n]*check it still fails before changing code/i);
  assert.match(wrong, /step 7[^\n]*no failure at step 7/i);
  assert.match(wrong, /gone[^\n]*no report is recorded/i);
  assert.ok(wrong.includes('ZZ-9') && wrong.includes('Bug') && wrong.includes(JSON.stringify('Totals wrong `on` **export**')) && wrong.includes('https://jira.example/browse/ZZ-9'));
  assert.match(wrong, /ZZ-8[^\n]*only the key is known/i);
  assert.match(wrong, /E-0012[^\n]*recorded in the ledger/);
  assert.ok(wrong.includes('`evidence.json` holds this. It names kinds and keys, never values'));
  assert.ok(wrong.includes('The work is done when the item\'s `done_when` passes.'));
});

test('DATA LEAK: no marker from the report or the inbox entry appears in any file of the plan; the shape msg, title, type and link do', () => {
  const p = plan({ evidence: EV() });
  const all = p.files.map(f => f.text).join('\n====\n');
  for (const m of ['COMMITMARK', 'ITEMMARK', 'SHOTMARK', 'ELEMVALUEMARK', 'REASONMARK', 'sk-fake-secret', 'ROLEMARK', 'NAMEMARK', 'MSGMARK', 'WASMARK', 'BYMARK', 'LABELMARK', 'COMPMARK', 'PRIOMARK', 'DESCMARK', 'UNKNOWNMARK', '2026-11-22'])
    assert.equal(all.includes(m), false, `${m} leaked`);
  const ev = JSON.parse(file(p, 'evidence.json').text).evidence;
  assert.equal(ev[0].findings[0].msg, MSG);
  assert.deepEqual(ev.find(e => e.kind === 'jira' && e.key === 'ZZ-9'), { kind: 'jira', key: 'ZZ-9', title: 'Totals wrong `on` **export**', type: 'Bug', link: 'https://jira.example/browse/ZZ-9' });
  assert.deepEqual(ev.find(e => e.kind === 'jira' && e.key === 'ZZ-8'), { kind: 'jira', key: 'ZZ-8', title: null, type: null, link: null });
  const par = ev[0];
  assert.deepEqual(par.findings.map(f => Object.keys(f).sort().join()), ['key,kind,msg', 'key,kind', 'key,kind', 'key,kind']);
  assert.deepEqual(par.counts, { fail: 4, by_kind: { shape: 1, text: 2, missing: 1 } });
});
