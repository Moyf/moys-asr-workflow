import { test, expect } from '@playwright/test';

const launcherUrl = new URL('../../web/launcher/index.html', import.meta.url).href;

test('custom slot errors use localized labels and custom authentication guidance', async ({ page }) => {
  await page.goto(launcherUrl);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length);
  for (const [providerId, label] of [['custom', '自定义接口（或本地模型）'], ['custom2', '自定义接口 #2'], ['custom3', '自定义接口 #3']]) {
    const message = await page.evaluate(id => window.MAWLauncher.errorText('postprocess_connection_failed', '', {
      httpStatus: 401, providerId: id, operation: 'connection test',
    }), providerId);
    expect(message).toContain(label);
    expect(message).toContain('API URL、API Key 是否来自同一服务商');
    expect(message).not.toContain('官网');
  }
});

test('DeepSeek links to AI Processing and translation restores its own provider', async ({ page }) => {
  await page.goto(launcherUrl);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length);
  await page.locator('#provider').selectOption('deepseek');
  await expect(page.locator('#start')).toBeDisabled();
  await page.locator('#providerNote button').click();
  await expect(page.locator('#toolboxDrawer')).toBeVisible();
  await expect(page.locator('#toolboxLlmTab')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#postprocessOperation').selectOption('translate_zh');
  await page.locator('#postprocessProvider').selectOption('qwen');
  await page.locator('#postprocessOperation').selectOption('proofread');
  await page.locator('#postprocessProvider').selectOption('deepseek');
  await page.locator('#postprocessOperation').selectOption('translate_en');
  await expect(page.locator('#postprocessProvider')).toHaveValue('qwen');
  const plan = await page.evaluate(() => window.MAWLauncher.getAutoPostprocessPayload());
  expect(plan.steps.find(step => step.id === 'translate').providerId).toBe('qwen');
  expect(plan.steps.find(step => step.id === 'proofread').providerId).toBe('deepseek');
});
