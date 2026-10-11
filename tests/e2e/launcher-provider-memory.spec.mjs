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

test('toolbox hides custom slots #2/#3 until a URL is saved', async ({ page }) => {
  await page.goto(launcherUrl);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length);
  const optionValues = (selector) => page.evaluate(
    sel => Array.from(document.querySelectorAll(`${sel} option`)).map(option => option.value),
    selector,
  );

  // 默认未配置：工具箱只保留首个自定义槽位，设置页仍列出全部槽位作为补填入口。
  expect(await optionValues('#postprocessProvider')).toContain('custom');
  expect(await optionValues('#postprocessProvider')).not.toContain('custom2');
  expect(await optionValues('#postprocessProvider')).not.toContain('custom3');
  expect(await optionValues('#llmProvider')).toEqual(expect.arrayContaining(['custom', 'custom2', 'custom3']));

  // 在设置页给 custom2 填 URL 保存后，工具箱下拉出现该槽位；custom3 仍未配置，继续隐藏。
  await page.locator('#settingsButton').click();
  await page.locator('#settingsLlmTab').click();
  await page.locator('#llmProvider').selectOption('custom2');
  await page.locator('#llmBaseUrl').fill('http://127.0.0.1:1234/v1');
  await page.locator('#llmModel').fill('local-model');
  await page.locator('#saveLlmSettings').click();
  await expect(page.locator('#postprocessProvider option[value="custom2"]')).toHaveCount(1);
  await expect(page.locator('#postprocessProvider option[value="custom3"]')).toHaveCount(0);
  expect(await optionValues('#llmProvider')).toEqual(expect.arrayContaining(['custom', 'custom2', 'custom3']));
});
