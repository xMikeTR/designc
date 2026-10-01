# Multi-language as-built extraction — slice 1

**Plan ID:** `extract-multilang-s1`
**Planned at:** 2026-09-25T18:33:26
**Project root:** `C:/Users/fialhomi/source/repos/designc/cenas/designc-desktop/app`
**Test runner:** `node --test "test/**/*.test.js"`
**Agent type:** frontend-dev

Scanner seam, C# hardening, JS/TS scanner, cross-language route linker (context + container levels).

## Quality gate (frontend-dev)
- **type_check:** `node -e "require('./extract.js')"`
- **test:** `node --test "test/**/*.test.js"`
- **security:** `npm audit --audit-level=high`

## Contract sections
`scanner_module`, `facts`, `route_normalisation`, `designc_json`, `extract_signature`, `catalogue`

---

## EXT-01 — Refactor extract.js behind a scanner seam with a generic queue linker and shared catalogue, output-identical on sample-codebase
**Depends on:** —
**Files:** `extract.js`, `extract/index.js`, `extract/csharp.js`, `extract/js.js`, `extract/js-calls.js`, `extract/link.js`, `extract/dsl.js`, `extract/catalogue.js`, `package.json`, `test/extract.sample.test.js`

**Boundaries:** Pure refactor — sample-codebase output must not change. `extract.js` becomes a one-line shim (`module.exports = require('./extract/index.js')`). `extract/index.js` extends the file walk to also collect `.js .jsx .ts .tsx .mjs .cjs` and `package.json`, adds `dist, build, coverage, out, .next, playwright-report, test-results, junit-results` to SKIP, runs every registered scanner, merges Facts, calls `link.js`, renders DSL via `dsl.js`, computes stats. Reworded "no projects" error: *"No .NET projects (.csproj, .fsproj) or package.json files found in this folder."* `extract/csharp.js` moves the existing .NET logic verbatim; Service Bus sender/receiver matching moves OUT of C# into `link.js` as generic queue matching (`Create(Sender)` → `consumes{kind:'queue'}`, `Create(Processor|Receiver|SessionProcessor)` → `provides{kind:'queue'}`), reproducing today's edges/labels/tech/unresolved exactly. `extract/js.js` and `extract/js-calls.js` are stubs in this task (empty Facts). `extract/catalogue.js` exports shared names only (id, name, kind, tech) — data only. `package.json` adds `scripts.test` and `extract/**` to `build.files`. No touching `renderer/`, `main.js`, `preload.js`. No new dependencies.

**Acceptance criteria:**
- **EXT-01-AC1** — Extracting sample-codebase via `require('./extract.js')` yields exactly the baseline stats, 8 elements, 9 edges, 0 unresolved (literal values from the manifest, not read back from new code). *(test: `test/extract.sample.test.js` — sample-codebase extraction is unchanged by the scanner refactor)*
- **EXT-01-AC2** — The DSL for sample-codebase (minus its date line) has one container line per baseline container and one relationship block per baseline edge, parsing cleanly via `Core.parse`. *(test: same file — sample-codebase DSL parses cleanly in the design compiler)*
- **EXT-01-AC3** — A folder with neither `.csproj`/`.fsproj` nor `package.json` returns `{ error }` with the reworded message. *(test: same file — empty folder reports no projects)*
- **EXT-01-AC4** — Can-fail proof for the new test runner: report a deliberately-broken run (changed edge label) showing red, then revert. *(manual: DEC-021 can-fail proof)*

---

## EXT-02 — JS/TS scanner, part A: detect package.json deployables and the HTTP routes Node APIs provide
**Depends on:** EXT-01
**Files:** `extract/js.js`, `test/js-packages.test.js`, `fixtures/fullstack/ui/package.json`, `fixtures/fullstack/node-api/package.json`, `fixtures/fullstack/node-api/src/server.js`, `fixtures/fullstack/node-api/src/routes/invoices.js`, `fixtures/fullstack/shared-lib/package.json`

**Boundaries:** Only `extract/js.js` among production files. Package discovery: every `package.json` not under a SKIP dir. Classification from deps/devDeps, generic not repo-specific: SPA (vite/next/react-scripts/@angular/core/vue/svelte), Node API (express/fastify/koa/@nestjs/core/hono), else `library` (in `facts.projects`, not an element). Records SPA dev port / Node API listen port as `element.ports`. Each source file belongs to its deepest containing package dir. Provides (`kind: 'http'`): express/koa-router/hono/fastify route registrations and `app.use('<prefix>', <routerId>)` resolution across files; Nest `@Controller`/`@Get`/`@Post`. Calls `js-calls.scan(ctx, packages)` and merges (stub until EXT-03). Fixtures are tiny hand-written files, not runnable apps.

**Acceptance criteria:**
- **EXT-02-AC1** — Extracting `fixtures/fullstack` yields containers named after `ui`/`node-api` package names with SPA and "Node.js (Express)" tech; `shared-lib` appears in `facts.projects` as `library`, not an element. *(test: `test/js-packages.test.js` — classifies SPA, Node API and library packages)*
- **EXT-02-AC2** — `facts.provides` contains `/api/v2/invoices/{}` (GET) and `/api/v2/invoices` (POST) owned by node-api, each with file:line evidence into `routes/invoices.js`. *(test: same file — resolves express router prefixes into provided routes)*

---

## EXT-03 — JS/TS scanner, part B: outbound HTTP calls, dev proxy, SignalR, SDK catalogue and env-only targets
**Depends on:** EXT-01
**Files:** `extract/js-calls.js`, `test/js-calls.test.js`, `fixtures/fullstack/ui/vite.config.ts`, `fixtures/fullstack/ui/src/api/client.ts`, `fixtures/fullstack/ui/src/api/orders.ts`, `fixtures/fullstack/ui/src/auth/msal.ts`, `fixtures/fullstack/ui/src/realtime/hub.ts`, `fixtures/fullstack/ui/src/telemetry.ts`

**Boundaries:** Only `extract/js-calls.js` among production files; exports `scan(ctx, packages)` → `{ elements, edges, consumes, provides, unresolved }`, tested directly (not dependent on EXT-02's discovery). HTTP consumes (`kind: 'http'`): literal/template-literal paths to `fetch`/`axios`/`ky`, or via a wrapper module with a literal or env-fallback base; absolute `https://` literals become externals by hostname. Dev proxy (`vite.config` `server.proxy`) sets `devTarget`. SignalR `.withUrl()` → `kind: 'hub'` consume (literal or env-traced). Catalogue-only external names (never invented) for MSAL/Entra ID, New Relic, App Insights, Postgres, MySQL, MongoDB, Redis, Blob Storage, Cosmos DB, Key Vault. `@azure/service-bus` `createSender`/`createReceiver` → queue consume/provide. Unresolvable calls go to `unresolved` with file/line, never a fabricated edge.

**Acceptance criteria:**
- **EXT-03-AC1** — `scan()` over the ui fixture returns http consumes for `/api/v1/orders/{}`, `/api/v1/orders`, `/api/v1/customers/{}` — first two carrying `env: 'VITE_API_BASE_URL'`, all three carrying `devTarget: 'http://localhost:5010'`. *(test: `test/js-calls.test.js` — resolves wrapper base, env fallback and dev proxy onto http consumes)*
- **EXT-03-AC2** — Returns a hub consume with `env: 'VITE_HUB_URL'` and no key-less edge, plus externals "Entra ID" and "New Relic" matching `extract/catalogue.js` entries exactly. *(test: same file — maps SignalR, MSAL and New Relic through the shared catalogue)*
- **EXT-03-AC3** — A `fetch` with a bare, untraceable variable argument produces exactly one unresolved entry (file+line), no consume. *(test: same file — unresolvable fetch goes to unresolved, not to an edge)*

---

## EXT-04 — Harden the C# scanner: minimal-API, controller and Functions routes, Service Bus attributes, catalogue stores and externals
**Depends on:** EXT-01
**Files:** `extract/csharp.js`, `test/csharp.test.js`, plus a full `fixtures/fullstack/api` fixture (`Shop.Api` minimal-API + controller host, `Shop.Functions` isolated-worker host, `Shop.Infrastructure` shared library)

**Boundaries:** Only `extract/csharp.js` among production files; everything generic to ASP.NET Core / Azure Functions, nothing repo-specific. Provides http: minimal-API `Map*`/`MapGroup` prefix chains resolved across files via extension-method closures; `[Route]`/`[Http*]` controllers; Azure Functions `[HttpTrigger(Route=...)]` plus interpolated route-prefix constants, prefixed by `host.json`'s `routePrefix` (default `api`). `MapHub<T>` → hub provide. Queue attributes `[ServiceBusTrigger]`/`[ServiceBusOutput]` → provide/consume, resolving `%Name%` settings from `local.settings.json`/`appsettings`, else `env:'Name'` for EXT-05 to bind. Functions projects get tech "Azure Functions (.NET isolated)". Catalogue-only externals/stores for Snowflake, SQL Server, Postgres, Key Vault, Entra ID, App Insights, New Relic. Library code attributed to every deployable in its reference closure.

**Acceptance criteria:**
- **EXT-04-AC1** — Extracting the fixture yields provides http `/api/v1/orders/{}` and `/api/v1/orders` owned by `Shop.Api` (cross-file minimal-API chain), `/api/v1/customers/{}` owned by `Shop.Api` (controller), and `/api/v1/orders/{}` owned by `Shop.Functions` (HttpTrigger, empty routePrefix). *(test: `test/csharp.test.js` — resolves minimal API, controller and Functions routes)*
- **EXT-04-AC2** — `Shop.Functions` has a queue consume+provide keyed `'orders'` (resolved from `%OrdersTopic%`); Snowflake appears once as a store with data edges from both hosts via the shared library; Entra ID appears as an external with an edge from `Shop.Api`. *(test: same file — resolves Service Bus attributes and catalogue stores through library closures)*

---

## EXT-05 — Link HTTP and hub consumes to providers across languages, apply designc.json bindings, and wire opts through main.js
**Depends on:** EXT-02, EXT-03, EXT-04
**Files:** `extract/link.js`, `extract/index.js`, `main.js`, `renderer/app.js`, `test/link.test.js`

**Boundaries:** `link.js` gains http/hub linking and bindings on top of the existing queue linking. Matching: equal normalised keys, or provide as a whole-segment prefix of consume (longest wins), grouped by provider deployable. Exactly one provider → one sync edge (`label: 'Calls <n> endpoint(s)'`, tech HTTP/SignalR, evidence = every matched call). Multiple providers → tie-break by `devTarget` port matching a provider's `element.ports`; still ambiguous → one unresolved entry naming all candidates, no edge. No match → unresolved (mentioning env if present). `opts.bindings`: an env-carrying consume whose env is a binding key links to an existing element or a new external named by the binding, with synthetic `designc.json` evidence; unbound env-only consumes stay unresolved. `index.js` passes `opts` through; `main.js`'s `codebase:extract` handler passes `readSettings().extract || {}`. `renderer/app.js`: only the Code map empty-state table (~line 882) is retitled and gains rows for JS/TS detection, HTTP linking, and bindings — no other renderer change, `facts` shape unchanged.

**Acceptance criteria:**
- **EXT-05-AC1** — Extracting `fixtures/fullstack` yields a sync edge from the ui SPA to `Shop.Api` (not `Shop.Functions` — dev-proxy port 5010 breaks the tie for `/api/v1/orders/{}`), evidence including `orders.ts`; `/api/v1/customers/{}` also lands on `Shop.Api`. *(test: `test/link.test.js` — links SPA calls to the C# API across languages with port tie-break)*
- **EXT-05-AC2** — With `opts.bindings = { VITE_HUB_URL: 'Notifications Hub' }`, the ui gains a realtime edge to external "Notifications Hub" with designc.json-declared evidence; without the binding, the hub consume is one unresolved entry naming `VITE_HUB_URL` and no edge exists. *(test: same file — applies designc.json bindings to env-only targets and leaves them unresolved otherwise)*
- **EXT-05-AC3** — With no port tie-break and two deployables providing the matched route, extraction emits one unresolved entry naming both candidates, no edge. *(test: same file — ambiguous providers go to unresolved with both candidates named)*
- **EXT-05-AC5** — Manual acceptance against a real repo: opening the Pricing-MaPS registry (`codebase: src`) and re-extracting shows the UI container, Api and Functions containers, Snowflake/Key Vault/Entra ID/Service Bus edges, and the UI→API edge either linked or listed under Unresolved with both candidates. *(manual: real-repo acceptance in the running Electron app — Pricing-MaPS is deliberately not a fixture)*
