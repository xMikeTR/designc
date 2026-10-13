# Requirement import: what a page file looks like

designc imports a folder of exported pages as requirement stubs. It reads `.html` and `.md` files only and keeps
no page text: a requirement file gets `id`, `title`, `source`, `version` and an empty `elements` list.
Anything else (Word, PDF, the REST storage format) is converted to one of these two shapes first.

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
