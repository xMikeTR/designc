'use strict';
// Headless core (intelligence plane phase 3): verdict query, context bundle, derived SQLite index, CLI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Verdicts = require('../renderer/verdicts.js');
const H = require('../headless/index.js');
const Store = require('../headless/store.js');
const Cli = require('../scripts/designc-core.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'core-registry');
const HO = '20261102-abcd1234';
const v = (id, o) => ({ path: `verdicts/${id}.yaml`, rec: { id, status: 'bound', ...o } });
const scratch = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-core-')); fs.cpSync(FIX, d, { recursive: true }); return d; };

test('verdict query: agreement, conflict, stale, proposed and invalid ignored', () => {
  const verdicts = [
    v('a', { verdict: 'matched', scope: ['el:UI', 'ui:list'], evidence: 'r1', commit: 'c1' }),
    v('b', { verdict: 'matched', scope: ['el:UI'], evidence: ['r2'] }),
    v('c', { verdict: 'diverged', scope: ['ui:list'], commit: 'c1' }),
    v('d', { verdict: 'matched', scope: ['el:API'], commit: 'c0' }),
    v('e', { verdict: 'diverged', scope: ['el:API'], status: 'proposed' }),
    v('f', { verdict: 'diverged', scope: ['el:UI'], commit: 1111111 }),
  ];
  const r = Verdicts.query({ verdicts, items: [] }, { scope: { elements: ['UI', 'API'] }, commit: 'c1' });
  const by = Object.fromEntries(r.nodes.map(n => [n.node_id, n]));
  assert.deepEqual(r.nodes.map(n => n.node_id), ['el:UI', 'el:API', 'ui:list']);
  assert.equal(by['el:UI'].verdict, 'matched');
  assert.deepEqual(by['el:UI'].evidence, ['r1', 'r2']);
  assert.equal(by['ui:list'].verdict, null);
  assert.deepEqual(by['ui:list'].conflict, ['a: matched', 'c: diverged']);
  assert.equal(by['el:API'].verdict, null);
  assert.deepEqual(by['el:API'].stale, ['d']);
  assert.deepEqual(r.invalid.map(x => x.path), ['verdicts/f.yaml']);
  assert.match(r.invalid[0].errors.join(), /commit/);
  // without a commit every bound verdict counts
  assert.equal(Verdicts.query({ verdicts, items: [] }, { scope: { elements: ['API'] } }).nodes[0].verdict, 'matched');
  assert.deepEqual(Verdicts.summary(r), { matched: 1, diverged: 0, accepted: 0, none: 1, conflict: 1 });
});

test('verdict query: work item scope and errors', () => {
  const items = [{ id: 'W-1', elements: ['UI'] }, { id: 'W-2', target: { document: 'x' } }];
  assert.deepEqual(Verdicts.query({ verdicts: [], items }, { scope: { work_item: 'W-1' } }).nodes.map(n => n.node_id), ['el:UI']);
  assert.match(Verdicts.query({ verdicts: [], items }, { scope: { work_item: 'W-9' } }).error, /no work item W-9/);
  assert.match(Verdicts.query({ verdicts: [], items }, { scope: { work_item: 'W-2' } }).error, /names no elements/);
  assert.match(Verdicts.query({ verdicts: [], items }, {}).error, /scope is/);
});

test('fixture verdicts at 1111111', () => {
  const r = H.verdicts(H.open(FIX), { scope: { work_item: 'W-tags' }, commit: '1111111' });
  assert.deepEqual(r.invalid, []);
  const by = Object.fromEntries(r.nodes.map(n => [n.node_id, n]));
  assert.ok(by['el:Tags/Tags UI'].conflict);
  assert.deepEqual(by['el:Tags/Tags API'].stale, ['v-api-old']);
  assert.equal(by['ui:tags/list'].verdict, 'matched');
  assert.ok(by['ui:tags/list/date'].conflict);
});

test('element refs: hierarchical id or a unique name meet on one node; a shared name is refused', () => {
  const d = scratch();
  try {
    const r = H.verdicts(H.open(d), { scope: { elements: ['Tags/Tags UI'] }, commit: '1111111' });
    assert.equal(r.nodes[0].node_id, 'el:Tags/Tags UI');
    assert.equal(r.nodes[0].name, 'Tags UI');
    assert.ok(r.nodes[0].conflict, 'verdicts written as el:Tags UI count on el:Tags/Tags UI');
    const b = H.bundle(H.open(d), { elements: ['Tags API', 'Tags/Tags API'], role: 'implementer' });
    assert.deepEqual(b.key.elements, ['Tags/Tags API']);
    assert.deepEqual(b.decisions[0].scope, ['el:Tags/Tags API']);
    const f = path.join(d, 'model', 'workspace.dsl');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('  }\n}', '    o = softwareSystem "Other" { odb = container "Tags DB" }\n  }\n}'));
    assert.match(H.bundle(H.open(d), { elements: ['Tags DB'], role: 'implementer' }).error, /give the id System\/Container when a name is shared\): Tags DB/);
    assert.deepEqual(H.bundle(H.open(d), { elements: ['Other/Tags DB'], role: 'implementer' }).key.elements, ['Other/Tags DB']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('canonical JSON sorts keys and drops undefined', () => {
  assert.equal(H.canonical({ b: 1, a: [{ d: null, c: 'x' }], u: undefined }), '{"a":[{"c":"x","d":null}],"b":1}');
});

test('bundle: pinned example, determinism, handover copies', () => {
  const reg = H.open(FIX, { handover: HO });
  const args = { work_item: 'W-tags', task: 'T-1', role: 'builder', commit: '1111111', jira: ['DEMO-7'] };
  const b = H.bundle(reg, args);
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'context-bundle.example.json'), 'utf8'));
  assert.deepEqual(b, example);
  assert.equal(H.bundle(H.open(FIX, { handover: HO }), args).bundle_id, b.bundle_id);
  const { bundle_id, ...body } = b;
  assert.equal(bundle_id, `sha256:${require('crypto').createHash('sha256').update(H.canonical(body)).digest('hex')}`);
  assert.equal(b.revision, 'r-0badc0de');
  // the handover froze only sort-server-side; the registry also has db-unique on Tags DB (out of scope) and a draft
  assert.deepEqual(b.decisions.map(d => d.id), ['sort-server-side']);
  // role changes the id
  assert.notEqual(H.bundle(reg, { ...args, role: 'reviewer' }).bundle_id, b.bundle_id);
});

test('bundle changes when a decision changes, and refuses bad input', () => {
  const d = scratch();
  try {
    const args = { elements: ['Tags API'], role: 'builder' };
    const before = H.bundle(H.open(d), args).bundle_id;
    const f = path.join(d, 'decisions', 'sort-server-side.yaml');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('not the browser', 'never the browser'));
    assert.notEqual(H.bundle(H.open(d), args).bundle_id, before);
    assert.match(H.bundle(H.open(d), { elements: ['Nope'], role: 'builder' }).error, /not elements of the model.*: Nope/);
    assert.match(H.bundle(H.open(d), { elements: ['Tags API'] }).error, /role is required/);
    assert.match(H.bundle(H.open(d), { role: 'builder' }).error, /name the elements/);
    assert.match(H.open(d, { handover: '../x' }).error, /not a handover id/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('index: build, search with FTS syntax kept out, inbound links', () => {
  const d = scratch();
  try {
    const b = Store.build(H.open(d));
    assert.equal(b.error, undefined);
    assert.ok(b.records > 5);
    assert.equal(fs.readFileSync(path.join(d, '.designc', '.gitignore'), 'utf8'), '*\n');
    assert.ok(Store.search(d, 'sort').hits.some(h => h.id === 'sort-server-side'));
    assert.deepEqual(Store.search(d, 'sort" OR id:* NEAR(').hits, []);
    assert.equal(Store.ftsQuery('a "b'), '"a"* """b"*');
    const ui = Store.inbound(d, 'el:Tags UI');
    assert.ok(ui.scoped_by.includes('v-tags-list-order'));
    assert.deepEqual(Store.inbound(d, 'old-sort').superseded_by, ['sort-server-side']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  assert.match(Store.search(os.tmpdir(), 'x').error, /no index yet/);
});

test('CLI: arguments, exit codes, --out never overwrites', async () => {
  assert.throws(() => Cli.parseArgs(['verdicts', '--registry', 'x']), /--item or --element/);
  assert.throws(() => Cli.parseArgs(['bundle', '--registry', 'x']), /--role/);
  assert.throws(() => Cli.parseArgs(['nope']), /unknown command/);
  assert.throws(() => Cli.parseArgs(['index', '--registry']), /needs a value/);
  const out = [], err = [];
  const io = { log: s => out.push(s), err: s => err.push(s) };
  assert.equal(await Cli.main(['verdicts', '--registry', FIX, '--item', 'W-tags', '--json'], io), 0);
  assert.ok(JSON.parse(out.pop()).nodes.length >= 2);
  assert.equal(await Cli.main(['verdicts', '--registry', FIX, '--item', 'W-9'], io), 2);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-bundle-'));
  try {
    const f = path.join(tmp, 'b.json');
    const a = ['bundle', '--registry', FIX, '--handover', HO, '--item', 'W-tags', '--role', 'builder', '--out', f];
    assert.equal(await Cli.main(a, io), 0);
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).schema, 'designc.context.bundle/1');
    assert.equal(await Cli.main(a, io), 2);
    assert.match(err.pop(), /never overwritten/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
