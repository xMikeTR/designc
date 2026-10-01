# Session Handoff — 2026-10-01, COMP-01 done, COMP-02 starting

## Standing instruction
"proceed to make it happen, I want this IDE done" — autonomous task-by-task execution of
the `plan/` manifests toward `DESIGNC_SYSTEM_SPECIFICATION.md`; pause only at genuine
blockers. `design-ide-features.md` (new, user-added) is the longer-horizon feature set
(typed model, fitness functions, structured canvas editor, P models, drift/semantic diffs);
COMP-xx/ZOOM-xx sit under its items 1 and 5. Not yet mapped onto the manifests.

## Repo state
- Git root is now `Designc/app` (`git init -b main`, `.gitignore`: node_modules, dist, .env, *.log).
  Previously the root was `/home/mike` — that no longer applies here.
- Commit `d9126f2`: baseline of the whole app + COMP-01. `npm test` = 68/68 green.
- Manifests live in `plan/*.json` (the `/tmp` copies are gone). Extract a task with
  `node -e "const m=require('./plan/extract-components-s2-manifest.json'); console.log(JSON.stringify(m.tasks.find(t=>t.task_id==='COMP-02'),null,1))"`.
  **The manifest's top-level `contract` object is authoritative** (component_assignment,
  component_ids, component_edges, link_pairs, csharp_references, designc_json, dsl,
  core_atLevel, scanner_units). Read it in full before each task. Manifest line numbers are
  stale (planned against a different commit); re-anchor by function name.
- xvfb is NOT installed (`sudo` needs a password). User must run `! sudo apt install -y xvfb`.
  Needed for COMP-01 AC7 (manual Electron check of Code map / "Start the design from this map").

## COMP-01: what exists
`extract/components.js` (seam: dispatch by extension, group into Map, `build({elements,units},opts)`
-> `{components, componentEdges, unresolved}`), `components-cs.js` / `components-js.js`
(assign() rules 5 + 8; edges() stubs return []), scanner `units`, `dsl.js` nesting,
`Core.atLevel` / `Core.containerLevelText`, 3 `app.js` lines, tests
`test/components-core.test.js`, `test/components.test.js`. `stats` is untouched
(computed from pre-components `unresolved`).

## KNOWN DEVIATIONS from the contract in the COMP-01 code (reconcile first)
1. **Component ids**: code uses `e_<owner>_<comp>`; contract says `c_<keyOf(container)>_<keyOf(component)>`,
   `_2/_3` suffix on collision in component-name order, components sorted by name (localeCompare 'en').
   `e_` is also how the sample test tells container rels from component rels.
2. **atLevel dedup**: contract drops a lifted rel if an explicit rel with the same `(src,dst)`
   exists (description NOT part of that check); otherwise keeps first lifted per `(src,dst,description)`.
   Code currently keys everything on `(src,dst,description)`. Also `'context'` level must fold containers
   into the softwareSystem and keep externals; people/systems stay.
3. **Unit shape**: contract = `{ file, owners: [container key], project, projectKind, root, lang }`,
   one per non-test source file under `root` (js: package's `src/` when present), **including library
   project files** (owners = deployables whose closure includes them). Code emits
   `{ owner, file, relFromRoot, evidence }` for deployables only. COMP-02 needs the contract shape
   (library components, anchors). Facts must not emit units.
4. **Component rel lines in dsl.js** are written in the 5-line container form; contract wants ONE line:
   `    <from> -> <to> "label" "tech" { properties { "d.interaction" "sync|async" } }` (what
   `containerLevelText` relies on). Component tech string for declarations: `"Name" "" "tech"`.
5. **facts.components** currently `{key,name,owner(display name),basis,evidence}`; contract only fixes
   `componentEdges` shape: `{from,to,kind,label,tech,via,evidence}` (from/to = component id or `e_` element id).
6. COMP-01 contract AC "Extracting twice gives identical facts.components and DSL" and "no container
   gets a `{` block with no source files" — verify; the latter is true by construction today.

## COMP-02 (next): scope in one paragraph
C# components: rules 2/3/4 in `components-cs.js` (anchors: class with a `[Function]` method, `*Controller`
/ derives ControllerBase|Controller, static class calling `Map(Get|Post|...)`; output-binding types from
`[Function]` return types joined to the method's class only when the name is declared exactly once in
the project; library project = one component per owner container; use `blankComments` code so
commented-out attributes aren't anchors). `link.js`: `edgeAdder` 7th arg `pair`, `e.pairs`
(linkQueues cross-owner, linkHttp collect/provider/host/binding) — pairs never reach `facts.edges`.
`components.js`: build componentEdges layers (a) pinned container edges and (b) same-container queue
links; rollup invariant (fold ends to containers, drop self-loops == set of `(from,to,kind)` of
`facts.edges`). Tests (names verbatim from manifest): `test/components-cs.test.js` (2 tests: "controllers,
endpoint classes, function classes and referenced libraries become components"; "a queue sent and
received inside one Functions app becomes an edge between the two function classes"; "output-binding
types join their function class only when unambiguous") and `test/components.test.js` additions
("component edges roll up to exactly the container edges on the fullstack fixture"; "an edge whose
provider end has no evidence targets the container itself"; "facts.edges keep their slice 1 shape").
Inline `withRepo` temp-dir fixtures with generic names only (pattern: `test/queue-internal.test.js`);
no new files under `fixtures/`. Existing link/queue-internal/spa-wrapper tests unchanged.
Invariants: no app-specific names in `extract/*.js`; no new dependencies; never invent edges.

## Plan for the next session
1. Refactor: deviations 1, 2, 4 DONE (commit "Align COMP-01 with manifest contract"). Remaining: 3 (unit shape) — do it as the first step of COMP-02.
2. COMP-02 TDD, one failing test at a time, starting with AC1 on `fixtures/fullstack`.
3. Update `ARCHITECTURE.md` if present (none seen in this repo root) — ask before creating.

## Watch out for
- Don't read only the task JSON — always read `m.contract` too (that is how the deviations above happened).
- `stats` must stay deep-equal to `BASELINE_STATS`; no new stats keys.
- `dsl.render` 4th/5th params must default (`new Map()`, `[]`) so the 3-arg form stays byte-identical.
- `facts.components` is an array with display-name owners; `dsl.render` takes a Map keyed by element key
  and component Map keyed `"ownerKey|compKey"` — tests must convert accordingly.
