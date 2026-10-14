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
  assert.deepEqual(Dispatch.settings({ command: 'go {handover}' }), { label: 'Dispatch', command: 'go {handover}' });
  assert.deepEqual(Dispatch.settings({ label: 'Build with S', command: 'go' }), { label: 'Build with S', command: 'go' });
  assert.ok(Dispatch.settings({ label: 'x' }).error);
  assert.ok(Dispatch.settings('go').error);
});
