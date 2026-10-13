# Requirement import: what a page file looks like

designc imports a folder of exported pages as requirement stubs. It reads `.html` and `.md` files only and keeps
no page text: a requirement file gets `id`, `title`, `source`, `version` and an empty `elements` list.
Anything else (Word, PDF, Confluence pages over REST) is converted to one of these two shapes first.

## Converting Word and PDF

```
python3 scripts/convert-pages.py <folder-of-docx-and-pdf> <new-output-folder>
```

Standard library only. `.docx` is read directly (headings, lists, tables become markdown). `.pdf` needs `pdftotext`
(poppler) on PATH; without it each PDF is listed as skipped with that reason. Each output file gets front matter
`title` (document title, else first heading, else file name) and `source` (the file name). The report prints counts
and reasons only, never page text. Then import the output folder in designc.

## Fetching Confluence pages

```
CONFLUENCE_TOKEN=<personal access token> python3 scripts/fetch-confluence.py <base-url> <new-output-folder> <page-id>... [--descendants]
```

Standard library only, GET requests only. `<base-url>` is the REST root (Data Center `https://wiki.example.com`, Cloud
`https://example.atlassian.net/wiki`); https is required, http only for localhost. The token is read from
`CONFLUENCE_TOKEN` (Bearer); with `CONFLUENCE_USER` also set it is basic auth for a Cloud API token. `--token-env` and
`--user-env` name other variables. A page id is the number in the page URL. `--descendants` also saves every page below
the ones named. Each page is saved as `<id>.html` with `<title>`, the canonical link, `confluence-page-version` and
the storage-format body, which is the HTML shape below, so the importer needs nothing more. A key such as `HRE-123` in
the title becomes the requirement id; otherwise the id is a slug and a re-import matches by the canonical link. The report
prints counts and HTTP status reasons only, never page text or the token.

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
