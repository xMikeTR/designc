/* designc desktop: dispatch a frozen handover to a coding agent. Pure, no I/O, no dependencies.
   Dual-load like renderer/look.js: <script src="dispatch.js"> in the renderer, require('./renderer/dispatch.js')
   from tests. `designc.json` `dispatch` names the person's own build commands (one `{label?, command, resume?}`, or named targets); `resume` restarts a parked run, with `{run}`; `command` fills its
   placeholders, each value quoted for the shell, and the app types the line into the Terminal without pressing Enter.
   designc never runs it: the person reads it and presses Enter. */
const Dispatch = (() => {
  const VARS = ['handover', 'repo', 'registry', 'base', 'run'];
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
    const text = template.replace(/\{(handover|repo|registry|base|run)\}/g, (_, n) => {
      const v = vars && vars[n];
      if (v === null || v === undefined || v === '') {
        problem = problem || (n === 'repo' ? 'The dispatch command uses {repo}, but there is no repository: set codebase in designc.json, or repo on the work item.' : `There is no value for {${n}}.`);
        return '';
      }
      if (/[\r\n]/.test(String(v))) { problem = problem || `The value for {${n}} spans more than one line, so it cannot be typed as one command.`; return ''; }
      return quote(String(v));
    });
    return problem ? { error: problem } : text;
  }

  return { VARS, settings, command };
})();
if (typeof module !== 'undefined') module.exports = Dispatch;
