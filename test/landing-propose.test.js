// S4 T: what propose_landing may write. The refusals are decided here, in code, never by the prompt (D5): requirement missing,
// a person's note already there, a node that is new, a high-risk area (via the requirement's elements, a proposed node's
// design element, or an ancestor), a requirement with no elements.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');
const Landing = require('../renderer/landing.js');

const sync = '{ properties { "d.interaction" "sync" } }';
const body = (sysProps = '', apiProps = '') => `workspace "T" { model {
 s = softwareSystem "S" {
  ${sysProps}
  api = container "Api" "" ".NET" {
    ${apiProps}
    orders = component "Orders"
  }
  db = container "Db" "" "SQL" "Database"
 }
 orders -> db "w" "SQL" ${sync}
}}`;
const BUILT_ONLY = body().replace(' db = container', ' extra = container "Extra" "" "Go" { ex = component "Ex" }\n  db = container');
function world({ design = body(), built = BUILT_ONLY } = {}) {
  const dm = Core.parse(design), bm = Core.parse(built);
  const drift = Core.driftModels(Core.atLevel(dm, 'container'), Core.atLevel(bm, 'container'));
  return { model: dm, idx: Landing.buildIndex(bm, {}), toDesign: drift.toDesign };
}
const REQS = [{ id: 'R-1', elements: ['Api'] }, { id: 'R-2', elements: [] }, { id: 'R-3' }, { id: 'R-4', elements: ['Db'] }];
const ARGS = { requirement: 'R-1', entry: { kind: 'action', node: 'Api' }, path: [{ stage: 'api', node: 'Api' }, { stage: 'store', node: 'Db' }], changes: [{ node: 'Api/Orders', what: 'filter' }] };
const check = (args = ARGS, o = {}) => { const w = o.world || world(); return Landing.proposalCheck(args, { requirements: REQS, idx: w.idx, model: w.model, toDesign: w.toDesign, existing: null, ledger: [], ...o, world: undefined }); };

test('a good proposal becomes an agent note, proposed, with a copy of its content and no approval', () => {
  const r = check();
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.record.author, 'agent'); assert.equal(r.record.status, 'proposed');
  assert.deepEqual(r.record.approved, {});
  assert.deepEqual(r.record.proposed, { entry: ARGS.entry, path: ARGS.path, changes: ARGS.changes, principle: null });
  assert.deepEqual(r.record.correction, {});
  assert.deepEqual(Landing.validate(r.record, { file: 'landings/R-1.yaml' }), []);
  assert.equal(Landing.corrected(r.record), false);
});

test('the arguments can never set status, author or approved', () => {
  const r = check({ ...ARGS, status: 'approved', author: 'human', approved: { by: 'mike', hash: 'x' }, correction: { proposal: 'x' } });
  assert.equal(r.record.status, 'proposed'); assert.equal(r.record.author, 'agent');
  assert.deepEqual(r.record.approved, {}); assert.deepEqual(r.record.correction, {});
});

test('1: the requirement must be in the registry', () => {
  assert.match(check({ ...ARGS, requirement: 'R-9' }).error, /R-9 is not in the registry/);
});

test('2: a person has drawn this one: a human note, or an approved one, blocks it; an agent note does not', () => {
  const human = { ...check().record, author: 'human' };
  assert.match(check(ARGS, { existing: human }).error, /a person has drawn this one/);
  const agent = check().record;
  assert.equal(check(ARGS, { existing: agent }).error, undefined);
  const approved = Landing.prepareApprove({ rec: agent, loadedText: 'x', currentText: 'x', yaml, file: 'landings/R-1.yaml', by: 'm', at: 't', model: world().model }).record;
  const row = { kind: 'landing_approved', requirement: 'R-1', hash: approved.approved.hash };
  assert.match(check(ARGS, { existing: approved, ledger: [row] }).error, /a person has drawn this one/);
});

test('3: every node must be on the code map; a new one is refused', () => {
  assert.match(check({ ...ARGS, changes: [{ node: 'Api/Nope', what: 'x' }] }).error, /Api\/Nope is new: draw this one yourself/);
  assert.match(check({ ...ARGS, path: [{ stage: 'api', node: 'Brand.New' }] }).error, /Brand\.New is new: draw this one yourself/);
  assert.match(check({ ...ARGS, entry: { kind: 'action', node: 'Gone/X' } }).error, /Gone\/X is new/);
});

test('4: a requirement with no elements is refused: map it first', () => {
  assert.match(check({ ...ARGS, requirement: 'R-2' }).error, /map the requirement first/);
  assert.match(check({ ...ARGS, requirement: 'R-3' }).error, /map the requirement first/);
});

test('D5: a high-risk element of the requirement refuses the proposal, even for a low-risk node', () => {
  const w = world({ design: body('', 'properties { "d.risk" "high" "d.code" "src/**" }') });
  assert.match(check({ ...ARGS, requirement: 'R-1', path: [{ stage: 'store', node: 'Db' }], changes: [{ node: 'Db', what: 'x' }], entry: { kind: 'action', node: 'Db' } }, { world: w }).error, /Api is high-risk: draw this one yourself/);
});

test('D5: a high-risk ancestor of a requirement element refuses it', () => {
  const w = world({ design: body('properties { "d.risk" "high" "d.code" "src/**" }') });
  assert.match(check({ ...ARGS, requirement: 'R-4', entry: { kind: 'action', node: 'Db' }, path: [{ stage: 'store', node: 'Db' }], changes: [{ node: 'Db', what: 'x' }] }, { world: w }).error, /S is high-risk: draw this one yourself/);
});

test('D5: a proposed node whose design element is high-risk refuses it, with a requirement that is not', () => {
  const w = world({ design: body().replace('db = container "Db" "" "SQL" "Database"', 'db = container "Db" "" "SQL" "Database" { properties { "d.risk" "high" "d.code" "db/**" } }') });
  const r = check({ ...ARGS, requirement: 'R-1' }, { world: w });
  assert.match(r.error, /Db is high-risk: draw this one yourself/);
});

test('D5: a node whose container maps to no design element counts as new', () => {
  const r = check({ ...ARGS, changes: [{ node: 'Extra/Ex', what: 'x' }] });
  assert.match(r.error, /Extra\/Ex is new: draw this one yourself/);
});

test('the refusals come in the documented order: requirement, person, new node, then risk', () => {
  const w = world({ design: body('', 'properties { "d.risk" "high" "d.code" "src/**" }') });
  const human = { ...check().record, author: 'human' };
  assert.match(check({ ...ARGS, requirement: 'R-9' }, { world: w, existing: human }).error, /not in the registry/);
  assert.match(check(ARGS, { world: w, existing: human }).error, /a person has drawn/);
  assert.match(check({ ...ARGS, changes: [{ node: 'Api/Nope', what: 'x' }] }, { world: w }).error, /is new/);
  assert.match(check(ARGS, { world: w }).error, /high-risk/);
});

test('the tools: propose_landing and review_landing are Grill-me only, behind ask, with no status, author or approved parameter', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'agent.js'), 'utf8').split('\n');
  const roleLine = key => src.find(l => l.startsWith(`  ${key}: { label:`));
  for (const k of ['architect', 'analyst', 'tutor']) assert.equal(/propose_landing|review_landing/.test(roleLine(k)), false, k);
  assert.match(roleLine('grill'), /ask: \[[^\]]*'propose_landing'[^\]]*'review_landing'|ask: \[[^\]]*'review_landing'[^\]]*'propose_landing'/);
  assert.match(roleLine('grill'), /ask: \[[^\]]*'map_requirement'/, 'map_requirement stays');
  const obj = (props, req = []) => ({ type: 'object', properties: props, required: req, additionalProperties: false });
  const pick = n => src.find(l => l.startsWith(`  ${n}: { d:`));
  const tools = new Function('obj', `return {${pick('propose_landing')}\n${pick('review_landing')}}`)(obj);
  assert.deepEqual(Object.keys(tools.propose_landing.p.properties).sort(), ['changes', 'entry', 'path', 'principle', 'requirement']);
  assert.deepEqual(tools.propose_landing.p.required, ['requirement', 'entry', 'path', 'changes']);
  assert.deepEqual(Object.keys(tools.review_landing.p.properties).sort(), ['findings', 'requirement']);
  for (const t of Object.values(tools)) assert.equal(/status|author|approved/.test(JSON.stringify(Object.keys(t.p.properties))), false);
});

test('a direct agent write to landings/ is still refused by policy (landing-policy.test.js holds it for every role)', () => {
  const Policy = require('../renderer/policy.js');
  assert.equal(Policy.writeVerdict('grill', 'landings/R-1.yaml', 'requirement: R-1\nauthor: agent\n', yaml.load).ok, false);
});

test('review_landing: only for an existing note, with findings that have text; the review is tied to the note\'s hash', () => {
  const rec = check().record;
  assert.match(Landing.reviewCheck({ requirement: 'R-1', findings: [{ text: 'x' }] }, { existing: null }).error, /no landing note for R-1/i);
  assert.match(Landing.reviewCheck({ requirement: 'R-1', findings: [] }, { existing: rec }).error, /findings/);
  assert.match(Landing.reviewCheck({ requirement: 'R-1', findings: [{ node: 'Api' }] }, { existing: rec }).error, /text/);
  const ok = Landing.reviewCheck({ requirement: 'R-1', findings: [{ node: 'Api', text: 'check the filter' }, { text: 'general' }] }, { existing: rec });
  assert.deepEqual(ok.review, { hash: Landing.contentHash(rec), findings: [{ node: 'Api', text: 'check the filter' }, { text: 'general' }] });
  assert.equal(Landing.reviewFor({ R1: 1 }, 'R-1', rec), null);
  assert.deepEqual(Landing.reviewFor({ 'R-1': ok.review }, 'R-1', rec), ok.review.findings);
  assert.equal(Landing.reviewFor({ 'R-1': ok.review }, 'R-1', { ...rec, changes: [] }), null, 'an edit hides a stale review');
});
