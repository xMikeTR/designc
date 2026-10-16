const { test } = require('node:test');
const assert = require('node:assert/strict');
const { termClipboardKey } = require('../renderer/terminalview.js');

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...mods });

test('Ctrl+Shift+C copies and Ctrl+Shift+V pastes on Linux and Windows', () => {
  for (const p of ['linux', 'win32']) {
    assert.equal(termClipboardKey(key('C', { ctrlKey: true, shiftKey: true }), p), 'copy');
    assert.equal(termClipboardKey(key('V', { ctrlKey: true, shiftKey: true }), p), 'paste');
  }
});

test('Ctrl+C and Ctrl+V without Shift stay with the shell (interrupt, literal next)', () => {
  assert.equal(termClipboardKey(key('c', { ctrlKey: true }), 'linux'), null);
  assert.equal(termClipboardKey(key('v', { ctrlKey: true }), 'linux'), null);
  assert.equal(termClipboardKey(key('C', { ctrlKey: true, shiftKey: true, altKey: true }), 'linux'), null);
});

test('Cmd+C and Cmd+V on macOS; Ctrl+Shift there is the shell\'s', () => {
  assert.equal(termClipboardKey(key('c', { metaKey: true }), 'darwin'), 'copy');
  assert.equal(termClipboardKey(key('v', { metaKey: true }), 'darwin'), 'paste');
  assert.equal(termClipboardKey(key('C', { ctrlKey: true, shiftKey: true }), 'darwin'), null);
});
