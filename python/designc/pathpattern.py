"""d.code path patterns: the Python mirror of renderer/pathpattern.js. System 2's meaning (Factory.Core
PathPattern); docs/path-patterns.json is the contract all three implementations test against."""
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
