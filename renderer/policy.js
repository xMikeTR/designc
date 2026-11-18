/* designc desktop: agent policy. Pure, no I/O, no dependencies.
   Dual-load like renderer/ledger.js: <script src="policy.js"> in the renderer, require('./renderer/policy.js')
   from tests. agent.js owns roles and tools; the decisions about what an agent may do live here. */
const Policy = (() => {
  // Folders each role may write through ACP fs/write_text_file.
  const WRITE_PATHS = { architect: [/^model\//, /^decisions\//], grill: [/^decisions\//, /^acceptance\//], analyst: [/^proposals\//, /^factory\/tasks\//],
    // The UI stages. compose also drafts ui/legacy/ (D8, never bound). Nothing writes ui/pack/ (a person pins it), ui/previews/ (a render writes it) or ui/holdout/ (a person writes it).
    compose: [/^ui\/specs\/[a-z][a-z0-9-]*\.json$/, /^ui\/legacy\/[a-z][a-z0-9-]*\.json$/], catalogue: [/^ui\/(components|templates)\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/] };

  // Written only by a human binding a decision (bindDecision), never by an agent.
  const PROMOTION_FIELDS = ['promoted_against', 'promoted_by', 'promoted_at'];

  // Evidence and agreement are what make a business decision a business decision; only a human supplies them.
  const HUMAN_FIELDS = ['agreed_by', 'evidence'];

  // Set when a human marks an assumption reviewed (reviewAssumption); an agent may draft the assumption, never its review.
  const REVIEW_FIELDS = ['reviewed_by', 'reviewed_at'];

  // Tools that change the registry. Settings can deny them or leave them out, never make them silent.
  const WRITE_TOOLS = ['propose_model_edit', 'mint_decision', 'write_check', 'set_check', 'mint_acceptance', 'mint_proposal', 'map_requirement', 'mint_test_scenarios', 'propose_parity_cover', 'group_reviews', 'draft_eval_task', 'add_source', 'add_finding', 'answer_question', 'mint_ui_spec', 'mint_ui_component', 'mint_ui_template', 'request_preview', 'suggest_stage'];

  // Read deny, for every role, no settings override: the holdout sample is written by a person and never shown to a stage.
  const HOLDOUT_DENIED = 'ui/holdout/ is never shown to an agent stage; a person writes it.';
  function readVerdict(role, rel) {
    if (typeof rel !== 'string') return { ok: true };
    const norm = rel.replace(/\\/g, '/').split('/').reduce((acc, seg) => { if (seg === '..') acc.pop(); else if (seg && seg !== '.') acc.push(seg); return acc; }, []).join('/').toLowerCase();
    if (norm === 'ui/holdout' || norm.startsWith('ui/holdout/')) return { ok: false, error: HOLDOUT_DENIED };
    return { ok: true };
  }
  const isHidden = rel => !readVerdict(null, rel).ok;

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
    const dir = /^(decisions|proposals|factory\/tasks|acceptance)\//.exec(rel);
    if (dir) {
      if (!/\.yaml$/.test(rel)) return no(`Agents may only write .yaml files in ${dir[1]}/.`);
      let doc = null;
      try { doc = parseYaml(content); } catch { /* reported below */ }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return no(`${rel} is not valid YAML with top-level fields, so designc cannot check it. Fix the file and write it again.`);
      const status = String(doc.status == null ? '' : doc.status).trim().toLowerCase();
      if (dir[1] === 'factory/tasks') {
        if (status === 'bound') return no('Binding an eval task is a human action; write it as minted.');
        const field = ['bound_by', 'bound_at', 'hash'].find(f => Object.prototype.hasOwnProperty.call(doc, f));
        if (field) return no(`${field} is recorded when a human binds a task; leave it out.`);
      }
      if (dir[1] === 'acceptance' && Array.isArray(doc.cases) && doc.cases.some(c => c && typeof c === 'object' && Object.prototype.hasOwnProperty.call(c, 'holdout'))) return no('holdout is set by the person binding the criterion; leave it out.');
      if (dir[1] === 'decisions' && (status === 'bound' || status === 'superseded')) return no('Binding a decision is a human action; write it as minted.');
      if (dir[1] === 'decisions') {
        const field = PROMOTION_FIELDS.find(f => Object.prototype.hasOwnProperty.call(doc, f));
        if (field) return no(`${field} is recorded when a human binds a decision; leave it out and write the decision as minted.`);
        const human = HUMAN_FIELDS.find(f => Object.prototype.hasOwnProperty.call(doc, f));
        if (human) return no(`${human} is added by a human, not an agent; leave it out.`);
        const reviewed = Array.isArray(doc.assumptions) && doc.assumptions.some(a => a && typeof a === 'object' && REVIEW_FIELDS.some(f => Object.prototype.hasOwnProperty.call(a, f)));
        if (reviewed) return no('An assumption is marked reviewed by a human, not an agent; leave reviewed_by and reviewed_at out.');
        // A check is a command or {id, run}; the command is what is judged.
        const prose = (Array.isArray(doc.checks) ? doc.checks : []).map(c => c && typeof c === 'object' && !Array.isArray(c) ? (typeof c.run === 'string' ? c.run : '') : c).find(c => checkProblem(c));
        if (prose != null) return no(`Check "${prose}": ${checkProblem(prose)} A check is a shell command run in the registry folder that exits 0 when the decision holds. Write the command, or "TODO <what it must prove>" when none exists yet.`);
      }
    }
    if (/^ui\//.test(rel)) {
      let doc = null;
      try { doc = JSON.parse(content); } catch { /* reported below */ }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return no(`${rel} is not a JSON object, so designc cannot check it. Fix the file and write it again.`);
      if (doc.status !== 'minted') return no('A person binds UI files (Approve and bind, or Pin); an agent writes them as "status": "minted".');
    }
    return { ok: true };
  }

  // A decision check is a shell command run in the registry folder; its exit code is the verdict. Null when
  // it can run (a TODO placeholder is left alone), else why not. A leading label such as "Model:" or
  // "ACS policy:" marks a description of what to verify, which the shell would only fail to run.
  function checkProblem(cmd) {
    const c = String(cmd == null ? '' : cmd).trim();
    if (!c) return 'The check is empty.';
    if (/^TODO/.test(c)) return null;
    if (/^[A-Z][A-Za-z]*( [A-Za-z]+)?:\s/.test(c)) return 'It reads as a description, not a command.';
    return null;
  }

  // What to tell the person when a check that ran failed for a reason the shell, not the decision, caused. Null when
  // the exit code says nothing about the shell. Windows runs checks through cmd.exe, which cannot run a .sh script
  // and says a missing program with 9009; POSIX shells say it with 127.
  function checkFailHint(cmd, code, platform) {
    const first = String(cmd == null ? '' : cmd).trim().split(/\s+/)[0];
    if (platform === 'win32' && /\.sh$/i.test(first)) return `Windows runs checks through cmd.exe, which cannot run "${first}". Write the check as "bash ${first.replace(/^\.[\\/]/, '')}" (Git Bash or WSL on PATH), and keep the script's line endings LF.`;
    if (code === 127 || (platform === 'win32' && code === 9009)) return `The shell could not find the program "${first}". Check the name and that it is on PATH.`;
    return null;
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

  return { WRITE_PATHS, WRITE_TOOLS, HOLDOUT_DENIED, verdict, readVerdict, isHidden, writeVerdict, checkProblem, checkFailHint, unapprovedChanges };
})();
if (typeof module !== 'undefined') module.exports = Policy;
