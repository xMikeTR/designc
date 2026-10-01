# designc agent host (MAF over AG-UI)

A sketch of the MAF side of designc's AG-UI agents: one ASP.NET Core app exposing Grill-me at `/grill` and the Architect at `/architect`, using the same gateway, registry rules and approvals as the IDE. **It has not been compiled**; expect to fix API names against your `Microsoft.Agents.AI` version (for example `MapAGUIServer` vs `MapAGUI`), then pin package versions.

```
dotnet run            # listens on http://127.0.0.1:5100
```

Environment: `DESIGNC_LLM_API_KEY` (gateway key) and `DESIGNC_MAF_TOKEN` (bearer token designc sends). Point `Registry:Path` at the same registry folder designc opens: the host writes approved changes there and designc picks them up through its file watcher.

In designc's `designc.json`:

```json
"aguiAgents": {
  "maf-architect": { "label": "Architect (MAF)", "url": "http://127.0.0.1:5100/architect", "headers": { "Authorization": "Bearer ${env:DESIGNC_MAF_TOKEN}" } },
  "maf-grill":     { "label": "Grill-me (MAF)",  "url": "http://127.0.0.1:5100/grill",     "headers": { "Authorization": "Bearer ${env:DESIGNC_MAF_TOKEN}" } }
}
```

What happens on the wire: designc POSTs a run with the conversation, its own tools as frontend tools, the design state as shared state, and the role instructions as context. The host streams text and tool events. Backend tools marked `ApprovalRequiredAIFunction` end the run with an interrupt (`reason: tool_call`); designc shows an approval card and resumes the thread with `resume: [{ interruptId, status: "resolved", payload: { accepted } }]`. Frontend tools the agent calls run inside designc under its role policy, and their results go back in the next run.

Before this carries real work: register AGT's governance middleware so ACS policy sees every tool call, add the ledger middleware, wrap runs in `DesigncTelemetry.BeginRun` so Langfuse traces carry element, task and decision, and add a test for the duplicate-execution hazard in approval flows (an interrupt must execute its tool at most once, even if a resume is sent twice).
