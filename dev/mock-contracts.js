// Scripted contracts command for trying the Agent contracts section without any compiler behind it.
//   "contracts": {"command": "node dev/mock-contracts.js {agents} {out}"}
// First agent compiles, the second needs input, the rest compile (set MOCK_ALL=1 to compile every agent).
// Writes an AGT-shaped policy per compiled agent and {out}/result.json (designc.contracts.result/2).
const fs = require('fs'), path = require('path');
const { hash16 } = require('../renderer/core.js')._shared;
const [agentsFile, out] = process.argv.slice(2);
const text = fs.readFileSync(agentsFile, 'utf8'), doc = JSON.parse(text);
fs.mkdirSync(out, { recursive: true });
const slug = a => a.name.replace(/\W+/g, '-').toLowerCase();
const agents = doc.agents.map((a, i) => {
  if (i === 1 && !process.env.MOCK_ALL) return { id: a.id, status: 'needs_input', reasons: ['no goal is stated for this agent'] };
  const policy = `contracts/out/${slug(a)}.policy.yaml`;
  const denied = a.tools.filter(t => t.direction === 'out' && t.effect === 'irreversible' && !t.approval).map(t => t.other);
  fs.writeFileSync(path.join(out, path.basename(policy)),
    `apiVersion: governance.toolkit/v1\nversion: 1\nname: ${slug(a)}\ndefault_action: allow\nrules:\n${denied.map((d, n) => `  - name: no-${d.replace(/\W+/g, '-').toLowerCase()}\n    condition: "tool.target == '${d}'"\n    action: deny\n    priority: ${100 - n}\n`).join('') || '  []\n'}`);
  return { id: a.id, status: 'compiled', policy, files: [policy] };
});
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ schema: 'designc.contracts.result/2', agents_hash: hash16(text), compiler: { name: 'mock-contracts', version: '0' }, agents }, null, 2) + '\n');
console.log(`wrote ${agents.length} results`);
