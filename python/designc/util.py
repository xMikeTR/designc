"""The few helpers the remaining Python commands (record, work, verify-ledger) share. The language itself (parse, rules,
gate, ui, domain) lives only in the Node core; `check` and `eval` run there through the shim in cli.py."""
import json


def _js(v):
    """String(v) as JavaScript gives it for the scalars YAML yields."""
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, float) and v.is_integer(): return str(int(v))
    return str(v)


def _s(v):
    """String(v) as JavaScript does it, for ids and versions read from YAML."""
    return _js(v)


def _list(v):
    return [] if v is None else v if isinstance(v, list) else [v]


def check_run(c):
    if isinstance(c, dict): return c['run'] if isinstance(c.get('run'), str) else ''
    return '' if c is None else _js(c)


def runs(rec):
    return [check_run(c) for c in _list((rec or {}).get('checks'))]


def accept_without_check(dec):
    """An accepted risk rests on its business decision and needs no check; a TODO placeholder is not a check.
    Same rule as core.js and renderer/ledger.js."""
    return dec.get('effect') in ('accept', 'build') and not any(c and not c.startswith('TODO') for c in runs(dec))


def _units(s): return s.encode('utf-16-be', 'surrogatepass')  # byte order equals UTF-16 code-unit order, as JS sorts


def canonical(v):
    """Keys sorted at every level, no whitespace, non-ASCII kept: the same string JSON.stringify gives in core.js."""
    if isinstance(v, list): return '[' + ','.join(canonical(x) for x in v) + ']'
    if isinstance(v, dict): return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + canonical(v[k]) for k in sorted(v, key=_units)) + '}'
    return json.dumps(v, ensure_ascii=False)
