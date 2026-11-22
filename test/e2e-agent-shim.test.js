// e2e/agent-shim.js must catch an agent start and let other npx calls through. Only harmless stand-ins here:
// the real agent packages are never run, and a missing shim would just fail to find the stand-in.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeAgentShim, attempts, isolatedEnv, AGENT_PACKAGES, AGENT_COMMANDS } = require('../e2e/agent-shim');

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-shim-'));
  const real = path.join(dir, 'real-npx'); fs.writeFileSync(real, '#!/bin/sh\necho "REAL $*"\n', { mode: 0o755 });
  const shim = makeAgentShim(dir, { realNpx: real, packages: ['standin-agent-pkg'], commands: ['standin-agent'] });
  const run = (cmd, args) => spawnSync(cmd, args, { env: isolatedEnv({ PATH: process.env.PATH }, shim.bin), encoding: 'utf8' });
  return { dir, shim, run };
};

test('shim refuses and records a stand-in agent package and command', () => {
  const { dir, shim, run } = setup();
  try {
    const r = run('npx', ['-y', 'standin-agent-pkg@1']);
    assert.strictEqual(r.status, 97); assert.doesNotMatch(r.stdout, /REAL/);
    assert.strictEqual(run('standin-agent', ['--acp']).status, 97);
    assert.strictEqual(attempts(shim.log).length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('other npx calls reach the real npx and record nothing', () => {
  const { dir, shim, run } = setup();
  try {
    const r = run('npx', ['-y', 'some-other-tool']);
    assert.strictEqual(r.status, 0); assert.match(r.stdout, /REAL -y some-other-tool/);
    assert.deepStrictEqual(attempts(shim.log), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the default shim covers every preset package and command in main.js', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const block = main.slice(main.indexOf('const ACP_PRESETS'), main.indexOf('function readSettings'));
  for (const p of block.match(/'(@[\w.-]+\/[\w.-]+)'/g).map(s => s.slice(1, -1))) assert.ok(AGENT_PACKAGES.includes(p), p);
  assert.ok(AGENT_COMMANDS.includes('copilot'));
});

test('isolated env drops model keys and base urls and puts the shims first', () => {
  const env = isolatedEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'x', DESIGNC_LLM_BASE_URL: 'x', DESIGNC_LLM_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x', HOME: '/h' }, '/shims');
  assert.deepStrictEqual(Object.keys(env).sort(), ['HOME', 'PATH']); assert.strictEqual(env.PATH, '/shims:/usr/bin');
});

test('isolated env also drops LANGFUSE_* variables', () => {
  const env = isolatedEnv({ PATH: '/usr/bin', LANGFUSE_SECRET_KEY: 'x', LANGFUSE_HOST: 'x', LANGFUSE_PUBLIC_KEY: 'x', HOME: '/h' }, '/shims');
  assert.deepStrictEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});
