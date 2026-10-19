/* designc desktop: ledger envelope v1. Pure, no I/O, Node built-ins only.
   Dual-load like renderer/core.js: <script src="ledger.js"> in the renderer, require('./renderer/ledger.js')
   from ledger-store.js and tests. See plan/ledger-schema-s1-manifest.json for the full contract.
   LS-01 slice: only `check` carries its final v1 spec; the other 14 designc kinds accept today's
   field names as-is (upcast adds only the envelope, no renames — later slices tighten each). */
const Ledger = (() => {
  const SCHEMA_VERSION = 1;

  // Harness envelope v1 (grill-me D16): charter kinds, as-is from event.py, routed to sessions.jsonl.
  // Disjoint from KINDS (R-3): designc kinds are snake_case, harness kinds are PascalCase.
  const HARNESS_ENVELOPE_VERSION = 1;
  const HARNESS_KINDS = [
    'SessionStarted', 'SessionEnded', 'ContextCompiled', 'ProposalMade', 'GatePassed',
    'GateFailed', 'NeedsDecision', 'ActionExecuted', 'ActionErrored', 'VerifyResult',
    'BudgetExceeded', 'HumanDecision', 'Done', 'NoteRecorded', 'WorkRecorded',
  ];
  const HARNESS_STREAM = 'sessions.jsonl';
  const HARNESS_FIELDS = [
    'envelope_version', 'kind', 'project', 'session_id', 'event_id', 'ts',
    'parent_session_id', 'agent_id', 'acting_as', 'pack_id', 'pack_version',
    'harness_version', 'image_digest', 'snapshot_hash', 'payload',
  ];
  const HARNESS_NULLABLE = [
    'parent_session_id', 'agent_id', 'acting_as', 'pack_id', 'pack_version',
    'harness_version', 'image_digest', 'snapshot_hash',
  ];

  // STAGES keys in renderer/app.js must equal this list (R-lint: see test/ledger.schema.test.js).
  const CAUGHT_BY = ['S1-lint', 'S1-p', 'S1-grill', 'pipeline'];
  // Where an escape came from, beside the stage that should have caught it (slice 33).
  const ORIGINS = ['spec_gap', 'design_error', 'translation_error', 'gate_gap'];

  const STREAM = {
    check: 'checks.jsonl',
    fitness: 'checks.jsonl',
    eval: 'checks.jsonl',
    gate: 'checks.jsonl',
    task: 'pipeline.jsonl',
    needs_decision: 'pipeline.jsonl',
    needs_decision_resolved: 'designc.jsonl',
    asbuilt_edge: 'pipeline.jsonl',
    escape: 'designc.jsonl',
    escape_classified: 'designc.jsonl',
    false_positive: 'pipeline.jsonl',
    handover: 'designc.jsonl',
    handover_closed: 'designc.jsonl',
    item_pulled: 'designc.jsonl',
    item_gate: 'checks.jsonl',
    item_done: 'designc.jsonl',
    item_recheck: 'designc.jsonl',
    item_awaiting_human: 'pipeline.jsonl',
    ui_acceptance_failed: 'pipeline.jsonl',
    item_conflict_deferred: 'pipeline.jsonl',
    wip_limit_changed: 'pipeline.jsonl',
    item_budget: 'pipeline.jsonl',
    item_judge: 'pipeline.jsonl',
    run_started: 'pipeline.jsonl',
    run_ended: 'pipeline.jsonl',
    decision_promoted: 'designc.jsonl',
    extraction: 'designc.jsonl',
    agent_turn: 'agents.jsonl',
    agent_tool: 'agents.jsonl',
    agent_permission: 'agents.jsonl',
    agent_approval: 'agents.jsonl',
    unapproved_change: 'agents.jsonl',
    suite_run: 'factory.jsonl',
    grader: 'factory.jsonl',
    suite_run_finished: 'factory.jsonl',
    failure_mode_classified: 'factory.jsonl',
    factory_task_bound: 'factory.jsonl',
    domain_pinned: 'designc.jsonl',
    trace_review: 'designc.jsonl',
  };
  // What a pipeline may append (docs/pipeline-contract.md). verify rule V9 holds pipeline.jsonl to this list; a kind
  // outside it (needs_decision_resolved, escape_classified, decision_promoted...) is a person's judgement.
  const PIPELINE_KINDS = ['task', 'check', 'needs_decision', 'asbuilt_edge', 'escape', 'false_positive', 'handover_closed', 'item_gate', 'item_awaiting_human', 'ui_acceptance_failed', 'item_conflict_deferred', 'wip_limit_changed', 'item_budget', 'item_judge', 'run_started', 'run_ended'];
  const PIPELINE_STREAM = 'pipeline.jsonl';

  const KINDS = Object.keys(STREAM).reduce((m, k) => { m[k] = { stream: STREAM[k] }; return m; }, {});

  // Envelope-level optional fields, allowed on every designc kind (contract.envelope).
  const ENVELOPE_OPTIONAL = [
    'system', 'run_id', 'trace_id', 'session', 'requirement', 'element',
    'decision', 'task', 'model', 'tokens_in', 'tokens_out', 'cost', 'sample', 'payload',
  ];

  // Kinds with a locked-down field set + rules. Grows slice by slice.
  const FINAL_KIND_FIELDS = {
    check: {
      required: ['decision', 'check', 'outcome', 'source'],
      optional: ['ms', 'exit_code', 'reason'],
      enums: { outcome: ['pass', 'fail'], source: ['local', 'pipeline'] },

      rules: ['fail_needs_evidence'],
    },
    fitness: {
      required: ['scenario', 'check', 'outcome', 'source'],
      optional: ['ms', 'exit_code', 'reason'],
      enums: { outcome: ['pass', 'fail'], source: ['local', 'pipeline'] },

      rules: ['fail_needs_evidence'],
    },
    eval: {
      required: ['eval', 'agent', 'outcome', 'metrics', 'cases', 'source', 'fingerprint', 'eval_hash'],
      optional: ['ms', 'exit_code', 'reason'],
      enums: { outcome: ['pass', 'fail'], source: ['local', 'pipeline'] },
      types: { eval: 'string', agent: 'string', metrics: 'object', cases: 'number', fingerprint: 'string', eval_hash: 'string' },
      rules: ['fail_needs_evidence'],
    },
    escape: {
      required: ['id', 'description'],
      optional: ['code', 'caught_by', 'source', 'traces', 'origin'],
      enums: {},
      rules: ['caught_by_member', 'origin_member'],
    },
    escape_classified: {
      required: ['escape', 'caught_by'],
      optional: ['origin'],
      enums: {},
      rules: ['caught_by_member', 'origin_member'],
    },
    false_positive: {
      required: ['code'],
      optional: ['note'],
      enums: {},
    },
    task: {
      required: ['task', 'status'],
      optional: ['title', 'element', 'reruns', 'turns', 'tokens', 'tokens_in', 'tokens_out', 'cost', 'model', 'tier', 'handover', 'run', 'usage', 'by_role'],
      enums: { status: ['passed', 'failed', 'blocked', 'running'] },
      rules: ['usage_shape', 'by_role_shape'],
    },
    needs_decision: {
      required: ['id', 'question', 'status'],
      optional: ['task', 'element'],
      enums: { status: ['open', 'resolved'] },
    },
    needs_decision_resolved: {
      required: ['id'],
      optional: [],
      enums: {},
    },
    asbuilt_edge: {
      required: ['from', 'to'],
      optional: [],
      enums: {},
    },
    decision_promoted: {
      required: ['decision'],
      optional: ['fingerprints'],
      enums: {},
    },
    handover: {
      required: ['handover', 'revision'],
      optional: ['commit', 'dirty', 'item'],
      enums: {},
      types: { commit: 'string|null', dirty: 'boolean', item: 'string' },
    },
    handover_closed: {
      required: ['handover', 'outcome'],
      optional: [],
      enums: { outcome: ['delivered', 'abandoned'] },
    },
    item_pulled: {
      required: ['item'],
      optional: [],
      enums: {},
      types: { item: 'string' },
    },
    item_gate: {
      required: ['item', 'gate', 'outcome', 'source', 'commit', 'dirty'],
      optional: ['ms', 'exit_code', 'reason'],
      enums: { outcome: ['pass', 'fail'], source: ['local', 'pipeline'] },
      types: { item: 'string', gate: 'string', commit: 'string|null', dirty: 'boolean' },
      rules: ['fail_needs_evidence'],
    },
    item_done: {
      required: ['item', 'commit', 'evidence'],
      optional: [],
      enums: {},
      types: { item: 'string', commit: 'string|null', evidence: 'array' },
    },
    item_awaiting_human: {
      required: ['item'],
      optional: ['reason'],
      enums: {},
      types: { item: 'string', reason: 'string' },
    },
    ui_acceptance_failed: {
      required: ['ac', 'element', 'task', 'commit'],
      optional: ['trace_id'],
      enums: {},
      types: { ac: 'string', element: 'string', task: 'string', commit: 'string', trace_id: 'string' },
    },
    item_conflict_deferred: {
      required: ['item'],
      optional: ['reason', 'with'],
      enums: {},
      types: { item: 'string', reason: 'string', with: 'string' },
    },
    wip_limit_changed: {
      required: ['limit'],
      optional: [],
      enums: {},
      types: { limit: 'number' },
    },
    item_budget: {
      required: ['item', 'status'],
      optional: ['limit_tokens', 'spent_tokens', 'reason'],
      enums: { status: ['within', 'exceeded', 'waiting'] },
      types: { item: 'string', status: 'string', limit_tokens: 'number', spent_tokens: 'number', reason: 'string' },
      rules: ['budget_shape'],
    },
    item_judge: {
      required: ['item', 'judge', 'score', 'threshold', 'outcome', 'commit'],
      optional: ['judge_version', 'rubric_hash', 'trace_id'],
      enums: { outcome: ['pass', 'fail'] },
      types: { item: 'string', judge: 'string', score: 'number', threshold: 'number', outcome: 'string', commit: 'string|null', judge_version: 'string', rubric_hash: 'string', trace_id: 'string' },
    },
    // A pipeline started building a handover, and how that run ended (Build's Runs). `run` is the pipeline's own
    // id for the attempt; the status is generic so any pipeline maps its own outcomes onto it.
    run_started: {
      required: ['run', 'handover'],
      optional: [],
      enums: {},
      types: { run: 'string', handover: 'string' },
    },
    run_ended: {
      required: ['run', 'handover', 'status'],
      optional: ['reason'],
      enums: { status: ['succeeded', 'failed', 'parked', 'cancelled'] },
      types: { run: 'string', handover: 'string', status: 'string', reason: 'string' },
      rules: ['ended_needs_reason'],
    },
    item_recheck: {
      required: ['item', 'handover', 'stale', 'reasons'],
      optional: [],
      enums: {},
      types: { item: 'string', handover: 'string', stale: 'boolean', reasons: 'array' },
    },
    gate: {
      required: ['source', 'revision', 'ready', 'verdict', 'clauses', 'findings'],
      optional: ['commit', 'dirty'],
      enums: { source: ['local', 'pipeline'] },
      types: { revision: 'string', ready: 'boolean', verdict: 'string', clauses: 'array', findings: 'array', commit: 'string|null', dirty: 'boolean' },
    },
    extraction: {
      required: ['repo', 'revision', 'projects', 'deployables', 'tests', 'elements', 'edges', 'unresolved'],
      optional: [],
      enums: {},
    },
    agent_turn: {
      required: ['agent', 'role', 'via'],
      optional: ['model', 'ms', 'tokens', 'tokens_in', 'tokens_out', 'stop_reason', 'context_used', 'run_id'],
      enums: { via: ['builtin', 'acp', 'agui'] },
    },
    agent_tool: {
      required: ['agent', 'role', 'tool', 'verdict', 'outcome', 'via'],
      optional: ['tool_kind', 'path'],
      enums: { verdict: ['allow', 'ask', 'deny', 'agent'], via: ['builtin', 'designc', 'acp', 'agui'] },
    },
    agent_permission: {
      required: ['agent', 'role', 'tool', 'outcome', 'via'],
      optional: ['tool_kind'],
      enums: { via: ['acp'] },
    },
    agent_approval: {
      required: ['agent', 'role', 'tool', 'interrupt', 'outcome', 'via'],
      optional: [],
      enums: { via: ['agui'] },
    },
    unapproved_change: {
      required: ['agent', 'role', 'path', 'via'],
      optional: [],
      enums: { via: ['acp', 'agui'] },
    },
    // Factory evals: an eval harness run of the Build pipeline, written through `designc record` (allowlisted kinds).
    // A suite run states its versions once and pins each eval task's hash and grader lists, so a trial's
    // outcome can be derived from the ledger alone (Ledger.suiteRuns).
    suite_run: {
      required: ['suite_run_id', 'suite', 'harness_version', 'model', 'prompt_version', 'trials', 'tasks'],
      optional: ['configurator'],
      enums: {},
      types: { suite_run_id: 'string', suite: 'string', harness_version: 'string', model: 'string', prompt_version: 'string', trials: 'number', tasks: 'object' },
      rules: ['suite_run_shape'],
    },
    grader: {
      required: ['suite_run_id', 'task_id', 'trial', 'grader', 'verdict'],
      optional: ['reason', 'ms', 'judge_version', 'rubric_hash'],
      enums: { verdict: ['pass', 'fail', 'unknown', 'skipped'] },
      types: { suite_run_id: 'string', task_id: 'string', trial: 'number', grader: 'string' },
    },
    suite_run_finished: {
      required: ['suite_run_id', 'outcome'],
      optional: ['reason'],
      enums: { outcome: ['completed', 'aborted'] },
      types: { suite_run_id: 'string' },
      rules: ['aborted_needs_reason'],
    },
    // A person names the failure mode (factory/taxonomy.yaml) of an escape recorded in a design registry, by its
    // designc.json `registries` key. Written by the app only (never by `designc record`); null clears it.
    failure_mode_classified: {
      required: ['registry', 'escape', 'failure_mode'],
      optional: [],
      enums: {},
      types: { registry: 'string', escape: 'string', failure_mode: 'string|null' },
    },
    // A human binds an eval task (factory/tasks/<id>.yaml): this pins the hash of the file as it was read, like
    // decision_promoted. Editing the file afterwards makes the task `changed` until it is bound again.
    factory_task_bound: {
      required: ['task_id', 'hash'],
      optional: [],
      enums: {},
      types: { task_id: 'string', hash: 'string' },
      rules: ['hash_not_blank'],
    },
    // A human pins a domain pack: domain/<pack>.yaml in the project is a copy of <registry>'s pack with this hash.
    // The latest pin per pack wins. Written by the app only; `designc record` refuses it.
    domain_pinned: {
      required: ['pack', 'registry', 'hash'],
      optional: [],
      enums: {},
      types: { pack: 'string', registry: 'string', hash: 'string' },
      rules: ['hash_not_blank'],
    },
    // Error analysis: a person's verdict on one task attempt of a pipeline run (`observation` is its task span in
    // telemetry). Written by the app only; the latest per observation wins. `failure_mode` names a mode in
    // factory/taxonomy.yaml (null or absent: not assigned).
    trace_review: {
      required: ['trace_id', 'observation', 'verdict', 'note'],
      optional: ['run_id', 'task', 'attempt', 'failure_mode'],
      enums: { verdict: ['pass', 'fail'] },
      types: { trace_id: 'string', observation: 'string', note: 'string', attempt: 'number', failure_mode: 'string|null' },
      rules: ['fail_needs_note'],
    },
  };

  const isPlainObject = v => v != null && typeof v === 'object' && !Array.isArray(v);
  // Conditional rules named in a kind's `rules`; each returns an error (without the kind prefix) or null.
  // Mirrored by id in python/designc/ledger.py.
  const RULES = {
    fail_needs_evidence: ev => (ev.outcome === 'fail' && ev.exit_code === undefined && !ev.reason ? "exit_code: required when outcome is 'fail' (or give reason)" : null),
    budget_shape: ev => {
      for (const k of ['limit_tokens', 'spent_tokens']) {
        if (ev[k] !== undefined && !(Number.isInteger(ev[k]) && ev[k] >= 0)) return `${k}: must be a whole number of at least 0`;
      }
      if (ev.status !== undefined && ev.status !== 'within') {
        for (const k of ['limit_tokens', 'spent_tokens']) if (ev[k] === undefined) return `${k}: required when status is not 'within'`;
      }
      return null;
    },
    // task.usage: a running total per model the task used, [{model, tier?, turns, tokens_in, tokens_out, cost?, cache_read?, cache_write?}].
    // The cache counts are the part of tokens_in read from or written to a prompt cache, not extra to it.
    usage_shape: ev => {
      if (ev.usage === undefined) return null;
      if (!Array.isArray(ev.usage)) return 'usage: must be a list of {model, turns, tokens_in, tokens_out}';
      for (const [i, u] of ev.usage.entries()) {
        const at = `usage[${i}]`;
        if (!isPlainObject(u)) return `${at}: must be an object`;
        if (typeof u.model !== 'string' || !u.model) return `${at}.model: must be a non-empty string`;
        if (u.tier !== undefined && typeof u.tier !== 'string') return `${at}.tier: must be a string`;
        for (const k of ['turns', 'tokens_in', 'tokens_out']) if (!(Number.isInteger(u[k]) && u[k] >= 0)) return `${at}.${k}: must be a whole number of at least 0`;
        if (u.cost !== undefined && typeof u.cost !== 'number') return `${at}.cost: must be a number`;
        for (const k of ['cache_read', 'cache_write']) if (u[k] !== undefined && !(Number.isInteger(u[k]) && u[k] >= 0)) return `${at}.${k}: must be a whole number of at least 0`;
        if ((u.cache_read || 0) + (u.cache_write || 0) > u.tokens_in) return `${at}: cache_read and cache_write are part of tokens_in, so together at most tokens_in`;
      }
      return null;
    },
    // task.by_role: the task's tokens by the role that spent them, [{role, turns, tokens_in, tokens_out, cold?}]; `cold` is how many of its turns missed a cache they should have hit. Display only.
    by_role_shape: ev => {
      if (ev.by_role === undefined) return null;
      if (!Array.isArray(ev.by_role)) return 'by_role: must be a list of {role, turns, tokens_in, tokens_out}';
      for (const [i, u] of ev.by_role.entries()) {
        const at = `by_role[${i}]`;
        if (!isPlainObject(u)) return `${at}: must be an object`;
        if (typeof u.role !== 'string' || !u.role) return `${at}.role: must be a non-empty string`;
        for (const k of ['turns', 'tokens_in', 'tokens_out']) if (!(Number.isInteger(u[k]) && u[k] >= 0)) return `${at}.${k}: must be a whole number of at least 0`;
        if (u.cold !== undefined) {
          if (!(Number.isInteger(u.cold) && u.cold >= 0)) return `${at}.cold: must be a whole number of at least 0`;
          if (u.cold > u.turns) return `${at}.cold: cannot be more than turns`;
        }
      }
      return null;
    },
    suite_run_shape: ev => {
      if (ev.trials !== undefined && !(Number.isInteger(ev.trials) && ev.trials >= 1)) return 'trials: must be a whole number of at least 1';
      if (!isPlainObject(ev.tasks)) return null;
      const ids = Object.keys(ev.tasks);
      if (!ids.length) return 'tasks: must name at least one eval task';
      const names = v => Array.isArray(v) && v.every(x => typeof x === 'string' && x);
      for (const id of ids) {
        const t = ev.tasks[id];
        if (!isPlainObject(t) || typeof t.hash !== 'string' || !t.hash) return `tasks.${id}: needs a hash`;
        if (!names(t.gates) || !t.gates.length) return `tasks.${id}: needs at least one gate grader`;
        if (t.gradients !== undefined && !names(t.gradients)) return `tasks.${id}: gradients must be a list of grader names`;
      }
      return null;
    },
    fail_needs_note: ev => (ev.verdict === 'fail' && typeof ev.note === 'string' && !ev.note.trim() ? "note: say what went wrong when verdict is 'fail'" : null),
    hash_not_blank: ev => (typeof ev.hash === 'string' && !ev.hash.trim() ? 'hash: must not be blank' : null),
    ended_needs_reason: ev => (ev.status !== undefined && ev.status !== 'succeeded' && !ev.reason ? "reason: required when status is not 'succeeded'" : null),
    aborted_needs_reason: ev => (ev.outcome === 'aborted' && !ev.reason ? "reason: required when outcome is 'aborted'" : null),
    caught_by_member: ev => ('caught_by' in ev && ev.caught_by !== undefined && ev.caught_by !== null && !CAUGHT_BY.includes(ev.caught_by) ? `caught_by: must be null or one of ${CAUGHT_BY.join('|')}` : null),
    origin_member: ev => ('origin' in ev && ev.origin !== undefined && ev.origin !== null && !ORIGINS.includes(ev.origin) ? `origin: must be null or one of ${ORIGINS.join('|')}` : null),
  };
  // Field types for kinds that declare `types` (table data, so python/designc/ledger_schema.json can carry it).
  const isType = (v, t) => t === 'null' ? v === null : t === 'array' ? Array.isArray(v) : t === 'object' ? isPlainObject(v) : typeof v === t;
  const TYPE_NAMES = { boolean: 'a boolean', string: 'a string', array: 'an array', object: 'an object', number: 'a number', 'string|null': 'a string or null' };
  const basename = p => String(p || '').split(/[\\/]/).pop();

  // An accepted risk rests on its business decision and needs no check; a TODO placeholder is not a check.
  // Same rule as the gate in core.js and python/designc (gate.py, verify.py).
  const acceptWithoutCheck = d => d.effect === 'accept' && !(d.checks || []).some(c => c && !/^TODO/.test(String(c)));
  // Skip-unchanged recording: true when the latest gate event from the same source has the same model
  // revision, commit (absent equals null) and verdict. `events` is the ordered ledger (Ledger.order).
  // Ledger integrity. `files` are raw `{path, text}`; read here so every line, repeat and harness event is seen.
  // Rules: V1 handover preceded by a green gate at its revision (a warning when it predates the first gate event),
  // V2 handover not dirty, V3 technical promotion preceded by a passing check, V4 every line validates,
  // V5 no repeated event_id with different content, V6 open unapproved changes (warning),
  // V7 handovers/ and handover events agree, V8 a pipeline eval after the latest handover ran under the eval file that handover froze, V9 pipeline.jsonl holds only PIPELINE_KINDS. Sample events are skipped. Mirrored in python/designc/verify.py.
  const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']'
    : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v);
  const bareRevision = r => String(r == null ? '' : r).replace(/^r-/, '');
  function verify(files, { handovers = [], decisions = [], handoverEvals = {} } = {}) {
    const errors = [], warnings = [];
    const err = (rule, msg) => errors.push({ rule, msg }), warn = (rule, msg) => warnings.push({ rule, msg });
    const firstSeen = new Map(), events = [];
    for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      const name = basename(f.path);
      String(f.text || '').split('\n').forEach((raw, i) => {
        if (!raw.trim()) return;
        const at = `${name}:${i + 1}`;
        let obj;
        try { obj = JSON.parse(raw); } catch { return err('V4', `${at} not valid JSON`); }
        if (!isPlainObject(obj)) return err('V4', `${at} not a JSON object`);
        if (obj.schema_version !== undefined && obj.envelope_version !== undefined) return err('V4', `${at} both schema_version and envelope_version`);
        if (obj.envelope_version !== undefined) return;
        if (name === PIPELINE_STREAM && typeof obj.kind === 'string' && !PIPELINE_KINDS.includes(obj.kind)) err('V9', `${at} ${obj.kind} is not a kind a pipeline writes (docs/pipeline-contract.md)`);
        let e;
        if (obj.schema_version === undefined) e = { ...obj, event_id: `legacy:${name}:${i + 1}` };
        else {
          if (obj.schema_version !== SCHEMA_VERSION) return err('V4', `${at} unknown schema_version ${obj.schema_version}`);
          const errs = validate(obj);
          if (errs.length) return err('V4', `${at} ${errs.join('; ')}`);
          e = obj;
          const seen = firstSeen.get(e.event_id);
          if (seen) { if (seen.body !== stable(e) && !seen.reported) { seen.reported = true; err('V5', `event_id ${e.event_id} has different content at ${seen.at} and ${at}`); } return; }
          firstSeen.set(e.event_id, { body: stable(e), at });
        }
        events.push({ ...e, _ts: typeof e.ts === 'number' ? e.ts : 0 });
      });
    }
    events.sort((a, b) => a._ts - b._ts);
    const live = events.filter(e => !e.sample), skipped = events.length - live.length;
    const gates = live.filter(e => e.kind === 'gate'), checks = live.filter(e => e.kind === 'check');
    const latest = (list, pred, ts) => list.filter(e => pred(e) && e._ts <= ts).pop();
    const firstGate = gates.length ? gates[0]._ts : null;
    for (const h of live.filter(e => e.kind === 'handover')) {
      if (h.dirty === true) err('V2', `handover ${h.handover} was frozen with uncommitted gate inputs`);
      if (h.item != null) continue; // a work item's handover follows the gate scoped to that item, which is not a ledger event
      if (firstGate === null || h._ts < firstGate) { warn('V1', `handover ${h.handover} predates gate recording`); continue; }
      const g = latest(gates, x => bareRevision(x.revision) === bareRevision(h.revision), h._ts);
      if (!g) err('V1', `handover ${h.handover} has no gate event at revision ${bareRevision(h.revision)} before it`);
      else if (!g.ready) err('V1', `handover ${h.handover}: the latest gate event at revision ${bareRevision(h.revision)} before it was not ready`);
    }
    for (const p of live.filter(e => e.kind === 'decision_promoted')) {
      const d = decisions.find(x => x.id === p.decision);
      if (!d || d.kind === 'business' || acceptWithoutCheck(d)) continue;
      const c = latest(checks, x => x.decision === p.decision, p._ts);
      if (!c || c.outcome !== 'pass') err('V3', `decision ${p.decision} was promoted without a passing check before it`);
    }
    for (const u of live.filter(e => e.kind === 'unapproved_change')) warn('V6', `unapproved change by ${u.agent} (${u.role}) to ${u.path}`);
    const eventIds = new Set(live.filter(e => e.kind === 'handover').map(e => e.handover)), folderIds = new Set(handovers);
    for (const id of handovers) if (!eventIds.has(id)) err('V7', `handover ${id} has no handover event in the ledger`);
    for (const id of eventIds) if (!folderIds.has(id)) err('V7', `handover event ${id} has no handover in handovers/`);
    // V8: handoverEvals is { <handover id>: { <eval id>: <eval_hash> } }, read from each handover.yaml.
    const lastHandover = live.filter(e => e.kind === 'handover').pop() || { _ts: Infinity };
    const frozen = (lastHandover && handoverEvals[lastHandover.handover]) || {};
    const said = new Set();
    for (const e of live.filter(x => x.kind === 'eval' && x.source === 'pipeline' && x._ts > lastHandover._ts)) {
      const key = `${e.eval}:${e.eval_hash}`;
      if (Object.prototype.hasOwnProperty.call(frozen, e.eval) && frozen[e.eval] !== e.eval_hash && !said.has(key)) { said.add(key); err('V8', `pipeline eval ${e.eval} ran under a different eval file than handover ${lastHandover.handover} froze`); }
    }
    return { errors, warnings, skipped };
  }

  function gateUnchanged(events, ev) {
    let last = null;
    for (const e of events) if (e.kind === 'gate' && e.source === ev.source && (!last || (e._ts || 0) >= (last._ts || 0))) last = e;
    return !!last && last.revision === ev.revision && (last.commit ?? null) === (ev.commit ?? null) && last.verdict === ev.verdict;
  }

  function validate(ev) {
    if (!isPlainObject(ev)) return ['event must be an object'];
    const errors = [];
    if (!KINDS[ev.kind]) { errors.push(`kind: unknown kind '${ev.kind}'`); return errors; }
    if (typeof ev.by !== 'string' || !ev.by) errors.push('by: required string');
    if ('schema_version' in ev && ev.schema_version !== undefined && ev.schema_version !== SCHEMA_VERSION)
      errors.push(`schema_version: must be ${SCHEMA_VERSION}, got ${ev.schema_version}`);
    if ('envelope_version' in ev && ev.envelope_version !== undefined) errors.push('envelope_version: not allowed on a designc kind');
    if ('ts' in ev && ev.ts != null && typeof ev.ts !== 'number') errors.push('ts: must be a number (epoch ms)');
    for (const k of Object.keys(ev)) if (k.startsWith('_')) errors.push(`${k}: '_'-prefixed keys are reserved`);
    if ('payload' in ev && ev.payload !== undefined && !isPlainObject(ev.payload)) errors.push('payload: must be an object');

    const spec = FINAL_KIND_FIELDS[ev.kind];
    if (spec) {
      const known = new Set(['schema_version', 'event_id', 'ts', 'kind', 'by', ...ENVELOPE_OPTIONAL, ...spec.required, ...spec.optional]);
      for (const k of Object.keys(ev)) if (!known.has(k) && !k.startsWith('_')) errors.push(`${k}: unknown field for kind '${ev.kind}' (put extra data under payload)`);
      for (const r of spec.required) if (ev[r] === undefined) errors.push(`${ev.kind}.${r}: required`);
      if (spec.enums) for (const [f, vals] of Object.entries(spec.enums)) if (ev[f] !== undefined && !vals.includes(ev[f])) errors.push(`${ev.kind}.${f}: must be one of ${vals.join('|')}`);
      if (spec.types) for (const [f, t] of Object.entries(spec.types)) if (ev[f] !== undefined && !t.split('|').some(x => isType(ev[f], x))) errors.push(`${ev.kind}.${f}: must be ${TYPE_NAMES[t] || t}`);
      for (const r of spec.rules || []) { const msg = RULES[r](ev); if (msg) errors.push(`${ev.kind}.${msg}`); }
    }
    return errors;
  }

  // LS-03/LS-05: legacy per-kind renames (rule->code, stage->caught_by, camelCase agent fields
  // ->snake_case, via inferred where the legacy shape never recorded it). Also moves any key not
  // in a locked-down kind's spec into payload, so callers always find extra data in the same place.
  function upcast(ev) {
    const e = { ...ev };
    if (e.kind === 'escape') {
      if ('rule' in e) { e.code = e.rule; delete e.rule; }
      if ('stage' in e) { e.caught_by = e.stage; delete e.stage; }
    } else if (e.kind === 'escape_classified') {
      if ('stage' in e) { e.caught_by = e.stage; delete e.stage; }
    } else if (e.kind === 'agent_turn') {
      if (!('via' in e)) e.via = ('runId' in e || /^agui:/.test(e.model || '')) ? 'agui' : ('stopReason' in e) ? 'acp' : 'builtin';
      if ('runId' in e) { e.run_id = e.runId; delete e.runId; }
      if ('stopReason' in e) { e.stop_reason = e.stopReason; delete e.stopReason; }
      if (e.via === 'acp' && 'tokens' in e) { e.context_used = e.tokens; delete e.tokens; }
    } else if (e.kind === 'agent_tool' || e.kind === 'agent_permission') {
      if ('toolKind' in e) { e.tool_kind = e.toolKind; delete e.toolKind; }
    } else if (e.kind === 'unapproved_change') {
      if (!('via' in e)) e.via = 'acp';
    }
    const spec = FINAL_KIND_FIELDS[e.kind];
    if (spec) {
      const known = new Set(['schema_version', 'event_id', 'ts', 'kind', 'by', ...ENVELOPE_OPTIONAL, ...spec.required, ...spec.optional]);
      const extra = {};
      for (const k of Object.keys(e)) if (!known.has(k) && !k.startsWith('_')) { extra[k] = e[k]; delete e[k]; }
      if (Object.keys(extra).length) e.payload = { ...(isPlainObject(e.payload) ? e.payload : {}), ...extra };
    }
    return e;
  }

  const nonBlank = v => {
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    if (isPlainObject(v)) return Object.keys(v).length > 0;
    return false;
  };
  // Port of event.py's has_failure_evidence / records_a_failure.
  function recordsFailure(kind, payload) {
    if (kind === 'GateFailed' || kind === 'ActionErrored') return true;
    if (kind === 'VerifyResult') {
      const verdict = typeof payload.verdict === 'string' ? payload.verdict.trim().toLowerCase() : '';
      if (['fail', 'failed', 'partial', 'error', 'blocked'].includes(verdict)) return true;
      if (Number.isInteger(payload.exit_code) && payload.exit_code !== 0) return true;
    }
    return false;
  }
  function hasFailureEvidence(payload) {
    if (['reason', 'verify_failures', 'failures', 'gate_errors', 'issues'].some(k => nonBlank(payload[k]))) return true;
    return nonBlank(payload.reason_unavailable);
  }

  function validateHarness(ev) {
    if (!isPlainObject(ev)) return ['event must be an object'];
    const errors = [];
    if (!HARNESS_KINDS.includes(ev.kind)) { errors.push(`kind: unknown harness kind '${ev.kind}'`); return errors; }
    if ('schema_version' in ev && ev.schema_version !== undefined) errors.push('schema_version: not allowed on a harness kind');
    if ('envelope_version' in ev && ev.envelope_version !== undefined && ev.envelope_version !== HARNESS_ENVELOPE_VERSION)
      errors.push(`envelope_version: must be ${HARNESS_ENVELOPE_VERSION}, got ${ev.envelope_version}`);
    if (typeof ev.project !== 'string' || !ev.project) errors.push('project: required non-empty string');
    if (typeof ev.session_id !== 'string' || !ev.session_id) errors.push('session_id: required string');
    if (!isPlainObject(ev.payload)) errors.push('payload: required object');
    for (const f of ['parent_session_id', 'agent_id', 'acting_as'])
      if (f in ev && ev[f] !== undefined && ev[f] !== null && typeof ev[f] !== 'string') errors.push(`${f}: must be a string or null`);
    if ('ts' in ev && ev.ts !== undefined && (typeof ev.ts !== 'string' || Number.isNaN(Date.parse(ev.ts)))) errors.push('ts: must be an ISO-8601 string');
    for (const k of Object.keys(ev)) {
      if (k.startsWith('_')) { errors.push(`${k}: '_'-prefixed keys are reserved`); continue; }
      if (!HARNESS_FIELDS.includes(k)) errors.push(`${k}: unknown field for harness kind '${ev.kind}' (put extra data under payload)`);
    }
    if (isPlainObject(ev.payload) && recordsFailure(ev.kind, ev.payload) && !hasFailureEvidence(ev.payload))
      errors.push(`${ev.kind}.payload: failure records require reason, verify_failures, failures, gate_errors, issues or reason_unavailable`);
    return errors;
  }

  // Port of event.py's resolved_event_ids: a HumanDecision resolves the harness NeedsDecision it cites.
  function resolvedEventIds(events) {
    const ids = new Set();
    for (const e of events) if (e.kind === 'HumanDecision' && isPlainObject(e.payload) && e.payload.cites_event_id) ids.add(e.payload.cites_event_id);
    return ids;
  }

  function parse(text, path) {
    const events = [], errors = [];
    const file = basename(path);
    const lines = String(text || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      const line = i + 1;
      let obj;
      try { obj = JSON.parse(raw); } catch (e) { errors.push({ path, line, msg: 'not valid JSON: ' + e.message }); continue; }
      if (!isPlainObject(obj)) { errors.push({ path, line, msg: 'not a JSON object' }); continue; }
      if (obj.schema_version !== undefined && obj.envelope_version !== undefined) {
        errors.push({ path, line, msg: 'both schema_version and envelope_version' }); continue;
      }
      if (obj.envelope_version !== undefined) {
        if (obj.envelope_version !== HARNESS_ENVELOPE_VERSION) {
          errors.push({ path, line, msg: `unknown envelope_version ${obj.envelope_version}` }); continue;
        }
        const herrs = validateHarness(obj);
        if (herrs.length) { errors.push({ path, line, msg: herrs.join('; ') }); continue; }
        events.push({ ...obj, _file: file, _line: line, _ts: Date.parse(obj.ts) });
        continue;
      }
      if (obj.schema_version === undefined) {
        const up = upcast(obj);
        events.push({ ...up, schema_version: SCHEMA_VERSION, event_id: `legacy:${file}:${line}`, _legacy: true, _file: file, _line: line, _ts: typeof up.ts === 'number' ? up.ts : 0 });
        continue;
      }
      if (obj.schema_version !== SCHEMA_VERSION) {
        errors.push({ path, line, msg: `unknown schema_version ${obj.schema_version}` }); continue;
      }
      const errs = validate(obj);
      if (errs.length) { errors.push({ path, line, msg: errs.join('; ') }); continue; }
      events.push({ ...obj, _file: file, _line: line, _ts: typeof obj.ts === 'number' ? obj.ts : 0 });
    }
    return { events, errors };
  }

  // Escape ids must not collide across branches, so they come from a uuid, not from a count.
  const escapeId = uuid => 'E-' + String(uuid).replace(/-/g, '').slice(0, 8);

  // One stream out of several files: drop an event_id already seen (a union merge, or the same line
  // read twice) and order by time. Array.prototype.sort is stable, so equal timestamps keep file order.
  function order(events) {
    const seen = new Set();
    return events.filter(e => !seen.has(e.event_id) && seen.add(e.event_id)).sort((a, b) => a._ts - b._ts);
  }

  // The ledger is append-only: classification and resolution are later events, folded in here.
  function derive(events) {
    const classify = new Map(), origins = new Map(), resolved = new Map();
    for (const e of events) {
      if (e.kind === 'escape_classified') { classify.set(e.escape, e.caught_by); if ('origin' in e) origins.set(e.escape, e.origin); }
      if (e.kind === 'needs_decision_resolved') resolved.set(e.id, resolution(e));
    }
    return events.filter(e => !['escape_classified', 'needs_decision_resolved'].includes(e.kind)).map(e => {
      if (e.kind === 'escape' && (classify.has(e.id) || origins.has(e.id))) {
        const o = { ...e };
        if (classify.has(e.id)) o.caught_by = classify.get(e.id);
        if (origins.has(e.id)) o.origin = origins.get(e.id);
        return o;
      }
      if (e.kind === 'needs_decision' && resolved.has(e.id)) return { ...e, status: 'resolved', resolution: resolved.get(e.id) };
      return e;
    });
  }

  // A person's answer to a needs_decision: the option chosen of those offered, a note, or the decision that answers it.
  function resolution(e) {
    const p = isPlainObject(e.payload) ? e.payload : {};
    const str = v => (typeof v === 'string' && v.trim() ? v : null);
    return { by: e.by || null, ts: e._ts ?? e.ts ?? null, option: str(p.option), note: str(p.note), decision: str(e.decision) };
  }

  // The needs_decision events a run's park reason names, each id matched as a whole word.
  function parkedOn(events, reason) {
    const text = String(reason || '');
    const word = id => new RegExp(`(^|[^\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`);
    return (events || []).filter(e => e.kind === 'needs_decision' && typeof e.id === 'string' && e.id && word(e.id).test(text));
  }

  // Whether a parked run can be resumed (`events` derived): it is parked, its handover is open, and every
  // needs-decision it waits on (named in the park reason, or an open one carrying payload.run_id) is answered
  // in a form the pipeline accepts. `confirm` lists what a person should see before resuming anyway;
  // `decisions` are the decision ids answers name, for the app to check they exist.
  function resumeCheck(events, run) {
    const ev = (events || []).slice().sort((a, b) => (a._ts || 0) - (b._ts || 0));
    const own = ev.filter(e => (e.kind === 'run_started' || e.kind === 'run_ended') && e.run === run);
    const last = own[own.length - 1];
    const out = { ok: false, run, handover: last ? last.handover || null : null, blockers: [], confirm: [], answered: [], decisions: [] };
    if (!last) { out.blockers.push(`There is no run ${run} in the ledger.`); return out; }
    if (last.kind === 'run_started') out.blockers.push(`Run ${run} is running again.`);
    else if (last.status !== 'parked') out.blockers.push(`Run ${run} is not parked: it ${last.status === 'succeeded' ? 'succeeded' : last.status === 'cancelled' ? 'was cancelled' : last.status}.`);
    const closed = ev.filter(e => e.kind === 'handover_closed' && e.handover === out.handover && (e._ts || 0) > (last._ts || 0)).pop();
    if (closed) out.blockers.push(`Handover ${out.handover} was closed (${closed.outcome}), so its runs are final.`);
    const waits = last.kind === 'run_ended' ? parkedOn(ev, last.reason) : [];
    for (const e of ev) if (e.kind === 'needs_decision' && e.status === 'open' && isPlainObject(e.payload) && e.payload.run_id === run && !waits.includes(e)) waits.push(e);
    for (const nd of waits) {
      if (nd.status !== 'resolved') { out.blockers.push(`${nd.id} is not answered yet: choose an option, answer it with a decision or mark it resolved, then resume.`); continue; }
      const r = nd.resolution || {}, { options } = ndOptions(nd);
      if (r.option && options.length && !options.some(o => o.id === r.option)) {
        out.blockers.push(`${nd.id} was answered with option ${r.option}, which is not one it offered (${options.map(o => o.id).join(', ')}). The run would refuse it and park again: answer it again.`);
        continue;
      }
      if (options.length && !r.option && !r.note && !r.decision) out.confirm.push(`${nd.id} was closed without choosing an option, a note or a decision, so the agent is only told to re-read the handover and decisions.`);
      if (r.decision) out.decisions.push(r.decision);
      out.answered.push(nd.id);
    }
    out.ok = !out.blockers.length;
    return out;
  }

  // The options a pipeline offered with a needs_decision (payload.options [{id, summary, consequence?}], payload.recommended).
  // An option without an id or summary is dropped; a recommendation that is not an offered option is none.
  function ndOptions(nd) {
    const p = nd && isPlainObject(nd.payload) ? nd.payload : {};
    const options = (Array.isArray(p.options) ? p.options : [])
      .filter(o => isPlainObject(o) && typeof o.id === 'string' && o.id.trim() && typeof o.summary === 'string' && o.summary.trim())
      .map(o => ({ id: o.id, summary: o.summary, ...(typeof o.consequence === 'string' ? { consequence: o.consequence } : {}) }));
    const recommended = options.some(o => o.id === p.recommended) ? p.recommended : null;
    return { options, recommended };
  }

  // Slice 33: what the escapes say about where the factory leaks. Pure; `uiElements` is the set of element
  // names tagged UI, `items` the work item ids that carry acceptance criteria (all done items when omitted).
  function escapeMetrics(events, { uiElements = [], items = null } = {}) {
    const esc = events.filter(e => e.kind === 'escape'), ui = new Set(uiElements);
    const byOrigin = Object.fromEntries(ORIGINS.map(o => [o, 0])); let unclassified = 0;
    for (const e of esc) { if (ORIGINS.includes(e.origin)) byOrigin[e.origin]++; else unclassified++; }
    const done = new Set(events.filter(e => e.kind === 'item_done').map(e => e.item));
    const judged = [...done].filter(id => !items || items.includes(id));
    const failed = new Set(events.filter(e => e.kind === 'ui_acceptance_failed').map(e => e.task));
    const firstPass = judged.filter(id => !failed.has(id)).length;
    const tamper = events.filter(e => e.kind === 'unapproved_change' && /^(acceptance|tests\/acceptance)\//.test(String(e.path || ''))).length;
    const uiEscapes = esc.filter(e => e.element && ui.has(e.element)).length;
    return { escapes: esc.length, uiEscapes, uiEscapeRate: judged.length ? uiEscapes / judged.length : null, byOrigin, unclassified, acceptance: { done: judged.length, firstPass }, tamper };
  }

  function totalTokens(ev) {
    if (typeof ev.tokens === 'number') return ev.tokens;
    if (typeof ev.tokens_in === 'number' || typeof ev.tokens_out === 'number') return (ev.tokens_in || 0) + (ev.tokens_out || 0);
    return 0;
  }

  // Spend per element and handover, from `task` events that name a handover and an element.
  // Reruns and failures count; events with no handover or no element are left out. Returns
  // Map(element name -> [{handover, tokens, cost}]) for the last `window` handovers, oldest first
  // (a handover's place is the time of its first task). Expects events in Ledger.order.
  // The task rows that count as spend. A row naming its `run` is a running total for that task in that run,
  // so only the latest per handover, task and run counts; a row with no `run` counts as written.
  function spendRows(events) {
    const latest = new Map(), out = [];
    for (const e of events) {
      if (e.kind !== 'task' || e.sample) continue;
      if (e.run == null) out.push(e);
      else latest.set(`${e.handover}\u0000${e.task}\u0000${e.run}`, e);
    }
    const keep = new Set([...out, ...latest.values()]);
    return events.filter(e => keep.has(e));
  }

  function elementHistory(events, { window = 10 } = {}) {
    const byEl = new Map(), first = new Map();
    for (const e of spendRows(events)) {
      if (!e.handover || !e.element) continue;
      if (!first.has(e.handover)) first.set(e.handover, first.size);
      const rows = byEl.get(e.element) || new Map();
      const r = rows.get(e.handover) || { handover: e.handover, tokens: 0, cost: 0 };
      r.tokens += totalTokens(e); r.cost += typeof e.cost === 'number' ? e.cost : 0;
      rows.set(e.handover, r); byEl.set(e.element, rows);
    }
    const out = new Map();
    for (const [el, rows] of byEl) out.set(el, [...rows.values()].sort((a, b) => first.get(a.handover) - first.get(b.handover)).slice(-window));
    return out;
  }

  // What one handover has cost so far. After a `handover_closed` event the figure is final: later tasks
  // are counted in `afterClose` and left out of the totals. `closed` is the outcome or null.
  function handoverActuals(events, id) {
    const close = events.filter(e => e.kind === 'handover_closed' && e.handover === id).pop();
    const out = { tokens: 0, cost: 0, tasks: 0, closed: close ? close.outcome : null, afterClose: 0 };
    for (const e of spendRows(events)) {
      if (e.handover !== id) continue;
      if (close && e._ts > close._ts) { out.afterClose++; continue; }
      out.tasks++; out.tokens += totalTokens(e); out.cost += typeof e.cost === 'number' ? e.cost : 0;
    }
    return out;
  }

  // Sums `usage` entries per tier (else model), most tokens first: [{tier, models[], turns, tokens_in, tokens_out, tokens, cost, cache_read, cache_write}].
  function sumUsage(rows) {
    const by = new Map();
    for (const r of rows) for (const u of (Array.isArray(r.usage) ? r.usage : [])) {
      if (!u || typeof u.model !== 'string') continue;
      const key = u.tier || u.model;
      const t = by.get(key) || { tier: key, models: [], turns: 0, tokens_in: 0, tokens_out: 0, tokens: 0, cost: 0, cache_read: 0, cache_write: 0 };
      if (!t.models.includes(u.model)) t.models.push(u.model);
      const n = k => (Number.isFinite(u[k]) ? u[k] : 0);
      t.turns += n('turns'); t.tokens_in += n('tokens_in'); t.tokens_out += n('tokens_out'); t.cost += n('cost');
      t.cache_read += n('cache_read'); t.cache_write += n('cache_write');
      t.tokens = t.tokens_in + t.tokens_out;
      by.set(key, t);
    }
    return [...by.values()].sort((a, b) => b.tokens - a.tokens);
  }

  // Sums `by_role` entries per role, most tokens first: [{role, turns, tokens_in, tokens_out, tokens, cold}].
  function sumByRole(rows) {
    const by = new Map();
    for (const r of rows) for (const u of (Array.isArray(r.by_role) ? r.by_role : [])) {
      if (!u || typeof u.role !== 'string') continue;
      const t = by.get(u.role) || { role: u.role, turns: 0, tokens_in: 0, tokens_out: 0, tokens: 0, cold: 0 };
      const n = k => (Number.isFinite(u[k]) ? u[k] : 0);
      t.turns += n('turns'); t.tokens_in += n('tokens_in'); t.tokens_out += n('tokens_out'); t.cold += n('cold');
      t.tokens = t.tokens_in + t.tokens_out;
      by.set(u.role, t);
    }
    return [...by.values()].sort((a, b) => b.tokens - a.tokens);
  }

  // Spend per tier across the spend rows (Ledger.spendRows), for metrics; `without` counts rows that carry no usage.
  function usageByTier(events) {
    const rows = spendRows(events);
    return { tiers: sumUsage(rows), without: rows.filter(e => !Array.isArray(e.usage)).length };
  }

  // Build's Runs: one row per pipeline run, newest first. A run_started while the run is open is ignored; one
  // after its end reopens it (a parked run resumed), and the latest run_ended wins. A run's tasks are the task
  // rows naming it, else (no `run`) the task rows of its handover since it started and not after it ended,
  // latest status per task. A run with no end is `running`; `ms` runs from its latest start to `now` until it ends.
  function liveRuns(events, { now = Date.now() } = {}) {
    const runs = new Map();
    const row = (e) => {
      if (!runs.has(e.run)) runs.set(e.run, { run: e.run, handover: e.handover, started: null, ended: null, status: 'running', reason: null, sample: !!e.sample });
      return runs.get(e.run);
    };
    for (const e of events) {
      if (e.kind === 'run_started') {
        const r = row(e);
        if (r.started == null || r.ended != null) Object.assign(r, { started: e._ts, handover: e.handover, ended: null, status: 'running', reason: null });
      }
      if (e.kind === 'run_ended') { const r = row(e); Object.assign(r, { ended: e._ts, status: e.status, reason: e.reason || null }); }
    }
    return [...runs.values()].map(r => {
      const tasks = new Map();
      for (const e of events) {
        if (e.kind !== 'task') continue;
        if (e.run != null ? e.run !== r.run : (e.handover !== r.handover || r.started == null || e._ts < r.started || (r.ended != null && e._ts > r.ended))) continue;
        // A task still running when its run ended did not finish: it stopped with the run.
        const status = r.ended != null && e.status === 'running' ? 'stopped' : e.status;
        tasks.set(e.task, { task: e.task, status, element: e.element || null, title: e.title || null, tier: e.tier || null, tokens: totalTokens(e), usage: Array.isArray(e.usage) ? e.usage : null, by_role: Array.isArray(e.by_role) ? e.by_role : null, at: e._ts });
      }
      const ms = r.started == null ? null : (r.ended != null ? r.ended : now) - r.started;
      return { ...r, ms, tasks: [...tasks.values()], usage: sumUsage([...tasks.values()]), by_role: sumByRole([...tasks.values()]) };
    }).sort((a, b) => (b.ended != null ? b.ended : b.started) - (a.ended != null ? a.ended : a.started));
  }

  // What each agent did, for the Improve view. One row per agent and role, newest activity last-seen.
  // Reads the agent_* kinds and unapproved_change; every other kind is ignored.
  function agentActivity(events) {
    const rows = new Map();
    const row = e => {
      const k = `${e.agent}\u0000${e.role}`;
      if (!rows.has(k)) rows.set(k, { agent: e.agent, role: e.role, via: e.via, turns: 0, tokens: 0, tools: 0, allowed: 0, asked: 0, denied: 0, declined: 0, permissions: 0, approvals: 0, unapproved: 0, last: 0 });
      const r = rows.get(k); r.last = Math.max(r.last, e._ts || 0); return r;
    };
    for (const e of events) {
      if (e.kind === 'agent_turn') { const r = row(e); r.turns++; r.tokens += totalTokens(e); }
      else if (e.kind === 'agent_tool') {
        const r = row(e); r.tools++;
        if (e.verdict === 'allow') r.allowed++; else if (e.verdict === 'ask') r.asked++; else if (e.verdict === 'deny') r.denied++;
        if (e.outcome === 'declined') r.declined++;
      }
      else if (e.kind === 'agent_permission') row(e).permissions++;
      else if (e.kind === 'agent_approval') row(e).approvals++;
      else if (e.kind === 'unapproved_change') row(e).unapproved++;
    }
    return [...rows.values()];
  }

  // How each eval is trending, for the Improve view. One row per eval id, oldest result first in `series`.
  // `metrics[name]` holds every recorded value in time order plus the change from the previous run to the latest.
  function evalTrends(events) {
    const by = new Map();
    for (const e of events.filter(x => x.kind === 'eval' && !x.sample).sort((a, b) => (a._ts || 0) - (b._ts || 0))) {
      if (!by.has(e.eval)) by.set(e.eval, { eval: e.eval, agent: e.agent, runs: 0, passed: 0, failed: 0, latest: null, metrics: {} });
      const r = by.get(e.eval); r.agent = e.agent; r.runs++;
      if (e.outcome === 'pass') r.passed++; else r.failed++;
      r.latest = { outcome: e.outcome, source: e.source, ts: e._ts || 0, cases: e.cases };
      for (const [k, v] of Object.entries(e.metrics || {})) (r.metrics[k] = r.metrics[k] || { values: [] }).values.push(v);
    }
    for (const r of by.values()) for (const m of Object.values(r.metrics)) {
      const n = m.values.length;
      m.latest = m.values[n - 1]; m.change = n > 1 ? m.latest - m.values[n - 2] : null;
    }
    return [...by.values()];
  }

  // Factory evals: one row per suite run, oldest first. A trial passes when every gate grader its suite_run pinned
  // passed and fails as soon as one failed; otherwise it is `incomplete` while the run is open and `harness` once
  // suite_run_finished arrived (the harness, not the agent, failed). Gradients never decide. The latest event per
  // grader wins; gate events after the finish are ignored, gradient events still count. Events naming a task, trial
  // or grader the run did not declare count as `stray`. pass@1 is passed / judged (pass + fail) trials per task,
  // pass^k its k-th power; run figures are means over tasks that have a score. Expects events in Ledger.order.
  function suiteRuns(events, { k = 3 } = {}) {
    const runs = new Map();
    for (const e of events) {
      if (e.sample) continue;
      if (e.kind === 'suite_run' && !runs.has(e.suite_run_id)) {
        runs.set(e.suite_run_id, { run: e, finished: null, stray: 0, trials: new Map() });
        continue;
      }
      const r = runs.get(e.suite_run_id);
      if (!r) continue;
      if (e.kind === 'suite_run_finished' && !r.finished) { r.finished = e; continue; }
      if (e.kind !== 'grader') continue;
      const spec = r.run.tasks[e.task_id];
      const isGate = spec && spec.gates.includes(e.grader), isGradient = spec && (spec.gradients || []).includes(e.grader);
      if (!spec || !(isGate || isGradient) || !(Number.isInteger(e.trial) && e.trial >= 1 && e.trial <= r.run.trials)) { r.stray++; continue; }
      if (isGate && r.finished) continue;
      const key = `${e.task_id}\u0000${e.trial}`;
      const tr = r.trials.get(key) || { gates: {}, gradients: {}, trace_id: null };
      tr[isGate ? 'gates' : 'gradients'][e.grader] = e.verdict;
      if (e.trace_id) tr.trace_id = e.trace_id;
      r.trials.set(key, tr);
    }
    const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return [...runs.values()].map(({ run, finished, stray, trials }) => {
      const counts = { pass: 0, fail: 0, incomplete: 0, harness: 0 };
      const tasks = Object.entries(run.tasks).map(([task_id, spec]) => {
        const rows = [];
        for (let n = 1; n <= run.trials; n++) {
          const tr = trials.get(`${task_id}\u0000${n}`) || { gates: {}, gradients: {}, trace_id: null };
          const vs = spec.gates.map(x => tr.gates[x]);
          const outcome = vs.includes('fail') ? 'fail' : vs.every(v => v === 'pass') ? 'pass' : finished ? 'harness' : 'incomplete';
          counts[outcome]++;
          rows.push({ trial: n, outcome, ...tr });
        }
        const passed = rows.filter(x => x.outcome === 'pass').length, judged = passed + rows.filter(x => x.outcome === 'fail').length;
        const passAt1 = judged ? passed / judged : null;
        return { task_id, hash: spec.hash, gates: spec.gates, gradients: spec.gradients || [], trials: rows, passed, judged, passAt1,
          passK: passAt1 === null ? null : Math.pow(passAt1, k), allPassed: passed === run.trials };
      });
      const scored = tasks.filter(x => x.passAt1 !== null);
      return {
        suite_run_id: run.suite_run_id, suite: run.suite, harness_version: run.harness_version, model: run.model, prompt_version: run.prompt_version,
        configurator: run.configurator || null, trials: run.trials, started: run._ts || 0,
        finished: finished ? { outcome: finished.outcome, reason: finished.reason || null, ts: finished._ts || 0 } : null,
        status: finished ? finished.outcome : 'running', tasks, counts, stray, k,
        passAt1: mean(scored.map(x => x.passAt1)), passK: mean(scored.map(x => x.passK)), allPassed: tasks.filter(x => x.allPassed).length,
      };
    });
  }

  // Factory evals: each run of suiteRuns (oldest first) against its baseline, the latest earlier run of the same suite on a
  // different harness_version that has a score. A run on the same harness_version as an earlier one is a repeat (repeatOf)
  // and is never a baseline for its own version. Only tasks whose hash matches the baseline and that are scored on both
  // sides are compared, so an edited eval task never moves the number; the run delta is the mean of those task deltas.
  function suiteCompare(runs) {
    const out = new Map();
    runs.forEach((r, i) => {
      const earlier = runs.slice(0, i).filter(x => x.suite === r.suite).reverse();
      const same = earlier.find(x => x.harness_version === r.harness_version);
      const base = earlier.find(x => x.harness_version !== r.harness_version && x.passAt1 !== null) || null;
      const byId = new Map(base ? base.tasks.map(x => [x.task_id, x]) : []);
      const tasks = {}, deltas = [];
      for (const x of r.tasks) {
        const b = byId.get(x.task_id);
        if (!base) continue;
        if (!b) { tasks[x.task_id] = { status: 'new' }; continue; }
        if (b.hash !== x.hash) { tasks[x.task_id] = { status: 'changed' }; continue; }
        if (x.passAt1 === null || b.passAt1 === null) { tasks[x.task_id] = { status: 'unscored' }; continue; }
        const d = { status: 'compared', passAt1: x.passAt1 - b.passAt1, passK: x.passK - b.passK };
        tasks[x.task_id] = d; deltas.push(d);
      }
      const mean = f => (deltas.length ? deltas.reduce((a, d) => a + d[f], 0) / deltas.length : null);
      const ids = new Set(r.tasks.map(x => x.task_id));
      out.set(r.suite_run_id, { baseline: base ? base.suite_run_id : null, baselineVersion: base ? base.harness_version : null,
        repeatOf: same ? same.suite_run_id : null, compared: deltas.length, passAt1: mean('passAt1'), passK: mean('passK'), tasks,
        dropped: base ? base.tasks.map(x => x.task_id).filter(id => !ids.has(id)) : [] });
    });
    return out;
  }

  // Factory evals: escapes per failure mode. `taxonomy` is factory/taxonomy.yaml parsed ({modes: [{id, name, triage?,
  // description?}]}) or null; `escapes` are the known escapes as {registry, id}. The latest failure_mode_classified per
  // registry and escape wins and null clears it. An id the taxonomy does not list is a warning (`unknown`), never counted.
  // Classifications of escapes not in `escapes` still count: their registry may just be unreachable.
  const TRIAGE = ['spec', 'fix', 'grader'];
  // The modes of factory/taxonomy.yaml (null: no file), each with `count` 0, and what is wrong with the file.
  function taxonomyModes(taxonomy) {
    const problems = [], modes = [], ids = new Set();
    if (taxonomy != null) {
      if (!isPlainObject(taxonomy)) problems.push('factory/taxonomy.yaml must be a mapping with a modes list');
      else if (!Array.isArray(taxonomy.modes)) problems.push('modes must be a list');
      else taxonomy.modes.forEach((m, i) => {
        const id = isPlainObject(m) && m.id != null && String(m.id).trim() ? String(m.id).trim() : null;
        if (!id) return problems.push(`mode ${i + 1} needs an id`);
        if (ids.has(id)) return problems.push(`${id} is listed more than once`);
        ids.add(id);
        if (!m.name || !String(m.name).trim()) problems.push(`${id} needs a name`);
        if (m.triage != null && !TRIAGE.includes(m.triage)) problems.push(`${id}: triage must be ${TRIAGE.slice(0, -1).join(', ')} or ${TRIAGE[TRIAGE.length - 1]}`);
        modes.push({ id, name: m.name ? String(m.name) : '', triage: TRIAGE.includes(m.triage) ? m.triage : null, description: m.description ? String(m.description) : '', count: 0 });
      });
    }
    return { modes, problems };
  }

  // Adds one mode to factory/taxonomy.yaml text (null or blank: a new file) by appending lines at the end of the modes
  // list, so every other line stays as written. The id is the next FM-NN. Refused when the name is blank, the triage is
  // not a known one, the text does not parse, or modes is not the file's last block (the person edits the file instead).
  function addTaxonomyMode(text, mode, parseYaml) {
    const name = mode && mode.name != null ? String(mode.name).trim() : '';
    if (!name) return { error: 'A failure mode needs a name.' };
    if (mode.triage != null && !TRIAGE.includes(mode.triage)) return { error: `triage must be ${TRIAGE.join(', ')} or absent` };
    const base = text == null || !String(text).trim() ? 'modes:\n' : String(text).replace(/\r\n/g, '\n');
    let doc;
    try { doc = parseYaml(base); } catch (e) { return { error: 'factory/taxonomy.yaml does not parse. Fix it, then add the mode.' }; }
    if (!isPlainObject(doc) || (doc.modes != null && !Array.isArray(doc.modes))) return { error: 'factory/taxonomy.yaml must be a mapping with a modes list.' };
    const lines = base.split('\n'), at = lines.findIndex(l => /^modes:\s*(#.*)?$/.test(l));
    const later = at < 0 ? [] : lines.slice(at + 1).filter(l => /^\S/.test(l) && !/^(#|- |-$)/.test(l));
    if (at < 0 || later.length) return { error: 'The modes list is not the last block of factory/taxonomy.yaml, so it cannot be added to safely. Edit the file instead.' };
    const item = lines.slice(at + 1).map(l => /^(\s*)- /.exec(l)).find(Boolean), ind = item ? item[1] : '  ';
    const n = Math.max(0, ...(doc.modes || []).map(m => { const x = /^FM-(\d+)$/.exec(isPlainObject(m) ? String(m.id) : ''); return x ? Number(x[1]) : 0; })) + 1;
    const id = `FM-${String(n).padStart(2, '0')}`;
    const body = [`${ind}- id: ${id}`, `${ind}  name: ${JSON.stringify(name)}`];
    if (mode.triage) body.push(`${ind}  triage: ${mode.triage}`);
    if (mode.description && String(mode.description).trim()) body.push(`${ind}  description: ${JSON.stringify(String(mode.description).trim())}`);
    const out = (base.endsWith('\n') ? base : base + '\n') + body.join('\n') + '\n';
    let back;
    try { back = parseYaml(out); } catch (e) { back = null; }
    const added = back && Array.isArray(back.modes) ? back.modes[back.modes.length - 1] : null;
    if (!isPlainObject(added) || added.id !== id || added.name !== name) return { error: 'The mode could not be added to factory/taxonomy.yaml safely. Edit the file instead.' };
    return { text: out, id };
  }

  function failureModes(events, { taxonomy = null, escapes = [] } = {}) {
    const { modes: listed, problems } = taxonomyModes(taxonomy), modes = listed.map(m => ({ ...m, escapes: [] }));
    const latest = new Map();
    for (const e of events) if (e.kind === 'failure_mode_classified') latest.set(`${e.registry}/${e.escape}`, e);
    const byEscape = new Map(), unknown = [], byId = new Map(modes.map(m => [m.id, m]));
    for (const [key, e] of latest) {
      if (e.failure_mode == null) continue;
      byEscape.set(key, e.failure_mode);
      const m = byId.get(e.failure_mode);
      if (m) { m.count++; m.escapes.push({ registry: e.registry, escape: e.escape }); } else unknown.push({ registry: e.registry, escape: e.escape, failure_mode: e.failure_mode });
    }
    const unclassified = escapes.filter(x => !byEscape.has(`${x.registry}/${x.id}`)).map(x => ({ registry: x.registry, escape: x.id }));
    return { modes, byEscape, unknown, unclassified, problems };
  }

  // Error analysis: failed reviews (the latest per observation) grouped by their failure_mode against the taxonomy.
  // `examples` are the reviews, newest first; a fail with no mode is `unassigned`, one the taxonomy lacks `unknown`.
  function reviewModes(events, { taxonomy = null } = {}) {
    const { modes: listed, problems } = taxonomyModes(taxonomy), modes = listed.map(m => ({ ...m, examples: [] }));
    const byId = new Map(modes.map(m => [m.id, m])), unassigned = [], unknown = [];
    const fails = [...traceReviews(events).values()].filter(r => r.verdict === 'fail').sort((a, b) => (b._ts || 0) - (a._ts || 0));
    for (const r of fails) {
      if (r.failure_mode == null || r.failure_mode === '') { unassigned.push(r); continue; }
      const m = byId.get(r.failure_mode);
      if (m) { m.count++; m.examples.push(r); } else unknown.push(r);
    }
    return { modes, unassigned, unknown, problems };
  }

  // Error analysis: an agent's proposed grouping of failed reviews ({mode} or {new_mode: {name, description?, triage?}},
  // observations, why), checked before a person is asked. Each observation must be a latest failed review and appear
  // once; a mode must be in the taxonomy, and a new mode's name must not repeat one. `changes` counts the reviews whose
  // mode would change. The person's verdict and note are never part of it.
  function reviewGrouping(events, taxonomy, groups) {
    if (!Array.isArray(groups) || !groups.length) return { error: 'groups must be a non-empty list.' };
    const { modes } = taxonomyModes(taxonomy), latest = traceReviews(events), seen = new Set();
    const names = new Set(modes.map(m => m.name.trim().toLowerCase())), out = [];
    let changes = 0;
    for (const [i, g] of groups.entries()) {
      const at = `group ${i + 1}`;
      if (!isPlainObject(g)) return { error: `${at} must be an object.` };
      if ((g.mode != null) === (g.new_mode != null)) return { error: `${at}: give either mode (an id from the taxonomy) or new_mode, not both or neither.` };
      if (!g.why || !String(g.why).trim()) return { error: `${at}: say why these notes belong together.` };
      let newMode = null;
      if (g.mode != null && !modes.some(m => m.id === g.mode)) return { error: `${at}: ${g.mode} is not in factory/taxonomy.yaml (${modes.map(m => m.id).join(', ') || 'no modes yet'}). Use new_mode for a new one.` };
      if (g.new_mode != null) {
        const name = isPlainObject(g.new_mode) && g.new_mode.name != null ? String(g.new_mode.name).trim() : '';
        if (!name) return { error: `${at}: new_mode needs a name.` };
        if (names.has(name.toLowerCase())) return { error: `${at}: a mode named "${name}" already exists. Use its id as mode.` };
        if (g.new_mode.triage != null && !TRIAGE.includes(g.new_mode.triage)) return { error: `${at}: triage must be ${TRIAGE.join(', ')} or absent.` };
        names.add(name.toLowerCase());
        newMode = { name, ...(g.new_mode.description ? { description: String(g.new_mode.description) } : {}), ...(g.new_mode.triage ? { triage: g.new_mode.triage } : {}) };
      }
      if (!Array.isArray(g.observations) || !g.observations.length) return { error: `${at}: list the observations it groups.` };
      const reviews = [];
      for (const o of g.observations) {
        const r = latest.get(o);
        if (!r || r.verdict !== 'fail') return { error: `${at}: ${o} is not a failed review. Use the observations list_reviews gives.` };
        if (seen.has(o)) return { error: `${o} is in more than one group.` };
        seen.add(o); reviews.push(r);
        if (newMode || (r.failure_mode == null ? null : r.failure_mode) !== g.mode) changes++;
      }
      out.push({ mode: newMode ? null : g.mode, newMode: newMode || undefined, why: String(g.why).trim(), reviews });
    }
    return { groups: out, changes };
  }

  // Error analysis to evals: examples for a judge of one failure mode. Positives are the latest failed reviews in the
  // mode, negatives the latest reviewed passes; fails in other modes are neither. `jsonl` is one line per example.
  function judgeExamples(events, mode) {
    const all = [...traceReviews(events).values()];
    const positives = all.filter(r => r.verdict === 'fail' && r.failure_mode === mode), negatives = all.filter(r => r.verdict === 'pass');
    const line = (r, label) => JSON.stringify({ trace_id: r.trace_id, observation: r.observation, ...(r.task != null ? { task: r.task } : {}), ...(r.run_id != null ? { run_id: r.run_id } : {}), ...(r.attempt != null ? { attempt: r.attempt } : {}), label, ...(label === 'fail' ? { failure_mode: mode } : {}), note: r.note || '' });
    return { positives, negatives, jsonl: [...positives.map(r => line(r, 'fail')), ...negatives.map(r => line(r, 'pass'))].map(l => l + '\n').join('') };
  }

  // Error analysis to evals: an agent's draft of factory/tasks/<id>.yaml from failed reviews in one mode, as `minted`.
  // `input` names the handover and commit of the first attempt's run when the ledger knows them; nothing is guessed.
  function evalTaskDraft(events, taxonomy, a, { taken = [] } = {}) {
    const { modes } = taxonomyModes(taxonomy), latest = traceReviews(events);
    if (!a || !modes.some(m => m.id === a.failure_mode)) return { error: `failure_mode must be a mode of factory/taxonomy.yaml (${modes.map(m => m.id).join(', ') || 'none yet'}).` };
    const title = a.title != null ? String(a.title).trim() : '';
    if (!title) return { error: 'The task needs a title saying what the pipeline must get right.' };
    if (!Array.isArray(a.observations) || !a.observations.length) return { error: 'List the failed reviews (observations) the task comes from.' };
    const reviews = [];
    for (const o of a.observations) {
      const r = latest.get(o);
      if (!r || r.verdict !== 'fail' || r.failure_mode !== a.failure_mode) return { error: `${o} is not a failed review in ${a.failure_mode}. Use list_reviews.` };
      if (!reviews.includes(r)) reviews.push(r);
    }
    const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'task';
    let id = base; for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
    const run = reviews[0].run_id, started = run != null ? events.find(e => e.kind === 'run_started' && e.run === run) : null;
    const frozen = started ? events.filter(e => e.kind === 'handover' && e.handover === started.handover).pop() : null;
    const q = JSON.stringify, lines = [`id: ${id}`, `title: ${q(title)}`, 'status: minted', 'source:', `  failure_mode: ${a.failure_mode}`, '  traces:',
      ...reviews.map(r => `    - { trace_id: ${q(String(r.trace_id))}, observation: ${q(String(r.observation))}${r.task != null ? `, task: ${q(String(r.task))}` : ''} }`)];
    if (a.why && String(a.why).trim()) lines.push(`  why: ${q(String(a.why).trim())}`);
    if (started) lines.push('input:', `  handover: ${q(String(started.handover))}`, ...(frozen && frozen.commit ? [`  commit: ${q(String(frozen.commit))}`] : []));
    lines.push('drafted_by: ide-agent');
    return { id, path: `factory/tasks/${id}.yaml`, text: lines.join('\n') + '\n', reviews, input: started ? { handover: started.handover, commit: frozen ? frozen.commit || null : null } : null };
  }

  // Error analysis: the latest trace_review per observation.
  function traceReviews(events) {
    const m = new Map();
    for (const e of events) if (e.kind === 'trace_review') m.set(e.observation, e);
    return m;
  }

  // The review queue over task attempts `spans` ({id, outcome, start, ...}): failed and not reviewed first, then the
  // rest not reviewed, then reviewed; newest first in each. Counts only cover attempts in `spans`.
  function reviewQueue(spans, events) {
    const reviews = traceReviews(events);
    const rows = spans.map(s => ({ ...s, review: reviews.get(s.id) || null }));
    const rank = r => (r.review ? 2 : r.outcome === 'failed' ? 0 : 1);
    rows.sort((a, b) => rank(a) - rank(b) || b.start - a.start);
    const reviewed = rows.filter(r => r.review);
    return { rows, counts: {
      total: rows.length, failed: rows.filter(r => r.outcome === 'failed').length, reviewed: reviewed.length,
      pass: reviewed.filter(r => r.review.verdict === 'pass').length, fail: reviewed.filter(r => r.review.verdict === 'fail').length,
      toReview: rows.length - reviewed.length,
    } };
  }

  // Factory evals: eval tasks. `tasks` are factory/tasks/*.yaml rows `{id, title?, status?, source?, hash, ...}` with `hash` the
  // hash of the file text (computed by the caller). The file says minted, checked or retired; `bound` is never in a file:
  // it is the latest factory_task_bound for the id with the file's current hash. A bind whose hash no longer matches
  // makes the task `changed`. Binding needs source.failure_mode (the task must come from an observed failure); a mode the
  // taxonomy does not list is only a warning. `runs` (suiteRuns output) name the suite runs that used each task and
  // those that pinned a hash other than the bound one.
  const TASK_FILE_STATUS = ['minted', 'checked', 'retired'];
  const taskBindProblem = t => (t && t.source && typeof t.source === 'object' && t.source.failure_mode && String(t.source.failure_mode).trim() ? null
    : 'A task is bound only when it names the failure mode it came from (source.failure_mode), so it is a regression test of something that happened.');
  function factoryTasks(events, { tasks = [], taxonomy = null, runs = [] } = {}) {
    const problems = [], seen = new Set(), out = [];
    const boundBy = new Map();
    for (const e of events) if (e.kind === 'factory_task_bound') boundBy.set(e.task_id, e.hash);
    const known = taxonomy && Array.isArray(taxonomy.modes) ? new Set(taxonomy.modes.filter(isPlainObject).map(m => String(m.id))) : null;
    tasks.forEach((t, i) => {
      const id = t && t.id != null && String(t.id).trim() ? String(t.id).trim() : null;
      if (!id) return problems.push(`task ${i + 1} needs an id`);
      if (seen.has(id)) return problems.push(`${id} is listed more than once`);
      seen.add(id);
      const own = [], warnings = [], raw = t.status == null ? 'minted' : String(t.status).trim().toLowerCase();
      if (raw === 'bound') own.push('status bound is recorded when a human binds a task; write it as minted or checked');
      else if (!TASK_FILE_STATUS.includes(raw)) own.push(`status must be ${TASK_FILE_STATUS.slice(0, -1).join(', ')} or ${TASK_FILE_STATUS[TASK_FILE_STATUS.length - 1]}`);
      const boundHash = boundBy.has(id) ? boundBy.get(id) : null;
      const status = own.length ? 'invalid' : raw === 'retired' ? 'retired' : boundHash === null ? raw : boundHash === t.hash ? 'bound' : 'changed';
      const bindProblem = taskBindProblem(t);
      const fmId = t.source && t.source.failure_mode ? String(t.source.failure_mode).trim() : '';
      if (fmId && known && !known.has(fmId)) warnings.push(`${id} names failure mode ${fmId}, which ${'factory/taxonomy.yaml'} does not list`);
      const used = runs.filter(r => r.tasks.some(x => x.task_id === id));
      out.push({ id, title: t.title ? String(t.title) : '', status, hash: t.hash, boundHash, failureMode: fmId || null, problems: own, warnings,
        bindable: !own.length && status !== 'retired' && status !== 'bound' && !bindProblem, bindProblem,
        runs: used.map(r => r.suite_run_id),
        offDefinition: boundHash === null ? [] : used.filter(r => r.tasks.some(x => x.task_id === id && x.hash !== boundHash)).map(r => r.suite_run_id) });
    });
    return { tasks: out, problems };
  }

  // Judge calibration (display only): `labels` are the parsed factory/labels/<dimension>.yaml files, each
  // {dimension, rounds: [{date, judge_version, precision, recall, n}]}. The latest valid round by date decides:
  // below when precision or recall is under `threshold`, else stale when older than `maxAgeDays`, else ok.
  // Invalid rounds are reported and skipped. Nothing here reaches the gate.
  const DAY = 86400000;
  const isoDate = d => (d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : typeof d === 'string' ? d : null);
  const roundProblem = r => {
    if (!isPlainObject(r)) return 'must be a mapping';
    const date = isoDate(r.date);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) return 'date must be YYYY-MM-DD';
    if (typeof r.judge_version !== 'string' && typeof r.judge_version !== 'number') return 'judge_version is required';
    if (!String(r.judge_version).trim()) return 'judge_version is required';
    for (const m of ['precision', 'recall']) if (typeof r[m] !== 'number' || !(r[m] >= 0 && r[m] <= 1)) return `${m} must be a number from 0 to 1`;
    if (!Number.isInteger(r.n) || r.n < 1) return 'n must be a whole number of at least 1';
    return null;
  };
  function calibrationStatus(labels, { now = Date.now(), threshold = 0.8, maxAgeDays = 30 } = {}) {
    const problems = [], seen = new Set(), dimensions = [];
    for (const f of labels) {
      if (!isPlainObject(f)) { problems.push('a file in factory/labels is not a mapping'); continue; }
      const dimension = String(f.dimension);
      if (seen.has(dimension)) { problems.push(`${dimension} is listed more than once`); continue; }
      seen.add(dimension);
      const valid = [];
      if (!Array.isArray(f.rounds)) problems.push(`${dimension}: rounds must be a list`);
      else f.rounds.forEach((r, i) => {
        const bad = roundProblem(r);
        if (bad) problems.push(`${dimension} round ${i + 1}: ${bad}`);
        else valid.push({ ...r, date: isoDate(r.date), judge_version: String(r.judge_version) });
      });
      valid.sort((a, b) => a.date.localeCompare(b.date));
      const latest = valid.length ? valid[valid.length - 1] : null;
      if (!latest) { dimensions.push({ dimension, status: 'uncalibrated', latest: null, ageDays: null, short: [], rounds: [] }); continue; }
      const ageDays = Math.floor((now - Date.parse(latest.date)) / DAY);
      const short = ['precision', 'recall'].filter(m => latest[m] < threshold);
      dimensions.push({ dimension, latest, ageDays, short, rounds: valid, status: short.length ? 'below' : ageDays > maxAgeDays ? 'stale' : 'ok' });
    }
    dimensions.sort((a, b) => a.dimension.localeCompare(b.dimension));
    return { dimensions, problems, threshold, maxAgeDays };
  }

  // Telemetry runs: Designc's own agents are tagged with these systems (ROLES[*].system in agent.js);
  // every other run, tagged or not, comes from a coding agent or pipeline and is what the cost views show.
  const OWN_SYSTEMS = ['S1', 'S4'];
  const pipelineRuns = runs => runs.filter(r => !OWN_SYSTEMS.includes(r.system));
  const runTotals = runs => ({
    runs: runs.length,
    tokens: runs.reduce((a, r) => a + r.tokens, 0),
    cost: runs.reduce((a, r) => a + r.cost, 0),
    failed: runs.filter(r => ['failed', 'error'].includes(r.outcome)).length,
  });

  const unapprovedChanges = events => events.filter(e => e.kind === 'unapproved_change');

  return {
    ORIGINS, escapeMetrics, PIPELINE_KINDS, PIPELINE_STREAM, OWN_SYSTEMS, pipelineRuns, runTotals, agentActivity, evalTrends, suiteRuns, suiteCompare, failureModes, traceReviews, reviewQueue, reviewModes, taxonomyModes, addTaxonomyMode, reviewGrouping, judgeExamples, evalTaskDraft, factoryTasks, taskBindProblem, calibrationStatus, elementHistory, handoverActuals, liveRuns, usageByTier, unapprovedChanges, SCHEMA_VERSION, KINDS, CAUGHT_BY, validate, gateUnchanged, verify, upcast, FINAL_KIND_FIELDS, ENVELOPE_OPTIONAL, RULE_IDS: Object.keys(RULES), parse, order, escapeId, derive, ndOptions, parkedOn, resumeCheck, totalTokens,
    HARNESS_ENVELOPE_VERSION, HARNESS_KINDS, HARNESS_STREAM, HARNESS_FIELDS, HARNESS_NULLABLE,
    validateHarness, resolvedEventIds,
  };
})();
if (typeof module !== 'undefined') module.exports = Ledger;
