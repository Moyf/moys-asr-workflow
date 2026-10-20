import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/launcher/index.html');

async function openLauncher(page) {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#autoPostprocessEnabled').check();
}

test('mock local provider stays ready after testing and refreshing another automatic step', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('maw.launcher.llm.provider_by_task', JSON.stringify({ cleanup: 'deepseek', proofread: 'deepseek' })));
  await openLauncher(page);
  await page.locator('#autoStepCleanup').click();
  await expect(page.locator('#settingsModal')).toBeVisible();
  await page.locator('#llmProvider').selectOption('custom');
  await page.locator('#llmApiKey').fill('');
  await page.locator('#llmBaseUrl').fill('http://127.0.0.1:1234/v1');
  await page.locator('#llmModel').fill('local-model');
  await page.locator('#testLlmConnection').click();
  await expect(page.locator('#autoStepCleanup')).toBeChecked();
  await page.locator('#settingsClose').click();
  await page.locator('#autoStepProofread').click();
  await expect(page.locator('#settingsModal')).toBeVisible();
  await expect(page.locator('#llmProvider')).toHaveValue('deepseek');
  await page.locator('#settingsClose').click();
  await page.locator('#autoStepCleanup').uncheck();
  await page.locator('#autoStepCleanup').check();
  await expect(page.locator('#autoStepCleanup')).toBeChecked();
  await expect(page.locator('#settingsModal')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('local-provider-ready.png') });
});

for (const dismiss of ['close', 'backdrop', 'escape']) {
  test(`dismissed automatic setup stays disabled after an unrelated test via ${dismiss}`, async ({ page }) => {
    await openLauncher(page);
    await page.locator('#autoStepCleanup').click();
    await expect(page.locator('#settingsModal')).toBeVisible();
    if (dismiss === 'close') await page.locator('#settingsClose').click();
    if (dismiss === 'backdrop') await page.locator('#settingsBackdrop').click({ position: { x: 2, y: 2 } });
    if (dismiss === 'escape') await page.keyboard.press('Escape');
    await expect(page.locator('#settingsModal')).toBeHidden();
    await page.locator('#settingsButton').click();
    await page.locator('#settingsLlmTab').click();
    await page.locator('#llmApiKey').fill('demo-key');
    await page.locator('#testLlmConnection').click();
    await expect(page.locator('#llmSettingsSaveStatus')).toContainText('连接成功');
    await expect(page.locator('#autoStepCleanup')).not.toBeChecked();
  });
}

test('canceling a checkbox during the provider refresh does not open settings', async ({ page }) => {
  await openLauncher(page);
  await page.evaluate(() => {
    const callBackend = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = (method, payload) => method === 'get_config'
      ? new Promise(resolve => { window.finishProviderRefresh = resolve; })
      : callBackend(method, payload);
  });
  await page.locator('#autoStepCleanup').check();
  await page.waitForFunction(() => typeof window.finishProviderRefresh === 'function');
  await page.locator('#autoStepCleanup').uncheck();
  await page.evaluate(() => window.finishProviderRefresh({ postprocessProviders: window.MAWLauncher.config.postprocessProviders }));
  await expect(page.locator('#autoStepCleanup')).not.toBeChecked();
  await expect(page.locator('#settingsModal')).toBeHidden();
});

test('Escape cancels and unchecks a step before its provider refresh returns', async ({ page }) => {
  await openLauncher(page);
  await page.evaluate(() => {
    const callBackend = window.MAWLauncher.callBackend;
    window.savedCancelPlans = [];
    window.MAWLauncher.callBackend = (method, payload) => {
      if (method === 'get_config') return new Promise(resolve => { window.finishProviderRefresh = resolve; });
      if (method === 'save_postprocess_plan') window.savedCancelPlans.push(payload.plan);
      return callBackend(method, payload);
    };
  });
  await page.locator('#autoStepCleanup').check();
  await page.waitForFunction(() => typeof window.finishProviderRefresh === 'function');
  await page.keyboard.press('Escape');
  await expect(page.locator('#autoStepCleanup')).not.toBeChecked();
  await page.evaluate(() => window.finishProviderRefresh({ postprocessProviders: window.MAWLauncher.config.postprocessProviders }));
  await expect(page.locator('#settingsModal')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.savedCancelPlans.at(-1)?.steps.find(step => step.id === 'cleanup')?.enabled)).toBe(false);
});
