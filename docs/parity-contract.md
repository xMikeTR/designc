# Legacy parity: the contract

designc holds a new app to its legacy app: it should look and behave the same unless a business requirement says otherwise. This page is for whoever records the two apps and wires the comparison into a pipeline. The meaning lives in `renderer/parity.js` (pure, dual-loaded); the cases every implementation must agree on are `docs/parity-cases.json` (run by `test/parity-snapshot.test.js` and `test/parity-diff.test.js`).

## What is compared

Shape, never data. A snapshot keeps the accessibility tree (role and name), interface text with volatile parts replaced (numbers `#`, times `<time>`, dates `<date>`, GUIDs `<guid>`), whether each control is enabled, and the *format* of data (`date:dd/0d/dddd`, `num:#,##0.00`, `text:Aa`). A table keeps its columns, the dominant shape per column, a record count and one template record. Values are dropped before anything is written, so a baseline holds no customer data.

| Finding | Fails when |
| --- | --- |
| `missing`, `extra` | an element is on one side only and no requirement covers it |
| `text` | interface text differs |
| `shape` | a value's format differs (per column for tables) |
| `state` | enabled on one side, disabled on the other |
| `order` | matched elements appear in a different order |
| `sort`, `filter` | a step's `expect` held on legacy but not on the new app (each side is judged alone) |
| `spacing` | a height or gap differs by more than 2 px, only when both viewports are the same |
| `step` | a step ran on legacy but failed or was blocked on the new app |

A step that could not run (missing element or param, an earlier step stopped) makes the scenario `could_not_run`: not a failure, and never a pass. Out of scope for tier 1: colours, fonts, keyboard, and empty, error and loading states (acceptance criteria cover those). Tier 1 never reads a screenshot.

### Tier 2: pixels

`renderer/parity-visual.js` (pure, dual-loaded) compares the legacy and the new app's screenshot of each step that ran on both sides. A pixel is changed when a channel differs by more than 8 (anti-aliasing is not a finding); the ratio is changed pixels over all pixels, and the scenario's worst step decides. Images of different sizes never match. It is judged against `threshold` (default 0.001, 0.1%).

Scenario fields: `threshold: <0..1>`, and `mask: [<CSS selector>, ...]`, which Playwright paints over in both apps' screenshots (volatile areas: a clock, the signed-in user, anything that is data). Pixels see data, which tier 1 does not, so a screen whose records differ between the two apps needs those regions in `mask:`. Do not confuse it with `masks:` (tree masks, tier 1).

To get the same pixels twice the web adapter freezes the clock (`parity.<side>.clock`, an ISO time, default 2024-01-15T10:00:00Z), disables animations, hides the caret, and already pins viewport, locale and timezone. Fonts are the machine's: compare on the machine that recorded the baseline.

The result is `visual {ratio, threshold, outcome}` with outcome `pass`, `fail` or `skipped`, in the report (with `failedSteps`) and on the `parity_result` row. **It is additive: the row's `outcome` stays tier 1.** A step with no shot on either side, or whose shot is not on this machine (shots are not in git), is skipped, and a scenario with nothing compared is `skipped`: never a pass. Tier 3 (the vision checklist) is the advisory `item_judge` / `ux_judge`.

Not done yet: a person-approved exception for a scenario that is meant to look different. It needs a new key on a bound business decision, which touches `records.js`, `records.py` and the schema.

## What covers a difference

- Added or changed element: a locator `{role, name}` in an `acceptance/*.yaml` criterion.
- Removed element: a **bound business** decision with `removes: [{role, name, screen?}]`. `screen` limits it to scenarios with that `screen`.

A covered difference is reported as `covered` and does not fail.

## Files in the registry

| Path | What | In git |
| --- | --- | --- |
| `parity/scenarios/<id>.yaml` | `id, title?, screen?, steps[], params {legacy, next}?, masks[]?, test_scenarios[]?` | yes |
| `test-scenarios/<id>.yaml` | one BDD case proving part of a requirement: `id, requirement, title, given[], when[], then[], by?` (see below) | yes |
| `parity/baselines/<id>/legacy.json` | the normalised legacy snapshot; with `--har` also `requests` (shapes only) | yes |
| `parity/reports/<id>.json` | the latest comparison: the new app's snapshot and every finding | yes |
| `parity/shots/<sha256>.png` | screenshots, by content hash | no (`parity/shots/.gitignore`) |
| `parity/har/<id>-<side>.har` | the HAR a `--har` run recorded; holds page data | no (`parity/har/.gitignore`, written by the CLI) |
| `parity/qa/<screen>.yaml` | the bugs QA logged on a screen (see "QA bugs") | yes |
| `parity/qa/shots/*` | screenshots QA attached; may show real data | no (`parity/qa/shots/.gitignore`) |

A step has exactly one action: `goto {path}`, `click`, `fill` or `select` `{role, name, index?, value?}`. `index` picks the nth match (records by position, never by value). A value may be `{param: name}`, taken from the side's params, so each app gets its own test data. `state` is optional: a name for the screen state the step leaves the app in (`list`, `apply dialog`), so QA bugs can say where they happen; without one the state is `<scenario id> step <n>`. `expect` is optional: `sorted: <column>` or `filtered: {column, contains}`. A mask is `{column | role, name, mode}` with mode `ignore` (no shape kept), `shape` (treat as data) or `exact` (a vocabulary word: compare the text).

`test_scenarios` is a list of `test-scenarios/` ids this parity scenario proves; one scenario may prove several cases. An unknown id is a registry problem shown in Problems, never a parity failure, and a test scenario with no parity scenario is shown as "not automated yet". Neither reaches the gate.

## The recorder CLI

```
node scripts/parity-record.js --registry <dir> --scenario <id|all> --side <legacy|next>
  [--adapter web|fixture:<file.json>] [--base-url <url>] [--param name=value]...
  [--commit <sha>] [--item <work item>] [--ledger] [--by <name>] [--no-shots] [--har]
  [--allow-writes] [--allow-request <url part>]... [--json]
```

- `--side legacy` writes the baseline. `--side next` compares with it, writes the report and, with `--ledger`, appends one `parity_result` per scenario through `ledger-store.js` (the CLI is the only writer of that kind).
- Adapter params come from `designc.json` `parity.legacy` / `parity.next` (`baseUrl`, `viewport`, `locale`, `timezoneId`, `headless`), then the scenario's `params.<side>`, then `--param`; `--base-url` wins. Secrets never go there.
- The web adapter needs `playwright-core` and Chromium on the machine that can reach both apps. It runs en-GB, Europe/London, 1280×800 by default.
- Read-only by default: a click whose name looks like it commits (Save, Apply, Delete, Submit…) is `blocked`, and the web adapter aborts every request that is not GET, HEAD or OPTIONS. Only the person running it may pass `--allow-writes` or `--allow-request`; a pipeline never should against a live legacy app.
- A login wall stops the scenario: a redirect to another host, or a page with exactly one visible password field. On legacy it is an error and the baseline is left as it was, so a sign-in page can never become the baseline; on the new app the scenario is `could_not_run`. The recorder does not sign in. Run the apps with sign-in off, such as a local copy in mock mode. It cannot see a sign-in page on the same host that shows no password field yet (email first), so look at the first baseline's screenshot.
- `--har` also records the requests the app made (see "Requests"). It needs a base URL, and `parity/har/` is git-ignored because a HAR holds page data.
- Exit: `0` pass (or baseline recorded), `1` a scenario failed, `2` an error (no baseline, bad scenario, adapter could not open; nothing judged), `3` a scenario could not run. With several scenarios the worst wins: 2, then 1, then 3.

## Requests

`--har` records what the app asked its server for, so a rebuilt screen can be held to the same endpoints and payload shapes. Same rule as the tree: shapes, never data.

- **Recording.** The web adapter passes `recordHar: {path: parity/har/<scenario>-<side>.har, content: 'embed', mode: 'minimal', urlFilter: <origin of baseUrl>/**}` to `browser.newContext`, and `close()` awaits `ctx.close()` before `browser.close()` because Playwright writes the HAR only when the context closes. The fixture adapter has a `requests: [{method, path, status?, request?, response?}]` field (real JSON values) and writes the same kind of HAR on close. The HAR holds data, so it stays on the recording machine (git-ignored); only the baseline's `requests` is committed.
- **`Parity.requests(har, {baseUrl})`** (pure, `renderer/parity.js`) returns `[{method, path, status, request, response}]` in recorded order, identical rows once. Only requests to `baseUrl`'s origin that are data requests are kept: `_resourceType` is not `document`, `script`, `stylesheet`, `image`, `font`, `media`, `manifest` or `texttrack` (or, with no `_resourceType`, the response is JSON or the method is not GET). `path` is the URL path without the query, with each numeric or uuid segment replaced by `:id` (`/api/bordereaux/17` is `/api/bordereaux/:id`). `status` is the HTTP status (0 when unknown).
- **`request` and `response`** are `null` for no body, otherwise a shape of the body: a JSON object keeps its keys and shapes each value, an array is a one-element array holding the shape of its first element (the tier 1 one-record rule: a count is data) or `[]` when empty, a string or number is `Parity.shape(String(value))` (`text:Aa`, `num:$#,##0`, `date:dddd-dd-0d`), a boolean is `bool`, `null` is `null`. A body that is not JSON is one `shape` of its first 200 characters. A base64 body (`content.encoding`) is decoded first.
- **Where it lands.** `legacy.json` gets a top-level `requests` array after `steps` (only with `--har`; a baseline recorded without it has no `requests` key, which means "not recorded", not "no requests"). `--side next` with `--har` puts the same field in the report's `next` snapshot; tier 1 does not compare it. Schema: `docs/parity-requests.schema.json`, example: `docs/parity-requests.example.json`.
- **Counts per step.** With `--har` the recorder also counts the data requests of each step, because a screen that calls an endpoint once per row where legacy batched it passes everything above. `scripts/parity-record.js` wraps the adapter (`timed`) so each `session.act` first notes `Date.now()`: mark k is when step k began (the recorder is not changed). `Parity.stepCalls(har, {baseUrl, marks})` (pure) uses the same data-request rule as `requests` and returns, per mark, `[{method, path, count}]` in first-seen order (`[]` for a step that made none). An entry goes to the last mark at or before its `startedDateTime`; one before the first mark is ignored; an integer `_step` on the entry (the fixture adapter writes it from a fixture request's `step: <n>`) wins over time. `count` is capped at 3, meaning "3 or more" (the one-record rule: how many rows a screen has is data, and 3 tells one call from one per row). Unknown is not zero: with no marks, or a data entry with neither `_step` nor a parseable date, the result is `null` and no step gets a `calls` key. Each step that has a mark gets `calls` in the snapshot (baseline and report `next`); without `--har` nothing changes. `compare` adds, for a step that ran on both sides and only when both sides have `calls`, a finding `kind: calls`, `key: calls:<METHOD> <path>`, severity `fail`, for each method and path the new app calls more often than legacy in that step (legacy absent counts as none): `GET /api/items/:id is called 3 or more times in this step; legacy calls it once`. Fewer or equal calls, and a side with no `calls` (a baseline recorded without `--har`), give nothing. A bound decision of any kind with `calls: [{method, path}]` (path as templated, e.g. `/api/items/:id`) covers the finding (`severity: covered`, `by: <decision id>`); `Parity.callsProblems(d)` checks the field and is not wired into the gate or an agent tool yet. The new field and finding kind are not in the pinned schema or cases files; the Factory carries `parity_result.failures` as free `{step, key, kind, msg}`.
- **Not kept:** the query string, headers, cookies, timings and the ordering of identical calls. Object keys are kept as written, so a response that is a map keyed by customer name would leak those names: that is a design smell in the app, and a scenario can't mask it.

## Drafting scenarios from legacy tests

```
node scripts/parity-import.js --from <legacy tests folder> --registry <dir> [--write] [--id <name>] [--link <test scenario id>] [--json]
```

`--id` names the scenario when the folder holds exactly one test (a `playwright codegen` recording); `--link` writes `test_scenarios: [<id>]` and refuses an id with no `test-scenarios/` file. The Record from legacy button on a test scenario types the codegen and import line for you (no Enter).

Each `test(...)` in the folder's Playwright tests becomes one draft scenario. It translates `page.goto` with a written-out path (an absolute URL keeps only its path) and `getByRole` locators with `.first()` or `.nth(n)`, whether inline, held in a local `const`, or a page object's property. It follows a page object's method one level, taking parameters from the call. Values are copied as the legacy test wrote them; move any that differ between the apps to `params`. It flags everything else with its file and line in the draft's header comment and on the console, and never guesses. That includes `getByLabel`, `getByText`, CSS locators, `.last()`, values held in variables, and helpers. It counts assertions and skips them, because parity compares the whole screen. Without `--write` it only reports. With `--write` it creates `parity/scenarios/<id>.yaml` (the id is a slug of the test title) and never overwrites one that exists. Exit: `0` drafted, `1` something was not translated or a draft has a problem, `2` an error.

## In the app

The Parity activity lists the scenarios, whether each has a baseline, and its latest result. A scenario's page shows its steps, its ledger results, and the latest report's findings per step. Beside the findings, it shows the legacy and new app screenshots, read through `parity:shot` (a 64-hex name only, confined to `parity/shots/`). A shot missing on this machine says so. A work item card with a `parity` entry shows each scenario's latest result and links to the view. Grill-me can read all of this, except screenshots and page data, with the read-only `read_parity` tool.

The view has buttons for the commands on this page: Record legacy, Compare new app (each for one scenario or all), Record result for Done, and Draft from legacy tests. Each types its command into the Terminal and stops before Enter, as Dispatch does, so the app itself never records or appends `parity_result`, and the command is never given `--allow-writes` or `--allow-request`. No agent tool reaches them. The app writes two things directly, both at a person's request: a starter scenario (New scenario) and `parity.legacy.baseUrl` / `parity.next.baseUrl` in `designc.json`. The view says what this machine lacks (`parity:tools`). An installer does not include the recorder, so there the buttons are disabled and the view says to run designc from source.

### Joining the UI graph (7f)

When `designc.json` `ui.screens` names the scenario's screen, `ParityQa.report` also takes `ui = {legacy, next}` (the UI graphs of each side) and `ParityQa.fromCode` joins their controls to the recording: by role and name when the source gives a role; by name alone, taking the recorded role, when it does not and exactly one recorded role has that name (`name`); `ambiguous` when several do; `unnamed` for a control with no literal name (a `t('key')` is not recorded text); `unrecorded` when nothing matches. Nothing is guessed. For the buckets `state_not_recorded` and `not_flagged` the reason then adds "in code: ..." per side: the file and line, the conditions it is shown under, its disabled, readOnly, hidden or required props, and its format, as source text, never evaluated. Buckets do not change, and no bug text is copied. The Parity scenario page shows the same joins in a "From code" block.

## Done

A work item may list `parity: <id>` or `parity: all` in `done_when` (repo items only, beside a `gate`). It is met when, for each scenario (`all` is every id in `parity/scenarios/`; none means not met), the latest `parity_result` at the item's done commit, recorded before `item_done`, is `pass`; a latest `fail` or `could_not_run` leaves it unmet. A row whose outcome designc does not know is ignored.

## The ledger row

`parity_result {scenario, commit, outcome, failures[≤50 {step, key, kind, msg}], item?, report?, visual? {ratio, threshold, outcome}}` in `pipeline.jsonl`; a fail names at least one failure. Schema: `python/designc/ledger_schema.json` (rule `failures_shape`).
