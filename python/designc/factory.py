"""Factory evals: `designc record`, the eval harness's one way into the ledger.

Only the kinds a harness run produces are accepted. The list is fixed here, not read from designc.json, so a
registry cannot widen what an external process may append: gate, promotion, resolution and classification
events stay with the app and the commands that own them. A batch is all or nothing: every line is checked
before any is written. Needs only the folder, not a model or settings."""
import json

from . import ledger

FACTORY_KINDS = ('suite_run', 'grader', 'suite_run_finished')


def parse_lines(text, by):
    """Return (events, errors). Blank lines are skipped; `by` fills in an event that names nobody;
    errors are {'line', 'msg'} with 1-based line numbers."""
    events, errors = [], []
    for n, raw in enumerate(text.split('\n'), 1):
        if not raw.strip(): continue
        try: ev = json.loads(raw)
        except ValueError:
            errors.append({'line': n, 'msg': 'not valid JSON'}); continue
        if not isinstance(ev, dict):
            errors.append({'line': n, 'msg': 'not a JSON object'}); continue
        if ev.get('kind') not in FACTORY_KINDS:
            errors.append({'line': n, 'msg': f"kind '{ev.get('kind')}' cannot be recorded here; designc record accepts {', '.join(FACTORY_KINDS)}"}); continue
        if not ev.get('by'): ev = {**ev, 'by': by}
        errs = ledger.validate(ev)
        if errs: errors.append({'line': n, 'msg': '; '.join(errs)}); continue
        events.append(ev)
    return events, errors


def record(root, text, by):
    """Check every line, then append them all through ledger.append_event, or append none.
    Returns {'ok', 'recorded', 'errors'}."""
    events, errors = parse_lines(text, by)
    if errors: return {'ok': False, 'recorded': 0, 'errors': errors}
    for ev in events: ledger.append_event(root, ev)
    return {'ok': True, 'recorded': len(events), 'errors': []}
