# Roadmap: designc

Remaining work, in order. Each slice is vertical: registry format, core (JS) plus the Python mirror where the gate or CLI is touched, app UI with buttons, a test, and AGENTS.md updated in the same change.

Sources: `ui-acceptance-playwright.md` and `work-intake-wip.md` (2026-10-12 briefs). Their F# types, the pull scheduler, the verify runner, the dispatcher's ledger fold and the Jira mirror belong to the System 2 workbook, not designc. designc owns the registry formats, the gate, Grill-me, the handover, the ledger kinds it reads, and the views.

Last updated: 2026-10-13. Slice 36 (requirement import, part A) built; parts B and C open. F# extractor item closed: no gap found across the user's F# codebases; Anthropic and OpenAI packages added to the catalogue. Since last look and Grill-me "I don't know" built. Before that, 2026-10-12. Slice 34 built. Drift flag and UI escape rate added. Slice 33 built. Slice 32 built. Slice 31 built. Slice 30 built. Slice 29 built. Slice 28 built. Slice 27 built. Slice 26 built. Slice 25 built. Slice 24 built. Slice 23 built. Slice 22 built. Slice 35 built. Before that: recorded the two briefs, then the scoped-freeze grill: intake moved first, slices renumbered 22 to 35.

## Principles for all slices

- **An agent's claim is never evidence.** "Done", "merged" and "it works" count only when designc can check them: a commit reachable from `main` (`git merge-base --is-ancestor`, through `git.js`), gate and acceptance results recorded at that commit, a ticked checklist or a recorded review. A claim designc cannot verify is shown as such ("Claimed merged, not on main"), never as done.
- **Scope can change.** Anything frozen can be re-checked and re-frozen; nothing is locked forever.

## Already open

- **Build GodotAgent from handover `20261011-d78a82e7`** with a coding agent. Open: how the agent receives the handover, what it writes to the ledger, and whether GodotAgent gets its own git repo first. See `SESSION_HANDOFF.md`.

## designc's own UI (from `ui-regression-gates.md`), first

| Slice | What | Notes |
| --- | --- | --- |
| 35 | **Done 2026-10-12.** **End-to-end tests for designc.** Playwright driving the Electron app (`_electron`), one `@critical` test per main journey (open registry, lint, bind, freeze, extract, Work view), on a copy of `sample-registry`. A Stop hook blocks an agent from finishing while they fail. Agents never delete, skip or loosen them | First (agreed 2026-10-12): it protects every later slice while Claude sessions build designc. Built: `e2e/journeys.spec.js` (open, findings, bind, freeze, extract), Stop hook `scripts/agent-gate.sh`, guard `test/e2e-guard.test.js`. The Work view journey is added with slice 22 |

## Work intake (from `work-intake-wip.md`), next

Why first: today about 8 parallel Claude sessions run with no shared tracking. Principles: plan big, freeze small; pull, don't push; one WIP limit because the human is shared.

Agreed in the grill of 2026-10-12:
- A **work item** is one requirement plus a subset of its elements: usually one Jira ticket and one item, and a cross-container ticket splits into slices.
- An item's elements must be in its requirement's `elements`. Off-scope is flagged, not silently allowed (see slice 23).
- The **scoped gate** counts anything that touches an in-scope element: decisions binding one, findings whose location or `related` names one, acceptance criteria on one. Model-wide errors (parse) block every item.
- An **item handover** holds the whole model and `elements.json` with the item's elements marked `in_scope`, and only the requirements, decisions, criteria and scenarios the item touches. Its id covers that content plus the work item id.

| Slice | What | Notes |
| --- | --- | --- |
| 22 | **Done 2026-10-12.** **Work items, tracked by hand.** `work/*.yaml`: `id, requirement, elements[]` (repo) or `target {document \| jira \| investigation}`, `depends_on[]`, `writes[]` (path patterns), `done_when[]` (`gate`, `checklist`, `review`, `judge`). Rules: a repo item needs a `gate`; a `judge` is never alone. Work view: backlog, New item, **Start** and **Done** per item (records `item_pulled`, `item_done`) so plain Claude sessions are tracked without a dispatcher. Done needs evidence for every `done_when` entry, and for repo items a `commit` reachable from `main`, else it refuses and says what is missing. Conflict check shown on Start: `Work.conflicts(item, active)` (writes overlap by `mayOverlap`, shared element, same document or Jira key). Python mirror of the file rules (`designc work`) | Built as `renderer/work.js` and `renderer/workview.js`, `core.js` untouched. Gate evidence is `item_gate` (the app's Run gates or a pipeline); a judge entry is shown but no score is, as no ledger kind carries one. No fetch before the main check. The Work view journey is the sixth `@critical` e2e test.  "Ticket" is a forbidden synonym for requirement, so the target kind is `jira`. Kinds are snake_case |
| 23 | **Done 2026-10-12.** **Scope flags.** Item names an element its requirement lacks: flagged, cannot freeze, **Add to requirement** (human only). Requirement element in no item: warning, **Add to item** / **New item**. Pipeline contract rule: ask with `needs_decision` (with `element`) before touching an element outside `in_scope`; an unasked change is an escape with origin `translation_error` | Built in `Work.validate` and `Work.coverage` (Python mirror in `work.py`); the origin value itself arrives with slice 33. Coverage judges only requirements that already have a repo item |
| 24 | **Done 2026-10-12.** **Scoped gate and item handover.** `Core.gate` with a work item scope; Freeze item from the Work view; `elements.json` gains `in_scope`; pin `design_version`; record `item_frozen`. Python mirror | Contract change: new schema id `designc.handover.elements/2`. Freeze horizon (WIP + 2) shown | Built: `Core.scopedGate`, `handoverPlan` `item`, `designc check --item`, Freeze item in the Work view. No `item_frozen` kind: the `handover` event carries `item`, and V1 skips it. No forecast in item handovers |
| 25 | **Done 2026-10-12.** **Re-check.** `Core.workRecheck(item, model)`: elements or decisions changed since `design_version` (`changeImpact`, fingerprints), or the item's own scope edited after freeze. Shown on each item with Re-freeze; records `item_recheck` | Built: `Core.workRecheck` is pure over the item handover's model copy; the event is written only when the answer changes. Python has no mirror (display only) |
| 26 | **Done 2026-10-12.** **Digest.** Four buckets from the ledger: Needs decision (oldest first), Failed a gate (including "Claimed merged, not on main" and "Claimed done without evidence"), Done since last look, Waiting (conflict, WIP, budget). Desktop notification only when the first two change. Kinds `item_conflict_deferred`, `item_awaiting_human`, `wip_limit_changed` for the dispatcher. Checklist and review capture for non-repo items | Per-run streams and their fold are the dispatcher's; designc reads the result. Budgets stay out of designc (`docs/pipeline-contract.md`); the cost forecast supplies estimates | Built: `Work.digest`, `Work.digestSignature`, Digest block in the Work view. Checklist and review capture already happens at Done (`workDone` asks per entry). Budget waiting is not shown: no kind carries a budget |

Also: mint the decision "the ledger is the queue's source of truth; Jira is a one-way mirror" (Option A) in the factory registry.

## UI acceptance (from `ui-acceptance-playwright.md`)

Principle: the agent that writes the code never touches the test that judges it. Specs run against the live API (not mocked at the boundary).

| Slice | What | Notes |
| --- | --- | --- |
| 27 | **Done 2026-10-12.** **Acceptance criteria.** `acceptance/*.yaml`: `id, requirement, element` (elements.json id), `decision?`, `states[]`, `locators {name: {role, name}}`, `cases[]` (`state, given, when?, then`). Gate clause when a UI requirement lacks a case for a required state (`forbidden` only where the element or decision declares an auth boundary). Python mirror. Acceptance section with New criterion. Handovers copy the criteria the item touches | UI-facing (agreed 2026-10-12): an element tagged `UI`; a requirement is UI-facing when any of its elements is. A work item cannot freeze without a criterion for each `UI` element in scope. The forbidden state is required only where the element or decision declares an auth boundary. Drift flags an extracted SPA whose design match is not tagged `UI` | Built: `Core.acceptanceClauses`, `acceptance_clauses` in Python, handover copy and `acceptance:` key, Acceptance section. The drift flag: `Core.driftModels` returns `uiUntagged` (an extracted SPA whose design match lacks the `UI` tag), shown in the Code map's Drift section |
| 28 | **Done 2026-10-12.** **Grill-me states.** Ask about every state per UI requirement, and how the user sees each bound decision's failure on a UI element. Draft acceptance criterion as a minted write | Add `acceptance/` to Grill-me `WRITE_PATHS` | Built: Grill-me instructions, `mint_acceptance` tool, `acceptance/` in its ACP write paths |
| 29 | **Done 2026-10-12.** **Locator contract.** Every locator a case names is declared in `locators`; roles from a closed list | Gate clause, not a DC rule (rules come from incidents). Built in `acceptanceClauses` and `acceptance_clauses`: cases name locators in `uses` |
| 30 | **Done 2026-10-12.** **Spec skeletons at freeze.** Freeze generates `tests/acceptance/<element>/<AC>.spec.ts` (deterministic given/when/then skeleton, `getByRole`/`getByLabel` only, "GENERATED, do not edit") into the handover, hashed. The handover also lists the specs the agent's loop runs: its in-scope elements' specs plus those of their callers (`Core.blastRadius`); the full suite runs at merge | Decided: designc at freeze, not S2. Built: `Core.acceptanceSpecs`, `specs:` and `loop_specs:` in `handover.yaml` |
| 31 | **Done 2026-10-12.** **Reserved test path.** Finding when an element's `d.code` may overlap `tests/acceptance/**`; `elements.json` names the reserved paths. Pipeline contract: acceptance results recorded per criterion with `commit`; a new spec must fail on the base branch ("red on base") | Rides on schema `/2` from slice 24. Built as part of DC009 (same source, one owner per file) rather than a new code; `reserved` in `elements.json` /2; the pipeline rules are in `docs/pipeline-contract.md` |
| 32 | **Done 2026-10-12.** **Pipeline reports acceptance failures.** Kind `ui_acceptance_failed {ac, element, task, commit, trace_id}` in `pipeline.jsonl` (V9), shown in Build and the digest | Built: `ui_acceptance_failed` kind, digest Failed entry, Build block. The task id is read as the item id |
| 33 | **Done 2026-10-12.** **Escape origin.** `origin` beside `caught_by`: `spec_gap`, `design_error`, `translation_error`, `gate_gap`. Classify dropdown in Improve. Metrics: UI escape rate, escapes by origin, acceptance first-pass rate, tamper attempts | "Defect" is a forbidden synonym; this stays an escape. Built: `origin` on `escape` and `escape_classified`, `Ledger.escapeMetrics`, Improve blocks. UI escape rate is UI escapes per done item (`uiEscapeRate`), shown beside the count; tamper attempts count unapproved changes under `acceptance/` and `tests/acceptance/` |
| 34 | **Done 2026-10-12.** **Design tokens and UX rules.** `design-tokens/tokens.json` (W3C) copied into the handover; no text size token below the minimum. Criteria gain `ux`: `keyboard`, `focus_order`, `focus_return?`, `breakpoints[]`; skeletons include axe, keyboard, focus and breakpoint checks | Stylelint and the axe run are the pipeline's gates. Built: `Core.tokenClauses` (minimum from `designc.json` `ux.minTextSize`, default 12 px), `ux` on criteria, skeleton tests, tokens copied into the handover, Design tokens section. No colour contrast check: axe does it against the running page |

Out of scope: visual regression screenshots, cross-browser matrix, freeze-time screenshots of a running UI, test suite speed (already sharded).

## Requirement import (slice 36)

Turns a folder of exported Confluence pages into `requirements/*.yaml` stubs. Page text never enters the registry. The user's work content is confidential: design against synthetic fixtures, and reports from the work VM carry counts and reasons only.

- **A. Built.** `.html` and `.md` pages with metadata, review list, new and changed handling (`docs/requirement-import.md`).
- **B. Open.** Agent maps a page to `elements[]`: a read-only reader confined to the import folder, and a narrow writer that sets only `elements` on an existing requirement behind an approval card. This widens `Policy.WRITE_PATHS` to `requirements/`, so flag it before building. One page per agent turn.
- **C. Open.** REST storage-format reader (`ac:` macros) for pages saved by the user's fetch script.
- **Converter. Built.** `scripts/convert-pages.py`: `.docx` with the standard library on the work VM's Python; `.pdf` needs `pdftotext`, which is an install request if PDFs turn up.

## Open questions

- Whether any of the user's pages are PDF (then request `pdftotext`). Slices 22 to 36A are built.
