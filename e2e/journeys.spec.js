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
  // Work counts it on its icon and answers it in place, like the gate.
  await expect(page.locator('#badge-work')).toHaveText('1');
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  const digest = page.locator('#special');
  await expect(digest.getByText('Which retry policy?')).toBeVisible();
  await expect(digest.getByRole('button', { name: 'Answer with a decision' })).toBeVisible();
  await expect(digest.getByRole('button', { name: 'Mark resolved' })).toBeVisible();
  await page.getByRole('button', { name: 'Design' }).click();
  // Answering asks first, so a stray click or Cancel writes nothing.
  await sidebar.getByRole('button', { name: 'Answer with a decision' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(fs.existsSync(path.join(reg, 'decisions')) ? fs.readdirSync(path.join(reg, 'decisions')) : []).toEqual([]);
  // The draft binds the element by its name, not the pipeline's elements.json id.
  await sidebar.getByRole('button', { name: 'Answer with a decision' }).click();
  await page.locator('.askbox').getByRole('textbox').fill('Retry twice with jitter');
  await page.locator('.askbox').getByRole('button', { name: 'OK' }).click();
  // Then the command that proves it, so the decision can pass its check once bound; a description is asked again.
  await expect(page.locator('.askbox')).toContainText('What command proves it');
  await page.locator('.askbox').getByRole('textbox').fill('Model: retries are bounded');
  await page.locator('.askbox').getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.askbox')).toContainText('description, not a command');
  await page.locator('.askbox').getByRole('textbox').fill('python3 checks/retry.py');
  await page.locator('.askbox').getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => fs.existsSync(path.join(reg, 'decisions')) ? fs.readdirSync(path.join(reg, 'decisions')) : []).toEqual(['retry-twice-with-jitter.yaml']);
  const answered = fs.readFileSync(path.join(reg, 'decisions', 'retry-twice-with-jitter.yaml'), 'utf8');
  expect(answered).toMatch(/^binds: \[Quotes API\]$/m);
  expect(answered).toMatch(/^  - "python3 checks\/retry.py"$/m);
  // A question that needs no decision is closed from the gate itself.
  await sidebar.getByRole('button', { name: 'Mark resolved' }).click();
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'needs_decision_resolved').map(e => e.id)).toEqual(['ND-0001']);
  await expect(sidebar.getByRole('button', { name: 'Mark resolved' })).toHaveCount(0);
  await expect(page.locator('#badge-work')).toHaveText('');
});

test('user can study a topic and decide from it @critical', async () => {
  test.setTimeout(120000); // two launches, one of them with an ACP agent
  const { reg, dir } = copyRegistry('fixtures/study-project');
  const study = path.join(dir, 'study-registry');
  fs.cpSync(path.join(__dirname, '..', 'fixtures/study-registry'), study, { recursive: true });
  const cfgPath = path.join(study, 'designc.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.acpAgents.mock.args = [path.join(__dirname, '..', 'dev/mock-acp-agent.js')];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  // A study notebook has no model and no gate: it opens on the Study view.
  session = await launch(study, { ready: page => page.locator('#sbBody [title="New topic"]') });
  let { page } = session;
  await page.locator('#special').getByRole('heading', { name: 'How do mature compilers structure their passes?' }).waitFor();

  await page.locator('#sbBody [title="New topic"]').click();
  await page.locator('.askcard input').fill('What makes a good plugin API?');
  await page.locator('.askcard').getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => fs.existsSync(path.join(study, 'study/what-makes-a-good-plugin-api.yaml'))).toBe(true);

  // The Researcher appends a source and a finding, each only after the person approves its card.
  await page.locator('#sbBody [data-id="pass-managers"]').click();
  await page.getByRole('button', { name: 'Ask the Researcher' }).click();
  const topic = () => fs.readFileSync(path.join(study, 'study/pass-managers.yaml'), 'utf8');
  const approve = page.locator('#agent .agcard').getByRole('button', { name: 'Approve' });
  await approve.click();
  await expect.poll(topic).toContain('https://github.com/example/compiler/blob/0123abc/src/passes.rs');
  await approve.click();
  await expect.poll(topic).toContain('Passes declare what they preserve');
  expect(topic()).toContain('status: open');
  await session.app.close();

  // The project registry drafts a decision from the settled topic, read-only from the study registry.
  session = await launch(reg);
  page = session.page;
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.locator('[title="New decision from a study"]').click();
  await page.locator('.askcard').getByRole('button', { name: /^study: When is event sourcing/ }).click();
  await page.locator('.askcard input').fill('Keep plain rows with a history table');
  await page.locator('.askcard').getByRole('button', { name: 'OK' }).click();
  const dec = path.join(reg, 'decisions/keep-plain-rows-with-a-history-table.yaml');
  await expect.poll(() => fs.existsSync(dec)).toBe(true);
  const text = fs.readFileSync(dec, 'utf8');
  expect(text).toContain('status: minted');
  expect(text).toContain('informed_by: [{"registry":"study","topic":"event-sourcing"}]');
  expect(text).toContain('Worth it only where audit of every change is a requirement');
  expect(fs.readFileSync(path.join(study, 'study/event-sourcing.yaml'), 'utf8')).not.toContain('keep-plain-rows');
});

test('user can pin a domain pack and see it checked @critical', async () => {
  const { reg, dir } = copyRegistry('fixtures/domain-project');
  fs.cpSync(path.join(__dirname, '..', 'fixtures/domain-registry'), path.join(dir, 'domain-registry'), { recursive: true });
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  // Listed but not pinned: the gate says so and offers the pin; the owned aggregate is unknown until it is.
  const sidebar = page.locator('#sbBody');
  await expect(sidebar.getByText('pricing is listed in designc.json domains but not pinned')).toBeVisible();
  await sidebar.locator('.clause').getByRole('button', { name: 'Pin' }).first().click();
  // Pinning copies the pack as the registry has it and records who accepted it.
  await expect.poll(() => fs.existsSync(path.join(reg, 'domain/pricing.yaml'))).toBe(true);
  // The file exists before its content is fully written, so wait for the same equality rather than read once.
  await expect.poll(() => fs.readFileSync(path.join(reg, 'domain/pricing.yaml'), 'utf8')).toBe(fs.readFileSync(path.join(dir, 'domain-registry/domain/pricing.yaml'), 'utf8'));
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'domain_pinned').map(e => `${e.pack}:${e.registry}`)).toEqual(['pricing:pricing']);
  await expect(sidebar.locator('.clause', { hasText: 'but not pinned' })).toHaveCount(0);
  await expect(sidebar.getByText('pricing/Quote', { exact: true })).toBeVisible();
});

test('user can see legacy parity and what it holds a work item to @critical', async () => {
  const { reg } = copyRegistry('fixtures/parity-registry');
  // Shots are not in git, so make the scratch copy's deterministic: the new app's shot is here, the legacy one is not.
  const shots = path.join(reg, 'parity/shots');
  for (const f of fs.readdirSync(shots)) if (f.endsWith('.png')) fs.rmSync(path.join(shots, f));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(shots, '3dc21ad15244b718a33419c6912edcffbfa06980a6085abd1104c52d01a0956a.png'), png);
  session = await launch(reg);
  const { page } = session;
  // The work item names parity as done_when, and its card says what each scenario last gave.
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  const special = page.locator('#special');
  await expect(special.getByText('tags-apply pass at 1111111 · tags-list fail at 1111111')).toBeVisible();
  await special.getByRole('button', { name: 'Show parity' }).first().click();
  // The Parity view: the failing scenario, its finding, and the two shots side by side for looking only.
  await page.locator('#sbBody').getByText('tags-list', { exact: true }).click();
  await expect(special.getByRole('heading', { name: /^tags-list/ })).toBeVisible();
  await expect(special.getByRole('cell', { name: /^step 1: column "Inception" is date:dddd-0d-dd/ })).toBeVisible();
  await expect(special.getByRole('listitem').filter({ hasText: 'legacy shows date:dd/0d/dddd' })).toContainText('fail');
  await expect(special.getByRole('img', { name: 'New app screenshot' })).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(special.getByText('Not on this machine (shots are not in git).')).toBeVisible();
});
