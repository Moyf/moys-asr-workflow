import { completeStaticLauncherDiscovery } from './launcher-ready.mjs';
import { test, expect } from '@playwright/test';

const launcherUrl = new URL('../../web/launcher/index.html', import.meta.url).href;

test('startup migrates legacy cleanup memory, preserves newer choices and restores comparison from other AI steps', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('maw.launcher.llm.provider_by_task', JSON.stringify({ ai_cleanup: 'qwen', cleanup: 'deepseek' }));
    const dispatch = window.dispatchEvent.bind(window);
    window.dispatchEvent = event => {
      if (event.type === 'mawlauncherready') {
        window.MAWLauncher.config.postprocessAutoPlan = { enabled: true, steps: [
          { id: 'match', enabled: true, aiCleanup: true, providerId: 'qwen' },
          { id: 'proofread', enabled: false, generateComparison: true },
        ] };
        document.getElementById('postprocessOperation').value = 'ai_cleanup';
      }
      return dispatch(event);
    };
  });
  await page.goto(launcherUrl);
  await completeStaticLauncherDiscovery(page);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length);
  await page.evaluate(() => window.MAWLauncher.openToolboxAiProcessing());
  await expect(page.locator('#postprocessProvider')).toHaveValue('deepseek');
  await expect(page.locator('#postprocessGenerateComparison')).toBeChecked();
  const result = await page.evaluate(() => ({
    memory: JSON.parse(localStorage.getItem('maw.launcher.llm.provider_by_task')),
    plan: window.MAWLauncher.getAutoPostprocessPayload(),
  }));
  expect(result.memory.cleanup).toBe('deepseek');
  expect(result.memory.ai_cleanup).toBeUndefined();
  expect(result.plan.steps.find(step => step.id === 'cleanup').providerId).toBe('deepseek');
  expect(result.plan.steps.filter(step => ['cleanup', 'proofread', 'resegment', 'translate'].includes(step.id)).every(step => step.generateComparison)).toBe(true);
  expect(errors).toEqual([]);
});

test('AI cleanup independently remembers its provider for manual requests and saved plans', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(launcherUrl);
  await completeStaticLauncherDiscovery(page);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length);
  await page.evaluate(() => window.MAWLauncher.openToolboxAiProcessing());
  await page.locator('#postprocessOperation').selectOption('translate_zh');
  await page.locator('#postprocessProvider').selectOption('qwen');
  await page.locator('#postprocessOperation').selectOption('ai_cleanup');
  await page.locator('#postprocessProvider').selectOption('deepseek');
  expect(await page.evaluate(() => window.MAWLauncher.getAutoPostprocessPayload().steps.find(s => s.id === 'cleanup').providerId)).toBe('deepseek');
  await page.reload();
  await completeStaticLauncherDiscovery(page);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length);
  await page.evaluate(() => window.MAWLauncher.openToolboxAiProcessing());
  await expect(page.locator('#postprocessProvider')).toHaveValue('qwen');
  await page.locator('#postprocessOperation').selectOption('ai_cleanup');
  await expect(page.locator('#postprocessProvider')).toHaveValue('deepseek');
  await page.evaluate(() => {
    Object.assign(window.MAWLauncher.config.postprocessProviders.find(p => p.id === 'deepseek'),
      { verified: true, hasApiKey: true, hasBaseUrl: true, hasModel: true });
    window.__cleanupSavedPlans = [];
    const original = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'save_postprocess_plan') window.__cleanupSavedPlans.push(payload.plan);
      if (method === 'run_ai_cleanup') {
        window.__cleanupProviderRequest = payload;
        return { ok: false, code: 'toolbox_failed', detail: 'fixture stopped before model invocation' };
      }
      return original(method, payload);
    };
  });
  await page.locator('#postprocessCleanupScriptPath').fill('script.txt');
  await page.locator('#toolboxInputPath').fill('source.mosp');
  await expect.poll(() => page.evaluate(() => window.__cleanupSavedPlans.at(-1)?.steps.find(s => s.id === 'cleanup')?.providerId)).toBe('deepseek');
  await page.locator('#runLlmPostprocess').click();
  await expect.poll(() => page.evaluate(() => window.__cleanupProviderRequest?.providerId)).toBe('deepseek');
  expect(pageErrors).toEqual([]);
  await expect(page.locator('#runLlmPostprocess')).toBeEnabled();
  await page.locator('#toolboxDrawer').screenshot({ path: testInfo.outputPath('cleanup-provider.png') });
});

test('custom slot errors use localized labels and custom authentication guidance', async ({ page }) => {
  await page.goto(launcherUrl);
  await completeStaticLauncherDiscovery(page);
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
  await completeStaticLauncherDiscovery(page);
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
  await completeStaticLauncherDiscovery(page);
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
  const toolboxProvider = await page.locator('#postprocessProvider').inputValue();
  const firstSlotName = await page.evaluate(() => window.MAWLauncher.config.postprocessProviders.find(item => item.id === 'custom').displayName);

  // 在设置页给 custom2 填 URL 保存后，工具箱下拉出现该槽位；custom3 仍未配置，继续隐藏。
  await page.locator('#settingsButton').click();
  await page.locator('#settingsLlmTab').click();
  await page.locator('#llmProvider').selectOption('custom2');
  await expect(page.locator('#postprocessProvider')).toHaveValue(toolboxProvider);
  await page.locator('#llmCustomDisplayName').fill('Second local service');
  expect(await page.evaluate(() => window.MAWLauncher.config.postprocessProviders.find(item => item.id === 'custom').displayName)).toBe(firstSlotName);
  await expect(page.locator('#llmProvider option[value="custom2"]')).toHaveText('Second local service');
  await page.locator('#llmBaseUrl').fill('http://127.0.0.1:1234/v1');
  await page.locator('#llmModel').fill('local-model');
  await page.locator('#saveLlmSettings').click();
  await expect(page.locator('#postprocessProvider option[value="custom2"]')).toHaveCount(1);
  await expect(page.locator('#postprocessProvider option[value="custom3"]')).toHaveCount(0);
  expect(await optionValues('#llmProvider')).toEqual(expect.arrayContaining(['custom', 'custom2', 'custom3']));
});
