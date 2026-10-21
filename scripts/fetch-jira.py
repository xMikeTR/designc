#!/usr/bin/env python3
"""Save Jira issues as .md files designc can import.

    JIRA_TOKEN=... python3 scripts/fetch-jira.py <base-url> <output-folder> [<issue-key>...] [--jql "<query>"] [--max N]

<base-url> is the site root (Data Center: https://jira.example.com, Cloud: https://example.atlassian.net). Each issue
named, and each issue the JQL query finds (at most --max, default 500), is read from
/rest/api/2/issue/<key>?fields=summary,description,updated and written as `<KEY>.md` with front matter id (the key),
title (the summary), source (the browse url) and version (the `updated` time), then the description as it comes from
the v2 API (wiki markup). The query uses /rest/api/2/search, or /rest/api/2/search/jql where the older endpoint is gone
(Cloud). Auth comes from the environment, never an argument: a personal access token in JIRA_TOKEN (Bearer), or, when
JIRA_USER is also set, that user and the token as basic auth (Cloud API token). `--token-env` and `--user-env` name
other variables. Standard library only. Read-only: the script only issues GET requests. Issue text is never printed:
the report is counts and reasons only, so it is safe to paste back from a work machine. Contract:
docs/requirement-import.md.
"""
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

PAGE = 100
KEY = re.compile(r'[A-Z][A-Z0-9_]{0,30}-\d{1,10}')


class HttpError(RuntimeError):
    def __init__(self, code):
        super().__init__(f'HTTP {code} (check the key or query, the base url and that the token may read it)')
        self.code = code


class Fetcher:
    def __init__(self, base, headers):
        self.base = base.rstrip('/')
        self.headers = headers

    def get(self, path, params):
        url = self.base + path + '?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers=self.headers, method='GET')
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            raise HttpError(e.code)
        except urllib.error.URLError as e:
            raise RuntimeError(f'could not connect: {e.reason}')
        except ValueError:
            raise RuntimeError('the response was not JSON (is the base url the site root?)')

    def issue(self, key):
        q = urllib.parse.quote(key, safe='')
        return self.get(f'/rest/api/2/issue/{q}', {'fields': 'summary,description,updated'})

    def search(self, jql, limit):
        try:
            return self._search_paged(jql, limit)
        except HttpError as e:
            if e.code not in (404, 410):
                raise
            return self._search_token(jql, limit)

    def _search_paged(self, jql, limit):
        keys, start = [], 0
        while len(keys) < limit:
            r = self.get('/rest/api/2/search', {'jql': jql, 'fields': 'summary', 'startAt': start, 'maxResults': PAGE})
            rows = r.get('issues') or []
            keys += [x['key'] for x in rows if 'key' in x]
            start += len(rows)
            if not rows or start >= (r.get('total') or 0):
                break
        return keys[:limit]

    def _search_token(self, jql, limit):
        keys, token = [], None
        while len(keys) < limit:
            params = {'jql': jql, 'fields': 'summary', 'maxResults': PAGE}
            if token:
                params['nextPageToken'] = token
            r = self.get('/rest/api/2/search/jql', params)
            keys += [x['key'] for x in (r.get('issues') or []) if 'key' in x]
            token = r.get('nextPageToken')
            if not token or r.get('isLast'):
                break
        return keys[:limit]


def one_line(s):
    return re.sub(r'\s+', ' ', str(s or '')).strip()


def render(issue, base):
    key = issue['key']
    fields = issue.get('fields') or {}
    title = one_line(fields.get('summary'))
    head = ['---', f'id: {key}', f'title: {title}', f'source: {base.rstrip("/")}/browse/{key}']
    if fields.get('updated'):
        head.append(f'version: {one_line(fields["updated"])}')
    head.append('---')
    desc = str(fields.get('description') or '').replace('\r\n', '\n')
    return '\n'.join(head) + f'\n# {title}\n\n' + desc + '\n'


def headers_from_env(token_env, user_env):
    token = os.environ.get(token_env, '')
    if not token:
        return None
    user = os.environ.get(user_env, '')
    if user:
        raw = base64.b64encode(f'{user}:{token}'.encode('utf-8')).decode('ascii')
        return {'Authorization': 'Basic ' + raw, 'Accept': 'application/json'}
    return {'Authorization': 'Bearer ' + token, 'Accept': 'application/json'}


def main(argv):
    args, opts = [], {}
    it = iter(argv[1:])
    for a in it:
        if a in ('--jql', '--max', '--token-env', '--user-env'):
            opts[a] = next(it, '')
        else:
            args.append(a)
    jql = opts.get('--jql', '').strip()
    if len(args) < 2 or (len(args) < 3 and not jql):
        print(__doc__.strip().split('\n\n')[0] + '\n', file=sys.stderr)
        return 2
    base, out, keys = args[0], args[1], args[2:]
    u = urllib.parse.urlparse(base)
    local = u.hostname in ('localhost', '127.0.0.1', '::1')
    if not (u.scheme == 'https' or (u.scheme == 'http' and local)) or not u.hostname:
        print('The base url must be https (http is allowed for localhost only).', file=sys.stderr)
        return 2
    if not all(KEY.fullmatch(k) for k in keys):
        print('An issue key looks like ABC-123 (project key in capitals, a dash, a number).', file=sys.stderr)
        return 2
    if not re.fullmatch(r'\d{1,5}', opts.get('--max', '500') or ''):
        print('--max is a whole number.', file=sys.stderr)
        return 2
    limit = int(opts.get('--max', '500'))
    token_env = opts.get('--token-env') or 'JIRA_TOKEN'
    user_env = opts.get('--user-env') or 'JIRA_USER'
    headers = headers_from_env(token_env, user_env)
    if headers is None:
        print(f'Set {token_env} to a personal access token (and {user_env} for Cloud basic auth).', file=sys.stderr)
        return 2
    os.makedirs(out, exist_ok=True)
    f = Fetcher(base, headers)
    todo, skipped = list(keys), []
    if jql:
        try:
            found = f.search(jql, limit)
            todo += found
            if len(found) == limit:
                skipped.append(('query', f'stopped at --max {limit}; there may be more'))
        except RuntimeError as e:
            skipped.append(('query', str(e)))
    saved, seen = 0, set()
    for key in todo:
        if key in seen:
            continue
        seen.add(key)
        try:
            issue = f.issue(key)
            if not KEY.fullmatch(str(issue.get('key') or '')):
                raise RuntimeError('the response carried an unexpected issue key')
            with open(os.path.join(out, issue['key'] + '.md'), 'w', encoding='utf-8') as fh:
                fh.write(render(issue, base))
            saved += 1
        except Exception as e:  # report the reason, never the content
            skipped.append((key, str(e) if isinstance(e, RuntimeError) else f'{type(e).__name__}'))
    print(f'saved {saved}, skipped {len(skipped)}')
    for key, why in skipped:
        print(f'  skipped {key}: {why}')
    return 1 if skipped else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
