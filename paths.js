// designc desktop: path confinement and child-process environment. Main process, no Electron, no dependencies.
const fs = require('fs');
const path = require('path');

// The real path of `abs`, resolving symlinks in the deepest part that exists and appending the rest.
function realish(abs) {
  const rest = [];
  let cur = abs;
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch { /* not there yet */ }
    const up = path.dirname(cur);
    if (up === cur) return abs;
    rest.push(path.basename(cur)); cur = up;
  }
}

// `rel` resolved against `root`, or a throw when it leaves the folder lexically or through a symlink.
function confine(root, rel) {
  const base = path.resolve(root), abs = path.resolve(base, rel || '.');
  const within = (r, a) => a === r || a.startsWith(r + path.sep);
  if (!within(base, abs) || !within(realish(base), realish(abs))) throw new Error('Path is outside the open folder');
  return abs;
}

// Secrets stay out of processes that run repository code or third-party agents. Names that look like
// credentials are dropped unless the settings list them to inherit.
const SECRETISH = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
function childEnv(env, inherit = []) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (inherit.includes(k) || !SECRETISH.test(k)) out[k] = v;
  return out;
}

// VS Code workspace trust: a folder is trusted if it, or any ancestor, was trusted.
// `all` is the user-level trust-everything switch (state.json `trustAllFolders`). It is never read from
// designc.json: a repository must not be able to switch off the question about itself.
function isTrusted(trusted, root, all = false) {
  if (all === true) return true;
  const base = path.resolve(root), real = realish(base);
  return trusted.some(t => { const a = path.resolve(t); return [base, real].some(p => p === a || p.startsWith(a + path.sep)); });
}

// What the trust dialog may offer: this folder, the repository holding it, and its parent. Never the
// filesystem root or the home folder, and no duplicates.
function trustChoices(root, repoRoot, home) {
  const out = [{ kind: 'folder', path: root }];
  const add = (kind, p) => {
    if (!p || out.some(o => o.path === p) || p === path.parse(p).root || p === home) return;
    out.push({ kind, path: p });
  };
  add('repo', repoRoot); add('parent', path.dirname(root));
  return out;
}

// A sibling registry listed in designc.json `registries` ({key: path relative to the open folder}), read-only.
// Only an own string entry counts, so the renderer cannot name `__proto__` or `toString`; the folder must exist.
// Paths inside it then go through confine(dir, rel) like the open folder's.
function registryDir(root, registries, key) {
  const map = registries && typeof registries === 'object' ? registries : {};
  const v = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Registry ${key} is not listed in designc.json registries`);
  const dir = path.resolve(root, v.trim());
  let st = null; try { st = fs.statSync(dir); } catch { /* missing */ }
  if (!st || !st.isDirectory()) throw new Error(`Registry ${key} (${v}) does not exist. Check the path in designc.json registries`);
  return dir;
}

module.exports = { confine, childEnv, isTrusted, trustChoices, registryDir };
