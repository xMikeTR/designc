/* designc desktop: dispatch a frozen handover to a coding agent. Pure, no I/O, no dependencies.
   Dual-load like renderer/look.js: <script src="dispatch.js"> in the renderer, require('./renderer/dispatch.js')
   from tests. `designc.json` `dispatch` names the person's own build commands (one `{label?, command, resume?}`, or named targets); `resume` restarts a parked run, with `{run}`; `command` fills its
   placeholders, each value quoted for the shell, and the app types the line into the Terminal without pressing Enter.
   designc never runs it: the person reads it and presses Enter. */
const Dispatch = (() => {
  const VARS = ['handover', 'repo', 'registry', 'base', 'run', 'legacy'];
  const LIST = VARS.map(v => `{${v}}`).join(', ');

  const posix = s => `'${s.replace(/'/g, "'\\''")}'`;
  const pwsh = s => `'${s.replace(/'/g, "''")}'`;

  // `{label?, command}` is one target; otherwise each key names a target `{label?, command, enabled?}`, in file order.
  function settings(d) {
    if (d === undefined || d === null) return null;
    if (typeof d !== 'object' || Array.isArray(d)) return { error: 'designc.json dispatch must be an object with a command, for example {"command": "my-build --handover {handover}"}, or named targets each with a command.' };
    const text = v => typeof v === 'string' && v.trim() ? v.trim() : null;
    if ('command' in d || 'label' in d) {
      if (!text(d.command)) return { error: 'designc.json dispatch needs a command.' };
      if ('resume' in d && !text(d.resume)) return { error: 'designc.json dispatch.resume must be a command, for example "my-build --handover {handover} --run-id {run}".' };
      const label = text(d.label) || 'Dispatch';
      return { label, targets: [{ key: 'default', label, command: d.command, resume: text(d.resume) && d.resume }] };
    }
    const keys = Object.keys(d);
    if (!keys.length) return { error: 'designc.json dispatch has no targets. Give it a command, or named targets each with a command.' };
    const targets = [];
    for (const key of keys) {
      const t = d[key];
      if (t && t.enabled === false) continue;
      if (!t || typeof t !== 'object' || Array.isArray(t) || !text(t.command)) return { error: `designc.json dispatch.${key} needs a command.` };
      if ('resume' in t && !text(t.resume)) return { error: `designc.json dispatch.${key}.resume must be a command, for example "my-build --handover {handover} --run-id {run}".` };
      targets.push({ key, label: text(t.label) || key, command: t.command, resume: text(t.resume) && t.resume });
    }
    if (!targets.length) return null;
    return { label: targets.length === 1 ? targets[0].label : 'Dispatch', targets };
  }

  function command(template, vars, platform) {
    if (typeof template !== 'string' || !template.trim()) return { error: 'designc.json dispatch needs a command.' };
    if (/[\r\n]/.test(template)) return { error: 'The dispatch command must be one line, so nothing runs before you press Enter.' };
    const unknown = [...template.matchAll(/\{([^{}\s]*)\}/g)].map(m => m[1]).filter(n => !VARS.includes(n));
    if (unknown.length) return { error: `The dispatch command uses {${unknown[0]}}, which designc does not fill. Use ${LIST}.` };
    const quote = platform === 'win32' ? pwsh : posix;
    let problem = null;
    const text = template.replace(/\{(handover|repo|registry|base|run|legacy)\}/g, (_, n) => {
      const v = vars && vars[n];
      if (v === null || v === undefined || v === '') {
        problem = problem || (n === 'repo' ? 'The dispatch command uses {repo}, but there is no repository: set codebase in designc.json, or repo on the work item.'
          : n === 'legacy' ? 'The dispatch command uses {legacy}, but there is no legacy reference: add one under references in designc.json.' : `There is no value for {${n}}.`);
        return '';
      }
      if (/[\r\n]/.test(String(v))) { problem = problem || `The value for {${n}} spans more than one line, so it cannot be typed as one command.`; return ''; }
      return quote(String(v));
    });
    return problem ? { error: problem } : text;
  }

  // `designc.json` `references`: read-only folders the build may read and never write, such as the legacy app a
  // migration is judged against. Each is `{kind: 'legacy', path, label?}` under a key that is a plain name. The
  // handover records the key and kind only; the path stays on this machine and reaches the build through {legacy}.
  const KINDS = ['legacy'];
  function references(d) {
    if (d === undefined || d === null) return null;
    if (typeof d !== 'object' || Array.isArray(d)) return { error: 'designc.json references must be an object, for example {"wpf": {"kind": "legacy", "path": "../legacy-wpf"}}.' };
    const refs = [];
    for (const key of Object.keys(d)) {
      const r = d[key];
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(key)) return { error: `designc.json references.${key}: a key is a plain name of letters, digits, dots, dashes and underscores.` };
      if (!r || typeof r !== 'object' || Array.isArray(r)) return { error: `designc.json references.${key} must be {"kind": "legacy", "path": "..."}.` };
      if (!KINDS.includes(r.kind)) return { error: `designc.json references.${key}.kind must be ${KINDS.join(' or ')}.` };
      const path = typeof r.path === 'string' ? r.path.trim() : '';
      if (!path) return { error: `designc.json references.${key} needs a path to the folder.` };
      if (/[\r\n]/.test(path)) return { error: `designc.json references.${key}.path must be on one line.` };
      const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim() : key;
      refs.push({ key, kind: r.kind, label, path });
    }
    return { refs };
  }

  // The path {legacy} stands for: the one legacy reference, `{error}` naming the keys when there are several, null when none.
  function legacy(refs) {
    const l = (refs || []).filter(r => r.kind === 'legacy');
    if (!l.length) return null;
    if (l.length > 1) return { error: `{legacy} is ambiguous: ${l.map(r => r.key).join(', ')} are all legacy references. Keep one, or give the others another kind.` };
    return { path: l[0].path };
  }

  // One line that runs a designc script, each value quoted for the shell, or `{error}` when a value is missing or spans lines.
  function toolLine(script, args, platform) {
    const quote = platform === 'win32' ? pwsh : posix;
    const parts = ['node', script, ...args];
    if (parts.some(p => p === null || p === undefined || p === '')) return { error: 'The command is missing a value.' };
    if (parts.some(p => /[\r\n]/.test(String(p)))) return { error: 'A value spans more than one line, so it cannot be typed as one command.' };
    return parts.map(p => (/^(node|--[a-z-]+)$/.test(String(p)) ? String(p) : quote(String(p)))).join(' ');
  }

  // The parity recorder's line (docs/parity-contract.md). It never carries --allow-writes or --allow-request: those stay
  // something a person adds by hand. A commit makes it evidence for Done, so it records to the ledger with its item.
  function parityRecord({ script, registry, scenario, side, baseUrl, commit, item }, platform) {
    if (side !== 'legacy' && side !== 'next') return { error: 'The side is legacy or next.' };
    if (commit && (side !== 'next' || !item)) return { error: 'Recording a result for Done needs the new app and a work item.' };
    const args = ['--registry', registry, '--scenario', scenario, '--side', side];
    if (baseUrl) args.push('--base-url', baseUrl);
    if (commit) args.push('--ledger', '--item', item, '--commit', commit);
    return toolLine(script, args, platform);
  }

  // Drafts scenarios from the legacy app's Playwright tests; the script never overwrites a scenario that exists.
  function parityImport({ script, registry, from }, platform) {
    return toolLine(script, ['--from', from, '--registry', registry, '--write'], platform);
  }

  return { VARS, settings, command, references, legacy, parityRecord, parityImport };
})();
if (typeof module !== 'undefined') module.exports = Dispatch;
