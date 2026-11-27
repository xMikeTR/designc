# Feature map: the contract

The feature map says what a user can do with the app, in the user's words, how they reach each thing, and what end state proves it works. It is the index an agent reads before it drives the app: it turns "the export on bordereaux doesn't work" into a screen, a state, the elements behind it, and a journey to replay. It follows Lauren Tan's verification skills (pstack, MIT): a map kept in the repo, one file per feature, maintained by a loop that reads source and drives every feature live.

Status: **slice 1 built** (the format, the schema and example, the reader `renderer/featuremap.js`, checks 1 to 4 as the Problems codes FM001 to FM004, the Features list in the Work view, seed features in the fixtures). **The executor and the ready probe are built** (`recorder/journey.js`, `scripts/feature-run.js`; see [The Factory side](#the-factory-side-not-built), Runner). **The `feature_result` ledger row and `done_when: feature` are built** (S12b; the Factory records the row in S13). **Everything else is still design**: checks 5 and 6, the handover, the Factory side, escapes and the maintenance loop. Sections not built say so. [Slices](#slices) gives the build order.

**The split.** As with acceptance criteria and the UI contract: designc owns what a feature is and how it is proved (`features/*.yaml`, checks, approvals). It never runs app code. The Factory drives the app, judges journeys and writes `feature_result`. Read with [ui-contract.md](ui-contract.md), [parity-contract.md](parity-contract.md) and [pipeline-contract.md](pipeline-contract.md).

### Why a map, when specs and scenarios exist

| Already in the registry | Answers | Doesn't answer |
| --- | --- | --- |
| Screen spec `states` / `transitions` | How one screen moves between states | What the user calls it; how they get there from elsewhere; what happens outside the screen |
| Parity scenario | Does the new app match legacy on this path | Whether the path does the job (side effects); new features with no legacy |
| Test scenario (BDD) | One case of a requirement | The live recipe: locators, entry points, the second view that proves it |
| Acceptance criterion | What must hold for one element | How a user reaches it |

A feature references all four by id. It adds three things none of them have: **user vocabulary** (aliases a bug report would use), **every entry point**, and **proof of the side effect** through a second, read-only view.

### Files in the registry

| Path | What | In git |
| --- | --- | --- |
| `features/<id>.yaml` | One user-facing feature (format below) | yes |
| `docs/feature.schema.json`, `docs/feature.example.yaml` | The shape of a feature file, and a worked example (Appendix A's) | yes |
| `designc.json` `verify.ready` | What "usable" means for a running app (see [Ready](#ready-not-just-up)) | yes |
| Run evidence: traces, ARIA trees, screenshots, API bodies | Proof of one journey at one commit | no: in the Factory's run dir, like parity shots; may hold data |

### The format

```yaml
id: bordereaux-export
title: Export bordereaux
intent: An underwriter exports the bordereaux they are looking at, with the filters applied, as a spreadsheet.
aliases: [export button, download bordereaux, export to excel]
screens: [bordereaux]                # ids in ui/specs/
elements: [Ui.BordereauxPage, Api.BordereauxExport]   # model element ids
requirements: [RE-1234]
acceptance: [AC-12, AC-13]           # optional: criteria this feature exercises
test_scenarios: [TS-7]               # optional

preconditions:
  role: underwriter                  # the sign-in the app must run as (mock mode in practice)
  data: { cedant: {param: cedant} }  # params, as in parity: values per environment, never real data

entry_points:
  - id: header-button
    from: bordereaux:ready           # <screen>:<state>
    via: { click: { role: button, name: Export } }
  - id: shortcut
    from: bordereaux:ready
    via: { press: Control+E }
  - id: deep-link
    via: { goto: { path: /bordereaux?export=1 } }

journeys:
  - id: export-filtered
    from: bordereaux:ready
    steps:
      - fill: { role: combobox, name: Cedant, value: {param: cedant} }
        state: filtered
      - entry                        # run each entry point here, one journey run per entry point
      - wait: { role: status, text: Export ready }
    proves:
      ui: { state: filtered, contains: [{ role: link, name: Download }] }
      effect:
        api: { method: GET, path: /api/bordereaux/exports/:id }
        expect: { status: 200, shape: { rows: [{ cedant: "text:Aa" }] } }

gotchas:
  - The export is built in the background; wait for the status, never a fixed sleep.
  - The shortcut does nothing while focus is in the Cedant combobox.

sync: { commit: 3f2a9c1, at: 2026-11-22, by: mike }
```

### Rules

- **Step grammar is parity's**: one action per step, `goto {path}`, `click`, `fill`, `select` `{role, name, index?, value?}`, values may be `{param: name}`, `state` names the spec state the step leaves the app in. The map adds `press <keys>`, `wait {role, name? | text?}` and the bare `entry` marker. One executor runs parity scenarios and feature journeys.
- **`text` is not `name`.** A status or live region's text is not its accessible name. `wait` and `contains` take `text` for those.
- **Every journey runs once per entry point**, at the `entry` marker or, with no marker, before the first step. A journey with no `entry` and an entry point whose `from` differs from the journey's `from` is a problem. Reaching a feature one convenient way is not proof that the others work.
- **`proves` is required**, with at least `ui`. `ui.state` must be a state of that screen's spec. `effect` is required when any step crosses a spec transition marked `commits` (the UI saying "saved" is not proof that anything was saved). `effect.api` is a read-only call (`GET`/`HEAD`), and `expect.shape` uses parity's shapes, never values.
- **Preconditions are stated, never weakened.** If the data a journey needs is not there, the journey is `could_not_run` and the reason belongs in `gotchas`. A journey is never edited to make it pass.
- **No implementation in the file.** Locators, paths, keys and user-visible text only. Code is reached through `elements` and the code map.

### Checks (designc, document only)

Checks 1 to 4 are built (slice 1) as their own Problems codes, **FM001 to FM004**, not `DC` codes: they are error rows under the feature file, never gate clauses and never in `Core.RULES`, so the gate and handover ids do not change. The Python CLI, the language server and `designc-core` do not report them. `features/` is a gate input only for the dirty check (a feature file with uncommitted changes blocks a freeze, like `landings/`). A ctx input the app could not read (the model did not parse, requirements not read) skips the sub-check that needs it: unknown is never a problem. All are Problems; none run code.

1. **Ids (FM001).** `id` present, a slug, equal to the file's base name and unique across `features/` (`x.yaml` beside `x.yml` is a duplicate); `title` and `intent` non-empty; `screens` a non-empty list, each in `ui/specs/`; `elements` in the model (by element id or name); `requirements`, `acceptance`, `test_scenarios` exist; `aliases` a list of strings.
2. **States (FM002).** A `from` is `<screen>:<state>` with the screen one of the feature's `screens`. Every `from`, step `state` and `proves.ui.state` is a state of that screen's spec; a bare state belongs to the current screen (the journey's `from` screen, or the screen of the latest `<screen>:<state>` step). Every `from` state is reachable from the spec's one initial state over all transitions (skipped when the spec has not exactly one initial state: `ui.js` reports that). A journey with no `entry` marker and an entry point whose `from` differs from the journey's `from` is a problem.
3. **Grammar (FM003).** `journeys` a non-empty list of `{id, from, steps, proves}`; `entry_points` an optional list of `{id, from?, via}`, ids slugs and unique, `via` exactly one step that is not `entry`. Steps parse (`goto`, `click`, `fill`, `select` through parity's own `Parity.stepProblem`, unchanged; `press` a non-empty string; `wait` `{role, name}` or `{text}`); `entry` appears at most once; every `{param: x}` in steps or `via` is declared under `preconditions.data`.
4. **Proof (FM004).** `proves.ui.state` present (`contains` optional, `{role, name}` or `{role, text}`); `proves.effect` present where a step crosses a `commits` transition (the spec of the current screen has a transition from the state before the step, to the step's `state`, marked `commits: true`); `effect.api.method` is `GET` or `HEAD` and `path` starts with `/`. `expect.shape` is **not checked** in slice 1.
5. **Coverage** (not built; display only, never a gate input, like "not automated yet"): spec states no journey reaches, and in-scope UI elements of a frozen item that no feature names.
6. **Stale** (not built; display only): a file under the feature's screens' `ui.graph` roots or its elements' code areas changed after `sync.commit`. The map may no longer describe the app; the [maintenance loop](#maintenance) clears it.

### Ready, not just up (built in `recorder/journey.js`)

`designc.json`:

```json
"verify": { "ready": { "goto": "/", "expect": { "role": "heading", "name": "Bordereaux" }, "api": { "method": "GET", "path": "/health" } } }
```

Before the first journey, and again after any journey that failed in a way the Factory did not expect, the driver checks this: the page renders a signed-in screen and the API answers. A health endpoint alone is not ready; a data read can still fail behind it. A failed ready check makes every journey `could_not_run`, never `fail`. The Factory never drives an instance it did not start.

As built: `ready(session, cfg)` acts `goto`, checks `expect` (`{role, name}` or `{role, text}`) in the captured tree, and, when `api` is set, calls `session.request({method, path})` and needs a 2xx status. `api.method` must be `GET` or `HEAD`, otherwise the probe fails without calling. No `verify.ready`, or an `api` check on a session with no `request`, is a failed probe with a message that says why: never a pass.

### Handover (not built)

An item handover adds `features: [{id, path, sha256}]`: every feature that names one of the item's `in_scope` elements or screens, frozen by hash like specs. The pipeline reads, never writes, `features/`. Adding a journey is a design change, made in designc.

### The Factory side (executor built; Factory parts not built)

- **Reader.** `WorkRegistryReader` reads `features/*.yaml` the way it reads `parity/scenarios/` (only what it needs; a file it cannot read is a problem, not a crash).
- **Briefs.** The implementer's and test author's brief lists the handover's features for the task's elements, with entry points and `proves`. The `playwright_cli` self-check follows them instead of exploring.
- **Repro.** `s2-repro` matches a bug summary to features by `aliases`, `title` and screen, then replays the matching journeys on every entry point. No match is itself a finding (see [Escapes](#escapes)).
- **Runner.** `factory-s2 features --repo --handover [--feature <id>] [--journey <id>]` launches the app the way QA does, runs the ready check, then runs each journey × entry point. Per journey it keeps a Playwright trace, the ARIA tree and a screenshot at `proves.ui`, and the `effect` response, in the run dir. Exits as parity: `0` pass, `1` a journey failed, `2` an error (nothing judged), `3` could not run.
- **Result.** One `feature_result` per feature at a commit, written with `designc record`.

**The executor (built, designc side).** `scripts/feature-run.js --registry <dir> --feature <id|all> [--journey <id>] [--adapter web|fixture:<file>] [--base-url <url>] [--param n=v]... [--allow-writes] [--out <dir>] [--json]` runs `recorder/journey.js` through the same adapters as parity and prints, per feature, `{feature, outcome, journeys: [{journey, entry, outcome, failures}]}` (the `feature_result` row without `kind`, `commit` or `by`). It writes no ledger; `--out` keeps each run's final capture (`.json`) and screenshot (`.png`) outside the registry. Exit: `0` pass, `1` a journey failed, `2` an error (a feature file that does not parse or has an FM problem is refused), `3` could not run. Parity's grammar and meaning are unchanged: `scenarioProblems` still rejects `press`, `wait` and `entry`.

- **Every run starts from the ready page.** Each run opens a fresh session, the ready probe does `goto verify.ready.goto`, and the steps continue from there. A journey that needs another start puts a `goto` first.
- **Outcomes per run.** The ready probe fails, a `{param}` is missing, a committing click (parity's `COMMITS` rule) is not allowed, or the adapter reports a login wall: `could_not_run`. The adapter reports a missing control, or throws: `fail`, kind `step` (for a feature the app under test is the new app, so a missing control is a real failure). Each `proves.ui.contains` item absent from the final capture: `fail`, kind `state`, one failure per item. Otherwise `pass`. `step` is 1-based over the expanded run steps (0 for the ready probe); failures are capped at 50. Feature outcome: `fail` if any run failed, else `could_not_run` if any could not run, else `pass`.
- **Matching.** `{role, name}` is an exact accessible name (with `index`); `{role, text}` is a node of that role whose subtree's names, joined with spaces, include the text.
- **Not judged yet.** `proves.ui.state` has no visible signature and `proves.effect` is a read-back: both are the Factory's job (S13). A run whose journey has an `effect` carries `effect: 'unchecked'` in the executor's result, so a `pass` here does not mean the effect holds. Step `state` keys are carried and not acted on.
- **Adapters.** Session `act` also takes `{press: '<keys>'}` and `{wait: {role, name | text}}`; the session has `request({method, path})` -> `{status}`. The fixture adapter follows the first `on` entry `{screen, press: '<keys>', go}` for `press` (else does nothing), finds a `wait` target on the current screen, and answers `request` from `api: {'GET /health': 200}` (404 when not listed).

### The ledger row (built)

`feature_result {feature, commit, outcome, journeys[{journey, entry, outcome, failures?[≤50 {step, kind, msg}]}], item?}` in `pipeline.jsonl`, a Factory kind like `ui_result`. `outcome` is `pass` (every journey × entry point passed), `fail` (any failed) or `could_not_run` (none failed, at least one could not run). A `failure.kind` is `step` (an action could not complete), `state` (`proves.ui` did not hold), `effect` (the read-back failed or had the wrong shape) or `ready`. No trees, bodies or data in the row. The schema is `FINAL_KIND_FIELDS.feature_result` with the rule `journeys_shape` (`renderer/ledger.js`, mirrored in `python/designc/ledger.py`); the row's `outcome` must agree with its journeys. Example: `docs/feature-result.example.json`.

### Done (built)

A work item may list `feature: <id>` in `done_when` (repo items only, beside a `gate`). It is met when the latest `feature_result` for that feature at the item's done commit, recorded before `item_done`, is `pass`. `could_not_run` leaves it unmet. In the Factory this is a new `Check` case, `Feature of string`, judged like `Parity`. In designc, `Work.validate({features})` checks the id against the base names of `features/*.yaml|yml` (`null` means not judged; Python `feature_ids`) and `Work.doneProblems` judges the row. A `feature` entry is not the `gate` a repo item needs.

### Escapes (not built)

When QA finds a bug the map would have caught:

- **A journey exists and passed:** its `proves` was too weak. The countermeasure (`NewGate`) strengthens `proves` (`Strengthens: <feature>/<journey>`).
- **No journey covers it:** origin `gate_gap`; the countermeasure is a new journey or entry point.
- **The bug report matched no feature:** a vocabulary gap; add the reporter's words to `aliases` or a new feature.

Each becomes a map change in designc, approved by a person, so the same kind of bug cannot reach QA twice through the same gap.

### Maintenance (not built)

A map rots when the app changes. The loop, adapted from Lauren's `maintain-verification-skill`:

1. **designc, source wave** (agent stage `feature-map`, read-only, proposals only): for each stale feature, read the code map and the screens' code, and propose changes to locators, entry points or states as diff cards. Unmapped spec states and in-scope elements become proposed journeys.
2. **Factory, live pass** (`factory-s2 features --all`): drive every feature on one instance. Report each failure as **map drift** (the app does what the user needs but the map describes it wrongly: propose a map fix) or **regression** (the app no longer does it: an escape, kept out of the map change).
3. **A person approves** the map changes. Approving moves each changed feature's `sync.commit` to the commit the live pass ran at; a feature whose live pass did not finish keeps its old `sync`.

Run it after a screen migration lands, when routes or controllers change, or when Stale shows up. Never on a schedule nobody reads.

### Invariants

- designc never runs app code; the Factory never writes `features/`.
- A journey is never weakened to pass. A failure is drift or a regression, and the report says which.
- Proof uses the real user path and a second, read-only view. No test-only endpoints, no internal setters.
- Evidence stays out of git; rows carry outcomes, not data.

### Slices

1. **designc, format and checks** (built). Node only: Python has no features reader (the Python side mirrors only the `feature` done kind, slice 2). `renderer/featuremap.js`, `docs/feature.schema.json` and `docs/feature.example.yaml`, checks 1–4, a Features list in the Work view (`renderer/featureview.js`). Three seeds in the fixtures; seed three to five real ones by hand from existing specs and parity scenarios.
2. **Factory, runner and result.** Reader, `factory-s2 features`, `feature_result` via `designc record`, `Check.Feature`. Verified live against one real screen before anything else.
3. **Briefs and repro.** Features in the implementer and test-author briefs; `s2-repro` matching by aliases.
4. **Stale and coverage.** Checks 5–6 using the UI graph and code map.
5. **Maintenance loop.** The `feature-map` stage and `features --all` live pass.

### Open questions

- Should `feature_result` per journey be separate rows, so `done_when: feature: <id>/<journey>` can name one journey? Starting with one row per feature keeps the ledger small.
- Keyboard entry points (`press`) are out of scope for parity tier 1. The map needs them; the shared executor must support them without changing parity's meaning.
- Who may move `sync.commit` without a live pass, if anyone? Default: nobody.
