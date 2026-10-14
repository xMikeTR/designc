// designc desktop: the only code that runs the git binary. Main process, no Electron, no dependencies.
// Every call is a fixed argument array through execFile (no shell, no passthrough). A repo is
// untrusted input: read calls switch off fsmonitor, hooks, pager, external diff and textconv, and the
// environment is cut down to what git needs. The registry may sit inside a larger repo, so every call
// is confined to the registry folder with a pathspec.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'core.untrackedCache=false'];

function cleanEnv() {
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C.UTF-8' };
  for (const k of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'SSH_AUTH_SOCK']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

function run(cwd, args, { input } = {}) {
  return new Promise(resolve => {
    const child = execFile('git', ['--no-pager', ...SAFE_CONFIG, ...args], { cwd, env: cleanEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve(err ? { error: (stderr || err.message).trim().split('\n')[0] || 'git failed' } : { out: stdout }));
    if (input != null) child.stdin.end(input);
  });
}

// The folder holding .git, found by walking up the file system. Runs no git, so it is safe to call
// before the folder is trusted.
function findRepo(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d); if (up === d) return null; d = up;
  }
}

// A path inside the registry, as git wants it: relative to the registry, forward slashes.
function within(root, rel) {
  const abs = path.resolve(root, rel || '.');
  const r = path.relative(path.resolve(root), abs);
  if (r.startsWith('..') || path.isAbsolute(r)) return null;
  return r.split(path.sep).join('/') || '.';
}

async function status(root) {
  const prefix = await run(root, ['rev-parse', '--show-prefix']);
  if (prefix.error) return { error: prefix.error };
  const r = await run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--no-renames', '--', '.']);
  if (r.error) return { error: r.error };
  const out = { branch: null, detached: false, head: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const pre = prefix.out.trim();
  for (const line of r.out.split('\0').filter(Boolean)) {
    if (line.startsWith('# branch.oid ')) out.head = line.slice(13) === '(initial)' ? null : line.slice(13);
    else if (line.startsWith('# branch.head ')) { const h = line.slice(14); out.detached = h === '(detached)'; out.branch = out.detached ? null : h; }
    else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) { out.ahead = +m[1]; out.behind = +m[2]; } }
    else if (line.startsWith('1 ') || line.startsWith('u ')) {
      const f = line.split(' '); const xy = f[1]; const file = f.slice(line.startsWith('1 ') ? 8 : 10).join(' ');
      out.files.push({ path: pre && file.startsWith(pre) ? file.slice(pre.length) : file, index: xy[0], worktree: xy[1] });
    } else if (line.startsWith('? ')) { const file = line.slice(2); out.files.push({ path: pre && file.startsWith(pre) ? file.slice(pre.length) : file, index: '?', worktree: '?' }); }
  }
  return out;
}

async function refs(root) {
  const r = await run(root, ['for-each-ref', '--format=%(refname)%1f%(objectname)%1f%(HEAD)', 'refs/heads', 'refs/tags']);
  if (r.error) return { error: r.error };
  const branches = [], tags = [];
  for (const line of r.out.split('\n').filter(Boolean)) {
    const [ref, hash, head] = line.split('\x1f');
    if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice(11), hash, current: head === '*' });
    else if (ref.startsWith('refs/tags/')) tags.push({ name: ref.slice(10), hash });
  }
  return { branches, tags };
}

async function log(root, rel, max) {
  const p = within(root, rel); if (!p) return { error: 'Path is outside the registry' };
  const n = Math.min(200, Math.max(1, Math.floor(Number(max)) || 1));
  const r = await run(root, ['log', `-n${n}`, '--no-ext-diff', '--format=%H%x1f%an%x1f%aI%x1f%s%x1e', '--', p]);
  if (r.error) return { error: r.error };
  return r.out.split('\x1e').map(s => s.trim()).filter(Boolean).map(s => {
    const [hash, author, date, subject] = s.split('\x1f'); return { hash, short: hash.slice(0, 7), author, date, subject };
  });
}

async function show(root, hash, rel) {
  if (typeof hash !== 'string' || !HASH.test(hash)) return { error: 'Give the full commit hash, not a name or an abbreviation' };
  const p = within(root, rel); if (!p || p === '.') return { error: 'Path is outside the registry' };
  const r = await run(root, ['show', '--no-ext-diff', '--no-textconv', `${hash}:./${p}`]);
  if (r.error) return { error: /exists on disk|does not exist|not in/.test(r.error) ? `${p} is not in that commit` : r.error };
  return { text: r.out };
}

// ---- writes (slice 2). Same rules as reads: fixed argument arrays, hooks off (core.hooksPath above),
// confined to the registry. Nothing here forces anything: no --force, no --hard, no reset.
const ok = r => r.error ? { error: r.error } : { ok: true };

function pathspecs(root, paths) {
  if (!Array.isArray(paths) || !paths.length) return { error: 'Choose at least one file' };
  const out = [];
  for (const p of paths) { const w = typeof p === 'string' ? within(root, p) : null; if (!w) return { error: `${p} is outside the registry` }; out.push(w); }
  return { out };
}

async function stage(root, paths) {
  const s = pathspecs(root, paths); if (s.error) return s;
  return ok(await run(root, ['add', '-A', '--', ...s.out]));
}

async function unstage(root, paths) {
  const s = pathspecs(root, paths); if (s.error) return s;
  const r = await run(root, ['restore', '--staged', '--', ...s.out]);
  if (!r.error) return { ok: true };
  return ok(await run(root, ['rm', '--cached', '-r', '-q', '--', ...s.out])); // a repo with no commits has no HEAD to restore from
}

// Throw away working tree edits of tracked files, back to what is in the index. Only a path git itself lists as modified or
// deleted in the working tree is accepted, so an untracked file, a directory or `.` can never be removed by this. Staged
// work is untouched (restore without --staged). The caller confirms with the person first.
async function discard(root, paths) {
  const s = pathspecs(root, paths); if (s.error) return s;
  const st = await status(root); if (st.error) return { error: st.error };
    const dirty = new Set(st.files.filter(f => f.worktree === 'M' || f.worktree === 'D').map(f => f.path));
  const bad = s.out.find(p => !dirty.has(p));
  if (bad) return { error: `${bad} has no unstaged changes to discard (untracked files are never removed from here)` };
  return ok(await run(root, ['restore', '--', ...s.out]));
}

async function commit(root, message) {
  if (typeof message !== 'string' || !message.trim()) return { error: 'Write a commit message' };
  const all = await run(root, ['diff', '--cached', '--name-only', '-z']);
  if (all.error) return { error: all.error };
  const mine = await run(root, ['diff', '--cached', '--name-only', '-z', '--', '.']);
  if (mine.error) return { error: mine.error };
  const count = r => r.out.split('\0').filter(Boolean).length;
  if (!count(all)) return { error: 'Nothing is staged' };
  if (count(all) !== count(mine)) return { error: 'Files outside the registry are staged. Unstage them in a terminal first.' };
  const r = await run(root, ['commit', '-F', '-'], { input: message });
  if (r.error) return { error: r.error };
  const h = await run(root, ['rev-parse', 'HEAD']);
  return h.error ? { error: h.error } : { ok: true, hash: h.out.trim() };
}

async function branch(root, name) {
  if (typeof name !== 'string' || !name || name.startsWith('-')) return { error: `${name} is not a valid branch name` };
  const c = await run(root, ['check-ref-format', '--branch', name]);
  if (c.error) return { error: `${name} is not a valid branch name` };
  return ok(await run(root, ['switch', '-c', name]));
}

async function switchTo(root, name) {
  const r = await refs(root); if (r.error) return { error: r.error };
  if (typeof name !== 'string' || !r.branches.some(b => b.name === name)) return { error: `No branch named ${name}` };
  return ok(await run(root, ['switch', name]));
}

const fetch = root => run(root, ['fetch', '--prune']).then(ok);

async function pull(root) { return ok(await run(root, ['pull', '--ff-only'])); }

async function push(root) {
  const s = await status(root); if (s.error) return { error: s.error };
  if (!s.upstream) return { error: 'This branch has no upstream. Publish it first.' };
  return ok(await run(root, ['push']));
}

// First push of a branch: only when there is exactly one remote, so the destination is never a guess.
async function publish(root) {
  const s = await status(root); if (s.error) return { error: s.error };
  if (!s.branch) return { error: 'Switch to a branch before publishing' };
  const r = await run(root, ['remote']); if (r.error) return { error: r.error };
  const remotes = r.out.split('\n').filter(Boolean);
  if (remotes.length !== 1) return { error: remotes.length ? 'Publish needs exactly one remote; this repo has several. Push from a terminal.' : 'This repo has no remote. Add one in a terminal first.' };
  return ok(await run(root, ['push', '-u', remotes[0], s.branch]));
}

// Stash. Only the registry's files go in (pathspec), untracked ones included (-u, never --all, so ignored files stay).
// A stash is addressed by `stash@{n}` and nothing else, so no ref, flag or revision expression comes from the caller.
const STASH_REF = /^stash@\{\d+\}$/;
const stashRef = ref => (typeof ref === 'string' && STASH_REF.test(ref) ? null : { error: `${ref} is not a stash reference` });

async function stashPush(root, message) {
  const args = ['stash', 'push', '-u'];
  if (typeof message === 'string' && message.trim()) args.push('-m', message.trim().replace(/\s+/g, ' '));
  const r = await run(root, [...args, '--', '.']);
  if (r.error) return { error: r.error };
  return /No local changes to save/.test(r.out) ? { error: 'Nothing to stash: there are no changes in this folder.' } : { ok: true };
}

async function stashList(root) {
  const r = await run(root, ['stash', 'list', '--format=%gd%x1f%gs%x1f%aI%x1e']);
  if (r.error) return { error: r.error };
  return r.out.split('\x1e').map(s => s.trim()).filter(Boolean).map(s => { const [ref, message, date] = s.split('\x1f'); return { ref, message, date }; });
}

async function stashApply(root, ref) { return stashRef(ref) || ok(await run(root, ['stash', 'apply', '--quiet', ref])); }
async function stashDrop(root, ref) { return stashRef(ref) || ok(await run(root, ['stash', 'drop', '--quiet', ref])); }
async function stashPop(root) {
  const l = await stashList(root); if (l.error) return l;
  if (!l.length) return { error: 'No stash to restore.' };
  return ok(await run(root, ['stash', 'pop', '--quiet', l[0].ref]));
}

// The ledger is append-only, so two branches that both appended merge cleanly with merge=union.
const UNION = 'ledger/*.jsonl merge=union';
const attrFile = root => path.join(root, '.gitattributes');
function hasLedgerUnion(root) {
  try { return fs.readFileSync(attrFile(root), 'utf8').split('\n').some(l => l.trim() === UNION); } catch { return false; }
}
function addLedgerUnion(root) {
  try {
    if (hasLedgerUnion(root)) return { ok: true };
    let t = ''; try { t = fs.readFileSync(attrFile(root), 'utf8'); } catch { /* new file */ }
    fs.writeFileSync(attrFile(root), (t && !t.endsWith('\n') ? t + '\n' : t) + UNION + '\n');
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

// Where a work item's repo is: its HEAD commit, branch and whether tracked files have uncommitted changes. Runs in the
// whole repo (a work item's repo is the codebase, not the registry), read-only.
async function head(dir) {
  const c = await run(dir, ['rev-parse', 'HEAD']);
  if (c.error) return { error: c.error };
  const b = await run(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const s = await run(dir, ['status', '--porcelain', '--untracked-files=no']);
  if (s.error) return { error: s.error };
  const branch = b.out ? b.out.trim() : null;
  return { commit: c.out.trim(), branch: branch === 'HEAD' ? null : branch, dirty: s.out.trim() !== '' };
}

// Is the commit reachable from the local branch? A fixed argument array: the commit must be a hash (or a
// short one git resolves to a commit) and the branch a plain branch name, so nothing here can be a flag.
// No fetch: a branch behind its remote can wrongly say no, and the caller says so.
async function isAncestor(dir, commit, branch) {
  if (!/^[0-9a-f]{7,64}$/.test(String(commit))) return { error: `${commit} is not a commit hash.` };
  if (!/^[A-Za-z0-9_][A-Za-z0-9._\/-]*$/.test(String(branch))) return { error: `${branch} is not a branch name.` };
  const full = await run(dir, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
  if (full.error || !HASH.test((full.out || '').trim())) return { error: `Commit ${String(commit).slice(0, 7)} is not in this repo.` };
  const tip = await run(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (tip.error) return { error: `Branch ${branch} does not exist in this repo.` };
  const c = full.out.trim();
  // Both ends exist, so a failure of is-ancestor means "not an ancestor".
  const r = await run(dir, ['merge-base', '--is-ancestor', c, `refs/heads/${branch}`]);
  return { onMain: !r.error, commit: c };
}

module.exports = { head, isAncestor, findRepo, status, refs, log, show, stage, unstage, discard, commit, branch, switchTo, fetch, pull, push, publish, stashPush, stashList, stashApply, stashDrop, stashPop, hasLedgerUnion, addLedgerUnion, run, within, HASH };
