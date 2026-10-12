// End-to-end tests for the designc app itself (Electron through Playwright's _electron).
// Run with `npm run e2e`; on Linux without a display, `xvfb-run -a npm run e2e`.
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
