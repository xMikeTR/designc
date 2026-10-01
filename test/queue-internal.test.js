const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('../extract.js');

const { withRepo } = require('./helpers/with-repo');

const FUNCTIONS_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>
  <ItemGroup><PackageReference Include="Microsoft.Azure.Functions.Worker" Version="1.0.0" /></ItemGroup>
</Project>`;

// The motivating shape: a queue sent and received inside one Functions app.
const JOBS_REPO = {
  'Jobs.Functions/Jobs.Functions.csproj': FUNCTIONS_CSPROJ,
  'Jobs.Functions/ReportJobFunction.cs': `public class ReportJobFunction
{
    [Function("ReportJob")]
    public Task<ReportJobOutput> Run([HttpTrigger(AuthorizationLevel.Function, "post")] HttpRequestData req) => null;
}`,
  'Jobs.Functions/ReportJobOutput.cs': `public class ReportJobOutput
{
    [ServiceBusOutput("jobs", Connection = "Bus")]
    public string Message { get; set; }
}`,
  'Jobs.Functions/JobWatcherFunction.cs': `public class JobWatcherFunction
{
    [Function("JobWatcher")]
    public Task<JobWatcherOutput> Run([ServiceBusTrigger("jobs", Connection = "Bus")] string message) => null;
}`,
  'Jobs.Functions/JobWatcherOutput.cs': `public class JobWatcherOutput
{
    [ServiceBusOutput("jobs", Connection = "Bus")]
    public string Again { get; set; }
    [ServiceBusOutput("%NoticesTopic%", Connection = "Bus")]
    public string Notice { get; set; }
}`,
};

test('a queue sent and received inside one deployable is recorded in facts.internal, not facts.edges', async () => {
  await withRepo(JOBS_REPO, async dir => {
    const r = await extract(dir);
    assert.equal(r.facts.edges.some(e => e.kind === 'async'), false);
    const links = r.facts.internal.filter(l => l.key === 'jobs');
    assert.ok(links.length >= 1);
    for (const l of links) {
      assert.equal(l.owner, 'Jobs.Functions');
      assert.ok(l.send.file && l.send.line && l.receive.file && l.receive.line);
    }
    assert.ok(links.some(l => /ReportJobOutput\.cs$/.test(l.send.file) && /JobWatcherFunction\.cs$/.test(l.receive.file)));
  });
});
