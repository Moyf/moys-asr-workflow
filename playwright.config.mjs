import { defineConfig } from '@playwright/test';

const configuredChromiumPath = String(process.env.MAW_E2E_CHROMIUM_PATH || '').trim();

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 60_000,
  retries: 0,
  trace: 'retain-on-failure',
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 10_000,
    ...(configuredChromiumPath
      ? { launchOptions: { executablePath: configuredChromiumPath } }
      : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
