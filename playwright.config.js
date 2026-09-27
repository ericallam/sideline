// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  use: {
    baseURL: 'http://localhost:4173',
    // Landscape iPad-ish viewport; the app is only ever used on an iPad
    viewport: { width: 1180, height: 820 },
    serviceWorkers: 'block', // SW caching would serve stale files between edits
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1180, height: 820 } } }],
  webServer: {
    command: 'pnpm exec serve public -l 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
  },
});
