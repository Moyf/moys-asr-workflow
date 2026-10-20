import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const runId = process.env.MAW_SCROLL_RUN_ID ||= String(Date.now());
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = process.env.MAW_SCROLL_RESULTS
  ? path.resolve(repositoryRoot, process.env.MAW_SCROLL_RESULTS)
  : path.join(repositoryRoot, `output/playwright/cue-scroll/results-${runId}`);

export default defineConfig({
  testDir: '../e2e', testMatch: 'cue-scroll-stability.spec.mjs',
  workers: 1, retries: 0, timeout: 120000,
  outputDir,
  use: { headless: true, viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' },
  projects: [ { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } } ],
});
