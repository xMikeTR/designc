// designc agent host: MAF agents exposed over AG-UI for the designc agent panel (and anything else that speaks AG-UI).
// Sketch, not compiled where it was written: check API names against your Microsoft.Agents.AI version.
using System.ClientModel;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Hosting.AGUI.AspNetCore;
using Microsoft.Extensions.AI;
using OpenAI;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAGUI();
var cfg = builder.Configuration;

// Every model call goes through the gateway (LiteLLM behind APIM), never straight to a provider.
var key = Environment.GetEnvironmentVariable(cfg["Gateway:ApiKeyEnv"] ?? "DESIGNC_LLM_API_KEY")
          ?? throw new InvalidOperationException("Gateway key environment variable is not set.");
IChatClient chat = new OpenAIClient(new ApiKeyCredential(key), new OpenAIClientOptions { Endpoint = new Uri(cfg["Gateway:BaseUrl"]!) })
    .GetChatClient(cfg["Gateway:Model"]!)
    .AsIChatClient();

var registry = new RegistryTools(cfg["Registry:Path"]!, cfg["Registry:Model"] ?? "model/workspace.dsl");

// Reads run freely. Writes are ApprovalRequiredAIFunction: the AG-UI adapter ends the run with an interrupt,
// designc shows an approval card, and the function runs only if the resume says accepted.
AITool[] readTools =
[
    AIFunctionFactory.Create(registry.ReadModel, "read_registry_model", "Read the design model (Structurizr DSL) with line numbers."),
    AIFunctionFactory.Create(registry.ListDecisions, "list_registry_decisions", "List decision files with their status and statement."),
];
AITool proposeEdit = new ApprovalRequiredAIFunction(AIFunctionFactory.Create(registry.ProposeModelEdit, "apply_model_patch",
    "Replace text in the design model. find must match exactly once. Needs the user's approval."));
AITool mintDecision = new ApprovalRequiredAIFunction(AIFunctionFactory.Create(registry.MintDecision, "mint_registry_decision",
    "Create a decision file with status minted. Binding is a human action. Needs the user's approval."));

const string Rules = """
    You serve the designc system design IDE. The design model is the source of truth; code is generated from it.
    designc may also offer you its own tools (findings, gate, code map, telemetry): prefer those for reading the design state,
    and use the shared state it sends. Never bind decisions. Keep answers short and cite line numbers.
    """;

// Governance: register AGT here so ACS policy (compiled from mlang) sees every tool call, plus ledger and telemetry.
//   .AsBuilder().Use(new GovernancePolicyMiddleware(acsEvaluator)).Use(new LedgerMiddleware(...)).Build()
// and wrap each run in DesigncTelemetry.BeginRun(...) (integrations/DesigncTelemetry.cs) so Langfuse traces carry element/task/decision.
AIAgent grill = chat.AsAIAgent(
    name: "grill-me",
    instructions: Rules + "\nYou are Grill-me: ask one question at a time, starting with what blocks the gate; offer to mint a decision from each answer.",
    tools: [.. readTools, mintDecision]);
AIAgent architect = chat.AsAIAgent(
    name: "architect",
    instructions: Rules + "\nYou are the Architect: explain findings and propose precise model edits or decisions.",
    tools: [.. readTools, proposeEdit, mintDecision]);

var app = builder.Build();

// Bearer token check. designc sends it from designc.json: "headers": { "Authorization": "Bearer ${env:DESIGNC_MAF_TOKEN}" }
var token = Environment.GetEnvironmentVariable(cfg["Auth:TokenEnv"] ?? "DESIGNC_MAF_TOKEN");
app.Use(async (ctx, next) =>
{
    if (!string.IsNullOrEmpty(token) && ctx.Request.Headers.Authorization != $"Bearer {token}") { ctx.Response.StatusCode = 401; return; }
    await next();
});

// Newer builds name this MapAGUIServer; earlier previews used MapAGUI.
app.MapAGUIServer("/grill", grill);
app.MapAGUIServer("/architect", architect);
app.Run();
