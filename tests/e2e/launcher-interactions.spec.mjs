import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/launcher/index.html');

async function openLauncher(page) {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#toolboxFab').click();
}

async function runReplacement(page, { outputMode = 'both' } = {}) {
  const previousCount = await page.locator('.toolbox-chain-item').count();
  await page.locator('#toolboxReplaceTab').click();
  await page.locator('#toolboxInputPath').fill('D:\\Demo\\source.mosp');
  await page.locator('#postprocessOutputMode').selectOption(outputMode);
  await page.locator('#postprocessReplacements').fill('old => new');
  await page.locator('#runFixedProcess').click();
  await expect(page.locator('.toolbox-chain-item')).toHaveCount(previousCount + 1);
}

test('translation merge option follows manual and automatic translation controls', async ({ page }) => {
  await openLauncher(page);
  await page.locator('#toolboxLlmTab').click();

  const manualOptions = page.locator('#postprocessTranslationOptions');
  await expect(manualOptions).toBeHidden();
  await expect(page.locator('#postprocessMergeBilingual')).not.toBeChecked();

  await page.locator('#postprocessOperation').selectOption('translate_en');
  await expect(manualOptions).toBeVisible();
  await expect(page.locator('#postprocessMergeBilingual')).not.toBeChecked();
  await page.locator('#postprocessOperation').selectOption('proofread');
  await expect(manualOptions).toBeHidden();
  await page.locator('#toolboxClose').click();

  await page.evaluate(() => {
    const provider = window.MAWLauncher.config.postprocessProviders.find((item) => item.id === 'deepseek');
    Object.assign(provider, { verified: true, hasApiKey: true, hasBaseUrl: true, hasModel: true });
    window.__savedPlans = [];
    const original = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'save_postprocess_plan') window.__savedPlans.push(JSON.parse(JSON.stringify(payload.plan)));
      return original(method, payload);
    };
  });
  await page.locator('#autoPostprocessEnabled').check();
  await page.locator('#autoStepTranslate').check();
  await expect(page.locator('#autoTranslateTargetField')).toBeVisible();
  await expect(page.locator('#autoTranslateMergeField')).toBeVisible();
  await expect(page.locator('#autoTranslateMergeBilingual')).not.toBeChecked();

  await page.locator('#autoTranslateMergeBilingual').check();
  await expect.poll(() => page.evaluate(() => {
    const plans = window.__savedPlans || [];
    const latest = plans[plans.length - 1];
    return latest?.steps?.find((step) => step.id === 'translate')?.mergeBilingual;
  })).toBe(true);

  await page.locator('#autoStepTranslate').uncheck();
  await expect(page.locator('#autoTranslateTargetField')).toBeHidden();
  await expect(page.locator('#autoTranslateMergeField')).toBeHidden();
});

test('Launcher settings switch between accessible tabs and deep links', async ({ page }) => {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#settingsButton').click();

  const tabs = page.locator('#settingsTabList [role="tab"]');
  await expect(tabs).toHaveCount(4);
  await expect(page.locator('#settingsTabList')).toHaveAttribute('aria-label', '设置分类');
  await expect(page.locator('#settingsGeneralPanel')).toBeVisible();
  await expect(page.locator('#settingsLlmPanel')).toBeHidden();
  await expect(page.locator('#settingsLlmTab')).toHaveText('大语言模型（AI）');

  const settingsCard = page.locator('#settingsModal .settings-modal-card');
  const initialCard = await settingsCard.boundingBox();
  const initialScroll = await page.locator('.settings-scroll').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollbarGutter: getComputedStyle(element).scrollbarGutter,
  }));

  await page.locator('#settingsLlmTab').click();
  await expect(page.locator('#settingsLlmTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#settingsLlmPanel')).toBeVisible();
  await expect(page.locator('#settingsGeneralPanel')).toBeHidden();
  const llmCard = await settingsCard.boundingBox();
  const llmScroll = await page.locator('.settings-scroll').evaluate((element) => element.clientWidth);
  expect(Math.abs(llmCard.y - initialCard.y)).toBeLessThan(1);
  expect(Math.abs(llmCard.height - initialCard.height)).toBeLessThan(1);
  expect(initialScroll.scrollbarGutter).toContain('stable');
  expect(llmScroll).toBe(initialScroll.clientWidth);

  await page.locator('#settingsLlmTab').press('ArrowRight');
  await expect(page.locator('#settingsProcessingTab')).toBeFocused();
  await expect(page.locator('#settingsProcessingPanel')).toBeVisible();
  await page.locator('#settingsProcessingTab').press('End');
  await expect(page.locator('#settingsRuntimeTab')).toBeFocused();
  await expect(page.locator('#settingsRuntimePanel')).toBeVisible();

  await page.evaluate(() => window.MAWLauncher.openSettings('ffmpegSettingsSection'));
  await expect(page.locator('#settingsRuntimeTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ffmpegSettingsSection')).toBeVisible();

  await page.setViewportSize({ width: 520, height: 520 });
  await page.reload();
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#settingsButton').click();
  const tabLayout = await page.locator('#settingsTabList').evaluate((element) => {
    const style = getComputedStyle(element);
    return { columns: style.gridTemplateColumns.split(' ').length, overflow: element.scrollWidth > element.clientWidth };
  });
  expect(tabLayout.columns).toBe(2);
  expect(tabLayout.overflow).toBe(false);
});

test('LLM settings refill the saved key and save only after a successful connection test', async ({ page }) => {
  await openLauncher(page);
  await page.locator('#toolboxLlmTab').click();
  await page.locator('#openLlmSettings').click();
  await page.evaluate(async () => {
    await window.MAWLauncher.callBackend('save_postprocess_settings', {
      providerId: 'deepseek',
      apiKey: 'sk-saved-for-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    });
    const select = document.querySelector('#postprocessProvider');
    select.value = 'zhipu';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.value = 'deepseek';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await expect(page.locator('#llmApiKey')).toHaveValue('sk-saved-for-test');
  await expect(page.locator('#llmKeyStatus')).toHaveText('已从本地环境读取密钥 sk-…mock');
  await page.locator('#llmApiKey').fill('sk-entered-for-test');
  await page.evaluate(() => {
    const callBackend = window.MAWLauncher.callBackend;
    window.__llmCalls = [];
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'test_postprocess_connection' || method === 'save_postprocess_settings') {
        window.__llmCalls.push({ method, payload });
      }
      return callBackend(method, payload);
    };
  });

  await page.locator('#testLlmConnection').click();
  await expect(page.locator('#llmSettingsSaveStatus')).toHaveText('连接成功（已自动保存到本地环境）');
  expect(await page.evaluate(() => window.__llmCalls.map(({ method }) => method))).toEqual([
    'test_postprocess_connection',
  ]);
  expect(await page.evaluate(() => window.__llmCalls[0].payload.save)).toBe(true);
  await expect(page.locator('#llmApiKey')).toHaveValue('sk-entered-for-test');
});

test('Custom provider labels and missing-key errors follow the selected language', async ({ page }) => {
  await openLauncher(page);

  const customOption = page.locator('#postprocessProvider option[value="custom"]');
  const settingsCustomOption = page.locator('#llmProvider option[value="custom"]');
  await expect(customOption).toHaveText('自定义（兼容 OpenAI）');
  await expect(settingsCustomOption).toHaveText('自定义（兼容 OpenAI）');

  await page.locator('#langToggle').click();
  await expect(customOption).toHaveText('Custom (OpenAI-compatible)');
  await expect(settingsCustomOption).toHaveText('Custom (OpenAI-compatible)');
  await page.locator('#toolboxLlmTab').click();
  await page.locator('#openLlmSettings').click();
  await page.evaluate(() => {
    window.MAWLauncher.callBackend = async (method) => (
      method === 'test_postprocess_connection'
        ? { ok: false, field: 'postprocessApiKey', code: 'api_key_missing', detail: 'Post-processing API key is required.', error: 'Post-processing API key is required.' }
        : { ok: true }
    );
  });

  await page.locator('#llmApiKey').fill('');
  await page.locator('#testLlmConnection').click();
  await expect(page.locator('#llmSettingsSaveStatus')).toHaveText('');
  await expect(page.locator('#llmSettingsSaveStatus')).toBeHidden();
  await expect(page.locator('#llmApiKeyError')).toHaveText('Enter an API Key, or save one first in Settings / API key.');
  await expect(page.locator('#llmApiKey')).toHaveClass(/invalid/);

  await page.locator('#llmProvider').selectOption('zhipu');
  await expect(page.locator('#llmApiKey')).not.toHaveClass(/invalid/);
  await expect(page.locator('#llmApiKeyError')).toHaveText('');

  await page.evaluate(() => {
    window.MAWLauncher.callBackend = async (method) => (
      method === 'test_postprocess_connection'
        ? { ok: true, saved: true, verified: true, maskedApiKey: 'sk-…mock' }
        : { ok: true }
    );
  });
  await page.locator('#llmApiKey').fill('sk-success');
  await page.locator('#testLlmConnection').click();
  await expect(page.locator('#llmSettingsSaveStatus')).toHaveText('Connection successful (saved to local environment automatically).');
  await expect(page.locator('#llmApiKeyError')).toHaveText('');
  await expect(page.locator('#llmApiKey')).not.toHaveClass(/invalid/);
});

test('LLM HTTP failures give provider-aware actions without showing the key', async ({ page }) => {
  await openLauncher(page);
  await page.locator('#toolboxLlmTab').click();
  await page.locator('#openLlmSettings').click();
  await page.locator('#llmApiKey').fill('test-only-key');
  await page.evaluate(() => {
    window.__llmFailureStatus = 401;
    window.__llmFailureProvider = 'deepseek';
    window.MAWLauncher.callBackend = async (method) => {
      if (method === 'test_postprocess_connection') {
        return {
          ok: false,
          field: 'postprocessProvider',
          code: 'postprocess_connection_failed',
          httpStatus: window.__llmFailureStatus,
          providerId: window.__llmFailureProvider,
          operation: 'connection test',
        };
      }
      if (method === 'get_postprocess_models') {
        return {
          ok: false,
          field: 'postprocessModel',
          code: 'postprocess_models_failed',
          httpStatus: window.__llmFailureStatus,
          providerId: window.__llmFailureProvider,
          operation: 'model list',
        };
      }
      return { ok: true };
    };
  });

  await page.locator('#testLlmConnection').click();
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('认证失败（HTTP 401');
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('当前供应商：DeepSeek 官网');
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('API URL');
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('官方控制台');
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('自定义（兼容 OpenAI）');
  await expect(page.locator('#llmSettingsSaveStatus')).not.toContainText('正确配置模型名');
  await expect(page.locator('#llmSettingsSaveStatus')).not.toContainText('test-only-key');

  await page.evaluate(() => { window.__llmFailureStatus = 403; });
  await page.locator('#testLlmConnection').click();
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('供应商拒绝了请求（HTTP 403');
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('账号或模型有权限');

  await page.evaluate(() => { window.__llmFailureStatus = 404; });
  await page.locator('#getLlmModels').click();
  await expect(page.locator('#llmModelError')).toContainText('接口或模型不存在（HTTP 404');
  await expect(page.locator('#llmModelError')).toContainText('/models');
  await expect(page.locator('#llmModelError')).not.toContainText('test-only-key');

  await page.evaluate(() => { window.__llmFailureStatus = 429; });
  await page.locator('#getLlmModels').click();
  await expect(page.locator('#llmModelError')).toContainText('请求被限流或额度暂时耗尽（HTTP 429');
  await expect(page.locator('#llmModelError')).toContainText('稍后重试');
  await expect(page.locator('#llmModelError')).not.toContainText('HTTP 404');

  await page.evaluate(() => { window.__llmFailureStatus = 401; window.__llmFailureProvider = 'custom'; });
  await page.locator('#testLlmConnection').click();
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('认证失败（HTTP 401');
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('当前供应商：自定义（兼容 OpenAI）');
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('API URL、API Key 是否来自同一服务商');
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('正确配置模型名');
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('请勿在错误报告中粘贴你的个人 API Key');
  await expect(page.locator('#llmSettingsSaveStatus')).not.toContainText('官方控制台');
});

test('runtime errors show an actionable notice outside the log', async ({ page }) => {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await expect(page.locator('#status')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('就绪');

  await page.evaluate(() => window.MAWLauncher.onBackendEvent({
    type: 'error',
    code: 'ffmpeg_missing',
    detail: 'ffmpeg and ffprobe were not found',
  }));

  const notice = page.locator('#errorNotice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('未找到 FFmpeg / FFprobe');
  await expect(page.locator('#status')).toBeVisible();
  await expect(page.locator('#status')).toContainText('未找到 FFmpeg / FFprobe');
  await expect(page.locator('#errorNoticeActions')).toBeVisible();
  await expect(page.locator('#errorNoticeAction')).toHaveText('FFmpeg 配置项');
  await expect(page.locator('#errorNoticeFaq')).toHaveText('查看常见问题');
  await expect(page.locator('#errorNoticeIssue')).toBeHidden();
  await expect(page.locator('#errorNoticeActions > button')).toHaveCount(4);
  await expect(notice).toHaveCSS('display', 'flex');
  await expect(notice).toHaveCSS('flex-direction', 'column');
  await expect(page.locator('#errorNoticeActions')).toHaveCSS('display', 'flex');
  await expect(page.locator('#errorNoticeActions')).toHaveCSS('flex-direction', 'row');
  await expect(page.locator('#errorNoticeActions')).toHaveCSS('flex-wrap', 'wrap');
  await expect(page.locator('#errorNoticeClose')).toHaveCSS('position', 'absolute');
  await page.setViewportSize({ width: 480, height: 800 });
  await expect(page.locator('#errorNoticeActions')).toHaveCSS('display', 'flex');
  await expect(page.locator('#errorNoticeActions')).toHaveCSS('flex-direction', 'row');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    const original = window.MAWLauncher.callBackend;
    window.__faqCalls = [];
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'open_faq') window.__faqCalls.push({ method, payload });
      return original(method, payload);
    };
  });
  await page.locator('#errorNoticeFaq').click();
  await expect.poll(() => page.evaluate(() => window.__faqCalls.length)).toBe(1);
  await page.locator('#errorNoticeAction').click();
  await expect(page.locator('#settingsModal')).toBeVisible();
  await expect(page.locator('#ffmpegSettingsSection')).toBeVisible();

  await page.locator('#settingsClose').click();
  await page.locator('#errorNoticeClose').click();
  await expect(notice).toBeHidden();
  await expect(page.locator('#status')).toBeVisible();
  await expect(page.locator('#status')).toContainText('未找到 FFmpeg / FFprobe');
});

test('provider HTTP failures keep retry guidance and original transcription discoverable', async ({ page }) => {
  await openLauncher(page);
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({
    type: 'error',
    code: 'postprocess_provider_response',
    detail: '后处理步骤 translate 失败：LLM provider returned HTTP 400: invalid request. This is a provider response, not a network outage.',
    canRetry: true,
    failedStep: 'translate',
    originalSrtPath: 'D:\\Demo\\clip.srt',
    originalProjectPath: 'D:\\Demo\\clip.mosp',
  }));

  await expect(page.locator('#errorNotice')).toBeVisible();
  await expect(page.locator('#errorNoticeMessage')).toContainText('这不是网络中断');
  await expect(page.locator('#errorNoticeMessage')).toContainText('原始转写仍然保留');
  await expect(page.locator('#retryPostprocess')).toBeVisible();
  await expect(page.locator('#openFolder')).toBeVisible();
  await expect(page.locator('#srtPath')).toHaveValue('D:\\Demo\\clip.srt');
  await expect(page.locator('#jsonPath')).toHaveValue('D:\\Demo\\clip.mosp');
});

test('error notice and status remain above the fixed footer at desktop and narrow widths', async ({ page }) => {
  const measure = () => page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
    };
    return {
      notice: box('#errorNotice'),
      copy: box('.error-notice-copy'),
      actions: box('#errorNoticeActions'),
      close: box('#errorNoticeClose'),
      status: box('#status'),
      footer: box('.actions'),
    };
  });
  const showFailure = async () => {
    await page.evaluate(() => {
      window.MAWLauncher.onBackendEvent({ type: 'error', code: 'ffmpeg_missing', detail: 'ffmpeg and ffprobe were not found' });
    });
    await expect(page.locator('#errorNotice')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(async () => {
      const metrics = await measure();
      return metrics.notice.bottom <= metrics.footer.top + 1 && metrics.status.bottom <= metrics.footer.top + 1;
    }).toBe(true);
  };
  const showRetry = async () => {
    await page.evaluate(() => document.querySelector('#retryPostprocess').classList.remove('hidden'));
    // Let ResizeObserver recalculate the shell's bottom reserve before moving
    // to the document end; this models the real late-arriving retry action.
    await page.waitForTimeout(80);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(async () => {
      const metrics = await measure();
      return metrics.notice.bottom <= metrics.footer.top + 1 && metrics.status.bottom <= metrics.footer.top + 1;
    }).toBe(true);
  };

  await page.setViewportSize({ width: 1180, height: 520 });
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await showFailure();
  const desktopNormal = await measure();
  expect(desktopNormal.notice.bottom).toBeLessThanOrEqual(desktopNormal.footer.top + 1);
  expect(desktopNormal.status.bottom).toBeLessThanOrEqual(desktopNormal.footer.top + 1);
  expect(desktopNormal.copy.width).toBeGreaterThan(250);
  expect(desktopNormal.actions.top).toBeGreaterThanOrEqual(desktopNormal.copy.bottom - 1);
  expect(desktopNormal.actions.left).toBeGreaterThanOrEqual(desktopNormal.notice.left - 1);
  expect(desktopNormal.actions.right).toBeLessThanOrEqual(desktopNormal.notice.right + 1);
  expect(desktopNormal.close.right).toBeGreaterThanOrEqual(desktopNormal.notice.right - 16);
  expect(desktopNormal.close.top).toBeGreaterThanOrEqual(desktopNormal.notice.top - 1);
  expect(desktopNormal.close.bottom).toBeLessThanOrEqual(desktopNormal.notice.top + 42);
  expect(desktopNormal.actions.height).toBeGreaterThanOrEqual(30);
  await showRetry();
  const desktopDynamic = await measure();
  await expect(page.locator('#retryPostprocess')).toBeVisible();
  expect(desktopDynamic.footer.height).toBeGreaterThanOrEqual(desktopNormal.footer.height);
  expect(desktopDynamic.notice.bottom).toBeLessThanOrEqual(desktopDynamic.footer.top + 1);
  expect(desktopDynamic.status.bottom).toBeLessThanOrEqual(desktopDynamic.footer.top + 1);

  await page.setViewportSize({ width: 520, height: 520 });
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await showFailure();
  const narrowNormal = await measure();
  expect(narrowNormal.notice.bottom).toBeLessThanOrEqual(narrowNormal.footer.top + 1);
  expect(narrowNormal.status.bottom).toBeLessThanOrEqual(narrowNormal.footer.top + 1);
  expect(narrowNormal.actions.top).toBeGreaterThanOrEqual(narrowNormal.copy.bottom - 1);
  expect(narrowNormal.close.right).toBeGreaterThanOrEqual(narrowNormal.notice.right - 16);
  expect(narrowNormal.close.top).toBeGreaterThanOrEqual(narrowNormal.notice.top - 1);
  expect(narrowNormal.close.bottom).toBeLessThanOrEqual(narrowNormal.notice.top + 42);
  await showRetry();
  const narrowDynamic = await measure();
  expect(narrowDynamic.footer.height).toBeGreaterThan(narrowNormal.footer.height);
  expect(narrowDynamic.notice.bottom).toBeLessThanOrEqual(narrowDynamic.footer.top + 1);
  expect(narrowDynamic.status.bottom).toBeLessThanOrEqual(narrowDynamic.footer.top + 1);
  expect(narrowDynamic.actions.top).toBeGreaterThanOrEqual(narrowDynamic.copy.bottom - 1);
  expect(narrowDynamic.close.right).toBeGreaterThanOrEqual(narrowDynamic.notice.right - 16);
  expect(narrowDynamic.close.top).toBeGreaterThanOrEqual(narrowDynamic.notice.top - 1);
  expect(narrowDynamic.close.bottom).toBeLessThanOrEqual(narrowDynamic.notice.top + 42);
});

test('error reports copy safe details and support file URL fallback', async ({ page }) => {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#apiKey').fill('sk-secret-test-key');
  await page.evaluate(() => {
    window.MAWLauncher.appendLog('child output: duration probe failed');
    window.MAWLauncher.appendLog('Authorization: Bearer secret-bearer-token');
    window.__copiedReports = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => window.__copiedReports.push(text) },
    });
  });
  await page.evaluate(() => {
    const event = { type: 'error', code: 'transcription_failed', detail: 'backend detail' };
    window.MAWLauncher.onBackendEvent(event);
    window.MAWLauncher.onBackendEvent(event);
    window.MAWLauncher.appendLog('[error] unrelated child failure');
    window.MAWLauncher.appendLog('[detail] unrelated child detail');
  });
  await expect(page.locator('#errorNoticeIssue')).toBeVisible();
  await page.locator('#errorNoticeCopy').click();
  await expect(page.locator('#errorNoticeCopy')).toHaveText('已复制');
  const report = (await page.evaluate(() => window.__copiedReports[0]));
  expect(report).toContain('错误码: transcription_failed');
  expect(report).toContain('backend detail');
  expect(report).toContain('child output: duration probe failed');
  expect(report).toContain('[error] unrelated child failure');
  expect(report).toContain('[detail] unrelated child detail');
  expect(report).not.toContain('[error] 转写失败，本次任务已停止。请查看日志后修正问题，再重新尝试。');
  expect(report).not.toContain('secret-bearer-token');
  expect(report.match(/详细信息: backend detail/g)?.length).toBe(1);
  expect(report.match(/\[detail\] backend detail/g)?.length).toBe(2);
  const expectedVersion = await page.locator('#appVersion').evaluate((element) => element.textContent.trim().replace(/^v/u, ''));
  expect(report).toContain(expectedVersion);
  expect(report).not.toContain('sk-secret-test-key');

  await page.evaluate(() => {
    window.__copiedReports = [];
    navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    document.execCommand = () => { window.__fallbackCopyUsed = true; return true; };
  });
  await page.locator('#errorNoticeCopy').click();
  await expect(page.locator('#errorNoticeCopy')).toHaveText('已复制');
  await expect.poll(() => page.evaluate(() => Boolean(window.__fallbackCopyUsed))).toBe(true);

  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    document.execCommand = () => false;
  });
  await page.locator('#errorNoticeCopy').click();
  await expect(page.locator('#errorNoticeCopy')).toHaveText('复制失败，请手动复制日志。');
  await page.locator('#errorNoticeClose').click();
  await expect(page.locator('#errorNotice')).toBeHidden();
  await expect(page.locator('#errorNoticeCopy')).toHaveText('复制错误报告');
});

test('unknown errors stay generic and do not expose FFmpeg actions', async ({ page }) => {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({
    type: 'error', code: 'unknown_backend_failure', detail: 'service exploded',
  }));
  await expect(page.locator('#errorNotice')).toBeVisible();
  await expect(page.locator('#errorNoticeMessage')).toContainText('service exploded');
  await expect(page.locator('#errorNoticeAction')).toBeHidden();
  await expect(page.locator('#errorNoticeFaq')).toBeVisible();
  await expect(page.locator('#errorNoticeFaq')).toHaveText('查看常见问题');
  await expect(page.locator('#errorNoticeCopy')).toHaveText('复制错误报告');
  await expect(page.locator('#errorNoticeIssue')).toHaveText('打开项目主页');
  await expect(page.locator('#errorNoticeIssue')).toBeVisible();
  await page.evaluate(() => {
    const original = window.MAWLauncher.callBackend;
    window.__issueCalls = [];
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'open_url') window.__issueCalls.push({ method, payload });
      return original(method, payload);
    };
  });
  await page.locator('#errorNoticeIssue').click();
  await expect.poll(() => page.evaluate(() => window.__issueCalls[0])).toEqual({
    method: 'open_url', payload: { url: 'https://github.com/Moyf/moys-asr-workflow' },
  });
});

test('error reports keep one structured hint when detail matches the hint', async ({ page }) => {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.evaluate(() => {
    window.__copiedReports = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => window.__copiedReports.push(text) },
    });
    window.MAWLauncher.onBackendEvent({
      type: 'error', code: 'unknown_backend_failure', detail: 'same\nmessage',
    });
  });
  await expect(page.locator('#errorNotice')).toBeVisible();
  await expect(page.locator('#status')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('same message');
  await page.locator('#errorNoticeCopy').click();
  await expect(page.locator('#errorNoticeCopy')).toHaveText('已复制');
  const report = await page.evaluate(() => window.__copiedReports[0]);
  expect(report.match(/提示: same message/g)?.length).toBe(1);
  expect(report).not.toContain('详细信息: same message');
  expect(report).toContain('[detail] same\nmessage');
  await page.locator('#errorNoticeClose').click();
  await expect(page.locator('#status')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('same message');
});

test('FAQ open failures remain visible without an unhandled rejection', async ({ page }) => {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.evaluate(() => {
    window.MAWLauncher.callBackend = async (method) => method === 'open_faq' ? { ok: false, error: 'FAQ unavailable' } : { ok: true };
    window.MAWLauncher.onBackendEvent({ type: 'error', code: 'transcription_failed', detail: 'failed' });
  });
  await page.locator('#errorNoticeFaq').click();
  await expect(page.locator('#status')).toBeVisible();
  await expect(page.locator('#status')).toContainText('FAQ unavailable');
  await expect(page.locator('#log')).toContainText('open_faq: FAQ unavailable');
  await page.evaluate(() => {
    window.MAWLauncher.callBackend = async (method) => method === 'open_url' ? { ok: false, error: 'Issue page unavailable' } : { ok: true };
    window.MAWLauncher.onBackendEvent({ type: 'error', code: 'unknown_backend_failure', detail: 'unknown failure' });
  });
  await page.locator('#errorNoticeIssue').click();
  await expect(page.locator('#status')).toBeVisible();
  await expect(page.locator('#status')).toContainText('Issue page unavailable');
  await expect(page.locator('#log')).toContainText('open_issue: Issue page unavailable');
});

test('artifact rows localize type labels while preserving MOSP-first and SRT-only selection', async ({ page }) => {
  await openLauncher(page);
  await runReplacement(page);

  const artifacts = page.locator('.toolbox-chain-file');
  await expect(artifacts).toHaveCount(2);
  await expect(artifacts.nth(0)).toHaveText('MOSP 工程');
  await expect(artifacts.nth(1)).toHaveText('SRT 字幕');
  await expect(artifacts.nth(0)).toHaveClass(/selected/);
  await expect(page.locator('#toolboxInputPath')).toHaveValue('D:\\Demo\\source.fixed.mosp');
  await expect(artifacts.nth(0)).toHaveAttribute('title', 'source.fixed.mosp\nD:\\Demo\\source.fixed.mosp');
  await expect(artifacts.nth(0)).toHaveAttribute('aria-label', /MOSP 工程.*source\.fixed\.mosp.*D:\\Demo\\source\.fixed\.mosp/);

  await page.locator('#langToggle').click();
  await expect(artifacts.nth(0)).toHaveText('MOSP project');
  await expect(artifacts.nth(1)).toHaveText('SRT subtitles');

  await artifacts.nth(1).click();
  await expect(page.locator('#toolboxInputPath')).toHaveValue('D:\\Demo\\clip.fixed.srt');
  await expect(page.locator('#jsonPath')).toHaveValue('D:\\Demo\\source.fixed.mosp');
  await expect(page.locator('#srtPath')).toHaveValue('D:\\Demo\\clip.fixed.srt');

  await runReplacement(page, { outputMode: 'srt' });
  const srtOnly = page.locator('.toolbox-chain-item').nth(1).locator('.toolbox-chain-file');
  await expect(srtOnly).toHaveCount(1);
  await expect(srtOnly).toHaveText('SRT subtitles');
  await expect(srtOnly).toHaveClass(/selected/);
  await expect(page.locator('#toolboxInputPath')).toHaveValue('D:\\Demo\\clip.fixed.srt');
});

test('server media accepts a dropped file even when batch mode is selected', async ({ page }) => {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#jsonPath').fill('D:\\Demo\\missing-media.mosp');
  await page.locator('#serverMediaField').evaluate((element) => element.classList.remove('hidden'));
  await page.locator('#batchMode').click();

  await page.locator('#serverMediaPath').evaluate((input) => {
    const dataTransfer = { types: ['Files'], files: [{ path: 'D:\\Demo\\clip.mp4' }] };
    const dragEnter = new Event('dragenter', { bubbles: true, cancelable: true });
    Object.defineProperty(dragEnter, 'dataTransfer', { value: dataTransfer });
    input.dispatchEvent(dragEnter);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
    input.dispatchEvent(drop);
  });

  await expect(page.locator('#serverMediaPath')).toHaveValue('D:\\Demo\\clip.mp4');
  await expect(page.locator('#serverMediaPath')).not.toHaveClass(/drag-over/);
  await expect(page.locator('.batch-row')).toHaveCount(0);
});

test('artifact context menu exposes exactly three actions and closes on every required path', async ({ page }) => {
  await openLauncher(page);
  await runReplacement(page);
  await page.locator('#langToggle').click();
  await page.evaluate(() => {
    window.__artifactCalls = [];
    const callBackend = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (['open_file', 'open_containing_folder'].includes(method)) {
        window.__artifactCalls.push({ method, payload });
        return { ok: true };
      }
      return callBackend(method, payload);
    };
  });

  const project = page.locator('.toolbox-chain-file').nth(0);
  const srt = page.locator('.toolbox-chain-file').nth(1);
  await srt.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Artifact actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(3);
  await expect(menu.getByRole('menuitem').nth(0)).toBeFocused();
  await menu.getByRole('menuitem', { name: 'Set as processing target' }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#toolboxInputPath')).toHaveValue('D:\\Demo\\clip.fixed.srt');

  await srt.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Open containing folder' }).click();
  await srt.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Open file', exact: true }).click();
  expect(await page.evaluate(() => window.__artifactCalls)).toEqual([
    { method: 'open_containing_folder', payload: { path: 'D:\\Demo\\clip.fixed.srt' } },
    { method: 'open_file', payload: { path: 'D:\\Demo\\clip.fixed.srt' } },
  ]);

  await srt.click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(srt).toBeFocused();

  await srt.click({ button: 'right' });
  await page.locator('#toolboxTitle').click();
  await expect(menu).toBeHidden();

  await srt.click({ button: 'right' });
  await project.click({ button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(1);
  await expect(menu).toBeVisible();

  const nativeContext = await page.locator('#toolboxTitle').evaluate((element) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(nativeContext).toBe(false);
});

test('artifact context menu remains inside the viewport and reports failed bridge actions', async ({ page }) => {
  await openLauncher(page);
  await runReplacement(page);
  await page.locator('#langToggle').click();
  await page.evaluate(() => {
    window.MAWLauncher.callBackend = async (method) => (
      method === 'open_file' ? { ok: false, error: 'File does not exist' } : { ok: true }
    );
  });

  const artifact = page.locator('.toolbox-chain-file').nth(0);
  await artifact.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: window.innerWidth - 1,
      clientY: window.innerHeight - 1,
    }));
  });
  const menu = page.getByRole('menu', { name: 'Artifact actions' });
  const bounds = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);

  await menu.getByRole('menuitem', { name: 'Open file', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#toolboxResult')).toContainText('File does not exist');
  await expect(artifact).toHaveClass(/selected/);
});

test('artifact context menu restores artifact focus after each action closes it', async ({ page }) => {
  // Given: a generated artifact with successful native artifact actions.
  await openLauncher(page);
  await runReplacement(page);
  await page.evaluate(() => {
    const callBackend = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => (
      ['open_file', 'open_containing_folder'].includes(method)
        ? { ok: true }
        : callBackend(method, payload)
    );
  });

  const artifact = page.locator('.toolbox-chain-file').nth(1);
  const menu = page.getByRole('menu');
  for (const action of ['设为处理目标', '打开所在文件夹', '打开文件']) {
    // When: an artifact menu action closes the menu.
    await artifact.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: action, exact: true }).click();

    // Then: focus returns to the originating artifact, never the hidden menu.
    await expect(menu).toBeHidden();
    await expect(artifact).toBeFocused();
  }
});

test('Escape closes an artifact context menu while postprocess is busy', async ({ page }) => {
  // Given: an open artifact menu while a postprocess request remains pending.
  await openLauncher(page);
  await runReplacement(page);
  await page.evaluate(() => {
    const callBackend = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = (method, payload) => (
      method === 'run_fixed_process'
        ? new Promise(() => {})
        : callBackend(method, payload)
    );
  });
  const artifact = page.locator('.toolbox-chain-file').nth(0);
  const menu = page.getByRole('menu');
  await page.locator('#runFixedProcess').click();
  await expect(page.locator('#toolboxProgress')).toBeVisible();
  await artifact.click({ button: 'right' });
  await expect(menu).toBeVisible();

  // When: Escape is pressed while the busy guard is active.
  const escapeConsumed = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });

  // Then: Escape is consumed, the menu closes, and focus returns to the artifact.
  expect(escapeConsumed).toBe(true);
  await expect(menu).toBeHidden();
  await expect(artifact).toBeFocused();
});

test('batch mode disables manuscript matching without changing its saved single-file choice', async ({ page }) => {
  // Given: manuscript matching is configured and selected for single-file transcription.
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#autoPostprocessEnabled').check();
  await page.evaluate(() => {
    const field = document.getElementById('postprocessScriptPath');
    field.value = 'D:\\Demo\\script.txt';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const match = page.locator('#autoStepMatch');
  await match.check();
  await expect(match).toBeChecked();
  await expect(page.locator('#toolboxDrawer')).toBeHidden();
  await page.evaluate(() => {
    window.__savedPlans = [];
    const callBackend = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'save_postprocess_plan') window.__savedPlans.push(JSON.parse(JSON.stringify(payload.plan)));
      return callBackend(method, payload);
    };
  });

  // When: batch mode is selected and another setting is edited (which persists the plan).
  await page.locator('#batchMode').click();

  // Then: matching is visibly unavailable but the user's selection is preserved.
  await expect(match).toBeChecked();
  await expect(match).toBeDisabled();
  await expect(page.locator('[data-auto-step-row="match"]')).toHaveClass(/batch-unavailable/);
  await expect(page.locator('#batchManuscriptNotice')).toBeVisible();
  await expect(page.locator('#batchManuscriptNotice')).toHaveAttribute('role', 'note');
  await page.evaluate(() => {
    const field = document.getElementById('postprocessReplacements');
    field.value = 'old => new';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => (window.__savedPlans || []).length > 0);
  const plans = await page.evaluate(() => window.__savedPlans);
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) {
    expect(plan.steps.find((step) => step.id === 'match').enabled).toBe(true);
  }

  // When: single-file mode is restored.
  await page.locator('#singleMode').click();

  // Then: the saved single-file choice is untouched.
  await expect(match).toBeChecked();
  await expect(match).toBeEnabled();
});

test('batch start delegates output allocation and batchDone reconciles every terminal outcome', async ({ page }) => {
  // Given: three queued files and a bridge spy that leaves allocation to the batch backend.
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#batchMode').click();
  await page.evaluate(() => {
    window.__batchCalls = [];
    window.MAWLauncher.callBackend = async (method, payload) => {
      window.__batchCalls.push({ method, payload });
      return { ok: true };
    };
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [{ path: 'D:\\Demo\\first.mp3' }, { path: 'D:\\Demo\\second.mp3' }, { path: 'D:\\Demo\\third.mp3' }] },
    });
    document.getElementById('mediaCard').dispatchEvent(drop);
  });

  // When: the run starts and the backend reports one completed and one cancelled item.
  await page.locator('#startBatch').click();
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({
    type: 'batch_done',
    status: 'cancelled',
    outcomes: [
      { id: 'batch-1', status: 'done', result: { srt_path: 'D:\\Demo\\first.srt', json_path: 'D:\\Demo\\first.mosp' } },
      { id: 'batch-2', status: 'cancelled', error: 'Cancelled before start' },
    ],
  }));

  // Then: no preallocation call occurred and the single-file paths stay out of the shared settings.
  const calls = await page.evaluate(() => window.__batchCalls);
  expect(calls.map(({ method }) => method)).toEqual(['start_batch_transcription']);
  expect(calls[0].payload.items).toEqual([
    { id: 'batch-1', mediaPath: 'D:\\Demo\\first.mp3' },
    { id: 'batch-2', mediaPath: 'D:\\Demo\\second.mp3' },
    { id: 'batch-3', mediaPath: 'D:\\Demo\\third.mp3' },
  ]);
  expect(calls[0].payload.settings.mediaPath).toBeUndefined();
  expect(calls[0].payload.settings.srtPath).toBeUndefined();
  expect(calls[0].payload.settings.providerId).toBeTruthy();

  // Then: every row reaches a terminal state, including the unreported cancelled leftover.
  const rows = page.locator('.batch-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveClass(/done/);
  await expect(rows.nth(1)).toHaveClass(/cancelled/);
  await expect(rows.nth(2)).toHaveClass(/cancelled/);
  await expect(rows.nth(2).locator('.batch-status')).toHaveText('已取消');
  await expect(page.locator('.batch-row.queued')).toHaveCount(0);
  await expect(rows.nth(0).getByRole('button', { name: '打开工程' })).toBeVisible();
  await expect(rows.nth(0).getByRole('button', { name: '打开文件夹' })).toBeVisible();
});

test('batchDone fails rows that never reported when the batch was not cancelled', async ({ page }) => {
  // Given: two queued files started in batch mode.
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#batchMode').click();
  await page.evaluate(() => {
    window.MAWLauncher.callBackend = async () => ({ ok: true });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [{ path: 'D:\\Demo\\first.mp3' }, { path: 'D:\\Demo\\second.mp3' }] },
    });
    document.getElementById('mediaCard').dispatchEvent(drop);
  });

  // When: the batch finishes normally but only one item ever reported an outcome.
  await page.locator('#startBatch').click();
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({
    type: 'batchDone',
    status: 'done',
    outcomes: [{ id: 'batch-1', status: 'done', srtPath: 'D:\\Demo\\first.srt', jsonPath: 'D:\\Demo\\first.mosp' }],
  }));

  // Then: the unreported row cannot remain queued and explains its failure.
  const rows = page.locator('.batch-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveClass(/done/);
  await expect(rows.nth(1)).toHaveClass(/failed/);
  await expect(rows.nth(1).locator('.batch-status')).toHaveText('失败');
  await expect(rows.nth(1).locator('.batch-details')).toContainText('批量结束时未收到该文件的结果');
  await expect(page.locator('.batch-row.queued')).toHaveCount(0);
});

test('artifact context menu opens at the viewport pointer after Launcher zoom', async ({ page }) => {
  // Given: generated artifacts and Launcher CSS zoom at 125%.
  await openLauncher(page);
  await runReplacement(page);
  await page.evaluate(() => {
    document.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -100,
    }));
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('105%');
  for (let index = 0; index < 4; index += 1) {
    await page.evaluate(() => {
      document.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -100,
      }));
    });
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('125%');

  // When: the artifact context menu is opened at a known viewport point.
  const pointer = { x: 420, y: 260 };
  await page.locator('.toolbox-chain-file').first().evaluate((element, point) => {
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
    }));
  }, pointer);

  // Then: the rendered menu rect starts at the event client point within pixel tolerance.
  const bounds = await page.getByRole('menu').boundingBox();
  expect(Math.abs(bounds.x - pointer.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(bounds.y - pointer.y)).toBeLessThanOrEqual(2);
});

test('toolbox resize preserves the other axis and converts pointer deltas through CSS zoom', async ({ page }) => {
  // Given: an open toolbox at 125% zoom with a stable explicit size.
  await openLauncher(page);
  await page.evaluate(() => {
    for (let index = 0; index < 5; index += 1) {
      document.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -100,
      }));
    }
    const drawer = document.getElementById('toolboxDrawer');
    drawer.style.width = '480px';
    drawer.style.blockSize = '400px';
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('125%');
  const before = await page.locator('#toolboxDrawer').evaluate((element) => ({
    cssWidth: Number.parseFloat(getComputedStyle(element).width),
    cssHeight: Number.parseFloat(getComputedStyle(element).height),
  }));

  // When: height grows by 50 viewport pixels, then width grows by 50 viewport pixels.
  const heightHandle = page.locator('#toolboxResizeY');
  const heightBox = await heightHandle.boundingBox();
  await page.mouse.move(heightBox.x + heightBox.width / 2, heightBox.y + heightBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(heightBox.x + heightBox.width / 2, heightBox.y + heightBox.height / 2 - 50);
  await page.mouse.up();
  const afterHeight = await page.locator('#toolboxDrawer').evaluate((element) => ({
    cssWidth: Number.parseFloat(getComputedStyle(element).width),
    cssHeight: Number.parseFloat(getComputedStyle(element).height),
  }));

  const widthHandle = page.locator('#toolboxResizeX');
  const widthBox = await widthHandle.boundingBox();
  await page.mouse.move(widthBox.x + widthBox.width / 2, widthBox.y + widthBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(widthBox.x + widthBox.width / 2 - 50, widthBox.y + widthBox.height / 2);
  await page.mouse.up();
  const afterWidth = await page.locator('#toolboxDrawer').evaluate((element) => ({
    cssWidth: Number.parseFloat(getComputedStyle(element).width),
    cssHeight: Number.parseFloat(getComputedStyle(element).height),
  }));

  // Then: 50 viewport pixels become 40 CSS pixels and each drag leaves its other axis unchanged.
  expect(afterHeight.cssWidth).toBeCloseTo(before.cssWidth, 0);
  expect(afterHeight.cssHeight - before.cssHeight).toBeCloseTo(40, 0);
  expect(afterWidth.cssWidth - afterHeight.cssWidth).toBeCloseTo(40, 0);
  expect(afterWidth.cssHeight).toBeCloseTo(afterHeight.cssHeight, 0);
});
