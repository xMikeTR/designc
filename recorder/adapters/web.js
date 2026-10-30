'use strict';
// Web adapter: a real browser through Playwright (Chromium). Acts with getByRole(role, {name, exact}).nth(index), waits
// for the page to settle, and captures Chromium's accessibility tree (roles and names as assistive technology sees
// them) with each node's box and data-testid. Playwright is required lazily, so loading this file costs nothing where
// it is not installed. Runs on a machine that can reach the apps (the work VM).
//
// params: { baseUrl, viewport?: {width, height}, locale?, timezoneId?, headless? }
const IGNORED = new Set(['InlineTextBox', 'LineBreak']);

async function settle(page, ms) {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: ms }).catch(() => {});
  // A single-page app re-renders after its requests settle (or fail), so wait until the DOM has been quiet for 250 ms.
  await page.evaluate(max => new Promise(done => {
    let t;
    const quiet = () => { clearTimeout(t); t = setTimeout(() => { obs.disconnect(); done(); }, 250); };
    const obs = new MutationObserver(quiet);
    obs.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    quiet();
    setTimeout(() => { obs.disconnect(); done(); }, max);
  }), ms).catch(() => {});
}

// Chromium's full AX tree into the recorder's raw tree. Ignored nodes are dropped and their children lifted, so the
// tree holds what assistive technology sees; the root (RootWebArea) is the page itself.
async function axTree(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    const prop = (n, k) => { const p = (n.properties || []).find(x => x.name === k); return p ? p.value.value : undefined; };
    const extra = async id => {
      if (id == null) return { box: null, testId: null };
      let box = null;
      let testId = null;
      try {
        const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: id });
        const q = model.border;
        box = { x: q[0], y: q[1], w: model.width, h: model.height };
      } catch { /* not rendered */ }
      try {
        const { node } = await cdp.send('DOM.describeNode', { backendNodeId: id });
        const at = node.attributes || [];
        const i = at.indexOf('data-testid');
        if (i >= 0) testId = at[i + 1];
      } catch { /* text node */ }
      return { box, testId };
    };
    async function build(n) {
      const kids = [];
      for (const cid of n.childIds || []) {
        const c = byId.get(cid);
        if (!c) continue;
        const role = c.role && c.role.value;
        if (c.ignored || IGNORED.has(role)) {
          for (const g of await build(c)) kids.push(g);
          continue;
        }
        kids.push(await node(c));
      }
      return kids;
    }
    async function node(n) {
      const { box, testId } = await extra(n.backendDOMNodeId);
      const out = { role: n.role ? n.role.value : '', name: n.name ? n.name.value : '', box, children: await build(n) };
      if (n.value && n.value.value !== undefined && n.value.value !== '') out.value = String(n.value.value);
      if (testId) out.testId = testId;
      if (prop(n, 'disabled')) out.disabled = true;
      return out;
    }
    return await node(nodes[0]);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

const hostname = u => { try { return new URL(u).hostname; } catch { return null; } };

// Why this page is a login wall rather than the app, or null. The new host catches a redirect to single sign-on; one
// visible password field catches a sign-in form on the app's own host (a change or register form has two or more).
async function loginWall(page, baseUrl) {
  const now = hostname(page.url());
  if (now && now !== hostname(baseUrl)) return `the app went to ${now}, not ${hostname(baseUrl)}`;
  const fields = await page.locator('input[type="password"]:visible').count();
  return fields === 1 ? `the page at ${new URL(page.url()).pathname} asks for a password` : null;
}

function create(name = 'web', { timeout = 10000 } = {}) {
  return {
    name,
    // readOnly aborts every request that is not GET, HEAD or OPTIONS, except URLs containing one of allowRequests (a
    // search that is sent as a POST, say); each abort is listed in the next capture as blockedRequests.
    async open({ params = {}, readOnly = true, allowRequests = [] }) {
      if (!params.baseUrl) throw new Error('no baseUrl in params');
      const { chromium } = require('playwright-core');
      const browser = await chromium.launch({ headless: params.headless !== false });
      const viewport = params.viewport || { width: 1280, height: 800 };
      const ctx = await browser.newContext({ viewport, locale: params.locale || 'en-GB', timezoneId: params.timezoneId || 'Europe/London' });
      const page = await ctx.newPage();
      let blocked = [];
      if (readOnly) {
        await ctx.route('**/*', route => {
          const req = route.request();
          const url = req.url();
          if (['GET', 'HEAD', 'OPTIONS'].includes(req.method()) || allowRequests.some(a => url.includes(a))) return route.continue();
          blocked.push({ method: req.method(), url });
          return route.abort('blockedbyclient');
        });
      }
      const settled = async () => {
        await settle(page, timeout);
        const wall = await loginWall(page, params.baseUrl);
        return wall ? { wall } : { ok: true };
      };
      const all = a => page.getByRole(a.role, a.name ? { name: a.name, exact: true } : {});
      return {
        async act(step) {
          if (step.goto) {
            await page.goto(new URL(step.goto.path, params.baseUrl).href);
            return settled();
          }
          const [k] = Object.keys(step);
          const a = step[k];
          const l = all(a).nth(a.index || 0);
          if ((await all(a).count()) <= (a.index || 0)) return { missing: `no ${a.role} named "${a.name}"${a.index ? ` (#${a.index})` : ''}` };
          if (k === 'click') await l.click({ timeout });
          else if (k === 'fill') await l.fill(a.value, { timeout });
          else await l.selectOption(a.value, { timeout });
          return settled();
        },
        async capture() {
          const out = { tree: await axTree(page), viewport, url: page.url() };
          if (blocked.length) { out.blockedRequests = blocked; blocked = []; }
          return out;
        },
        async screenshot() { return page.screenshot({ fullPage: true }); },
        async close() { await browser.close(); },
      };
    },
  };
}

module.exports = { create, axTree, loginWall };
