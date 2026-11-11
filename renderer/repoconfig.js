/* designc desktop: split-repo settings edits. Pure, no I/O, no dependencies.
   Dual-load like renderer/policy.js. Each function takes a designc.json object and returns {cfg} (a new object) or {error},
   or {needsName:'codebase'} when the caller must first say what to call the existing `codebase`. */
const RepoConfig = (() => {
  const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
  const norm = p => String(p).replace(/\/+$/, '');

  function add(cfg, name, path, { codebaseName = null } = {}) {
    name = String(name == null ? '' : name).trim();
    if (!NAME.test(name)) return { error: 'A repo name starts with a letter and uses only letters, digits, - and _ (it begins every file path in the code map).' };
    const repos = cfg.repos && typeof cfg.repos === 'object' && !Array.isArray(cfg.repos) ? { ...cfg.repos } : {};
    const out = { ...cfg };
    if (!Object.keys(repos).length && cfg.codebase) {
      if (!codebaseName) return { needsName: 'codebase' };
      if (!NAME.test(codebaseName)) return { error: 'The existing codebase needs a valid repo name too.' };
      if (codebaseName === name) return { error: 'Give the new repo a different name from the existing codebase.' };
      repos[codebaseName] = cfg.codebase;
      delete out.codebase;
    }
    if (Object.prototype.hasOwnProperty.call(repos, name)) return { error: `${name} is already a repo.` };
    const same = Object.keys(repos).find(k => norm(repos[k]) === norm(path));
    if (same) return { error: `That folder is already added as ${same}.` };
    repos[name] = path;
    out.repos = repos;
    return { cfg: out };
  }

  function remove(cfg, name) {
    if (!cfg.repos || !Object.prototype.hasOwnProperty.call(cfg.repos, name)) return { error: `${name} is not a repo.` };
    const repos = { ...cfg.repos }; delete repos[name];
    const out = { ...cfg };
    if (Object.keys(repos).length) out.repos = repos; else delete out.repos;
    return { cfg: out };
  }

  return { add, remove };
})();
if (typeof module !== 'undefined') module.exports = RepoConfig;
