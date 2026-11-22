// S1c: designc drafts the checker for a decision. agent.js needs the DOM, so the block between its
// "checker:begin" and "checker:end" markers is evaluated here with stubs for the app's globals.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Records = require('../renderer/records.js');
const Core = require('../renderer/core.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'agent.js'), 'utf8');
const block = () => {
  const a = SRC.indexOf('// checker:begin'), b = SRC.indexOf('// checker:end');
  assert.ok(a >= 0 && b > a, 'agent.js has the checker:begin / checker:end block');
  return SRC.slice(a, b);
};

const yamlStr = s => JSON.stringify(String(s || ''));
const GOOD = '#!/usr/bin/env bash\nset -e\ngrep -q rowversion model/workspace.dsl || { echo "no rowversion"; exit 1; }\n';

// A fake registry: files by path, a decision list, an agent state, and recorders for every effect.
function world({ decisions, files = {}, agent = 'builtin', acp = {}, llm = false, busy = false, runOutcome = 'pass', noRun = false, runThrows = null, ledger = [] } = {}) {
  const w = { files: { ...files }, writes: [], toasts: [], sent: [], ran: [], role: 'architect', panel: false };
  const A = { decisions, ledger: ledger.map(r => ({ ...r })), cfg: {} };
  Object.defineProperty(w, 'ledger', { get: () => A.ledger });
  Object.defineProperty(A, 'tree', { get: () => Object.keys(w.files).map(path => ({ path })), set() {} });
  const AG = { agent, acpAgents: acp, busy, role: 'architect', approved: new Map() };
  const host = {
    exists: async p => p in w.files,
    read: async p => { if (!(p in w.files)) throw new Error('ENOENT'); return w.files[p]; },
    write: async (p, t) => { if (w.failOn === p) throw new Error('disk full'); w.writes.push(p); w.files[p] = t; },
    tree: async () => [],
  };
  const reload = async () => {
    for (const d of A.decisions) if (d._path in w.files) Object.assign(d, require('js-yaml').load(w.files[d._path]));
  };
  const runChecks = async list => {
    if (runThrows) throw new Error(runThrows);
    if (noRun) return;
    for (const d of list) for (const cmd of Records.runs(d).filter(c => c && !/^TODO/.test(c))) {
      w.ran.push(`${d.id}: ${cmd}`);
      A.ledger.push({ kind: 'check', decision: d.id, check: cmd, outcome: typeof runOutcome === 'function' ? runOutcome(cmd) : runOutcome, exit_code: 1, _ts: 1000 + A.ledger.length });
    }
  };
  const env = {
    A, AG, host, Records, Core, yamlStr, treePaths: ns => (ns || []).flatMap(n => (n.dir ? [] : [n.path])), esc: s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
    loadRegistry: reload, loadLedger: async () => { A.ledger = A.ledger.map(r => ({ ...r })); },  // like the real one: fresh objects every time
    jsyaml: require('js-yaml'), recompile() {}, renderAll() {}, runChecks,
    toast: (m, k) => w.toasts.push(m), Setup: { llmReady: () => llm },
    setRole: r => { AG.role = r; w.role = r; }, toggleAgent: () => { w.panel = true; }, send: t => { w.sent.push(t); },
    grillInPanel(t) { if (AG.busy) { w.toasts.push('busy'); return true; } if (AG.agent === 'builtin') { const k = Object.keys(AG.acpAgents)[0]; if (!k) return false; AG.agent = k; } w.sent.push(t); return true; },
  };
  const names = Object.keys(env);
  const api = new Function(...names, `${block()}\nreturn { needsChecker, offerChecker, scriptProblem, writeCheck, startChecker, draftCheck, approveCard, replaceCheck, whenLines };`)(...names.map(n => env[n]));
  return { w, A, AG, api };
}
const dec = (id, checks, extra = {}) => ({ id, status: 'bound', kind: 'technical', effect: 'fix', statement: `${id} holds`, _path: `decisions/${id}.yaml`, checks, ...extra });
const file = (id, checksText, extra = '') => `id: ${id}\nstatus: bound\nkind: technical\neffect: fix\nstatement: "${id} holds"\n${checksText}${extra}rationale: "why"\n`;
const setup = (id, checks, text, opts = {}) => {
  const d = dec(id, checks);
  return world({ decisions: [d], files: { [d._path]: text, 'model/workspace.dsl': 'rowversion', ...(opts.files || {}) }, ...opts });
};
const args = (id, script = GOOD, summary = 'Passes when: the model names rowversion.\nFails when: it does not.') => ({ decision: id, script, summary });

// ---- cause table: every shape of "no runnable check" gets a draft
const SHAPES = [
  ['template TODO', ['TODO command that proves it, or leave it'], 'checks:\n  - "TODO command that proves it, or leave it"\n', 'checks/D-1.sh'],
  ['domain invariant TODO', ['TODO'], 'checks:\n  - "TODO"\n', 'checks/D-1.sh'],
  ['agent mint default', ['TODO command that proves it'], 'checks:\n  - "TODO command that proves it"\n', 'checks/D-1.sh'],
  ['agent prompt wording', ['TODO <what it must prove>'], 'checks:\n  - "TODO <what it must prove>"\n', 'checks/D-1.sh'],
  ['empty list', [], 'checks: []\n', 'checks/D-1.sh'],
  ['TODO with a script path', ['TODO ./checks/occ.sh: writers use rowversion'], 'checks:\n  - "TODO ./checks/occ.sh: writers use rowversion"\n', 'checks/occ.sh'],
];
for (const [name, checks, text, target] of SHAPES) {
  test(`write_check drafts for: ${name}`, async () => {
    const { w, A, api } = setup('D-1', checks, file('D-1', text));
    const card = await api.writeCheck(args('D-1'));
    assert.ok(!card.error, card.error);
    assert.deepEqual(w.writes, [], 'nothing is written before approval');
    assert.match(card.preview, new RegExp(target.replace('.', '\\.')));
    await card.apply();
    assert.ok(w.files[target].startsWith('#!/usr/bin/env bash'));
    assert.deepEqual(Records.runs(A.decisions[0]), [`bash ./${target}`]);
  });
}

test('the card says when it passes and fails above the script, and the button reads Approve and run', async () => {
  const { api } = setup('D-1', [], file('D-1', 'checks: []\n'));
  const card = await api.writeCheck(args('D-1', GOOD, 'Passes when: the model names rowversion.\nFails when: it never does.'));
  assert.equal(card.ok, 'Approve and run');
  const i = card.preview.indexOf('Passes when'), j = card.preview.indexOf('Fails when'), k = card.preview.indexOf('<pre');
  assert.ok(i >= 0 && j > i && k > j, 'Passes when, Fails when, then the script');
  assert.match(card.preview, /the model names rowversion/); assert.match(card.preview, /it never does/);
});

test('a summary without Passes when or Fails when says so on the card instead of hiding it', async () => {
  const { api } = setup('D-1', [], file('D-1', 'checks: []\n'));
  const card = await api.writeCheck(args('D-1', GOOD, 'Checks the model'));
  assert.match(card.preview, /did not say when it passes or fails/i);
});

test('the card HTML escapes the summary and the script', async () => {
  const { api } = setup('D-1', [], file('D-1', 'checks: []\n'));
  const card = await api.writeCheck(args('D-1', GOOD + '# <img src=x>\n', 'Passes when: <b>x</b>\nFails when: y'));
  assert.doesNotMatch(card.preview, /<img src=x>|<b>x<\/b>/);
});

// ---- never replaces, and a safe path
test('write_check refuses when the script already exists, at the card and again at apply', async () => {
  const a = setup('D-1', [], file('D-1', 'checks: []\n'), { files: { 'checks/D-1.sh': '#!/usr/bin/env bash\nexit 3\n' } });
  const r = await a.api.writeCheck(args('D-1'));
  assert.match(r.error, /already exists/); assert.deepEqual(a.w.writes, []);
  const b = setup('D-1', [], file('D-1', 'checks: []\n'));
  const card = await b.api.writeCheck(args('D-1'));
  b.w.files['checks/D-1.sh'] = 'made meanwhile';
  await assert.rejects(card.apply(), /already exists/);
  assert.equal(b.w.files['checks/D-1.sh'], 'made meanwhile'); assert.deepEqual(b.w.writes, []);
});

test('a TODO naming an existing script is not overwritten either', async () => {
  const { api, w } = setup('D-1', ['TODO ./checks/occ.sh: x'], file('D-1', 'checks:\n  - "TODO ./checks/occ.sh: x"\n'), { files: { 'checks/occ.sh': 'mine' } });
  assert.match((await api.writeCheck(args('D-1'))).error, /already exists/); assert.equal(w.files['checks/occ.sh'], 'mine');
});

test('the id must be a safe file name inside checks/', async () => {
  for (const id of ['../x', 'a/b', '.hidden', 'a b', 'x;rm', '']) {
    const { api } = world({ decisions: [dec(id || 'blank', [])].map(d => ({ ...d, id })), files: {} });
    const r = await api.writeCheck(args(id));
    assert.ok(r.error, `refused: ${JSON.stringify(id)}`);
  }
  const { api } = setup('D-1', ['TODO ./checks/../../evil.sh: x'], file('D-1', 'checks:\n  - "TODO ./checks/../../evil.sh: x"\n'));
  const card = await api.writeCheck(args('D-1'));
  assert.ok(card.error || /checks\/D-1\.sh/.test(card.preview), 'a traversal in the TODO is not followed');
});

// ---- a script with no failing path
test('scriptProblem refuses scripts with no failing path and accepts ones that can fail', () => {
  const { api } = world({ decisions: [] });
  for (const s of ['exit 0', 'echo ok\nexit 0', 'true', '# exit 1\nexit 0', 'echo "exit 1"\nexit 0', ':', 'echo hi', 'set -e\necho hi\nexit 0', 'set -e']) {
    assert.ok(api.scriptProblem(`#!/usr/bin/env bash\n${s}\n`), `refused: ${s}`);
  }
  for (const s of ['exit 1', '[ -f x ] || exit 1', 'grep -q a b', 'set -e\ngrep a b\necho ok', 'if ! test -f x; then echo no; exit 2; fi', 'false', 'test -f a || { echo missing; exit "$?"; }\nexit 0']) {
    assert.equal(api.scriptProblem(`#!/usr/bin/env bash\n${s}\n`), null, `accepted: ${s}`);
  }
});

test('write_check refuses an always-pass script before any card', async () => {
  const { api, w } = setup('D-1', [], file('D-1', 'checks: []\n'));
  const r = await api.writeCheck(args('D-1', '#!/usr/bin/env bash\necho ok\nexit 0\n'));
  assert.match(r.error, /cannot fail|no failing path/i); assert.deepEqual(w.writes, []);
});

test('the blocklist and shebang rules still apply', async () => {
  const { api } = setup('D-1', [], file('D-1', 'checks: []\n'));
  assert.match((await api.writeCheck(args('D-1', '#!/usr/bin/env bash\ncurl x || exit 1\n'))).error, /curl/);
  assert.match((await api.writeCheck(args('D-1', 'exit 1\n'))).error, /#!\/usr\/bin\/env bash/);
});

// ---- the decision file edit keeps the rest
test('checks: [] with a trailing comment is replaced and the comment kept', async () => {
  const { api, w } = setup('D-1', [], file('D-1', 'checks: []   # filled by designc\n'));
  await (await api.writeCheck(args('D-1'))).apply();
  assert.match(w.files['decisions/D-1.yaml'], /^checks:   # filled by designc\n  - "bash \.\/checks\/D-1\.sh"\n/m);
});

test('a missing checks: key is added', async () => {
  const { api, w } = setup('D-1', [], 'id: D-1\nstatus: bound\nkind: technical\neffect: fix\nstatement: "s"\n');
  await (await api.writeCheck(args('D-1'))).apply();
  assert.match(w.files['decisions/D-1.yaml'], /\nchecks:\n  - "bash \.\/checks\/D-1\.sh"\n$/);
});

test('{id, run} entries: the TODO run is replaced, its id, the other checks and the comments stay', async () => {
  const text = file('D-1', 'checks:\n  # first the old one\n  - { id: keep, run: "TODO ./checks/a.sh: x" }   # trailing\n  - "TODO other thing"\n  - id: long\n    run: "TODO long form"\n');
  const { api, w } = setup('D-1', ['TODO ./checks/a.sh: x', 'TODO other thing', 'TODO long form'], text);
  await (await api.writeCheck(args('D-1'))).apply();
  const out = w.files['decisions/D-1.yaml'];
  assert.match(out, /# first the old one\n  - \{ id: keep, run: "bash \.\/checks\/a\.sh" \}   # trailing\n/);
  assert.match(out, /- "TODO other thing"\n/); assert.match(out, /run: "TODO long form"/);
});

test('a multi-line {id, run} TODO is replaced in place', async () => {
  const { api, w } = setup('D-1', ['TODO long form'], file('D-1', 'checks:\n  - id: long\n    run: "TODO long form"\n'));
  await (await api.writeCheck(args('D-1'))).apply();
  assert.match(w.files['decisions/D-1.yaml'], /- id: long\n    run: "bash \.\/checks\/D-1\.sh"\n/);
});

test('a bare checks: (null) is filled', async () => {
  const { api, w } = setup('D-1', [], file('D-1', 'checks:\n'));
  await (await api.writeCheck(args('D-1'))).apply();
  assert.match(w.files['decisions/D-1.yaml'], /^checks:\n  - "bash \.\/checks\/D-1\.sh"\nrationale/m);
});

test('a flow list is replaced in place', async () => {
  const { api, w } = setup('D-1', ['TODO x'], file('D-1', 'checks: ["TODO x"]  # one\n'));
  await (await api.writeCheck(args('D-1'))).apply();
  assert.match(w.files['decisions/D-1.yaml'], /^checks: \["bash \.\/checks\/D-1\.sh"\]  # one$/m);
});

test('apply writes nothing when the file changed and the TODO line cannot be found', async () => {
  const { api, w } = setup('D-1', ['TODO x'], file('D-1', 'checks:\n  - "TODO x"\n'));
  const card = await api.writeCheck(args('D-1'));
  w.files['decisions/D-1.yaml'] = file('D-1', 'checks:\n  - "TODO y"\n');
  await assert.rejects(card.apply(), /Nothing was written/);
  assert.deepEqual(w.writes, []);
});

// ---- eligibility
test('write_check refuses a decision that already has a runnable check, or is superseded, or is unknown', async () => {
  const real = setup('D-1', ['p check -tc a'], file('D-1', 'checks:\n  - p check -tc a\n'));
  assert.match((await real.api.writeCheck(args('D-1'))).error, /already has a runnable check/);
  const gone = setup('D-1', [], file('D-1', 'checks: []\n')); gone.A.decisions[0].status = 'superseded';
  assert.ok((await gone.api.writeCheck(args('D-1'))).error);
  assert.match((await gone.api.writeCheck(args('D-9'))).error, /not in the registry/);
});

test('needsChecker: technical fix decisions with no runnable check only', () => {
  const { api } = world({ decisions: [] });
  assert.equal(api.needsChecker(dec('a', [])), true);
  assert.equal(api.needsChecker(dec('a', ['TODO'])), true);
  assert.equal(api.needsChecker(dec('a', ['TODO', 'p check'])), false);
  assert.equal(api.needsChecker(dec('a', [], { kind: 'business' })), false);
  assert.equal(api.needsChecker(dec('a', [], { effect: 'accept' })), false);
  assert.equal(api.needsChecker(dec('a', [], { effect: 'build' })), false);
  assert.equal(api.needsChecker(dec('a', [], { status: 'superseded' })), false);
  assert.equal(api.needsChecker(dec('a', [], { kind: undefined })), true);
  assert.equal(api.needsChecker(dec('a', [{ id: 'x', run: 'TODO y' }])), true);
  assert.equal(api.needsChecker(dec('a', [{ id: 'x', run: 'bash ./c.sh' }])), false);
});

// ---- approve, run, record
test('approving saves, replaces the TODO, runs the check and reports a pass', async () => {
  const { api, w } = setup('D-1', ['TODO x'], file('D-1', 'checks:\n  - "TODO x"\n'));
  const msg = await api.approveCard(await api.writeCheck(args('D-1')));
  assert.deepEqual(w.ran, ['D-1: bash ./checks/D-1.sh']);
  assert.match(msg, /Saved checks\/D-1\.sh/); assert.match(msg, /passed/);
});

test('a failing run is reported as failed and nothing is changed to make it pass', async () => {
  const { api, w } = setup('D-1', [], file('D-1', 'checks: []\n'), { runOutcome: 'fail' });
  const msg = await api.approveCard(await api.writeCheck(args('D-1')));
  assert.match(msg, /FAILED/); assert.match(msg, /not changed/i);
  assert.deepEqual(w.writes.sort(), ['checks/D-1.sh', 'decisions/D-1.yaml']);
});

test('a run that did not happen (not trusted, busy) is said, not reported as a pass', async () => {
  const { api, w } = setup('D-1', [], file('D-1', 'checks: []\n'), { noRun: true });
  const msg = await api.approveCard(await api.writeCheck(args('D-1')));
  assert.match(msg, /did not run/i); assert.doesNotMatch(msg, /passed/);
  assert.deepEqual(w.ran, []);
});

// ---- starting the draft
test('startChecker uses the selected agent, or the llm, or the first agent, and says why when there is none', () => {
  const sel = world({ decisions: [dec('D-1', [])], agent: 'mock', acp: { claude: {}, mock: {} } });
  assert.equal(sel.api.startChecker('D-1'), 'started'); assert.equal(sel.AG.agent, 'mock'); assert.equal(sel.w.sent.length, 1);
  assert.equal(sel.w.role, 'grill');
  const llm = world({ decisions: [dec('D-1', [])], llm: true });
  assert.equal(llm.api.startChecker('D-1'), 'started'); assert.equal(llm.AG.agent, 'builtin');
  const first = world({ decisions: [dec('D-1', [])], acp: { claude: {} } });
  assert.equal(first.api.startChecker('D-1'), 'started'); assert.equal(first.AG.agent, 'claude');
  const none = world({ decisions: [dec('D-1', [])] });
  assert.equal(none.api.startChecker('D-1'), 'no-agent'); assert.deepEqual(none.w.sent, []);
  assert.match(none.w.toasts.join(), /D-1/); assert.match(none.w.toasts.join(), /Draft a check/);
});

test('startChecker while the agent is busy starts nothing and says why', () => {
  const b = world({ decisions: [dec('D-1', [])], agent: 'mock', acp: { mock: {} }, busy: true });
  assert.equal(b.api.startChecker('D-1'), 'busy'); assert.deepEqual(b.w.sent, []);
  assert.match(b.w.toasts.join(), /still answering/); assert.match(b.w.toasts.join(), /Draft a check/);
});

test('the prompt asks for write_check, Passes when and Fails when, and never tells a person to write the script', () => {
  const { api, w } = world({ decisions: [dec('D-1', [])], agent: 'mock', acp: { mock: {} } });
  api.draftCheck('D-1');
  assert.match(w.sent[0], /write_check/); assert.match(w.sent[0], /Passes when/); assert.match(w.sent[0], /Fails when/);
  assert.doesNotMatch(w.sent[0], /set_check/);
});

// ---- the bind hook and the buttons (source-level: app.js needs the DOM; e2e proves the behaviour)
const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
test('bindDecision starts the draft after the promotion, never for a bulk re-bind', () => {
  const body = APP.slice(APP.indexOf('async function bindDecision'), APP.indexOf('async function rebindAll'));
  const at = body.indexOf('startChecker(d.id)'), promoted = body.indexOf("recordEvent('decision_promoted'");
  assert.ok(at > promoted && promoted > 0, 'after the promotion is recorded');
  assert.match(body, /!confirmed\s*&&\s*needsChecker\(/, 'rebindAll passes confirmed:true and starts none');
});

test('the gate row and the decision card offer the button for every decision that needs a checker', () => {
  assert.match(APP, /offerChecker\(d\)/);
  assert.match(APP, /'Draft a check'/); assert.match(APP, /'Write the check'/);
});

test('every prompt stops leaving the script for a person', () => {
  for (const re of [/or a TODO naming the script still to write/, /write "TODO <what it must prove>" and say what script is needed/, /Replace it in the decision file/])
    assert.doesNotMatch(SRC + APP, re);
});

// ================= retry 1 =================
// ---- 1. save and run are two steps of one approval
const sav = (id = 'D-1', checks = [], text = file(id, 'checks: []\n'), o = {}) => setup(id, checks, text, o);
test('approveCard: apply saves, then run runs; a card without run behaves as before', async () => {
  const { api, w } = sav();
  const card = await api.writeCheck(args('D-1'));
  const out = await api.approveCard(card);
  assert.match(out, /Saved checks\/D-1\.sh/); assert.match(out, /passed/); assert.deepEqual(w.ran, ['D-1: bash ./checks/D-1.sh']);
  const plain = await api.approveCard({ apply: async () => 'done' });
  assert.equal(plain, 'done');
});
test('approveCard: a failed apply never runs, and its error is not rewritten', async () => {
  const { api, w } = sav();
  const card = await api.writeCheck(args('D-1'));
  w.files['checks/D-1.sh'] = 'made meanwhile';
  await assert.rejects(api.approveCard(card), /already exists/); assert.deepEqual(w.ran, []);
});
test('approveCard: a throw in run says saved, but could not run, never nothing written', async () => {
  const { api, w } = sav('D-1', [], file('D-1', 'checks: []\n'), { runThrows: 'boom' });
  const out = await api.approveCard(await api.writeCheck(args('D-1')));
  assert.match(out, /saved, but could not run: boom/i); assert.doesNotMatch(out, /nothing was written/i);
  assert.ok(w.files['checks/D-1.sh']);
});
test('approveCard: a failing run is reported as failed', async () => {
  const { api } = sav('D-1', [], file('D-1', 'checks: []\n'), { runOutcome: 'fail' });
  assert.match(await api.approveCard(await api.writeCheck(args('D-1'))), /FAILED/);
});
test('apply alone saves and does not run', async () => {
  const { api, w } = sav();
  await (await api.writeCheck(args('D-1'))).apply();
  assert.deepEqual(w.ran, []); assert.ok(w.files['checks/D-1.sh']);
});

// runTool from agent.js, with stubs: declined never runs; the waiting buttons are gone while the run is in progress.
function tool(card, approve) {
  const a = SRC.indexOf('async function runTool'), b = SRC.indexOf('function contextNote');
  const chips = []; let statusDuringRun = null, chip = null;
  const pend = new Promise(r => { tool.resolve = r; });
  const env = { roleCfg: () => ({ label: 'x' }), verdict: () => 'ask', AG: { agent: 'builtin' }, READERS: {}, renderAgent() {}, ledger() {},
    WRITERS: { write_check: async () => card }, approveCard: world({ decisions: [] }).api.approveCard, waitFor: c => { chip = c; return pend; } };
  const names = Object.keys(env);
  const runTool = new Function(...names, `${SRC.slice(a, b)}\nreturn runTool;`)(...names.map(n => env[n]));
  return { runTool, get chip() { return chip; }, items: chips };
}
test('runTool: declined never applies or runs; approved applies then runs with no waiting buttons', async () => {
  const log = [];
  const card = { title: 't', preview: '', apply: async () => { log.push('apply'); return 'saved'; }, run: async s => { log.push('run:' + t2.chip.status); return s + ' ran'; } };
  const t1 = tool(card); const c1 = { items: [] };
  const p1 = t1.runTool('grill', 'write_check', {}, c1); await new Promise(r => setImmediate(r));
  assert.equal(t1.chip.status, 'waiting'); tool.resolve(false);
  const r1 = await p1; assert.deepEqual(log, []); assert.equal(t1.chip.status, 'declined'); assert.equal(r1.ok, false);
  const t2 = tool(card); const c2 = { items: [] };
  const p2 = t2.runTool('grill', 'write_check', {}, c2); await new Promise(r => setImmediate(r)); tool.resolve(true);
  const r2 = await p2; assert.deepEqual(log, ['apply', 'run:applying']); assert.equal(r2.out, 'saved ran'); assert.equal(t2.chip.status, 'approved');
});
test('runTool: a card with no run behaves as before', async () => {
  const t = tool({ title: 't', preview: '', apply: async () => 'plain' }); const p = t.runTool('grill', 'write_check', {}, { items: [] });
  await new Promise(r => setImmediate(r)); tool.resolve(true); assert.equal((await p).out, 'plain');
});

// ---- 2. a stale pass for the same command is not this run's
test('a stale pass for the same cmd is not reported as this run; the ledger is reloaded as fresh objects', async () => {
  const old = [{ kind: 'check', decision: 'D-1', check: 'bash ./checks/D-1.sh', outcome: 'pass', _ts: 5 }];
  const { api } = sav('D-1', [], file('D-1', 'checks: []\n'), { noRun: true, ledger: old });
  const out = await api.approveCard(await api.writeCheck(args('D-1')));
  assert.match(out, /did not run/i); assert.doesNotMatch(out, /passed/);
  const ran = sav('D-1', [], file('D-1', 'checks: []\n'), { runOutcome: 'fail', ledger: old });
  assert.match(await ran.api.approveCard(await ran.api.writeCheck(args('D-1'))), /FAILED/);
});

// ---- 3. any TODO or empty, beside a runnable check too
test('a TODO beside a runnable check is drafted, replaces only the TODO, and reports the new check', async () => {
  const text = file('D-1', 'checks:\n  - "p check -tc a"\n  - "TODO ./checks/occ.sh: x"\n');
  const { api, w, A } = sav('D-1', ['p check -tc a', 'TODO ./checks/occ.sh: x'], text, { runOutcome: c => /occ/.test(c) ? 'fail' : 'pass' });
  const card = await api.writeCheck(args('D-1')); assert.ok(!card.error, card.error);
  const out = await api.approveCard(card);
  assert.deepEqual(Records.runs(A.decisions[0]), ['p check -tc a', 'bash ./checks/occ.sh']);
  assert.match(out, /FAILED/, 'the new check, not the other one that passed');
});
test('offerChecker: needsChecker, or any TODO on a live decision', () => {
  const { api } = world({ decisions: [] });
  assert.equal(api.offerChecker(dec('a', ['TODO', 'p check'])), true);
  assert.equal(api.offerChecker(dec('a', ['TODO x'], { kind: 'business' })), true);
  assert.equal(api.offerChecker(dec('a', ['TODO x'], { effect: 'accept' })), true);
  assert.equal(api.offerChecker(dec('a', ['TODO x'], { status: 'superseded' })), false);
  assert.equal(api.offerChecker(dec('a', ['p check'])), false);
  assert.equal(api.offerChecker(dec('a', [], { kind: 'business' })), false);
  assert.equal(api.offerChecker(dec('a', [])), true);
  assert.equal(api.needsChecker(dec('a', ['TODO', 'p check'])), false, 'auto-start on bind stays needsChecker only');
});

// ---- 4. replaceCheck never corrupts
const yl = require('js-yaml');
test('replaceCheck: { id: "TODO x", run: "TODO x" } keeps the id', () => {
  const { api } = world({ decisions: [] });
  const out = api.replaceCheck('id: D\nchecks:\n  - { id: "TODO x", run: "TODO x" }\n', 'TODO x', 'bash ./c.sh');
  assert.deepEqual(yl.load(out).checks, [{ id: 'TODO x', run: 'bash ./c.sh' }]);
});
test('replaceCheck: throws, writing nothing, when the only difference would not be this one run', () => {
  const { api } = world({ decisions: [] });
  assert.throws(() => api.replaceCheck('checks:\n  - { id: "TODO x", note: "TODO x" }\n', 'TODO x', 'bash ./c.sh'), /Nothing was written/);
  assert.throws(() => api.replaceCheck('checks:\n  - "a"\n', 'TODO x', 'bash ./c.sh'), /Nothing was written/);
});
// ---- 5. common YAML shapes
test('replaceCheck: zero-indent list, column-0 comment, plain flow scalars, flow maps, CRLF', () => {
  const { api } = world({ decisions: [] });
  const cmd = 'bash ./c.sh', run = (t, todo) => yl.load(api.replaceCheck(t, todo, cmd));
  assert.deepEqual(run('id: D\nchecks:\n- TODO x\nrationale: y\n', 'TODO x').checks, [cmd]);
  assert.deepEqual(run('checks:\n# note\n- p\n- TODO x\n', 'TODO x').checks, ['p', cmd]);
  assert.deepEqual(run('checks:\n  # note\n  - TODO x\n', 'TODO x').checks, [cmd]);
  assert.deepEqual(run('checks: [TODO]\n', 'TODO').checks, [cmd]);
  assert.deepEqual(run('checks: [TODO xy, TODO]\n', 'TODO').checks, ['TODO xy', cmd]);
  assert.deepEqual(run('checks: [a, TODO y]\n', 'TODO y').checks, ['a', cmd]);
  assert.deepEqual(run('checks:\n  - {run: TODO x, id: a}\n', 'TODO x').checks, [{ run: cmd, id: 'a' }]);
  assert.deepEqual(run('checks:\n  - {id: a, run: TODO x}\n', 'TODO x').checks, [{ id: 'a', run: cmd }]);
  assert.deepEqual(run('checks:\n- \nrationale: y\n', null).checks, [cmd]);
});
test('replaceCheck: inserted lines keep CRLF in a CRLF file', () => {
  const { api } = world({ decisions: [] });
  const a = api.replaceCheck('id: D\r\nchecks: []\r\nrationale: y\r\n', null, 'bash ./c.sh');
  assert.equal(a, 'id: D\r\nchecks:\r\n  - "bash ./c.sh"\r\nrationale: y\r\n');
  const b = api.replaceCheck('id: D\r\nstatus: b\r\n', null, 'bash ./c.sh');
  assert.equal(b, 'id: D\r\nstatus: b\r\nchecks:\r\n  - "bash ./c.sh"\r\n');
  const c = api.replaceCheck('id: D\r\nchecks: [] # c\r\n', null, 'bash ./c.sh');
  assert.equal(c, 'id: D\r\nchecks:   # c\r\n  - "bash ./c.sh"\r\n');
});

// ---- 6. scripts that cannot fail
test('scriptProblem refuses scripts that cannot fail (retry 1 list) and still accepts the ones that can', () => {
  const { api } = world({ decisions: [] });
  const no = ['grep -q a b || true', 'grep -q a b || :', 'grep -q a b || echo no', 'grep -q a b; true', 'false || true', 'echo exit 1',
    'set -e\ngrep -q a b || true', 'set -e\nset +e\ngrep -q a b\nexit 0', 'cat <<EOF\nexit 1\nEOF\nexit 0', "cat <<'EOF'\nfalse\nexit 2\nEOF\necho ok",
    'x=1', 'exit 00', 'exit 256', 'exec true', '(exit 1)\nexit 0', 'grep -q a b || {\n echo no\n}'];
  for (const s of no) assert.ok(api.scriptProblem(`#!/usr/bin/env bash\n${s}\n`), `refused: ${JSON.stringify(s)}`);
  const yes = ['test -f a && echo ok', 'for f in a b; do\n  grep -q x "$f" || exit 1\ndone', 'if grep -q a b; then\n  echo ok\nelse\n  exit 1\nfi',
    'case "$x" in\n  a) exit 0;;\n  *) exit 1;;\nesac', 'grep -q a b || {\n  echo no\n  exit "$rc"\n}', 'x=$(grep a b)', 'set -o errexit\ngrep a b\necho ok',
    'set -euo pipefail\ngrep a b\necho ok', 'echo x | grep -q y', '(exit 1)\nset -e\n(exit 1)', 'exit 255'];
  for (const s of yes) assert.equal(api.scriptProblem(`#!/usr/bin/env bash\n${s}\n`), null, `accepted: ${JSON.stringify(s)}`);
});

// ---- 7. Passes when / Fails when on one line
test('whenLines: both orders on one line, neither swallowed into the other', () => {
  const { api } = world({ decisions: [] });
  let w = api.whenLines('Checks X. Passes when: a');
  assert.deepEqual([w.passes, w.fails, w.rest], ['a', '', ['Checks X.']]);
  w = api.whenLines('Passes when: a. Fails when: b.'); assert.deepEqual([w.passes, w.fails], ['a.', 'b.']);
  w = api.whenLines('Fails when: b Passes when: a'); assert.deepEqual([w.passes, w.fails], ['a', 'b']);
  w = api.whenLines('Checks X. Fails when: b. Passes when: a'); assert.deepEqual([w.passes, w.fails, w.rest], ['a', 'b.', ['Checks X.']]);
  w = api.whenLines('Passes when: a\nFails when: b'); assert.deepEqual([w.passes, w.fails], ['a', 'b']);
});

// ---- 8. bind decides from the fresh decision
function bindWith(pre, fresh) {
  const a = APP.indexOf('async function bindDecision'), b = APP.indexOf('async function rebindAll');
  const started = [], decisions = [pre];
  const env = { Core: { bindProblems: () => [] }, A: { decisions, model: { elements: new Map() }, user: 'u', requirements: [] }, confirm: () => true, toast() {},
    editYaml: async () => { decisions[0] = fresh; }, setField: t => t, recordEvent: async () => {}, supersedeDecision: async () => {}, loadRegistry: async () => {},
    chooseRequirement: async () => null, startChecker: id => started.push(id), needsChecker: d => needsOf(d) };
  const { api } = world({ decisions: [] }); const needsOf = api.needsChecker;
  const names = Object.keys(env);
  const bind = new Function(...names, `${APP.slice(a, b)}\nreturn bindDecision;`)(...names.map(n => env[n]));
  return { bind, started };
}
test('bindDecision decides from the fresh decision, not the pre-bind object', async () => {
  const pre = dec('D-1', []), fresh = dec('D-1', ['p check -tc a']);
  const x = bindWith(pre, fresh); await x.bind(pre); assert.deepEqual(x.started, []);
  const pre2 = dec('D-2', ['p check']), fresh2 = dec('D-2', []);
  const y = bindWith(pre2, fresh2); await y.bind(pre2); assert.deepEqual(y.started, ['D-2']);
  const z = bindWith(pre2, fresh2); await z.bind(pre2, { confirmed: true }); assert.deepEqual(z.started, [], 'rebindAll starts none');
});

// ---- 9. the decision write fails after the script write
test('when the decision write fails after the script was saved, the error says so and what to do', async () => {
  const { api, w } = sav('D-1', [], file('D-1', 'checks: []\n'));
  const card = await api.writeCheck(args('D-1'));
  const orig = w.files; // fail only the decision file
  const hostWrite = Object.getOwnPropertyDescriptor; void hostWrite;
  w.failOn = 'decisions/D-1.yaml';
  await assert.rejects(card.apply(), e => /checks\/D-1\.sh was saved/.test(e.message) && /decision.*not changed/i.test(e.message) && /bash \.\/checks\/D-1\.sh/.test(e.message) && /delete|set/i.test(e.message));
  assert.ok(orig['checks/D-1.sh']);
});

// ---- 3 (buttons): the gate row shows the button for a TODO beside a runnable check, and for a business decision with a TODO
test('the gate row offers Write the check for needsChecker or any TODO on a live decision', () => {
  const a = APP.indexOf('function clauseActions'), b = APP.indexOf('\n}\n', a);
  const { api } = world({ decisions: [] });
  const mk = ds => new Function('A', 'Records', 'offerChecker', 'esc', 'decisionNote', 'evidenceHost', 'Core', `${APP.slice(a, b + 2)}\nreturn clauseActions;`)({ decisions: ds, diags: [] }, Records, api.offerChecker, x => x, () => '', () => null, {});
  const row = d => mk([d])({ kind: 'check', decision: d.id, text: `${d.id} has no result` });
  assert.match(row(dec('a', ['TODO ./checks/x.sh: y', 'p check'])), /data-wcheck/);
  assert.match(row(dec('a', ['TODO y'], { kind: 'business' })), /data-wcheck/);
  assert.match(row(dec('a', ['TODO y'], { effect: 'accept' })), /data-wcheck/);
  assert.doesNotMatch(row(dec('a', ['p check'])), /data-wcheck/);
});
