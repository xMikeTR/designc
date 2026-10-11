"""d.code path patterns: the Python mirror of renderer/pathpattern.js. designc's meaning;
docs/path-patterns.json is the contract every implementation, designc's or a coding agent's, tests against."""
import re


def create(text):
    """(normalised pattern, None) or (None, error)."""
    if text is None or not str(text).strip(): return None, 'empty path'
    s = str(text).strip().replace('\\', '/')
    if s.startswith('./'): s = s[2:]
    if s.startswith('/') or (len(s) > 1 and s[1] == ':'): return None, f'absolute path not allowed: {text}'
    if re.search(r'[\[\]{}]', s): return None, f'character classes and braces are not supported: {text}'
    segs = re.sub(r'/+$', '', s).split('/')
    bad = next((g for g in segs if g in ('', '.', '..') or ('**' in g and g != '**')), None)
    if bad is not None: return None, f"invalid segment '{bad}' in {text}"
    return '/'.join(segs), None


def _wild(g): return '*' in g or '?' in g


def _match_seg(pat, pi, s, si):
    if pi == len(pat): return si == len(s)
    if pat[pi] == '*': return _match_seg(pat, pi + 1, s, si) or (si < len(s) and _match_seg(pat, pi, s, si + 1))
    return si < len(s) and (pat[pi] == '?' or pat[pi] == s[si]) and _match_seg(pat, pi + 1, s, si + 1)


def _match_segs(ps, ss):
    """`**` matches zero or more whole segments."""
    if not ps: return not ss
    if ps[0] == '**': return _match_segs(ps[1:], ss) or (bool(ss) and _match_segs(ps, ss[1:]))
    return bool(ss) and _match_seg(ps[0], 0, ss[0], 0) and _match_segs(ps[1:], ss[1:])


def may_overlap(a, b):
    """Could any file match both normalised patterns? Over-approximates, as the contract does."""
    as_, bs = a.split('/'), b.split('/')
    ea, eb = not any(map(_wild, as_)), not any(map(_wild, bs))
    if ea and eb: return a == b
    if ea: return _match_segs(bs, as_)
    if eb: return _match_segs(as_, bs)

    def compatible(x, y):
        if not _wild(x): return _match_seg(y, 0, x, 0)
        if not _wild(y): return _match_seg(x, 0, y, 0)
        return True

    def overlap(xs, ys):
        if not xs and not ys: return True
        if xs and xs[0] == '**': return overlap(xs[1:], ys) or (bool(ys) and overlap(xs, ys[1:]))
        if ys and ys[0] == '**': return overlap(xs, ys[1:]) or (bool(xs) and overlap(xs[1:], ys))
        return bool(xs) and bool(ys) and compatible(xs[0], ys[0]) and overlap(xs[1:], ys[1:])

    return overlap(as_, bs)
