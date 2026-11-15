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

// Exported pages for requirement import: .html, .htm, .md and .markdown files directly in `dir` (no recursion).
// A symlink is skipped, as is a file over `maxBytes`; both are named in `skipped` so the review can say so.
const PAGE_EXT = /\.(html?|md|markdown)$/i;
function readPages(dir, { maxBytes = 2 * 1024 * 1024, maxFiles = 500 } = {}) {
  const pages = [], skipped = [];
  const names = fs.readdirSync(dir).filter(n => PAGE_EXT.test(n)).sort((a, b) => a.localeCompare(b));
  for (const name of names.slice(0, maxFiles)) {
    const abs = path.join(dir, name);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) { skipped.push({ name, reason: 'not a regular file' }); continue; }
    if (st.size > maxBytes) { skipped.push({ name, reason: `larger than ${Math.round(maxBytes / 1048576)} MB` }); continue; }
    pages.push({ name, text: fs.readFileSync(abs, 'utf8') });
  }
  if (names.length > maxFiles) skipped.push({ name: `${names.length - maxFiles} more files`, reason: `only the first ${maxFiles} are read` });
  return { pages, skipped };
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

// What Set up's Check command can say about a dispatch command without running it: is its program on PATH (or at the
// path it names), and does the folder after `--project` exist. Read-only (stat only); placeholders are left as written.
function words(cmd) {
  const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(cmd))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}
function commandCheck(cmd, { cwd, env = process.env, platform = process.platform, exists = f => fs.existsSync(f) } = {}) {
  const w = words(String(cmd || '').trim());
  if (!w.length) return { error: 'empty' };
  const prog = w[0], win = platform === 'win32', sep = win ? ';' : ':';
  const exts = win ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const join = (d, f) => (win ? path.win32 : path.posix).join(d, f);
  const hasPath = /[\\/]/.test(prog);
  const dirs = hasPath ? [cwd || '.'] : String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  const found = dirs.some(d => exts.some(x => exists(hasPath ? path.resolve(d, prog + x) : join(d, prog + x))));
  const out = { program: prog, programFound: found };
  const i = w.indexOf('--project');
  if (i >= 0 && w[i + 1] && !/[{}]/.test(w[i + 1])) { out.project = w[i + 1]; out.projectFound = exists(path.resolve(cwd || '.', w[i + 1])); }
  return out;
}

// UI previews (docs/ui-contract.md, check 4). Read-only, one screen at a time: the screen must be [a-z0-9-]+, and nothing is read
// outside ui/previews/<screen>/ (symlinks are skipped) and ui/specs/<screen>.json.
const SCREEN = /^[a-z0-9-]+$/;
const screenOk = screen => { if (typeof screen !== 'string' || !SCREEN.test(screen)) throw new Error('screen must be lowercase letters, digits and hyphens'); return screen; };
const sha256 = b => require('crypto').createHash('sha256').update(b).digest('hex');
// {relative path: sha256} of every file under ui/previews/<screen>/ (placements included), forward slashes; {} when the folder is not there.
function previewHashes(root, screen) {
  const base = confine(root, `ui/previews/${screenOk(screen)}`), out = {};
  const walk = (dir, prefix) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`);
      else if (e.isFile()) out[`${prefix}${e.name}`] = sha256(fs.readFileSync(path.join(dir, e.name)));
    }
  };
  walk(base, '');
  return out;
}
// sha256 of ui/specs/<screen>.json as it is on disk, or null.
function specHash(root, screen) {
  try { return sha256(fs.readFileSync(confine(root, `ui/specs/${screenOk(screen)}.json`))); } catch (e) { if (/^screen /.test(e.message)) throw e; return null; }
}
// A page picture as a data URL: a .png directly in the screen's folder. Placements (a subfolder) are never shown. null when absent.
function previewImage(root, screen, rel) {
  const base = confine(root, `ui/previews/${screenOk(screen)}`);
  if (typeof rel !== 'string' || !/^[A-Za-z0-9._-]+\.png$/.test(rel) || rel.includes('..')) return null;
  try { const f = path.join(base, rel); if (!fs.lstatSync(f).isFile()) return null; return `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`; } catch { return null; }
}

module.exports = { commandCheck, confine, childEnv, isTrusted, trustChoices, registryDir, readPages, previewHashes, specHash, previewImage };
