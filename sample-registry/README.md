# Sample registry

The contract between System 1 (design) and System 2 (build). designc opens this folder.

| Path | Holds |
| --- | --- |
| `model/workspace.dsl` | Structurizr C4 model with `d.*` design properties |
| `behaviour/*.p` | P models, one per protocol |
| `requirements/*.yaml` | Jira keys the design answers, pinned |
| `jira-mapping.yaml` | Maps Jira labels and components to a requirement's `risk`, `data_class` and `repo` at import. Ships empty |
| `inbox/*.yaml` | Jira issues swept for you, waiting in the Work view to accept or dismiss. `HRE-1301` is an invented example |
| `decisions/*.yaml` | Decisions: minted, then bound by a human, each with checks |
| `proposals/*.yaml` | System 4 proposals, same lifecycle as decisions |
| `handovers/*.yaml` | Frozen handover records |
| `ledger/*.jsonl` | Append-only events from every system |
| `designc.json` | Settings: model path, chain length, LLM gateway |

`ledger/pipeline.jsonl` contains sample events marked `"sample": true`. Delete the file when real pipeline events arrive.
