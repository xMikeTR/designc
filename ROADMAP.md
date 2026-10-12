# Roadmap: designc

Remaining work, in order. Each slice is vertical: registry format, core (JS) plus the Python mirror where the gate or CLI is touched, app UI with buttons, a test, and AGENTS.md updated in the same change.

Sources: `ui-acceptance-playwright.md` and `work-intake-wip.md` (2026-10-12 briefs). Their F# types, the pull scheduler, the verify runner, the dispatcher's ledger fold and the Jira mirror belong to the System 2 workbook, not designc. designc owns the registry formats, the gate, Grill-me, the handover, the ledger kinds it reads, and the views.

Last updated: 2026-10-12. Slice 22 built. Slice 35 built. Before that: recorded the two briefs, then the scoped-freeze grill: intake moved first, slices renumbered 22 to 35.

## Principles for all slices

- **An agent's claim is never evidence.** "Done", "merged" and "it works" count only when designc can check them: a commit reachable from `main` (`git merge-base --is-ancestor`, through `git.js`), gate and acceptance results recorded at that commit, a ticked checklist or a recorded review. A claim designc cannot verify is shown as such ("Claimed merged, not on main"), never as done.
- **Scope can change.** Anything frozen can be re-checked and re-frozen; nothing is locked forever.

## Already open

- **Build GodotAgent from handover `20261011-d78a82e7`** with a coding agent. Open: how the agent receives the handover, what it writes to the ledger, and whether GodotAgent gets its own git repo first. See `SESSION_HANDOFF.md`.
- **F# extractor gaps** (container routes, stores, links). Start with `/grill-me` in its own session. No Go scanner.
- **Remove merged worktrees** `app-s1` and `app-s3` and their branches (recommended, not yet confirmed).

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
| 23 | **Scope flags.** Item names an element its requirement lacks: flagged, cannot freeze, **Add to requirement** (human only). Requirement element in no item: warning, **Add to item** / **New item**. Pipeline contract rule: ask with `needs_decision` (with `element`) before touching an element outside `in_scope`; an unasked change is an escape with origin `translation_error` | |
| 24 | **Scoped gate and item handover.** `Core.gate` with a work item scope; Freeze item from the Work view; `elements.json` gains `in_scope`; pin `design_version`; record `item_frozen`. Python mirror | Contract change: new schema id `designc.handover.elements/2`. Freeze horizon (WIP + 2) shown |
| 25 | **Re-check.** `Core.workRecheck(item, model)`: elements or decisions changed since `design_version` (`changeImpact`, fingerprints), or the item's own scope edited after freeze. Shown on each item with Re-freeze; records `item_recheck` | |
| 26 | **Digest.** Four buckets from the ledger: Needs decision (oldest first), Failed a gate (including "Claimed merged, not on main" and "Claimed done without evidence"), Done since last look, Waiting (conflict, WIP, budget). Desktop notification only when the first two change. Kinds `item_conflict_deferred`, `item_awaiting_human`, `wip_limit_changed` for the dispatcher. Checklist and review capture for non-repo items | Per-run streams and their fold are the dispatcher's; designc reads the result. Budgets stay out of designc (`docs/pipeline-contract.md`); the cost forecast supplies estimates |

Also: mint the decision "the ledger is the queue's source of truth; Jira is a one-way mirror" (Option A) in the factory registry.

## UI acceptance (from `ui-acceptance-playwright.md`)

Principle: the agent that writes the code never touches the test that judges it. Specs run against the live API (not mocked at the boundary).

| Slice | What | Notes |
| --- | --- | --- |
| 27 | **Acceptance criteria.** `acceptance/*.yaml`: `id, requirement, element` (elements.json id), `decision?`, `states[]`, `locators {name: {role, name}}`, `cases[]` (`state, given, when?, then`). Gate clause when a UI requirement lacks a case for a required state (`forbidden` only where the element or decision declares an auth boundary). Python mirror. Acceptance section with New criterion. Handovers copy the criteria the item touches | UI-facing (agreed 2026-10-12): an element tagged `UI`; a requirement is UI-facing when any of its elements is. A work item cannot freeze without a criterion for each `UI` element in scope. The forbidden state is required only where the element or decision declares an auth boundary. Drift flags an extracted SPA whose design match is not tagged `UI` |
| 28 | **Grill-me states.** Ask about every state per UI requirement, and how the user sees each bound decision's failure on a UI element. Draft acceptance criterion as a minted write | Add `acceptance/` to Grill-me `WRITE_PATHS` |
| 29 | **Locator contract.** Every locator a case names is declared in `locators`; roles from a closed list | Gate clause, not a DC rule (rules come from incidents) |
| 30 | **Spec skeletons at freeze.** Freeze generates `tests/acceptance/<element>/<AC>.spec.ts` (deterministic given/when/then skeleton, `getByRole`/`getByLabel` only, "GENERATED, do not edit") into the handover, hashed. The handover also lists the specs the agent's loop runs: its in-scope elements' specs plus those of their callers (`Core.blastRadius`); the full suite runs at merge | Decided: designc at freeze, not S2 |
| 31 | **Reserved test path.** Finding when an element's `d.code` may overlap `tests/acceptance/**`; `elements.json` names the reserved paths. Pipeline contract: acceptance results recorded per criterion with `commit`; a new spec must fail on the base branch ("red on base") | Rides on schema `/2` from slice 24 |
| 32 | **Pipeline reports acceptance failures.** Kind `ui_acceptance_failed {ac, element, task, commit, trace_id}` in `pipeline.jsonl` (V9), shown in Build and the digest | |
| 33 | **Escape origin.** `origin` beside `caught_by`: `spec_gap`, `design_error`, `translation_error`, `gate_gap`. Classify dropdown in Improve. Metrics: UI escape rate, escapes by origin, acceptance first-pass rate, tamper attempts | "Defect" is a forbidden synonym; this stays an escape |
| 34 | **Design tokens and UX rules.** `design-tokens/tokens.json` (W3C) copied into the handover; no text size token below the minimum. Criteria gain `ux`: `keyboard`, `focus_order`, `focus_return?`, `breakpoints[]`; skeletons include axe, keyboard, focus and breakpoint checks | Stylelint and the axe run are the pipeline's gates |

Out of scope: visual regression screenshots, cross-browser matrix, freeze-time screenshots of a running UI, test suite speed (already sharded).

## Open questions

- None at the moment.
