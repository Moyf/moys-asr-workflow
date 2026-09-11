import { defineConfig } from '@playwright/test';
const runId = process.env.MAW_SCROLL_RUN_ID ||= String(Date.now());

export default defineConfig({
  testDir: './tests/e2e', testMatch: 'cue-scroll-stability.spec.mjs',
  workers: 1, retries: 0, timeout: 120000,
  outputDir: process.env.MAW_SCROLL_RESULTS || `output/playwright/cue-scroll/results-${runId}`,
  use: { headless: true, viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' },
  projects: [ { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } } ],
});
