# DesignC: System Architecture & Technical Specification
**Version:** 1.0.0-feat.canvas  
**Repository:** `xMikeTR/designc`  
**Runtime:** Electron (Node.js 20+ / Chromium)  
**Target Environments:** Windows, macOS, Linux  

---

## 1. System Vision & Core Philosophy

**DesignC** is a system design integrated development environment (IDE) built on a foundational premise:  
> **"The design is the source; code is a build output."**

Traditional software development treats architecture diagrams and specifications as ephemeral documentation that quickly drifts from reality. DesignC inverts this relationship: the architectural model, behavioral protocols, and governance invariants constitute the executable source of truth. Production code is continuously extracted, validated, and verified against this model.

The platform unifies four distinct architectural systems into a single workbench:

```
+---------------------------------------------------------------------------------------------------+
|                                      DESIGNC WORKBENCH                                            |
|                                                                                                   |
|  +--------------------+  +--------------------+  +--------------------+  +--------------------+   |
|  |     SYSTEM 1       |  |     SYSTEM 2       |  |     AS-BUILT       |  |     SYSTEM 4       |   |
|  |     (Design)       |  |     (Build)        |  |    (Code Map)      |  |    (Improve)       |   |
|  |--------------------|  |--------------------|  |--------------------|  |--------------------|   |
|  | * Structurizr DSL  |  | * Langfuse Runs    |  | * AST Extraction   |  | * Escapes Tracking |   |
|  | * Live Lint DC00x  |  | * Token & Cost     |  | * .NET & JS/TS     |  | * Rule Health      |   |
|  | * P Protocol Check |  | * Ready Gate       |  | * Sync/Async Links |  | * Proposals YAML   |   |
|  | * Decision Checks  |  | * Decision Status  |  | * Drift Analysis   |  | * Value Metrics    |   |
|  | * Visual Canvas    |  | * Pipeline Ledger  |  | * Fact Registry    |  | * Retrospectives   |   |
|  +--------------------+  +--------------------+  +--------------------+  +--------------------+   |
+---------------------------------------------------------------------------------------------------+
```

1. **System 1 (Design)**: Formal structural definition using Structurizr DSL (`workspace.dsl`) and behavioral verification using the P language (`behaviour/*.p`). Live structural linting (`DC000`–`DC006`), architectural decision records (`decisions/*.yaml`), requirements traceability (`requirements/*.yaml`), and an interactive visual canvas.
2. **System 2 (Build)**: Execution telemetry and pipeline governance. Tracks agentic task runs via Langfuse, computes token expenditure and monetary cost per architectural element, tracks decision check outcomes, and evaluates the formal **Definition-of-Ready Gate**.
3. **As-Built (Code Map)**: Deterministic, compiler-free multi-language static extraction (.NET C# and JavaScript/TypeScript). Generates an as-built C4 model (`asbuilt/workspace.dsl`) and fact registry (`asbuilt/facts.json`) with line-level evidence, calculating bi-directional drift against the intended design.
4. **System 4 (Improve)**: Organizational learning and architectural evolution. Tracks escapes by the stage that should have intercepted them, computes rule effectiveness, drafts architectural proposals (`proposals/*.yaml`), and captures frozen handovers (`handovers/*.yaml`).

---

## 2. Process Architecture & Security Boundary

DesignC runs as an Electron application enforcing strict process boundaries:

```
+---------------------------------------------------------------------------------------------+
|                                    MAIN PROCESS (Node.js)                                   |
|                                                                                             |
|  * Window Management (BrowserWindow, WebContents)                                           |
|  * Filesystem Sandboxing (fsguard.js - scoped strictly to Registry & Codebase roots)        |
|  * Settings & Secret Isolation (settings.js - env var names stored, never values)           |
|  * Dual-Envelope Ledger Writer (ledger-store.js - single-writer atomic append)              |
|  * Subprocess Orchestration:                                                                |
|      - ACP Client (acp.js) via Stdio JSON-RPC                                               |
|      - DesignC MCP Bridge Server (designc-mcp.js)                                           |
|      - P-Checker CLI (dotnet tool run p check)                                              |
|      - Multi-language Extractor (extract.js, extract/*.js)                                  |
|  * Observability Telemetry Fetcher (telemetry.js - Langfuse API v2/v3)                      |
+---------------------------------------------------------------------------------------------+
                                       |
                   IPC Channels (invoke / handle, send / on)
                   Context Isolation: ON | Node Integration: OFF
                                       v
+---------------------------------------------------------------------------------------------+
|                                PRELOAD BRIDGE (preload.js)                                  |
|                                                                                             |
|  * Exposes window.host API surface via contextBridge                                        |
|  * Sanitizes payloads across the IPC boundary                                               |
+---------------------------------------------------------------------------------------------+
                                       |
                                       v
+---------------------------------------------------------------------------------------------+
|                                RENDERER PROCESS (Chromium)                                  |
|                                                                                             |
|  * UI Workbench Shell (index.html, styles.css, app.js)                                      |
|  * Monaco Editor (VS Code Editor Engine) for Structurizr DSL & YAML editing                 |
|  * Design Compiler & Lint Engine (core.js - Structurizr parser, DC000-DC006, Ready Gate)   |
|  * Interactive Drawing Canvas (renderer/canvas/ - SVG engine, AST edit, Agentic rules)      |
|  * In-Memory Ledger Parser & Sort Normalizer (ledger.js - splitLedgerTokens, _ts sort)      |
|  * Agent Panel UI & Governance Controller (agent.js - streaming chat, diff approvals)       |
+---------------------------------------------------------------------------------------------+
```

### 2.1. Filesystem Sandboxing (`fsguard.js`)
To prevent directory traversal attacks or unauthorized file access:
* All read and write requests from the renderer are validated by `fsguard.js`.
* Path traversal tokens (`..`) and absolute paths outside the designated registry directory or configured codebase path are blocked with immediate exceptions.
* Codebase access is strictly **read-only** in the IDE; code mutations must flow through authorized coding pipelines.

### 2.2. Credentials & Secret Hygiene
* `designc.json` never stores raw API tokens, keys, or passwords.
* Configurations specify environment variable *names* (e.g. `"apiKeyEnv": "DESIGNC_LLM_API_KEY"`).
* The IPC bridge `settings:resolve` transmits resolved configuration state indicating whether keys are present (`file`, `env`, or `none`), but redacts all secret values from reaching the renderer DOM.

---

## 3. Physical Data Model (The Registry Folder)

A DesignC workspace is entirely file-backed. Everything is stored in human-readable, git-versioned plain text files:

```
my-registry/
├── designc.json                 # Global configuration (model path, LLM, Langfuse, codebase)
├── quotes-writes.pproj          # P project configuration for behavioral verification
├── model/
│   ├── workspace.dsl            # Primary Structurizr C4 Model (Source of Truth)
│   └── layout.json              # Canvas visual node coordinates & viewport state
├── behaviour/
│   └── quotes-writes.p          # P state-machine protocol models & safety specs
├── decisions/
│   └── D-0001.yaml              # Bound architectural decisions with executable checks
├── requirements/
│   └── HRE-1234.yaml            # Business & functional requirements linked to elements
├── proposals/
│   └── P-0001.yaml              # System 4 architectural improvement proposals
├── handovers/
│   └── H-2026-09-25.yaml        # Immutable milestone handover artifacts
├── reviews/
│   └── 2026-09-30-design-review.md # Exported STRIDE/OWASP design review reports
├── asbuilt/
│   ├── workspace.dsl            # Extracted as-built C4 model from codebase
│   └── facts.json               # Extracted code facts with file:line evidence
├── ledger/
│   ├── checks.jsonl             # Decision check pass/fail logs
│   ├── pipeline.jsonl           # Tasks, as-built edges, false positives
│   ├── designc.jsonl            # Escapes, handovers, extractions, design reviews
│   ├── agents.jsonl             # Agent turns, tool calls, and human approvals
│   └── sessions.jsonl           # MAF harness charter events (SessionStart, Done, etc.)
└── telemetry/
    └── langfuse-sample.json     # Optional offline mock telemetry fixture
```

---

## 4. Subsystem Deep-Dives

### 4.1. Core Design Compiler (`renderer/core.js`)

`core.js` is the heart of System 1. It implements a complete Structurizr DSL parser and C4 model compiler directly in the browser environment, with the same rules and results as the Python CLI in `python/designc`, which is the CI form of the compiler.

#### C4 Model Hierarchy
* **Person**: Human actors interacting with systems.
* **Software System**: Top-level applications or domain boundaries.
* **Container**: Independently deployable units (Web App, API, Worker, Database, Storage).
* **Component**: Internal modules or controllers within a container.
* **Relationship**: Unidirectional dependencies between elements (`->`), tagged with protocols and interaction properties.

#### Structural Lint Rules (`DC000`–`DC006`)
* **`DC000` (Syntax & Properties)**: Validates declared properties against known schemas (e.g. `d.zone`, `d.aka`, `d.agent.*`).
* **`DC001` (Dangling Relationships)**: Flags edges pointing to non-existent or out-of-scope targets.
* **`DC002` (Undeclared Data Stores)**: Enforces that persistent state is encapsulated within declared database/store containers.
* **`DC003` (Synchronous Hop Chains)**: Flags deep synchronous call chains exceeding configured limits (`chainHops`), identifying latency cascades.
* **`DC004` (Non-Idempotent Retry)**: Flags retried synchronous links against non-idempotent endpoints.
* **`DC005` (Missing Error Handlers)**: Enforces error semantics on inter-service communications.
* **`DC006` (Cross-Zone Data Invariants)**: Validates network zone crossing rules (e.g. Internet to Secure Core).

#### Extensibility Hooks
`core.js` provides three extension points utilized by add-ons (such as `designc-canvas`):
```javascript
Core.registerProperties(specArray); // Registers new d.* metadata schemas
Core.registerRules(ruleArray);       // Adds domain-specific linter checks
Core.specsFor(category);             // Queries registered element specifications
```

#### Behavioral Verification (P-Checker Integration)
Structural models cannot detect concurrency races. DesignC integrates the **P Language** (`p-org.github.io/P`) to model communicating state machines and monitors:
* Hand-crafted state machines (`behaviour/*.p`) define state transitions and events.
* Safety specifications (`spec NoLostUpdate observes eCommitted`) assert temporal invariants across all possible execution schedules.
* Test cases (`test tcOptimistic [main = GuardedDb]: assert NoLostUpdate`) explore hundreds of interleaved schedules (`p check -tc tcOptimistic -s 100`).
* Executable checks are bound directly into Decision YAMLs (`decisions/D-0001.yaml` under `checks:`) and executed on demand (Ctrl+Shift+B).

---

### 4.2. Dual-Envelope Ledger Engine (`ledger-store.js` & `renderer/ledger.js`)

DesignC records all operational events into an append-only JSONL ledger. Reconciled under architectural decision `grill-me D16`, it implements a dual-envelope architecture supporting both internal DesignC events and Claude Harness charter events.

```
                                    LEDGER STORE
                               (ledger-store.js / main)
                                         |
               +-------------------------+-------------------------+
               |                                                   |
      Envelope: designc_v1                                Envelope: harness_v1
  - Kinds: snake_case                                 - Kinds: PascalCase
  - ts: epoch ms (number)                             - ts: ISO-8601 UTC (string)
  - Targets: checks.jsonl, pipeline.jsonl,            - Target: sessions.jsonl
             designc.jsonl, agents.jsonl
```

#### The 5 Invariants (R-1 to R-5)
1. **R-1 (Two Envelopes, One Store)**: `designc_v1` and `harness_v1` exist side-by-side. Both are validated and appended by the same store singleton.
2. **R-2 (Synthetic `_ts` Normalization)**: On read, `splitLedgerTokens()` calculates a numeric `_ts` property in memory. In-app sorting is always executed on `_ts`, ensuring perfect chronological ordering regardless of raw storage format.
3. **R-3 (Disjoint Closed Kind Sets)**:
   * `DESIGNC_KINDS`: `['check', 'escape', 'run', 'handover', 'extraction', 'needs_decision', 'needs_decision_resolved', 'asbuilt_edge', 'false_positive', 'task', 'agent_turn', 'agent_tool', 'agent_permission', 'agent_approval', 'unapproved_change', 'design_review']`.
   * `HARNESS_KINDS`: `['SessionStarted', 'SessionEnded', 'ContextCompiled', 'ProposalMade', 'GatePassed', 'GateFailed', 'NeedsDecision', 'ActionExecuted', 'ActionErrored', 'VerifyResult', 'BudgetExceeded', 'HumanDecision', 'Done', 'NoteRecorded', 'WorkRecorded']`.
4. **R-4 (Gate Counting Isolation)**: The Ready-to-Build gate only counts open DesignC `needs_decision` events. Harness `NeedsDecision` events represent agent pipeline blockers and never block the structural design gate.
5. **R-5 (Single Append Path)**: Direct filesystem appending from renderer code is prohibited. All writes route via IPC `host.appendLedgerEvent()`, which serializes writes and validates payloads against schemas in `ledger-store.js`.

---

### 4.3. Interactive Drawing Canvas (`renderer/canvas/`)

The Canvas subsystem provides an interactive SVG-based visual design surface for Structurizr models without introducing heavyweight external dependencies.

```
+---------------------------------------------------------------------------------+
|                                 CANVAS VIEW                                     |
|                                                                                 |
|  +---------------------+   +-------------------------------------------------+  |
|  |   STENCIL PALETTE   |   |                   SVG VIEWPORT                  |  |
|  |---------------------|   |-------------------------------------------------|  |
|  | [O] Person          |   |  +-------------+              +-------------+   |  |
|  | [O] Software System |   |  | Web App     |  (Connect)   | API Service |   |  |
|  | [O] Container       |   |  | [Container] |------------->| [Container] |   |  |
|  | [O] Database        |   |  +-------------+              +-------------+   |  |
|  | [O] Queue / Topic   |   |                                                 |  |
|  | [O] AI Agent        |   |  * Pan: Middle-drag                             |  |
|  | [O] AI Guardrail    |   |  * Zoom: Wheel                                  |  |
|  | [O] Vector Store    |   |  * Grid snap: 16px                              |  |
|  +---------------------+   +-------------------------------------------------+  |
+---------------------------------------------------------------------------------+
                                      |
                     Surgical AST Edit (dsl-edit.js)
                                      v
+---------------------------------------------------------------------------------+
|                         MONACO BUFFER (workspace.dsl)                           |
|                                                                                 |
|  workspace "Example" {                                                          |
|      model {                                                                    |
|          web = container "Web App"                                              |
|          api = container "API Service"                                          |
|          web -> api "Calls"                                                     |
|      }                                                                          |
|  }                                                                              |
+---------------------------------------------------------------------------------+
```

#### Core Components
* **`canvas.js` & `canvas.css`**: Standalone SVG renderer. Handles pointer events, multi-selection, drag-and-drop node placement with 16px grid snapping, connect handles for drawing edges, and viewport panning/zooming.
* **`dsl-edit.js`**: Surgical AST modifier for Structurizr DSL. Parses the DSL line-by-line, calculates exact character ranges, and injects/renames/removes elements. Unrelated lines, formatting, indentation, and user comments are strictly preserved.
* **`layout.js`**: Decouples diagram aesthetics from architectural semantics. Persists element positions `(x, y)` to `model/layout.json`.
* **`agentic-rules.js`**: Implements 10 specialized linter rules (`AG001`–`AG010`) covering agentic AI patterns:
  * `AG001`: Lethal Trifecta (autonomous execution + sensitive data + external network).
  * `AG002`: Excessive Agency (unapproved write/execute actions).
  * `AG003`: Missing stopping conditions / budget caps on agent loops.
  * `AG004`–`AG010`: AI gateway bypass, unobserved agent, unsandboxed code execution, shared memory tenant leakage, single-model SPOF, unauthenticated agent-to-agent calls, shared agent identity.
* **`review.js`**: Evaluates the compiled graph against STRIDE threat categories and OWASP Top 10 for LLM Applications, generating a structured Markdown design review report.
* **Setup-Panel Viewport Fix (`d6a013f`)**: Ensures that entering the Canvas special tab suppresses the blocking `#setup` panel, keeping pointer events focused on drawing.

---

### 4.4. Code Map Multi-Language Extractor (`extract.js` & `extract/`)

The Code Map extractor performs deterministic static analysis of target codebases to discover containers, components, routes, and inter-service dependencies.

#### Language Analyzers
* **.NET Analyzer (`extract/csharp.js`)**:
  * Parses `.sln`, `.csproj`, and `appsettings*.json`.
  * Identifies web APIs, worker services, and CLI applications.
  * Detects Entity Framework `DbContext` stores (`UseSqlServer`, `UseNpgsql`).
  * Traces `HttpClient` registrations (`AddHttpClient`) and maps base URLs to target containers.
  * Scans Azure Service Bus senders, processors, and `[ServiceBusTrigger]` attributes to map queue/topic publishers and subscribers.
* **JavaScript / TypeScript Analyzer (`extract/js.js`, `extract/js-calls.js`)**:
  * Scans `package.json` dependencies to classify SPAs (React, Vite, Next.js, Angular, Vue) vs APIs (Express, NestJS, Fastify, Hono).
  * Extracts route registrations (`app.get()`, `@Controller()`, `@Get()`).
  * Traces outbound HTTP calls (`fetch()`, `axios`, `ky`), including resolution through wrapper modules and tsconfig/vite path aliases.
  * Evaluates Vite dev proxy configurations (`server.proxy`) to resolve target container ports.
* **Linker (`extract/link.js`)**:
  * Matches client calls to route declarations using path normalization.
  * Identifies same-container queue loops as `internal` links.
  * Handles environment variable fallbacks via `designc.json` (`extract.bindings`).
* **DSL Generator (`extract/dsl.js`)**:
  * Writes the resulting architecture to `asbuilt/workspace.dsl`.
  * Writes line-by-line evidence and unresolved items to `asbuilt/facts.json`.
  * Computes drift against the designed model:
    * **In code, not in design**: Undeclared dependencies or shadow systems.
    * **Designed, not in code**: Missing implementations or planned features.

---

### 4.5. Agentic AI & Governance Subsystem (`renderer/agent.js`, `acp.js`, `designc-mcp.js`)

DesignC provides a unified agent interface supporting three distinct execution models:

| Agent Model | Host Process | Communication | Governance Mechanism |
|---|---|---|---|
| **Built-in** | In-App (Electron Main) | Direct HTTP to OpenAI-compatible endpoint | In-app deterministic tool filters and approval cards |
| **ACP (Agent Client Protocol)** | External CLI process (Claude Code, Codex, Copilot) | Newline-delimited JSON-RPC over Stdio | Stdio bridge; tool execution routed through DesignC MCP server |
| **AG-UI** | Remote Microservice (e.g. MAF Host) | HTTP / SSE / JSON streaming | Server-side Access Control Services (ACS) + frontend approval interrupts |

#### Governance & Approvals
* **Fail-Closed Role Policies**:
  * **Architect (S1)**: Can read workspace, findings, gate, code map; can propose model edits and mint decisions (requires human approval).
  * **Grill-me (S1)**: Focused on stress-testing decisions and requirements; can mint decisions (requires human approval).
  * **Analyst (S4)**: Analyzes escapes, telemetry, and rule health; can mint proposals (requires human approval).
* **Deterministic Diff Validation**: Proposed model edits are validated against the DSL AST before being presented to the human.
* **Unapproved Change Detection**: If an external ACP agent mutates files on disk using native tools without going through DesignC approval cards, the turn flags an `unapproved_change` event in `ledger/agents.jsonl`.
* **DesignC MCP Server (`designc-mcp.js`)**: Exposes four core tools over Model Context Protocol:
  1. `read_registry`: Reads files, decisions, and models.
  2. `check_dsl`: Lints Structurizr DSL and returns `DC000`–`DC006` errors.
  3. `query_ledger`: Queries event records by kind and timestamp.
  4. `get_design_review`: Generates the automated STRIDE/OWASP design review report.

---

### 4.6. Telemetry & Observability Engine (`telemetry.js`)

DesignC integrates directly with **Langfuse** (self-hosted v4 or Cloud) to tie runtime agent executions back to the C4 architectural design.

* **API Endpoints**: Uses Observations API v2 (`GET /api/public/v2/observations`) and Scores API v3 (`GET /api/public/v3/scores`). Avoids deprecated v1 endpoints.
* **Semantic Tagging**: Traces tagged with `designc` are mapped to C4 elements using trace metadata (`element`, `task`, `decision`, `attempt`).
* **Cost & Token Tracking**: Aggregates token usage and monetary cost per container and system.
* **Escape Suggestion Pipeline**: Agent tasks requiring 3+ attempts, failing completely, or escalating to human intervention are surfaced in System 4 as candidate escapes. One click registers them into `ledger/designc.jsonl`.

---

### 4.7. Configuration & Setup Engine (`settings.js` & `#setup` panel)

#### Precedence Hierarchy
Settings resolution (`resolveSettings()`) enforces a strict precedence ladder:
1. `designc.json` file settings (Highest priority).
2. Environment variables (e.g. `LANGFUSE_PUBLIC_KEY`, `DESIGNC_LLM_BASE_URL`).
3. Detected system tools (e.g. `claude` CLI on system `PATH`).

#### Non-Destructive Add-Only Writing
The "Set up this registry" panel (`#setup`) provides a diff-previewed setup flow:
* Never overwrites existing keys.
* Writes variable names rather than secret values.
* Persists user-skipped blocks in `"setup": { "skip": ["block_name"] }`.

---

## 5. IPC API Reference (`preload.js`)

The renderer interacts with the operating system through `window.host`:

```typescript
interface DesigncHostBridge {
  // Application Lifecycle & Folder
  boot(): Promise<BootConfig>;
  openFolder(): Promise<string | null>;
  openPath(path: string): Promise<boolean>;
  openSample(): Promise<string>;
  
  // Filesystem Operations (Sandboxed)
  tree(): Promise<FileNode[]>;
  read(relPath: string): Promise<string>;
  readOptional(relPath: string): Promise<string | null>;
  exists(relPath: string): Promise<boolean>;
  write(relPath: string, content: string): Promise<void>;
  list(relDir: string, ext?: string): Promise<string[]>;
  
  // Unified Ledger
  appendLedgerEvent(event: LedgerEvent): Promise<{ written: boolean }>;
  
  // Decision Checks & Behavioral Verification
  runCheck(id: string, cmd: string): Promise<void>;
  cancelCheck(id: string): Promise<void>;
  onCheckOutput(callback: (output: CheckOutput) => void): () => void;
  
  // Code Map Extractor
  chooseCodebase(): Promise<string | null>;
  extract(codebasePath: string): Promise<ExtractionResult>;
  readCode(codebasePath: string, relPath: string): Promise<string>;
  searchCode(codebasePath: string, query: string, maxResults: number): Promise<SearchResult[]>;
  
  // Telemetry & Settings
  telemetry(): Promise<TelemetryPayload>;
  settings(): Promise<ResolvedSettings>;
  setupPreview(options: SetupOptions): Promise<SetupPreviewResult>;
  setupWrite(oldJson: string, nextJson: string): Promise<{ written: boolean }>;
  
  // Agent Subsystems
  chat(messages: Message[]): Promise<ChatResponse>;
  agentChat(id: string, payload: AgentPayload): Promise<void>;
  agentCancel(id: string): Promise<void>;
  onAgentDelta(callback: (delta: AgentDelta) => void): () => void;
  
  // ACP & AG-UI
  acpAgents(): Promise<AcpAgentConfig[]>;
  acpConnect(key: string, metadata: object): Promise<void>;
  acpPrompt(key: string, text: string): Promise<void>;
  acpCancel(key: string): Promise<void>;
  acpDisconnect(key: string): Promise<void>;
  aguiAgents(): Promise<AguiAgentConfig[]>;
  aguiRun(id: string, key: string, body: object): Promise<void>;
  aguiCancel(id: string): Promise<void>;
  
  // UI & File Watcher Events
  onChanged(callback: (event: FsChangeEvent) => void): () => void;
  onFolder(callback: (root: FolderRoot) => void): () => void;
  onCmd(callback: (commandId: string) => void): () => void;
}
```

---

## 6. Verification & Quality Gates

The codebase enforces strict mechanical gates before any commit:

1. **Require Smoke Gate**:
   ```powershell
   node -e "require('./extract.js')"
   ```
   Ensures core modules load cleanly with zero syntax or packaging failures.

2. **Automated Unit & Integration Test Suite**:
   ```powershell
   node --test "test/**/*.test.js"
   ```
   Runs 100 named unit tests covering AST editing, ledger serialization, token parsing, rules linting, and extractor logic. (All 100 must pass with individual checkmarks).

3. **Dependency & Vulnerability Audit**:
   ```powershell
   npm audit --audit-level=high
   ```
   Ensures zero application-level vulnerabilities. Only the 2 pre-existing upstream Electron vulnerabilities are permitted.

4. **Single-Writer Ledger Invariant Guard**:
   `test/ledger-guard.test.js` performs static analysis across the entire codebase to assert that no file other than `ledger-store.js` writes to `ledger/*.jsonl`.

---

## 7. Build, Packaging & Execution

### Prerequisites
* Node.js v20+ and npm.
* .NET SDK 8 (optional, required only for running P protocol checks).
* Java 11+ JRE on PATH (required for P compiler).

### Quickstart Commands
```bash
# Navigate to desktop app
cd designc-desktop/app

# Install dependencies
npm install

# Launch workbench on Windows (auto-configures Langfuse and Electron flags)
.\run-designc.ps1 C:\path\to\registry

# Launch workbench on macOS/Linux
npm start -- /path/to/registry

# Run complete test suite
node --test "test/**/*.test.js"

# Build production installers
npm run dist:win    # Windows installer (Setup.exe)
npm run dist:mac    # macOS DMG
npm run dist:linux  # Linux AppImage
```
