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

A step that could not run (missing element or param, an earlier step stopped) makes the scenario `could_not_run`: not a failure, and never a pass. Out of scope: colours, fonts, keyboard, and empty, error and loading states (acceptance criteria cover those). Screenshots are kept for people (the gallery) and never compared.

## What covers a difference

- Added or changed element: a locator `{role, name}` in an `acceptance/*.yaml` criterion.
- Removed element: a **bound business** decision with `removes: [{role, name, screen?}]`. `screen` limits it to scenarios with that `screen`.

A covered difference is reported as `covered` and does not fail.

## Files in the registry

| Path | What | In git |
| --- | --- | --- |
| `parity/scenarios/<id>.yaml` | `id, title?, screen?, steps[], params {legacy, next}?, masks[]?` | yes |
| `parity/baselines/<id>/legacy.json` | the normalised legacy snapshot | yes |
| `parity/reports/<id>.json` | the latest comparison: the new app's snapshot and every finding | yes |
| `parity/shots/<sha256>.png` | screenshots, by content hash | no (`parity/shots/.gitignore`) |

A step has exactly one action: `goto {path}`, `click`, `fill` or `select` `{role, name, index?, value?}`. `index` picks the nth match (records by position, never by value). A value may be `{param: name}`, taken from the side's params, so each app gets its own test data. `expect` is optional: `sorted: <column>` or `filtered: {column, contains}`. A mask is `{column | role, name, mode}` with mode `ignore` (no shape kept), `shape` (treat as data) or `exact` (a vocabulary word: compare the text).

## The recorder CLI

```
node scripts/parity-record.js --registry <dir> --scenario <id|all> --side <legacy|next>
  [--adapter web|fixture:<file.json>] [--base-url <url>] [--param name=value]...
  [--commit <sha>] [--item <work item>] [--ledger] [--by <name>] [--no-shots]
  [--allow-writes] [--allow-request <url part>]... [--json]
```

- `--side legacy` writes the baseline. `--side next` compares with it, writes the report and, with `--ledger`, appends one `parity_result` per scenario through `ledger-store.js` (the CLI is the only writer of that kind).
- Adapter params come from `designc.json` `parity.legacy` / `parity.next` (`baseUrl`, `viewport`, `locale`, `timezoneId`, `headless`), then the scenario's `params.<side>`, then `--param`; `--base-url` wins. Secrets never go there.
- The web adapter needs `playwright-core` and Chromium on the machine that can reach both apps. It runs en-GB, Europe/London, 1280×800 by default.
- Read-only by default: a click whose name looks like it commits (Save, Apply, Delete, Submit…) is `blocked`, and the web adapter aborts every request that is not GET, HEAD or OPTIONS. Only the person running it may pass `--allow-writes` or `--allow-request`; a pipeline never should against a live legacy app.
- A login wall stops the scenario: a redirect to another host, or a page with exactly one visible password field. On legacy it is an error and the baseline is left as it was, so a sign-in page can never become the baseline; on the new app the scenario is `could_not_run`. The recorder does not sign in. Run the apps with sign-in off, such as a local copy in mock mode. It cannot see a sign-in page on the same host that shows no password field yet (email first), so look at the first baseline's screenshot.
- Exit: `0` pass (or baseline recorded), `1` a scenario failed, `2` an error (no baseline, bad scenario, adapter could not open; nothing judged), `3` a scenario could not run. With several scenarios the worst wins: 2, then 1, then 3.

## Drafting scenarios from legacy tests

```
node scripts/parity-import.js --from <legacy tests folder> --registry <dir> [--write] [--json]
```

Each `test(...)` in the folder's Playwright tests becomes one draft scenario. It translates `page.goto` with a written-out path (an absolute URL keeps only its path) and `getByRole` locators with `.first()` or `.nth(n)`, whether inline, held in a local `const`, or a page object's property. It follows a page object's method one level, taking parameters from the call. Values are copied as the legacy test wrote them; move any that differ between the apps to `params`. It flags everything else with its file and line in the draft's header comment and on the console, and never guesses. That includes `getByLabel`, `getByText`, CSS locators, `.last()`, values held in variables, and helpers. It counts assertions and skips them, because parity compares the whole screen. Without `--write` it only reports. With `--write` it creates `parity/scenarios/<id>.yaml` (the id is a slug of the test title) and never overwrites one that exists. Exit: `0` drafted, `1` something was not translated or a draft has a problem, `2` an error.

## In the app

The Parity activity lists the scenarios, whether each has a baseline, and its latest result. A scenario's page shows its steps, its ledger results, and the latest report's findings per step. Beside the findings, it shows the legacy and new app screenshots, read through `parity:shot` (a 64-hex name only, confined to `parity/shots/`). A shot missing on this machine says so. A work item card with a `parity` entry shows each scenario's latest result and links to the view. Grill-me can read all of this, except screenshots and page data, with the read-only `read_parity` tool.

The view has buttons for the commands on this page: Record legacy, Compare new app (each for one scenario or all), Record result for Done, and Draft from legacy tests. Each types its command into the Terminal and stops before Enter, as Dispatch does, so the app itself never records or appends `parity_result`, and the command is never given `--allow-writes` or `--allow-request`. No agent tool reaches them. The app writes two things directly, both at a person's request: a starter scenario (New scenario) and `parity.legacy.baseUrl` / `parity.next.baseUrl` in `designc.json`. The view says what this machine lacks (`parity:tools`). An installer does not include the recorder, so there the buttons are disabled and the view says to run designc from source.

## Done

A work item may list `parity: <id>` or `parity: all` in `done_when` (repo items only, beside a `gate`). It is met when, for each scenario (`all` is every id in `parity/scenarios/`; none means not met), the latest `parity_result` at the item's done commit, recorded before `item_done`, is `pass`; a latest `fail` or `could_not_run` leaves it unmet. A row whose outcome designc does not know is ignored.

## The ledger row

`parity_result {scenario, commit, outcome, failures[≤50 {step, key, kind, msg}], item?, report?}` in `pipeline.jsonl`; a fail names at least one failure. Schema: `python/designc/ledger_schema.json` (rule `failures_shape`).
