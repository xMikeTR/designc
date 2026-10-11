/* designc desktop: d.code path patterns. Pure, no I/O, no dependencies.
   Dual-load like renderer/policy.js: <script src="pathpattern.js"> before core.js in the renderer,
   require('./renderer/pathpattern.js') from core.js, extract/glob.js and tests. designc owns the meaning:
   docs/path-patterns.json is the contract its implementations and any consuming coding agent test against. */
const PathPattern = (() => {
  // A repo-relative path or glob: `*` and `?` inside a segment, `**` as a whole segment. Character classes,
  // braces, absolute paths, `.`, `..`, empty segments and `**` inside a segment are rejected.
  function create(input) {
    if (input == null || !String(input).trim()) return { ok: false, error: 'empty path' };
    let s = String(input).trim().replace(/\\/g, '/');
    if (s.startsWith('./')) s = s.slice(2);
    if (s.startsWith('/') || (s.length > 1 && s[1] === ':')) return { ok: false, error: `absolute path not allowed: ${input}` };
    if (/[[\]{}]/.test(s)) return { ok: false, error: `character classes and braces are not supported: ${input}` };
    const segs = s.replace(/\/+$/, '').split('/');
    const bad = segs.find(g => g === '' || g === '.' || g === '..' || (g.includes('**') && g !== '**'));
    if (bad !== undefined) return { ok: false, error: `invalid segment '${bad}' in ${input}` };
    return { ok: true, value: segs.join('/'), segs };
  }

  const isWild = g => g.includes('*') || g.includes('?');

  function matchSeg(pat, pi, s, si) {
    if (pi === pat.length) return si === s.length;
    if (pat[pi] === '*') return matchSeg(pat, pi + 1, s, si) || (si < s.length && matchSeg(pat, pi, s, si + 1));
    return si < s.length && (pat[pi] === '?' || pat[pi] === s[si]) && matchSeg(pat, pi + 1, s, si + 1);
  }

  // `**` matches zero or more whole segments.
  function matchSegs(ps, ss) {
    if (!ps.length) return !ss.length;
    if (ps[0] === '**') return matchSegs(ps.slice(1), ss) || (ss.length > 0 && matchSegs(ps, ss.slice(1)));
    return ss.length > 0 && matchSeg(ps[0], 0, ss[0], 0) && matchSegs(ps.slice(1), ss.slice(1));
  }

  // Does the pattern match a concrete repo-relative file path? Ordinal, case-sensitive. A pattern
  // create() rejects matches nothing.
  const parsed = new Map();
  function matches(pattern, path) {
    if (!parsed.has(pattern)) parsed.set(pattern, create(pattern));
    const p = parsed.get(pattern);
    if (!p.ok) return false;
    let f = String(path).replace(/\\/g, '/');
    if (f.startsWith('./')) f = f.slice(2);
    return matchSegs(p.segs, f.split('/').filter(Boolean));
  }

  // Could any file match both normalised patterns? Over-approximates, as the contract does: two wild
  // segments are assumed compatible, because a false "no" would let two tasks write the same file.
  function mayOverlap(a, b) {
    const as = a.split('/'), bs = b.split('/'), ea = !as.some(isWild), eb = !bs.some(isWild);
    if (ea && eb) return a === b;
    if (ea) return matchSegs(bs, as);
    if (eb) return matchSegs(as, bs);
    const compatible = (x, y) => (!isWild(x) ? matchSeg(y, 0, x, 0) : !isWild(y) ? matchSeg(x, 0, y, 0) : true);
    const overlap = (xs, ys) => {
      if (!xs.length && !ys.length) return true;
      if (xs[0] === '**') return overlap(xs.slice(1), ys) || (ys.length > 0 && overlap(xs, ys.slice(1)));
      if (ys[0] === '**') return overlap(xs, ys.slice(1)) || (xs.length > 0 && overlap(xs.slice(1), ys));
      return xs.length > 0 && ys.length > 0 && compatible(xs[0], ys[0]) && overlap(xs.slice(1), ys.slice(1));
    };
    return overlap(as, bs);
  }

  return { create, matches, mayOverlap };
})();
if (typeof module !== 'undefined') module.exports = PathPattern;
