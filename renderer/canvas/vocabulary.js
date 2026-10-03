/* designc-canvas: vocabulary.
   Stencils for the palette, the extra d.* design properties (quality attributes and agentic design),
   and the question banks the design review uses. Plain data; no DOM. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else (root.DesigncCanvas = root.DesigncCanvas || {}).vocabulary = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const YN = ['yes', 'no'];

  // ---------------------------------------------------------------- stencils
  // kind: the Structurizr element kind. tags: added to the element. shape: how the canvas draws it.
  // props: only what the stencil implies. Everything else stays undeclared until a rule needs it.
  const STENCILS = [
    { id: 'person', group: 'C4', label: 'Person', kind: 'person', tags: [], shape: 'person', glyph: '◯' },
    { id: 'system', group: 'C4', label: 'Software system', kind: 'softwareSystem', tags: [], shape: 'box', glyph: '▢' },
    { id: 'external', group: 'C4', label: 'External system', kind: 'softwareSystem', tags: ['External'], shape: 'box', glyph: '⇱' },
    { id: 'container', group: 'C4', label: 'Service', kind: 'container', tags: [], shape: 'box', glyph: '▭', tech: '' },
    { id: 'webapp', group: 'C4', label: 'Web app', kind: 'container', tags: ['Web App'], shape: 'browser', glyph: '⌂' },
    { id: 'worker', group: 'C4', label: 'Worker', kind: 'container', tags: ['Worker'], shape: 'box', glyph: '⚙' },
    { id: 'database', group: 'Data', label: 'Database', kind: 'container', tags: ['Database'], shape: 'cylinder', glyph: '⛁' },
    { id: 'cache', group: 'Data', label: 'Cache', kind: 'container', tags: ['Cache'], shape: 'cylinder-dashed', glyph: '⚡', props: { 'd.store': 'yes' } },
    { id: 'blob', group: 'Data', label: 'Blob storage', kind: 'container', tags: ['Blob Store'], shape: 'cylinder', glyph: '▤', props: { 'd.store': 'yes' } },
    { id: 'queue', group: 'Data', label: 'Queue or topic', kind: 'container', tags: ['Queue'], shape: 'queue', glyph: '≡' },
    { id: 'search', group: 'Data', label: 'Search index', kind: 'container', tags: ['Search'], shape: 'cylinder', glyph: '⌕', props: { 'd.store': 'yes' } },
    { id: 'gateway', group: 'Edge', label: 'API gateway', kind: 'container', tags: ['Gateway'], shape: 'gateway', glyph: '⇆' },
    { id: 'idp', group: 'Edge', label: 'Identity provider', kind: 'softwareSystem', tags: ['Identity Provider', 'External'], shape: 'box', glyph: '⚿' },
    { id: 'scheduler', group: 'Edge', label: 'Scheduler', kind: 'container', tags: ['Scheduler'], shape: 'box', glyph: '◷' },
    { id: 'agent', group: 'Agentic', label: 'Agent', kind: 'container', tags: ['Agent'], shape: 'hexagon', glyph: '✦' },
    { id: 'orchestrator', group: 'Agentic', label: 'Orchestrator agent', kind: 'container', tags: ['Agent', 'Orchestrator'], shape: 'hexagon', glyph: '✱' },
    { id: 'llm', group: 'Agentic', label: 'LLM', kind: 'softwareSystem', tags: ['LLM', 'External'], shape: 'llm', glyph: '◈' },
    { id: 'aigateway', group: 'Agentic', label: 'AI gateway', kind: 'container', tags: ['Gateway', 'AI Gateway'], shape: 'gateway', glyph: '⇆' },
    { id: 'tool', group: 'Agentic', label: 'Tool', kind: 'container', tags: ['Tool'], shape: 'tool', glyph: '⚒' },
    { id: 'mcp', group: 'Agentic', label: 'MCP server', kind: 'container', tags: ['Tool', 'MCP Server'], shape: 'tool', glyph: '⚒' },
    { id: 'memory', group: 'Agentic', label: 'Vector store / memory', kind: 'container', tags: ['Vector Store', 'Memory'], shape: 'cylinder', glyph: '⋮', props: { 'd.store': 'yes' } },
    { id: 'policy', group: 'Agentic', label: 'Policy engine', kind: 'container', tags: ['Policy Engine'], shape: 'shield', glyph: '⛨' },
    { id: 'approval', group: 'Agentic', label: 'Human approval', kind: 'person', tags: ['Human Approval'], shape: 'diamond', glyph: '✓' },
    { id: 'evaluator', group: 'Agentic', label: 'Evaluator', kind: 'container', tags: ['Evaluator'], shape: 'box', glyph: '◎' },
    { id: 'traces', group: 'Agentic', label: 'Trace store', kind: 'container', tags: ['Trace Store'], shape: 'cylinder', glyph: '⌇', props: { 'd.store': 'yes' } },
  ];
  // Tag → shape, so elements written by hand in the DSL get the right shape too.
  const TAG_SHAPES = [['Human Approval', 'diamond'], ['Agent', 'hexagon'], ['LLM', 'llm'], ['Gateway', 'gateway'], ['MCP Server', 'tool'], ['Tool', 'tool'],
    ['Policy Engine', 'shield'], ['Queue', 'queue'], ['Cache', 'cylinder-dashed'], ['Vector Store', 'cylinder'], ['Database', 'cylinder'], ['Blob Store', 'cylinder'],
    ['Search', 'cylinder'], ['Trace Store', 'cylinder'], ['Web App', 'browser']];
  function shapeFor(el) {
    if (el.kind === 'person' && !el.tags.has('Human Approval')) return 'person';
    for (const [tag, shape] of TAG_SHAPES) if (el.tags.has(tag)) return shape;
    return 'box';
  }
  const isAgent = el => el.tags.has('Agent');

  // ---------------------------------------------------------------- properties
  // [key, target, kind, values, group, doc, source]
  const PROPERTIES = [
    // quality attributes
    ['d.owner', 'element', 'str', null, 'Quality', 'Owning team. Every element needs one before handover.', 'Design review practice'],
    ['d.latency.p99', 'element', 'str', null, 'Quality', 'Latency target at the 99th percentile, e.g. 250ms.', 'NFR capture'],
    ['d.throughput', 'element', 'str', null, 'Quality', 'Expected peak throughput, e.g. 200 rps.', 'NFR capture'],
    ['d.rto', 'element', 'str', null, 'Quality', 'Recovery time objective, e.g. 1h.', 'NFR capture (disaster recovery)'],
    ['d.rpo', 'element', 'str', null, 'Quality', 'Recovery point objective, e.g. 15m.', 'NFR capture (disaster recovery)'],
    ['d.data.classification', 'element', 'enum', ['public', 'internal', 'confidential', 'restricted'], 'Quality', 'Most sensitive data held or processed.', 'Security NFRs'],
    ['d.pii', 'element', 'enum', YN, 'Quality', 'Holds or processes personal data.', 'Security and compliance NFRs'],
    ['d.state', 'element', 'enum', ['stateless', 'stateful'], 'Quality', 'Whether instances hold state; affects scaling and recovery.', 'Scalability NFRs'],
    ['d.scaling', 'element', 'enum', ['none', 'vertical', 'horizontal', 'auto'], 'Quality', 'How it scales under load.', 'Scalability NFRs'],
    ['d.backup', 'element', 'enum', YN, 'Quality', 'Backed up, with restore tested.', 'NFR capture (disaster recovery)'],
    // agentic design
    ['d.agent.autonomy', 'element', 'enum', ['suggest', 'approve-writes', 'autonomous'], 'Agentic', 'How far the agent acts without a human: suggest only, act after approval for writes, or act alone.', 'OWASP LLM06 Excessive Agency; ASI02'],
    ['d.agent.model', 'element', 'str', null, 'Agentic', 'Model or model tier the agent uses.', 'Agent design'],
    ['d.agent.fallback', 'element', 'str', null, 'Agentic', 'Fallback model or provider when the primary is unavailable.', 'Availability; ASI08 Cascading Failures'],
    ['d.agent.maxSteps', 'element', 'int', null, 'Agentic', 'Hard cap on loop iterations per run.', 'Stopping conditions; ASI08'],
    ['d.agent.budget', 'element', 'str', null, 'Agentic', 'Token or cost budget per run, e.g. 200k tokens or $2.', 'Stopping conditions; resource saturation'],
    ['d.agent.memory', 'element', 'enum', ['none', 'session', 'persistent'], 'Agentic', 'What the agent remembers between turns or runs.', 'ASI06 Memory and Context Poisoning'],
    ['d.agent.untrustedInput', 'element', 'enum', YN, 'Agentic', 'Reads content an attacker could influence: web pages, email, uploaded documents, tickets, tool output.', 'Lethal trifecta (Willison); ASI01 Goal Hijack'],
    ['d.agent.privateData', 'element', 'enum', YN, 'Agentic', 'Can read private or confidential data.', 'Lethal trifecta (Willison)'],
    ['d.agent.externalComms', 'element', 'enum', YN, 'Agentic', 'Can send data outside: email, HTTP calls, posting, writing to shared places.', 'Lethal trifecta (Willison)'],
    ['d.agent.codeExec', 'element', 'enum', YN, 'Agentic', 'Generates and runs code or shell commands.', 'ASI05 Unexpected Code Execution'],
    ['d.agent.sandbox', 'element', 'enum', YN, 'Agentic', 'Runs generated code in an isolated sandbox.', 'ASI05 Unexpected Code Execution'],
    ['d.agent.identity', 'element', 'enum', ['delegated', 'service', 'shared'], 'Agentic', 'Whose identity the agent acts under: the user\'s (delegated), its own service identity, or a shared account.', 'ASI03 Identity and Privilege Abuse'],
    ['d.agent.tracing', 'element', 'enum', YN, 'Agentic', 'Every run is traced (e.g. to Langfuse) with element, task and decision.', 'Observability; ASI10 Rogue Agents'],
    ['d.agent.eval', 'element', 'str', null, 'Agentic', 'Eval suite that gates changes to this agent\'s prompt, tools or model.', 'Agent quality practice'],
    ['d.agent.pattern', 'element', 'enum', ['single-call', 'prompt-chain', 'routing', 'parallel', 'orchestrator-workers', 'evaluator-optimizer', 'autonomous-loop'], 'Agentic', 'The agent pattern used: one call, a fixed chain, routing, parallel calls, or the more complex orchestrator-workers, evaluator-optimizer and autonomous loop.', 'Anthropic, Building effective agents (use the simplest pattern that works)'],
    ['d.agent.patternWhy', 'element', 'str', null, 'Agentic', 'Why a simpler pattern is not enough. Required (AG011) for orchestrator-workers, evaluator-optimizer and autonomous-loop.', 'Anthropic, Building effective agents'],
    ['d.tenant.isolation', 'element', 'enum', ['none', 'logical', 'physical'], 'Agentic', 'Isolation between tenants or users in shared memory and vector stores.', 'ASI06 Memory and Context Poisoning'],
    // relationships
    ['d.tool.effect', 'relationship', 'enum', ['read', 'write', 'irreversible'], 'Agentic', 'Side effect of this call: read-only, a reversible write, or irreversible (payments, deletes, sends).', 'ASI02 Tool Misuse; LLM06 Excessive Agency'],
    ['d.approval', 'relationship', 'enum', ['none', 'policy', 'human'], 'Agentic', 'What must approve this call before it runs.', 'Human-in-the-loop; ASI02, ASI09'],
    ['d.protocol', 'relationship', 'enum', ['http', 'grpc', 'mcp', 'a2a', 'acp', 'agui', 'function', 'queue'], 'Agentic', 'Protocol of the interaction.', 'Agent design'],
  ];
  const PROP = new Map(PROPERTIES.map(([key, target, kind, values, group, doc, source]) => [key, { key, target, kind, values, group, doc, source }]));

  // Specs in designc core.js's SPECS shape, for Core.registerProperties().
  function coreSpecs() {
    const out = { element: {}, relationship: {} };
    for (const p of PROP.values()) out[p.target][p.key] = p.kind === 'enum' ? { k: 'enum', v: p.values } : { k: p.kind };
    return out;
  }
  // Rows in designc app.js's PROPS shape, for completions and hovers.
  const propsList = () => [...PROP.values()].map(p => [p.key, p.target, p.values, `${p.doc} (${p.source})`]);

  // Built-in designc properties, so the inspector can edit them too.
  const CORE_PROPS = [
    ['d.interaction', 'relationship', 'enum', ['sync', 'async'], 'Design', 'Call style.'],
    ['d.delivery', 'relationship', 'enum', ['at-most-once', 'at-least-once', 'exactly-once'], 'Design', 'Delivery guarantee (async).'],
    ['d.idempotent', 'relationship', 'enum', YN, 'Design', 'Receiver handles this idempotently.'],
    ['d.retry', 'relationship', 'enum', ['none', 'fixed', 'backoff'], 'Design', 'Caller retry policy.'],
    ['d.retry.max', 'relationship', 'int', null, 'Design', 'Max retry attempts.'],
    ['d.encrypted', 'relationship', 'enum', YN, 'Design', 'Encrypted in transit.'],
    ['d.authenticated', 'relationship', 'enum', YN, 'Design', 'Caller is authenticated.'],
    ['d.writes', 'relationship', 'list', null, 'Design', 'Entities written to the destination store.'],
    ['d.concurrency', 'relationship', 'enum', ['none', 'optimistic', 'pessimistic'], 'Design', 'Concurrency control on writes.'],
    ['d.instances', 'element', 'int', null, 'Design', 'Running instances.'],
    ['d.critical', 'element', 'enum', YN, 'Design', 'On a critical path.'],
    ['d.zone', 'element', 'str', null, 'Design', 'Trust zone; children inherit it.'],
    ['d.availability', 'element', 'float', null, 'Design', 'Availability as a fraction, e.g. 0.999.'],
    ['d.owns', 'element', 'list', null, 'Design', 'Entities this element owns writes to.'],
    ['d.store', 'element', 'enum', YN, 'Design', 'Is a data store.'],
    ['d.aka', 'element', 'list', null, 'Design', 'Other names, for matching code.'],
  ].map(([key, target, kind, values, group, doc]) => ({ key, target, kind, values, group, doc, source: 'designc' }));
  function inspectorProps(target, el) {
    const all = [...CORE_PROPS, ...PROP.values()].filter(p => p.target === target);
    return all.filter(p => {
      if (p.group !== 'Agentic') return true;
      if (target === 'element') return el && (isAgent(el) || (p.key === 'd.tenant.isolation' && (el.tags.has('Vector Store') || el.tags.has('Memory'))));
      return true;
    });
  }

  // ---------------------------------------------------------------- review banks
  // Quality-attribute questions by element role (NFR capture practice, ISO 25010 families).
  const NFR_QUESTIONS = {
    any: [
      ['Ownership', 'Who owns it, and who is on call for it?', 'd.owner'],
      ['Observability', 'What does it log, measure and trace, and which alert tells you it is unhealthy?'],
      ['Security', 'How are callers authenticated and authorised, and what is the most sensitive data it touches?', 'd.data.classification'],
    ],
    service: [
      ['Performance', 'What latency target does it have at p99, and under what load?', 'd.latency.p99'],
      ['Scalability', 'How does it scale, and is it stateless?', 'd.scaling'],
      ['Availability', 'What availability does it need, and what happens to callers when it is down?', 'd.availability'],
      ['Resilience', 'What are its timeouts, retries and circuit breakers on each dependency?'],
    ],
    store: [
      ['Recovery', 'What are its RTO and RPO, and when was a restore last tested?', 'd.rto'],
      ['Data', 'Who owns each entity written here, and how are concurrent writes handled?', 'd.owns'],
      ['Compliance', 'Does it hold personal data, and what is the retention and deletion policy?', 'd.pii'],
      ['Capacity', 'How much does it grow per day, and when does it need re-sharding or archiving?'],
    ],
    queue: [
      ['Delivery', 'What delivery guarantee does it give, and are consumers idempotent?'],
      ['Backpressure', 'What happens when consumers fall behind: max depth, dead-lettering, alerting?'],
      ['Ordering', 'Does any consumer rely on ordering, and is it guaranteed per key?'],
    ],
    external: [
      ['Dependency', 'What is its SLA, rate limit and cost model, and what is the fallback when it fails?'],
      ['Contract', 'How are breaking changes to its API detected before production?'],
    ],
    person: [['Access', 'How do these users sign in, and what can the least-privileged of them do?']],
  };
  // STRIDE per data flow crossing a trust boundary (Microsoft threat modelling).
  const STRIDE = [
    ['Spoofing', 'Can the caller be impersonated across this boundary?', r => r.authenticated !== 'yes'],
    ['Tampering', 'Can the data be modified in transit or replayed?', r => r.encrypted !== 'yes'],
    ['Repudiation', 'Is the call logged with who made it, in a way the caller cannot deny?', () => true],
    ['Information disclosure', 'Could more data cross than the receiver needs?', () => true],
    ['Denial of service', 'Is the receiver protected by rate limits and quotas?', () => true],
    ['Elevation of privilege', 'Does the receiver act with more privilege than the caller has?', () => true],
  ];
  // OWASP Top 10 for Agentic Applications 2026 (OWASP GenAI Security Project).
  const OWASP_ASI = [
    ['ASI01', 'Agent Goal Hijack', 'Treat retrieved and tool content as untrusted; constrain objectives; watch for goal drift.'],
    ['ASI02', 'Tool Misuse and Exploitation', 'Scope tools to the least agency; validate parameters; gate writes.'],
    ['ASI03', 'Identity and Privilege Abuse', 'Give each agent its own identity and least privilege; never share credentials.'],
    ['ASI04', 'Agentic Supply Chain Vulnerabilities', 'Pin and review tools, MCP servers, prompts and models; treat tool descriptions as untrusted.'],
    ['ASI05', 'Unexpected Code Execution', 'Sandbox generated code; never execute model output on the host.'],
    ['ASI06', 'Memory and Context Poisoning', 'Validate what enters memory; isolate memory per tenant; expire it.'],
    ['ASI07', 'Insecure Inter-Agent Communication', 'Authenticate and authorise agent-to-agent calls; sign messages.'],
    ['ASI08', 'Cascading Failures', 'Cap steps, tokens and time; add fallbacks; stop runaway loops.'],
    ['ASI09', 'Human-Agent Trust Exploitation', 'Show evidence with every recommendation; make approvals meaningful, not rubber stamps.'],
    ['ASI10', 'Rogue Agents', 'Trace every run; detect behaviour outside the agent\'s intended scope; be able to stop it.'],
  ];
  // Anthropic, "Building effective agents": the five workflow patterns and when to use them.
  const PATTERNS = [
    ['Prompt chaining', 'The task splits into fixed, predictable steps; add checks (gates) between steps.'],
    ['Routing', 'Inputs differ in type or difficulty and need different handling or models.'],
    ['Parallelization', 'Independent subtasks can run at once, or several attempts can vote.'],
    ['Orchestrator-workers', 'Subtasks cannot be predicted up front; a central agent plans and delegates.'],
    ['Evaluator-optimizer', 'Output quality needs iteration against clear criteria.'],
  ];

  const SOURCES = [
    ['OWASP Top 10 for Agentic Applications 2026', 'https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/'],
    ['Simon Willison, The lethal trifecta for AI agents (2025)', 'https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/'],
    ['Anthropic, Building effective agents (2024)', 'https://www.anthropic.com/engineering/building-effective-agents'],
    ['Microsoft Engineering Playbook, Non-functional requirements capture', 'https://microsoft.github.io/code-with-engineering-playbook/design/design-patterns/non-functional-requirements-capture-guide/'],
    ['Microsoft, STRIDE threat model', 'https://learn.microsoft.com/azure/security/develop/threat-modeling-tool-threats'],
  ];

  return { STENCILS, shapeFor, isAgent, PROPERTIES: [...PROP.values()], PROP, CORE_PROPS, coreSpecs, propsList, inspectorProps, NFR_QUESTIONS, STRIDE, OWASP_ASI, PATTERNS, SOURCES };
});
