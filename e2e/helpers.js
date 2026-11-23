// Launches designc on a fresh copy of a registry, with its own user data folder
// (trustAllFolders, so no native trust dialog) and never the user's state.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('@playwright/test');
const { makeAgentShim, attempts, isolatedEnv } = require('./agent-shim');

const APP = path.resolve(__dirname, '..');
const made = [];
const shims = [];

function scratch(prefix = 'designc-e2e-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

// Removes every folder this test made. Call after closing the app.
// It throws if a started app tried to start a real agent (e2e/agent-shim.js).
function cleanup() {
  const tried = shims.splice(0).flatMap(attempts);
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (tried.length) throw new Error(`e2e tried to start a real agent: ${tried.join('; ')}`);
}

// Copies `registry` (relative to the app) into a scratch folder outside any git repo.
// `codebase: true` also copies sample-codebase as the sibling designc.json names; a string copies that folder
// (relative to the app) as the sibling `designc-<basename>` instead.
// `siblings` are more app folders copied beside the registry as `designc-<basename>` (a references repo, say).
function copyRegistry(registry, { codebase = false, siblings = [] } = {}) {
  const dir = scratch();
  const reg = path.join(dir, 'registry');
  fs.cpSync(path.join(APP, registry), reg, { recursive: true });
  for (const s of siblings) fs.cpSync(path.join(APP, s), path.join(dir, `designc-${path.basename(s)}`), { recursive: true });
  if (typeof codebase === 'string') {
    fs.cpSync(path.join(APP, codebase), path.join(dir, `designc-${path.basename(codebase)}`), { recursive: true });
  } else if (codebase) {
    fs.cpSync(path.join(APP, 'sample-codebase'), path.join(dir, 'designc-sample-codebase'), {
      recursive: true,
      filter: src => !/[\\/](bin|obj)$/.test(src),
    });
  }
  return { dir, reg };
}

// `ready(page)` gives the locator that says the folder is loaded; by default the status bar's gate
// (a study notebook has no model, so no gate).
async function launch(reg, { ready = page => page.getByRole('button', { name: /^Gate: / }) } = {}) {
  const userData = scratch('designc-e2e-ud-');
  fs.writeFileSync(path.join(userData, 'state.json'), JSON.stringify({ trustAllFolders: true }));
  let realNpx = ''; try { realNpx = execFileSync('which', ['npx'], { encoding: 'utf8' }).trim(); } catch {}
  const shim = makeAgentShim(scratch('designc-e2e-shim-'), { realNpx });
  shims.push(shim.log);
  const app = await electron.launch({
    args: [APP, `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu', reg],
    cwd: APP,
    env: { ...isolatedEnv(process.env, shim.bin), DESIGNC_E2E: '1' },
  });
  const page = await app.firstWindow();
  page.on('dialog', d => d.accept());
  await page.waitForLoadState('domcontentloaded');
  await ready(page).waitFor({ timeout: 30000 });
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.isVisible()).length);
  if (visible) throw new Error(`e2e must not show a window, but ${visible} BrowserWindow(s) are visible`);
  return { app, page };
}

const readLedger = (reg, file) => {
  const p = path.join(reg, 'ledger', file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
};

module.exports = { APP, copyRegistry, launch, readLedger, cleanup };
