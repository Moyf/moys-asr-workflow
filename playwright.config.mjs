import { defineConfig } from '@playwright/test';

const configuredChromiumPath = String(process.env.MAW_E2E_CHROMIUM_PATH || '').trim();

export default defineConfig({
  testDir: './tests/e2e',
  // 每个 spec 文件用 helpers 里的 findFreePort 起独立服务器，文件之间天然隔离，
  // 文件级并行安全；文件内部仍串行。2 个 worker 兼顾吞吐与负载敏感用例的稳定性。
  workers: 2,
  timeout: 60_000,
  retries: 0,
  trace: 'retain-on-failure',
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 10_000,
    // Launcher 按 navigator.language 自动选界面语言（beta.4 起）；Playwright
    // 默认 en-US 会把整页切成英文，导致中文文案断言全部失配。钉住 zh-CN
    // 与产品主要用户基线一致；英文模式用例自行点击语言切换。
    locale: 'zh-CN',
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
