#!/usr/bin/env python3
"""Put the Jira issues assigned to you that are new or changed into the registry's inbox/ folder.

    JIRA_TOKEN=... python3 scripts/sweep-jira.py <base-url> <registry-folder> [--jql "<query>"] [--max N]

Default query: assignee = currentUser() AND (created >= -1d OR updated >= -1d) AND statusCategory != Done. Each issue
found becomes `inbox/<KEY>.yaml` (id, title, jira: type/labels/components/priority, target: {jira: KEY}, swept date). An
issue is skipped when work/ already has an item targeting it, or inbox/ (or inbox/dismissed/) already has its entry. The
description is never copied. An inbox entry is only a suggestion: the Work view's Accept makes the work item, a person
does. Auth, https rule and the GET-only guarantee are those of fetch-jira.py (same environment variables and options
--token-env and --user-env). The report is counts only. Standard library only. Contract: docs/requirement-import.md.
"""
import datetime
import importlib.util
import json
import os
import re
import sys
import urllib.parse

DEFAULT_JQL = 'assignee = currentUser() AND (created >= -1d OR updated >= -1d) AND statusCategory != Done'
FIELDS = 'summary,issuetype,labels,components,priority'

_spec = importlib.util.spec_from_file_location('fetch_jira', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fetch-jira.py'))
fj = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fj)


def tracked_keys(reg):
    """Keys a work item targets, plus every key with an inbox or dismissed entry."""
    keys = set()
    work = os.path.join(reg, 'work')
    if os.path.isdir(work):
        for n in os.listdir(work):
            if n.endswith(('.yaml', '.yml')):
                with open(os.path.join(work, n), encoding='utf-8', errors='replace') as fh:
                    keys.update(re.findall(r'\bjira:\s*["\']?(' + fj.KEY.pattern + r')\b', fh.read()))
    for d in (os.path.join(reg, 'inbox'), os.path.join(reg, 'inbox', 'dismissed')):
        if os.path.isdir(d):
            keys.update(n.rsplit('.', 1)[0] for n in os.listdir(d) if n.endswith(('.yaml', '.yml')))
    return keys


def entry(issue, today):
    key = issue['key']
    fields = issue.get('fields') or {}
    one = lambda v: json.dumps(v, ensure_ascii=False, separators=(', ', ': '))
    return (f'id: {key}\ntitle: {one(fj.one_line(fields.get("summary")))}\n'
            f'jira: {one(fj.jira_block(fields))}\ntarget: {{ jira: {key} }}\nswept: {today}\n')


def main(argv):
    args, opts = [], {}
    it = iter(argv[1:])
    for a in it:
        if a in ('--jql', '--max', '--token-env', '--user-env'):
            opts[a] = next(it, '')
        else:
            args.append(a)
    if len(args) != 2:
        print(__doc__.strip().split('\n\n')[0] + '\n', file=sys.stderr)
        return 2
    base, reg = args
    u = urllib.parse.urlparse(base)
    local = u.hostname in ('localhost', '127.0.0.1', '::1')
    if not (u.scheme == 'https' or (u.scheme == 'http' and local)) or not u.hostname:
        print('The base url must be https (http is allowed for localhost only).', file=sys.stderr)
        return 2
    if not re.fullmatch(r'\d{1,5}', opts.get('--max', '100') or ''):
        print('--max is a whole number.', file=sys.stderr)
        return 2
    token_env = opts.get('--token-env') or 'JIRA_TOKEN'
    user_env = opts.get('--user-env') or 'JIRA_USER'
    headers = fj.headers_from_env(token_env, user_env)
    if headers is None:
        print(f'Set {token_env} to a personal access token (and {user_env} for Cloud basic auth).', file=sys.stderr)
        return 2
    if not os.path.isdir(reg):
        print('The registry folder does not exist.', file=sys.stderr)
        return 2
    limit = int(opts.get('--max', '100') or 100)
    try:
        found = fj.Fetcher(base, headers).search(opts.get('--jql', '').strip() or DEFAULT_JQL, limit, FIELDS)
    except RuntimeError as e:
        print(f'sweep failed: {e}')
        return 1
    have = tracked_keys(reg)
    today = datetime.date.today().isoformat()
    new = already = 0
    for issue in found:
        key = str(issue.get('key') or '')
        if not fj.KEY.fullmatch(key):
            continue
        if key in have:
            already += 1
            continue
        os.makedirs(os.path.join(reg, 'inbox'), exist_ok=True)
        with open(os.path.join(reg, 'inbox', key + '.yaml'), 'w', encoding='utf-8') as fh:
            fh.write(entry(issue, today))
        have.add(key)
        new += 1
    print(f'swept {new} new, {already} already tracked' + (f'; stopped at --max {limit}, there may be more' if len(found) == limit else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
