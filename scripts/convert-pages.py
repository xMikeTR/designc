#!/usr/bin/env python3
"""Convert Word (.docx) and PDF pages to markdown files designc can import.

    python3 scripts/convert-pages.py <input-folder> <output-folder>

Standard library only. .docx is read directly. .pdf needs `pdftotext` on PATH (poppler); without it each
PDF is reported as skipped. Output is `<name>.md` with front matter (title, source = the file name) in a
separate folder, then import that folder in designc. Page text is never printed: the report is counts and
reasons only, so it is safe to paste back from a work machine. Contract: docs/requirement-import.md.
"""
import os
import re
import shutil
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
DC = '{http://purl.org/dc/elements/1.1/}'


def para_text(p):
    out = []
    for n in p.iter():
        if n.tag == W + 't' and n.text:
            out.append(n.text)
        elif n.tag in (W + 'tab',):
            out.append(' ')
        elif n.tag in (W + 'br', W + 'cr'):
            out.append('\n')
    return ''.join(out).strip()


def para_md(p):
    text = para_text(p)
    if not text:
        return ''
    style = p.find(f'{W}pPr/{W}pStyle')
    val = style.get(W + 'val', '') if style is not None else ''
    m = re.match(r'(?i)heading\s*([1-6])$', val)
    if val.lower() == 'title':
        return f'# {text}'
    if m:
        return f'{"#" * int(m.group(1))} {text}'
    if p.find(f'{W}pPr/{W}numPr') is not None:
        return f'- {text}'
    return text


def table_md(tbl):
    rows = []
    for tr in tbl.findall(f'{W}tr'):
        cells = [' '.join(para_text(p) for p in tc.iter(W + 'p')).replace('|', '/') for tc in tr.findall(f'{W}tc')]
        rows.append('| ' + ' | '.join(cells) + ' |')
    if len(rows) > 1:
        cols = rows[0].count('|') - 1
        rows.insert(1, '|' + ' --- |' * max(cols, 1))
    return '\n'.join(rows)


def docx_to_md(path):
    with zipfile.ZipFile(path) as z:
        body = ET.fromstring(z.read('word/document.xml')).find(W + 'body')
        title = None
        if 'docProps/core.xml' in z.namelist():
            t = ET.fromstring(z.read('docProps/core.xml')).find(DC + 'title')
            title = t.text.strip() if t is not None and t.text else None
    parts = []
    for el in body:
        if el.tag == W + 'p':
            parts.append(para_md(el))
        elif el.tag == W + 'tbl':
            parts.append(table_md(el))
    text = '\n\n'.join(p for p in parts if p)
    if not title:
        h = re.search(r'^#\s+(.+)$', text, re.M)
        title = h.group(1) if h else None
    return title, text


def pdf_to_md(path):
    exe = shutil.which('pdftotext')
    if not exe:
        raise RuntimeError('pdftotext is not installed (poppler-utils); convert the PDF to .docx or install it')
    r = subprocess.run([exe, '-layout', '-enc', 'UTF-8', path, '-'], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f'pdftotext failed with exit {r.returncode}')
    text = r.stdout.strip()
    first = next((ln.strip() for ln in text.splitlines() if ln.strip()), None)
    return first, text


def clean(s):
    return re.sub(r'\s+', ' ', s.replace('"', "'")).strip()


def convert(src, dst):
    ext = os.path.splitext(src)[1].lower()
    title, text = docx_to_md(src) if ext == '.docx' else pdf_to_md(src)
    stem = os.path.splitext(os.path.basename(src))[0]
    title = clean(title or stem)
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(f'---\ntitle: "{title}"\nsource: "{clean(os.path.basename(src))}"\n---\n{text}\n')


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip().split('\n\n')[0] + '\n', file=sys.stderr)
        return 2
    src, out = argv[1], argv[2]
    if not os.path.isdir(src):
        print(f'{src} is not a folder', file=sys.stderr)
        return 2
    if os.path.realpath(src) == os.path.realpath(out):
        print('The output folder must differ from the input folder.', file=sys.stderr)
        return 2
    os.makedirs(out, exist_ok=True)
    done, skipped = 0, []
    for name in sorted(os.listdir(src)):
        path = os.path.join(src, name)
        ext = os.path.splitext(name)[1].lower()
        if ext not in ('.docx', '.pdf') or os.path.islink(path) or not os.path.isfile(path):
            continue
        try:
            convert(path, os.path.join(out, os.path.splitext(name)[0] + '.md'))
            done += 1
        except Exception as e:  # report the reason, never the content
            skipped.append((name, f'{type(e).__name__}: {e}'))
    print(f'converted {done}, skipped {len(skipped)}')
    for name, why in skipped:
        print(f'  skipped {name}: {why}')
    return 1 if skipped else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
