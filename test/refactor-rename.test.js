// L2 slice 3: Refactor.renamePlan. Rename updates every reference, proves it changed only the name, and never touches a promoted_against hash.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');
const Refactor = require('../renderer/refactor.js');
const { renameRegistry, stateOf, applyEdits, write, read } = require('./helpers/l2-registry.js');

const W = 'model/workspace.dsl';
const plan = (dir, rel, line0, character, newName, overlay) => { const st = stateOf(dir, overlay); return Refactor.renamePlan({ files: st.files, cfgModel: st.cfgModel, at: { path: rel, line0, character }, newName }); };
const hashes = files => Object.entries(files).filter(([p]) => /^decisions\//.test(p)).map(([p, t]) => [p, (t.match(/"hash":"[^"]*"/g) || [])]);
const sub = (t, from, to) => t.split(from).join(to);
const keyed = (edits) => edits.map(e => `${e.path}:${e.range.line0 + 1}:${e.range.c}`);
function onDisk(dir, edits) {
  const st = stateOf(dir), after = applyEdits(st.files, edits);
  for (const e of new Set(edits.map(x => x.path))) fs.writeFileSync(path.join(dir, e), after[e]);
  return stateOf(dir);
}
const promotionClauses = s => s.gate.clauses.filter(c => c.kind === 'promotion').map(c => c.text);

test('name rename: edits, one renamedFrom, gate unchanged except the existing "changed since promotion" clause', () => {
  const dir = renameRegistry(), before = stateOf(dir);
  const p = plan(dir, W, 52, 30, 'Booking Store');
  assert.equal(p.error, undefined, p.error);
  assert.deepEqual([p.kind, p.from, p.to], ['name', 'Bookings DB', 'Booking Store']);
  assert.deepEqual(keyed(p.edits).sort(), [`decisions/D-0001.yaml:5:8`, `decisions/accept-escalations.yaml:13:48`, `decisions/accept-escalations.yaml:6:8`, `requirements/DEMO-1234.yaml:5:11`, 'scenarios/s1.yaml:4:10', `work/W-1.yaml:3:11`, `${W}:53:27`].sort());
  assert.ok(p.edits.every(e => !/^handovers\//.test(e.path)));
  assert.equal(p.edits.find(e => e.path === W).newText, '"Booking Store"');
  assert.equal(p.edits.find(e => e.path === 'work/W-1.yaml').newText, 'Booking Store');
  // fix-api's hash does not belong to the renamed element: its reference text is not touched
  assert.ok(!p.edits.some(e => e.path === 'decisions/fix-api.yaml' || e.path === 'decisions/old.yaml'));
  assert.deepEqual(p.rebind.map(r => r.decision).sort(), ['accept-escalations', 'fix-api']);
  for (const e of p.edits) assert.ok(!('restamp' in e));

  const after = onDisk(dir, p.edits);
  assert.deepEqual(hashes(after.files), hashes(before.files), 'no hash value was touched');
  const norm = c => sub(c.text, 'Bookings DB', 'Booking Store');
  const was = before.s.gate.clauses.map(norm), now = after.s.gate.clauses.map(c => c.text);
  for (const t of was) assert.ok(now.includes(t), `clause kept: ${t}`);
  const added = after.s.gate.clauses.filter(c => !was.includes(c.text));
  assert.deepEqual(added.map(c => c.text).sort(), ['accept-escalations: Booking Store changed since promotion', 'fix-api: Fares API changed since promotion']);
  assert.ok(added.every(c => c.kind === 'promotion'));
  assert.ok(promotionClauses(before.s).includes('old: Fares API changed since promotion') && promotionClauses(after.s).includes('old: Fares API changed since promotion'));
  assert.deepEqual(after.s.diags.map(d => [d.code, d.sev]), before.s.diags.map(d => [d.code, d.sev]));
  assert.ok(!after.s.gate.clauses.some(c => /^DC002 on/.test(c.text)), 'DC002 stays covered by accept-escalations');
  const d = Core.diffModels(before.model, after.model);
  assert.deepEqual(d.elements.map(e => [e.change, e.renamedFrom]), [['changed', 'Bookings DB']]);
  assert.deepEqual(d.rels, []);
});

test('identifier rename: DSL sites and promoted_against.element only; only neighbours go stale', () => {
  const dir = renameRegistry(), before = stateOf(dir);
  const p = plan(dir, W, 52, 8, 'bookingsDb');
  assert.equal(p.error, undefined, p.error);
  assert.equal(p.kind, 'ident');
  assert.deepEqual(keyed(p.edits).sort(), [`${W}:103:19`, `${W}:53:6`, `${W}:76:11`, 'decisions/accept-escalations.yaml:13:30'].sort());
  assert.ok(p.edits.every(e => e.newText === 'bookingsDb' || e.newText === '"bookingsDb"'));
  const after = onDisk(dir, p.edits);
  assert.deepEqual(hashes(after.files), hashes(before.files));
  const was = before.s.gate.clauses.map(c => c.text);
  const added = after.s.gate.clauses.filter(c => !was.includes(c.text));
  assert.deepEqual(added.map(c => c.text), ['fix-api: Fares API changed since promotion']);
  assert.equal(Core.diffModels(before.model, after.model).elements.length, 0);
  assert.equal(after.model.elements.get('bookingsDb').name, 'Bookings DB');
  assert.equal(after.s.diags.length, before.s.diags.length);
});

test('identifier rename on the include registry edits the two model files only', () => {
  const dir = renameRegistry({ includes: true });
  const st = stateOf(dir);
  const def = st.model.symbols.defs.find(d => d.ident === 'bookings').identAt;
  const p = Refactor.renamePlan({ files: st.files, cfgModel: st.cfgModel, at: { path: def.file, line0: def.line - 1, character: def.c + 1 }, newName: 'bookingsDb' });
  assert.equal(p.error, undefined, p.error);
  assert.deepEqual([...new Set(p.edits.map(e => e.path))].sort(), ['decisions/accept-escalations.yaml', 'model/fares/workers.dsl', 'model/relationships.dsl']);
  assert.equal(p.edits.filter(e => /\.dsl$/.test(e.path)).length, 3);
  const after = onDisk(dir, p.edits);
  assert.deepEqual(after.model.errors, []);
});

test('refusals give a reason and no partial plan', () => {
  const dir = renameRegistry();
  const at = (line0, ch) => [W, line0, ch];
  const name = (nm, pos = at(52, 30)) => plan(dir, ...pos, nm);
  assert.match(name('Fares API').error, /already|clash|another element/i);
  assert.match(name('').error, /empty/i);
  assert.match(name('a\nb').error, /newline/i);
  assert.match(name('bookings db', at(47, 30)).error, /sibling|same as/i);
  for (const id of ['api', 'container', 'views', '9x', 'a.b']) assert.ok(plan(dir, W, 52, 8, id).error, id);
  assert.match(plan(dir, W, 52, 8, 'api').error, /already/);
  assert.match(plan(dir, W, 52, 8, 'container').error, /reserved/);
  assert.match(plan(dir, W, 52, 8, '9x').error, /identifier/);
  assert.match(plan(dir, W, 72, 3, 'x').error, /nothing to rename|not on/i); // inside a string
  assert.match(plan(dir, 'handovers/h1/decisions/frozen.yaml', 1, 10, 'Store').error, /handovers/);
  // a parse error
  const broken = plan(dir, W, 52, 8, 'bookingsDb', { [W]: read(dir, W) + '\n}}}\n' });
  assert.match(broken.error, /fix the \d+ model errors? first/);
  // unscannable YAML that mentions the name
  write(dir, 'decisions/anchor.yaml', 'id: anchor\nbinds:\n  - &x Bookings DB\n');
  assert.match(plan(dir, W, 52, 30, 'Booking Store').error, /decisions\/anchor.yaml: binds is written in a form designc cannot edit safely/);
});

test('a dotted identifier in the model refuses an identifier rename', () => {
  const dir = renameRegistry();
  const text = read(dir, W).replace(/views \{/, 'views {\n    systemContext fares { include bookings.db }').replace('  }\n}', '  }\n}');
  const src = read(dir, W);
  const withViews = src.includes('views {') ? text : src.replace(/\n}\s*$/, '\n  views { systemContext fares { include bookings.db } }\n}\n');
  const p = plan(dir, W, 52, 8, 'bookingsDb', { [W]: withViews });
  assert.match(p.error, /dotted|hierarchical|bookings\.db/);
});

test('newName equal to the old one gives no edits', () => {
  const dir = renameRegistry();
  const p = plan(dir, W, 52, 30, 'Bookings DB');
  assert.equal(p.error, undefined);
  assert.deepEqual(p.edits, []);
});

test('quoting: a name needing YAML quotes is written quoted and js-yaml reads it back', () => {
  const dir = renameRegistry();
  const p = plan(dir, W, 52, 30, 'Bookings: DB');
  assert.equal(p.error, undefined, p.error);
  assert.equal(p.edits.find(e => e.path === 'decisions/D-0001.yaml').newText, '"Bookings: DB"');
  assert.equal(p.edits.find(e => e.path === 'work/W-1.yaml').newText, '"Bookings: DB"');
  const after = onDisk(dir, p.edits);
  assert.deepEqual(yaml.load(after.files['decisions/D-0001.yaml']).binds, ['Bookings: DB']);
  assert.deepEqual(yaml.load(after.files['work/W-1.yaml']).elements, ['Bookings: DB']);
  assert.equal(after.model.elements.get('bookings').name, 'Bookings: DB');
  const pa = yaml.load(after.files['decisions/accept-escalations.yaml']).promoted_against[0];
  assert.deepEqual([pa.element, pa.name], ['bookings', 'Bookings: DB']);
});
