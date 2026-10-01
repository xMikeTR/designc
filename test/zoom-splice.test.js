const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const BUILT = `workspace "x (as built)" {
  model {
    sys = softwareSystem "Shop" {
      e_fn = container "Shop.Functions" "" "Azure Functions" {
        f_app = component "App shell" "" "composition root"
        f_ord = component "OrderFunctions" "" "function class"
      }
      e_ui = container "ui" "" "React SPA" {
        u_api = component "api" "" ""
      }
    }
    f_ord -> f_app "Uses" "" { properties { "d.interaction" "sync" } }
    u_api -> f_ord "Calls" "HTTP" { properties { "d.interaction" "sync" } }
  }
}`;
const DESIGN = `workspace "d" {
  model {
    sys = softwareSystem "Shop" {
      fn = container "Shop.Functions" {
        description "Back office"
      }
      ui = container "ui"
    }
    ui -> fn "Calls"
  }
}`;
const lines = t => t.split('\n');
const splice = (text, builtName, designName, built = Core.parse(BUILT)) => {
  const design = Core.parse(text);
  const pick = (m, n) => [...m.elements.values()].find(e => e.name === n);
  return Core.spliceComponents(text, design, pick(design, designName).id, built, pick(built, builtName).id);
};

test('adopting a container\'s components inserts them into its block', () => {
  const r = splice(DESIGN, 'Shop.Functions', 'Shop.Functions');
  assert.equal(r.error, undefined);
  const out = lines(r.text), orig = lines(DESIGN);
  // original lines are all kept, in order
  let at = 0; for (const l of orig) { at = out.indexOf(l, at); assert.notEqual(at, -1, l); at++; }
  const added = out.filter(l => !orig.includes(l));
  assert.deepEqual(added, [
    '        f_app = component "App shell" "" "composition root"',
    '        f_ord = component "OrderFunctions" "" "function class"',
    '        f_ord -> f_app "Uses" "" { properties { "d.interaction" "sync" } }',
  ]);
  const m = Core.parse(r.text);
  assert.deepEqual(m.errors, []);
  const d = Core.driftComponents(m, Core.parse(BUILT));
  assert.deepEqual([...d.scored].map(id => Core.parse(BUILT).elements.get(id).name), ['Shop.Functions']);
  assert.deepEqual(d.unknownEls, []);
  assert.deepEqual(d.missingEls, []);
});

test('a container without a block gets one and idents never collide', () => {
  const design = `workspace "d" {
  model {
    sys = softwareSystem "Shop" {
      f_app = container "Other"
      fn = container "Shop.Functions" "d" "Azure Functions"
      ui = container "ui"
    }
  }
}`;
  const r = splice(design, 'Shop.Functions', 'Shop.Functions');
  assert.equal(r.error, undefined);
  const out = lines(r.text);
  const i = out.indexOf('      fn = container "Shop.Functions" "d" "Azure Functions" {');
  assert.notEqual(i, -1);
  assert.deepEqual(out.slice(i + 1, i + 5), [
    '        f_app_2 = component "App shell" "" "composition root"',
    '        f_ord = component "OrderFunctions" "" "function class"',
    '        f_ord -> f_app_2 "Uses" "" { properties { "d.interaction" "sync" } }',
    '      }',
  ]);
  // every other original line is unchanged, and the cross-container rel (ui -> OrderFunctions) is not written
  const orig = lines(design);
  assert.deepEqual(out.filter(l => !orig.includes(l) && !/f_|^ {6}\}$| \{$/.test(l)), []);
  assert.ok(!r.text.includes('u_api'));
  assert.deepEqual(Core.parse(r.text).errors, []);
});

test('splice refuses when the container cannot be located or already has components', () => {
  const built = Core.parse(BUILT);
  const pick = (m, n) => [...m.elements.values()].find(e => e.name === n);
  const run = (text, name, bname = 'Shop.Functions') => {
    const d = Core.parse(text);
    return Core.spliceComponents(text, d, pick(d, name).id, built, pick(built, bname).id);
  };
  const wrap = x => `workspace "d" { model { sys = softwareSystem "Shop" {\n${x}\n} } }`;
  // already has components
  let r = run(wrap('fn = container "Shop.Functions" {\n x = component "X"\n}'), 'Shop.Functions');
  assert.match(r.error, /already/); assert.equal(r.text, undefined);
  // not a container
  r = run(wrap('fn = container "Shop.Functions"'), 'Shop');
  assert.match(r.error, /not a container/); assert.equal(r.text, undefined);
  // built side is not a container
  r = run(wrap('fn = container "Shop.Functions"'), 'Shop.Functions', 'App shell');
  assert.match(r.error, /not a container/);
  // the line has no container keyword (a stale el.line)
  const d = Core.parse(wrap('fn = container "Shop.Functions"'));
  const fn = pick(d, 'Shop.Functions'); fn.line = 1;
  r = Core.spliceComponents(wrap('fn = container "Shop.Functions"'), d, fn.id, built, pick(built, 'Shop.Functions').id);
  assert.match(r.error, /container keyword/); assert.equal(r.text, undefined);
  // unbalanced braces
  r = run('workspace "d" { model { sys = softwareSystem "Shop" {\nfn = container "Shop.Functions" {\n description "x"\n', 'Shop.Functions');
  assert.ok(r.error); assert.equal(r.text, undefined);
  // braces inside strings do not count, in either direction
  r = run(wrap('fn = container "Shop.Functions" "a } b" {\n description "{{"\n}'), 'Shop.Functions');
  assert.equal(r.error, undefined);
  assert.deepEqual(Core.parse(r.text).errors, []);
  assert.ok(r.text.includes('f_ord = component'));
});

test('adopting an internal queue surfaces its missing delivery guarantee', async () => {
  const { extract } = require('../extract.js');
  const { withRepo, JOBS_REPO } = require('./helpers/with-repo');
  await withRepo(JOBS_REPO, async dir => {
    const dsl = (await extract(dir)).dsl;
    const built = Core.parse(dsl);
    const designText = Core.containerLevelText(dsl);
    const design = Core.parse(designText);
    const pick = (m, n) => [...m.elements.values()].find(e => e.name === n);
    const before = Core.check(design).map(f => f.code + f.loc.label);
    const r = Core.spliceComponents(designText, design, pick(design, 'Jobs.Functions').id, built, pick(built, 'Jobs.Functions').id);
    assert.equal(r.error, undefined);
    const after = Core.check(Core.parse(r.text));
    const fresh = after.filter(f => !before.includes(f.code + f.loc.label));
    assert.equal(fresh.length, 1, JSON.stringify(fresh.map(f => [f.code, f.loc.label])));
    assert.equal(fresh[0].code, 'DC001');
    assert.match(fresh[0].msg || fresh[0].message || fresh[0].text || '', /async, but no delivery guarantee declared/);
    assert.equal(fresh[0].loc.label, 'ReportJobFunction → JobWatcherFunction');
  });
});
