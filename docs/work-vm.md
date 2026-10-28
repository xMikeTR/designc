# Taking designc, S2 and M to the work VM

First run on a real codebase: follow [test-drive.md](test-drive.md) once you are set up.

Read this on the VM. The work VM has no Anthropic key: models come through Vertex AI with
gcloud Application Default Credentials (ADC). Nothing here needs a key in a file.

## 1. Sign in once

```
gcloud auth application-default login
gcloud config set project <project>
```

Both apps check this with `gcloud auth application-default print-access-token`. The token is
never stored.

## 2. designc

```
npm install
scripts/setup-wizard.sh <design-folder>     # choose 3, Claude on Vertex AI
npm start -- <design-folder>
```

The wizard writes `llm: {provider: "vertex", project, region, model}` into the folder's
`designc.json`. Region `global` is the default. Without a model, Grill-me still works through
an ACP agent. First launch shows a short tour; Help, Take the Tour shows it again.

## 3. S2 (factory-s2)

```
scripts/setup-wizard.sh
source ~/.config/factory-s2/env
dotnet run --project src/Factory.S2 -- validate --help
```

Choose Vertex (the default) for both sides. Any Vertex model works: `claude-*` ids use the
Anthropic client, everything else (Gemini, Model Garden) the OpenAI-compatible endpoint.

The reviewer must be a different model family from the implementer. A non-Claude reviewer
needs `FACTORY_REVIEWER_MODEL_FAMILY` (for example `google`). Same-family review
(`FACTORY_REVIEWER_SAME_FAMILY=allow`) is limited to dry-run merges.

## 4. M (agent contracts)

M lives in `FrontierAgenticSoftware/m-lang`. Copy or clone it to the VM, then:

```
uv sync
uv run mlang compile examples/underwriting.m --emit agt,agis,sdk
```

How M joins designc and S2 is planned, not built yet:

| Stage | What | Where |
| --- | --- | --- |
| 1 | designc drafts one `.m` per agent element from its `d.agent.*` properties and tool relationships; a person completes types and `never` rules | designc Design view, button |
| 2 | The handover carries the `.m` files and their compiled AGT policy | handover folder |
| 3 | S2 loads the AGT policy for the agents it runs and refuses a run whose agent has no compiled contract | S2 harness |

Stage 1 is a proposal: designc may suggest, a person decides what the contract says.

## 5. Check without a model

- designc: `npm test`, then open the sample project.
- S2: `dotnet run --project src/Factory.S2 -- validate`.
