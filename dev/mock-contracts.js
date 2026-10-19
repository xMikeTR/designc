// Scripted contracts command for trying the Agent contracts section without any compiler behind it.
//   "contracts": {"command": "node dev/mock-contracts.js {agents} {out}"}
// First agent compiles, the second needs input, the rest compile; writes {out}/result.json.
const fs = require('fs'), path = require('path');
const [agentsFile, out] = process.argv.slice(2);
const doc = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
fs.mkdirSync(out, { recursive: true });
const agents = doc.agents.map((a, i) => i === 1
  ? { id: a.id, status: 'needs_input', reasons: ['no goal is stated for this agent'] }
  : { id: a.id, status: 'compiled', files: [path.join('contracts', 'out', `${a.name.replace(/\W+/g, '-')}.json`)] });
for (const a of agents) for (const f of a.files || []) fs.writeFileSync(path.join(out, path.basename(f)), JSON.stringify({ agent: a.id }) + '\n');
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ schema: 'designc.contracts.result/1', agents }, null, 2) + '\n');
console.log(`wrote ${agents.length} results`);
