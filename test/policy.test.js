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
  assert.deepEqual(Policy.WRITE_TOOLS, ['propose_model_edit', 'mint_decision', 'write_check', 'mint_acceptance', 'mint_proposal', 'map_requirement', 'group_reviews', 'draft_eval_task', 'add_source', 'add_finding', 'answer_question', 'mint_ui_spec', 'mint_ui_component', 'mint_ui_template', 'request_preview', 'suggest_stage']);
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
  for (const c of ['p check -tc tcOptimistic', './checks/playtest-clean.sh', 'echo hi: there', 'npm test -- --grep "Booking: writes"', 'FOO=1 make check', 'TODO command that proves it'])
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
  for (const role of Object.keys(Policy.WRITE_PATHS)) assert.equal(wv(role, 'domain/fares.yaml', 'id: fares\n').ok, false, role);
});

test('checkFailHint names what the shell got wrong, not the decision', () => {
  assert.match(Policy.checkFailHint('./checks/in-process-only.sh', 1, 'win32'), /cmd\.exe.*"bash checks\/in-process-only\.sh"/);
  assert.match(Policy.checkFailHint('checks\\x.sh --fast', 9009, 'win32'), /"bash checks\\x\.sh"/);
  assert.match(Policy.checkFailHint('pcheck -tc t', 9009, 'win32'), /could not find the program "pcheck"/);
  assert.match(Policy.checkFailHint('pcheck -tc t', 127, 'linux'), /could not find the program "pcheck"/);
  assert.equal(Policy.checkFailHint('./checks/x.sh', 1, 'linux'), null);
  assert.equal(Policy.checkFailHint('bash checks/x.sh', 1, 'win32'), null);
});

test('readVerdict: ui/holdout/ is denied for every role, however the path is spelled', () => {
  for (const role of ['architect', 'grill', 'analyst', 'tutor', 'researcher', 'compose', 'catalogue', null])
    for (const rel of ['ui/holdout/home.json', 'ui/holdout', './ui/holdout/home.json', 'ui\\holdout\\home.json', 'ui/specs/../holdout/home.json', 'UI/Holdout/home.json'])
      assert.deepEqual(Policy.readVerdict(role, rel), { ok: false, error: Policy.HOLDOUT_DENIED }, `${role} ${rel}`);
  assert.match(Policy.HOLDOUT_DENIED, /never shown to an agent stage; a person writes it/);
});

test('readVerdict: other registry paths stay readable', () => {
  for (const rel of ['ui/specs/home.json', 'ui/holdouts.json', 'ui/pack/tokens.json', 'decisions/a.yaml', 'model/workspace.dsl', null])
    assert.deepEqual(Policy.readVerdict('compose', rel), { ok: true }, String(rel));
});

test('readVerdict: designc.json agents settings cannot open the holdout', () => {
  // The verdict takes no settings, so no allow list can reach it.
  assert.equal(Policy.readVerdict.length, 2);
  assert.equal(Policy.verdict({ allow: ['read_registry_file'], ask: [], deny: [] }, 'read_registry_file'), 'allow');
  assert.equal(Policy.readVerdict('architect', 'ui/holdout/x.json').ok, false);
});

test('unapprovedChanges: a change under ui/ is flagged unless a write was approved', () => {
  assert.deepEqual(flagged(['ui/specs/home.json']), ['ui/specs/home.json']);
  assert.deepEqual(flagged(['ui/components/button.json'], { approved: { 'ui/components/button.json': 95000 } }), []);
});

test('writeVerdict: holdout on an acceptance case is the person\'s, an agent write with it is refused', () => {
  const doc = h => `id: AC-1\nrequirement: R-1\nelement: x\nstates: [ready]\ncases:\n  - { state: ready, given: a, then: b${h} }\n`;
  assert.deepEqual(wv('grill', 'acceptance/AC-1.yaml', doc('')), { ok: true });
  for (const h of [', holdout: true', ', holdout: false'])
    assert.match(wv('grill', 'acceptance/AC-1.yaml', doc(h)).error || '', /holdout is set by the person binding the criterion; leave it out/, h);
});

test('compose and catalogue write only their own ui/ files; no stage writes the pack, the previews or the holdout', () => {
  const may = (role, rel) => (Policy.WRITE_PATHS[role] || []).some(re => re.test(rel));
  assert.equal(may('compose', 'ui/specs/home.json'), true);
  assert.equal(may('compose', 'ui/specs/Home.json'), false);
  assert.equal(may('compose', 'ui/specs/a/b.json'), false);
  assert.equal(may('compose', 'ui/components/Button.json'), false);
  assert.equal(may('catalogue', 'ui/components/Button.json'), true);
  assert.equal(may('catalogue', 'ui/templates/list-detail.json'), true);
  assert.equal(may('catalogue', 'ui/specs/home.json'), false);
  // D8: a legacy spec draft lives in ui/legacy/ and only compose writes it
  assert.equal(may('compose', 'ui/legacy/tags.json'), true);
  assert.equal(may('compose', 'ui/legacy/Tags.json'), false);
  assert.equal(may('compose', 'ui/legacy/a/b.json'), false);
  for (const role of ['catalogue', 'architect', 'grill', 'analyst']) assert.equal(may(role, 'ui/legacy/tags.json'), false, role);
  for (const role of ['compose', 'catalogue', 'architect', 'grill', 'analyst'])
    for (const rel of ['ui/pack/components/Button.json', 'ui/previews/home/a.png', 'ui/holdout/home.json', 'ui/holdout/x.json']) assert.equal(may(role, rel), false, `${role} ${rel}`);
});

test('writeVerdict: a ui/ file an agent writes must be JSON and minted, never bound', () => {
  const doc = o => JSON.stringify({ screen: 'home', status: 'minted', ...o });
  assert.deepEqual(wv('compose', 'ui/specs/home.json', doc({})), { ok: true });
  assert.match(wv('compose', 'ui/specs/home.json', doc({ status: 'bound' })).error, /minted/);
  assert.match(wv('compose', 'ui/specs/home.json', doc({ status: undefined })).error, /minted/);
  assert.deepEqual(wv('compose', 'ui/legacy/home.json', doc({})), { ok: true });
  assert.match(wv('compose', 'ui/legacy/home.json', doc({ status: 'bound' })).error, /minted/);
  assert.match(wv('catalogue', 'ui/legacy/home.json', doc({})).error, /may not write/);
  assert.match(wv('compose', 'ui/specs/home.json', '{').error, /JSON/);
  assert.match(wv('compose', 'ui/specs/home.json', '[]').error, /JSON/);
  assert.deepEqual(wv('catalogue', 'ui/components/Button.json', doc({})), { ok: true });
  assert.match(wv('catalogue', 'ui/components/Button.json', doc({ status: 'bound' })).error, /minted/);
  assert.match(wv('catalogue', 'ui/specs/home.json', doc({})).error, /may not write/);
  assert.match(wv('compose', 'ui/holdout/home.json', doc({})).error, /may not write/);
});

test('ui mint tools ask even when listed under allow', () => {
  for (const t of ['mint_ui_spec', 'mint_ui_component', 'mint_ui_template', 'request_preview', 'suggest_stage'])
    assert.equal(Policy.verdict({ allow: [t], ask: [], deny: [] }, t), 'ask', t);
});

test('D7 part 2: get_system3 is a read tool for the Analyst only; the Analyst still writes only proposals/ and factory/tasks/', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer', 'agent.js'), 'utf8');
  const roleLine = key => src.split('\n').find(l => l.startsWith(`  ${key}: { label:`));
  assert.match(roleLine('analyst'), /allow: \[[^\]]*'get_system3'/);
  for (const k of ['architect', 'grill', 'tutor', 'compose', 'catalogue']) assert.equal(/get_system3/.test(roleLine(k)), false, k);
  assert.equal(Policy.WRITE_TOOLS.includes('get_system3'), false);
  assert.match(roleLine('analyst'), /ask: \[[^\]]*'mint_proposal'/);
  assert.match(src, /mint_proposal:[^\n]*'catalogue gap'/);
  assert.deepEqual(Policy.WRITE_PATHS.analyst.map(String), ['/^proposals\\//', '/^factory\\/tasks\\//']);
  const may = rel => Policy.WRITE_PATHS.analyst.some(re => re.test(rel));
  for (const rel of ['ui/pack/components/DataTable.json', 'ui/components/DataTable.json', 'ui/specs/home.json', 'ui/holdout/home.json', '../acme-ui-registry/ui/components/DataTable.json', 'ledger/designc.jsonl']) assert.equal(may(rel), false, rel);
  assert.equal(may('proposals/catalogue-gap.yaml'), true);
  assert.equal(Policy.readVerdict('analyst', 'ui/holdout/home.json').ok, false, 'holdout stays sealed');
});
