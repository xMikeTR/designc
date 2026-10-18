"""The gate event: what the definition-of-ready gate said, as one compact ledger snapshot.
Mirrors Core.modelRevision, Core.verdictHash and Core.gateRecord in renderer/core.js."""
import json
import os
import subprocess

from .rules import hash16


def _units(s): return s.encode('utf-16-be', 'surrogatepass')  # byte order equals UTF-16 code-unit order, as JS sorts


def model_revision(text): return 'r-' + hash16(text)[:8]


def canonical(v):
    """Keys sorted at every level, no whitespace, non-ASCII kept: the same string JSON.stringify gives in core.js."""
    if isinstance(v, list): return '[' + ','.join(canonical(x) for x in v) + ']'
    if isinstance(v, dict): return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + canonical(v[k]) for k in sorted(v, key=_units)) + '}'
    return json.dumps(v, ensure_ascii=False)


def _by_canonical(items): return sorted(items, key=lambda x: _units(canonical(x)))


def verdict_hash(ready, clauses, findings): return hash16(canonical({'ready': ready, 'clauses': clauses, 'findings': findings}))


def gate_record(model_text, diags, gate, source, git):
    clauses = _by_canonical([{'kind': c['kind'], 'text': c['text']} for c in gate['clauses']])
    findings = _by_canonical([{'code': d['code'], 'sev': d['sev'], 'on': d['loc']['label'], 'loc': d['loc']['kind'],
                               'unknown': bool(d['unknown']), 'suppressed': bool(d['suppressed'])} for d in diags])
    ready = bool(gate['ready'])
    ev = {'kind': 'gate', 'source': source, 'revision': model_revision(model_text), 'ready': ready,
          'verdict': verdict_hash(ready, clauses, findings), 'clauses': clauses, 'findings': findings}
    if git is not None: ev['commit'] = git['commit']; ev['dirty'] = bool(git['dirty'])
    return ev


# What the gate reads from the registry; `ledger/` is deliberately not here, so recording never makes a run dirty.
def gate_inputs(cfg):
    return [cfg.get('model') or 'model/workspace.dsl', 'decisions', 'requirements', 'scenarios', 'acceptance', 'design-tokens', 'evals/*.yaml', 'evals/*.yml', 'behaviour', 'vocabulary', 'domain', 'designc.json']


_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'core.untrackedCache=false']


def _git(root, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update({'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0'})
    r = subprocess.run(['git', *_GIT, *args], cwd=root, env=env, capture_output=True, text=True, timeout=20)
    return r.returncode, r.stdout.strip()


def git_state(root, cfg):
    """{'commit': hash|None, 'dirty': bool} for the gate inputs, or None when there is no usable git.
    Read-only, fixed arguments, hooks and fsmonitor off. The registry may sit inside a larger repository."""
    try:
        code, inside = _git(root, 'rev-parse', '--is-inside-work-tree')
        if code != 0 or inside != 'true': return None
        code, head = _git(root, 'rev-parse', '--verify', '-q', 'HEAD')
        code2, porcelain = _git(root, 'status', '--porcelain', '--', *gate_inputs(cfg))
        if code2 != 0: return None
        return {'commit': head if code == 0 else None, 'dirty': bool(porcelain)}
    except (OSError, subprocess.SubprocessError):
        return None
