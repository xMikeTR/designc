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
  const CAUGHT_BY = ['S1-lint', 'S1-p', 'S1-grill', 'S2-runtime', 'S2-config'];

  const STREAM = {
    check: 'checks.jsonl',
    fitness: 'checks.jsonl',
    gate: 'checks.jsonl',
    task: 'pipeline.jsonl',
    needs_decision: 'pipeline.jsonl',
    needs_decision_resolved: 'designc.jsonl',
    asbuilt_edge: 'pipeline.jsonl',
    escape: 'designc.jsonl',
    escape_classified: 'designc.jsonl',
    false_positive: 'pipeline.jsonl',
    handover: 'designc.jsonl',
    decision_promoted: 'designc.jsonl',
    extraction: 'designc.jsonl',
    agent_turn: 'agents.jsonl',
    agent_tool: 'agents.jsonl',
    agent_permission: 'agents.jsonl',
    agent_approval: 'agents.jsonl',
    unapproved_change: 'agents.jsonl',
  };
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
    escape: {
      required: ['id', 'description'],
      optional: ['code', 'caught_by', 'source', 'traces'],
      enums: {},
      rules: ['caught_by_member'],
    },
    escape_classified: {
      required: ['escape', 'caught_by'],
      optional: [],
      enums: {},
      rules: ['caught_by_member'],
    },
    false_positive: {
      required: ['code'],
      optional: ['note'],
      enums: {},
    },
    task: {
      required: ['task', 'status'],
      optional: ['title', 'element', 'reruns', 'turns', 'tokens', 'tokens_in', 'tokens_out', 'cost', 'model', 'tier'],
      enums: { status: ['passed', 'failed', 'blocked', 'running'] },
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
      optional: ['commit', 'dirty'],
      enums: {},
      types: { commit: 'string|null', dirty: 'boolean' },
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
  };

  const isPlainObject = v => v != null && typeof v === 'object' && !Array.isArray(v);
  // Conditional rules named in a kind's `rules`; each returns an error (without the kind prefix) or null.
  // Mirrored by id in python/designc/ledger.py.
  const RULES = {
    fail_needs_evidence: ev => (ev.outcome === 'fail' && ev.exit_code === undefined && !ev.reason ? "exit_code: required when outcome is 'fail' (or give reason)" : null),
    caught_by_member: ev => ('caught_by' in ev && ev.caught_by !== undefined && ev.caught_by !== null && !CAUGHT_BY.includes(ev.caught_by) ? `caught_by: must be null or one of ${CAUGHT_BY.join('|')}` : null),
  };
  // Field types for kinds that declare `types` (table data, so python/designc/ledger_schema.json can carry it).
  const isType = (v, t) => t === 'null' ? v === null : t === 'array' ? Array.isArray(v) : typeof v === t;
  const TYPE_NAMES = { boolean: 'a boolean', string: 'a string', array: 'an array', 'string|null': 'a string or null' };
  const basename = p => String(p || '').split(/[\\/]/).pop();

  // Skip-unchanged recording: true when the latest gate event from the same source has the same model
  // revision, commit (absent equals null) and verdict. `events` is the ordered ledger (Ledger.order).
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
    const classify = new Map(), resolved = new Set();
    for (const e of events) {
      if (e.kind === 'escape_classified') classify.set(e.escape, e.caught_by);
      if (e.kind === 'needs_decision_resolved') resolved.add(e.id);
    }
    return events.filter(e => !['escape_classified', 'needs_decision_resolved'].includes(e.kind)).map(e => {
      if (e.kind === 'escape' && classify.has(e.id)) return { ...e, caught_by: classify.get(e.id) };
      if (e.kind === 'needs_decision' && resolved.has(e.id)) return { ...e, status: 'resolved' };
      return e;
    });
  }

  function totalTokens(ev) {
    if (typeof ev.tokens === 'number') return ev.tokens;
    if (typeof ev.tokens_in === 'number' || typeof ev.tokens_out === 'number') return (ev.tokens_in || 0) + (ev.tokens_out || 0);
    return 0;
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

  const unapprovedChanges = events => events.filter(e => e.kind === 'unapproved_change');

  return {
    agentActivity, unapprovedChanges, SCHEMA_VERSION, KINDS, CAUGHT_BY, validate, gateUnchanged, upcast, FINAL_KIND_FIELDS, ENVELOPE_OPTIONAL, RULE_IDS: Object.keys(RULES), parse, order, escapeId, derive, totalTokens,
    HARNESS_ENVELOPE_VERSION, HARNESS_KINDS, HARNESS_STREAM, HARNESS_FIELDS, HARNESS_NULLABLE,
    validateHarness, resolvedEventIds,
  };
})();
if (typeof module !== 'undefined') module.exports = Ledger;
