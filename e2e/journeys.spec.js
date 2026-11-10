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
  await expect(page.locator('#sbBody').getByText('Repos: Api, Ui')).toBeVisible();
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
});
