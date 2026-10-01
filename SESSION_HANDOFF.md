# Session Handoff — 2026-09-30 COMP-01 (component seam)

## What we were doing

Executing the `plan/` manifest tasks end-to-end to make DesignC a fully functioning
system design IDE per `DESIGNC_SYSTEM_SPECIFICATION.md` (System 1 of the
design-to-code factory), autonomously, task by task, verified by tests. Current task:
**COMP-01** — "Component seam end to end: scanner units, components.js with the
first-folder convention, nested DSL, Core.atLevel and containerLevelText, renderer
pinned to the container view." Full verbatim task JSON (id, scope, boundaries,
inputs, all 7 acceptance criteria) was re-fetched this session from
`/tmp/extract-components-s2-manifest.json` and is also saved at `/tmp/comp01.json`
(both outside the repo, in `/tmp` — not guaranteed to survive a reboot; re-extract
from the manifest mirror if gone: `node -e` with
`m.tasks.find(t => t.task_id === "COMP-01")`).

Standing instruction governing all of this (from much earlier in the session, still
in force, not to be re-confirmed): "proceed to make it happen, I want this IDE done"
— autonomous execution, pause only at genuine blockers.

## Decisions made this session

All manifest line-number citations for `renderer/app.js` and `extract/js.js` were
confirmed stale against the actual current files — every decision below is based on
direct reads of the real files, not the manifest's cited numbers.

1. **Unit shape** (one per source file of a *deployable-only* container — library/test
   projects excluded from unit generation in COMP-01):
   `{ owner: keyOf(containerName), file: rel(f), relFromRoot: <path relative to the
   owning project/package dir, forward-slashed>, evidence: { file, line: 1, text:
   basename(f) } }`.
2. **`extract/components.js`** owns ids/precedence, dispatches by file extension
   (`/\.(cs|fs)$/i` → `components-cs`, `/\.(js|jsx|ts|tsx|mjs|cjs)$/i` → `components-js`),
   calls `mod.assign(unit) -> { name, basis, evidence } | null`, groups into a
   `components` Map keyed `"${owner}|${keyOf(name)}"` → `{ key, name, owner, basis,
   evidence: [] }` (evidence accumulates across units), builds
   `componentEdges = [...cs.edges(ctx), ...js.edges(ctx)]` (both stub to `[]` in
   COMP-01), returns `{ components, componentEdges, unresolved }`. **Written and
   verified present** at `extract/components.js`.
3. **`components-cs.js` / `components-js.js`** implement only rule 5 (App shell) and
   rule 8 (first folder): split `relFromRoot` on `/`; ≤1 segment → `{ name: 'App
   shell', basis: 'app-shell' }`; else → `{ name: segs[0], basis: 'first-folder' }`.
   The JS variant additionally strips a leading `src/` (`p.slice(4)` after
   `startsWith('src/')`) before applying the same logic, since JS/SPA/Node projects
   wrap source in `src/` and C# projects don't. **Both written and verified present.**
4. **Component DSL id scheme**: `e_${ownerKey}_${compKey}` (both keys already
   alnum-only via `keyOf`, so `_` is an unambiguous separator).
5. **`extract/index.js` integration** (edited, not yet re-verified by tests — see
   below): added `const components = require('./components');`; added a `units = []`
   accumulator merged from each scanner's `facts.units` inside the existing merge
   loop; after the existing `link.link(...)` call, added
   `const comp = components.build({ elements, units }, opts);`; changed
   `dsl.render(repoName, elements, edges)` to
   `dsl.render(repoName, elements, edges, comp.components, comp.componentEdges)`;
   changed `facts.unresolved` to `[...unresolved, ...comp.unresolved]` while
   **deliberately leaving `stats.unresolved` computed from the original `unresolved`
   array** (pre-components) so `stats` is provably unchanged per the task boundary
   ("Do not change stats") even though `comp.unresolved` is always `[]` in practice
   today; added `facts.components` and `facts.componentEdges` fields.
6. **`extract/csharp.js` / `extract/js.js` units emission** — designed but **NOT YET
   coded this session** (see "Where we got to"). Insertion points confirmed by full
   reads:
   - `csharp.js`: insert a `units` array right after the existing
     `const deployables = projects.filter(p => ['web','worker','app'].includes(p.kind));`
     line (line 161 in the current file), iterating `deployables` × `d.sources`,
     `relFromRoot = path.relative(d.dir, f).split(path.sep).join('/')`; add `units,`
     to the final `return { projects, elements, edges, consumes, provides, unresolved }`
     (currently lines 364-372).
   - `js.js`: insert a `units` array after the existing package-to-files assignment
     loop (lines 86-89), iterating `pkgDefs.filter(p => p.kind !== 'library')` ×
     `p.files`, same `relFromRoot` computation relative to `p.dir`; add `units,` to
     the final return (currently lines 148-155). Do **not** merge anything from
     `calls` (js-calls.js produces no units).
7. **`extract/dsl.js` nesting** — designed but **NOT YET coded**. New signature
   `render(repoName, elements, edges, components = new Map(), componentEdges = [])`
   — defaults make every existing 3-arg call site byte-identical to today (required
   by AC2/AC6). Group `components` by `.owner` into `compsByOwner`. For each
   container line, if it owns ≥1 component: emit the existing head line + `" {"`,
   then one `        e_${ownerKey}_${c.key} = component ${q(c.name)} "" ""` line per
   component, then a `      }` line. Zero components → render exactly as today (no
   brace). Component-level edges use the same `compId()` helper and the same
   sync/async block shape as container edges (not exercised by any real data yet
   since `componentEdges` is always `[]` in COMP-01, but written for forward
   compatibility with COMP-02+).
8. **`renderer/core.js` — `Core.atLevel(model, level)`** — designed but **NOT YET
   coded**. `KIND_RANK = { person:0, softwareSystem:1, container:2, component:3 }`,
   `LEVEL_RANK = { context:1, container:2, component:3 }`. An element survives iff
   `kind === 'person'` or `KIND_RANK[kind] <= LEVEL_RANK[level]`. Memoized `resolve(id)`
   walks `.parent` chains to the nearest surviving ancestor (or itself). New
   `elements` = survivors (parent chains stay valid — C4 hierarchy guarantees a
   survivor's parent is also a survivor). Rels: re-target via `resolve(src)`/
   `resolve(dst)`; drop self-loops (`src === dst` after folding); dedup by
   `(src, dst, description)`, where a rel is "explicit" if folding didn't change its
   endpoints — an explicit rel always wins over a lifted duplicate for the same key
   regardless of encounter order; otherwise keep the first-encountered rel's id/
   fields. Rebuild via the existing `makeModel(model.name, elements, rels,
   model.errors)`. At `'component'` level every element survives (`KIND_RANK` maxes
   at 3), so the result is structurally equivalent to the input — matches AC3's
   "'component' returns an equivalent model".
9. **`renderer/core.js` — `Core.containerLevelText(dslText)`** — designed but **NOT
   YET coded**. Reuses `parse(dslText)` to find component elements (their `.line`)
   and rels touching a component endpoint (their starting `.line`, then a
   brace-balance scan forward — respecting `"…"` quoting — to find the full line
   span of a multi-line rel block). Strips exactly those line numbers from the raw
   text by index and rejoins with `\n`, leaving every surviving line byte-identical.
   On the real fixtures/fullstack nested DSL (AC4's actual test subject) there are
   currently **zero** component-level rels to strip (`componentEdges` is always `[]`
   in COMP-01) — so in practice only declaration-line stripping is exercised now;
   the rel-span logic is written for forward compatibility but won't be covered by
   a COMP-01 test.
10. **`renderer/app.js` — exactly 3 lines to change** (the manifest's cited line
    numbers `:121`/`:129`/`:851` are stale; **actual current lines confirmed by
    direct read**):
    - Line 140, inside `loadAsbuilt()`: `A.asbuilt = dsl ? Core.parse(dsl) : null;`
      → `A.asbuilt = dsl ? Core.atLevel(Core.parse(dsl), 'container') : null;`
      (preserve the `dsl ? … : null` guard — the manifest's literal suggested text
      omits it).
    - Line 148, inside `recompile()`:
      `A.drift = A.asbuilt && A.model.elements.size ? Core.driftModels(A.model,
      A.asbuilt) : null;` → same but
      `Core.driftModels(Core.atLevel(A.model, 'container'), A.asbuilt)` (preserve the
      surrounding guard).
    - Line 876, inside `adoptAsDesign()`:
      `const dsl = (await readText('asbuilt/workspace.dsl')).replace(/^\/\/.*\n/gm, '')
      .replace(/\(as built\)/, '');` → pipe the raw as-built text through
      `Core.containerLevelText(...)` **before** the existing two `.replace(...)`
      calls.
    - **Do not touch** `codemapSidebar()` (880-899), `renderCodemap()` (901-925,
      already correct from an earlier EXT-05 edit), or the start of `drawCodemap()`
      (927+, uses `A.asbuilt`/`A.drift` — reads the now-folded values, needs no
      change itself). The exact current boundaries of the "grill-me region" (stale
      manifest cites `:39, :41, :493-523, :648-654, :993-1065, :1114-1117`) were
      **not re-located this session** — they don't overlap lines 140/148/876, so the
      3 edits are safe to make without re-locating them, but re-locate them by
      content search before touching anything else in `app.js`.
11. **Fixture reality check (reconfirmed)**: `fixtures/fullstack` has no `admin/` app
    and no test files anywhere, contradicting the manifest's `inputs.context`
    fixture description — that description belongs to a later task (likely COMP-04).
    Package names are literally `ui`, `shared-lib`, `node-api` (not `shop-ui`/
    `shop-shared` as the manifest prose loosely suggests) — assert against the real
    names in tests.
12. **`test/extract.sample.test.js` change is minimal**: only the second test
    (`sample-codebase DSL parses cleanly in the design compiler`) needs a one-line
    change: `const parsed = Core.parse(dsl);` → `const parsed =
    Core.atLevel(Core.parse(dsl), 'container');`. Reasoning: `componentEdges` is
    always `[]` in COMP-01 so no new rel lines are ever rendered — `parsed.rels.length`
    stays `BASELINE_EDGES.length` either way — but using `atLevel` makes the test
    match AC1's literal wording ("container-level view … parses with zero errors and
    has exactly BASELINE_EDGES.length rels") and keeps it robust once COMP-02+ add
    real component rels. The other two existing tests (facts/stats equality test,
    empty-folder test) need **no changes** — components are a wholly separate
    `facts.components` field, never merged into `facts.elements`/`facts.edges`, so
    `BASELINE_STATS` and the 8/9 element/edge counts are untouched. All 3 existing
    test names are preserved.
13. **New test files still to be written** (not started): `test/components-core.test.js`
    with 3 tests named exactly:
    - `"atLevel container view of the nested as-built equals the flat container model"` (AC2)
    - `"atLevel folds children into ancestors and lifts relationships without duplicates"` (AC3)
    - `"containerLevelText leaves a container-only design"` (AC4)
    and `test/components.test.js` with 2 tests named exactly:
    - `"every source file of every deployable lands in exactly one component"` (AC5)
    - `"a container without components renders exactly as in slice 1"` (AC6)
    AC7 is manual/Electron-app acceptance — flag as pending human action (xvfb not
    installed in this environment; established precedent from earlier tasks in this
    session).

## Decisions NOT yet made

- Exact literal technology/description strings (if any) for rendered component
  elements in `dsl.js` — currently planned as empty strings (`""`, `""`), which
  `Core.parse` turns into `technology: null`. Not tested by any AC, low risk either
  way.
- Exact shape of a future `componentEdges` entry (`{ fromOwner, fromKey, toOwner,
  toKey, label, tech, kind }` was assumed for the `dsl.js` render loop) — provisional,
  not exercised by any COMP-01 test since both `edges()` stubs return `[]`. COMP-02/03
  will need to confirm or revise this shape when they implement real component-edge
  detection.
- Whether `Core.containerLevelText`'s multi-line rel-block stripping (brace-balance
  scan) is even needed for COMP-01's acceptance criteria — current analysis says no
  real test exercises it yet, but it's included for forward compatibility. Could be
  deferred/simplified if it turns out to add risk without test coverage.

## Where we got to

**Files created this session (component seam, all written and confirmed present):**
- `extract/components.js` — done.
- `extract/components-cs.js` — done.
- `extract/components-js.js` — done.

**Files edited this session:**
- `extract/index.js` — done (require added, `units` accumulator, `comp = components.build(...)`
  call, `dsl.render` call extended with `comp.components`/`comp.componentEdges`,
  `facts.unresolved`/`facts.components`/`facts.componentEdges` added, `stats`
  deliberately left reading the pre-components `unresolved` array).

**Files NOT yet touched (still exactly as before this task):**
- `extract/csharp.js` — needs the `units` block inserted after the `deployables`
  line (~161) and `units,` added to the return object (~364-372). Not started.
- `extract/js.js` — needs the `units` block inserted after the files-to-package
  loop (~86-89) and `units,` added to the return object (~148-155). Not started.
- `extract/dsl.js` — needs the signature extended to
  `(repoName, elements, edges, components = new Map(), componentEdges = [])` and
  the container-loop nesting logic. Not started.
- `renderer/core.js` — needs `atLevel` and `containerLevelText` function bodies
  added (placed after `driftModels`, before the "Extension hooks" comment per the
  file's existing section organization) and both names added to the final
  `return { … }` export object (currently line 454). Not started.
- `renderer/app.js` — needs the exact 3 line edits listed in decision #10 above.
  Not started. **Right before this handoff was invoked**, lines 860-934 had just
  been read to confirm `adoptAsDesign()` (874-879), `codemapSidebar()` (880-899),
  `renderCodemap()` (901-925), and the start of `drawCodemap()` (927-934) — this
  read is what grounds decision #10 above; no app.js edit has been made yet.
- `test/extract.sample.test.js` — needs the single one-line change in decision #12.
  Not started.
- `test/components-core.test.js` — does not exist yet. Not started.
- `test/components.test.js` — does not exist yet. Not started.

**No test run has happened yet this session** — nothing is currently verified
against the test suite. The first test run should happen only after `csharp.js`,
`js.js`, `dsl.js`, and `core.js` are all done (since `components.js`/`index.js`
alone can't run meaningfully without `units` actually being populated by the
scanners).

## What to load on restart

- This file (`SESSION_HANDOFF.md`) — read first, in full.
- `/tmp/comp01.json` (or `/tmp/extract-components-s2-manifest.json` if the former is
  gone) — the verbatim COMP-01 task JSON, for the exact acceptance-criteria wording
  and `verified_by` test names.
- `extract/index.js` (just edited — re-read to confirm current state before
  continuing, don't trust memory of the diff).
- `extract/csharp.js`, `extract/js.js`, `extract/dsl.js`, `renderer/core.js`,
  `renderer/app.js` — re-read each in full before editing; do not trust any cached
  line numbers from this handoff without a quick re-grep first, since these files
  may have shifted if anything else touched them.
- `test/extract.sample.test.js` — re-read before making the one-line change.
- No skill needs to be re-invoked; this is a direct continuation of ordinary
  autonomous implementation work under the standing "make it happen" instruction.
  Just keep going top-to-bottom through the "Where we got to" NOT-yet-touched list.

## Watch out for

- **Manifest line-number citations are unreliable across this entire file set.**
  Every citation re-checked this session was stale. Always re-read/re-grep the
  actual current file before editing; never trust a cited line number verbatim.
- **`git` repo root is `/home/mike`, not the project directory.** `git status`
  inside `Designc/app` shows the *entire home directory* as untracked (`?? ./` at
  the app-folder level) because the repo was apparently initialized at the home
  directory level, not at a project boundary. This means an unqualified `git add -A`
  or similar from anywhere in this tree could attempt to stage unrelated home-
  directory content. **Do not run broad git add/commit commands** — if/when the
  user asks to commit COMP-01, stage only the specific known file paths under
  `Designc/app/...` explicitly, and flag this repo-root anomaly to the user rather
  than silently working around it.
- `stats.unresolved` in `extract/index.js` is now intentionally computed from the
  pre-components `unresolved` array while `facts.unresolved` includes
  `comp.unresolved` appended — these two are now different variables/expressions in
  the same function. Don't "simplify" them back to the same source without
  re-checking the "Do not change stats" boundary.
- `dsl.render`'s 4th/5th parameters (`components`, `componentEdges`) **must** default
  to `new Map()`/`[]` respectively — several existing call sites (and AC2/AC6) rely
  on the 3-arg call form producing byte-identical output to before this task.
- When writing `Core.containerLevelText`, remember component declaration lines in
  this codebase's generated DSL are always single-line (no trailing `{`) — only
  component *relationship* blocks can be multi-line, and only once COMP-02+ starts
  emitting real `componentEdges`.
- `xvfb` is still not installed in this environment — AC7 (manual Electron-app
  acceptance) cannot be automated here; keep flagging it as a pending human action
  rather than attempting a headless workaround that wasn't asked for.
