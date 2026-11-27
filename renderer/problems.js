/* designc desktop: the Problems view's rows. Pure, no I/O.
   Dual-load like renderer/work.js: <script src="problems.js"> in the renderer (before app.js), require('./renderer/problems.js')
   from the LSP and tests. One place that turns a check's results into [[path, rows[]]], so the app's Problems panel and the
   language server show the same findings. The code-quality groups stay in app.js (they need the code map's facts). */
const Problems = (() => {
  const CR = typeof Core !== 'undefined' ? Core : require('./core.js');

  // Same row fields and group order as app.js renderPanel: model rows (by file), then path rows (yaml, ledger, work, work warnings, duplicate proposal ids).
  function rows({ model, diags = [], cfgModel, decisions = [], yamlErrors = [], ledgerErrors = [], workErrors = [], workWarnings = [], featureProblems = [], proposals = [] }) {
    const live = diags.filter(d => !d.suppressed);
    const groups = [];
    const mrows = [...model.errors.map(e => ({ sev: 'error', msg: e.msg, code: 'parse', line: e.line, file: CR.locFile(e, cfgModel) })),
      ...live.map(f => ({ sev: f.sev, msg: `${f.loc.label}: ${f.msg}`, code: f.code, line: f.loc.line, file: CR.locFile(f.loc, cfgModel), fi: diags.indexOf(f), unknown: f.unknown, dec: CR.decisionsFor(f, decisions)[0], f }))];
    const mby = new Map();
    for (const r of mrows) { if (!mby.has(r.file)) mby.set(r.file, []); mby.get(r.file).push(r); }
    groups.push(...mby);
    const byPath = new Map();
    for (const e of [...yamlErrors, ...ledgerErrors, ...workErrors]) { if (!byPath.has(e.path)) byPath.set(e.path, []); byPath.get(e.path).push({ sev: 'error', msg: e.msg, code: 'yaml', line: e.line }); }
    for (const w of workWarnings) { if (!byPath.has(w.path)) byPath.set(w.path, []); byPath.get(w.path).push({ sev: 'warning', msg: w.msg, code: 'work', line: 1 }); }
    // features/ (FM001 to FM004, or yaml): rows keep their own code. Never gate clauses; the LSP passes none.
    for (const p of featureProblems) { if (!byPath.has(p.path)) byPath.set(p.path, []); byPath.get(p.path).push({ sev: 'error', msg: p.msg, code: p.code, line: p.line || 1 }); }
    const seenP = new Set();
    for (const x of proposals) { if (seenP.has(x.id) && x._path) { if (!byPath.has(x._path)) byPath.set(x._path, []); byPath.get(x._path).push({ sev: 'error', msg: `duplicate id ${x.id}`, code: 'id', line: 1 }); } seenP.add(x.id); }
    groups.push(...byPath);
    return groups;
  }

  // The ⊗ and ⚠ counts over groups.
  function counts(groups) {
    let errors = 0, warnings = 0;
    for (const [, rs] of groups) for (const r of rs) { if (r.sev === 'error') errors++; else if (r.sev === 'warning') warnings++; }
    return { errors, warnings };
  }

  return { rows, counts };
})();
if (typeof module !== 'undefined') module.exports = Problems;
