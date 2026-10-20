import { test, expect } from '@playwright/test';

const launcherUrl = new URL('../../web/launcher/index.html', import.meta.url).href;

test('boundary retry shows logical batch with retry number and keeps actionable failure detail', async ({ page }, testInfo) => {
  await page.goto(launcherUrl);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length);
  await page.evaluate(() => window.MAWLauncher.openToolboxAiProcessing());
  await page.locator('#postprocessOperation').selectOption('resegment');
  await page.locator('#toolboxInputPath').fill('source.mosp');
  await page.evaluate(() => {
    const original = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method !== 'run_llm_postprocess') return original(method, payload);
      for (const attempt of [1, 2]) {
        window.MAWLauncher.onPostprocessStream({ operationId: payload.operationId, kind: 'reset', batch: 1, attempt });
        window.MAWLauncher.onPostprocessStream({ operationId: payload.operationId, kind: 'content', batch: 1, attempt, text: '[c0001]\n[c0002]' });
      }
      return { ok: false, code: 'toolbox_failed', detail: '第 1 批断点校验失败：断点 [c0001] → [c0002]（原字幕 1 → 2）：左侧 "60" | 右侧 "fps"；断点拆开了数字与单位。\n重新断句阶段记录：source.resegment-record.md' };
    };
  });
  await page.locator('#runLlmPostprocess').click();
  await expect(page.locator('#toolboxStreamMeta')).toHaveText('第 1 批 · 重试 1');
  await expect(page.locator('#toolboxModelOutput')).toHaveText('[c0001]\n[c0002]');
  await expect(page.locator('#toolboxResult')).toContainText('左侧 "60"');
  await expect(page.locator('#toolboxResult')).toContainText('重新断句阶段记录：source.resegment-record.md');
  await expect(page.locator('#runLlmPostprocess')).toBeEnabled();
  await page.locator('#toolboxDrawer').screenshot({ path: testInfo.outputPath('resegment-retry-diagnostics.png') });
});
