# Requirement import: what a page file looks like

designc imports a folder of exported pages as requirement stubs. It reads `.html` and `.md` files only and keeps
no page text: a requirement file gets `id`, `title`, `source`, `version` and an empty `elements` list.
Anything else (Word, PDF, the REST storage format) is converted to one of these two shapes first.

## Converting Word and PDF

```
python3 scripts/convert-pages.py <folder-of-docx-and-pdf> <new-output-folder>
```

Standard library only. `.docx` is read directly (headings, lists, tables become markdown). `.pdf` needs `pdftotext`
(poppler) on PATH; without it each PDF is listed as skipped with that reason. Each output file gets front matter
`title` (document title, else first heading, else file name) and `source` (the file name). The report prints counts
and reasons only, never page text. Then import the output folder in designc.

## Markdown (the converter contract)

```markdown
---
id: HRE-1234            # optional; else a key like ABC-123 in the title or file name; else a slug of the title
title: Referral status updates keep underwriter edits
source: https://wiki.example/pages/12345    # the page URL
version: 7              # the page version; else a hash of the text, so any edit reads as a new version
---
# Referral status updates keep underwriter edits

Body text. Never copied into the registry.
```

## HTML (Confluence export)

`<title>` or the first `<h1>` is the title. `<link rel="canonical" href>` or `<meta name="source">` is the source.
`<meta name="confluence-page-version" content>` or `<meta name="version">` is the version.

## Rules

- A page with no title is listed as invalid with the reason; nothing is guessed.
- Two pages in one import with the same id: the first is imported, the other is listed as invalid.
- Re-import: same id and version is unchanged; a different version is changed and updated only when a person approves.
  A changed version blocks any bound business decision on that requirement until it is re-bound.

## Mapping to elements (agent)

An imported requirement is untraced until it lists elements. "Map to elements" (Requirements list, or the gate clause) asks Grill-me to read that one page (`read_import_page`, only from the folder chosen in this session; designc does not remember it) and propose element names with `map_requirement`. Nothing changes without approving the card, and only the `elements` line of the requirement file is rewritten. The page text goes to the model the panel uses.
