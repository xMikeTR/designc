const fs = require('fs');
const os = require('os');
const path = require('path');

// Inline temp-dir fixtures: generic names only, nothing under fixtures/.
async function withRepo(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    }
    return await fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

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

module.exports = { withRepo, FUNCTIONS_CSPROJ, JOBS_REPO };
