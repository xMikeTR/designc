const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extract } = require('../extract');

function repo(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-'));
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), t);
  }
  return d;
}
const fsproj = pkgs => `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework></PropertyGroup>
<ItemGroup>${pkgs.map(p => `<PackageReference Include="${p}" Version="1.0.0" />`).join('')}</ItemGroup></Project>`;

test('an F# agent that references the Anthropic package gets the Anthropic API as an external system', async () => {
  const r = await extract(repo({ 'Agent/Agent.fsproj': fsproj(['Anthropic']), 'Agent/Program.fs': 'printfn "hi"\n' }));
  const el = r.facts.elements.find(e => e.name === 'Anthropic API');
  assert.ok(el, 'Anthropic API missing');
  assert.equal(el.kind, 'external');
  const edge = r.facts.edges.find(e => e.to === 'Anthropic API');
  assert.ok(edge, 'edge missing');
  assert.equal(edge.label, 'Calls');
  assert.match(edge.evidence[0].text, /PackageReference: Anthropic/);
});

test('a C# project with Anthropic.SDK or OpenAI gets the matching external system', async () => {
  const r = await extract(repo({
    'A/A.csproj': fsproj(['Anthropic.SDK']).replace('Exe', 'Exe'),
    'B/B.csproj': fsproj(['Azure.AI.OpenAI']),
  }));
  assert.ok(r.facts.elements.find(e => e.name === 'Anthropic API'));
  assert.ok(r.facts.elements.find(e => e.name === 'OpenAI API'));
});

test('a project with no LLM package gets no LLM external', async () => {
  const r = await extract(repo({ 'A/A.csproj': fsproj(['Newtonsoft.Json']) }));
  assert.equal(r.facts.elements.some(e => /API$/.test(e.name)), false);
});

test('a TypeScript service importing @anthropic-ai/sdk or openai gets them too', async () => {
  const r = await extract(repo({
    'svc/package.json': JSON.stringify({ name: 'svc', dependencies: { express: '4' } }),
    'svc/src/index.ts': "import express from 'express';\nimport Anthropic from '@anthropic-ai/sdk';\nimport OpenAI from 'openai';\nconst app = express();\napp.get('/ping', (_q, s) => s.send('ok'));\n",
  }));
  assert.ok(r.facts.elements.find(e => e.name === 'Anthropic API'), 'Anthropic API missing');
  assert.ok(r.facts.elements.find(e => e.name === 'OpenAI API'), 'OpenAI API missing');
});
