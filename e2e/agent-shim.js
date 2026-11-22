// Keeps e2e from ever reaching a real agent. designc offers ACP presets (npx claude/codex/gemini packages, copilot)
// and a Bind may start one. In e2e the child's PATH starts with shims: an agent command, or npx given an agent
// package, records the attempt in a log and exits 97; any other npx call runs the real one. Agents in e2e are
// dev/mock-acp* or stubbed send only. launch() strips LLM keys and base urls; cleanup() fails on a recorded attempt.
const fs = require('fs');
const path = require('path');

const AGENT_PACKAGES = ['@agentclientprotocol/claude-agent-acp', '@zed-industries/codex-acp', '@google/gemini-cli'];
const AGENT_COMMANDS = ['copilot', 'claude', 'codex', 'gemini'];
const SECRET_ENV = /^(ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_API_KEY|GH_TOKEN|GITHUB_TOKEN|CLAUDE_CODE_|DESIGNC_LLM_|AWS_BEARER_TOKEN_BEDROCK)/;

const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Writes the shims into `dir`; returns { bin, log }. `realNpx` is the npx other calls pass through to.
function makeAgentShim(dir, { realNpx, packages = AGENT_PACKAGES, commands = AGENT_COMMANDS } = {}) {
  const bin = path.join(dir, 'bin'), log = path.join(dir, 'agent-attempts.log');
  fs.mkdirSync(bin, { recursive: true });
  const refuse = `echo "$0 $*" >> ${quote(log)}; echo "designc e2e: agent start refused" >&2; exit 97`;
  const write = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  write('npx', `for a in "$@"; do case "$a" in ${packages.map(p => `${quote(p)}*`).join('|')}) ${refuse};; esac; done\n${realNpx ? `exec ${quote(realNpx)} "$@"` : 'echo "no real npx" >&2; exit 127'}`);
  for (const c of commands) write(c, refuse);
  return { bin, log };
}

// Recorded start attempts (empty when none).
const attempts = log => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];

// The env for the app: shim dir first on PATH, nothing that could authenticate a model call.
function isolatedEnv(env, bin) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) out[k] = v;
  out.PATH = `${bin}${path.delimiter}${env.PATH || ''}`;
  return out;
}

module.exports = { makeAgentShim, attempts, isolatedEnv, AGENT_PACKAGES, AGENT_COMMANDS };
