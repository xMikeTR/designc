// designc tagging convention for Langfuse, via OpenTelemetry.
// Sketch for the MAF harness: not compiled here. Check it against your OpenTelemetry and MAF versions.
//
// The IDE reads these trace metadata keys (rename them in designc.json "langfuse.fields"):
//   system    S1 | S2 | S4
//   element   design element name, e.g. "Quotes DB" (must match the model or a d.aka)
//   task      plan task id, e.g. "T-04"
//   decision  decision id the task implements, e.g. "D-0001"
//   attempt   1, 2, 3 … for reruns of the same task
//   outcome   passed | failed | escalated   (or send a "task_passed" score instead)
// and the trace tag "designc", which is how the IDE filters.
//
// Langfuse maps langfuse.trace.metadata.<key> to filterable trace metadata and langfuse.trace.tags
// to tags, and wants them on every span of the trace, so they travel as OpenTelemetry baggage
// and a processor copies them onto each span as it starts.
using System.Diagnostics;
using OpenTelemetry;

public static class DesigncTelemetry
{
    public const string Tag = "designc";
    public static readonly ActivitySource Source = new("Designc.Harness");
    private const string Prefix = "langfuse.trace.metadata.";

    /// <summary>Wrap one run: a task attempt in S2, a grill-me session in S1, an analyst pass in S4.
    /// Every span started inside, including MAF agent and chat-client spans, carries the keys.</summary>
    public static Run BeginRun(string name, string system, string? element = null, string? task = null,
                               string? decision = null, int? attempt = null)
    {
        var previous = Baggage.Current;
        var b = previous;
        void Set(string key, string? value) { if (!string.IsNullOrEmpty(value)) b = Baggage.SetBaggage(Prefix + key, value, b); }
        Set("system", system); Set("element", element); Set("task", task); Set("decision", decision);
        Set("attempt", attempt?.ToString());
        Baggage.Current = b;
        var activity = Source.StartActivity(name, ActivityKind.Internal);
        return new Run(activity, previous);
    }

    public sealed class Run : IDisposable
    {
        private readonly Activity? _root; private readonly Baggage _previous;
        internal Run(Activity? root, Baggage previous) { _root = root; _previous = previous; }

        /// <summary>passed | failed | escalated. Set once, when verify decides.</summary>
        public void Outcome(string outcome) => _root?.SetTag(Prefix + "outcome", outcome);

        public void Dispose() { _root?.Dispose(); Baggage.Current = _previous; }
    }
}

/// <summary>Copies designc baggage onto every span, plus the designc tag.</summary>
public sealed class DesigncBaggageProcessor : BaseProcessor<Activity>
{
    public override void OnStart(Activity activity)
    {
        var any = false;
        foreach (var (key, value) in Baggage.Current.GetBaggage())
        {
            if (!key.StartsWith("langfuse.trace.metadata.", StringComparison.Ordinal)) continue;
            activity.SetTag(key, value); any = true;
        }
        if (any) activity.SetTag("langfuse.trace.tags", new[] { DesigncTelemetry.Tag });
    }
}

/* Wiring (Program.cs of the harness host):

var basic = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{pk}:{sk}"));
builder.Services.AddOpenTelemetry().WithTracing(t => t
    .AddSource(DesigncTelemetry.Source.Name)
    .AddSource("*Microsoft.Agents.AI*", "*Microsoft.Extensions.AI*")   // confirm the source names your MAF version emits
    .AddProcessor(new DesigncBaggageProcessor())
    .AddOtlpExporter(o =>
    {
        o.Endpoint = new Uri($"{langfuseHost}/api/public/otel/v1/traces");
        o.Protocol = OtlpExportProtocol.HttpProtobuf;
        // x-langfuse-ingestion-version=4 makes data visible to the v2 read API in real time
        o.Headers = $"Authorization=Basic {basic},x-langfuse-ingestion-version=4";
    }));

// In the team sub-workflow, around one task attempt:
using var run = DesigncTelemetry.BeginRun($"task {task.Id}", "S2", task.Element, task.Id, task.Decision, attempt);
var result = await teamWorkflow.RunAsync(task, ct);
run.Outcome(result.Passed ? "passed" : result.Escalated ? "escalated" : "failed");
*/
