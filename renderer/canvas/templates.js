/* designc-canvas: reference architectures.
   DSL statements for the model body; {p} becomes a unique identifier prefix on insert.
   Each template declares the practices it stands for, so it starts clean under the lint rules and
   shows what "good" looks like: gated writes, capped loops, tracing, the gateway in every model path. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else (root.DesigncCanvas = root.DesigncCanvas || {}).templates = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const props = o => `properties {\n${Object.entries(o).map(([k, v]) => `    "${k}" "${v}"`).join('\n')}\n  }`;
  const block = o => ` {\n  ${props(o)}\n}`;
  // Containers are written flat inside their system block; helper keeps the snippets readable.
  const TEMPLATES = [
    {
      id: 'governed-agent', title: 'Governed agent with tools', pattern: 'Single agent',
      about: 'One agent behind an AI gateway, with a policy engine on every tool call, human approval for irreversible actions, and traces to a trace store.',
      elements: `{p}_user = person "Operator {p}"
{p}_llm = softwareSystem "Model provider {p}" "" "LLM,External"
{p}_sys = softwareSystem "Agent platform {p}" {
  {p}_app = container "Operator app" "" "Web" "Web App"
  {p}_agent = container "Task agent" "" "MAF" "Agent"${block({ 'd.agent.autonomy': 'approve-writes', 'd.agent.pattern': 'autonomous-loop', 'd.agent.patternWhy': 'Each tool call depends on the result of the last, so the steps cannot be fixed in advance.', 'd.agent.maxSteps': '20', 'd.agent.budget': '200k tokens', 'd.agent.tracing': 'yes', 'd.agent.identity': 'service', 'd.agent.untrustedInput': 'no', 'd.agent.privateData': 'yes', 'd.agent.externalComms': 'no', 'd.agent.eval': 'task-agent-evals' })}
  {p}_gw = container "AI gateway" "" "LiteLLM" "Gateway,AI Gateway"
  {p}_policy = container "Policy engine" "" "ACS" "Policy Engine"
  {p}_tools = container "Tool server" "" "MCP" "Tool,MCP Server"
  {p}_traces = container "Trace store" "" "Langfuse" "Trace Store"${block({ 'd.store': 'yes' })}
}
{p}_approver = person "Approver {p}" "" "Human Approval"`,
      relationships: `{p}_user -> {p}_app "Asks for work"
{p}_app -> {p}_agent "Starts a run"${block({ 'd.interaction': 'async', 'd.delivery': 'at-least-once', 'd.idempotent': 'yes' })}
{p}_agent -> {p}_gw "Model calls"${block({ 'd.tool.effect': 'read' })}
{p}_gw -> {p}_llm "Routes to"
{p}_agent -> {p}_policy "Checks each tool call"${block({ 'd.tool.effect': 'read' })}
{p}_agent -> {p}_tools "Calls tools"${block({ 'd.tool.effect': 'write', 'd.approval': 'policy', 'd.protocol': 'mcp' })}
{p}_agent -> {p}_approver "Asks before irreversible actions"
{p}_agent -> {p}_traces "Traces every run"${block({ 'd.tool.effect': 'write', 'd.interaction': 'async', 'd.delivery': 'at-most-once' })}`,
    },
    {
      id: 'agentic-rag', title: 'Agentic RAG over private documents', pattern: 'Routing + retrieval',
      about: 'Answers questions from private documents. It reads untrusted content and private data, so it deliberately has no way to send data out: two trifecta legs, never three.',
      elements: `{p}_user = person "Analyst {p}"
{p}_llm = softwareSystem "Model provider {p}" "" "LLM,External"
{p}_sys = softwareSystem "Knowledge assistant {p}" {
  {p}_ui = container "Chat UI" "" "Web" "Web App"
  {p}_agent = container "Answer agent" "" "MAF" "Agent"${block({ 'd.agent.autonomy': 'suggest', 'd.agent.pattern': 'single-call', 'd.agent.maxSteps': '8', 'd.agent.tracing': 'yes', 'd.agent.identity': 'delegated', 'd.agent.memory': 'session', 'd.agent.untrustedInput': 'yes', 'd.agent.privateData': 'yes', 'd.agent.externalComms': 'no', 'd.agent.eval': 'rag-answer-evals' })}
  {p}_gw = container "AI gateway" "" "LiteLLM" "Gateway,AI Gateway"
  {p}_index = container "Vector index" "" "Azure AI Search" "Vector Store"${block({ 'd.store': 'yes', 'd.tenant.isolation': 'logical', 'd.data.classification': 'confidential' })}
  {p}_ingest = container "Ingestion worker" "" ".NET" "Worker"
  {p}_docs = container "Document store" "" "Blob Storage" "Blob Store"${block({ 'd.store': 'yes', 'd.data.classification': 'confidential' })}
}`,
      relationships: `{p}_user -> {p}_ui "Asks"
{p}_ui -> {p}_agent "Question"
{p}_agent -> {p}_index "Retrieves passages"${block({ 'd.tool.effect': 'read' })}
{p}_agent -> {p}_gw "Model calls"${block({ 'd.tool.effect': 'read' })}
{p}_gw -> {p}_llm "Routes to"
{p}_ingest -> {p}_docs "Reads new documents"
{p}_ingest -> {p}_index "Embeds and writes"${block({ 'd.writes': 'Passage' })}`,
    },
    {
      id: 'orchestrator-workers', title: 'Orchestrator and workers', pattern: 'Orchestrator-workers',
      about: 'A planner delegates to specialist workers and an evaluator checks the result. Every agent is capped, and agent-to-agent calls are authenticated.',
      elements: `{p}_sys = softwareSystem "Multi-agent service {p}" {
  {p}_orch = container "Orchestrator" "" "MAF" "Agent,Orchestrator"${block({ 'd.agent.autonomy': 'approve-writes', 'd.agent.pattern': 'orchestrator-workers', 'd.agent.patternWhy': 'The subtasks depend on the request and cannot be listed up front.', 'd.agent.maxSteps': '15', 'd.agent.budget': '$3', 'd.agent.tracing': 'yes', 'd.agent.identity': 'service', 'd.agent.untrustedInput': 'no', 'd.agent.privateData': 'yes', 'd.agent.externalComms': 'no', 'd.agent.eval': 'orchestration-evals' })}
  {p}_w1 = container "Research worker" "" "MAF" "Agent"${block({ 'd.agent.autonomy': 'suggest', 'd.agent.pattern': 'single-call', 'd.agent.maxSteps': '10', 'd.agent.tracing': 'yes', 'd.agent.identity': 'service', 'd.agent.untrustedInput': 'yes', 'd.agent.privateData': 'no', 'd.agent.externalComms': 'no', 'd.agent.eval': 'research-evals' })}
  {p}_w2 = container "Drafting worker" "" "MAF" "Agent"${block({ 'd.agent.autonomy': 'suggest', 'd.agent.pattern': 'single-call', 'd.agent.maxSteps': '10', 'd.agent.tracing': 'yes', 'd.agent.identity': 'service', 'd.agent.untrustedInput': 'no', 'd.agent.privateData': 'yes', 'd.agent.externalComms': 'no', 'd.agent.eval': 'drafting-evals' })}
  {p}_eval = container "Evaluator" "" "MAF" "Evaluator"
  {p}_gw = container "AI gateway" "" "LiteLLM" "Gateway,AI Gateway"
}`,
      relationships: `{p}_orch -> {p}_w1 "Delegates research"${block({ 'd.authenticated': 'yes', 'd.protocol': 'a2a' })}
{p}_orch -> {p}_w2 "Delegates drafting"${block({ 'd.authenticated': 'yes', 'd.protocol': 'a2a' })}
{p}_orch -> {p}_eval "Checks the result"
{p}_orch -> {p}_gw "Model calls"${block({ 'd.tool.effect': 'read' })}
{p}_w1 -> {p}_gw "Model calls"${block({ 'd.tool.effect': 'read' })}
{p}_w2 -> {p}_gw "Model calls"${block({ 'd.tool.effect': 'read' })}`,
    },
    {
      id: 'evaluator-optimizer', title: 'Evaluator-optimizer loop', pattern: 'Evaluator-optimizer',
      about: 'A generator and an evaluator iterate against clear criteria until the bar is met or the cap is hit.',
      elements: `{p}_sys = softwareSystem "Refinement loop {p}" {
  {p}_gen = container "Generator" "" "MAF" "Agent"${block({ 'd.agent.autonomy': 'suggest', 'd.agent.pattern': 'evaluator-optimizer', 'd.agent.patternWhy': 'Output quality improves with a critic checking it against written criteria.', 'd.agent.maxSteps': '6', 'd.agent.tracing': 'yes', 'd.agent.untrustedInput': 'no', 'd.agent.privateData': 'no', 'd.agent.externalComms': 'no', 'd.agent.eval': 'generator-evals' })}
  {p}_crit = container "Critic" "" "MAF" "Agent"${block({ 'd.agent.autonomy': 'suggest', 'd.agent.pattern': 'single-call', 'd.agent.maxSteps': '6', 'd.agent.tracing': 'yes', 'd.agent.untrustedInput': 'no', 'd.agent.privateData': 'no', 'd.agent.externalComms': 'no', 'd.agent.eval': 'critic-evals' })}
  {p}_gw = container "AI gateway" "" "LiteLLM" "Gateway,AI Gateway"
}`,
      relationships: `{p}_gen -> {p}_crit "Submits a draft"${block({ 'd.authenticated': 'yes' })}
{p}_crit -> {p}_gen "Returns critique"${block({ 'd.authenticated': 'yes' })}
{p}_gen -> {p}_gw "Model calls"${block({ 'd.tool.effect': 'read' })}
{p}_crit -> {p}_gw "Model calls"${block({ 'd.tool.effect': 'read' })}`,
    },
    {
      id: 'outbox', title: 'Event-driven service with outbox', pattern: 'Transactional outbox',
      about: 'Writes state and the outgoing event in one transaction; a relay publishes the outbox; consumers are idempotent.',
      elements: `{p}_sys = softwareSystem "Order service {p}" {
  {p}_api = container "Order API" "" ".NET" ${block({ 'd.instances': '3', 'd.state': 'stateless', 'd.scaling': 'horizontal' }).trim()}
  {p}_db = container "Orders DB" "" "Azure SQL" "Database"${block({ 'd.owner': 'Orders team', 'd.backup': 'yes', 'd.rpo': '5m', 'd.rto': '1h' })}
  {p}_relay = container "Outbox relay" "" ".NET" "Worker"
  {p}_bus = container "Order events" "" "Service Bus" "Queue"
  {p}_consumer = container "Fulfilment consumer" "" ".NET" "Worker"
}`,
      relationships: `{p}_api -> {p}_db "Writes order and outbox row"${block({ 'd.writes': 'Order,Outbox', 'd.concurrency': 'optimistic' })}
{p}_relay -> {p}_db "Reads outbox"
{p}_relay -> {p}_bus "Publishes"${block({ 'd.interaction': 'async', 'd.delivery': 'at-least-once', 'd.idempotent': 'yes' })}
{p}_bus -> {p}_consumer "Delivers"${block({ 'd.interaction': 'async', 'd.delivery': 'at-least-once', 'd.idempotent': 'yes' })}`,
    },
    {
      id: 'design-to-code', title: 'Design-to-code factory', pattern: 'designc itself',
      about: 'System 1 designs, System 2 builds, System 4 improves: the architecture this IDE belongs to.',
      elements: `{p}_eng = person "Engineer {p}"
{p}_llm = softwareSystem "Model provider {p}" "" "LLM,External"
{p}_sys = softwareSystem "Design-to-code factory {p}" {
  {p}_ide = container "designc" "" "Electron" "Web App"
  {p}_registry = container "Registry" "" "git" "Database"${block({ 'd.owner': 'Platform', 'd.store': 'yes' })}
  {p}_harness = container "MAF harness" "" ".NET" "Agent,Orchestrator"${block({ 'd.agent.autonomy': 'approve-writes', 'd.agent.pattern': 'orchestrator-workers', 'd.agent.patternWhy': 'Which tasks to run and in what order depends on the handover and cannot be fixed in advance.', 'd.agent.maxSteps': '40', 'd.agent.budget': '$5', 'd.agent.tracing': 'yes', 'd.agent.identity': 'service', 'd.agent.codeExec': 'yes', 'd.agent.sandbox': 'yes', 'd.agent.untrustedInput': 'no', 'd.agent.privateData': 'yes', 'd.agent.externalComms': 'no', 'd.agent.eval': 'k-rerun-suite' })}
  {p}_policy = container "ACS" "" "AGT" "Policy Engine"
  {p}_gw = container "AI gateway" "" "LiteLLM" "Gateway,AI Gateway"
  {p}_langfuse = container "Langfuse" "" "Langfuse" "Trace Store"${block({ 'd.store': 'yes' })}
}`,
      relationships: `{p}_eng -> {p}_ide "Designs and approves"
{p}_ide -> {p}_registry "Writes design and decisions"
{p}_harness -> {p}_registry "Reads handovers"${block({ 'd.tool.effect': 'read' })}
{p}_harness -> {p}_policy "Checks each tool call"${block({ 'd.tool.effect': 'read' })}
{p}_harness -> {p}_gw "Model calls"${block({ 'd.tool.effect': 'read' })}
{p}_gw -> {p}_llm "Routes to"
{p}_harness -> {p}_langfuse "Traces runs"${block({ 'd.tool.effect': 'write', 'd.interaction': 'async', 'd.delivery': 'at-most-once' })}
{p}_ide -> {p}_langfuse "Reads runs"`,
    },
  ];
  return { TEMPLATES };
});
