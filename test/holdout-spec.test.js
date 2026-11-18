'use strict';
// designc-core holdout-spec (D5 slice 6): the spec for one holdout case, from the registry, for the Factory. Never in a handover.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');
const Cli = require('../scripts/designc-core.js');
const { HOLDOUT_GIVEN, HOLDOUT_THEN, fixture, inputs } = require('./helpers/handover-ui.js');

function registry() {
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-hold-'));
  fs.mkdirSync(path.join(dir, 'model')); fs.mkdirSync(path.join(dir, 'acceptance'));
  fs.writeFileSync(path.join(dir, 'model/workspace.dsl'), f.modelText);
  for (const c of f.criteria) { const doc = { ...c }; for (const k of Object.keys(doc)) if (k.startsWith('_')) delete doc[k]; fs.writeFileSync(path.join(dir, c._path), yaml.dump(doc)); }
  return { dir, f };
}
const snapshot = d => fs.readdirSync(d, { recursive: true }).sort().join('\n');
const run = async argv => { const out = [], err = []; const code = await Cli.main(argv, { log: s => out.push(s), err: s => err.push(s) }); return { code, out: out.join('\n'), err: err.join('\n') }; };

test('holdout-spec prints the generated spec for one holdout case, with the hash the handover names, and writes nothing', async () => {
  const { dir, f } = registry();
  try {
    const before = snapshot(dir);
    const r = await run(['holdout-spec', '--registry', dir, '--criterion', 'AC-UI-1', '--case', '4']);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(HOLDOUT_GIVEN) || r.out.includes('Quillfeather') || r.out.includes(HOLDOUT_THEN), 'the Factory gets the holdout case');
    assert.match(r.out, /test\(/);
    const j = JSON.parse((await run(['holdout-spec', '--registry', dir, '--criterion', 'AC-UI-1', '--case', '4', '--json'])).out);
    assert.equal(j.sha256, Core.holdoutCaseHash(f.criteria[0].cases[4]));
    assert.equal(j.state, 'ready');
    assert.equal(j.spec.replace(/\n$/, ''), r.out);
    assert.equal(snapshot(dir), before, 'nothing written');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('holdout-spec refuses a visible case, a missing case or criterion, and a bad index; the same text is never in the handover', async () => {
  const { dir, f } = registry();
  try {
    for (const [args, re] of [[['--criterion', 'AC-UI-1', '--case', '0'], /not a holdout case/], [['--criterion', 'AC-UI-1', '--case', '9'], /no case 9/], [['--criterion', 'NOPE', '--case', '0'], /no acceptance criterion NOPE/], [['--criterion', 'AC-UI-1', '--case', 'x'], /case index/]]) {
      const r = await run(['holdout-spec', '--registry', dir, ...args]);
      assert.equal(r.code, 2); assert.match(r.err, re);
    }
    assert.throws(() => Cli.parseArgs(['holdout-spec', '--registry', dir, '--criterion', 'AC-UI-1']), /--criterion and --case/);
    const p = Core.handoverPlan(inputs(f));
    for (const file of p.files) assert.ok(!file.text.includes(HOLDOUT_THEN) && !file.text.includes('Quillfeather'), file.path);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
