const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AcpHub } = require('../acp.js');

// A registry inside a parent folder, and a hub whose UI approves everything it is asked.
function setup(reply = { ok: true }) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-write-'));
  const root = path.join(parent, 'registry');
  fs.mkdirSync(path.join(root, 'model'), { recursive: true });
  const asked = [];
  const hub = new AcpHub({ getRoot: () => root, getCodebase: () => null, mcpServer: () => ({}),
    ui: async (channel, key, w) => { asked.push(w); return reply; } });
  const write = p => hub.handle('k', 'fs/write_text_file', { path: p, content: 'x' });
  return { parent, root, asked, write };
}

test('an approved write inside the registry is written, and the UI is given the relative path', async () => {
  const { root, asked, write } = setup();
  await write(path.join(root, 'model', 'workspace.dsl'));
  assert.equal(fs.readFileSync(path.join(root, 'model', 'workspace.dsl'), 'utf8'), 'x');
  assert.equal(asked[0].rel, 'model/workspace.dsl');
});

test('a path that climbs out of the registry is not written, even if the UI approves', async () => {
  const { parent, root, asked, write } = setup();
  const sneaky = `${root}/model/../../escaped.txt`;
  await assert.rejects(write(sneaky), /inside the registry/);
  assert.equal(fs.existsSync(path.join(parent, 'escaped.txt')), false);
  assert.equal(asked[0].rel, null);
});

test('dot segments that stay inside the registry are resolved before policy sees them', async () => {
  const { root, asked, write } = setup();
  await write(`${root}/model/../decisions/a.yaml`);
  assert.equal(asked[0].rel, 'decisions/a.yaml');
  assert.equal(fs.existsSync(path.join(root, 'decisions', 'a.yaml')), true);
});

test('the registry root itself, a sibling with the same prefix, and a relative path are refused', async () => {
  const { parent, root, write } = setup();
  await assert.rejects(write(root), /inside the registry/);
  await assert.rejects(write(root + '-other/x.txt'), /inside the registry/);
  await assert.rejects(write('model/workspace.dsl'), /inside the registry/);
  assert.equal(fs.existsSync(parent + '/registry-other'), false);
});

test('a declined write is not written', async () => {
  const { root, write } = setup({ ok: false, error: 'The user declined this write.' });
  await assert.rejects(write(path.join(root, 'model', 'a.dsl')), /declined/);
  assert.equal(fs.existsSync(path.join(root, 'model', 'a.dsl')), false);
});
