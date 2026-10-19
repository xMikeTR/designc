/* designc desktop: agent contracts. Pure, no I/O, no dependencies. Dual-load like renderer/dispatch.js.
   designc describes the design's agents neutrally (Core.handoverAgents, docs/handover-agents.schema.json) and runs
   the person's own command on that file; whatever compiles it (an agent contract language, a policy generator) lives
   behind the command and designc does not know it. `designc.json` `contracts` is `{label?, command}`; the command
   fills {agents} (the input file), {out} (a folder it writes into) and {registry}, each quoted for the shell.
   The command writes {out}/result.json (docs/contracts-result.schema.json); this module reads it. */
const Contracts = (() => {
  const VARS = ['agents', 'out', 'registry'];
  const PATHS = { agents: 'contracts/agents.json', out: 'contracts/out', result: 'contracts/out/result.json' };
  const STATUS = ['compiled', 'needs_input', 'failed'];
  const text = v => typeof v === 'string' && v.trim() ? v.trim() : null;

  function settings(c) {
    if (c === undefined || c === null) return null;
    if (typeof c !== 'object' || Array.isArray(c) || !text(c.command)) return { error: 'designc.json contracts needs a command, for example {"command": "my-compiler --agents {agents} --out {out}"}.' };
    return { label: text(c.label) || 'Compile contracts', command: c.command };
  }

  function command(template, vars, platform) {
    if (typeof template !== 'string' || !template.trim()) return { error: 'designc.json contracts needs a command.' };
    if (/[\r\n]/.test(template)) return { error: 'The contracts command must be one line.' };
    const unknown = [...template.matchAll(/\{([^{}\s]*)\}/g)].map(m => m[1]).filter(n => !VARS.includes(n));
    if (unknown.length) return { error: `The contracts command uses {${unknown[0]}}, which designc does not fill. Use ${VARS.map(v => `{${v}}`).join(', ')}.` };
    const quote = platform === 'win32' ? s => `'${s.replace(/'/g, "''")}'` : s => `'${s.replace(/'/g, "'\\''")}'`;
    return template.replace(/\{(agents|out|registry)\}/g, (_, n) => quote(String((vars && vars[n]) || '')));
  }

  // result.json: {schema: 'designc.contracts.result/1', agents: [{id, status, files?, reasons?}]}, judged against
  // the agents file that was compiled. Every agent gets a row; one the command did not mention is `missing`, and an id
  // it invented is a problem, never a row. `reasons` are required unless compiled.
  function readResult(raw, agentsDoc) {
    let r;
    try { r = JSON.parse(raw); } catch (e) { return { error: `${PATHS.result} is not JSON: ${e.message}` }; }
    if (!r || r.schema !== 'designc.contracts.result/1' || !Array.isArray(r.agents)) return { error: `${PATHS.result} must be {"schema": "designc.contracts.result/1", "agents": [...]}.` };
    const known = new Map(((agentsDoc && agentsDoc.agents) || []).map(a => [a.id, a]));
    const problems = [], byId = new Map();
    for (const a of r.agents) {
      if (!a || typeof a.id !== 'string' || !known.has(a.id)) { problems.push(`The result names ${a && a.id ? `"${a.id}"` : 'an agent with no id'}, which is not an agent in the design.`); continue; }
      if (!STATUS.includes(a.status)) { problems.push(`${a.id}: status must be ${STATUS.join(', ')}.`); continue; }
      const reasons = Array.isArray(a.reasons) ? a.reasons.filter(x => typeof x === 'string' && x.trim()) : [];
      if (a.status !== 'compiled' && !reasons.length) { problems.push(`${a.id}: ${a.status} needs a reason.`); continue; }
      byId.set(a.id, { id: a.id, name: known.get(a.id).name, status: a.status, files: Array.isArray(a.files) ? a.files.filter(x => typeof x === 'string') : [], reasons });
    }
    const agents = [...known.values()].map(a => byId.get(a.id) || { id: a.id, name: a.name, status: 'missing', files: [], reasons: ['The command wrote no result for this agent.'] });
    return { agents, problems };
  }

  return { VARS, PATHS, settings, command, readResult };
})();
if (typeof module !== 'undefined') module.exports = Contracts;
