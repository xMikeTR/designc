'use strict';
// scripts/parity-import.js: drafts parity scenarios from legacy Playwright tests, flags what it cannot say, never guesses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const Parity = require('../renderer/parity.js');
const Import = require('../scripts/parity-import.js');

const pageObject = `import { Page, Locator } from '@playwright/test';
export class TagsPage {
  readonly program: Locator;
  readonly apply: Locator;
  constructor(private page: Page) {
    this.program = page.getByRole('textbox', { name: 'Program' });
    this.apply = page.getByRole('button', { name: 'Bulk apply', exact: true });
  }
  get export() { return this.page.locator('#export'); }
  async open() {
    await this.page.goto('https://legacy.example.test/tags');
  }
  async search(program: string) {
    await this.program.fill(program);
  }
}
`;
const spec = `import { test, expect } from '@playwright/test';
import { TagsPage } from './tags.page';
test('Bulk apply opens the dialog', async ({ page }) => {
  const tags = new TagsPage(page);
  await tags.open();
  await tags.search('54027');
  await tags.apply.click();
  // await page.getByText('ignored').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page
    .getByRole('row')
    .nth(2)
    .click();
  await page.getByLabel('Reason').fill('x');
  await tags.export.click();
  const year = page.getByRole('combobox', { name: 'Year' });
  await year.selectOption({ label: '2026' });
});
test('Bulk apply opens the dialog', async ({ page }) => {
  await page.goto(\`/tags/\${id}\`);
});
`;
const files = [{ path: 'tags.page.ts', text: pageObject }, { path: 'tags.spec.ts', text: spec }];

test('a test becomes steps through page objects, inline locators and local consts, in order', () => {
  const [d] = Import.drafts(files);
  assert.strictEqual(d.id, 'bulk-apply-opens-the-dialog');
  assert.deepStrictEqual(d.steps, [
    { goto: { path: '/tags' } },
    { fill: { role: 'textbox', name: 'Program', value: '54027' } },
    { click: { role: 'button', name: 'Bulk apply' } },
    { click: { role: 'row', name: '', index: 2 } },
    { select: { role: 'combobox', name: 'Year', value: '2026' } },
  ]);
  assert.strictEqual(d.assertions, 1);
  assert.deepStrictEqual(Parity.scenarioProblems({ id: d.id, steps: d.steps }), []);
});

test('what a scenario cannot say is flagged with file and line, and a comment is not code', () => {
  const [d, second] = Import.drafts(files);
  assert.deepStrictEqual(d.flags.map(f => `${f.file}:${f.line}`), ['tags.spec.ts:14', 'tags.spec.ts:15']);
  assert.match(d.flags[0].why, /getByLabel\(\) is not a role and name/);
  assert.match(d.flags[1].why, /locator\(\) is not a role and name/);
  assert.ok(!d.flags.some(f => /ignored/.test(f.text)));
  assert.strictEqual(second.id, 'bulk-apply-opens-the-dialog-2', 'a repeated title gets its own id');
  assert.deepStrictEqual(second.steps, []);
  assert.match(second.flags[0].why, /path that is not written out/);
});

test('roleLocator refuses what depends on the page: a name that is not written out, .last()', () => {
  assert.match(Import.roleLocator("getByRole('button', { name: label })").why, /name that is not written out/);
  assert.match(Import.roleLocator("getByRole('row').last()").why, /\.last\(\)/);
  assert.deepStrictEqual(Import.roleLocator("getByRole('row').first()").loc, { role: 'row', name: '', index: 0 });
});

test('the CLI reports, writes only with --write, and never overwrites a scenario', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-import-'));
  try {
    const from = path.join(dir, 'tests'), reg = path.join(dir, 'reg');
    fs.mkdirSync(from); fs.mkdirSync(reg);
    for (const f of files) fs.writeFileSync(path.join(from, f.path), f.text);
    const out = [];
    assert.strictEqual(Import.main(['--from', from, '--registry', reg], { log: s => out.push(s) }), 1, 'flags make exit 1');
    assert.ok(!fs.existsSync(path.join(reg, 'parity')), 'a report writes nothing');
    assert.match(out.join('\n'), /bulk-apply-opens-the-dialog: would write \(5 steps/);
    Import.main(['--from', from, '--registry', reg, '--write'], { log: () => {} });
    const file = path.join(reg, 'parity/scenarios/bulk-apply-opens-the-dialog.yaml');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^# Drafted by scripts\/parity-import.js from tags.spec.ts:3/);
    assert.match(text, /# not translated: tags.spec.ts:14 /);
    assert.deepStrictEqual(Parity.scenarioProblems(yaml.load(text)), []);
    assert.ok(!fs.existsSync(path.join(reg, 'parity/scenarios/bulk-apply-opens-the-dialog-2.yaml')), 'a draft with no steps is not written');
    fs.writeFileSync(file, 'id: bulk-apply-opens-the-dialog\n# edited by a person\n');
    const again = [];
    Import.main(['--from', from, '--registry', reg, '--write'], { log: s => again.push(s) });
    assert.match(again.join('\n'), /exists, not overwritten/);
    assert.match(fs.readFileSync(file, 'utf8'), /edited by a person/);
    assert.strictEqual(Import.main(['--registry', reg], { err: () => {} }), 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
