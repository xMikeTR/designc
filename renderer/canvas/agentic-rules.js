/* designc-canvas: agentic design rules (AG001 to AG010).
   Same shape as designc's core RULES, registered with Core.registerRules(). Demand-driven like the
   core rules: an undeclared property only produces an "unknown" finding where a rule needs it.
   Each rule names the risk it comes from (OWASP Top 10 for Agentic Applications 2026, the lethal
   trifecta, Anthropic's agent guidance). Promote a rule's `source` to an incident when one happens. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else (root.DesigncCanvas = root.DesigncCanvas || {}).agenticRules = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function makeRules(Core) {
    const get = Core.get;
    const D = (code, sev, msg, loc, extra = {}) => ({ code, sev, msg, loc, hint: null, unknown: false, suppressed: null, related: [], ...extra });
    const agents = m => [...m.elements.values()].filter(e => e.tags.has('Agent'));
    const isAgent = e => e && e.tags.has('Agent');
    const out = (m, e) => m.rels.filter(r => r.src === e.id);
    const into = (m, e) => m.rels.filter(r => r.dst === e.id);
    const el = (m, id) => m.elements.get(id);
    const sensitive = e => get(e, 'd.pii') === 'yes' || ['confidential', 'restricted'].includes(get(e, 'd.data.classification'));
    const external = e => e && e.tags.has('External') && !e.tags.has('LLM') && !e.tags.has('Identity Provider');

    return [
      { code: 'AG001', title: 'Lethal trifecta', source: 'Simon Willison, "The lethal trifecta" (2025); OWASP ASI01 Agent Goal Hijack',
        doc: 'An agent with private data, untrusted content and a way to communicate externally can be steered by injected instructions into sending that data out.',
        fn(m) {
          const res = [];
          for (const a of agents(m)) {
            const legs = {
              untrustedInput: get(a, 'd.agent.untrustedInput'),
              privateData: get(a, 'd.agent.privateData') || (out(m, a).some(r => sensitive(el(m, r.dst))) ? 'yes' : null),
              externalComms: get(a, 'd.agent.externalComms') || (out(m, a).some(r => external(el(m, r.dst)) && ['write', 'irreversible'].includes(get(r, 'd.tool.effect'))) ? 'yes' : null),
            };
            const yes = Object.keys(legs).filter(k => legs[k] === 'yes'), unknown = Object.keys(legs).filter(k => legs[k] == null);
            if (yes.length === 3) res.push(D('AG001', 'error', 'has all three legs of the lethal trifecta: private data, untrusted content and external communication', m.locEl(a),
              { hint: 'remove a leg: split the agent so no single context holds all three, or drop external communication. Guardrail filters are not a fix.' }));
            else if (unknown.length && yes.length + unknown.length === 3) res.push(D('AG001', 'warning', `could have the full lethal trifecta; declare ${unknown.map(k => 'd.agent.' + k).join(', ')}`, m.locEl(a),
              { hint: 'yes or no for each leg; two legs are usually fine, three are not', unknown: true }));
          }
          return res;
        } },
      { code: 'AG002', title: 'Excessive agency', source: 'OWASP ASI02 Tool Misuse; OWASP LLM06 Excessive Agency',
        doc: 'Irreversible actions need a human; reversible writes by an autonomous agent need at least a policy gate.',
        fn(m) {
          const res = [];
          for (const a of agents(m)) {
            const autonomy = get(a, 'd.agent.autonomy');
            for (const r of out(m, a)) {
              const dst = el(m, r.dst); if (!dst || dst.tags.has('LLM') || dst.tags.has('Trace Store')) continue;
              const effect = get(r, 'd.tool.effect'), approval = get(r, 'd.approval');
              if (effect === 'irreversible' && approval !== 'human') res.push(D('AG002', 'error', `irreversible action on ${dst.name} without human approval`, m.locRel(r), { hint: 'set d.approval: human, or make the action reversible' }));
              else if (effect === 'write' && autonomy === 'autonomous' && (!approval || approval === 'none')) res.push(D('AG002', 'warning', `autonomous agent writes to ${dst.name} with no approval gate`, m.locRel(r), { hint: 'set d.approval: policy (e.g. ACS) or human, or lower d.agent.autonomy' }));
              else if (!effect && (dst.tags.has('Tool') || dst.tags.has('External') || Core.isStore(dst))) res.push(D('AG002', 'warning', `side effect of calling ${dst.name} undeclared`, m.locRel(r), { hint: 'set d.tool.effect: read | write | irreversible', unknown: true }));
            }
          }
          return res;
        } },
      { code: 'AG003', title: 'No stopping condition', source: 'OWASP ASI08 Cascading Failures; Anthropic, Building effective agents (stopping conditions)',
        doc: 'Every agent loop needs a hard cap on steps or spend; agents that can call each other need one on every agent in the cycle.',
        fn(m) {
          const res = [], A = agents(m), ids = new Set(A.map(a => a.id));
          const capped = a => get(a, 'd.agent.maxSteps') != null || get(a, 'd.agent.budget') != null;
          const adj = new Map(A.map(a => [a.id, out(m, a).filter(r => ids.has(r.dst)).map(r => r.dst)]));
          const inCycle = new Set();
          for (const a of A) { const seen = new Set(), stack = [...adj.get(a.id)]; while (stack.length) { const n = stack.pop(); if (n === a.id) { inCycle.add(a.id); break; } if (seen.has(n)) continue; seen.add(n); stack.push(...(adj.get(n) || [])); } }
          for (const a of A) {
            if (capped(a)) continue;
            if (inCycle.has(a.id)) res.push(D('AG003', 'error', 'can be called back by the agents it calls, with no cap on steps or budget', m.locEl(a), { hint: 'set d.agent.maxSteps or d.agent.budget' }));
            else res.push(D('AG003', 'warning', 'no step or budget cap declared', m.locEl(a), { hint: 'set d.agent.maxSteps and/or d.agent.budget', unknown: true }));
          }
          return res;
        } },
      { code: 'AG004', title: 'Model access outside the gateway', source: 'Governed platform practice: one gateway for cost, policy and tracing',
        doc: 'Agents should reach models through the AI gateway so budgets, routing, keys and tracing apply to every call.',
        fn(m) {
          return agents(m).flatMap(a => out(m, a).filter(r => { const d = el(m, r.dst); return d && d.tags.has('LLM'); })
            .map(r => D('AG004', 'warning', `calls ${el(m, r.dst).name} directly, not through the AI gateway`, m.locRel(r), { hint: 'route it through an element tagged "AI Gateway"' })));
        } },
      { code: 'AG005', title: 'Unobserved agent', source: 'OWASP ASI10 Rogue Agents; evaluation practice',
        doc: 'Every agent run should be traced, and changes to prompts, tools or models gated by an eval suite.',
        fn(m) {
          const res = [];
          for (const a of agents(m)) {
            const t = get(a, 'd.agent.tracing');
            if (t === 'no') res.push(D('AG005', 'warning', 'runs are not traced', m.locEl(a), { hint: 'trace every run with element, task and decision metadata' }));
            else if (t == null) res.push(D('AG005', 'warning', 'tracing undeclared', m.locEl(a), { hint: 'set d.agent.tracing: yes | no', unknown: true }));
            if (get(a, 'd.agent.eval') == null) res.push(D('AG005', 'note', 'no eval suite named', m.locEl(a), { hint: 'set d.agent.eval to the suite that gates prompt, tool and model changes' }));
          }
          return res;
        } },
      { code: 'AG006', title: 'Unsandboxed code execution', source: 'OWASP ASI05 Unexpected Code Execution',
        doc: 'Model-generated code must run in an isolated sandbox, never on the host.',
        fn(m) {
          return agents(m).filter(a => get(a, 'd.agent.codeExec') === 'yes' && get(a, 'd.agent.sandbox') !== 'yes')
            .map(a => D('AG006', 'error', 'runs generated code outside a sandbox', m.locEl(a), { hint: 'set d.agent.sandbox: yes and run it in an isolated environment' }));
        } },
      { code: 'AG007', title: 'Shared memory without isolation', source: 'OWASP ASI06 Memory and Context Poisoning',
        doc: 'Memory or vector stores shared across agents, or holding sensitive data, need tenant isolation to prevent leakage and poisoning.',
        fn(m) {
          const res = [];
          for (const s of m.elements.values()) {
            if (!(s.tags.has('Vector Store') || s.tags.has('Memory'))) continue;
            const users = new Set(into(m, s).map(r => r.src).filter(id => isAgent(el(m, id))));
            if (!users.size || !(users.size > 1 || sensitive(s))) continue;
            const iso = get(s, 'd.tenant.isolation');
            if (iso === 'none') res.push(D('AG007', 'warning', `${users.size > 1 ? `shared by ${users.size} agents` : 'holds sensitive data'} with no tenant isolation`, m.locEl(s), { hint: 'isolate per tenant or user, and validate what gets written to memory' }));
            else if (iso == null) res.push(D('AG007', 'warning', `${users.size > 1 ? `shared by ${users.size} agents` : 'holds sensitive data'}; isolation undeclared`, m.locEl(s), { hint: 'set d.tenant.isolation: none | logical | physical', unknown: true }));
          }
          return res;
        } },
      { code: 'AG008', title: 'Single model dependency', source: 'Availability practice; OWASP ASI08 Cascading Failures',
        doc: 'A critical agent needs a fallback model or provider.',
        fn(m) {
          return agents(m).filter(a => get(a, 'd.critical') === 'yes' && get(a, 'd.agent.fallback') == null)
            .map(a => D('AG008', 'warning', 'critical, with no fallback model or provider', m.locEl(a), { hint: 'set d.agent.fallback, or record the accepted risk' }));
        } },
      { code: 'AG009', title: 'Unauthenticated agent-to-agent call', source: 'OWASP ASI07 Insecure Inter-Agent Communication',
        doc: 'Calls between agents must be authenticated, or one compromised agent can impersonate another.',
        fn(m) {
          const res = [];
          for (const r of m.rels) {
            if (!isAgent(el(m, r.src)) || !isAgent(el(m, r.dst))) continue;
            const au = get(r, 'd.authenticated');
            if (au === 'no') res.push(D('AG009', 'warning', 'agent-to-agent call is not authenticated', m.locRel(r), { hint: 'authenticate the caller and authorise per agent' }));
            else if (au == null) res.push(D('AG009', 'warning', 'agent-to-agent call; authentication undeclared', m.locRel(r), { hint: 'set d.authenticated: yes | no', unknown: true }));
          }
          return res;
        } },
      { code: 'AG010', title: 'Shared agent identity', source: 'OWASP ASI03 Identity and Privilege Abuse',
        doc: 'Agents that write should act under their own or the user\'s delegated identity, never a shared account.',
        fn(m) {
          const res = [];
          for (const a of agents(m)) {
            const id = get(a, 'd.agent.identity');
            const writes = out(m, a).some(r => ['write', 'irreversible'].includes(get(r, 'd.tool.effect')));
            if (id === 'shared') res.push(D('AG010', 'warning', 'acts under a shared identity', m.locEl(a), { hint: 'use a per-agent service identity or the user\'s delegated identity' }));
            else if (id == null && writes) res.push(D('AG010', 'warning', 'writes, with identity undeclared', m.locEl(a), { hint: 'set d.agent.identity: delegated | service | shared', unknown: true }));
          }
          return res;
        } },
    ];
  }
  return { makeRules };
});
