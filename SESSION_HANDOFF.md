# Session Handoff — 2026-10-13 — "Since last look", Grill-me "I don't know", F# extractor closed

## What we were doing
Closing out the 2026-10-12 briefs (all designc slices 22 to 35 done), housekeeping, then two small features from the user's reading of The Pragmatic Programmer (situational awareness) and learning to answer Grill-me. The F# extractor item was grilled and closed.

## Decisions made this session
1. **Since last look** (Design sidebar, first section): `renderer/look.js` (`Look.snapshot`, `Look.diff`), snapshot per registry in `localStorage`, kept on first sight and on Mark as seen (✓). Lists gate flip, clauses, findings, decision status, drift counts; code map older than 7 days is a note with Re-extract, not a change. At most 8 lines. Display only. No desktop notification (not asked for).
2. **Grill-me "I don't know"** (inline, no handoff to the Tutor): technical questions are researched (`RESEARCH_RULE`: web search, else web fetch because search is blocked at work, else say unsourced; never invent a link), 2 or 3 options with a recommendation, the user chooses. The decision is the user's: rationale "Chosen by the user.", "Suggested by Grill-me: ...", and "User's view: ..." only when the user typed reasons. Business questions are never answered by research: who should answer, options, `PROPOSED:` business decision. Buttons: a reply under Grill-me's last message in the panel, and one per sidebar Grill-me question (`dontKnow`, prefers an ACP agent).
3. The rest of both briefs belongs to System 2. Its `SESSION_HANDOFF.md` (`~/Desktop/Coding/System2/factory-s2-workbook/`) now lists what to build, stale fixtures to re-copy, and the two ledger kinds designc waits on (budget, judge score; strawmen there).

## Decisions NOT yet made
- **Ledger kinds for budget and judge score**: System 2 decides the shape, then designc adds them to `ledger.js`, `ledger_schema.json`, `PIPELINE_KINDS` and the Work digest.
- **GodotAgent build** from handover `20261011-d78a82e7`: grill on the System 2 side.
- **Slice 4 (factory evals out of designc)**: still parked (System 2 handoff, decisions 4 and 5 of 2026-10-11).

## Requirement import, slice A (uncommitted)
Folder of exported pages (`.html`, `.md`) to `requirements/*.yaml` stubs, via the ⇩ button in the Requirements section. Pure core `renderer/requirement-import.js`, folder read `paths.js` `readPages`, IPC `import:choose`/`import:read`, contract `docs/requirement-import.md`. Next: slice B (agent mapping; widens write policy, flag first), slice C (REST reader), Word/PDF converter (need VM tooling facts). Work content is confidential: synthetic fixtures only, no page text in reports.

## F# extractor: closed, not a gap
Read-only extraction over the user's F# codebases (PokemonTournament, DIRPOCv2, factory-s2-workbook, F#Agent, FsharpHarness) is correct; routes and stores live in their C# projects. Only fix: `Anthropic` and `OpenAI` packages (C# and JS) now map to externals in `extract/catalogue.js` (`test/extract-llm-api.test.js`). Go scanner stays dropped; `TournamentManager`'s localhost:8090 client stays unresolved.

## Requirement import, slice B (built)
Grill-me maps one imported page to `elements[]`: `read_import_page` + `map_requirement`, Map to elements button; `RequirementImport.setElements`. `WRITE_PATHS` not widened. Not verified live (native folder dialog and agent); unit and e2e green. Next: slice C (REST storage-format reader).

## Where we got to
- `main` at `2e7051e` pushed; LLM-API catalogue change and docs are uncommitted. Worktrees `app-s1`, `app-s3` and their branches removed.
- `npm test` 684 pass, 0 fail; `xvfb-run -a npx playwright test` 8 passed.
- Not ours, deliberately uncommitted: this file, `sample-registry/ledger/checks.jsonl`, `Evaluation Bible Design-to-Code Factory.md`, `python/build/`, the `obj/Debug` outputs.
- The "I don't know" path is untried against a live agent: the user tries it over ACP (Claude Code).
- Open elsewhere: GodotAgent `ledger/*.jsonl` uncommitted, stray empty files `=` and `project` there; System2 `factory-registry` 6 uncommitted ledger lines (live8, live9; both closes say `abandoned`).

## What to load on restart
- `AGENTS.md`, `ROADMAP.md`, this file.

## Watch out for
- `designc check` appends a `gate` event to the registry ledger (not with `--item`). Use `verify-ledger` or a copy to inspect read-only.
- No commits in `~/Desktop/Coding`: the user commits there.
- Headless runs: `--user-data-dir=<scratch>` with `trustAllFolders: true`, on a registry copy. Never touch `~/.config/designc/state.json`.
- Keep `process.reallyExit(0)` in `will-quit`.
- Never delete, skip or loosen the `@critical` e2e journeys.
- `~/Downloads/APIKEY` exists: do not read or send it.
- Forbidden synonyms: bug/defect (escape), ticket (requirement; target kind `jira`), DoR (gate).
