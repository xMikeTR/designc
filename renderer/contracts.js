/* designc desktop: agent contracts. Pure, no I/O, no dependencies. Dual-load like renderer/dispatch.js.
   designc describes the design's agents neutrally (Core.handoverAgents, docs/handover-agents.schema.json) and runs
   the person's own command on that file; whatever compiles it (an agent contract language, a policy generator) lives
   behind the command and designc does not know it. `designc.json` `contracts` is `{label?, command}`; the command
   fills {agents} (the input file), {out} (a folder it writes into) and {registry}, each quoted for the shell.
   The command writes {out}/result.json (docs/contracts-result.schema.json); this module reads it. */
const Contracts = (() => {
  const VARS = ['agents', 'out', 'registry'];
  const PATHS = { agents: 'contracts/agents.json', out: 'contracts/out', result: 'contracts/out/result.json' };
  const SCHEMA = 'designc.contracts.result/2', SCHEMA_V1 = 'designc.contracts.result/1';
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
    if (!r || (r.schema !== SCHEMA && r.schema !== SCHEMA_V1) || !Array.isArray(r.agents)) return { error: `${PATHS.result} must be {"schema": "${SCHEMA}", "agents": [...]}.` };
    const known = new Map(((agentsDoc && agentsDoc.agents) || []).map(a => [a.id, a]));
    const problems = [], byId = new Map();
    for (const a of r.agents) {
      if (!a || typeof a.id !== 'string' || !known.has(a.id)) { problems.push(`The result names ${a && a.id ? `"${a.id}"` : 'an agent with no id'}, which is not an agent in the design.`); continue; }
      if (!STATUS.includes(a.status)) { problems.push(`${a.id}: status must be ${STATUS.join(', ')}.`); continue; }
      const reasons = Array.isArray(a.reasons) ? a.reasons.filter(x => typeof x === 'string' && x.trim()) : [];
      if (a.status !== 'compiled' && !reasons.length) { problems.push(`${a.id}: ${a.status} needs a reason.`); continue; }
      byId.set(a.id, { id: a.id, name: known.get(a.id).name, status: a.status, policy: typeof a.policy === 'string' ? a.policy : null, files: Array.isArray(a.files) ? a.files.filter(x => typeof x === 'string') : [], reasons });
    }
    const agents = [...known.values()].map(a => byId.get(a.id) || { id: a.id, name: a.name, status: 'missing', files: [], reasons: ['The command wrote no result for this agent.'] });
    return { version: r.schema === SCHEMA ? 2 : 1, agents_hash: typeof r.agents_hash === 'string' ? r.agents_hash : null, compiler: r.compiler && typeof r.compiler === 'object' ? r.compiler : null, agents, problems };
  }

  // Gate input when designc.json contracts.require is true: one {name, text} per agent that is not `suggest` and has no
  // compiled contract for the design as it is now. The result is read with the same rules as a freeze.
  function gaps({ resultText, agentsDoc, agentsText, hash }) {
    const need = ((agentsDoc && agentsDoc.agents) || []).filter(a => a.autonomy !== 'suggest');
    if (!need.length) return [];
    const say = (a, why) => ({ name: a.name, text: `${a.name} has no compiled contract: ${why}` });
    const r = resultText == null ? { error: 'not compiled yet' } : readResult(resultText, agentsDoc);
    if (r.error) return need.map(a => say(a, r.error.startsWith('No') ? r.error : 'not compiled yet'));
    if (r.version < 2 || r.agents_hash !== hash(agentsText)) return need.map(a => say(a, r.version < 2 ? 'the result is from an older command' : 'the design changed since it was compiled'));
    const by = new Map(r.agents.map(a => [a.id, a]));
    return need.filter(a => !by.get(a.id) || by.get(a.id).status !== 'compiled' || !by.get(a.id).policy).map(a => say(a, (by.get(a.id) || { status: 'missing' }).status.replace('_', ' ')));
  }

  // What a freeze copies. Pure: the caller reads the files and passes `hash` (Core._shared.hash16). Returns
  // {skip: true} when the design has no agents, {error} when the compiled contracts cannot be frozen as they are, else
  // {contracts} for Core.handoverPlan. `suggest` agents may go uncontracted; every other agent must be compiled with
  // a policy, for the same agents.json text that was compiled.
  function forFreeze({ resultText, agentsDoc, agentsText, hash, read }) {
    if (!agentsDoc || !agentsDoc.agents.length) return { skip: true };
    if (resultText == null) return { error: `No ${PATHS.result}. Press Compile contracts first.` };
    const r = readResult(resultText, agentsDoc);
    if (r.error) return { error: r.error };
    if (r.version < 2) return { error: `${PATHS.result} comes from an older contracts command (result/1). It must write schema ${SCHEMA} with agents_hash and a policy per agent.` };
    if (r.agents_hash !== hash(agentsText)) return { error: 'The design\'s agents changed since the contracts were compiled. Press Compile contracts again.' };
    if (r.problems.length) return { error: r.problems[0] };
    const files = new Map(), agents = {}, uncontracted = [], bad = [];
    const take = rel => {
      if (typeof rel !== 'string' || !rel.startsWith(PATHS.out + '/') || rel.split('/').includes('..') || rel === PATHS.result) return `${rel} is not a compiled file under ${PATHS.out}/.`;
      if (!files.has(rel)) { const t = read(rel); if (t == null) return `${rel} is listed in the result but is missing.`; files.set(rel, t); }
      return null;
    };
    for (const a of r.agents) {
      const el = agentsDoc.agents.find(x => x.id === a.id);
      if (a.status !== 'compiled') {
        if (el && el.autonomy === 'suggest') { uncontracted.push(a.id); continue; }
        bad.push(`${a.name || a.id} is ${a.status.replace('_', ' ')}${a.reasons.length ? `: ${a.reasons[0]}` : ''}.`); continue;
      }
      if (!a.policy) { bad.push(`${a.name || a.id} is compiled but names no policy file.`); continue; }
      for (const f of [a.policy, ...a.files]) { const e = take(f); if (e) bad.push(`${a.name || a.id}: ${e}`); }
      agents[a.id] = 'contracts/' + a.policy.slice(PATHS.out.length + 1);
    }
    if (bad.length) return { error: `Contracts are not ready to freeze: ${bad[0]}${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}` };
    return { contracts: { result: { path: 'contracts/result.json', text: resultText }, files: [...files].map(([p, text]) => ({ path: 'contracts/' + p.slice(PATHS.out.length + 1), text })), agents, uncontracted, compiler: r.compiler } };
  }

  return { VARS, PATHS, SCHEMA, settings, command, readResult, forFreeze, gaps };
})();
if (typeof module !== 'undefined') module.exports = Contracts;
