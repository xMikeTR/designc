const { test } = require('node:test');
const assert = require('node:assert/strict');
const Dispatch = require('../renderer/dispatch.js');

const vars = { handover: 'handovers/20261014-99e5021f', repo: '../codebase', registry: '/home/me/reg', base: 'main' };

test('command: fills every placeholder, each value shell-quoted', () => {
  const r = Dispatch.command('factory run --handover {handover} --repo {repo} --registry {registry} --base {base}', vars, 'linux');
  assert.equal(r, "factory run --handover 'handovers/20261014-99e5021f' --repo '../codebase' --registry '/home/me/reg' --base 'main'");
});

test('command: a value cannot break out of its quotes', () => {
  const v = { ...vars, registry: "/tmp/it's; rm -rf ~" };
  assert.equal(Dispatch.command('x {registry}', v, 'linux'), "x '/tmp/it'\\''s; rm -rf ~'");
  assert.equal(Dispatch.command('x {registry}', v, 'darwin'), "x '/tmp/it'\\''s; rm -rf ~'");
});

test('command: PowerShell quoting on Windows', () => {
  const v = { ...vars, registry: "C:\\Users\\o'neil\\reg" };
  assert.equal(Dispatch.command('x {registry} {base}', v, 'win32'), "x 'C:\\Users\\o''neil\\reg' 'main'");
});

test('command: the same placeholder may appear twice; text around it is kept as written', () => {
  assert.equal(Dispatch.command('cd {repo} && build {repo}', vars, 'linux'), "cd '../codebase' && build '../codebase'");
});

test('command: an unknown placeholder is an error that names it', () => {
  const r = Dispatch.command('run {handover} {model}', vars, 'linux');
  assert.match(r.error, /\{model\}/);
  assert.match(r.error, /\{handover\}, \{repo\}, \{registry\}, \{base\}/);
});

test('command: {repo} with no repository is an error saying where to set one', () => {
  const r = Dispatch.command('run {repo}', { ...vars, repo: null }, 'linux');
  assert.match(r.error, /codebase/);
  assert.equal(Dispatch.command('run {handover}', { ...vars, repo: null }, 'linux'), "run 'handovers/20261014-99e5021f'", 'unused, it does not matter');
});

test('command: a missing or blank template is an error', () => {
  for (const t of [undefined, null, '', '   ', 42]) assert.ok(Dispatch.command(t, vars, 'linux').error, String(t));
});

test('command: a newline in the template is refused, so nothing runs before the person presses Enter', () => {
  assert.match(Dispatch.command('echo a\nrm x', vars, 'linux').error, /one line/);
  assert.match(Dispatch.command('echo a\rrm x', vars, 'linux').error, /one line/);
  assert.match(Dispatch.command('run {base}', { ...vars, base: 'main\nrm x' }, 'linux').error, /one line/);
});

test('settings: no dispatch means no button; a malformed one is a problem, not an exception', () => {
  assert.equal(Dispatch.settings(undefined), null);
  assert.ok(Dispatch.settings({ label: 'x' }).error);
  assert.ok(Dispatch.settings('go').error);
  assert.ok(Dispatch.settings([]).error);
});

test('settings: the single {label?, command} form is one target', () => {
  assert.deepEqual(Dispatch.settings({ command: 'go {handover}' }),
    { label: 'Dispatch', targets: [{ key: 'default', label: 'Dispatch', command: 'go {handover}', resume: null }] });
  assert.deepEqual(Dispatch.settings({ label: 'Build with S', command: 'go' }),
    { label: 'Build with S', targets: [{ key: 'default', label: 'Build with S', command: 'go', resume: null }] });
});

test('settings: a map of named targets, in file order; a label defaults to the key', () => {
  const s = Dispatch.settings({ pipeline: { label: 'Build with my pipeline', command: 'a {handover}' }, headless: { command: 'b {repo}' } });
  assert.deepEqual(s.targets, [
    { key: 'pipeline', label: 'Build with my pipeline', command: 'a {handover}', resume: null },
    { key: 'headless', label: 'headless', command: 'b {repo}', resume: null },
  ]);
  assert.equal(s.label, 'Dispatch', 'several targets: the button is generic and asks which');
});

test('settings: a map with one target uses that target\'s label on the button', () => {
  assert.equal(Dispatch.settings({ only: { label: 'Build it', command: 'go' } }).label, 'Build it');
});

test('settings: an entry with enabled false is left out; none left means no button', () => {
  const s = Dispatch.settings({ a: { command: 'go' }, b: { command: 'x', enabled: false }, draft: { enabled: false } });
  assert.deepEqual(s.targets.map(t => t.key), ['a']);
  assert.equal(Dispatch.settings({ b: { command: 'x', enabled: false } }), null);
});

test('settings: an empty map or a target without a command is a problem naming it', () => {
  assert.match(Dispatch.settings({}).error, /no targets/);
  assert.match(Dispatch.settings({ good: { command: 'go' }, bad: { label: 'x' } }).error, /dispatch\.bad/);
  assert.match(Dispatch.settings({ bad: 'go' }).error, /dispatch\.bad/);
});

test('settings: a target may carry a resume command; one without has none', () => {
  const s = Dispatch.settings({ s2: { command: 'b {handover}', resume: 'b {handover} --run-id {run}' }, other: { command: 'o' } });
  assert.deepEqual(s.targets.map(t => [t.key, t.resume]), [['s2', 'b {handover} --run-id {run}'], ['other', null]]);
  assert.equal(Dispatch.settings({ command: 'b', resume: 'r {run}' }).targets[0].resume, 'r {run}');
  assert.match(Dispatch.settings({ s2: { command: 'b', resume: '  ' } }).error, /dispatch\.s2\.resume/);
  assert.match(Dispatch.settings({ command: 'b', resume: 3 }).error, /dispatch\.resume/);
});

test('command: {run} is filled when given and missing otherwise', () => {
  assert.equal(Dispatch.command('b --run-id {run}', { ...vars, run: '20261016-114233' }, 'linux'), "b --run-id '20261016-114233'");
  assert.equal(Dispatch.command('b --run-id {run}', vars, 'linux').error, 'There is no value for {run}.');
});
