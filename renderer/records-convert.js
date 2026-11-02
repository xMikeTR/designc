/* Records converter (intelligence plane phase 2), dry run only. Pure and dual-loaded (after records.js, policy.js
   and core.js): scripts/records-convert.js runs it on a folder, and the Decisions section's Check records button shows
   the same report in Output. It says what each decision file would become in the record envelope and flags what it
   cannot decide. It never guesses and never writes.

   Flags: no_id, unknown_status, ambiguous_name (an element name with no exact match, or several by normalised name),
   unknown_element, unknown_requirement, unknown_scope, supersede_without_successor, supersedes_unknown,
   possibly_verdict (a ui: scoped statement that describes existing behaviour), check_is_prose, invalid. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./records.js'), require('./policy.js'));
  else root.RecordsConvert = factory(root.Records, root.Policy);
})(typeof self !== 'undefined' ? self : this, function (Records, Policy) {
  'use strict';
  const list = v => v == null ? [] : Array.isArray(v) ? v : [v];
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  // Wording that describes what the app already does rather than a choice: parity territory, a verdict on a UI node.
  const EXISTING = /\b(as (it is )?today|as (in|on) (the )?legacy|same as (the )?(legacy|old|current)|matches (the )?(legacy|old|current)|unchanged|keeps? (the )?(existing|current)|existing behaviou?r|currently|continues? to)\b/i;

  function readFile(rel, text, load) {
    if (/\.md$/i.test(rel)) {
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
      if (!m) return { error: 'no YAML front matter' };
      const doc = load(m[1]) || {};
      const body = m[2].trim();
      if (body && doc.rationale == null) doc.rationale = body;
      return { doc };
    }
    return { doc: load(text) };
  }

  // files: [{path, text}] (read with ctx.parseYaml) or [{path, doc}] (already read); ctx: {elements: [names], requirements: [ids], parseYaml}.
    function convert(files, ctx = {}) {
    const elements = list(ctx.elements);
    const reqs = new Set(list(ctx.requirements));
    const parsed = files.map(f => {
      try { const r = 'doc' in f ? { doc: Object.fromEntries(Object.entries(f.doc || {}).filter(([k]) => !k.startsWith('_'))) } : readFile(f.path, f.text, ctx.parseYaml); return { path: f.path, ...r }; } catch (e) { return { path: f.path, error: `does not parse: ${String(e.message).split('\n')[0]}` }; }
    });
    const ids = new Set(parsed.filter(p => p.doc && p.doc.id != null).map(p => String(p.doc.id)));
    const successors = new Set(parsed.flatMap(p => p.doc ? list(p.doc.supersedes).map(String) : []));
    return parsed.map(p => {
      const flags = [];
      const flag = (code, msg) => flags.push({ code, msg });
      if (p.error || !p.doc || typeof p.doc !== 'object' || Array.isArray(p.doc)) {
        flag('invalid', p.error || 'not a mapping');
        return { path: p.path, id: null, record: null, flags };
      }
      const d = p.doc;
      if (d.id == null || String(d.id).trim() === '') flag('no_id', 'no id; give it one (a Jira key if it has one, else a slug of the statement)');
      const raw = d.status == null ? 'minted' : String(d.status);
      const status = Records.status(raw);
      if (!Records.STATUSES.includes(status)) flag('unknown_status', `status ${raw} is not minted, checked, bound, superseded or retired`);
      const scope = [];
      for (const r of list(d.requirement)) {
        scope.push(`req:${r}`);
        if (!reqs.has(String(r))) flag('unknown_requirement', `requirement ${r} is not in requirements/`);
      }
      for (const b of list(d.binds)) {
        const name = String(b);
        if (elements.includes(name)) { scope.push(`el:${name}`); continue; }
        const near = elements.filter(e => norm(e) === norm(name));
        if (near.length === 1) flag('ambiguous_name', `binds ${name}; the model has ${near[0]}, which differs only in spelling`);
        else if (near.length > 1) flag('ambiguous_name', `binds ${name}, which could be any of ${near.join(', ')}`);
        else flag('unknown_element', `binds ${name}, which is not an element of the model`);
      }
      for (const s of list(d.scope)) {
        const str = String(s);
        if (str.includes(':') && !Records.parseRef(str)) flag('unknown_scope', `scope ${str} has an unknown prefix`);
        else scope.push(str);
      }
      if (status === 'superseded' && d.id != null && !successors.has(String(d.id))) flag('supersede_without_successor', 'superseded, but no record says it supersedes this one');
      for (const s of list(d.supersedes)) if (!ids.has(String(s))) flag('supersedes_unknown', `supersedes ${s}, which is not among the records`);
      if (scope.some(s => s.startsWith('ui:')) && EXISTING.test(String(d.statement || ''))) flag('possibly_verdict', 'scoped to a UI node and describes existing behaviour: possibly a matched verdict, not a decision');
      const checks = Records.checks(d);
      for (const c of checks) { const why = Policy.checkProblem(c.run); if (why) flag('check_is_prose', `check "${c.run}": ${why}`); }
      const record = {
        ...d,
        id: d.id == null ? null : String(d.id),
        status,
        scope: [...new Set(scope)],
        supersedes: list(d.supersedes).map(String),
        evidence: list(d.evidence).map(String),
        source: d.source == null ? p.path : String(d.source),
        checks,
        enforced_by: list(d.enforced_by).length ? list(d.enforced_by) : checks.filter(c => !/^TODO/.test(c.run)).map(c => c.id),
      };
      delete record.requirement; delete record.binds;
      if (d.id != null) for (const e of Records.validate('decision', record)) if (!/^status:/.test(e)) flag('invalid', e);
      return { path: p.path, id: record.id, record, flags };
    });
  }

  // One line per file and flag, for Output and the CLI.
  function describe(out) {
    const lines = [`${out.length} decision files; ${out.filter(r => r.flags.length).length} flagged. Dry run: nothing was written.`];
    for (const r of out) {
      lines.push(`${r.path}${r.id ? ` (${r.id})` : ''}: ${r.flags.length ? `${r.flags.length} to decide` : 'converts cleanly'}`);
      for (const f of r.flags) lines.push(`  ${f.code}: ${f.msg}`);
    }
    return lines.join('\n');
  }

  return { convert, describe, EXISTING };
});
