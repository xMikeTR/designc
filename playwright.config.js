// End-to-end tests for the designc app itself (Electron through Playwright's _electron).
// Run with `npm run e2e`. The app runs hidden on every OS (DESIGNC_E2E=1), so no window appears;
// xvfb-run -a is optional on Linux.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.js',
  timeout: 60000,
  expect: { timeout: 15000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
