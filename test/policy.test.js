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
  assert.deepEqual(Policy.WRITE_TOOLS, ['propose_model_edit', 'mint_decision', 'mint_acceptance', 'mint_proposal', 'map_requirement', 'group_reviews', 'draft_eval_task', 'add_source', 'add_finding', 'answer_question']);
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

test('the tutor writes nothing: no write path, and a write tool it is not given is denied', () => {
  const yaml = require('js-yaml');
  for (const rel of ['model/workspace.dsl', 'decisions/x.yaml', 'proposals/x.yaml', 'factory/tasks/x.yaml'])
    assert.equal(Policy.writeVerdict('tutor', rel, 'id: x', yaml.load).ok, false, rel);
  const tutor = { allow: ['read_model', 'get_findings'], ask: [], deny: [] };
  for (const t of Policy.WRITE_TOOLS) assert.equal(Policy.verdict(tutor, t), 'deny', t);
});

test('checkProblem: a check written as a description is not a command', () => {
  for (const c of ['Model: user -> agent has d.idempotent = no', 'Test: with the MCP server stopped, a request fails', 'Telemetry: zero matches', 'ACS policy: a deny-listed read is denied'])
    assert.match(Policy.checkProblem(c), /description, not a command/, c);
  assert.match(Policy.checkProblem(''), /empty/);
  assert.match(Policy.checkProblem('   '), /empty/);
});

test('checkProblem: real commands and TODO placeholders pass', () => {
  for (const c of ['p check -tc tcOptimistic', './checks/playtest-clean.sh', 'echo hi: there', 'npm test -- --grep "Quote: writes"', 'FOO=1 make check', 'TODO command that proves it'])
    assert.equal(Policy.checkProblem(c), null, c);
});

test('writeVerdict: an agent decision whose check is a description is refused, naming it', () => {
  const doc = 'id: x\nstatus: minted\nchecks:\n  - "./ok.sh"\n  - "Model: agent is read-only"\n';
  const v = wv('grill', 'decisions/x.yaml', doc);
  assert.equal(v.ok, false);
  assert.match(v.error, /Model: agent is read-only/);
  assert.match(v.error, /TODO/);
  assert.equal(wv('grill', 'decisions/x.yaml', 'id: x\nstatus: minted\nchecks:\n  - "./ok.sh"\n  - "TODO write the playtest script"\n').ok, true);
});

test('Grill-me may write acceptance criteria as yaml, and no other role may', () => {
  const wv = (role, rel, text) => Policy.writeVerdict(role, rel, text, require('js-yaml').load);
  assert.deepEqual(wv('grill', 'acceptance/AC-1.yaml', 'id: AC-1\nrequirement: R-1\n'), { ok: true });
  assert.equal(wv('grill', 'acceptance/AC-1.md', 'x').ok, false);
  assert.equal(wv('grill', 'acceptance/AC-1.yaml', '- a\n- b\n').ok, false);
  assert.match(wv('architect', 'acceptance/AC-1.yaml', 'id: x\n').error, /may not write acceptance/);
  assert.match(wv('analyst', 'acceptance/AC-1.yaml', 'id: x\n').error, /may not write acceptance/);
});

test('map_requirement and read_import_page are offered to Grill-me only, and the write path list is unchanged', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer', 'agent.js'), 'utf8');
  const roleLine = key => src.split('\n').find(l => l.startsWith(`  ${key}: { label:`));
  for (const k of ['architect', 'analyst', 'tutor']) {
    assert.equal(/map_requirement|read_import_page/.test(roleLine(k)), false, k);
  }
  assert.match(roleLine('grill'), /ask: \[[^\]]*'map_requirement'/);
  assert.match(roleLine('grill'), /allow: \[[^\]]*'read_import_page'/);
  assert.equal(/requirements\//.test(JSON.stringify(Object.values(Policy.WRITE_PATHS).flat().map(String))), false);
});

test('read_parity is a read-only tool offered to Grill-me only', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer', 'agent.js'), 'utf8');
  const roleLine = key => src.split('\n').find(l => l.startsWith(`  ${key}: { label:`));
  for (const k of ['architect', 'analyst', 'tutor']) assert.equal(/read_parity/.test(roleLine(k)), false, k);
  assert.match(roleLine('grill'), /allow: \[[^\]]*'read_parity'/);
  assert.equal(/read_parity/.test(roleLine('grill').split('ask:')[1].split(']')[0]), false);
  assert.equal(Policy.WRITE_TOOLS.includes('read_parity'), false);
  assert.equal(/parity\//.test(JSON.stringify(Object.values(Policy.WRITE_PATHS).flat().map(String))), false);
});

test('the Researcher appends to study topics only through its approved tools; a raw write to study/ is refused', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../renderer/agent.js'), 'utf8');
  const line = src.split('\n').find(l => l.startsWith('  researcher: { label:'));
  assert.ok(line, 'agent.js defines the researcher role');
  assert.match(line, /ask: \['add_source', 'add_finding', 'answer_question'\]/);
  assert.match(line, /allow: \['read_study'\]/);
  for (const t of ['add_source', 'add_finding', 'answer_question']) assert.equal(Policy.verdict(cfg({ allow: [t], ask: [] }), t), 'ask', t);
  assert.equal(wv('researcher', 'study/compiler-passes.yaml', 'id: compiler-passes\nstatus: settled\n').ok, false);
  for (const role of Object.keys(Policy.WRITE_PATHS)) assert.equal(wv(role, 'study/a.yaml', 'id: a\n').ok, false, role);
});

test('no role may write domain/: a pack is pinned by a person from its registry', () => {
  assert.equal(/domain\//.test(JSON.stringify(Object.values(Policy.WRITE_PATHS).flat().map(String))), false);
  for (const role of Object.keys(Policy.WRITE_PATHS)) assert.equal(wv(role, 'domain/pricing.yaml', 'id: pricing\n').ok, false, role);
});

test('checkFailHint names what the shell got wrong, not the decision', () => {
  assert.match(Policy.checkFailHint('./checks/in-process-only.sh', 1, 'win32'), /cmd\.exe.*"bash checks\/in-process-only\.sh"/);
  assert.match(Policy.checkFailHint('checks\\x.sh --fast', 9009, 'win32'), /"bash checks\\x\.sh"/);
  assert.match(Policy.checkFailHint('pcheck -tc t', 9009, 'win32'), /could not find the program "pcheck"/);
  assert.match(Policy.checkFailHint('pcheck -tc t', 127, 'linux'), /could not find the program "pcheck"/);
  assert.equal(Policy.checkFailHint('./checks/x.sh', 1, 'linux'), null);
  assert.equal(Policy.checkFailHint('bash checks/x.sh', 1, 'win32'), null);
});
