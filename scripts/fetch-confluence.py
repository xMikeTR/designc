#!/usr/bin/env python3
"""Save Confluence pages as .html files designc can import.

    CONFLUENCE_TOKEN=... python3 scripts/fetch-confluence.py <base-url> <output-folder> <page-id>... [--descendants]

<base-url> is the site root as the REST API sees it (Data Center: https://wiki.example.com, Cloud:
https://example.atlassian.net/wiki). Each page is read from /rest/api/content/<id>?expand=body.storage,version and
written as `<id>.html`: a <title>, a canonical link, `confluence-page-version`, then the storage-format body.
`--descendants` also saves every page below the ones named. Auth comes from the environment, never an argument:
a personal access token in CONFLUENCE_TOKEN (Bearer), or, when CONFLUENCE_USER is also set, that user and the
token as basic auth (Cloud API token). `--token-env` and `--user-env` name other variables. Standard library only.
Read-only: the script only issues GET requests. Page text is never printed: the report is counts and reasons only,
so it is safe to paste back from a work machine. Contract: docs/requirement-import.md.
"""
import base64
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

PAGE = 100


class Fetcher:
    def __init__(self, base, headers):
        self.base = base.rstrip('/')
        self.headers = headers

    def get(self, path):
        req = urllib.request.Request(self.base + path, headers=self.headers, method='GET')
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            raise RuntimeError(f'HTTP {e.code} (check the page id, the base url and that the token may read it)')
        except urllib.error.URLError as e:
            raise RuntimeError(f'could not connect: {e.reason}')
        except ValueError:
            raise RuntimeError('the response was not JSON (is the base url the REST API root?)')

    def page(self, pid):
        q = urllib.parse.quote(str(pid), safe='')
        return self.get(f'/rest/api/content/{q}?expand=body.storage,version')

    def descendants(self, pid):
        q = urllib.parse.quote(str(pid), safe='')
        start, out = 0, []
        while True:
            r = self.get(f'/rest/api/content/{q}/descendant/page?limit={PAGE}&start={start}')
            rows = r.get('results') or []
            out += [str(x['id']) for x in rows if 'id' in x]
            if len(rows) < PAGE:
                return out
            start += PAGE


def render(page, base):
    links = page.get('_links') or {}
    webui = links.get('webui')
    canon = (links.get('base') or base.rstrip('/')) + webui if webui else None
    ver = (page.get('version') or {}).get('number')
    body = ((page.get('body') or {}).get('storage') or {}).get('value') or ''
    head = [f'<title>{html.escape(page.get("title") or "")}</title>']
    if canon:
        head.append(f'<link rel="canonical" href="{html.escape(canon, quote=True)}">')
    if ver is not None:
        head.append(f'<meta name="confluence-page-version" content="{html.escape(str(ver), quote=True)}">')
    return '<html><head>\n' + '\n'.join(head) + '\n</head><body>\n' + body + '\n</body></html>\n'


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
    args, flags, opts = [], set(), {}
    it = iter(argv[1:])
    for a in it:
        if a == '--descendants':
            flags.add(a)
        elif a in ('--token-env', '--user-env'):
            opts[a] = next(it, '')
        else:
            args.append(a)
    if len(args) < 3:
        print(__doc__.strip().split('\n\n')[0] + '\n', file=sys.stderr)
        return 2
    base, out, ids = args[0], args[1], args[2:]
    u = urllib.parse.urlparse(base)
    local = u.hostname in ('localhost', '127.0.0.1', '::1')
    if not (u.scheme == 'https' or (u.scheme == 'http' and local)) or not u.hostname:
        print('The base url must be https (http is allowed for localhost only).', file=sys.stderr)
        return 2
    if not all(re.fullmatch(r'\d{1,20}', i) for i in ids):
        print('A page id is the number in the page url (pageId=12345 or /pages/12345/).', file=sys.stderr)
        return 2
    token_env = opts.get('--token-env') or 'CONFLUENCE_TOKEN'
    user_env = opts.get('--user-env') or 'CONFLUENCE_USER'
    headers = headers_from_env(token_env, user_env)
    if headers is None:
        print(f'Set {token_env} to a personal access token (and {user_env} for Cloud basic auth).', file=sys.stderr)
        return 2
    os.makedirs(out, exist_ok=True)
    f = Fetcher(base, headers)
    todo, seen = [], set()
    skipped = []
    for pid in ids:
        todo.append(pid)
        if '--descendants' in flags:
            try:
                todo += f.descendants(pid)
            except RuntimeError as e:
                skipped.append((pid, f'descendants: {e}'))
    saved = 0
    for pid in todo:
        if pid in seen:
            continue
        seen.add(pid)
        try:
            page = f.page(pid)
            pid_out = str(page.get('id') or pid)
            if not re.fullmatch(r'\d{1,20}', pid_out):
                raise RuntimeError('the response carried an unexpected page id')
            with open(os.path.join(out, pid_out + '.html'), 'w', encoding='utf-8') as fh:
                fh.write(render(page, base))
            saved += 1
        except Exception as e:  # report the reason, never the content
            skipped.append((pid, str(e) if isinstance(e, RuntimeError) else f'{type(e).__name__}'))
    print(f'saved {saved}, skipped {len(skipped)}')
    for pid, why in skipped:
        print(f'  skipped {pid}: {why}')
    return 1 if skipped else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
