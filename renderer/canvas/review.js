/* designc-canvas: design review.
   Turns a model and its findings into the review a principal engineer runs before sign-off:
   open findings, quality-attribute questions per element, STRIDE per trust-boundary crossing,
   OWASP agentic checks per agent, a capacity and agent-cost estimate, and decisions to record.
   Output is plain data plus Markdown, so a host can render it or save it as a file. */
(function (root, factory) {
  const m = factory(typeof require === 'function' && typeof module === 'object' ? require('./vocabulary.js') : root.DesigncCanvas.vocabulary);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else (root.DesigncCanvas = root.DesigncCanvas || {}).review = m;
})(typeof self !== 'undefined' ? self : this, function (V) {
  'use strict';

  function role(Core, e) {
    if (e.kind === 'person') return 'person';
    if (e.tags.has('Agent')) return 'agent';
    if (e.tags.has('Queue')) return 'queue';
    if (Core.isStore(e)) return 'store';
    if (e.tags.has('External')) return 'external';
    return 'service';
  }
  function zoneOf(Core, m, id) { let c = m.elements.get(id); while (c) { const z = Core.get(c, 'd.zone'); if (z) return z; c = c.parent ? m.elements.get(c.parent) : null; } return null; }
  const leaves = m => { const kids = new Set([...m.elements.values()].filter(e => e.parent).map(e => e.parent)); return [...m.elements.values()].filter(e => !kids.has(e.id)); };

  // ---------------------------------------------------------------- capacity (back-of-the-envelope)
  const CAP_DEFAULTS = { dailyActiveUsers: 2000, requestsPerUserPerDay: 40, peakFactor: 5, payloadKB: 8, writeRatio: 0.2, retentionDays: 365, replicas: 3,
    agentRunsPerDay: 500, tokensPerRun: 60000, outputShare: 0.15, pricePerMTokIn: 3, pricePerMTokOut: 15, expectedAttempts: 1.3 };
  function capacity(input) {
    const c = { ...CAP_DEFAULTS, ...(input || {}) };
    const reqDay = c.dailyActiveUsers * c.requestsPerUserPerDay, avgRps = reqDay / 86400, peakRps = avgRps * c.peakFactor;
    const writeGBDay = reqDay * c.writeRatio * c.payloadKB / 1024 / 1024;
    const storedGB = writeGBDay * c.retentionDays * c.replicas;
    const tokDay = c.agentRunsPerDay * c.tokensPerRun * c.expectedAttempts;
    const costDay = tokDay * ((1 - c.outputShare) * c.pricePerMTokIn + c.outputShare * c.pricePerMTokOut) / 1e6;
    return { input: c, requestsPerDay: reqDay, avgRps, peakRps, writeGBPerDay: writeGBDay, storedGB, agentTokensPerDay: tokDay, agentCostPerDay: costDay, agentCostPerMonth: costDay * 30 };
  }

  // ---------------------------------------------------------------- review
  function generate(Core, model, diags, opts = {}) {
    const g = (e, k) => Core.get(e, k);
    const live = (diags || []).filter(d => !d.suppressed && d.sev !== 'note');
    const els = leaves(model);
    const agents = els.filter(e => e.tags.has('Agent'));
    const status = v => (v == null ? 'open' : 'answered');

    const quality = els.map(e => {
      const r = role(Core, e);
      const qs = [...V.NFR_QUESTIONS.any, ...(V.NFR_QUESTIONS[r === 'agent' ? 'service' : r] || [])]
        .map(([attr, question, prop]) => ({ attr, question, prop: prop || null, value: prop ? g(e, prop) : null, status: prop ? status(g(e, prop)) : 'discuss' }));
      return { element: e.name, role: r, questions: qs };
    });

    const threats = [];
    for (const r of model.rels) {
      const zs = zoneOf(Core, model, r.src), zd = zoneOf(Core, model, r.dst);
      if (!zs || !zd || zs === zd) continue;
      const facts = { authenticated: g(r, 'd.authenticated'), encrypted: g(r, 'd.encrypted') };
      threats.push({ flow: `${model.elements.get(r.src).name} → ${model.elements.get(r.dst).name}`, crossing: `${zs} → ${zd}`, line: r.line,
        stride: V.STRIDE.map(([cat, question, gap]) => ({ category: cat, question, gap: !!gap(facts) })) });
    }

    const agentic = agents.map(a => {
      const outs = model.rels.filter(r => r.src === a.id), dst = r => model.elements.get(r.dst);
      const tools = outs.filter(r => dst(r) && (dst(r).tags.has('Tool') || dst(r).tags.has('MCP Server'))).map(r => dst(r).name);
      // Same exemptions as rule AG002: model calls and the agent's own traces are not side effects to gate.
      const writes = outs.filter(r => ['write', 'irreversible'].includes(g(r, 'd.tool.effect')) && dst(r) && !dst(r).tags.has('Trace Store') && !dst(r).tags.has('LLM'));
      const legs = ['untrustedInput', 'privateData', 'externalComms'].map(k => [k, g(a, 'd.agent.' + k)]);
      const check = {
        ASI01: legs.filter(([, v]) => v === 'yes').length === 3 ? 'risk: all three trifecta legs' : legs.some(([, v]) => v == null) ? 'open: declare the trifecta legs' : 'ok: at most two trifecta legs',
        ASI02: writes.length ? (writes.every(r => ['human', 'policy'].includes(g(r, 'd.approval'))) ? `ok: ${writes.length} write(s), all gated` : `risk: ${writes.filter(r => !['human', 'policy'].includes(g(r, 'd.approval'))).length} ungated write(s)`) : 'ok: no declared writes',
        ASI03: g(a, 'd.agent.identity') ? (g(a, 'd.agent.identity') === 'shared' ? 'risk: shared identity' : `ok: ${g(a, 'd.agent.identity')} identity`) : 'open: identity undeclared',
        ASI04: tools.length ? `review: ${tools.length} tool source(s) to pin and vet (${tools.join(', ')})` : 'ok: no tool sources declared',
        ASI05: g(a, 'd.agent.codeExec') === 'yes' ? (g(a, 'd.agent.sandbox') === 'yes' ? 'ok: sandboxed code execution' : 'risk: code execution without sandbox') : 'ok: no code execution declared',
        ASI06: g(a, 'd.agent.memory') ? `review: ${g(a, 'd.agent.memory')} memory` : 'open: memory undeclared',
        ASI07: outs.some(r => dst(r) && dst(r).tags.has('Agent')) ? (outs.filter(r => dst(r) && dst(r).tags.has('Agent')).every(r => g(r, 'd.authenticated') === 'yes') ? 'ok: agent calls authenticated' : 'risk: agent calls not all authenticated') : 'ok: no agent-to-agent calls',
        ASI08: g(a, 'd.agent.maxSteps') != null || g(a, 'd.agent.budget') != null ? `ok: capped (${[g(a, 'd.agent.maxSteps') != null && g(a, 'd.agent.maxSteps') + ' steps', g(a, 'd.agent.budget')].filter(Boolean).join(', ')})` : 'risk: no step or budget cap',
        ASI09: writes.some(r => g(r, 'd.approval') === 'human') ? 'review: approvals must show evidence, not just a yes/no' : 'ok: no human approvals to rubber-stamp',
        ASI10: g(a, 'd.agent.tracing') === 'yes' ? 'ok: traced' : 'risk: not traced',
      };
      return { agent: a.name, autonomy: g(a, 'd.agent.autonomy') || 'undeclared', model: g(a, 'd.agent.model') || 'undeclared', tools, owasp: V.OWASP_ASI.map(([id, title, mitigation]) => ({ id, title, mitigation, status: check[id] })) };
    });

    const decisions = [];
    for (const f of live.filter(d => d.sev === 'error')) decisions.push(`${f.code} on ${f.loc.label}: fix it, or accept the risk as a bound decision with a check.`);
    for (const q of quality) {
      const wanted = q.role === 'store' ? ['Recovery', 'Security', 'Compliance'] : q.role === 'agent' ? ['Availability'] : [];
      for (const x of q.questions.filter(x => x.status === 'open' && wanted.includes(x.attr))) decisions.push(`${q.element}: ${x.question}`);
    }

    const cap = capacity(opts.capacity);
    const review = { title: opts.title || model.name, date: opts.date || new Date().toISOString().slice(0, 10),
      summary: { elements: els.length, agents: agents.length, relationships: model.rels.length, boundaryCrossings: threats.length, errors: live.filter(d => d.sev === 'error').length, warnings: live.filter(d => d.sev === 'warning').length },
      findings: live.map(d => ({ code: d.code, severity: d.sev, where: d.loc.label, line: d.loc.line, message: d.msg, hint: d.hint })),
      quality, threats, agentic, capacity: cap, decisions: decisions.slice(0, 40), patterns: V.PATTERNS, sources: V.SOURCES };
    review.markdown = toMarkdown(review);
    return review;
  }

  const c_ = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const pl = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const n = (x, d = 0) => Number(x).toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: d });
  function toMarkdown(r) {
    const L = [];
    L.push(`# Design review: ${r.title}`, '', `${r.date}. ${pl(r.summary.elements, 'element')} (${pl(r.summary.agents, 'agent')}), ${pl(r.summary.relationships, 'relationship')}, ${pl(r.summary.boundaryCrossings, 'trust-boundary crossing')}. ${pl(r.summary.errors, 'error')} and ${pl(r.summary.warnings, 'warning')} open.`, '');
    L.push('## Open findings', '');
    if (r.findings.length) { L.push('| Code | Severity | Where | Finding |', '| --- | --- | --- | --- |'); r.findings.forEach(f => L.push(`| ${f.code} | ${f.severity} | ${c_(f.where)} (line ${f.line}) | ${c_(f.message + (f.hint ? `. ${f.hint}` : ''))} |`)); }
    else L.push('None.');
    L.push('', '## Decisions to record', '');
    if (r.decisions.length) r.decisions.forEach((d, i) => L.push(`${i + 1}. ${d}`)); else L.push('None outstanding.');
    L.push('', '## Quality attributes', '');
    for (const q of r.quality) {
      L.push(`### ${q.element} (${q.role})`, '', '| Attribute | Question | Status |', '| --- | --- | --- |');
      q.questions.forEach(x => L.push(`| ${x.attr} | ${c_(x.question)} | ${c_(x.status === 'answered' ? `${x.prop} = ${x.value}` : x.status === 'open' ? `open${x.prop ? ` (set ${x.prop})` : ''}` : 'discuss in review')} |`));
      L.push('');
    }
    L.push('## Threat model (STRIDE per trust-boundary crossing)', '');
    if (!r.threats.length) L.push('No crossings found. Declare d.zone on elements (children inherit it) to find them.', '');
    for (const t of r.threats) {
      L.push(`### ${t.flow} (${t.crossing}, line ${t.line})`, '', '| Threat | Question | Model says |', '| --- | --- | --- |');
      t.stride.forEach(s => L.push(`| ${s.category} | ${c_(s.question)} | ${s.gap ? 'gap' : 'check in review'} |`));
      L.push('');
    }
    L.push('## Agentic review (OWASP Top 10 for Agentic Applications 2026)', '');
    if (!r.agentic.length) L.push('No agents in the model. Tag an element "Agent" to include it.', '');
    for (const a of r.agentic) {
      L.push(`### ${a.agent}`, '', `Autonomy: ${a.autonomy}. Model: ${a.model}. Tools: ${a.tools.join(', ') || 'none declared'}.`, '', '| Risk | Status | Mitigation |', '| --- | --- | --- |');
      a.owasp.forEach(o => L.push(`| ${o.id} ${o.title} | ${c_(o.status)} | ${c_(o.mitigation)} |`));
      L.push('');
    }
    const c = r.capacity, i = c.input;
    L.push('## Capacity and agent cost (estimate)', '',
      `Inputs: ${n(i.dailyActiveUsers)} daily users × ${n(i.requestsPerUserPerDay)} requests, peak ×${i.peakFactor}, ${i.payloadKB} KB payloads, ${Math.round(i.writeRatio * 100)}% writes, ${i.retentionDays} days retention, ${i.replicas} replicas. ${n(i.agentRunsPerDay)} agent runs/day × ${n(i.tokensPerRun)} tokens × ${i.expectedAttempts} expected attempts, $${i.pricePerMTokIn}/$${i.pricePerMTokOut} per million input/output tokens.`, '',
      '| Measure | Estimate |', '| --- | --- |',
      `| Requests per day | ${n(c.requestsPerDay)} |`, `| Average / peak requests per second | ${n(c.avgRps, 1)} / ${n(c.peakRps, 1)} |`,
      `| New data per day | ${n(c.writeGBPerDay, 2)} GB |`, `| Stored over retention (with replicas) | ${n(c.storedGB, 1)} GB |`,
      `| Agent tokens per day | ${n(c.agentTokensPerDay)} |`, `| Agent model cost per day / month | $${n(c.agentCostPerDay, 2)} / $${n(c.agentCostPerMonth, 0)} |`, '',
      'Expected attempts is the lever: every open finding on an element that agents build raises it. Calibrate it from Langfuse history once handovers exist.', '');
    L.push('## Agent workflow patterns', '', 'From Anthropic, "Building effective agents". Prefer the simplest pattern that fits; add autonomy only where the steps cannot be predicted.', '', '| Pattern | Use when |', '| --- | --- |');
    r.patterns.forEach(([p, w]) => L.push(`| ${p} | ${c_(w)} |`));
    L.push('', '## Sources', ''); r.sources.forEach(([t, u]) => L.push(`- [${t}](${u})`));
    return L.join('\n') + '\n';
  }
  return { generate, capacity, CAP_DEFAULTS, toMarkdown };
});
