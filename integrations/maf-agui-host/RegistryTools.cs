using System.ComponentModel;
using System.Text;
using System.Text.RegularExpressions;

/// <summary>Registry access for hosted agents. Same limits as designc's own agent policy:
/// writes only inside the registry, model edits must match exactly once, decisions are always minted.</summary>
public sealed class RegistryTools(string registryRoot, string modelPath)
{
    private readonly string _root = Path.GetFullPath(registryRoot);

    private string Inside(string rel)
    {
        var abs = Path.GetFullPath(Path.Combine(_root, rel));
        if (!abs.StartsWith(_root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"{rel} is outside the registry.");
        return abs;
    }

    public string ReadModel([Description("First line, 1-based")] int from = 1, [Description("Last line")] int to = int.MaxValue)
    {
        var lines = File.ReadAllLines(Inside(modelPath));
        var sb = new StringBuilder();
        for (var i = Math.Max(1, from); i <= Math.Min(to, lines.Length); i++) sb.Append(i.ToString().PadLeft(4)).Append("  ").AppendLine(lines[i - 1]);
        return sb.ToString();
    }

    public string ListDecisions()
    {
        var dir = Inside("decisions");
        if (!Directory.Exists(dir)) return "No decisions.";
        return string.Join('\n', Directory.GetFiles(dir, "*.yaml").OrderBy(f => f).Select(f =>
        {
            var text = File.ReadAllText(f);
            string Field(string k) => Regex.Match(text, $@"^{k}:\s*(.*)$", RegexOptions.Multiline).Groups[1].Value.Trim();
            return $"{Field("id")} [{Field("status").Split('#')[0].Trim()}] {Field("statement")}";
        }));
    }

    public string ProposeModelEdit(
        [Description("Exact text to replace; must occur exactly once")] string find,
        [Description("Replacement text")] string replace,
        [Description("Why")] string reason)
    {
        var path = Inside(modelPath);
        var text = File.ReadAllText(path);
        var count = string.IsNullOrEmpty(find) ? 0 : Regex.Matches(text, Regex.Escape(find)).Count;
        if (count != 1) throw new InvalidOperationException(count == 0 ? "find does not match the model." : $"find matches {count} places; include more context.");
        var at = text.IndexOf(find, StringComparison.Ordinal);
        File.WriteAllText(path, text[..at] + replace + text[(at + find.Length)..]);
        var line = text[..at].Count(c => c == '\n') + 1;
        return $"Applied at line {line}: {reason}";
    }

    public string MintDecision(
        [Description("What was decided")] string statement,
        [Description("fix or accept")] string effect,
        [Description("Design element names it binds to")] string[] binds,
        [Description("Finding codes it resolves, e.g. DC002")] string[] resolves,
        [Description("Commands that prove it")] string[] checks,
        [Description("Why")] string rationale)
    {
        var dir = Inside("decisions"); Directory.CreateDirectory(dir);
        var next = Directory.GetFiles(dir, "D-*.yaml").Select(f => int.TryParse(Path.GetFileNameWithoutExtension(f)[2..], out var n) ? n : 0).DefaultIfEmpty(0).Max() + 1;
        var id = $"D-{next:0000}";
        static string Q(string s) => System.Text.Json.JsonSerializer.Serialize(s);
        var yaml = $"""
            id: {id}
            status: minted          # minted | checked | bound | superseded
            effect: {(effect == "accept" ? "accept" : "fix")}
            requirement: null
            binds: [{string.Join(", ", binds.Select(Q))}]
            resolves: [{string.Join(", ", resolves.Select(r => Q(r.ToUpperInvariant())))}]
            statement: {Q(statement)}
            checks:
            {string.Join("\n", (checks.Length > 0 ? checks : ["TODO command that proves it"]).Select(c => "  - " + Q(c)))}
            rationale: {Q(rationale)}
            drafted_by: maf-host
            """;
        File.WriteAllText(Path.Combine(dir, $"{id}.yaml"), yaml + "\n");
        return $"Created decisions/{id}.yaml as minted. Binding it is up to the user.";
    }
}
