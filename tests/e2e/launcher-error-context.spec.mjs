import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/launcher/index.html');
const errorContext = { version: '1.8.0-beta.1', occurredAt: '2026-10-03T23:59:59+08:00' };

for (const [language, width] of [['zh', 900], ['en', 760]]) {
  test(`error context survives delayed copy (${language}, ${width})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 880 });
    await page.goto(`file://${launcherPath}`);
    await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
    if (language === 'en') {
      await page.evaluate(() => window.MAWLauncher.openSettings());
      await page.locator('#langEn').click();
      await page.locator('#settingsClose').click();
    }
    await page.evaluate((context) => {
      window.__reports = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => window.__reports.push(text) },
      });
      window.MAWLauncher.onBackendEvent({
        type: 'error', code: 'transcription_failed', detail: 'Example failure', errorContext: context,
      });
    }, errorContext);
    const footer = page.locator('#errorNoticeContext');
    await expect(footer).toHaveText(language === 'en'
      ? 'Version: 1.8.0-beta.1\nOccurred at: 2026-10-03 23:59:59+08:00'
      : '版本：1.8.0-beta.1\n发生时间：2026-10-03 23:59:59+08:00');
    await page.clock.setFixedTime(new Date('2026-10-05T10:00:00Z'));
    await page.locator('#errorNoticeCopy').click();
    const report = await page.evaluate(() => window.__reports[0]);
    expect(report).toContain(errorContext.occurredAt);
    expect(report).toContain(language === 'en' ? 'Occurred at:' : '发生时间:');
    expect(report).not.toContain('2026-10-05');
    const gap = await footer.evaluate((node) => node.getBoundingClientRect().top - document.querySelector('#errorNoticeActions').getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(8);
    await page.locator('#errorNotice').screenshot({ path: testInfo.outputPath(`error-context-${language}.png`) });
  });
}

test('synchronous and legacy errors both receive report context', async ({ page }) => {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.evaluate((context) => window.MAWLauncher.onBatchError({ ok: false, code: 'transcription_failed', detail: 'Sync failure', errorContext: context }), errorContext);
  await expect(page.locator('#errorNoticeContext')).toContainText('2026-10-03 23:59:59+08:00');
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({ type: 'error', code: 'transcription_failed', detail: 'Legacy event' }));
  await expect(page.locator('#errorNoticeContext')).toHaveText(/版本：.+\s+发生时间：\d{4}-\d{2}-\d{2} /);
});

test('switching language refreshes context labels without changing the error time or log', async ({ page }) => {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.evaluate((context) => {
    window.__reports = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => window.__reports.push(text) },
    });
    window.MAWLauncher.onBackendEvent({
      type: 'error', code: 'transcription_failed', detail: 'Example failure', errorContext: context,
    });
  }, errorContext);
  const log = await page.locator('#log').textContent();
  await page.clock.setFixedTime(new Date('2026-10-05T10:00:00Z'));
  for (const [language, expected] of [
    ['en', 'Version: 1.8.0-beta.1\nOccurred at: 2026-10-03 23:59:59+08:00'],
    ['zh', '版本：1.8.0-beta.1\n发生时间：2026-10-03 23:59:59+08:00'],
  ]) {
    await page.evaluate(() => window.MAWLauncher.openSettings());
    await page.locator(language === 'en' ? '#langEn' : '#langZh').click();
    await page.locator('#settingsClose').click();
    await expect(page.locator('#errorNoticeContext')).toHaveText(expected);
    await expect(page.locator('#log')).toHaveText(log);
  }
  await page.locator('#errorNoticeCopy').click();
  expect(await page.evaluate(() => window.__reports[0])).toContain(errorContext.occurredAt);
});
