// The @critical journeys of the designc app. Each runs on a fresh copy of a registry,
// outside any git repository, with its own user data folder (see helpers.js).
// Agents never delete, skip or loosen these tests (AGENTS.md); test/e2e-guard.test.js pins the titles.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { copyRegistry, launch, readLedger, cleanup } = require('./helpers');

let session;
test.afterEach(async () => { if (session) await session.app.close(); session = null; cleanup(); });

test('user can open a registry @critical', async () => {
  const { reg } = copyRegistry('sample-registry');
  session = await launch(reg);
  const { page } = session;
  // Explorer is the view a registry opens in, with the model open in the editor.
  const sidebar = page.locator('#sbBody');
  await expect(sidebar.getByText('workspace.dsl', { exact: true })).toBeVisible();
  await expect(page.locator('#monaco').getByText('"RE Pricing Engine"')).toBeVisible();
  await sidebar.getByText('HRE-1234.yaml', { exact: true }).click();
  await expect(page.locator('#tabs').getByText('HRE-1234.yaml')).toBeVisible();
  await expect(page.locator('#monaco').getByText('HRE-1234').first()).toBeVisible();
});

test('user sees the model findings @critical', async () => {
  const { reg } = copyRegistry('sample-registry');
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: /^Problems/ }).click();
  const panel = page.locator('#panelBody');
  // Same findings as the Python CLI on sample-registry (AGENTS.md): 2 errors, 5 warnings.
  await expect(panel.getByText('⊗')).toHaveCount(2);
  await expect(panel.getByText('⚠')).toHaveCount(5);
  await expect(panel.getByText('designc(DC002)')).toBeVisible();
  await expect(panel.getByText('designc(DC004)')).toBeVisible();
});

test('user can bind a decision @critical', async () => {
  const { reg } = copyRegistry('sample-registry');
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Design' }).click();
  const sidebar = page.locator('#sbBody');
  await sidebar.getByRole('button', { name: 'Bind', exact: true }).first().click();
  await expect.poll(() => fs.readFileSync(path.join(reg, 'decisions/D-0001.yaml'), 'utf8')).toMatch(/^status: bound/m);
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'decision_promoted').map(e => e.decision))
    .toEqual(['D-0001']);
  await expect(sidebar.getByText('bound', { exact: true })).toBeVisible();
});

test('user can freeze a handover @critical', async () => {
  // The sample registry is not ready: the gate says so and offers no freeze.
  const sample = copyRegistry('sample-registry');
  session = await launch(sample.reg);
  await session.page.getByRole('button', { name: 'Design' }).click();
  await expect(session.page.locator('#sbBody').getByText(/✗ \d+ blocking items/)).toBeVisible();
  await expect(session.page.getByRole('button', { name: 'Freeze handover' })).toHaveCount(0);
  await session.app.close();

  const { reg } = copyRegistry('e2e/fixtures/ready-registry');
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Design' }).click();
  await expect(page.getByText('✓ Ready to hand over')).toBeVisible();
  await page.getByRole('button', { name: 'Freeze handover' }).click();
  await expect(page.getByText(/^Handover \S+ frozen at r-/)).toBeVisible();
  const ids = fs.readdirSync(path.join(reg, 'handovers'));
  expect(ids).toHaveLength(1);
  expect(fs.existsSync(path.join(reg, 'handovers', ids[0], 'handover.yaml'))).toBe(true);
  expect(readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'handover').map(e => e.handover)).toEqual(ids);

  // A second freeze of the same design is refused: a frozen handover is never rewritten.
  await page.getByRole('button', { name: 'Freeze handover' }).click();
  await expect(page.getByText(`This design is already frozen as ${ids[0]}`, { exact: false })).toBeVisible();
  expect(fs.readdirSync(path.join(reg, 'handovers'))).toEqual(ids);
});

test('user can extract the code map @critical', async () => {
  const { reg } = copyRegistry('sample-registry', { codebase: true });
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Code map' }).click();
  await page.locator('#sbBody').getByRole('button', { name: 'Extract the as-built map' }).click();
  await expect(page.getByText(/^Mapped \d+ deployables/)).toBeVisible();
  const dsl = fs.readFileSync(path.join(reg, 'asbuilt/workspace.dsl'), 'utf8');
  expect(dsl).toMatch(/container "Pricing\.Api"/);
  expect(readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'extraction')).toHaveLength(1);
  // The map is drawn: an SVG box labelled with the extracted container.
  await expect(page.locator('#special svg text', { hasText: 'Pricing.Api' }).first()).toBeVisible();
});

test('user can track a work item @critical', async () => {
  const { execFileSync } = require('child_process');
  const { reg, dir } = copyRegistry('e2e/fixtures/ready-registry');
  const repo = path.join(dir, 'repo');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...a) => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' }).trim();
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git('add', '-A'); git('commit', '-q', '-m', 'first');
  git('switch', '-q', '-c', 'feature');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n'); git('add', '-A'); git('commit', '-q', '-m', 'the work');
  const commit = git('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(reg, 'work'));
  fs.writeFileSync(path.join(reg, 'work/W-quote.yaml'), [
    'id: W-quote', 'title: Quote endpoint', 'requirement: QT-1', 'elements: [Quotes API]', 'repo: ../repo',
    'writes: ["src/**"]', 'done_when:', '  - gate: "true"', '',
  ].join('\n'));

  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  const item = page.locator('[data-workitem="W-quote"]');
  await expect(item.getByText('backlog', { exact: true })).toBeVisible();

  await item.getByRole('button', { name: 'Start' }).click();
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'item_pulled').map(e => e.item)).toEqual(['W-quote']);

  await item.getByRole('button', { name: 'Run gates' }).click();
  await expect.poll(() => readLedger(reg, 'checks.jsonl').filter(e => e.kind === 'item_gate').map(e => [e.gate, e.outcome, e.commit, e.dirty]))
    .toEqual([['true', 'pass', commit, false]]);

  // The gate passed, but the commit is only on a feature branch: Done is refused and says why.
  await item.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('.askcard input').fill(commit);
  await page.locator('.askcard').getByRole('button', { name: 'OK' }).click();
  await expect(item.getByText(`is not on main`, { exact: false })).toBeVisible();
  expect(readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'item_done')).toHaveLength(0);

  // Once the commit is merged to main, Done is recorded.
  git('switch', '-q', 'main'); git('merge', '-q', '--ff-only', 'feature');
  await item.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('.askcard input').fill(commit);
  await page.locator('.askcard').getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'item_done').map(e => [e.item, e.commit])).toEqual([['W-quote', commit]]);
});

test('a frozen work item says when the design moved under it', async () => {
  const { reg } = copyRegistry('e2e/fixtures/ready-registry');
  fs.mkdirSync(path.join(reg, 'work'));
  fs.writeFileSync(path.join(reg, 'work', 'W-api.yaml'),
    'id: W-api\ntitle: Quotes API\nrequirement: QT-1\nelements: [Quotes API]\ndone_when:\n  - gate: "true"\n');
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  const item = page.locator('[data-workitem="W-api"]');
  await expect(item.getByText('Gate for this item: ready.', { exact: false })).toBeVisible();
  await item.getByRole('button', { name: 'Freeze item' }).click();
  await expect(item.getByText('Design unchanged for this item since it was frozen.')).toBeVisible();
  const ids = fs.readdirSync(path.join(reg, 'handovers'));
  expect(ids).toHaveLength(1);
  expect(readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'handover').map(e => e.item)).toEqual(['W-api']);

  // The model changes under the frozen item: it says so and offers Freeze again.
  const model = path.join(reg, 'model', 'workspace.dsl');
  fs.writeFileSync(model, fs.readFileSync(model, 'utf8').replace('"ASP.NET Core"', '"ASP.NET Core 9"'));
  await expect(item.getByText('The design moved since this item was frozen', { exact: false })).toBeVisible({ timeout: 15000 });
  await expect(item.getByText('Quotes API changed since the design was frozen.')).toBeVisible();
  await expect(item.getByRole('button', { name: 'Freeze again' })).toBeVisible();
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'item_recheck').map(e => e.stale)).toEqual([false, true]);
});

test('the work digest names what needs a person and what failed', async () => {
  const { reg } = copyRegistry('e2e/fixtures/ready-registry');
  fs.mkdirSync(path.join(reg, 'work'));
  fs.writeFileSync(path.join(reg, 'work', 'W-api.yaml'),
    'id: W-api\ntitle: Quotes API\nrequirement: QT-1\nelements: [Quotes API]\ndone_when:\n  - gate: "true"\n');
  const ev = (ts, kind, o) => JSON.stringify({ schema_version: 1, event_id: `e${ts}`, ts, kind, by: 'pipeline', ...o });
  fs.mkdirSync(path.join(reg, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(reg, 'ledger', 'pipeline.jsonl'), [
    ev(2, 'item_awaiting_human', { item: 'W-api', reason: 'Review the schema change' }),
    ev(1, 'item_gate', { item: 'W-api', gate: 'true', outcome: 'fail', source: 'pipeline', commit: 'a'.repeat(40), dirty: false, exit_code: 1 }),
  ].join('\n') + '\n');
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await expect(page.getByText('Needs a decision (1)')).toBeVisible();
  await expect(page.getByText('W-api is waiting for a person: Review the schema change')).toBeVisible();
  await expect(page.getByText('Failed a gate (0)')).toBeVisible();
  await page.locator('[data-workitem="W-api"]').getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Needs a decision (0)')).toBeVisible();
  await expect(page.getByText('Failed a gate (1)')).toBeVisible();
  await expect(page.getByText('W-api: gate "true" failed at aaaaaaa')).toBeVisible();
});

test('a pipeline needs-decision in the gate is answered once, or marked resolved', async () => {
  const { reg } = copyRegistry('e2e/fixtures/ready-registry');
  fs.mkdirSync(path.join(reg, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(reg, 'ledger', 'pipeline.jsonl'), JSON.stringify({ schema_version: 1, event_id: 'nd1', ts: 1, kind: 'needs_decision',
    by: 'pipeline', id: 'ND-0001', question: 'Which retry policy?', status: 'open', element: 'Quotes/Quotes API' }) + '\n');
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Design' }).click();
  const sidebar = page.locator('#sbBody');
  await expect(sidebar.getByText('open needs-decision ND-0001: Which retry policy?')).toBeVisible();
  // Answering asks first, so a stray click or Cancel writes nothing.
  await sidebar.getByRole('button', { name: 'Answer with a decision' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(fs.existsSync(path.join(reg, 'decisions')) ? fs.readdirSync(path.join(reg, 'decisions')) : []).toEqual([]);
  // The draft binds the element by its name, not the pipeline's elements.json id.
  await sidebar.getByRole('button', { name: 'Answer with a decision' }).click();
  await page.locator('.askbox').getByRole('textbox').fill('Retry twice with jitter');
  await page.locator('.askbox').getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => fs.existsSync(path.join(reg, 'decisions')) ? fs.readdirSync(path.join(reg, 'decisions')) : []).toEqual(['retry-twice-with-jitter.yaml']);
  expect(fs.readFileSync(path.join(reg, 'decisions', 'retry-twice-with-jitter.yaml'), 'utf8')).toMatch(/^binds: \[Quotes API\]$/m);
  // A question that needs no decision is closed from the gate itself.
  await sidebar.getByRole('button', { name: 'Mark resolved' }).click();
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'needs_decision_resolved').map(e => e.id)).toEqual(['ND-0001']);
  await expect(sidebar.getByRole('button', { name: 'Mark resolved' })).toHaveCount(0);
});
