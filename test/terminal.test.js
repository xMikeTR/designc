const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shellFor, Terminals } = require('../terminal.js');

test('shellFor uses $SHELL as a login shell on Linux and macOS, bash when unset', () => {
  assert.deepEqual(shellFor('linux', { SHELL: '/bin/zsh' }), { file: '/bin/zsh', args: ['-l'] });
  assert.deepEqual(shellFor('darwin', {}), { file: '/bin/bash', args: ['-l'] });
});

test('shellFor uses PowerShell on Windows', () => {
  assert.deepEqual(shellFor('win32', { COMSPEC: 'C:\\Windows\\cmd.exe' }), { file: 'powershell.exe', args: ['-NoLogo'] });
});

// A fake node-pty: records spawns, lets the test drive output and exit.
function fakePty() {
  const spawned = [];
  return {
    spawned,
    spawn(file, args, opts) {
      const p = { file, args, opts, written: [], size: [opts.cols, opts.rows], killed: false, data: null, exit: null };
      p.onData = fn => { p.data = fn; }; p.onExit = fn => { p.exit = fn; };
      p.write = s => p.written.push(s); p.resize = (c, r) => { p.size = [c, r]; }; p.kill = () => { p.killed = true; };
      spawned.push(p); return p;
    },
  };
}

test('open spawns the shell in the folder with the given env and xterm-256color', () => {
  const pty = fakePty(), t = new Terminals(pty, { platform: 'linux' });
  const id = t.open({ cwd: '/reg', env: { SHELL: '/bin/zsh', HOME: '/h' }, cols: 100, rows: 30, onData() {}, onExit() {} });
  const p = pty.spawned[0];
  assert.equal(p.file, '/bin/zsh'); assert.equal(p.opts.cwd, '/reg');
  assert.equal(p.opts.env.HOME, '/h'); assert.equal(p.opts.env.TERM, 'xterm-256color');
  assert.deepEqual(p.size, [100, 30]); assert.equal(typeof id, 'number');
});

test('input, resize and output reach the right terminal; exit forgets it', () => {
  const pty = fakePty(), t = new Terminals(pty, { platform: 'linux' }), out = [], exits = [];
  const a = t.open({ cwd: '/r', env: {}, cols: 80, rows: 24, onData: s => out.push(['a', s]), onExit: c => exits.push(['a', c]) });
  const b = t.open({ cwd: '/r', env: {}, cols: 80, rows: 24, onData: s => out.push(['b', s]), onExit() {} });
  assert.notEqual(a, b);
  t.input(b, 'ls\r'); t.resize(a, 120, 40);
  assert.deepEqual(pty.spawned[1].written, ['ls\r']); assert.deepEqual(pty.spawned[0].size, [120, 40]);
  pty.spawned[0].data('hi'); assert.deepEqual(out, [['a', 'hi']]);
  pty.spawned[0].exit({ exitCode: 3 }); assert.deepEqual(exits, [['a', 3]]);
  assert.equal(t.input(a, 'x'), false);
});

test('a bad size is clamped, an unknown id is ignored, closeAll kills every shell', () => {
  const pty = fakePty(), t = new Terminals(pty, { platform: 'linux' });
  const a = t.open({ cwd: '/r', env: {}, cols: 0, rows: 'x', onData() {}, onExit() {} });
  assert.deepEqual(pty.spawned[0].size, [80, 24]);
  t.resize(a, -5, 1e9); assert.deepEqual(pty.spawned[0].size, [80, 24]);
  assert.equal(t.input(999, 'x'), false); assert.equal(t.close(999), false);
  t.open({ cwd: '/r', env: {}, cols: 80, rows: 24, onData() {}, onExit() {} });
  t.closeAll();
  assert.ok(pty.spawned.every(p => p.killed)); assert.equal(t.count(), 0);
});
