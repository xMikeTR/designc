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
  await expect(page.locator('#monaco').getByText('"RE Fares Engine"')).toBeVisible();
  await sidebar.getByText('DEMO-1234.yaml', { exact: true }).click();
  await expect(page.locator('#tabs').getByText('DEMO-1234.yaml')).toBeVisible();
  await expect(page.locator('#monaco').getByText('DEMO-1234').first()).toBeVisible();
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
  expect(dsl).toMatch(/container "Fares\.Api"/);
  expect(readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'extraction')).toHaveLength(1);
  // The map is drawn: an SVG box labelled with the extracted container.
  await expect(page.locator('#special svg text', { hasText: 'Fares.Api' }).first()).toBeVisible();
});

test('user can extract one code map from an API repo and a UI repo @critical', async () => {
  // Two separate repos (each its own git tree in real life) named under repos in designc.json; no `codebase` at all.
  const { reg } = copyRegistry('fixtures/split-registry', { siblings: ['fixtures/fullstack/api', 'fixtures/fullstack/ui'] });
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Code map' }).click();
  await expect(page.locator('#sbBody').locator('[data-repo-row]')).toHaveText([/^Api/, /^Ui/]);
  await page.locator('#sbBody').getByRole('button', { name: 'Extract the as-built map' }).click();
  await expect(page.getByText(/^Mapped \d+ deployables?/)).toBeVisible();
  const facts = JSON.parse(fs.readFileSync(path.join(reg, 'asbuilt/facts.json'), 'utf8'));
  expect(facts.repos).toEqual(['Api', 'Ui']);
  // The UI's calls link to the API repo's routes: one edge across the two repos.
  expect(facts.edges.some(e => e.from === 'ui' && e.to === 'Shop.Api' && e.kind === 'sync')).toBe(true);
  expect(facts.edges.find(e => e.from === 'ui' && e.to === 'Shop.Api').evidence.every(v => v.file.startsWith('Ui/'))).toBe(true);
  await expect(page.locator('#special svg text', { hasText: 'Shop.Api' }).first()).toBeVisible();
  // Files open read-only through the repo prefix, from the right repo; a path that leaves its repo is refused.
  const api = await page.evaluate(() => host.readCode(undefined, 'Api/src/Shop.Api/Program.cs'));
  expect(api).toMatch(/WebApplication|builder/);
  const ui = await page.evaluate(() => host.readCode(undefined, 'Ui/package.json'));
  expect(JSON.parse(ui).name).toBe('ui');
  const escape = await page.evaluate(() => host.readCode(undefined, 'Api/../ui/package.json').then(() => 'read', e => String(e.message)));
  expect(escape).toMatch(/outside the codebase/);
  const hits = await page.evaluate(() => host.searchCode(undefined, 'VITE_API', 20));
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every(h => /^(Api|Ui)\//.test(h.file))).toBe(true);
});

test('user can add a second repo from the code map @critical', async () => {
  const { dir, reg } = copyRegistry('sample-registry', { codebase: true });
  const ui = path.join(dir, 'ui'); fs.mkdirSync(ui);
  session = await launch(reg);
  const { app, page } = session;
  // The folder picker is a native dialog: answer it with the folder, as a person would.
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ui);
  await page.getByRole('button', { name: 'Code map' }).click();
  const side = page.locator('#sbBody');
  await side.getByRole('button', { name: 'Add a second repo' }).click();
  // Name the new repo, then the existing codebase, which becomes a repo too.
  await page.locator('.askcard input').fill('Ui');
  await page.locator('.askcard').getByRole('button', { name: 'OK' }).click();
  await page.locator('.askcard input').fill('Api');
  await page.locator('.askcard').getByRole('button', { name: 'OK' }).click();
  await expect(side.locator('[data-repo-row]')).toHaveCount(2);
  const cfg = () => JSON.parse(fs.readFileSync(path.join(reg, 'designc.json'), 'utf8'));
  expect(cfg().repos).toEqual({ Api: '../designc-sample-codebase', Ui: '../ui' });
  expect(cfg().codebase).toBeUndefined();
  // Remove drops one repo from designc.json and the list.
  await side.getByRole('button', { name: 'Remove repo Ui' }).click();
  await expect(side.locator('[data-repo-row]')).toHaveCount(1);
  expect(cfg().repos).toEqual({ Api: '../designc-sample-codebase' });
});

test('user can see the UI graph of a screen @critical', async () => {
  const { reg } = copyRegistry('fixtures/ui-registry', { codebase: 'fixtures/ui-app', siblings: ['fixtures/ui-legacy'] });
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Code map' }).click();
  await page.locator('#sbBody').getByRole('button', { name: 'Extract the as-built map' }).click();
  await expect(page.getByText(/^Mapped \d+ deployables?/)).toBeVisible();
  const facts = JSON.parse(fs.readFileSync(path.join(reg, 'asbuilt/facts.json'), 'utf8'));
  expect(facts.ui.screens.map(s => s.name)).toEqual(['tags']);
  // The UI level lists the screen's controls by component: role, name, the element and when it is on screen.
  const special = page.locator('#special');
  await special.getByRole('button', { name: 'UI', exact: true }).click();
  const table = special.getByRole('table', { name: 'Controls on tags' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: 'Search tags' }).first()).toContainText('searchbox');
  // A control inside a followed component, named at the usage, and one from a library whose role is not in source.
  await expect(table.getByRole('row').filter({ hasText: 'via Field' }).first()).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: 'ui-lib' }).first()).toBeVisible();
  // Conditions are source text, never evaluated.
  await expect(table.getByRole('row').filter({ hasText: 'New tag' })).toContainText('canEdit');
  // A registered field carries the rules of the one schema naming it, then its register rules.
  await expect(table.getByRole('row').filter({ hasText: 'TagForm.tsx:17' })).toContainText('min 1, max 40, required');
  // A references repo is read only when the person extracts it; a tag in ui.roles takes its role from there.
  await special.getByRole('combobox', { name: 'Repo' }).selectOption('legacy');
  await special.getByRole('button', { name: 'Extract legacy' }).click();
  await expect(page.getByText(/^Read 1 screen and 2 controls from legacy/)).toBeVisible();
  expect(fs.existsSync(path.join(reg, 'asbuilt/ui-legacy.json'))).toBe(true);
  await expect(table.getByRole('row').filter({ hasText: 'Add tag' })).toContainText('mapped');
  // The Parity view joins both graphs to the recording: a control the source cannot give a role takes the recorded one by name.
  await page.getByRole('button', { name: 'Parity', exact: true }).click();
  await page.locator('#sbBody').getByText('tags-search', { exact: true }).click();
  await expect(special.getByRole('heading', { name: 'From code' })).toBeVisible();
  await expect(special.getByRole('row').filter({ hasText: 'Reset' })).toContainText('role from recording');
  await expect(special.getByRole('row').filter({ hasText: 'Add tag' })).toContainText('recorded');
});

test('user can remove a requirement and a bound decision made by mistake', async () => {
  const { reg } = copyRegistry('sample-registry');
  fs.writeFileSync(path.join(reg, 'requirements/FAKE-1.yaml'), 'id: FAKE-1\ntitle: Made by mistake\nversion: 1\nelements: []\n');
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Design' }).click();
  const sidebar = page.locator('#sbBody');
  await sidebar.locator('.item', { hasText: 'FAKE-1' }).getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => fs.existsSync(path.join(reg, 'requirements/FAKE-1.yaml'))).toBe(false);
  await sidebar.getByRole('button', { name: 'Bind', exact: true }).first().click();
  await sidebar.getByRole('button', { name: 'Supersede', exact: true }).first().click();
  await expect.poll(() => fs.readFileSync(path.join(reg, 'decisions/D-0001.yaml'), 'utf8')).toMatch(/^status: superseded/m);
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
  fs.writeFileSync(path.join(reg, 'work/W-booking.yaml'), [
    'id: W-booking', 'title: Booking endpoint', 'requirement: QT-1', 'elements: [Bookings API]', 'repo: ../repo',
    'writes: ["src/**"]', 'done_when:', '  - gate: "true"', '',
  ].join('\n'));

  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  const item = page.locator('[data-workitem="W-booking"]');
  await expect(item.getByText('backlog', { exact: true })).toBeVisible();

  await item.getByRole('button', { name: 'Start' }).click();
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'item_pulled').map(e => e.item)).toEqual(['W-booking']);

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
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'item_done').map(e => [e.item, e.commit])).toEqual([['W-booking', commit]]);
});

test('a frozen work item says when the design moved under it', async () => {
  const { reg } = copyRegistry('e2e/fixtures/ready-registry');
  fs.mkdirSync(path.join(reg, 'work'));
  fs.writeFileSync(path.join(reg, 'work', 'W-api.yaml'),
    'id: W-api\ntitle: Bookings API\nrequirement: QT-1\nelements: [Bookings API]\ndone_when:\n  - gate: "true"\n');
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
  await expect(item.getByText('Bookings API changed since the design was frozen.')).toBeVisible();
  await expect(item.getByRole('button', { name: 'Freeze again' })).toBeVisible();
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'item_recheck').map(e => e.stale)).toEqual([false, true]);
});

test('the work digest names what needs a person and what failed', async () => {
  const { reg } = copyRegistry('e2e/fixtures/ready-registry');
  fs.mkdirSync(path.join(reg, 'work'));
  fs.writeFileSync(path.join(reg, 'work', 'W-api.yaml'),
    'id: W-api\ntitle: Bookings API\nrequirement: QT-1\nelements: [Bookings API]\ndone_when:\n  - gate: "true"\n');
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
    by: 'pipeline', id: 'ND-0001', question: 'Which retry policy?', status: 'open', element: 'Bookings/Bookings API' }) + '\n');
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
  expect(answered).toMatch(/^binds: \[Bookings API\]$/m);
  expect(answered).toMatch(/^  - "python3 checks\/retry.py"$/m);
  // Answering with a decision closes the question, so the gate no longer offers it.
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'needs_decision_resolved').map(e => e.id)).toEqual(['ND-0001']);
  await expect(sidebar.getByRole('button', { name: 'Mark resolved' })).toHaveCount(0);
  // A question that needs no decision is closed from the gate itself.
  fs.appendFileSync(path.join(reg, 'ledger', 'pipeline.jsonl'), JSON.stringify({ schema_version: 1, event_id: 'nd2', ts: 2, kind: 'needs_decision',
    by: 'pipeline', id: 'ND-0002', question: 'Which log level?', status: 'open' }) + '\n');
  await expect(sidebar.getByText('open needs-decision ND-0002: Which log level?', { exact: true })).toBeVisible();
  await sidebar.getByRole('button', { name: 'Mark resolved' }).click();
  await page.locator('.askbox').getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'needs_decision_resolved').map(e => e.id)).toEqual(['ND-0001', 'ND-0002']);
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
  await expect(sidebar.getByText('fares is listed in designc.json domains but not pinned')).toBeVisible();
  await sidebar.locator('.clause').getByRole('button', { name: 'Pin' }).first().click();
  // Pinning copies the pack as the registry has it and records who accepted it.
  await expect.poll(() => fs.existsSync(path.join(reg, 'domain/fares.yaml'))).toBe(true);
  // The file exists before its content is fully written, so wait for the same equality rather than read once.
  await expect.poll(() => fs.readFileSync(path.join(reg, 'domain/fares.yaml'), 'utf8')).toBe(fs.readFileSync(path.join(dir, 'domain-registry/domain/fares.yaml'), 'utf8'));
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'domain_pinned').map(e => `${e.pack}:${e.registry}`)).toEqual(['fares:fares']);
  await expect(sidebar.locator('.clause', { hasText: 'but not pinned' })).toHaveCount(0);
  await expect(sidebar.getByText('fares/Booking', { exact: true })).toBeVisible();
});

test('user can pin a UI pack and see a screen spec checked against it @critical', async () => {
  const { reg, dir } = copyRegistry('fixtures/ui-project');
  fs.cpSync(path.join(__dirname, '..', 'fixtures/ui-pack-registry'), path.join(dir, 'ui-pack-registry'), { recursive: true });
  fs.rmSync(path.join(reg, 'ui/pack'), { recursive: true });
  const cfgFile = path.join(reg, 'designc.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), codebase: '../app' }, null, 2));
  // D2: a criterion on the screen's component asks for a state the spec does not have (forbidden).
  const dsl = path.join(reg, 'model/workspace.dsl');
  fs.writeFileSync(dsl, fs.readFileSync(dsl, 'utf8').replace('app = softwareSystem "Bordereaux app"', 'app = softwareSystem "Bordereaux app" {\n      list = container "BordereauxList" "" "" "UI"\n    }'));
  fs.mkdirSync(path.join(reg, 'acceptance'), { recursive: true });
  fs.writeFileSync(path.join(reg, 'acceptance/AC-1.yaml'), 'id: AC-1\nrequirement: R-1\nelement: BordereauxList\nstates: [ready, forbidden]\ncases:\n  - { state: ready, given: g, then: t }\n  - { state: forbidden, given: g, then: t }\n');
  session = await launch(reg);
  const { page } = session;
  const asked = [];
  page.on('dialog', d => asked.push(d.message()));
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  // A spec with no pack: the gate says so and offers the pin.
  const sidebar = page.locator('#sbBody');
  await expect(sidebar.getByText('ui/specs/bordereaux.json /template: No UI pack is pinned')).toBeVisible();
  await sidebar.locator('.clause').getByRole('button', { name: 'Pin' }).first().click();
  // Pinning shows what is copied, writes ui/pack/ as the registry has it, and records who accepted it.
  await expect.poll(() => asked.some(m => /Pin the UI pack from acme-ui\?.*Added: .*components\/Button\.json/s.test(m))).toBe(true);
  const src = path.join(dir, 'ui-pack-registry/ui/components/Button.json');
  await expect.poll(() => fs.existsSync(path.join(reg, 'ui/pack/components/Button.json')) && fs.readFileSync(path.join(reg, 'ui/pack/components/Button.json'), 'utf8')).toBe(fs.readFileSync(src, 'utf8'));
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'ui_pinned').map(e => `${e.pack}:${e.registry}`)).toEqual(['acme-ui:acme-ui']);
  await expect(sidebar.locator('.clause', { hasText: 'UI pack' })).toHaveCount(0);
  // The bordereaux spec passes with its holdout; the section lists it.
  await expect(sidebar.getByText('bordereaux', { exact: true })).toBeVisible();
  await expect(sidebar.getByText('holdout', { exact: true })).toBeVisible();
  // The state rule shows in the gate panel: forbidden is not a state of the bordereaux spec.
  await expect(sidebar.getByText("acceptance/AC-1/states/1: State 'forbidden' is not in spec bordereaux")).toBeVisible();

  // D3, check 4: the criterion is fixed, the Factory renders (a fixture row and files stand in for it), a person approves and binds.
  const sha = b => require('crypto').createHash('sha256').update(b).digest('hex');
  fs.writeFileSync(path.join(reg, 'acceptance/AC-1.yaml'), 'id: AC-1\nrequirement: R-1\nelement: BordereauxList\nstates: [ready, loading, empty, error]\ncases:\n' + ['ready', 'loading', 'empty', 'error'].map(st => `  - { state: ${st}, given: g, then: t }`).join('\n') + '\n');
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const pv = path.join(reg, 'ui/previews/bordereaux');
  fs.mkdirSync(path.join(pv, 'placements'), { recursive: true });
  const states = ['ready', 'loading', 'empty', 'error', 'filtered'], hashes = {};
  for (const st of states) { const f = `${st}-chromium-linux.png`; fs.writeFileSync(path.join(pv, f), Buffer.concat([PNG, Buffer.from(st)])); hashes[f] = sha(fs.readFileSync(path.join(pv, f))); }
  fs.writeFileSync(path.join(pv, 'placements/ready__header-chromium-linux.png'), PNG); hashes['placements/ready__header-chromium-linux.png'] = sha(PNG);
  const specFile = path.join(reg, 'ui/specs/bordereaux.json');
  const row = (kind, ts, extra) => JSON.stringify({ schema_version: 1, event_id: `e2e-${kind}-${ts}`, ts, by: 'factory', kind, ...extra }) + '\n';
  const rendered = ts => row('ui_preview_rendered', ts, { screen: 'bordereaux', spec_hash: sha(fs.readFileSync(specFile)), files: hashes, image: 'ready-chromium-linux.png' });
  fs.appendFileSync(path.join(reg, 'ledger/designc.jsonl'), rendered(Date.now() - 60000));
  await expect(sidebar.getByText('ui/specs/bordereaux.json: spec not bound. Check the previews, then press Approve and bind')).toBeVisible();
  await expect(sidebar.getByRole('img', { name: /Preview of bordereaux: ready/ })).toBeVisible();
  // Render previews types the command and stops: nothing runs.
  await sidebar.getByRole('button', { name: 'Render previews' }).click();
  await expect(page.locator('#termBody')).toContainText('preview --registry');
  await expect(page.locator('#termBody')).toContainText('--screen');
  await expect(page.locator('#termBody')).toContainText('--repo');
  // D5: a UI-scoped work item. Before approval its handover is refused, and nothing is written.
  fs.mkdirSync(path.join(reg, 'work'), { recursive: true }); fs.mkdirSync(path.join(reg, 'requirements'), { recursive: true });
  fs.writeFileSync(path.join(reg, 'requirements/R-1.yaml'), 'id: R-1\ntitle: See received bordereaux\nsource: ""\nversion: 1\nelements: [BordereauxList]\n');
  fs.writeFileSync(path.join(reg, 'work/W-ui.yaml'), 'id: W-ui\ntitle: Bordereaux screen\nrequirement: R-1\nelements: [BordereauxList]\ndone_when:\n  - gate: "true"\n');
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  const wi = page.locator('[data-workitem="W-ui"]');
  await expect(wi).toBeVisible();
  await expect(wi.getByRole('button', { name: 'Freeze item' })).toBeDisabled();
  expect(fs.existsSync(path.join(reg, 'handovers'))).toBe(false);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await sidebar.getByRole('button', { name: 'Approve and bind' }).click();
  await expect.poll(() => JSON.parse(fs.readFileSync(specFile, 'utf8')).status).toBe('bound');
  await expect.poll(() => readLedger(reg, 'designc.jsonl').filter(e => e.kind === 'ui_spec_bound' || e.kind === 'ui_preview_approved').map(e => e.kind)).toEqual(['ui_spec_bound', 'ui_preview_approved']);
  const approved = readLedger(reg, 'designc.jsonl').find(e => e.kind === 'ui_preview_approved');
  expect(approved.spec).toBe(sha(fs.readFileSync(specFile)));
  expect(approved.files).toEqual(hashes);
  await expect(sidebar.getByText(/^ui\/specs\/bordereaux\.json: spec not bound/)).toHaveCount(0);
  await expect(sidebar.getByText(/^ui\/specs\/bordereaux\.json: (previews not approved|approval is stale)/)).toHaveCount(0);
  // D5, closing D3's freeze step: with the approval valid the item freezes, and the handover carries ui.json and the approved pictures.
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await expect(wi.getByText('Gate for this item: ready.', { exact: false })).toBeVisible();
  await wi.getByRole('button', { name: 'Freeze item' }).click();
  await expect.poll(() => fs.existsSync(path.join(reg, 'handovers')) && fs.readdirSync(path.join(reg, 'handovers')).length).toBe(1);
  const hid = fs.readdirSync(path.join(reg, 'handovers'))[0], hdir = path.join(reg, 'handovers', hid);
  const uij = JSON.parse(fs.readFileSync(path.join(hdir, 'ui.json'), 'utf8'));
  expect(uij.schema).toBe('designc.handover.ui/1');
  expect(uij.screens.map(x => x.screen)).toEqual(['bordereaux']);
  expect(uij.screens[0].previews.files).toEqual(hashes);
  for (const [rel, h] of Object.entries(hashes)) expect(sha(fs.readFileSync(path.join(hdir, 'ui/previews/bordereaux', rel)))).toBe(h);
  expect(fs.existsSync(path.join(hdir, 'ui/specs/bordereaux.json'))).toBe(true);
  expect(fs.existsSync(path.join(hdir, 'ui/holdout'))).toBe(false);
  const holdText = fs.readFileSync(path.join(reg, 'ui/holdout/bordereaux.json'), 'utf8');
  expect(uij.screens[0].holdout.sha256).toBe(require('../renderer/ui.js').sha256(holdText));
  const leak = JSON.parse(holdText).bordereaux[0].Cedant;
  for (const f of fs.readdirSync(hdir, { recursive: true })) { const full = path.join(hdir, f); if (fs.statSync(full).isFile() && !f.endsWith('.png')) expect(fs.readFileSync(full, 'utf8')).not.toContain(leak); }
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  // A new render, even of the same bytes, takes the approval away; the button now says Approve previews.
  fs.appendFileSync(path.join(reg, 'ledger/designc.jsonl'), rendered(Date.now() + 60000));
  await expect(sidebar.getByText(/^ui\/specs\/bordereaux\.json: approval is stale: rendered again since/)).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Approve previews' })).toBeVisible();
});

test('the Compose stage mints a spec behind a card, and a spec that fails its checks is refused @critical', async () => {
  test.setTimeout(90000);
  const { reg } = copyRegistry('fixtures/ui-project');
  const cfgFile = path.join(reg, 'designc.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), codebase: '../app', acpAgents: { mock: { label: 'Mock agent', command: 'node', args: [path.join(__dirname, '..', 'dev/mock-acp-agent.js')], env: { MOCK_SCRIPT: 'compose' } } } }, null, 2));
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.locator('[data-agenttoggle]').first().click();
  await page.locator('#agAgent').selectOption('mock');
  await page.locator('#agRole').selectOption('compose');
  await page.locator('#agInput').fill('Compose the orders screen');
  await page.locator('#agSend').click();
  // The spec that fails its checks is refused with its clauses: no card, nothing written.
  await expect(page.locator('#agent')).toContainText('fails its checks');
  await expect(page.locator('#agent')).toContainText("Unknown template 'no-such-template'");
  // The good one shows the placements as a table, and writes nothing until Approve.
  const card = page.locator('#agent .agcard');
  await expect(card.locator('table.uispec th')).toHaveText(['Slot', 'Component', 'Data', 'Why']);
  expect(fs.existsSync(path.join(reg, 'ui/specs/orders.json'))).toBe(false);
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => fs.existsSync(path.join(reg, 'ui/specs/orders.json')) && JSON.parse(fs.readFileSync(path.join(reg, 'ui/specs/orders.json'), 'utf8')).status).toBe('minted');
});

test('user can mint a structured test scenario and see it blocked from binding by its open questions @critical', async () => {
  test.setTimeout(90000);
  const yaml = require('js-yaml');
  const { reg } = copyRegistry('fixtures/scenario-registry');
  const cfgFile = path.join(reg, 'designc.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), codebase: '../app', acpAgents: { mock: { label: 'Mock agent', command: 'node', args: [path.join(__dirname, '..', 'dev/mock-acp-agent.js')], env: { MOCK_SCRIPT: 'scenarios' } } } }, null, 2));
  session = await launch(reg);
  const { app, page } = session;
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  // The strict mint reads the requirement page, so the person chooses the folder of pages first (a native dialog; answer it, then leave the import review).
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, path.join(reg, 'import'));
  await page.locator('[data-a="importreq"]').click();
  await page.locator('.askcard').getByRole('button', { name: 'Cancel' }).click();
  await page.locator('[data-agenttoggle]').first().click();
  await page.locator('#agAgent').selectOption('mock');
  await page.locator('#agRole').selectOption('grill');
  await page.locator('#agInput').fill('Draft test scenarios for ORD-1');
  await page.locator('#agSend').click();
  // A quote the page does not contain is refused with its reason: no card, nothing written.
  await expect(page.locator('#agent')).toContainText('source_not_in_page');
  const file = path.join(reg, 'test-scenarios/ORD-1-ts-01.yaml');
  expect(fs.existsSync(file)).toBe(false);
  // The valid one shows its open question on the card and writes nothing until Approve.
  const card = page.locator('#agent .agcard');
  await expect(card).toContainText('1 open question');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => fs.existsSync(file)).toBe(true);
  const rec = yaml.load(fs.readFileSync(file, 'utf8'));
  expect([rec.status, rec.by, rec.source, rec.effect.operation]).toEqual(['minted', 'grill', 'The tag is applied to all orders matching the string entered.', 'tagOrders']);
  // Minted, not bound: the Bind button is disabled and the question is listed.
  const row = page.locator('#sbBody .tsbind');
  await expect(row).toContainText('minted');
  await expect(row).toContainText('blocked: 1 open question');
  await expect(row).toContainText('Is the match a prefix, or anywhere in the reference?');
  await expect(row.getByRole('button', { name: 'Bind' })).toBeDisabled();
  // Answering the question (editing the file) unblocks it; only the person's Bind button binds, and it rewrites the one status line.
  delete rec.questions;
  fs.writeFileSync(file, yaml.dump(rec, { lineWidth: -1 }));
  await expect(row.getByRole('button', { name: 'Bind' })).toBeEnabled();
  await row.getByRole('button', { name: 'Bind' }).click();
  await expect.poll(() => yaml.load(fs.readFileSync(file, 'utf8')).status).toBe('bound');
  await expect(row).toContainText('bound');
});

test('a legacy spec is drafted by the agent and copied as a new spec by the person @critical', async () => {
  test.setTimeout(90000);
  const { reg } = copyRegistry('fixtures/ui-project');
  const cfgFile = path.join(reg, 'designc.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), codebase: '../app', acpAgents: { mock: { label: 'Mock agent', command: 'node', args: [path.join(__dirname, '..', 'dev/mock-acp-agent.js')], env: { MOCK_SCRIPT: 'legacy' } } } }, null, 2));
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.locator('[data-agenttoggle]').first().click();
  await page.locator('#agAgent').selectOption('mock');
  await page.locator('#agRole').selectOption('compose');
  await page.locator('#agInput').fill('Draft the legacy invoices screen');
  await page.locator('#agSend').click();
  const card = page.locator('#agent .agcard');
  await expect(card).toContainText('Draft legacy spec invoices');
  expect(fs.existsSync(path.join(reg, 'ui/legacy/invoices.json'))).toBe(false);
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => fs.existsSync(path.join(reg, 'ui/legacy/invoices.json'))).toBe(true);
  // No agent tool writes ui/specs: only the person's button does, byte for byte, and it never overwrites.
  expect(fs.existsSync(path.join(reg, 'ui/specs/invoices.json'))).toBe(false);
  const led = () => { try { return fs.readFileSync(path.join(reg, 'ledger/designc.jsonl'), 'utf8'); } catch { return ''; } }, ledgerBefore = led();
  const row = page.locator('#sbBody .item').filter({ hasText: 'invoices' });
  await row.getByRole('button', { name: 'Copy as new spec' }).click();
  await expect.poll(() => fs.existsSync(path.join(reg, 'ui/specs/invoices.json'))).toBe(true);
  expect(fs.readFileSync(path.join(reg, 'ui/specs/invoices.json'), 'utf8')).toBe(fs.readFileSync(path.join(reg, 'ui/legacy/invoices.json'), 'utf8'));
  expect(led()).toBe(ledgerBefore);
  await expect(page.locator('#sbBody .uidiff')).toContainText('nothing');
  await expect(page.locator('#sbBody .item').filter({ hasText: 'invoices' }).getByRole('button', { name: 'Copy as new spec' })).toBeDisabled();
});

test('user can see legacy parity and what it holds a work item to @critical', async () => {
  const { reg } = copyRegistry('fixtures/parity-registry');
  // Shots are not in git, so make the scratch copy's deterministic: the new app's shot is here, the legacy one is not.
  const shots = path.join(reg, 'parity/shots');
  fs.mkdirSync(shots, { recursive: true });
  for (const f of fs.readdirSync(shots)) if (f.endsWith('.png')) fs.rmSync(path.join(shots, f));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(shots, '3dc21ad15244b718a33419c6912edcffbfa06980a6085abd1104c52d01a0956a.png'), png);
  session = await launch(reg);
  const { page } = session;
  // The requirement says where it is on the way to proven parity, and the one next step (display only).
  await page.getByRole('button', { name: 'Design' }).click();
  await expect(page.locator('#sbBody').getByText('Next: Automate 1 of 2 test scenarios in a parity scenario')).toBeVisible();
  // The work item names parity as done_when, and its card says what each scenario last gave.
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  const special = page.locator('#special');
  await expect(special.getByText('tags-apply pass at 1111111 · tags-list fail at 1111111')).toBeVisible();
  await special.getByRole('button', { name: 'Show parity' }).first().click();
  // The Parity view: the failing scenario, its finding, and the two shots side by side for looking only.
  await page.locator('#sbBody').getByText('tags-list', { exact: true }).click();
  await expect(special.getByRole('heading', { name: /^tags-list/ })).toBeVisible();
  // It names the test scenario it proves, from the requirement's page (display only).
  await expect(special.getByText('Proves: QT-1-ts-01 Tags are listed (requirement QT-1)')).toBeVisible();
  await expect(special.getByRole('cell', { name: /^step 1: column "Inception" is date:dddd-0d-dd/ })).toBeVisible();
  await expect(special.getByRole('listitem').filter({ hasText: 'legacy shows date:dd/0d/dddd' })).toContainText('fail');
  await expect(special.getByRole('img', { name: 'New app screenshot' })).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(special.getByText('Not on this machine (shots are not in git).')).toBeVisible();
  // QA bugs on the scenario's screen, matched against the recordings: how many were caught, and why the rest were not.
  await expect(special.getByRole('heading', { name: /^QA bugs/ })).toBeVisible();
  await expect(special.getByText('Caught 1', { exact: true })).toBeVisible();
  await expect(special.getByRole('row').filter({ hasText: 'TAG-5' })).toContainText('Captured but not flagged');
  // Compare types the recorder's line into the Terminal and stops: no report is rewritten until the person presses Enter.
  const report = path.join(reg, 'parity/reports/tags-list.json');
  const before = fs.readFileSync(report, 'utf8');
  await special.getByRole('button', { name: 'Compare new app', exact: true }).click();
  await expect(page.locator('#termBody')).toContainText('parity-record.js');
  await expect(page.locator('#termBody')).toContainText('tags-list');
  expect(fs.readFileSync(report, 'utf8')).toBe(before);
});

test('user can record the QA bugs as escapes, once', async () => {
  const { reg } = copyRegistry('fixtures/system3-registry');
  session = await launch(reg);
  const { page } = session;
  const lines = () => fs.readFileSync(path.join(reg, 'ledger/designc.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const before = lines().length;
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.locator('#special').getByRole('button', { name: 'Show parity' }).first().click();
  const special = page.locator('#special');
  await expect(special.getByRole('heading', { name: /^QA bugs/ })).toBeVisible();
  await special.getByRole('button', { name: 'Record QA escapes' }).click();
  await expect.poll(() => lines().length).toBe(before + 5);
  await expect(page.locator('#toasts .toast').filter({ hasText: 'Recorded 5 QA escapes' })).toBeVisible();
  const mine = lines().filter(e => String(e.id).startsWith('qa-bordereaux-'));
  expect(mine.map(e => e.id).sort()).toEqual(['qa-bordereaux-BDX-1', 'qa-bordereaux-BDX-2', 'qa-bordereaux-BDX-3', 'qa-bordereaux-BDX-4', 'qa-bordereaux-BDX-5']);
  expect(mine.find(e => e.id === 'qa-bordereaux-BDX-1')).toMatchObject({ kind: 'escape', screen: 'bordereaux', bucket: 'caught', caught_by: 'parity' });
  expect(JSON.stringify(mine)).not.toContain('Inception dates show year first');
  // The bug with no where and kind needs triage: it is not recorded. A second press adds nothing.
  await special.getByRole('button', { name: 'Record QA escapes' }).click();
  await expect(page.locator('#toasts .toast').filter({ hasText: '5 already recorded' })).toBeVisible();
  expect(lines().length).toBe(before + 5);
});

test('Improve shows time to signal, escape rate and review veto and recovery per screen', async () => {
  const { reg } = copyRegistry('fixtures/system3-registry');
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Improve', exact: true }).click();
  const s3 = page.locator('[data-system3]');
  await expect(s3).toBeVisible();
  await s3.getByLabel('Screen').selectOption('bordereaux');
  const row = s3.locator('tr[data-s3stage="ui-visual"]');
  await expect(row).toContainText('10 s (n=1)');
  await expect(row).toContainText('67% (2 of 3)');
  await expect(s3.locator('[data-s3="review-veto"]')).toContainText('1 of 1 (100%)');
  await expect(s3.locator('[data-s3="review-recovery"]')).toContainText('1 of 1 (100%)');
  await s3.getByLabel('Screen').selectOption('summary');
  await expect(s3.locator('[data-s3="review-veto"]')).not.toContainText('1 of 1');
});

test('user can accept or dismiss a swept Jira issue @critical', async () => {
  const { reg } = copyRegistry('e2e/fixtures/ready-registry');
  fs.mkdirSync(path.join(reg, 'inbox'));
  for (const [k, t] of [['ZZ-1', 'Accept me'], ['ZZ-2', 'Dismiss me']]) {
    fs.writeFileSync(path.join(reg, 'inbox', `${k}.yaml`), `id: ${k}\ntitle: ${JSON.stringify(t)}\njira: {"type": "Story", "labels": ["lbl-a"], "components": []}\ntarget: { jira: ${k} }\nswept: 2026-11-05\n`);
  }
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  const inbox = page.locator('[data-inbox]');
  await expect(inbox.getByText('Accept me')).toBeVisible();

  // Dismiss moves the entry out of the way, never deletes it.
  await inbox.locator('li', { hasText: 'Dismiss me' }).getByRole('button', { name: 'Dismiss' }).click();
  await expect(inbox.getByText('Dismiss me')).toHaveCount(0);
  expect(fs.existsSync(path.join(reg, 'inbox/dismissed/ZZ-2.yaml'))).toBe(true);
  expect(fs.existsSync(path.join(reg, 'inbox/ZZ-2.yaml'))).toBe(false);

  // Accept goes through New item: the person confirms the title, and the item targets the Jira issue.
  await inbox.locator('li', { hasText: 'Accept me' }).getByRole('button', { name: 'Accept' }).click();
  await page.locator('.askcard input').fill('Accept me');
  await page.locator('.askcard').getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => fs.readdirSync(path.join(reg, 'work')).filter(f => f.endsWith('.yaml')).length).toBe(1);
  const file = fs.readdirSync(path.join(reg, 'work')).find(f => f.endsWith('.yaml'));
  expect(fs.readFileSync(path.join(reg, 'work', file), 'utf8')).toMatch(/^target: \{ jira: "ZZ-1" \}$/m);
  // Back on the Work tab, the accepted issue is gone from the inbox and the new item is in the backlog.
  await page.getByRole('tab', { name: /^WK Work/ }).click();
  await expect(page.locator('[data-workitem]')).toHaveCount(1);
  await expect(page.locator('[data-inbox]')).toHaveCount(0);
});

test('a gate clause on a check offers the next step, and the TODO is replaced once the card is approved', async () => {
  const { reg } = copyRegistry('sample-registry');
  const dec = (id, checks) => `id: ${id}\nstatus: bound\neffect: fix\nrequirement: DEMO-1234\nbinds: [Bookings DB]\nresolves: [DC009]\nstatement: "${id} statement"\n${checks}\n`;
  fs.writeFileSync(path.join(reg, 'decisions/D-0003.yaml'), dec('D-0003', 'checks:\n  - "TODO ./checks/occ.sh: writers use rowversion"'));
  fs.writeFileSync(path.join(reg, 'decisions/D-0002.yaml'), dec('D-0002', 'checks: []'));
  session = await launch(reg);
  const { page } = session;
  await page.getByRole('button', { name: 'Design' }).click();
  const rows = page.locator('#sbBody .clause');
  const todo = rows.filter({ hasText: 'D-0003: no check result recorded yet' });
  await expect(todo.getByRole('button', { name: 'Write the check' })).toBeVisible();
  await expect(todo.getByRole('button', { name: 'Run check' })).toHaveCount(0);
  await expect(rows.filter({ hasText: 'D-0002 has no check' }).getByRole('button', { name: 'Draft a check' })).toBeVisible();
  // Approving the card (its apply is what the Approve button runs) replaces the TODO; then the check can run.
  await page.evaluate(async () => {
    const card = WRITERS.write_check({ decision: 'D-0003', script: '#!/usr/bin/env bash\nexit 0\n', summary: 'x' });
    await card.apply();
  });
  await expect.poll(() => fs.readFileSync(path.join(reg, 'decisions/D-0003.yaml'), 'utf8')).toMatch(/bash \.\/checks\/occ\.sh/);
  await expect(todo.getByRole('button', { name: 'Run check' })).toBeVisible();
  await expect(todo.getByRole('button', { name: 'Write the check' })).toHaveCount(0);
  // set_check fills a decision that has none.
  await page.evaluate(async () => { await WRITERS.set_check({ decision: 'D-0002', check: 'bash ./checks/b.sh', summary: 'x' }).apply(); });
  await expect.poll(() => fs.readFileSync(path.join(reg, 'decisions/D-0002.yaml'), 'utf8')).toMatch(/^checks:\n  - "?bash \.\/checks\/b\.sh/m);
});

test('user can see health on the C4 sheet @critical', async () => {
  const { reg } = copyRegistry('sample-registry');
  // The model holds the claims; health.json holds the evidence, keyed by the handover id (names joined by "/").
  const dsl = path.join(reg, 'model', 'workspace.dsl');
  fs.writeFileSync(dsl, fs.readFileSync(dsl, 'utf8').replace('"d.instances" "3"', '"d.instances" "3"\n          "d.idempotent" "yes"\n          "d.cached" "ttl 5m"'));
  const health = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'health.example.json'), 'utf8'));
  health.elements = { 'Fares Platform/Fares API': health.elements['Pricing/Quotes'] };
  fs.writeFileSync(path.join(reg, 'health.json'), JSON.stringify(health));
  session = await launch(reg);
  const { page } = session;
  // Off by default: the sheet is as it always was.
  await expect(page.locator('#sheetscroll .chip')).toHaveCount(0);
  await page.locator('#sheetBadges').selectOption('health');
  // The element's finding count, and one chip per property: claimed, with no check fresh against git yet, so declared.
  const api = page.locator('#sheetscroll .node', { hasText: 'Fares API' });
  await expect(api.locator('text', { hasText: /^14$/ })).toHaveCount(1);
  await expect(api.locator('.chip')).toHaveText(['idempotent: declared', 'cached: declared']);
  await expect(page.locator('#sheetscroll .chip')).toHaveCount(2); // nothing is drawn for elements the file does not mention
  // Headline numbers on the title block; selecting the element adds its findings by category.
  const block = page.locator('#titleblock');
  await expect(block).toContainText('2 properties'); // both claimed, neither verified
  await expect(block).toContainText('3 findings');
  await api.click();
  await expect(block).toContainText('8 smell, 3 duplication, 2 dead-code, 1 security (2 new)');
});
