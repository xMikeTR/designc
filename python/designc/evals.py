"""Agent evals: threshold parsing and scoring. A port of Core.parseThreshold and Core.scoreEval."""
import math
import re

_THRESHOLD = re.compile(r'^\s*([A-Za-z_][\w.-]*)\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)\s*$', re.A)
_OPS = {'>=': lambda a, b: a >= b, '<=': lambda a, b: a <= b, '>': lambda a, b: a > b, '<': lambda a, b: a < b, '==': lambda a, b: a == b}


def _num(v):
    """Numbers print as JavaScript prints them: 1.0 is 1."""
    return str(int(v)) if isinstance(v, float) and v.is_integer() else str(v)


def _is_num(v): return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def parse_threshold(text):
    m = _THRESHOLD.match(text) if isinstance(text, str) else None
    if not m: return {'error': f'"{text}" is not "<metric> <op> <number>", e.g. task_success >= 0.85'}
    return {'metric': m.group(1), 'op': m.group(2), 'value': float(m.group(3))}


def score_eval(eval_def, results):
    """The verdict from a results file: {outcome, metrics, cases, thresholds, reason?}, or {error} when nothing can be judged."""
    thresholds = (eval_def or {}).get('thresholds') or []
    if not thresholds: return {'error': f"eval {(eval_def or {}).get('id')} has no thresholds"}
    parsed = [parse_threshold(t) for t in thresholds]
    for t in parsed:
        if 'error' in t: return {'error': t['error']}
    if not isinstance(results, dict): return {'error': 'results must be an object with metrics and cases'}
    metrics = results.get('metrics')
    if not isinstance(metrics, dict) or not all(_is_num(v) for v in metrics.values()): return {'error': 'results.metrics must be an object of numbers'}
    cases = results.get('cases')
    if isinstance(cases, float) and cases.is_integer(): cases = int(cases)
    if not isinstance(cases, int) or isinstance(cases, bool) or cases < 0: return {'error': 'results.cases must be a whole number, 0 or more'}
    scored = []
    for t in parsed:
        actual = metrics.get(t['metric'])
        scored.append({**t, 'actual': actual, 'ok': actual is not None and _OPS[t['op']](actual, t['value'])})
    reasons = [f"{t['metric']} is missing from the results" if t['actual'] is None else f"{t['metric']} {_num(t['actual'])} is not {t['op']} {_num(t['value'])}" for t in scored if not t['ok']]
    out = {'outcome': 'fail' if reasons else 'pass', 'metrics': metrics, 'cases': cases, 'thresholds': scored}
    if reasons: out['reason'] = '; '.join(reasons)
    return out
