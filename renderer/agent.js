/* Agent panel. Agents propose; deterministic checks and a human decide.
   Loaded after app.js and shares its state (A) and helpers. */
'use strict';

// ---------------------------------------------------------------- roles & policy
const READ_TOOLS = ['read_model', 'get_findings', 'get_gate', 'list_decisions', 'read_registry_file', 'get_code_map', 'search_codebase', 'read_code', 'get_telemetry'];
const COMMON_RULES = `You work inside designc, a system design IDE. The design (Structurizr DSL with d.* design properties) is the source of truth; code is generated from it.
Rules:
- Use tools to look before you answer. Cite evidence as model line numbers ("line 53") or file:line for code.
- You cannot change anything directly. Tools marked as needing approval show the user a card; nothing happens unless they approve. Never say you changed something unless a tool result says "Applied" or "Created".
- Prefer one precise proposal over several vague ones. Keep answers short and concrete.
- A decision check is a shell command run in the registry folder that exits 0 when the decision holds (for example ./checks/playtest-clean.sh or p check -tc tcOptimistic); designc runs it and records the result. Never write a check as a description such as "Model: ..." or "Test: ...": when no command exists yet, write "TODO <what it must prove>" and say what script is needed.
- The lint rules: DC001 duplicate processing, DC002 lost update, DC003 compound availability, DC004 retry duplicates side effects, DC005 single point of failure, DC006 trust boundary. Design properties are listed in the model.`;
const ROLES = {
  architect: { label: 'Architect', system: 'S1', allow: READ_TOOLS, ask: ['propose_model_edit', 'mint_decision'],
    instructions: 'You are the Architect: a design partner for the engineer. Explain findings, compare the design with the code map and telemetry, and propose precise model edits or decisions.',
    starters: ['Why is the gate blocked, and what are my options?', 'Compare the code map with the design and propose edits for the drift', 'Which element is costing the most agent effort, and is the design the cause?'] },
  grill: { label: 'Grill-me', system: 'S1', allow: READ_TOOLS.filter(t => t !== 'get_telemetry'), ask: ['mint_decision'],
    instructions: 'You are Grill-me. Interrogate the design one question at a time, starting with what blocks the gate. When the user answers, offer to mint a decision that records it, with a check that would prove it: a shell command, or a TODO naming the script still to write.',
    starters: ['Grill me on this design', 'Grill me on Quotes DB only', 'What would you ask the business, not me?'] },
  analyst: { label: 'Analyst', system: 'S4', allow: READ_TOOLS, ask: ['mint_proposal'],
    instructions: 'You are the Analyst for Improve, the evals and improvement loop. You improve the factory (lint rules, P properties, grill-me questions, gate clauses, eval cases, routing), never the product. Every proposal cites an escape or a run as evidence and says how to prove it works. When reviewing decisions, check each against this rubric: does it state an assumption with a review date (list_decisions shows them); is any assumption overdue or untested by a check; does an accepted risk rely on a bound business decision; would the escapes seen so far have been caught if its assumption were false. Name the decision id and the rubric line it fails. You cannot mark an assumption reviewed; only the human can.',
    starters: ['What should change in the factory given the recent escapes?', 'Which lint rule would have caught the most failed runs?', 'Is any rule noisy enough to reconsider?'] },
  tutor: { label: 'Tutor', system: 'S1', allow: READ_TOOLS.filter(t => t !== 'get_telemetry'), ask: [],
    instructions: 'You are the Tutor: you teach system design to an engineer who is learning it while designing. Explain the concept in plain words first, then tie it to their model (read it; name the elements and lines it applies to). Give the trade-offs, not one right answer. Name sources worth reading (books, papers, well-known articles); if you can search the web, look and link what you used, and never invent a link. End with one short question that checks understanding. You never change the design and never propose edits or decisions; if the user wants a change, tell them to ask the Architect or edit it themselves.',
    starters: ['Explain the C4 levels using my model', 'What should I learn first to design this well?', 'Explain the findings on my model as if I were new to this'] },
};
function roleCfg(role) {
  const base = ROLES[role]; const o = (A.cfg.agents && A.cfg.agents[role]) || {};
  return { ...base, allow: o.allow || base.allow, ask: o.ask || base.ask, deny: o.deny || [], instructions: base.instructions + (o.instructions ? '\n' + o.instructions : '') };
}
// Fail closed: the rules live in policy.js.
const verdict = (role, tool) => Policy.verdict(roleCfg(role), tool);

// ---------------------------------------------------------------- tool definitions
const obj = (props, req = []) => ({ type: 'object', properties: props, required: req, additionalProperties: false });
const TOOLS = {
  read_model: { d: 'Read the design model (Structurizr DSL) with line numbers. Optional line range.', p: obj({ from: { type: 'integer' }, to: { type: 'integer' } }) },
  get_findings: { d: 'Current lint findings on the model (code, severity, location, line, message, hint, suppressed).', p: obj({}) },
  get_gate: { d: 'Definition-of-ready verdict and every blocking clause.', p: obj({}) },
  list_decisions: { d: 'All decisions with status, effect, bindings, checks and latest check result; also requirements.', p: obj({}) },
  read_registry_file: { d: 'Read a file in the registry folder, e.g. decisions/D-0001.yaml or behaviour/quotes-writes.p.', p: obj({ path: { type: 'string' } }, ['path']) },
  get_code_map: { d: 'The as-built map extracted from the codebase: elements, dependencies with evidence, drift against the design, d.code areas against the files in the codebase, unresolved items.', p: obj({}) },
  search_codebase: { d: 'Case-insensitive text search across the codebase (read-only). Returns file:line matches.', p: obj({ query: { type: 'string' } }, ['query']) },
  read_code: { d: 'Read a file from the codebase (read-only), optionally a line range.', p: obj({ path: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' } }, ['path']) },
  get_telemetry: { d: 'Agent runs from Langfuse per design element and task: attempts, outcomes, tokens, cost, errors; plus tasks suggested as escapes and recorded escapes.', p: obj({}) },
  propose_model_edit: { d: 'Propose an edit to the design model. find must match the model text exactly once (copy it from read_model without line numbers). The user sees a diff and approves or declines.', p: obj({ find: { type: 'string' }, replace: { type: 'string' }, reason: { type: 'string' } }, ['find', 'replace', 'reason']) },
  mint_decision: { d: 'Propose a new decision (status minted). The user approves it; binding stays a human action.', p: obj({ statement: { type: 'string' }, effect: { type: 'string', enum: ['fix', 'accept'] }, binds: { type: 'array', items: { type: 'string' } }, resolves: { type: 'array', items: { type: 'string' } }, requirement: { type: 'string' }, checks: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' }, kind: { type: 'string', enum: ['business', 'technical'] }, relies_on: { type: 'array', items: { type: 'string' } } }, ['statement', 'effect', 'binds', 'checks', 'rationale']) },
  mint_proposal: { d: 'Propose a change to Design or Build (status minted), citing evidence.', p: obj({ kind: { type: 'string', enum: ['lint rule', 'P property', 'grill-me question', 'gate clause', 'eval case', 'routing'] }, statement: { type: 'string' }, evidence: { type: 'string' }, check: { type: 'string' } }, ['kind', 'statement', 'evidence', 'check']) },
};
const toolSpecs = role => Object.entries(TOOLS).filter(([n]) => verdict(role, n) !== 'deny').map(([name, t]) => ({ type: 'function', function: { name, description: t.d, parameters: t.p } }));
const cap = (s, n = 24000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);

// ---------------------------------------------------------------- tool implementations (read)
const numbered = (text, from = 1, to = Infinity) => text.split('\n').map((l, i) => [i + 1, l]).filter(([n]) => n >= from && n <= to).map(([n, l]) => `${String(n).padStart(4)}  ${l}`).join('\n');
const READERS = {
  read_model: a => A.modelText ? cap(numbered(A.modelText, a.from || 1, a.to || Infinity)) : `No model at ${A.cfg.model} yet.`,
  get_findings: () => JSON.stringify(A.diags.map(f => ({ code: f.code, severity: f.sev, where: f.loc.label, line: f.loc.line, message: f.msg, hint: f.hint, unknownProperty: f.unknown || undefined, suppressed: f.suppressed || undefined }))),
  get_gate: () => JSON.stringify({ ready: A.gate.ready, blocking: A.gate.clauses.map(c => ({ kind: c.kind, text: c.text, line: c.line })) }),
  list_decisions: () => JSON.stringify({
    decisions: A.decisions.map(d => ({ id: d.id, status: d.status, effect: d.effect, statement: d.statement, binds: d.binds, resolves: d.resolves, checks: d.checks, requirement: d.requirement, assumptions: d.assumptions || [], latestCheck: (Core.latestCheck(A.ledger, d.id) || {}).outcome || null, file: d._path })),
    requirements: A.requirements.map(r => ({ id: r.id, title: r.title, elements: r.elements })),
  }),
  read_registry_file: async a => { const t = await readText(a.path); return t == null ? `No file ${a.path} in the registry.` : cap(numbered(t)); },
  get_code_map: () => {
    if (!A.facts) return A.cfg.codebase ? 'The codebase has not been extracted yet. Ask the user to run Extract Code Map.' : 'No codebase is configured.';
    const d = A.drift;
    return cap(JSON.stringify({
      repo: A.facts.repo, extractedAt: A.facts.extractedAt,
      elements: A.facts.elements.map(e => ({ name: e.name, kind: e.kind, tech: e.tech, inDesign: d ? d.toDesign.has('e_' + e.key) || !!designNameFor(e.name) : null })),
      dependencies: A.facts.edges.map(e => ({ from: e.from, to: e.to, kind: e.kind, label: e.label, evidence: e.evidence.slice(0, 2).map(v => `${v.file}:${v.line}`) })),
      drift: d ? { inCodeNotDesign: d.undeclared.map(u => `${u.from} -> ${u.to}`), elementsInCodeOnly: d.unknownEls, designedNotInCode: d.unrealised.map(u => `${u.from} -> ${u.to}`), designElementsNotFound: d.missingEls } : 'no design to compare',
      codeAreas: A.areas ? { areas: A.areas.areas.map(a => ({ element: a.name, pattern: a.pattern, files: a.matched, ...(a.hint ? { hint: a.hint } : {}) })), filesInCodebase: A.areas.files, inNoArea: A.areas.unclaimed.length, inNoAreaFirst: A.areas.unclaimed.slice(0, 50) } : 're-extract to see code areas',
      unresolved: A.facts.unresolved.map(u => `${u.where}: ${u.what} (${u.file}:${u.line})`),
    }));
  },
  search_codebase: async a => {
    if (!A.cfg.codebase) return 'No codebase is configured.';
    const hits = await host.searchCode(A.cfg.codebase, a.query, 60);
    return hits.length ? hits.map(h => `${h.file}:${h.line}  ${h.text}`).join('\n') : `No matches for "${a.query}".`;
  },
  read_code: async a => {
    if (!A.cfg.codebase) return 'No codebase is configured.';
    try { return cap(numbered(await host.readCode(A.cfg.codebase, a.path), a.from || 1, a.to || Infinity)); } catch (e) { return `Can't read ${a.path}: ${e.message}`; }
  },
  get_telemetry: () => {
    if (A.tel.error || !A.tel.meta) return `Telemetry unavailable: ${telErrorText(A.tel.error) || 'not loaded'}`;
    const g = telAgg();
    return cap(JSON.stringify({
      source: A.tel.meta.source, lookbackDays: A.tel.meta.lookbackDays, tokensPerPassingTask: g.tpp, costUsd: +g.total.cost.toFixed(3),
      byElement: [...g.byEl.values()].map(e => ({ element: e.element, inDesign: e.known, tasks: e.tasks.size, runs: e.runs, failedRuns: e.failed, tokens: e.tokens, costUsd: +e.cost.toFixed(3) })),
      tasks: [...g.tasks.values()].map(t => ({ task: t.task, element: t.element, attempts: t.runs.length, final: t.final, errors: t.runs.map(r => r.firstError).filter(Boolean) })),
      suggestedEscapes: telSuggestions().map(t => ({ task: t.task, element: t.element, why: t.why })),
      recordedEscapes: A.ledger.filter(e => e.kind === 'escape').map(e => ({ id: e.id, element: e.element, description: e.description, caught_by: e.caught_by || null, code: e.code || null })),
      ruleSources: Core.RULES.map(r => ({ code: r.code, source: r.source })),
    }));
  },
};

// ---------------------------------------------------------------- tool implementations (write, after approval)
// Each returns {preview, apply}; validation happens before the user is asked.
const WRITERS = {
  propose_model_edit: a => {
    const count = A.modelText.split(a.find).length - 1;
    if (!a.find) return { error: 'find is empty.' };
    if (count === 0) return { error: 'find does not match the model text. Call read_model and copy the exact text without line numbers.' };
    if (count > 1) return { error: `find matches ${count} places. Include more surrounding lines so it is unique.` };
    const at = A.modelText.indexOf(a.find), line = A.modelText.slice(0, at).split('\n').length;
    return {
      title: 'Edit the model', detail: a.reason,
      preview: `<div class="diffhead">${esc(A.cfg.model)}, from line ${line}</div>${diffHTML(a.find, a.replace)}`,
      apply: async () => {
        await openFile(A.cfg.model); const b = A.buffers.get(A.cfg.model); const model = b.model;
        const start = model.getPositionAt(model.getValue().indexOf(a.find)), end = model.getPositionAt(model.getValue().indexOf(a.find) + a.find.length);
        model.pushEditOperations([], [{ range: new monacoRef.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: a.replace }], () => null);
        AG.approved.set(A.cfg.model, Date.now()); await save(A.cfg.model); A.modelText = model.getValue(); recompile(); renderAll();
        const live = A.diags.filter(f => !f.suppressed);
        return `Applied at line ${line}. The model now has ${live.filter(f => f.sev === 'error').length} errors and ${live.filter(f => f.sev === 'warning').length} warnings; the gate has ${A.gate.clauses.length} blocking items.`;
      },
    };
  },
  mint_decision: a => {
    const prose = (a.checks || []).find(c => Policy.checkProblem(c));
    if (prose != null) return { error: `Check "${prose}": ${Policy.checkProblem(prose)} Write a shell command that exits 0 when the decision holds, or "TODO <what it must prove>" when none exists yet.` };
    const business = a.kind === 'business';
    if (business) a = { ...a, statement: `PROPOSED: ${String(a.statement).replace(/^PROPOSED:\s*/i, '')}` };
    const id = Core.slugId(a.statement, A.decisions.map(d => d.id));
    const text = `id: ${id}
status: minted          # minted | checked | bound | superseded
kind: ${business ? 'business' : 'technical'}
${(a.relies_on || []).length ? `relies_on: ${yamlList(a.relies_on)}\n` : ''}effect: ${a.effect === 'accept' ? 'accept' : 'fix'}
requirement: ${a.requirement ? yamlStr(a.requirement) : 'null'}
binds: ${yamlList(a.binds || [])}
resolves: ${yamlList((a.resolves || []).map(x => String(x).toUpperCase()))}
statement: ${yamlStr(a.statement)}
checks:
${(a.checks && a.checks.length ? a.checks : ['TODO command that proves it']).map(c => `  - ${yamlStr(c)}`).join('\n')}
rationale: ${yamlStr(a.rationale || '')}
drafted_by: ide-agent
`;
    return { title: `Mint decision ${id}`, detail: a.statement, preview: `<pre class="yamlprev">${esc(text)}</pre>`,
      apply: async () => { AG.approved.set(`decisions/${id}.yaml`, Date.now()); await host.write(`decisions/${id}.yaml`, text); A.tree = await host.tree(); await loadRegistry(); recompile(); renderAll(); return `Created decisions/${id}.yaml as minted. Binding it is up to the user.`; } };
  },
  mint_proposal: a => {
    const id = Core.slugId(a.statement, A.proposals.map(x => x.id));
    const text = `id: ${id}\nstatus: minted\nkind: ${yamlStr(a.kind)}\nevidence: ${yamlStr(a.evidence)}\nstatement: ${yamlStr(a.statement)}\ncheck: ${yamlStr(a.check)}\ndrafted_by: ide-agent\n`;
    return { title: `Mint proposal ${id}`, detail: a.statement, preview: `<pre class="yamlprev">${esc(text)}</pre>`,
      apply: async () => { AG.approved.set(`proposals/${id}.yaml`, Date.now()); await host.write(`proposals/${id}.yaml`, text); A.tree = await host.tree(); await loadRegistry(); recompile(); renderAll(); return `Created proposals/${id}.yaml as minted.`; } };
  },
};
function diffHTML(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  let pre = 0; while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0; while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const ctx = l => `<div class="dl">  ${esc(l)}</div>`;
  return `<pre class="diff">${x.slice(0, pre).map(ctx).join('')}${x.slice(pre, x.length - suf).map(l => `<div class="dl del">- ${esc(l)}</div>`).join('')}${y.slice(pre, y.length - suf).map(l => `<div class="dl add">+ ${esc(l)}</div>`).join('')}${x.slice(x.length - suf).map(ctx).join('')}</pre>`;
}

// ---------------------------------------------------------------- session & loop
const AG = { open: false, agent: 'builtin', role: 'architect', chats: {}, busy: false, reqId: null, pending: [], session: Math.random().toString(36).slice(2, 10),
  acpAgents: {}, aguiAgents: {}, conns: {}, sessRoles: {}, approved: new Map(), graceUntil: 0 };
const chatKey = () => `${AG.agent}:${AG.role}`;
const chat = () => (AG.chats[chatKey()] ||= { messages: [], items: [] });   // messages → model (built-in); items → UI
const isAgui = () => AG.agent.startsWith('agui:');
const agentLabel = () => AG.agent === 'builtin' ? 'designc' : isAgui() ? ((AG.aguiAgents[AG.agent.slice(5)] || {}).label || AG.agent.slice(5)) : ((AG.acpAgents[AG.agent] || {}).label || AG.agent);
const ledger = (kind, fields) => recordEvent(kind, { ...fields, agent: AG.agent, role: AG.role, system: ROLES[AG.role].system, session: AG.session });
function waitFor(chip) { return new Promise(res => AG.pending.push({ chip, resolve: v => { AG.pending = AG.pending.filter(x => x.chip !== chip); res(v); } })); }

// One execution path for designc tools, used by the built-in agent and by ACP agents over MCP.
async function runTool(role, name, args, c, { showReads = true } = {}) {
  const r = roleCfg(role), v = verdict(role, name);
  const chip = { kind: 'tool', name, args, verdict: v, status: 'running', via: AG.agent === 'builtin' ? null : 'designc' };
  const show = v !== 'allow' || showReads;
  if (show) { c.items.push(chip); renderAgent(); }
  let out;
  if (v === 'deny' || (!READERS[name] && !WRITERS[name])) { out = `Denied by policy: the ${r.label} role may not use ${name}.`; chip.status = 'denied'; }
  else if (v === 'allow' && READERS[name]) { try { out = await READERS[name](args); chip.status = 'ok'; } catch (e) { out = `Error: ${e.message}`; chip.status = 'error'; } }
  else {
    const w = WRITERS[name] ? WRITERS[name](args) : { error: `${name} is not available` };
    if (w.error) { out = `Rejected before asking the user: ${w.error}`; chip.status = 'invalid'; if (!show) { c.items.push(chip); } }
    else {
      chip.status = 'waiting'; chip.card = w; renderAgent();
      const ok = await waitFor(chip);
      if (ok) { try { out = await w.apply(); chip.status = 'approved'; } catch (e) { out = `Error while applying: ${e.message}`; chip.status = 'error'; } }
      else { out = 'The user declined this. Do not retry the same change; ask what they would prefer.'; chip.status = 'declined'; }
    }
  }
  chip.result = String(out).slice(0, 600);
  ledger('agent_tool', { tool: name, verdict: v, outcome: chip.status, via: chip.via || 'builtin' });
  renderAgent();
  return { out: String(out), ok: !['denied', 'invalid', 'error', 'declined'].includes(chip.status) };
}
function contextNote() {
  const live = A.diags.filter(f => !f.suppressed);
  let s = `Workspace: ${A.root ? A.root.name : 'none'}. Model: ${A.cfg.model} (${A.model ? A.model.elements.size : 0} elements, ${live.filter(f => f.sev === 'error').length} errors, ${live.filter(f => f.sev === 'warning').length} warnings). Gate: ${A.gate && A.gate.ready ? 'ready' : `${A.gate ? A.gate.clauses.length : 0} blocking`}. Code map: ${A.facts ? `${A.facts.repo}, ${A.drift ? A.drift.undeclared.length + A.drift.unknownEls.length + ' differences' : 'no drift computed'}` : 'not extracted'}. Telemetry: ${A.tel.meta ? `${A.tel.runs.length} runs (${A.tel.meta.source})` : 'unavailable'}.`;
  if (A.active && !A.active.startsWith('special:') && editor) {
    const sel = editor.getSelection(), m = editor.getModel();
    s += `\nThe user has ${A.active} open${sel && !sel.isEmpty() ? `, with lines ${sel.startLineNumber}-${sel.endLineNumber} selected:\n${cap(m.getValueInRange(sel), 4000)}` : '.'}`;
  }
  return s;
}
async function send(text) {
  if (AG.busy || !text.trim() || !A.root) return;
  if (isAgui()) return sendAgui(text);
  if (AG.agent !== 'builtin') return sendAcp(text);
  const c = chat(), r = roleCfg(AG.role);
  c.messages.push({ role: 'user', content: `${text}\n\n[context] ${contextNote()}` });
  c.items.push({ kind: 'user', text });
  AG.busy = true; renderAgent();
  try {
    for (let turn = 0; turn < 12; turn++) {
      const item = { kind: 'assistant', text: '' }; c.items.push(item); renderAgent();
      AG.reqId = 'r' + Date.now() + turn; AG.streamItem = item;
      const res = await host.agentChat(AG.reqId, { role: AG.role, system: r.system, session: AG.session, tools: toolSpecs(AG.role),
        messages: [{ role: 'system', content: `${COMMON_RULES}\n\n${r.instructions}` }, ...c.messages] });
      AG.streamItem = null;
      if (res.cancelled) { item.text += item.text ? '\n\n_Stopped._' : '_Stopped._'; break; }
      if (res.error) { c.items.pop(); c.items.push({ kind: 'error', text: agentError(res) }); break; }
      if (res.usage) ledger('agent_turn', { model: res.model, via: 'builtin', tokens: res.usage.total_tokens || 0,
        ...(res.usage.prompt_tokens != null ? { tokens_in: res.usage.prompt_tokens } : {}),
        ...(res.usage.completion_tokens != null ? { tokens_out: res.usage.completion_tokens } : {}) });
      item.text = res.message.content || item.text;
      if (!item.text) c.items.pop();
      c.messages.push(res.message);
      const calls = res.message.tool_calls || [];
      if (!calls.length) break;
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* bad JSON is reported as a normal tool error */ }
        const { out } = await runTool(AG.role, call.function.name, args, c);
        c.messages.push({ role: 'tool', tool_call_id: call.id, content: out });
      }
    }
  } finally { AG.busy = false; AG.reqId = null; renderAgent(); }
}
// ---------------------------------------------------------------- ACP agents
const ACP_RULES = `[designc] You are connected to designc, a system design IDE, through the Agent Client Protocol. The workspace is a design registry; the design model (Structurizr DSL) is the source of truth and code is generated from it.
Use the "designc" MCP tools to read the model, findings, gate, decisions, code map and telemetry. Change the model or create decisions/proposals with the designc tools that need approval, or by writing files inside the registry; every change is shown to the user as a diff to approve. The codebase is read-only here. Do not bind decisions: that is a human action.
A decision check is a shell command run in the registry folder that exits 0 when the decision holds; designc runs it and records the result. Never write a check as a description such as "Model: ..." or "Test: ...": when no command exists yet, write "TODO <what it must prove>".`;
async function sendAcp(text) {
  const c = chat(), key = AG.agent;
  c.items.push({ kind: 'user', text }); AG.busy = true; renderAgent();
  try {
    if (!AG.conns[key]) {
      const status = { kind: 'status', text: `Starting ${agentLabel()}…` }; c.items.push(status); renderAgent();
      AG.sessRoles[AG.session] = AG.role;
      const r = await host.acpConnect(key, { session: AG.session });
      c.items.splice(c.items.indexOf(status), 1);
      if (r.error) { c.items.push({ kind: 'error', text: `Couldn't start ${agentLabel()}: ${r.error}. Check that it's installed and signed in; the command is in the agent menu's tooltip.` }); return; }
      AG.conns[key] = { ...r.info, role: AG.role, session: AG.session, first: true };
      c.items.push({ kind: 'status', text: `Connected to ${r.info.agent ? (r.info.agent.title || r.info.agent.name) : agentLabel()} over ACP v${r.info.protocolVersion}. designc tools are available as the "designc" MCP server.` });
    }
    const conn = AG.conns[key];
    const prefix = conn.first ? `${ACP_RULES}\n\nRole: ${roleCfg(AG.role).instructions}\n\n` : '';
    conn.first = false;
    AG.turn = { key, c, msg: null, tools: new Map(), started: Date.now() };
    const res = await host.acpPrompt(key, `${prefix}${text}\n\n[context] ${contextNote()}`);
    if (res && res.error) c.items.push({ kind: 'error', text: `${agentLabel()}: ${res.error}` });
    else if (res && res.stopReason && res.stopReason !== 'end_turn') c.items.push({ kind: 'status', text: `Turn ended: ${res.stopReason.replace('_', ' ')}.` });
    ledger('agent_turn', { model: key, via: 'acp', stop_reason: res && res.stopReason, context_used: (AG.turn && AG.turn.used) || null, ms: Date.now() - AG.turn.started });
  } finally { AG.busy = false; AG.turn = null; renderAgent(); }
}
const ACP_STATUS = { pending: 'running', in_progress: 'running', completed: 'ok', failed: 'error' };
function onAcpUpdate(key, p) {
  const t = AG.turn; if (!t || t.key !== key || !p || !p.update) return;
  const u = p.update, c = t.c, textOf_ = x => (x && x.type === 'text' ? x.text : x && x.type === 'resource_link' ? `[${x.name || x.uri}]` : '');
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': case 'agent_message': {
      if (!t.msg || (u.messageId && u.messageId !== t.msgId) || c.items[c.items.length - 1] !== t.msg) { t.msg = { kind: 'assistant', text: '' }; t.msgId = u.messageId; c.items.push(t.msg); }
      const add = Array.isArray(u.content) ? u.content.map(textOf_).join('') : textOf_(u.content);
      t.msg.text = u.sessionUpdate === 'agent_message' ? add : t.msg.text + add; break;
    }
    case 'agent_thought_chunk': {
      if (!t.thought || c.items[c.items.length - 1] !== t.thought) { t.thought = { kind: 'thought', text: '' }; c.items.push(t.thought); }
      t.thought.text += textOf_(u.content); break;
    }
    case 'tool_call': case 'tool_call_update': {
      let chip = t.tools.get(u.toolCallId);
      if (!chip) { chip = { kind: 'tool', acp: true, name: u.title || u.toolCallId, args: {}, status: 'running', toolKind: u.kind }; t.tools.set(u.toolCallId, chip); c.items.push(chip); t.msg = null; }
      if (u.title) chip.name = u.title;
      if (u.kind) chip.toolKind = u.kind;
      if (u.status) chip.status = ACP_STATUS[u.status] || chip.status;
      if (u.locations && u.locations.length) chip.locations = u.locations;
      if (u.content) { const txt = u.content.map(x => x.type === 'content' ? textOf_(x.content) : x.type === 'diff' ? `edited ${x.path}` : '').filter(Boolean).join('\n'); if (txt) chip.result = txt.slice(0, 600); }
      if (u.status === 'completed' || u.status === 'failed') ledger('agent_tool', { tool: chip.name, tool_kind: chip.toolKind, verdict: 'agent', outcome: chip.status, via: 'acp' });
      break;
    }
    case 'plan': { if (!t.plan) { t.plan = { kind: 'plan', entries: [] }; c.items.push(t.plan); } t.plan.entries = u.entries || []; break; }
    case 'usage_update': t.used = u.used; break;
    default: return;
  }
  renderAgent();
}
// session/request_permission → a card with the agent's own options.
async function onAcpPermission(key, p) {
  const c = (AG.turn && AG.turn.c) || chat();
  const tc = p.toolCall || {};
  const chip = { kind: 'perm', title: tc.title || 'The agent wants to run a tool', toolKind: tc.kind, raw: tc.rawInput, options: p.options || [], status: 'waiting' };
  c.items.push(chip); renderAgent();
  const optionId = await waitFor(chip);
  const opt = chip.options.find(o => o.optionId === optionId);
  chip.status = opt ? (/^allow/.test(opt.kind) ? 'approved' : 'declined') : 'declined'; chip.chosen = opt ? opt.name : 'Cancelled';
  ledger('agent_permission', { tool: chip.title, tool_kind: chip.toolKind, outcome: opt ? opt.kind : 'cancelled', via: 'acp' });
  renderAgent();
  return { optionId: optionId || null };
}
// fs/write_text_file → the same write policy as the built-in agent, then a diff to approve.
async function onAcpWrite(key, w) {
  const c = (AG.turn && AG.turn.c) || chat();
  const rel = w.rel || null, role = (AG.conns[key] && AG.conns[key].role) || AG.role;
  const error = Policy.writeVerdict(role, rel, w.content, jsyaml.load).error || null;
  const chip = { kind: 'tool', acp: true, name: `write ${rel || w.path}`, args: {}, status: error ? 'denied' : 'waiting' };
  c.items.push(chip);
  if (error) { chip.result = error; ledger('agent_tool', { tool: 'fs/write_text_file', path: rel || w.path, verdict: 'deny', outcome: 'denied', via: 'acp' }); renderAgent(); return { ok: false, error }; }
  chip.card = { title: w.old == null ? `Create ${rel}` : `Edit ${rel}`, detail: `${agentLabel()} wants to write this file.`, preview: w.old == null ? `<pre class="yamlprev">${esc(w.content)}</pre>` : diffHTML(w.old, w.content) };
  renderAgent();
  const ok = await waitFor(chip);
  chip.status = ok ? 'approved' : 'declined';
  if (ok) AG.approved.set(rel, Date.now() + 2000);
  ledger('agent_tool', { tool: 'fs/write_text_file', path: rel, verdict: 'ask', outcome: chip.status, via: 'acp' });
  renderAgent();
  return ok ? { ok: true } : { ok: false, error: 'The user declined this write.' };
}
// MCP bridge: tools/list and tools/call from the agent's designc MCP server.
function onMcpList(session) {
  const role = AG.sessRoles[session] || AG.role;
  return { tools: toolSpecs(role).map(t => ({ name: t.function.name, description: t.function.description + (verdict(role, t.function.name) === 'ask' ? ' Needs the user\'s approval in designc.' : ''), inputSchema: t.function.parameters })) };
}
async function onMcpCall(req) {
  const role = AG.sessRoles[req.session] || AG.role;
  const c = (AG.turn && AG.turn.c) || chat();
  const r = await runTool(role, req.name, req.arguments || {}, c, { showReads: false });
  return { text: r.out, isError: !r.ok };
}
host.onUiCall(async (id, channel, ...args) => {
  let value = null;
  try {
    if (channel === 'acp:permission') value = await onAcpPermission(...args);
    else if (channel === 'acp:write') value = await onAcpWrite(...args);
    else if (channel === 'mcp:list') value = onMcpList(...args);
    else if (channel === 'mcp:call') value = await onMcpCall(...args);
  } catch (e) { value = channel === 'acp:write' ? { ok: false, error: e.message } : { text: `designc error: ${e.message}`, isError: true }; }
  host.uiReply(id, value);
});
host.onAcp('acp:update', (key, p) => onAcpUpdate(key, p));
host.onAcp('acp:exit', (key, msg) => {
  if (!AG.conns[key]) return;
  delete AG.conns[key];
  const c = (AG.turn && AG.turn.key === key && AG.turn.c) || AG.chats[`${key}:${AG.role}`];
  if (c) { c.items.push({ kind: 'error', text: `${(AG.acpAgents[key] || {}).label || key} stopped: ${msg}` }); renderAgent(); }
});
host.onAcp('acp:log', (key, t) => { AG.logs = ((AG.logs || '') + `[${key}] ${t}`).slice(-20000); });
// External agents can also touch files directly, outside ACP. Anything that changes in the registry during
// an ACP turn without an approved write is flagged and recorded, not silently accepted.
function agentSawChange(paths) {
  const t = AG.turn; if (!t || AG.agent === 'builtin') return;
  const now = Date.now(); let flagged = false;
  if (isAgui() && now < AG.graceUntil) return;
  for (const p of Policy.unapprovedChanges(paths, { approved: AG.approved, ownAppends: OWN_APPENDS, now })) {
    t.c.items.push({ kind: 'error', text: `${agentLabel()} changed ${p} without going through designc's approval. Review it before relying on it.` });
    ledger('unapproved_change', { path: p, via: isAgui() ? 'agui' : 'acp' }); flagged = true;
  }
  if (flagged) renderAgent();
}
// ---------------------------------------------------------------- AG-UI agents (remote services, e.g. MAF)
const uid = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
// Shared state: what designc tells the agent about the design, sent with every run.
function designcState() {
  const live = A.diags.filter(f => !f.suppressed);
  return { designc: {
    model: { path: A.cfg.model, revision: 'r-' + hash(A.modelText || ''), elements: A.model ? A.model.elements.size : 0 },
    findings: { errors: live.filter(f => f.sev === 'error').length, warnings: live.filter(f => f.sev === 'warning').length,
      top: live.slice(0, 25).map(f => ({ code: f.code, severity: f.sev, where: f.loc.label, line: f.loc.line })) },
    gate: { ready: !!(A.gate && A.gate.ready), blocking: A.gate ? A.gate.clauses.slice(0, 25).map(c => c.text) : [] },
    drift: A.drift ? { inCodeNotDesign: A.drift.undeclared.map(u => `${u.from} -> ${u.to}`), elementsInCodeOnly: A.drift.unknownEls } : null,
    decisions: A.decisions.map(d => ({ id: d.id, status: d.status, statement: d.statement })),
  } };
}
function applyPatch(doc, ops) {
  const out = JSON.parse(JSON.stringify(doc || {}));
  for (const op of ops || []) {
    const keys = String(op.path || '').split('/').slice(1).map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!keys.length) { if (op.op === 'add' || op.op === 'replace') return op.value; continue; }
    let cur = out; for (const k of keys.slice(0, -1)) { if (cur[k] == null) cur[k] = {}; cur = cur[k]; }
    const last = keys[keys.length - 1];
    if (op.op === 'remove') Array.isArray(cur) ? cur.splice(+last, 1) : delete cur[last];
    else if (op.op === 'add' && Array.isArray(cur)) last === '-' ? cur.push(op.value) : cur.splice(+last, 0, op.value);
    else if (op.op === 'add' || op.op === 'replace') cur[last] = op.value;
  }
  return out;
}
async function sendAgui(text) {
  const key = AG.agent.slice(5), spec = AG.aguiAgents[key] || {}, c = chat(), role = AG.role, r = roleCfg(role);
  const T = c.agui ||= { threadId: uid('thread'), messages: [], state: null, resolved: new Set(), executed: new Set() };
  c.items.push({ kind: 'user', text });
  T.messages.push({ id: uid('msg'), role: 'user', content: text });
  AG.busy = true; renderAgent();
  const clientTools = spec.clientTools !== false ? toolSpecs(role).map(t => ({ name: t.function.name, description: t.function.description + (verdict(role, t.function.name) === 'ask' ? ' Runs in designc and needs the user\'s approval there.' : ''), parameters: t.function.parameters })) : [];
  const clientNames = new Set(clientTools.map(t => t.name));
  let resume = null;
  AG.turn = { key: AG.agent, c, started: Date.now() };
  try {
    for (let run = 0; run < 12; run++) {
      const runId = uid('run'), calls = new Map(), results = new Set(); let outcome = null, failed = null, msg = null;
      const body = {
        threadId: T.threadId, runId, messages: resume ? [] : T.messages, tools: clientTools,
        context: [{ description: 'designc role and rules', value: `${COMMON_RULES}\n\n${r.instructions}` }, { description: 'designc workspace', value: contextNote() }],
        state: spec.sendState !== false ? { ...(T.state || {}), ...designcState() } : (T.state || {}),
        forwardedProps: { designc: { role, system: r.system, session: AG.session, user: A.user } },
      };
      if (resume) body.resume = resume;
      AG.aguiReq = runId; AG.aguiSeen = 0;
      AG.onAgui = ev => {
        switch (ev.type) {
          case 'TEXT_MESSAGE_START': case 'TEXT_MESSAGE_CHUNK': case 'TEXT_MESSAGE_CONTENT': {
            const id = ev.messageId || (msg && msg.id) || uid('msg');
            if (!msg || msg.id !== id) { msg = { id, item: { kind: 'assistant', text: '' }, hist: { id, role: 'assistant', content: '' } }; c.items.push(msg.item); T.messages.push(msg.hist); }
            if (ev.delta) { msg.item.text += ev.delta; msg.hist.content += ev.delta; }
            break;
          }
          case 'TEXT_MESSAGE_END': msg = null; break;
          case 'TOOL_CALL_START': {
            const call = { id: ev.toolCallId, name: ev.toolCallName, args: '', chip: { kind: 'tool', acp: true, name: ev.toolCallName, args: {}, status: 'running' } };
            calls.set(ev.toolCallId, call);
            if (!clientNames.has(call.name)) c.items.push(call.chip); else call.chip = null;
            let host_ = ev.parentMessageId && T.messages.find(m => m.id === ev.parentMessageId);
            if (!host_ || host_.role !== 'assistant') { host_ = { id: ev.parentMessageId || uid('msg'), role: 'assistant', content: '' }; T.messages.push(host_); }
            (host_.toolCalls ||= []).push({ id: call.id, type: 'function', function: { name: call.name, arguments: '' } });
            call.hist = host_.toolCalls[host_.toolCalls.length - 1]; msg = null; break;
          }
          case 'TOOL_CALL_ARGS': { const call = calls.get(ev.toolCallId); if (call) { call.args += ev.delta || ''; call.hist.function.arguments = call.args; } break; }
          case 'TOOL_CALL_END': break;
          case 'TOOL_CALL_RESULT': {
            results.add(ev.toolCallId); const call = calls.get(ev.toolCallId);
            if (call && call.chip) { call.chip.status = 'ok'; call.chip.result = String(ev.content || '').slice(0, 600); }
            T.messages.push({ id: ev.messageId || uid('msg'), role: 'tool', toolCallId: ev.toolCallId, content: String(ev.content ?? '') });
            ledger('agent_tool', { tool: call ? call.name : ev.toolCallId, verdict: 'agent', outcome: 'ok', via: 'agui' }); break;
          }
          case 'STATE_SNAPSHOT': T.state = ev.snapshot; showState(c, T); break;
          case 'STATE_DELTA': T.state = applyPatch(T.state, ev.delta); showState(c, T); break;
          case 'MESSAGES_SNAPSHOT': if (Array.isArray(ev.messages)) T.messages = ev.messages; break;
          case 'STEP_STARTED': c.items.push({ kind: 'status', text: `Step: ${ev.stepName}` }); break;
          case 'RUN_ERROR': failed = ev.message || 'The agent reported an error.'; break;
          case 'RUN_FINISHED': outcome = ev.outcome || null; break;
          default:
            if (/THINKING|REASONING/.test(ev.type) && ev.delta) {
              const last = c.items[c.items.length - 1];
              if (last && last.kind === 'thought') last.text += ev.delta; else c.items.push({ kind: 'thought', text: ev.delta });
            }
        }
        renderAgent();
      };
      const res = await host.aguiRun(runId, key, body);
      await drainAgui(res && res.events);
      AG.onAgui = null; resume = null;
      ledger('agent_turn', { model: `agui:${key}`, via: 'agui', run_id: runId, ms: Date.now() - AG.turn.started });
      if (res.cancelled) { c.items.push({ kind: 'status', text: 'Stopped.' }); break; }
      if (res.error || failed) { c.items.push({ kind: 'error', text: `${agentLabel()}: ${failed || res.error}` }); break; }

      // 1. Interrupts (MAF approvals, or any other interrupt): ask once per interrupt id, then resume.
      const interrupts = outcome && outcome.type === 'interrupt' ? (outcome.interrupts || []).filter(i => !T.resolved.has(i.id)) : [];
      if (interrupts.length) {
        const entries = [];
        for (const it of interrupts) {
          T.resolved.add(it.id);
          const fc = it.metadata && it.metadata.agent_framework && it.metadata.agent_framework.function_call;
          const call = it.toolCallId && calls.get(it.toolCallId);
          const name = (fc && fc.name) || (call && call.name) || null;
          let args = fc ? fc.arguments : null; if (!args && call) { try { args = JSON.parse(call.args || '{}'); } catch { args = call.args; } }
          if (call && call.chip) call.chip.status = 'waiting';
          const chip = { kind: 'perm', title: it.message || (name ? `Approve ${name}?` : 'The agent is waiting for you'), toolKind: name || it.reason, raw: args,
            options: [{ optionId: 'accept', name: 'Approve', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }], status: 'waiting' };
          c.items.push(chip); renderAgent();
          const choice = await waitFor(chip);
          chip.status = choice === 'accept' ? 'approved' : 'declined'; chip.chosen = choice === 'accept' ? 'Approved' : choice === 'reject' ? 'Rejected' : 'Cancelled';
          if (call && call.chip) call.chip.status = choice === 'accept' ? 'running' : 'declined';
          if (choice === 'accept') AG.graceUntil = Date.now() + 30000;   // the host may now write what was approved
          entries.push(choice ? { interruptId: it.id, status: 'resolved', payload: { accepted: choice === 'accept' } } : { interruptId: it.id, status: 'cancelled' });
          ledger('agent_approval', { tool: name, interrupt: it.id, outcome: choice || 'cancelled', via: 'agui' });
        }
        resume = entries; renderAgent(); continue;
      }
      // 2. Frontend tools the agent called: run them in designc (policy + approvals), once per call id.
      const pending = [...calls.values()].filter(x => clientNames.has(x.name) && !results.has(x.id) && !T.executed.has(x.id));
      if (pending.length) {
        for (const call of pending) {
          T.executed.add(call.id);
          let args = {}; try { args = JSON.parse(call.args || '{}'); } catch { /* reported by the tool */ }
          const out = await runTool(role, call.name, args, c, { showReads: true });
          T.messages.push({ id: uid('msg'), role: 'tool', toolCallId: call.id, content: out.out });
        }
        continue;
      }
      break;
    }
  } finally { AG.busy = false; AG.turn = null; AG.aguiReq = null; AG.onAgui = null; renderAgent(); }
}
function showState(c, T) {
  let it = c.items.find(x => x.kind === 'state' && x.thread === T.threadId);
  if (!it) { it = { kind: 'state', thread: T.threadId }; c.items.push(it); }
  const { designc, ...agentOwned } = T.state || {};
  it.json = JSON.stringify(agentOwned, null, 2);
}
host.onAcp('agui:event', (id, ev, n) => {
  if (id !== AG.aguiReq || !AG.onAgui) return;
  AG.onAgui(ev); AG.aguiSeen = n;
  if (AG.aguiWait && n >= AG.aguiWait.n) { AG.aguiWait.resolve(); AG.aguiWait = null; }
});
// Wait until every event the main process sent for this run has been handled (bounded, just in case).
function drainAgui(n) {
  if (!n || AG.aguiSeen >= n) return Promise.resolve();
  return new Promise(resolve => { AG.aguiWait = { n, resolve }; setTimeout(() => { if (AG.aguiWait) { AG.aguiWait = null; resolve(); } }, 5000); });
}

async function loadAcpAgents() {
  try { AG.acpAgents = await host.acpAgents(); } catch { AG.acpAgents = {}; }
  try { AG.aguiAgents = await host.aguiAgents(); } catch { AG.aguiAgents = {}; }
  const sel = $('#agAgent'); if (!sel) return;
  sel.innerHTML = `<option value="builtin" title="Built-in loop through your gateway (any model LiteLLM routes)">designc (gateway)</option>` +
    Object.entries(AG.aguiAgents).map(([k, v]) => `<option value="agui:${esc(k)}" title="${esc(v.url)}">${esc(v.label)} (AG-UI)</option>`).join('') +
    Object.entries(AG.acpAgents).map(([k, v]) => `<option value="${esc(k)}" title="${esc(v.command)}">${esc(v.label)} (ACP)</option>`).join('');
  if (AG.agent !== 'builtin' && !(AG.agent in AG.acpAgents) && !(isAgui() && AG.agent.slice(5) in AG.aguiAgents)) AG.agent = 'builtin';
  sel.value = AG.agent;
}

function agentError(r) {
  if (r.error === 'not_configured') return 'The agent panel needs a model. Open Help, Open settings, or use Set up this folder to choose a model provider.';
  if (r.error === 'no_key') return `Set the ${r.env} environment variable to your model key, then restart designc.`;
  if (r.error === 'no_gcloud' || r.error === 'no_adc') return `${r.error === 'no_gcloud' ? 'gcloud is not installed.' : 'Google credentials are not set up.'} ${r.hint}`;
  if (r.error === 'no_project') return 'Set llm.project in designc.json (Set up this folder has a field for it), or GOOGLE_CLOUD_PROJECT in your environment.';
  if (r.error === 'invalid') return 'The llm settings in designc.json are not valid. Open Set up this folder to check the provider, project, region and model.';
  if (r.error === 'http') return `The model provider answered ${r.status}: ${r.message}${/tool/i.test(r.message || '') ? ' (does this model support tool calling?)' : ''}`;
  return `Couldn't reach the model provider: ${r.message || r.error}`;
}

// ---------------------------------------------------------------- rendering
function md(t) {
  const blocks = String(t || '').split(/```(\w*)\n?([\s\S]*?)```/g); let h = '';
  for (let i = 0; i < blocks.length; i++) {
    if (i % 3 === 1) continue;
    if (i % 3 === 2) { h += `<pre class="code">${esc(blocks[i])}</pre>`; continue; }
    const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;])/g, '$1<i>$2</i>');
    for (const para of blocks[i].split(/\n{2,}/)) {
      const lines = para.split('\n').filter(l => l.trim());
      if (!lines.length) continue;
      if (lines.every(l => /^\s*([-*]|\d+\.)\s/.test(l))) h += `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>`).join('')}</ul>`;
      else if (/^#{1,4}\s/.test(lines[0])) h += `<p><b>${inline(lines[0].replace(/^#+\s/, ''))}</b>${lines.slice(1).map(l => '<br>' + inline(l)).join('')}</p>`;
      else h += `<p>${lines.map(inline).join('<br>')}</p>`;
    }
  }
  return h;
}
const STATUS = { running: ['…', 'running'], ok: ['✓', ''], denied: ['⊘', 'denied by policy'], invalid: ['!', 'rejected before asking you'], waiting: ['?', 'waiting for you'], approved: ['✓', 'approved'], declined: ['✕', 'declined'], error: ['!', 'error'] };
function argSummary(n, a) { return n === 'search_codebase' ? `"${a.query}"` : n === 'read_code' || n === 'read_registry_file' ? a.path : n === 'read_model' && a.from ? `lines ${a.from}-${a.to || '…'}` : ''; }
function renderAgent() {
  const panel = $('#agent'); if (!panel) return;
  $('#shell').classList.toggle('withagent', AG.open);
  document.querySelector('[data-agenttoggle]').setAttribute('aria-selected', String(AG.open));
  if (!AG.open) return;
  const c = chat(), r = ROLES[AG.role];
  $('#agRole').value = AG.role; if ($('#agAgent')) $('#agAgent').value = AG.agent;
  $('#agConn').textContent = AG.agent === 'builtin' ? '' : isAgui() ? 'service' : AG.conns[AG.agent] ? 'connected' : 'not started';
  const log = $('#agLog');
  if (!A.root) log.innerHTML = `<div class="agempty">Open a registry folder to talk to its agents.</div>`;
  else if (!c.items.length) log.innerHTML = `<div class="agempty"><p><b>${esc(r.label)}</b>. ${esc(r.instructions.split('. ')[0].replace(/^You are (the )?/, ''))}.</p>
      <p class="muted">${isAgui() ? `${esc(agentLabel())} is a remote agent service over AG-UI (${esc((AG.aguiAgents[AG.agent.slice(5)] || {}).url || '')}). Its own tools run in the service under its governance; approvals it requires come here as cards. designc's tools run here, under the same policy as the other agents.` : AG.agent === 'builtin' ? `Runs through your gateway. Reads freely; ${!roleCfg(AG.role).ask.length ? 'it cannot change anything.' : ''}${roleCfg(AG.role).ask.map(t => `<code>${t}</code>`).join(', ')} ${!roleCfg(AG.role).ask.length ? '' : `${roleCfg(AG.role).ask.length === 1 ? 'needs' : 'need'} your approval; everything else is refused.`}` : `${esc(agentLabel())} runs as its own process over ACP, with designc's tools as an MCP server. Its permission requests and every file write come here for approval; writes outside the registry are refused.`}</p>
      ${r.starters.map(s => `<button class="agstart" data-agstart="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
  else log.innerHTML = c.items.map((it, i) => {
    if (it.kind === 'user') return `<div class="agmsg user">${esc(it.text)}</div>`;
    if (it.kind === 'error') return `<div class="agmsg err">${esc(it.text)}${/designc\.json/.test(it.text) ? ' <button class="lnk" data-agsettings>Open designc.json</button>' : ''}</div>`;
    if (it.kind === 'assistant') return `<div class="agmsg bot">${it.text ? md(it.text) : '<span class="muted">Thinking…</span>'}</div>`;
    if (it.kind === 'status') return `<div class="agstatus">${esc(it.text)}</div>`;
    if (it.kind === 'state') return it.json && it.json !== '{}' ? `<details class="agthought"><summary>Agent state</summary><pre class="yamlprev">${esc(it.json)}</pre></details>` : '';
    if (it.kind === 'thought') return `<details class="agthought"><summary>Thinking</summary><div>${esc(it.text)}</div></details>`;
    if (it.kind === 'plan') return `<div class="agplan"><div class="t">Plan</div>${it.entries.map(e => `<div class="pe ${esc(e.status)}"><span>${e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '▸' : '○'}</span>${esc(e.content)}</div>`).join('')}</div>`;
    if (it.kind === 'perm') {
      const raw = it.raw ? `<pre class="yamlprev">${esc(typeof it.raw === 'string' ? it.raw : JSON.stringify(it.raw, null, 2)).slice(0, 1500)}</pre>` : '';
      return `<div class="agcard perm ${it.status}"><div class="t">${esc(agentLabel())} asks permission</div><div>${esc(it.title)}${it.toolKind ? ` <span class="tag">${esc(it.toolKind)}</span>` : ''}</div>${raw}
        ${it.status === 'waiting' ? `<div class="acts">${it.options.map(o => `<button class="btn ${/^allow/.test(o.kind) ? (o.kind === 'allow_once' ? 'primary' : '') : ''}" data-perm="${esc(o.optionId)}" data-i="${i}">${esc(o.name)}</button>`).join('')}</div>` : `<div class="muted" style="margin-top:4px">${esc(it.chosen || '')}</div>`}</div>`;
    }
    const [ic, word] = STATUS[it.status] || ['·', it.status];
    let h = `<details class="agtool ${it.status}" ${it.status === 'waiting' ? 'open' : ''}><summary><span class="ic">${ic}</span>${it.acp ? `<span class="acpt">${esc(it.name)}</span>` : `<code>${it.via ? 'designc · ' : ''}${esc(it.name)}</code>`} <span class="muted">${esc(argSummary(it.name, it.args))}</span>${word ? `<span class="st">${word}</span>` : ''}</summary>`;
    if (it.card) h += `<div class="agcard"><div class="t">${esc(it.card.title)}</div>${it.card.detail ? `<div class="muted">${esc(it.card.detail)}</div>` : ''}${it.card.preview}${it.status === 'waiting' ? `<div class="acts"><button class="btn primary" data-agok data-i="${i}">Approve</button><button class="btn" data-agno data-i="${i}">Decline</button></div>` : ''}</div>`;
    if (it.result && (it.status !== 'ok' || it.acp)) h += `<div class="agres">${esc(it.result)}</div>`;
    return h + '</details>';
  }).join('');
  log.scrollTop = log.scrollHeight;
  $('#agSend').style.display = AG.busy ? 'none' : ''; $('#agStop').style.display = AG.busy ? '' : 'none';
  $('#agInput').disabled = !A.root;
}
function setRole(role) {
  AG.role = role;
  if (AG.agent !== 'builtin' && !isAgui() && AG.conns[AG.agent]) { host.acpDisconnect(AG.agent); delete AG.conns[AG.agent]; }
}
// "Ask the tutor" buttons across the app: switch to the Tutor, open the panel and send the question.
function askTutor(question) {
  if (AG.busy) return toast('The agent is still answering. Stop it or wait, then ask again.', 'error');
  if (AG.role !== 'tutor') setRole('tutor');
  toggleAgent(true); send(question);
}
// Grill-me in the panel, for when no model is set: uses the chosen ACP or AG-UI agent, or the first ACP one. False when there is none.
function grillInPanel(text) {
  if (AG.busy) { toast('The agent is still answering. Stop it or wait, then try again.', 'error'); return true; }
  if (AG.agent === 'builtin') { const key = Object.keys(AG.acpAgents)[0]; if (!key) return false; AG.agent = key; }
  if (AG.role !== 'grill') setRole('grill');
  toggleAgent(true); send(text); return true;
}
function toggleAgent(force) { AG.open = force ?? !AG.open; renderAgent(); if (AG.open) setTimeout(() => $('#agInput').focus(), 50); }

// ---------------------------------------------------------------- events
host.onAgentDelta((id, chunk) => { if (id === AG.reqId && AG.streamItem) { AG.streamItem.text += chunk; renderAgent(); } });
document.addEventListener('click', e => {
  const t = e.target.closest('[data-agenttoggle],[data-agstart],[data-agok],[data-agno],[data-perm],[data-agsettings],#agSend,#agStop,#agNew'); if (!t) return;
  if (t.dataset.agenttoggle != null) return toggleAgent();
  if (t.dataset.agstart) return send(t.dataset.agstart);
  const pend = () => { const it = chat().items[+t.dataset.i]; return AG.pending.find(p => p.chip === it); };
  if (t.dataset.agok != null) { const p = pend(); return p && p.resolve(true); }
  if (t.dataset.agno != null) { const p = pend(); return p && p.resolve(false); }
  if (t.dataset.perm != null) { const p = pend(); return p && p.resolve(t.dataset.perm); }
  if (t.dataset.agsettings != null) return openFile('designc.json');
  if (t.id === 'agSend') { const v = $('#agInput').value; $('#agInput').value = ''; return send(v); }
  if (t.id === 'agStop') { for (const p of [...AG.pending]) p.resolve(p.chip.kind === 'perm' ? null : false); if (AG.reqId) host.agentCancel(AG.reqId); if (AG.aguiReq) host.aguiCancel(AG.aguiReq); else if (AG.agent !== 'builtin') host.acpCancel(AG.agent); return; }
  if (t.id === 'agNew') { if (AG.busy) return; AG.chats[chatKey()] = { messages: [], items: [] }; AG.session = Math.random().toString(36).slice(2, 10); if (AG.agent !== 'builtin' && !isAgui()) { host.acpDisconnect(AG.agent); delete AG.conns[AG.agent]; } renderAgent(); }
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'agInput' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = e.target.value; e.target.value = ''; send(v); }
});
document.addEventListener('change', e => {
  if (e.target.id === 'agRole') { if (AG.busy) { e.target.value = AG.role; return; } setRole(e.target.value); renderAgent(); }
  if (e.target.id === 'agAgent') { if (AG.busy) { e.target.value = AG.agent; return; } AG.agent = e.target.value; renderAgent(); }
});
host.onFolder(() => { AG.conns = {}; AG.chats = {}; setTimeout(loadAcpAgents, 300); });
host.onChanged(paths => { if (paths.includes('designc.json')) loadAcpAgents(); });
host.onCmd(cmd => { if (cmd === 'toggle-agent') toggleAgent(); });
renderAgent();
setTimeout(loadAcpAgents, 500);
