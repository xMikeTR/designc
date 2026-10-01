# designc-desktop vs the MAF plan's System 1 IDE scope — gap check

Dated 2026-09-25. Scope decided that day: "fully" = the desktop IDE surface the
MAF plan and README assign to it — not the backend factory (MAF host, Postgres
ledger, F# gate, dispatcher, System 2/4 automation), which stays out of scope.
Verified against the actual code by a read-only Explore pass, not against the
docs' claims about themselves. Source docs: `Design-to-code factory
implementation plan (MAF).md` and this app's `README.md`; `system-of-systems.md`
used as background only where it doesn't conflict.

## Verdicts

| # | Capability | Verdict | Evidence | Note |
|---|---|---|---|---|
| 1 | Structurizr editor + live lint DC000-DC006 | **BUILT** | `renderer/core.js:200-343`, `renderer/app.js:227-314` | All 7 rules real, not stubs |
| 2 | C4 sheet | **BUILT** | `renderer/app.js:727-826` | Real auto-layout + badge overlays |
| 3 | Decisions/requirements YAML lifecycle | **PARTIAL** | `renderer/app.js:76-88,405-421,448-452` | No `checked` stage exists, only minted→bound; body is raw YAML text, no field schema |
| 4 | Definition-of-ready gate (5 conditions) | **PARTIAL** | `renderer/core.js:360-388` | 4/5 solid; "P model passes, every behavioural decision has a property" is folded into "decision has *a* passing check" with no P-specific enforcement |
| 5 | Grill-me structured interview | **PARTIAL** | `renderer/app.js:493-523,1001` | Batch of 3-5 questions per call, not one-at-a-time/checkpointed; "one question at a time" is a system-prompt string in the agent-panel role, not code |
| 6 | Handover / Freeze Handover | **BUILT** | `renderer/app.js:453-459` | Real, writes `handovers/*.yaml` + ledger event |
| 7 | Code map + drift | **BUILT at container level; component level MISSING** | `extract.js:42-198` | Everything is `kind:'container'`; no class/component-level extraction (this is slice 2 of `extract-multilang-s1`) |
| 8 | Agent panel: gateway / ACP / AG-UI | **All three client-side BUILT**; AG-UI *host* confirmed sketch | `main.js:211-370`, `acp.js:1-124`, `renderer/agent.js` | `integrations/maf-agui-host/Program.cs` literally says "Sketch, not compiled" |
| 9 | Build dashboard (Langfuse v2/v3) | **BUILT** | `telemetry.js:25-93`, `renderer/app.js:156-177,953-972` | Real API reads + aggregation |
| 10 | Improve / System 4 view | **BUILT** | `renderer/app.js:178-183,974-987,1003-1010` | Real escape suggestions + one-click ledger record |
| 11 | Atlassian MCP intake | **MISSING** | exhaustive grep, zero hits beyond a UI label string | Belongs to the backend harness per the MAF doc, not this app — correctly out of IDE scope, but worth naming since README doesn't say so |
| 12 | Input drift (pinned vs live Jira/Confluence) | **MISSING** | same grep | Same as above |
| 13 | Ledger schema vs MAF's richer shape | **PARTIAL, narrower** | `main.js:174-179` + every `appendLedger` call site | No `stage`/`code`/`severity`/token-split/cost fields; ad hoc shape per kind, no envelope version. See "Ledger" section below â€” `~/.claude/harness` is a mature reference design for fixing exactly this, not a drop-in dependency |

## Ledger: what `~/.claude/harness` actually offers

Checked `event.py` and `ledger_append.py` directly (Python, ~470 + ~550 lines).
It is not code designc can import — different language, different domain (Claude
Code session-quality events: `SessionStarted`, `GateFailed`, `NeedsDecision`,
`BudgetExceeded`, `HumanDecision`, `Done`, `NoteRecorded`, `WorkRecorded`, ... vs
a design-to-code pipeline's `task`/`check`/`decision`/`escape`/`asbuilt_edge`).

What *is* directly reusable is the design, hard-won and documented in the module
headers:

- **A fixed, versioned envelope** (`ENVELOPE_VERSION`, a closed set of kind
  constants) instead of an ad hoc shape per call site. designc's own ledger
  today is the exact failure this module's header describes elsewhere in the
  estate: the same "one JSONL, one hook, one digest" idea built three times
  under three schemas that couldn't be merged.
- **One deterministic append path** that validates before writing, rather than
  every call site building its own object inline (`main.js:174` currently
  accepts and appends whatever shape the caller passes).
- **`resolution-is-an-event-not-a-mutation`** — designc already does this
  independently (README: "It never rewrites a ledger line"; `escape` and
  `handover` are append-only). Good alignment, nothing to change here.
- **Cross-platform atomic-append locking** (`msvcrt`/`fcntl`) — solves
  concurrent writers to one file. Not an active problem today (Electron main
  process is the sole writer); becomes relevant only once a separate pipeline
  process also writes to the same `ledger/*.jsonl`, i.e. after System 2 exists.
  Premature to port now.

**Recommendation:** when tightening item 13, port the *pattern* — a small
`ledger.js` in this app with fixed kind constants matching the MAF doc's
`system`/`stage`/`kind`/`code`/`severity`/`outcome`/token/cost fields, and one
`appendLedgerEvent()` used by every call site instead of five ad hoc object
literals — rather than reaching for the Python module itself.

## What's most worth closing next (my read, not decided)

Ranked by "blocks something else" rather than doc order:
1. **#13 ledger schema** — cheap, mechanical, and every dashboard/gate reads this data; tightening it now avoids a second migration later.
2. **#3 decisions `checked` stage** — the gate (#4) and grill-me (#5) both assume a real lifecycle; right now `minted -> bound` skips the state the doc's gate logic is written against.
3. **#5 grill-me one-at-a-time** — currently the single biggest gap between "looks like grill-me" and "is grill-me" per the doc's own description.
4. **#7 component-level code map** — already an agreed, planned, in-flight slice (`extract-multilang-s1`, slice 2).
5. **#4 P-specific gate condition** — small, well-scoped once #3 exists.

#11/#12 (Atlassian intake, input drift) are correctly out of scope for the
desktop IDE per the MAF doc's own executor split — flagging only so the README
says so explicitly rather than leaving it to be discovered by absence.
