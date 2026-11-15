# UI contract: what a screen should be

Parity answers "did we copy it right". This page covers the other half: what a screen should be, written down before it is built, in a form an agent can follow and a gate can check. It covers both migrated screens (Lane A) and new ones (Lane B), with one catalogue for both.

Status: **partly built** (session D1: pack, spec and state clauses, checks 1–3 and the holdout clause; implemented in `renderer/ui.js` and `python/designc/ui.py`). The rest is design. A standalone kit (schemas, validator, code check, Vitest preview and page tests, two skills) exists outside designc and is the reference for the shapes below. [Slices](#slices) gives the build order.

**The split.** designc owns what a screen should be and the approvals: packs, specs, state graphs, document checks, approving previews. It never runs app code. The Factory runs everything that executes code: rendering previews, building the page, and proving it matches. That half is in the Factory's `docs/ui-contract-verify.md`. Acceptance criteria already split this way: written here, run there.

Stages are `ROLES` entries in `renderer/agent.js`. Read with parity-walkthrough, [parity-contract.md](parity-contract.md) and designc-vs-sysml.

## The idea in one line

Agents don't design screens. They fill **slots** in approved **templates** with **catalogued components**, write that down as a **screen spec**, and a person approves the **rendered preview** of every state. The spec's state graph is the spine shared by acceptance criteria, parity scenarios and QA bugs.

This comes from Gus's (Commerce Tools) talk on generative UI: the catalogue is the contract, and layout resolves bottom-up (data, then components, then template).

## Pieces

| Piece | What it is | Where | Who writes it |
| --- | --- | --- | --- |
| Design tokens | The closed set of design values | `design-tokens/tokens.json` (W3C, already a gate input) | Person |
| Component manifest | What a library component is for, its props, data shapes, states, `useWhen`/`avoidWhen` | UI pack `ui/components/<Name>.json` | Minted in the `catalogue` stage, bound by a person |
| Template | A page archetype: named slots, the component categories each accepts, how many | UI pack `ui/templates/<name>.json` | Same |
| Screen spec | One screen: template, placements, data bindings, **state graph** | Project `ui/specs/<screen>.json` | Same |
| Preview | Per state: a screenshot and an ARIA tree of the spec rendered with the real library, plus one screenshot per placement | Project `ui/previews/<screen>/` (`<state>-<browser>-<platform>.png`, `<state>.aria.yml`, `placements/<state>__<placement>-<browser>-<platform>.png`) | Rendered by a Factory preview run, approved by a person |
| Holdout sample | A second set of sample data for one screen, one value per `data` key. The build never sees it; a Factory check renders the built page with it, so a page hard-coded to the visible sample fails | Project `ui/holdout/<screen>.json` | Person only. READ is denied to every stage; it is in the handover by hash only |

SysML terms, for readers who know them: a manifest or template is a **definition**, a placement or spec is a **usage**. A placement `id` is a stable element ID. A bound spec plus approved previews is **satisfy** ("designed for"); passing gates is **verify** ("proven").

## UI packs

A UI pack works like a domain pack. It describes one component library and is reused by every app that uses that library.

- Source: a registry with `kind: ui` holding `ui/components/` and `ui/templates/`. It is a separate registry folder next to the project registry, listed under `registries` in `designc.json` like a domain registry, and the library's owner binds changes there. It is not the project's registry: a shared library has one source however many apps pin it.
- Project: **Pin** copies the pack into `ui/pack/` (`ui/pack/components/`, `ui/pack/templates/`) and appends `ui_pinned {pack, registry, hash}` (human only; `designc record` refuses it). `hash` covers every file in the pack. The latest pin wins. **Re-pin** shows what changed (components and templates added, removed or edited).
- No agent stage may write `ui/pack/`. In the source registry, the `catalogue` stage may mint a manifest or template (`mint_ui_component`, `mint_ui_template`), status `minted`, for a person to bind. See [Agents](#agents).
- Tokens stay the project's own `design-tokens/tokens.json` (W3C). Four groups are closed for the spec: `space`, `color`, `density`, `tone`. A token-typed prop names one of them, and a spec value is the name of a token in that group (its path below the group, joined with dots). The pack generates closed TypeScript unions from the same file.
- Categories are a closed list: `page-header, navigation, filter, action, metric, chart, table, list, detail, form, form-field, text, status, feedback, container`. Data shapes are a closed list too: `number, text, date, boolean, record, list, table, series, money, percent`. Adding one is a pack change, bound by a person, with templates updated in the same change.

## Screen spec

```json
{
  "screen": "bordereaux",
  "component": "BordereauxList",
  "intent": "Underwriters browse received bordereaux, filter by cedant and period, see total premium, open one.",
  "ticket": "RE-1234",
  "template": "list-detail",
  "data": {
    "bordereaux":   { "shape": "table",  "source": "GET /api/bordereaux", "sample": [ ... ] },
    "totalPremium": { "shape": "money",  "source": "GET /api/bordereaux/summary", "sample": { ... } },
    "selected":     { "shape": "record", "source": "GET /api/bordereaux/{id}", "sample": { ... } }
  },
  "slots": {
    "header":         [{ "id": "hdr", "component": "PageHeader", "props": { "title": "Bordereaux" } }],
    "header.actions": [{ "id": "export", "component": "Button", "locator": { "role": "button", "name": "Export" },
                         "props": { "label": "Export", "variant": "secondary", "onClick": "exportBordereaux" } }],
    "main":           [{ "id": "table", "component": "DataTable", "bind": { "rows": "bordereaux" },
                         "why": "Many records, compared by cedant, period, premium" }]
  },
  "states": {
    "loading":  { "initial": true, "pending": ["bordereaux", "totalPremium", "selected"] },
    "ready":    {},
    "filtered": {},
    "empty":    { "data": { "bordereaux": [], "selected": null } },
    "error":    { "failed": ["bordereaux", "totalPremium"], "error": "Bordereaux could not be loaded" }
  },
  "transitions": [
    { "from": "loading",  "to": "ready",    "on": { "event": "data arrives" } },
    { "from": "loading",  "to": "error",    "on": { "event": "request fails" } },
    { "from": "ready",    "to": "filtered", "on": { "fill": { "role": "combobox", "name": "Cedant" } } },
    { "from": "filtered", "to": "empty",    "on": { "event": "no match" } },
    { "from": "filtered", "to": "ready",    "on": { "click": { "role": "button", "name": "Clear all" } } }
  ]
}
```

- `screen` is the same lower-case name used by `designc.json` `ui.screens`, parity scenarios and QA bugs. One spec per screen.
- `file` (optional) is the path of the page's source file in the app, so the generated page test knows what to import. Page tests are always generated from the spec; nobody writes them by hand.
- There is one viewport. The spec has no `viewports` field; more viewports would be listed as coverage when they are added.
- `locator` uses acceptance's `{role, name}` and its closed role list. It joins a placement to acceptance locators, parity recordings and the UI graph.
- `data.source` names the endpoint. Request parity compares against it ([Gaps it closes](#gaps-it-closes)).
- `sample` is realistic, small (3–8 rows) and fake. It is what the preview renders and what the visual check mocks.
- Status follows decisions: an agent mints (`status: minted`), a person binds (`status: bound`). A bound spec is frozen; a change is a new mint that supersedes it. Manifests and templates use the same two statuses, plus `deprecated`; the spec checks require every component and template a spec uses to be bound.

### The state graph is the spine

The walkthrough's state diagram (`parity/states/<screen>.md`) becomes the spec's `states` and `transitions`, which designc reads. Then the walkthrough's convention becomes a check:

| Where a state name appears | Rule | Status |
| --- | --- | --- |
| Acceptance criterion `states` and case `state` | Must be in the acceptance list (`ready, loading, empty, error, forbidden`) **and** in the spec's `states` | enforced (D2): gate clause, joined by the element's component name |
| Parity scenario step `state:` | Must be in the spec's `states` | enforced (D2): gate clause, joined by `screen`; no `screen` is skipped |
| QA bug `state:` | Must be in the spec's `states`, else `need triage` | enforced (D2): `need triage`, not a gate failure |
| Spec state | Must be reachable from the initial state. A state no scenario records is listed (coverage, not a failure) | reachability enforced (D1); unrecorded states are coverage (D2) |

Extra states such as `filtered` or `apply-dialog` are spec and scenario states only. Acceptance keeps its five. A transition with `commits: true` is one parity cannot record read-only, matching the walkthrough's rule: it is listed as coverage (D2), and so is a state reachable only through such edges.

## Checks

Gate clauses of a new kind, `ui`, only when a pack is pinned (`ui/pack/` exists) or a spec exists (opt-in, like domain packs). `GATE_INPUTS` gains `ui`.

1. **Pack.** Manifests and templates validate against their schemas. Token-typed props name a token group in `design-tokens/tokens.json`.
2. **Spec.** Template bound; each slot path exists; each component bound and of a category the slot accepts; slot min/max; required props present, unknown props refused, enum and token values valid; every required data prop bound to a declared key of the matching shape.
3. **States.** One initial state; transitions name known states; every state is reachable from the initial one; the [table above](#the-state-graph-is-the-spine).
3a. **Holdout.** `ui/holdout/<screen>.json` is optional. When present, every key exists in the spec's `data`, and no value equals the visible `sample` (a holdout equal to the sample proves nothing). A screen without a holdout is listed as coverage, not a failure.
4. **Freeze.** A work item on an element tagged `UI` with a `screen` cannot freeze without a bound spec and approved previews for every acceptance state. This sits alongside the existing acceptance rule, not in place of it.

Each clause says what is wrong and what to do, like the existing ones. The standalone validator's messages are the model.

Not a gate input, unchanged: the UI graph stays display only. It feeds drafts (below), never clauses.

## Preview and approval

Previews are rendered by the Factory, not designc, because they need the app's real library and a browser: `factory-s2 preview --registry <dir> --screen <screen> --repo <app>`. It runs the spec's preview tests (Vitest browser mode) in the sandbox, one per state, and writes a screenshot and an ARIA tree per state into `ui/previews/<screen>/`. designc types the command into the Terminal (the **Render previews** button on a spec, or the `compose` stage's `request_preview` card), like the Parity view's Record buttons. The person presses Enter.

A person approves the page pictures, not the JSON and not the crops. **Approve previews** appends `ui_preview_approved {screen, spec, files: {name: sha256}}` (human only). `files` covers everything under the screen's folder, the per-placement screenshots included (`ui__<screen>__<state>__<placement>`, placement ids `[a-z0-9-]+`), but the UI shows page pictures only: nobody is asked to look at 30 crops. The files are in the registry, so the hashes pin exactly what was approved. A new render after approval needs a new approval.

## Handover

**Built (D5).** `Core.handoverPlan` takes `ui` (specs, pack, pin, approved previews, holdout hashes), `criteria` and `yamlDump`. Freeze writes `ui.json` (`docs/handover-ui.schema.json`, example `docs/handover-ui.example.json`), the spec, template and used components as text under `ui/`, and the approved pictures under `ui/previews/<screen>/`, copied by the main process (`ui:copyPreviews`) after re-hashing each against the approval. The id covers every copied file, every preview hash, the holdout sample hash and each holdout case hash; `ui.json` is derived, outside the id, like `domain.json`. A criterion with a holdout case is copied again without it (a comment line says so); other criteria stay verbatim. `designc-core holdout-spec --registry <dir> --criterion <id> --case <n>` prints the generated spec for one holdout case, for the Factory to judge; nothing writes it into a handover.

The handover copies the bound spec, the pinned pack's manifests and templates the spec uses, and the approved preview files, inside the id hash. The holdout sample (`ui/holdout/<screen>.json`) and acceptance cases marked `holdout: true` are listed by hash only and never copied into files that go to a worktree. A derived `ui.json` (`designc.handover.ui/1`) lists them with their hashes. `BUILD.md` gains one rule: build from the spec, one library component per placement, `data-ui-id` first, no inline styles or raw values. `done_when` gains `ui: <screen>`. What the Factory does with them is in its `docs/ui-contract-verify.md`.

## Two lanes

**Lane A, migration (built, D8).** Legacy screen → round-trip spec → new screen.

1. Draft the legacy screen's spec from what designc already has: the UI graph (controls, `when` conditions as state hints, formats) for TS/JS legacy, or the parity recording for Blazor until a `.razor` extractor exists. The draft must describe the legacy screen as it is.
2. Copy it as the new screen's spec. Each edit is a difference from legacy, and the diff of the two specs lists them. Added or changed placements carry locators (acceptance's added rule), removed ones need a bound business decision with `removes:`. A changed look is a bound decision citing the approved new previews: the approved visual exception the parity contract lacks.
3. Build, then both checks: parity against the legacy recording, `ui:` against the approved previews.

**Lane B, new screens.** Ticket → data → components → template → spec → previews → approval → build → `ui:` check. No legacy, so the approved previews are the only baseline, from day one.

## Gaps it closes

From designc-vs-sysml and the walkthrough's known gaps:

| Gap | Closed by |
| --- | --- |
| One state graph per screen; state names not checked | Spec `states`/`transitions` and the state checks |
| Empty, error and loading states unmodelled (tier 1 leaves them out) | Spec states with previews, and the `ui:` visual check per state |
| No approved visual exception | A bound decision citing approved previews (Lane A step 2) |
| API calls not compared | Request parity, in the Factory's `parity` command: record a HAR per scenario and compare endpoints and payload shapes against `data.source` and the legacy recording. A later slice |
| Blazor legacy has no UI graph | Not closed. A `.razor` extractor is still needed for full Lane A drafts; the recording is the stopgap |
| `ui.screens` with split `repos` | Not closed. Needed for drafts and parity in split repos; the pack and specs work regardless |

## Feeding System 3

The QA bucket mapping stands (state not recorded → `spec_gap`, captured but not flagged → `gate_gap`, and so on). The UI contract adds:

- `caught_by` stages: `ui-spec` (spec checks, designc), `ui-preview` (a person rejected a preview, designc), `ui-code` and `ui-visual` (the Factory's checks, projected into the registry ledger; `ui-visual` includes the placement kinds), `holdout` (the visible checks passed without the behaviour being right, counted on its own), alongside `parity` and `acceptance`. This touches `ledger.js`, the schema and the Python mirror.
- Origin `catalogue_gap`: the spec passed but was wrong, because a slot accepts too much, a `useWhen` is vague or a template is missing. System 3 proposes a pack change.
- The variance test: mint the same ticket's spec several times and diff them. Where the drafts disagree, a rule is missing; each disagreement is a `catalogue_gap` proposal.

## Agents (built, D4)

The UI contract adds no new agent. It adds `compose` and `catalogue` as new `ROLES` entries in `renderer/agent.js`. The two kit skills are these stages outside designc; designc has them now (D4): the skill text, cut to what applies inside designc, is the stage brief. `suggest_stage` is the one tool added beyond this table: a card with an Open button that switches the stage after the turn. `ui/holdout/` is unreadable to every stage (`Policy.readVerdict`, no settings override), and acceptance `holdout` is set only by a person.

| Stage | Where | Does | Reads | Proposes (all ask) |
| --- | --- | --- | --- | --- |
| `compose` | Project registry | Lane B: ticket → data → components → template → spec. Lane A: drafts a spec from the UI graph or parity recording, which must describe the legacy screen as it is | Pinned pack, specs, acceptance, UI graph (`get_ui_graph`), parity (`read_parity`), previews | `mint_ui_spec`, `request_preview` |
| `catalogue` | UI pack registry | Drafts manifests from the library's types and templates from agreed screens, then drafts the agreed screen's own spec, which must pass | Library source, agreed screens, pack | `mint_ui_component`, `mint_ui_template`, `request_preview` |

Changes to existing stages:

- **`grill`** reads the screen's spec (`read_ui_spec`) and uses its state names in `mint_acceptance`. It may suggest `holdout: true` on a case; only a person sets it. It asks about the spec's gaps: unreachable states, states with no acceptance case, transitions marked `commits` with no mock. With no spec for a UI element, it suggests `compose` (`suggest_stage`) instead of improvising one.
- **Analyst (System 3)** reads the `ui-*` escape stages and variance-test diffs, and drafts `catalogue_gap` proposals aimed at the pack's source registry.
- **`model`** (today's Architect) is unchanged. Screen composition stays out of it.

Tools:

| Tool | Kind | Notes |
| --- | --- | --- |
| `read_ui_spec`, `read_ui_pack`, `get_ui_graph` | Read | System 1 read set, every stage |
| `mint_ui_spec` | Write, ask | `ui/specs/<screen>.json`, status `minted`; refused if it fails the spec checks, with the clauses; supersedes a bound spec only by listing it |
| `request_preview` | Card | Asks for a Factory preview run. The card shows the command; approving it types the command into the Terminal for the person to run. The agent never runs app code |
| `mint_ui_component`, `mint_ui_template` | Write, ask | Only in a `kind: ui` registry, status `minted` |
| `suggest_stage` | Card | Never changes stage itself |

Policy rows (`renderer/policy.js`):

- `READ` deny: `ui/holdout/**` for every stage.
- `WRITE_PATHS`: `ui/specs/` for `compose` only (`ui/previews/` is written by the Factory preview run, never by an agent); `ui/components/` and `ui/templates/` for `catalogue` only, in a `kind: ui` registry; `ui/pack/` for no stage.
- Human only, refused for every stage and by `designc record`: binding a spec, manifest or template; `ui_preview_approved`; `ui_pinned`.
- An ACP agent writing `ui/` directly (outside the tools) is an `unapproved_change`, like the other registry folders.
- The approval card for `mint_ui_spec` shows the spec as a table (slot → component → data → why) and links its previews. Approving the card writes a minted spec. It does not bind it.

## Invariants

- Probabilistic components propose, people decide: agents mint manifests, templates and specs; people bind them and approve previews.
- No agent writes `ui/pack/`, binds a spec or approves a preview.
- The UI graph stays display only.
- Samples are fake. A preview never calls a real API.
- No stage reads `ui/holdout/`. A person writes it.
- designc never runs app code. Rendering and proving happen in the Factory.
- Nothing is guessed: a missing component, state or locator is a clause or an `unresolved` entry, never a default.

## Slices

Each slice names the repo it lands in. Factory slices are detailed in its `docs/ui-contract-verify.md`.

1. **Standalone at work.** The kit in the app repo: bootstrap the pack from one agreed screen, one Lane B screen end to end. No designc or Factory change.
2. **designc: pack and spec.** `kind: ui` registry, Pin and Re-pin, `ui_pinned`, `ui/specs/` loading, spec and state clauses (checks 1–3), Python mirror.
3. **designc: state names join up.** Acceptance, scenario and QA state checks; the walkthrough's state graph step reads the spec.
4. **Factory: preview run** (`factory-s2 preview`). **designc:** Render previews, Approve previews, `ui_preview_approved`, check 4 (enforced, D3: a UI-tagged element's spec must be bound, rendered, and approved after the latest render, with the approved file hashes and spec hash equal to disk).
5. **designc: stages.** `compose` and `catalogue` with the UI tools, as new `ROLES` entries in `renderer/agent.js`. Until then the kit skills do the same job outside designc.
6. **designc: handover, built (D5)** (`ui.json`, preview files in the id hash, `done_when: ui:`). **Factory:** the `ui:` check in integration verify, frozen baselines, test-author-first page tests, sabotage cases.
7. **designc: Lane A drafting, built (D8).** The `draft_legacy` tool returns a skeleton from the UI graph or the parity recording (placements with `from`, state names, notes for unnamed controls); `mint_ui_spec legacy:true` writes `ui/legacy/<screen>.json` (same schema as a spec, status `minted`, never bound). The person presses Copy as new spec (no agent tool does) to write `ui/specs/<screen>.json` byte for byte, refused if it exists; a diff panel (`Ui.specDiff`) shows what the copy changed. Gate clauses for a spec with a legacy file: an added or changed placement needs a locator; a removed one needs a bound decision with `removes: [{role, name}]`; a changed template or token-typed prop needs a bound decision with `look: <screen>` and a current approval of the previews. Mirrored in `python/designc/ui.py`.
8. **Both: System 3.** The Factory projects `ui-code`/`ui-visual` rows; designc adds the stages, `catalogue_gap` and the "Record QA escapes" button.
9. **Factory: request parity**, then **designc:** the `.razor` extractor and split-repo `ui.screens`.

## Decisions on the open questions

- **Tokens.** The pack uses W3C tokens and generates closed TypeScript unions from them. Closed groups for the spec: `space`, `color`, `density`, `tone`.
- **Source registry.** A shared UI pack's source registry is a separate `kind: ui` registry folder next to the project registry. The library owner binds it.
- **Page test.** Always generated. The spec gains an optional `file` field.
- **Viewports.** One. No `viewports` field.
- ~~Preview hashes vs pixels.~~ Settled: the approved files are the baseline (Vitest keeps them per browser and platform), and their hashes are what `ui_preview_approved` and the handover pin. The check's threshold covers rendering noise.
- Where previews render: one fixed runner image, so the platform part of the file name never changes. A laptop render is for looking, never for approval.
- Still open (session D2): whether `filtered`-style states should be limited to what parity can record (read-only edges), or allowed freely and listed as uncovered.
