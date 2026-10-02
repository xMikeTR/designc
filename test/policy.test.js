const { test } = require('node:test');
const assert = require('node:assert/strict');
const Policy = require('../renderer/policy.js');

const cfg = (o = {}) => ({ allow: ['read_model'], ask: ['mint_decision'], deny: [], ...o });

test('verdict fails closed: deny beats ask beats allow, unlisted is deny', () => {
  assert.equal(Policy.verdict(cfg(), 'read_model'), 'allow');
  assert.equal(Policy.verdict(cfg(), 'mint_decision'), 'ask');
  assert.equal(Policy.verdict(cfg(), 'get_gate'), 'deny');
  assert.equal(Policy.verdict(cfg({ deny: ['read_model', 'mint_decision'] }), 'read_model'), 'deny');
  assert.equal(Policy.verdict(cfg({ deny: ['mint_decision'] }), 'mint_decision'), 'deny');
  assert.equal(Policy.verdict(cfg({ allow: ['read_model', 'get_gate'], ask: ['get_gate'] }), 'get_gate'), 'ask');
});

test('each role may write only its own folders', () => {
  const may = (role, rel) => (Policy.WRITE_PATHS[role] || []).some(re => re.test(rel));
  assert.equal(may('architect', 'model/workspace.dsl'), true);
  assert.equal(may('architect', 'decisions/D-0001.yaml'), true);
  assert.equal(may('architect', 'proposals/P-0001.yaml'), false);
  assert.equal(may('grill', 'model/workspace.dsl'), false);
  assert.equal(may('analyst', 'proposals/P-0001.yaml'), true);
  assert.equal(may('nobody', 'model/workspace.dsl'), false);
});

test('a write tool never runs without asking, even when settings list it under allow', () => {
  for (const tool of Policy.WRITE_TOOLS) {
    assert.equal(Policy.verdict(cfg({ allow: [tool], ask: [] }), tool), 'ask', tool);
    assert.equal(Policy.verdict(cfg({ allow: [tool], ask: [], deny: [tool] }), tool), 'deny', tool);
    assert.equal(Policy.verdict(cfg({ allow: [], ask: [] }), tool), 'deny', tool);
  }
  assert.deepEqual(Policy.WRITE_TOOLS, ['propose_model_edit', 'mint_decision', 'mint_proposal']);
});

const yaml = require('js-yaml');
const wv = (role, rel, content) => Policy.writeVerdict(role, rel, content, yaml.load);

test('writeVerdict: outside the registry, wrong folder and right folder', () => {
  assert.equal(wv('architect', null, 'x').ok, false);
  assert.match(wv('architect', null, 'x').error, /inside the registry/);
  assert.equal(wv('grill', 'model/workspace.dsl', 'workspace {}').ok, false);
  assert.match(wv('grill', 'model/workspace.dsl', 'workspace {}').error, /may not write model\/workspace\.dsl/);
  assert.deepEqual(wv('architect', 'model/workspace.dsl', 'workspace {}'), { ok: true });
  assert.deepEqual(wv('grill', 'decisions/a.yaml', 'id: a\nstatus: minted\n'), { ok: true });
});

test('writeVerdict: an agent cannot write a decision as bound or superseded, however it is spelled', () => {
  for (const status of ['bound', '"bound"', "'bound'", 'superseded', ' Bound ', '"SUPERSEDED"'])
    assert.match(wv('architect', 'decisions/a.yaml', `id: a\nstatus: ${status}\n`).error || '', /human action/, status);
  assert.match(wv('architect', 'decisions/a.yaml', '{ id: a, status: bound }').error || '', /human action/);
});

test('writeVerdict: a decision or proposal that is not a readable YAML mapping is refused', () => {
  assert.match(wv('architect', 'decisions/a.yaml', 'id: [unclosed').error || '', /not valid YAML/);
  assert.match(wv('architect', 'decisions/a.yaml', '- just a list').error || '', /not valid YAML/);
  assert.match(wv('analyst', 'proposals/a.yaml', 'id: [unclosed').error || '', /not valid YAML/);
  assert.deepEqual(wv('architect', 'decisions/notes.md', 'status: bound'), { ok: false, error: 'Agents may only write .yaml files in decisions/.' });
});

const flagged = (paths, { approved = {}, own = {}, now = 100000 } = {}) =>
  Policy.unapprovedChanges(paths, { approved: new Map(Object.entries(approved)), ownAppends: new Map(Object.entries(own)), now });

test('unapprovedChanges: registry files changed without a recent approval are flagged', () => {
  assert.deepEqual(flagged(['model/workspace.dsl']), ['model/workspace.dsl']);
  assert.deepEqual(flagged(['model/workspace.dsl'], { approved: { 'model/workspace.dsl': 95000 } }), []);
  assert.deepEqual(flagged(['model/workspace.dsl'], { approved: { 'model/workspace.dsl': 91000 } }), ['model/workspace.dsl']);
  assert.deepEqual(flagged(['model', 'asbuilt/facts.json', 'telemetry/x.json']), [])
  assert.deepEqual(flagged(['designc.json']), ['designc.json']);
  assert.deepEqual(flagged(['designc.json'], { approved: { 'designc.json': 99000 } }), []);;
});

test('unapprovedChanges: a ledger file is flagged unless the app itself just appended to it', () => {
  assert.deepEqual(flagged(['ledger/checks.jsonl']), ['ledger/checks.jsonl']);
  assert.deepEqual(flagged(['ledger/checks.jsonl'], { own: { 'ledger/checks.jsonl': 95000 } }), []);
  assert.deepEqual(flagged(['ledger/checks.jsonl'], { own: { 'ledger/agents.jsonl': 95000 } }), ['ledger/checks.jsonl']);
  assert.deepEqual(flagged(['ledger/checks.jsonl'], { own: { 'ledger/checks.jsonl': 91000 } }), ['ledger/checks.jsonl']);
  assert.deepEqual(flagged(['ledger/checks.jsonl'], { approved: { 'ledger/checks.jsonl': 99000 } }), ['ledger/checks.jsonl']);
});
