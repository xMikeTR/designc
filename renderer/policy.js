/* designc desktop: agent policy. Pure, no I/O, no dependencies.
   Dual-load like renderer/ledger.js: <script src="policy.js"> in the renderer, require('./renderer/policy.js')
   from tests. agent.js owns roles and tools; the decisions about what an agent may do live here. */
const Policy = (() => {
  // Folders each role may write through ACP fs/write_text_file.
  const WRITE_PATHS = { architect: [/^model\//, /^decisions\//], grill: [/^decisions\//], analyst: [/^proposals\//] };

  // Written only by a human binding a decision (bindDecision), never by an agent.
  const PROMOTION_FIELDS = ['promoted_against', 'promoted_by', 'promoted_at'];

  // Evidence and agreement are what make a business decision a business decision; only a human supplies them.
  const HUMAN_FIELDS = ['agreed_by', 'evidence'];

  // Set when a human marks an assumption reviewed (reviewAssumption); an agent may draft the assumption, never its review.
  const REVIEW_FIELDS = ['reviewed_by', 'reviewed_at'];

  // Tools that change the registry. Settings can deny them or leave them out, never make them silent.
  const WRITE_TOOLS = ['propose_model_edit', 'mint_decision', 'mint_proposal'];

  // Fail closed: a tool is usable only if the role lists it, and deny always wins.
  function verdict(cfg, tool) {
    if (cfg.deny.includes(tool)) return 'deny';
    if (cfg.ask.includes(tool)) return 'ask';
    if (cfg.allow.includes(tool)) return WRITE_TOOLS.includes(tool) ? 'ask' : 'allow';
    return 'deny';
  }

  // May this role write this registry file with this content? `rel` is the path relative to the
  // registry, or null when the path is outside it. `parseYaml` is injected (js-yaml's load).
  function writeVerdict(role, rel, content, parseYaml) {
    const no = error => ({ ok: false, error });
    if (!rel) return no('designc only lets agents write inside the registry. The codebase is read-only here; code changes go through the coding pipeline.');
    if (!(WRITE_PATHS[role] || []).some(re => re.test(rel))) return no(`The ${role} role may not write ${rel}.`);
    const dir = /^(decisions|proposals)\//.exec(rel);
    if (dir) {
      if (!/\.yaml$/.test(rel)) return no(`Agents may only write .yaml files in ${dir[1]}/.`);
      let doc = null;
      try { doc = parseYaml(content); } catch { /* reported below */ }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return no(`${rel} is not valid YAML with top-level fields, so designc cannot check it. Fix the file and write it again.`);
      const status = String(doc.status == null ? '' : doc.status).trim().toLowerCase();
      if (dir[1] === 'decisions' && (status === 'bound' || status === 'superseded')) return no('Binding a decision is a human action; write it as minted.');
      if (dir[1] === 'decisions') {
        const field = PROMOTION_FIELDS.find(f => Object.prototype.hasOwnProperty.call(doc, f));
        if (field) return no(`${field} is recorded when a human binds a decision; leave it out and write the decision as minted.`);
        const human = HUMAN_FIELDS.find(f => Object.prototype.hasOwnProperty.call(doc, f));
        if (human) return no(`${human} is added by a human, not an agent; leave it out.`);
        const reviewed = Array.isArray(doc.assumptions) && doc.assumptions.some(a => a && typeof a === 'object' && REVIEW_FIELDS.some(f => Object.prototype.hasOwnProperty.call(a, f)));
        if (reviewed) return no('An assumption is marked reviewed by a human, not an agent; leave reviewed_by and reviewed_at out.');
      }
    }
    return { ok: true };
  }

  // Which of the registry paths that changed on disk during an agent turn did designc not write or
  // approve? `approved` maps a path to the time its write was approved; `ownAppends` maps a ledger
  // file to the time the app last appended to it. An approval never covers a ledger file: only the
  // app's own append does.
  const WINDOW_MS = 8000;
  function unapprovedChanges(paths, { approved, ownAppends, now }) {
    const recent = t => t != null && now - t < WINDOW_MS;
    return paths.filter(p => {
      if (!/\.[a-z0-9]+$/i.test(p) || /^(asbuilt|telemetry)\//.test(p)) return false;
      return !recent((/^ledger\//.test(p) ? ownAppends : approved).get(p));
    });
  }

  return { WRITE_PATHS, WRITE_TOOLS, verdict, writeVerdict, unapprovedChanges };
})();
if (typeof module !== 'undefined') module.exports = Policy;
