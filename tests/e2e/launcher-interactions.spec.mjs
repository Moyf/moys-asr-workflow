import { completeStaticLauncherDiscovery } from './launcher-ready.mjs';
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/launcher/index.html');

async function gotoLauncher(page, { reload = false, realTimeStartup = false } = {}) {
  if (reload) await page.reload();
  else await page.goto(`file://${launcherPath}`);
  if (!realTimeStartup) {
    // Complete absent-host discovery through the real listener; keep native clocks.
    await completeStaticLauncherDiscovery(page);
  }
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
}

async function openLauncher(page, options) {
  await gotoLauncher(page, options);
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

test('alignment model shortcut opens the selected model without changing the ASR provider', async ({ page }, testInfo) => {
  await openLauncher(page);
  await page.locator('#provider').selectOption('qwen');
  await page.locator('#toolboxTimestampsTab').click();
  const provider = await page.locator('#provider').inputValue();
  const asrModel = await page.locator('#model').inputValue();
  const modelId = await page.evaluate(() => window.MAWLauncher.config.alignmentModels.at(-1).id);
  await page.locator('#toolboxTimestampModel').selectOption(modelId);
  const hint = page.locator('#toolboxAlignmentModelHint');
  const gap = await hint.evaluate((element) => ({
    above: element.getBoundingClientRect().top - element.previousElementSibling.getBoundingClientRect().bottom,
    row: parseFloat(getComputedStyle(element).rowGap),
  }));
  expect(gap.above).toBeGreaterThanOrEqual(8);
  expect(gap.row).toBeGreaterThanOrEqual(8);
  console.log(`Alignment settings spacing: above=${gap.above}px, wrapped rows=${gap.row}px`);
  await testInfo.attach('alignment-link-spacing', { body: JSON.stringify(gap), contentType: 'application/json' });
  await hint.locator('..').screenshot({ path: testInfo.outputPath('alignment-model-shortcut.png') });

  const shortcut = page.locator('#openAlignmentModelSettings');
  await expect(shortcut).toHaveText('管理对齐模型');
  await page.evaluate(() => document.getElementById('langEn').click());
  await expect(shortcut).toHaveText('Manage alignment models');
  await shortcut.click();
  await expect(page.locator('#settingsLlmTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#alignmentModelSettingsSection')).toBeVisible();
  await expect(page.locator(`#localAlignmentModelList [data-model-id="${modelId}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#provider')).toHaveValue(provider);
  await page.locator('#alignmentModelSettingsSection').screenshot({ path: testInfo.outputPath('alignment-model-settings.png') });

  // Complete setup through the real UI flow while retaining cloud ASR settings.
  await expect(page.locator('#prepareAlignmentModel')).toBeDisabled();
  await expect(page.locator('#localAlignmentModelStatus')).toContainText('Missing dependencies');
  await page.locator('#localAlignmentModelStatus button').click();
  await expect(page.locator('#localRuntimePanel')).toBeVisible();
  await expect(page.locator('#settingsRuntimeTab')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#refreshLocalRuntime').click();
  await expect(page.locator('#localRuntimeStatus')).toHaveText('Local runtime is not installed');
  await page.locator('#localRuntimePanel').screenshot({ path: testInfo.outputPath('cloud-asr-runtime-setup.png') });
  await page.locator('#installLocalRuntime').click();
  await expect(page.locator('#localRuntimeStatus')).toHaveText('Local runtime is ready');
  await expect(page.locator('#localRuntimeProgress')).toBeHidden();
  await expect(page.locator('#provider')).toHaveValue(provider);
  await expect(page.locator('#model')).toHaveValue(asrModel);
  await page.locator('#settingsClose').click();
  await shortcut.click();
  await expect(page.locator('#prepareAlignmentModel')).toBeEnabled();
  const selectedModel = page.locator(`#localAlignmentModelList [data-model-id="${modelId}"]`);
  await expect(selectedModel).not.toHaveClass(/\bready\b/);
  await page.locator('#prepareAlignmentModel').click();
  await expect(selectedModel).toHaveClass(/\bready\b/);
  await expect(page.locator('#provider')).toHaveValue(provider);
  await expect(page.locator('#model')).toHaveValue(asrModel);
});

test('cloud ASR runtime installation errors leave the installing state', async ({ page }) => {
  await openLauncher(page);
  const config = await page.evaluate(() => window.MAWLauncher.config);
  await page.addInitScript((initialConfig) => {
    initialConfig.providerId = 'qwen';
    window.__runtimeBackend = { status: 'installing', ready: false };
    initialConfig.localRuntime = { ...window.__runtimeBackend };
    window.__runtimeRequests = [];
    window.pywebview = { api: new Proxy({}, { get: (_target, method) => method === 'then' ? undefined : async (payload) => {
      if (method === 'get_config') return initialConfig;
      if (method === 'get_local_runtime') {
        window.__runtimeRequests.push(payload);
        return { ok: true, ...window.__runtimeBackend };
      }
      if (method === 'get_alignment_models') return { ok: true, models: initialConfig.alignmentModels };
      return { ok: true };
    } }) };
  }, config);
  await page.reload();
  await page.waitForFunction(() => document.body.classList.contains('launcher-ready'));
  await page.evaluate(() => window.MAWLauncher.openSettings('localRuntimePanel'));
  for (const code of ['local_runtime_install_failed', 'local_runtime_cancelled']) {
    await page.evaluate((errorCode) => {
      window.MAWLauncher.config.localRuntime = { status: 'installing', ready: false };
      window.MAWLauncher.onBackendEvent({ type: 'localRuntimeProgress', percent: 30 });
      window.__runtimeBackend = { status: 'broken', ready: false };
      window.MAWLauncher.onBackendEvent({ type: 'error', code: errorCode, detail: 'test runtime failure' });
    }, code);
    await expect(page.locator('#localRuntimeStatus')).toHaveText('本地运行环境需要修复');
    await expect(page.locator('#localRuntimeProgress')).toBeHidden();
    await expect(page.locator('#installLocalRuntime')).toHaveText('修复运行环境');
    await expect(page.locator('#installLocalRuntime')).toBeEnabled();
    await expect(page.locator('#provider')).toHaveValue('qwen');
  }
  const requests = await page.evaluate(() => window.__runtimeRequests);
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(requests.every((payload) => payload.modelId === '')).toBe(true);
});

test('runtime upgrade and alignment model states distinguish files, validation, and dependencies', async ({ page }, testInfo) => {
  await openLauncher(page);
  await page.evaluate(() => {
    const names = ['faster_whisper', 'funasr', 'qwen_asr', 'jieba', 'torch', 'torchaudio', 'quapeaks', 'sherpa_onnx', 'soundfile'];
    window.MAWLauncher.config.localRuntime = {
      status: 'broken',
      ready: false,
      runtimeVersion: '6',
      path: 'D:\\Demo\\local-runtime',
      modelCachePath: 'D:\\Demo\\model-cache',
      inventory: {
        status: 'broken',
        ready: false,
        runtimeVersionExpected: '7',
        runtimeVersionInstalled: '6',
        pythonVersionExpected: '3.11',
        pythonVersionInstalled: '3.11',
        manifestStatus: 'ready',
        installedAt: 0,
        components: names.map((name) => ({ name, required: true, installed: true })),
      },
    };
  });
  await page.locator('#provider').selectOption('local');
  await page.locator('#settingsButton').click();
  await page.locator('#settingsRuntimeTab').click();

  await expect(page.locator('#localRuntimeStatus')).toContainText('运行环境需要升级：6 → 7');
  await expect(page.locator('#localRuntimeHint')).toHaveText('已检测到依赖文件：9/9，尚未完成新版环境验证。');
  await expect(page.locator('#installLocalRuntime')).toHaveText('升级并验证运行环境');
  await page.locator('#toggleLocalRuntimeInventory').click();
  await expect(page.locator('#localRuntimeInventory')).toContainText('需要升级：6 → 7');
  await expect(page.locator('#localRuntimeInventory')).toContainText('依赖组件 (9/9)');
  const runtimeGap = await page.locator('.repair-row').evaluate((row) => {
    const hint = row.querySelector('#localRuntimeHint').getBoundingClientRect();
    const button = row.querySelector('#installLocalRuntime').getBoundingClientRect();
    const style = getComputedStyle(row);
    return { vertical: button.top >= hint.bottom ? button.top - hint.bottom : 0, rowGap: parseFloat(style.rowGap) };
  });
  expect(runtimeGap.rowGap).toBeGreaterThanOrEqual(8);
  if (runtimeGap.vertical > 0) expect(runtimeGap.vertical).toBeGreaterThanOrEqual(8);
  console.log(`Runtime upgrade layout spacing: vertical=${runtimeGap.vertical}px, wrapped row gap=${runtimeGap.rowGap}px`);
  await testInfo.attach('runtime-upgrade-spacing', { body: JSON.stringify(runtimeGap), contentType: 'application/json' });
  await page.locator('#localRuntimePanel').screenshot({ path: testInfo.outputPath('runtime-upgrade-status.png') });

  await page.evaluate(() => {
    const inventory = window.MAWLauncher.config.localRuntime.inventory;
    inventory.components = inventory.components.map((component) => component.name === 'qwen_asr' ? { ...component, installed: false } : component);
  });
  await page.locator('#refreshLocalRuntime').click();
  await expect(page.locator('#localRuntimeHint')).toHaveText('已检测到依赖文件：8/9，升级时会补齐缺失文件并验证新版环境。');
  await page.evaluate(() => window.MAWLauncher.openSettings('alignmentModelSettingsSection'));
  const aligner = page.locator('#localAlignmentModelList [data-model-id="qwen3-forced-aligner-0.6b"]');
  await expect(aligner).toContainText('未下载 · 缺少依赖');
  await expect(page.locator('#localAlignmentModelStatus')).toContainText('未下载 · 缺少依赖');
  const recognitionModel = await page.evaluate(() => window.MAWLauncher.config.providers
    .find((item) => item.id === 'local').models.find((model) => !model.supportsWordTimestamps).id);
  await page.locator('#settingsClose').click();
  await page.locator('#model').selectOption(recognitionModel);
  await page.evaluate(() => {
    const select = document.getElementById('recognitionAlignmentModel');
    select.value = 'qwen3-forced-aligner-0.6b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#recognitionAlignmentModelStatus')).toContainText('未下载 · 缺少依赖');
  await expect(page.locator('#recognitionAlignmentModelStatus button')).toHaveText('本地运行环境');
  await page.evaluate(() => window.MAWLauncher.openSettings('alignmentModelSettingsSection'));
  await page.locator('#alignmentModelSettingsSection').screenshot({ path: testInfo.outputPath('alignment-model-dependency-status.png') });
});

test('OpenAI ASR exposes official and OpenRouter models with a conditional Custom input', async ({ page }) => {
  await openLauncher(page);
  await page.locator('#provider').selectOption('openai');

  await expect(page.locator('#provider option[value="openai"]')).toHaveText('OpenAI 格式通用接口');
  await expect(page.locator('#model')).toHaveValue('whisper-1');
  await expect(page.locator('#model option')).toHaveCount(8);
  expect(await page.locator('#model option').allTextContents()).toEqual([
    'whisper-1',
    'gpt-4o-transcribe',
    'gpt-4o-mini-transcribe',
    'gpt-transcribe（支持关键词）',
    'gpt-4o-transcribe-diarize（说话人分离）',
    'whisper-large-v3-turbo（OpenRouter）',
    'whisper-large-v3（OpenRouter）',
    '自定义（Custom）',
  ]);
  await expect(page.locator('#openaiModelField')).toBeHidden();
  await expect(page.locator('#openKeyUrl')).toHaveText('OpenAI 官方');
  await expect(page.locator('#openKeyHintOr')).toHaveText(' 或 ');
  await expect(page.locator('#openRouterKeyUrl')).toHaveText('OpenRouter');
  await expect(page.locator('#keyHintSuffix')).toHaveText('获取 API Key');

  await page.locator('#openaiBaseUrl').fill('https://openrouter.ai/api/v1');
  await expect(page.locator('#modelNote')).toContainText('OpenRouter 参考价');
  await page.locator('#openaiBaseUrl').fill('https://api.openai.com/v1');
  await expect(page.locator('#modelNote')).not.toContainText('OpenRouter 参考价');
  await expect(page.locator('#modelNote')).toContainText('OpenAI 官方参考价');
  await page.locator('#openaiBaseUrl').fill('https://relay.example/v1');
  await expect(page.locator('#modelNote')).not.toContainText('参考价');

  await page.locator('#openaiBaseUrl').fill('https://api.openai.com/v1');
  await page.locator('#model').selectOption('gpt-transcribe');
  await page.locator('#advancedToggle').click();
  await expect(page.locator('#openaiAdvancedOptions')).toBeVisible();
  await expect(page.locator('#openaiPromptField')).toBeVisible();
  await expect(page.locator('#openaiKeywordsField')).toBeVisible();
  await expect(page.locator('#openaiDiarizationField')).toBeHidden();

  await page.locator('#model').selectOption('gpt-4o-transcribe-diarize');
  await expect(page.locator('#openaiPromptField')).toBeHidden();
  await expect(page.locator('#openaiKeywordsField')).toBeHidden();
  await expect(page.locator('#openaiDiarizationField')).toBeVisible();
  await expect(page.locator('#openaiDiarizationUnsupported')).toBeHidden();
  await page.locator('#openaiBaseUrl').fill('https://openrouter.ai/api/v1');
  await expect(page.locator('#openaiDiarizationUnsupported')).toBeVisible();

  await page.locator('#model').selectOption('custom-asr');
  await expect(page.locator('#openaiModelField')).toBeVisible();
  await expect(page.locator('label[for="openaiModel"]')).toHaveText('自定义 ASR 模型名');
  await page.locator('#openaiModel').fill('my-custom-model');
  await page.locator('#model').selectOption('gpt-4o-mini-transcribe');
  await expect(page.locator('#openaiModelField')).toBeHidden();
  await page.locator('#model').selectOption('custom-asr');
  await expect(page.locator('#openaiModel')).toHaveValue('my-custom-model');
});

test('cloud ASR models show provider-specific price hints', async ({ page }) => {
  // Retain the native 1800ms fallback journey.
  await openLauncher(page, { realTimeStartup: true });

  // A host arriving after fallback must not replace the settled bridge.
  const lateReady = await page.evaluate(async () => {
    const config = window.MAWLauncher.config;
    window.__lateHostCalls = 0;
    window.pywebview = { api: { get_config: async () => {
      window.__lateHostCalls += 1;
      return { lateHost: true };
    } } };
    window.dispatchEvent(new Event('pywebviewready'));
    const result = await window.MAWLauncher.callBackend('get_config');
    return { calls: window.__lateHostCalls, sameConfig: config === window.MAWLauncher.config,
      lateHost: Boolean(result.lateHost) };
  });
  expect(lateReady).toEqual({ calls: 0, sameConfig: true, lateHost: false });

  await page.locator('#provider').selectOption('qwen');
  await expect(page.locator('#modelNote')).toContainText('阿里云百炼参考价');

  await page.locator('#provider').selectOption('soniox');
  await expect(page.locator('#modelNote')).toContainText('Soniox 参考价');

  await page.locator('#provider').selectOption('openai');
  await expect(page.locator('#modelNote')).toContainText('OpenAI 官方参考价');
});

test('project and tutorial hero links open their configured URLs', async ({ page }) => {
  await gotoLauncher(page);
  await page.evaluate(() => {
    window.__openedUrls = [];
    window.open = (url) => {
      window.__openedUrls.push(String(url));
      return null;
    };
  });

  await page.locator('#homeLink').click();
  await page.locator('#tutorialVideoLink').click();

  await expect.poll(() => page.evaluate(() => window.__openedUrls)).toEqual([
    'https://github.com/Moyf/moys-asr-workflow',
    'https://www.bilibili.com/video/BV1S9bZ6pEHg',
  ]);
});

test('support link opens the sponsor QR modal and closes on Escape or backdrop', async ({ page }) => {
  await gotoLauncher(page);

  await page.locator('#supportLink').click();
  await expect(page.locator('#supportModal')).toBeVisible();
  await expect(page.locator('#supportModal .support-qr')).toHaveAttribute('src', /support-qr\.png$/);
  await expect(page.locator('#supportModal .support-desc')).toContainText('前往B站小店赞助');
  await expect(page.locator('#supportModal .support-note')).toHaveText([
    '软件免费使用，但我为此花了非常多的心血 ❤️',
    '你的支持将帮助 Moy 把它做得更好  :)',
  ]);

  await page.keyboard.press('Escape');
  await expect(page.locator('#supportModal')).toBeHidden();

  await page.locator('#supportLink').click();
  await expect(page.locator('#supportModal')).toBeVisible();
  await page.locator('#supportBackdrop').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('#supportModal')).toBeHidden();
});

test('OCR video source follows a newly dropped video media', async ({ page }) => {
  await openLauncher(page);
  await page.locator('#toolboxOcrTab').click();
  await page.locator('#ocrVideoPath').fill('D:\\Demo\\1.mov');
  await page.evaluate(() => {
    const jsonPath = document.getElementById('jsonPath');
    jsonPath.value = 'D:\\Demo\\previous.mosp';
    jsonPath.dispatchEvent(new Event('input', { bubbles: true }));
    window.MAWLauncher.onBackendEvent({ type: 'dropMedia', path: 'D:\\Demo\\new-video.mp4' });
  });

  await expect(page.locator('#mediaPath')).toHaveValue('D:\\Demo\\new-video.mp4');
  await expect(page.locator('#ocrVideoPath')).toHaveValue('D:\\Demo\\new-video.mp4');
  await expect.poll(async () => page.evaluate(() => {
    const step = window.MAWLauncher.config?.postprocessAutoPlan?.steps?.find((item) => item.id === 'ocr');
    return [step?.videoPath || '', step?.videoPathMode || ''];
  })).toEqual(['', 'auto']);
});

test('automatic OCR video source is not persisted as a manual override', async ({ page }) => {
  await openLauncher(page);
  await page.locator('#mediaPath').fill('D:\\Demo\\1.mov');

  const ocrStep = await page.evaluate(() => window.MAWLauncher.getAutoPostprocessPayload()
    .steps.find((step) => step.id === 'ocr'));
  expect(ocrStep.videoPath).toBe('');
  expect(ocrStep.videoPathMode).toBe('auto');

  await page.evaluate(() => {
    window.MAWLauncher.onBackendEvent({ type: 'dropMedia', path: 'D:\\Demo\\2.mov' });
  });
  await expect(page.locator('#ocrVideoPath')).toHaveValue('D:\\Demo\\2.mov');
});

test('automatic subtitle burning follows the selected video', async ({ page }) => {
  await openLauncher(page);
  await page.locator('#mediaPath').fill('D:\\Demo\\clip.mp4');
  await page.locator('#autoPostprocessEnabled').check();
  await expect(page.locator('[data-auto-step-row="burn"]')).toBeVisible();
  await expect(page.locator('[data-auto-step-row="burn"]')).toContainText('烧录字幕');

  await page.locator('#autoStepBurn').check();

  await expect(page.locator('#autoStepBurnStatus')).toHaveClass(/ready/);
  await expect(page.locator('#autoStepBurnHint')).toContainText('clip.mp4');
  await expect(page.locator('#configureAutoBurn')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    window.MAWLauncher.getAutoPostprocessPayload().steps.find((step) => step.id === 'burn')
  ))).toMatchObject({ id: 'burn', enabled: true, videoEncoder: 'auto' });
});

test('waveform tool sends the selected and container-default audio tracks', async ({ page }) => {
  // Given: the toolbox media has two tracks and track 2 is the container default.
  await openLauncher(page);
  await page.locator('#toolboxUtilitiesPrimaryTab').click();
  await page.locator('#toolboxWaveformTab').click();
  await page.evaluate(() => {
    window.__waveformCalls = [];
    window.MAWLauncher.callBackend = async (method, payload) => {
      window.__waveformCalls.push({ method, payload });
      if (method === 'probe_audio_tracks') {
        return {
          ok: true,
          tracks: [
            { audioIndex: 0, title: 'Voice', default: false },
            { audioIndex: 1, title: 'Mix', default: true },
          ],
        };
      }
      if (method === 'generate_waveform_project') {
        return { ok: true, projectPath: 'D:\\Demo\\clip.waveform.mosp', warnings: [] };
      }
      return { ok: true };
    };
    const media = document.getElementById('toolboxUtilityMediaPath');
    media.value = 'D:\\Demo\\clip.mp4';
    media.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#toolboxAudioTrack')).toHaveValue('1');
  await page.locator('#toolboxAudioTrack').selectOption('0');

  // When: a waveform-only project is generated for the non-default track.
  await page.locator('#generateWaveform').click();

  // Then: cache identity carries both the selected track and the real default.
  await expect.poll(() => page.evaluate(() => (
    window.__waveformCalls.find(({ method }) => method === 'generate_waveform_project')?.payload
  ))).toEqual({
    mediaPath: 'D:\\Demo\\clip.mp4',
    audioTrack: 0,
    defaultAudioTrack: 1,
    generateSpectral: false,
  });
});

test('translation merge option follows manual and automatic translation controls', async ({ page }) => {
  await openLauncher(page);
  await page.evaluate(() => document.getElementById('langZh').click());
  await page.locator('#toolboxLlmTab').click();

  const manualOptions = page.locator('#postprocessTranslationOptions');
  await page.locator('#postprocessOperation').selectOption('proofread');
  await expect(manualOptions).toBeHidden();
  await expect(page.locator('#postprocessMergeBilingual')).not.toBeChecked();

  await page.locator('#postprocessOperation').selectOption('translate_en');
  await expect(manualOptions).toBeVisible();
  await expect(page.locator('#postprocessMergeBilingual')).not.toBeChecked();
  await expect(page.locator('#postprocessTranslationOptions [data-i18n="backfill_subtitles_hint"]')).toHaveText('适用于仅有少量语音需要翻译的情况，将翻译后文本直接回填替换。例如7句中文+3句英文，选择「翻译成中文」并启用回填，将得到10句中文字幕。');
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
  await expect(page.locator('#autoTranslateMergeHint')).toBeVisible();
  await expect(page.locator('#autoTranslateBilingualOrder')).toBeHidden();
  await expect(page.locator('#autoTranslateBackfillHint')).toHaveText('只把少量外文语句翻译成目标语言。');

  await page.locator('#autoTranslateMergeBilingual').check();
  await expect(page.locator('#autoTranslateMergeHint')).toBeHidden();
  await expect(page.locator('#autoTranslateBilingualOrder')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const plans = window.__savedPlans || [];
    const latest = plans[plans.length - 1];
    return latest?.steps?.find((step) => step.id === 'translate')?.mergeBilingual;
  })).toBe(true);

  await page.locator('#autoTranslateMergeBilingual').uncheck();
  await expect(page.locator('#autoTranslateMergeHint')).toBeVisible();
  await expect(page.locator('#autoTranslateBilingualOrder')).toBeHidden();

  await page.locator('#autoStepTranslate').uncheck();
  await expect(page.locator('#autoTranslateTargetField')).toBeHidden();
  await expect(page.locator('#autoTranslateMergeField')).toBeHidden();
});

test('translation language filter defaults on, persists, syncs and reaches requests', async ({ page }) => {
  await openLauncher(page);
  await page.evaluate(() => {
    Object.assign(window.MAWLauncher.config.postprocessProviders.find(p => p.id === 'deepseek'),
      { verified: true, hasApiKey: true, hasBaseUrl: true, hasModel: true });
    window.__filterPlans = [];
    window.__filterRequests = [];
    const original = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'save_postprocess_plan') window.__filterPlans.push(payload.plan);
      if (method === 'run_llm_postprocess') {
        window.__filterRequests.push(payload);
        return { ok: false, error: 'test stopped before sending to a model' };
      }
      return original(method, payload);
    };
  });
  await page.locator('#toolboxLlmTab').click();
  await page.locator('#postprocessOperation').selectOption('translate_zh');
  await expect(page.locator('#postprocessSkipTarget')).toBeChecked();
  await page.locator('#postprocessSkipTarget').uncheck();
  await expect(page.locator('#autoTranslateSkipTarget')).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => window.__filterPlans.at(-1)?.steps
    .find(s => s.id === 'translate')?.skipTargetLanguage)).toBe(false);
  await page.locator('#toolboxInputPath').fill('source.mosp');
  await page.locator('#runLlmPostprocess').click();
  await expect.poll(() => page.evaluate(() => window.__filterRequests.at(-1)?.skipTargetLanguage)).toBe(false);
  const manualGap = await page.locator('#postprocessSkipTarget').evaluate(input => {
    const label = input.closest('label');
    return label.nextElementSibling.getBoundingClientRect().top - label.getBoundingClientRect().bottom;
  });
  expect(manualGap).toBeGreaterThanOrEqual(8);
  await page.locator('#postprocessSkipTarget').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.artifacts/translation-filter-manual.png' });
  await page.locator('#toolboxClose').click();
  await page.locator('#autoPostprocessEnabled').check();
  await page.locator('#autoStepTranslate').check();
  await expect(page.locator('#autoTranslateSkipTargetField')).toBeVisible();
  await page.locator('#autoTranslateSkipTarget').check();
  await expect(page.locator('#postprocessSkipTarget')).toBeChecked();
  await expect.poll(() => page.evaluate(() => window.__filterPlans.at(-1)?.steps
    .find(s => s.id === 'translate')?.skipTargetLanguage)).toBe(true);
  const autoGap = await page.locator('#autoTranslateSkipTargetField').evaluate(group => {
    const [label, hint] = group.children;
    return hint.getBoundingClientRect().top - label.getBoundingClientRect().bottom;
  });
  expect(autoGap).toBeGreaterThanOrEqual(8);
  await page.locator('#autoTranslateSkipTargetField').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.artifacts/translation-filter-auto.png' });
  await page.locator('#autoStepTranslate').uncheck();
  await expect(page.locator('#autoTranslateSkipTargetField')).toBeHidden();
});

test('automatic LLM setup highlights test connection until clicked', async ({ page }) => {
  await gotoLauncher(page);
  await page.evaluate(async () => {
    await window.MAWLauncher.callBackend('save_postprocess_settings', { providerId: 'deepseek', apiKey: 'demo-key' });
    const provider = window.MAWLauncher.config.postprocessProviders.find((item) => item.id === 'deepseek');
    Object.assign(provider, {
      verified: false,
      hasApiKey: true,
      hasBaseUrl: true,
      hasModel: true,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
    });
  });

  await page.locator('#autoPostprocessEnabled').check();
  await page.locator('#autoStepTranslate').click();
  await expect(page.locator('#autoStepTranslate')).not.toBeChecked();
  await expect(page.locator('#settingsModal')).toBeVisible();
  await expect(page.locator('#settingsLlmTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#testLlmConnection')).toHaveClass(/attention/);
  await expect.poll(() => page.locator('#testLlmConnection').evaluate((element) => getComputedStyle(element).animationIterationCount)).toBe('infinite');

  await page.evaluate(() => {
    window.MAWLauncher.callBackend = async (method) => (
      method === 'test_postprocess_connection'
        ? { ok: true, saved: true, verified: true, maskedApiKey: 'sk-…mock' }
        : { ok: true }
    );
  });
  await page.locator('#testLlmConnection').click();
  await expect(page.locator('#testLlmConnection')).not.toHaveClass(/attention/);
});

test('verified custom loopback without a key can enable an automatic LLM step', async ({ page }) => {
  await gotoLauncher(page);
  await page.evaluate(() => {
    const item = window.MAWLauncher.config.postprocessProviders.find(item => item.id === 'custom2');
    Object.assign(item, { verified: false, hasApiKey: false, apiKeyRequired: true, hasBaseUrl: false, hasModel: false });
    window.MAWLauncher.callBackend = async method => method === 'test_postprocess_connection'
      ? { ok: true, saved: true, verified: true, apiKeyRequired: false, maskedApiKey: '' }
      : { ok: true };
  });
  // 未填 URL 的 custom2 不在工具箱下拉，需要先在设置页补填。
  await expect(page.locator('#postprocessProvider option[value="custom2"]')).toHaveCount(0);
  await page.locator('#settingsButton').click();
  await page.locator('#settingsLlmTab').click();
  await page.locator('#llmProvider').selectOption('custom2');
  await page.locator('#llmApiKey').fill('');
  await page.locator('#llmBaseUrl').fill('http://127.0.0.1:1234/v1');
  await page.locator('#llmModel').fill('local-model');
  await page.locator('#testLlmConnection').click();
  // 连接成功（已保存 URL）后，工具箱下拉出现该槽位。
  await expect(page.locator('#postprocessProvider option[value="custom2"]')).toHaveCount(1);
  await page.evaluate(() => window.MAWLauncher.closeSettings());
  await page.locator('#autoPostprocessEnabled').check();
  await page.evaluate(() => {
    const select = document.getElementById('postprocessProvider');
    select.value = 'custom2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#autoStepProofread').click();
  await expect(page.locator('#autoStepProofread')).toBeChecked();
  expect(await page.evaluate(() => window.MAWLauncher.config.postprocessProviders.find(item => item.id === 'custom2').hasApiKey)).toBe(false);
});

test('blank LLM form fields use the effective connection and save response', async ({ page }) => {
  await gotoLauncher(page);
  await page.evaluate(() => {
    const item = window.MAWLauncher.config.postprocessProviders.find(item => item.id === 'deepseek');
    Object.assign(item, { verified: false, hasApiKey: true, hasBaseUrl: true, hasModel: true });
    window.llmFallbackCalls = [];
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (['test_postprocess_connection', 'save_postprocess_settings'].includes(method)) {
        window.llmFallbackCalls.push({ method, payload });
        return { ok: true, saved: true, verified: true, apiKeyRequired: true, maskedApiKey: 'sk-…mock', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
      }
      return { ok: true };
    };
  });
  await page.locator('#autoPostprocessEnabled').check();
  await page.locator('#autoStepProofread').click();
  await expect(page.locator('#settingsModal')).toBeVisible();
  await page.locator('#llmBaseUrl').fill('');
  await page.locator('#llmModel').fill('');
  await page.locator('#testLlmConnection').click();
  await expect(page.locator('#autoStepProofread')).toBeChecked();
  await expect(page.locator('#llmBaseUrl')).toHaveValue('https://api.deepseek.com');
  await expect(page.locator('#llmModel')).toHaveValue('deepseek-flash');
  await page.locator('#llmBaseUrl').fill('');
  await page.locator('#llmModel').fill('');
  await page.locator('#saveLlmSettings').click();
  await expect(page.locator('#llmBaseUrl')).toHaveValue('https://api.deepseek.com');
  await expect(page.locator('#llmModel')).toHaveValue('deepseek-flash');
  expect(await page.evaluate(() => {
    const item = window.MAWLauncher.config.postprocessProviders.find(item => item.id === 'deepseek');
    return [item.hasBaseUrl, item.hasModel, item.verified];
  })).toEqual([true, true, true]);
  for (const { payload } of await page.evaluate(() => window.llmFallbackCalls)) {
    expect(payload.baseUrl).toBe('');
    expect(payload.model).toBe('');
  }
});

test('system notifications are disabled by default and announce enabling', async ({ page }) => {
  await gotoLauncher(page);
  await page.evaluate(() => document.getElementById('langZh').click());

  await expect(page.locator('#notifyOnComplete')).not.toBeChecked();
  await page.locator('#settingsButton').click();
  await page.locator('#notifyOnComplete').check();

  await expect.poll(() => page.evaluate(() => window.__mockNotifications || [])).toEqual([
    { title: '系统通知已启用', message: '之后任务完成或失败时会提醒你。' },
  ]);

  await page.locator('#notifyOnComplete').uncheck();
  await expect.poll(() => page.evaluate(() => (window.__mockNotifications || []).length)).toBe(1);
});

test('single transcription notifications report completion and failure', async ({ page }) => {
  await gotoLauncher(page);
  await page.evaluate(() => document.getElementById('langZh').click());
  await page.evaluate(() => {
    window.MAWLauncher.config.notifyOnComplete = true;
    window.__mockNotifications = [];
  });

  await page.locator('#mediaPath').fill('D:\\Demo\\clip.mp4');
  await page.locator('#srtPath').fill('D:\\Demo\\clip.srt');
  await page.locator('#apiKey').fill('sk-mock-key');
  await page.locator('#start').click();
  await expect.poll(() => page.evaluate(() => window.__mockNotifications || [])).toEqual([
    { title: '转写完成', message: '已生成 clip.srt' },
  ]);

  await page.evaluate(() => { window.__mockNotifications = []; });
  await page.locator('#start').click();
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({
    type: 'error', code: 'transcription_failed', detail: 'service exploded',
  }));
  await expect.poll(() => page.evaluate(() => window.__mockNotifications || [])).toEqual([
    {
      title: '转写失败',
      message: '文件 clip.mp4 处理失败：转写失败，本次任务已停止。请查看日志后修正问题，再重新尝试。 service exploded',
    },
  ]);

  // The delayed mock completion is a late event after failure and must not notify again.
  await page.waitForTimeout(1_000);
  await expect.poll(() => page.evaluate(() => (window.__mockNotifications || []).length)).toBe(1);
});

test('batch failure notifications summarize outcomes', async ({ page }) => {
  await gotoLauncher(page);
  await page.evaluate(() => document.getElementById('langZh').click());
  await page.evaluate(() => {
    window.MAWLauncher.config.notifyOnComplete = true;
    window.__mockNotifications = [];
    window.MAWLauncher.callBackend = async () => ({ ok: true });
  });
  await page.locator('#batchMode').click();
  await page.evaluate(() => {
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [{ path: 'D:\\Demo\\first.mp3' }, { path: 'D:\\Demo\\second.mp3' }] },
    });
    document.getElementById('mediaCard').dispatchEvent(drop);
  });
  await page.locator('#startBatch').click();

  await page.evaluate(() => {
    window.MAWLauncher.onBackendEvent({ type: 'batch_started', total: 2 });
    window.MAWLauncher.onBackendEvent({
      type: 'batch_done',
      status: 'failed',
      total: 2,
      outcomes: [{ id: 'batch-1', status: 'done', srtPath: 'D:\\Demo\\first.srt' }],
    });
  });

  await expect.poll(() => page.evaluate(() => window.__mockNotifications || [])).toEqual([
    { title: '批量转写失败', message: '成功 1 个，失败 1 个。' },
  ]);
});

test('cancelling a transcription stays quiet', async ({ page }) => {
  await gotoLauncher(page);
  await page.evaluate(() => document.getElementById('langZh').click());
  await page.evaluate(() => {
    window.MAWLauncher.config.notifyOnComplete = true;
    window.__mockNotifications = [];
  });

  await page.locator('#mediaPath').fill('D:\\Demo\\cancelled.mp4');
  await page.locator('#srtPath').fill('D:\\Demo\\cancelled.srt');
  await page.locator('#apiKey').fill('sk-mock-key');
  await page.locator('#start').click();
  await page.locator('#stop').click();
  await expect(page.locator('#status')).toHaveText('转写已停止。');
  await page.waitForTimeout(1_000);

  await expect.poll(() => page.evaluate(() => window.__mockNotifications || [])).toEqual([]);
});

test('Utilities use a horizontal tab strip with arrow-key navigation', async ({ page }) => {
  await openLauncher(page);
  await page.locator('#toolboxUtilitiesPrimaryTab').click();

  await expect(page.locator('#toolboxUtilitiesContent')).toBeVisible();
  // 横向 tab 条：ARIA 方向保持默认 horizontal，不得声明 vertical（契约见
  // test_gui_web.test_launcher_toolbox_uses_primary_tabs…）。
  await expect(page.locator('#toolboxUtilitiesTabList')).not.toHaveAttribute('aria-orientation', 'vertical');
  const layout = await page.evaluate(() => {
    const style = getComputedStyle(document.getElementById('toolboxUtilitiesContent'));
    // beta.4 重构后 tablist 导航是 content 的兄弟节点；tab 条横向一行五列。
    const tabList = document.querySelector('#toolboxUtilitiesTabList .toolbox-tab-list');
    const tabListStyle = getComputedStyle(tabList);
    return {
      columns: style.gridTemplateColumns.split(' ').length,
      tabColumnCount: tabListStyle.gridTemplateColumns.split(' ').length,
    };
  });
  expect(layout.columns).toBe(1);
  expect(layout.tabColumnCount).toBe(5);

  // 媒体工具依次为文稿匹配、烧录、口播对齐、提取音频、生成波形；隐藏的媒体重组不参与键盘导航。
  await page.locator('#toolboxAlignmentTab').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#toolboxExtractAudioTab')).toBeFocused();
  await expect(page.locator('#toolboxExtractAudioPanel')).toBeVisible();
  await expect(page.locator('#toolboxAlignmentPanel')).toBeHidden();

  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#toolboxAlignmentTab')).toBeFocused();
  await expect(page.locator('#toolboxAlignmentPanel')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#toolboxBurnSubtitleTab')).toBeFocused();
  await expect(page.locator('#toolboxBurnSubtitlePanel')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#toolboxScriptAlignmentTab')).toBeFocused();
  await expect(page.locator('#toolboxScriptAlignmentPanel')).toBeVisible();
});

test('FFmpeg media log stays above the utility notice and renders the latest progress', async ({ page }) => {
  await openLauncher(page);
  await page.locator('#toolboxUtilitiesPrimaryTab').click();
  await page.locator('#toolboxBurnSubtitleTab').click();

  await page.evaluate(() => {
    for (let frame = 1; frame <= 5; frame += 1) {
      window.MAWLauncher.onBackendEvent({
        type: 'media_tool_log',
        message: `frame=${frame} fps=24.0 time=00:00:01.75 speed=1.2x`,
      });
    }
  });

  await expect(page.locator('#toolboxMediaLog')).toBeVisible();
  await expect(page.locator('#toolboxMediaLogText')).toHaveText(
    'frame=3 fps=24.0 time=00:00:01.75 speed=1.2x\nframe=4 fps=24.0 time=00:00:01.75 speed=1.2x\nframe=5 fps=24.0 time=00:00:01.75 speed=1.2x',
  );
  expect(await page.evaluate(() => (
    document.getElementById('toolboxMediaLog').compareDocumentPosition(document.querySelector('#toolboxBurnSubtitlePanel .toolbox-notice'))
      & Node.DOCUMENT_POSITION_FOLLOWING
  ))).toBeTruthy();
});

test('green-screen burn accepts subtitles without a video source and optional source audio', async ({ page }, testInfo) => {
  await openLauncher(page);
  await page.locator('#toolboxUtilitiesPrimaryTab').click();
  await page.locator('#toolboxBurnSubtitleTab').click();
  await page.evaluate(() => {
    window.__greenBurnCalls = [];
    const original = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'run_burn_subtitles') {
        window.__greenBurnCalls.push(payload);
        return { ok: true, mediaPath: 'D:\\Demo\\captions.green-screen.mp4' };
      }
      return original(method, payload);
    };
  });
  await expect(page.locator('#toolboxGreenScreenAudioField')).toBeHidden();
  await page.locator('#toolboxGreenScreen').check();
  await expect(page.locator('#toolboxGreenScreenAudioField')).toBeVisible();
  await expect(page.locator('#toolboxGreenScreenIncludeAudio')).not.toBeChecked();
  await expect(page.locator('#toolboxUtilityMediaDropZone')).toBeVisible();
  await expect(page.locator('#toolboxUtilityMediaDropZone')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#toolboxUtilityMediaPath')).toBeDisabled();
  await expect(page.locator('#pickToolboxUtilityMedia')).toBeDisabled();
  await expect(page.locator('#runBurnSubtitle')).toHaveText('生成绿幕视频');
  const option = page.locator('.toolbox-green-screen-option');
  const fieldGap = await option.locator('#toolboxGreenScreenSizeField').evaluate((element) =>
    element.getBoundingClientRect().top - element.previousElementSibling.getBoundingClientRect().bottom);
  expect(fieldGap).toBeGreaterThanOrEqual(8);
  const hintGap = await option.locator('[data-i18n="toolbox_green_screen_hint"]').evaluate((element) =>
    element.getBoundingClientRect().top - element.previousElementSibling.getBoundingClientRect().bottom);
  expect(hintGap).toBeGreaterThanOrEqual(8);
  await page.locator('#toolboxBurnSubtitlePath').fill('D:\\Demo\\captions.ass');
  await page.locator('#runBurnSubtitle').click();
  await expect.poll(() => page.evaluate(() => window.__greenBurnCalls.length)).toBe(1);
  const call = await page.evaluate(() => window.__greenBurnCalls[0]);
  expect(call).toMatchObject({ mediaPath: '', subtitlePath: 'D:\\Demo\\captions.ass', greenScreen: true,
    greenScreenIncludeAudio: false });
  await expect(page.locator('#toolboxUtilityMediaPath')).toHaveValue('D:\\Demo\\captions.green-screen.mp4');
  await page.locator('#toolboxGreenScreenIncludeAudio').check();
  await expect(page.locator('#toolboxUtilityMediaPath')).toBeEnabled();
  await page.locator('#toolboxUtilityMediaPath').fill('D:\\Demo\\voice.wav');
  const audioGap = await page.locator('#toolboxGreenScreenAudioField').evaluate(el =>
    el.getBoundingClientRect().left - el.previousElementSibling.getBoundingClientRect().right);
  expect(audioGap).toBeGreaterThanOrEqual(8);
  console.log(`Launcher green screen spacing: ${JSON.stringify({ fieldGap, hintGap, audioGap })}`);
  await page.screenshot({ path: testInfo.outputPath('green-screen-audio-option.png') });
  await page.locator('#runBurnSubtitle').click();
  await expect.poll(() => page.evaluate(() => window.__greenBurnCalls.length)).toBe(2);
  expect(await page.evaluate(() => window.__greenBurnCalls[1])).toMatchObject({
    mediaPath: 'D:\\Demo\\voice.wav', greenScreen: true, greenScreenIncludeAudio: true });
  await page.locator('#toolboxGreenScreenIncludeAudio').uncheck();
  await page.locator('#toolboxWaveformTab').click();
  await expect(page.locator('#toolboxUtilityMediaPath')).toBeEnabled();
  await expect(page.locator('#pickToolboxUtilityMedia')).toBeEnabled();
  await page.locator('#toolboxBurnSubtitleTab').click();
  await expect(page.locator('#toolboxUtilityMediaPath')).toBeDisabled();
  await page.locator('#toolboxGreenScreen').uncheck();
  await expect(page.locator('#toolboxGreenScreenAudioField')).toBeHidden();
  await expect(page.locator('#toolboxUtilityMediaPath')).toBeEnabled();
  await expect(page.locator('#pickToolboxUtilityMedia')).toBeEnabled();
  await expect(page.locator('#runBurnSubtitle')).toHaveText('烧录字幕');
});

test('Launcher settings switch between accessible tabs and deep links', async ({ page }) => {
  await gotoLauncher(page);
  await page.evaluate(() => document.getElementById('langZh').click());

  await page.locator('#settingsButton').click();

  const tabs = page.locator('#settingsTabList [role="tab"]');
  await expect(tabs).toHaveCount(4);
  await expect(page.locator('#settingsTabList')).toHaveAttribute('aria-label', '设置分类');
  await expect(page.locator('#settingsGeneralPanel')).toBeVisible();
  await expect(page.locator('#settingsLlmPanel')).toBeHidden();
  await expect(page.locator('#settingsLlmTab')).toHaveText('AI 模型');

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
  await expect(page.locator('#settingsGeneralTab')).toBeFocused();
  await expect(page.locator('#settingsGeneralPanel')).toBeVisible();
  await page.locator('#settingsGeneralTab').press('ArrowRight');
  await expect(page.locator('#settingsProcessingTab')).toBeFocused();
  await expect(page.locator('#settingsProcessingPanel')).toBeVisible();
  await page.locator('#settingsProcessingTab').press('ArrowRight');
  await expect(page.locator('#settingsRuntimeTab')).toBeFocused();
  await expect(page.locator('#settingsRuntimePanel')).toBeVisible();
  await page.locator('#settingsRuntimeTab').press('End');
  await expect(page.locator('#settingsLlmTab')).toBeFocused();

  await page.evaluate(() => window.MAWLauncher.openSettings('ffmpegSettingsSection'));
  await expect(page.locator('#settingsRuntimeTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ffmpegSettingsSection')).toBeVisible();

  await page.setViewportSize({ width: 520, height: 520 });
  await gotoLauncher(page, { reload: true });
  await page.locator('#settingsButton').click();
  const tabLayout = await page.locator('#settingsTabList').evaluate((element) => {
    const style = getComputedStyle(element);
    return { columns: style.gridTemplateColumns.split(' ').length, overflow: element.scrollWidth > element.clientWidth };
  });
  expect(tabLayout.columns).toBe(2);
  expect(tabLayout.overflow).toBe(false);
});

test('Qwen regional settings use a narrow advanced link and live at the bottom of LLM settings', async ({ page }) => {
  await gotoLauncher(page);
  await page.evaluate(() => document.getElementById('langZh').click());

  await page.locator('#provider').selectOption('qwen');
  await page.locator('#advancedToggle').click();
  const regionalHint = page.locator('#dashscopeRegionHint');
  await expect(regionalHint).toBeVisible();
  expect(await regionalHint.evaluate((element) => {
    const style = getComputedStyle(element);
    return { gridColumnStart: style.gridColumnStart, gridColumnEnd: style.gridColumnEnd };
  })).toEqual({ gridColumnStart: '1', gridColumnEnd: '-1' });
  await expect(regionalHint.locator('button')).toHaveCount(1);
  await expect(regionalHint.locator('button')).toHaveText('⚙️ 设置 → 运行环境');
  await expect(regionalHint).toContainText('配置阿里云百炼地域。');
  await page.locator('#openDashscopeRegionSettings').click();
  await expect(page.locator('#settingsModal')).toBeVisible();
  await expect(page.locator('#settingsLlmTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#settingsRuntimeTab')).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('#dashscopeRegionPanel')).toBeVisible();
  await expect(page.locator('#dashscopeRegionPanel h3')).toHaveText('阿里云百炼 地域设置');
  expect(await page.locator('#dashscopeRegionPanel').evaluate((element) => element.parentElement?.id)).toBe('settingsLlmPanel');
});

test('Launcher keeps the length limit backend-only', async ({ page }) => {
  await gotoLauncher(page);

  await expect(page.locator('#lengthLimitField')).toHaveCount(0);
  await expect(page.locator('#lengthLimit')).toHaveCount(0);
  await page.locator('#testRun').check();
  await expect(page.locator('#status')).toBeVisible();
});

test('segmentation settings live under Processing and validation opens that tab', async ({ page }) => {
  await gotoLauncher(page);

  await page.locator('#settingsButton').click();
  await page.locator('#settingsProcessingTab').click();
  await expect(page.locator('#settingsProcessingPanel')).toBeVisible();
  await expect(page.locator('#segmentationSettingsSection')).toBeVisible();
  await page.locator('#maxLen').fill('2');
  await page.locator('#minLen').fill('5');
  await page.locator('#settingsClose').click();

  await page.locator('#mediaPath').fill('D:\\Demo\\clip.mp4');
  await page.locator('#srtPath').fill('D:\\Demo\\clip.srt');
  await page.locator('#start').click();

  await expect(page.locator('#settingsModal')).toBeVisible();
  await expect(page.locator('#settingsProcessingTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#segmentationSettingsSection')).toBeVisible();
  await expect(page.locator('#maxLenError')).toHaveText('断句参数无效：请输入整数，并确保单句上限不小于短句合并值。');
});

test('does not start local transcription while model status is still checking', async ({ page }) => {
  await gotoLauncher(page);
  await page.locator('#provider').selectOption('local');
  await expect(page.locator('#localModelSettingsEntry')).toBeVisible();
  await page.locator('#mediaPath').fill('D:\\Demo\\clip.mp4');
  await page.locator('#srtPath').fill('D:\\Demo\\clip.local.srt');

  await page.evaluate(() => {
    const config = window.MAWLauncher.config;
    config.localRuntime = { status: 'ready', ready: true, path: '', pythonPath: '' };
    const local = config.providers.find((item) => item.id === 'local');
    const model = local.models.find((item) => item.id === document.querySelector('#model').value);
    model.localStatus = { status: 'checking', installed: false, canPrepare: false };
  });

  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('正在检查本地模型……');
  await expect(page.locator('#start')).toBeVisible();
  await expect(page.locator('#stop')).toBeHidden();
});

test('keeps local runtime events working after the page learns that installation is in progress', async ({ page }) => {
  await gotoLauncher(page);
  await page.locator('#provider').selectOption('local');
  await page.locator('#settingsButton').click();
  await page.locator('#settingsRuntimeTab').click();
  await expect(page.locator('#localRuntimePanel')).toBeVisible();

  await page.evaluate(() => {
    const config = window.MAWLauncher.config;
    config.localRuntime = { status: 'installing', ready: false, path: 'D:\\Demo\\local-runtime', pythonPath: '' };
    window.MAWLauncher.onBackendEvent({
      type: 'localRuntimeProgress',
      percent: 37,
      message: '正在安装本地运行环境……',
    });
  });
  await expect(page.locator('#localRuntimeProgress')).toBeVisible();
  await expect.poll(() => page.locator('#localRuntimeProgressBar').getAttribute('style')).toContain('37%');
  await expect(page.locator('#localRuntimeProgressMessage')).toHaveText('正在安装本地运行环境……');

  await page.evaluate(() => window.MAWLauncher.onBackendEvent({ type: 'localRuntimeReady' }));
  await expect(page.locator('#status')).toHaveText('本地模型支持已安装完成');
});

test('local runtime check sits above the local model settings entry and deep-links to the Runtime tab top', async ({ page }) => {
  await gotoLauncher(page);
  await page.locator('#provider').selectOption('local');
  await expect(page.locator('#localRuntimeCheckField')).toBeVisible();
  const checkRow = await page.locator('#localRuntimeCheckField').boundingBox();
  const modelEntry = await page.locator('#localModelSettingsEntry').boundingBox();
  expect(checkRow.y + checkRow.height).toBeLessThan(modelEntry.y);
  await expect(page.locator('#localModelCachePathLine')).toContainText('模型缓存：D:\\Models\\MAW');
  await expect(page.locator('#localRuntimeCheckStatus')).toHaveText('本地运行环境未安装');
  await page.locator('#openLocalRuntimeSettings').click();
  await expect(page.locator('#settingsModal')).toBeVisible();
  await expect(page.locator('#settingsRuntimeTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#localRuntimePanel')).toBeVisible();
  // 深度链接落在 Runtime 面板顶部：内容区回到顶部，弹窗卡片本体不被滚动。
  await expect.poll(() => page.locator('.settings-scroll').evaluate((el) => el.scrollTop)).toBeLessThan(4);
  await expect.poll(() => page.locator('.settings-modal-card').evaluate((el) => el.scrollTop)).toBe(0);
});

test('English mode localizes provider, model, and language labels from the backend config', async ({ page }) => {
  await gotoLauncher(page);
  await page.evaluate(() => document.getElementById('langEn').click());
  await page.locator('#provider').selectOption('local');

  await expect(page.locator('#provider option[value="local"]')).toHaveText('Local models (Beta)');
  await expect(page.locator('#model option[value="qwen3-asr-local"]')).toHaveText('Qwen3-ASR 0.6B (recommended)');
  await expect(page.locator('#modelNote')).toHaveText('Lightweight multilingual recognition with native word/character timestamps; shares the Qwen3-ForcedAligner cache.');
  await expect(page.locator('#language option').first()).toHaveText('Auto detect');
});

test('local runtime accepts a custom root directory in Settings', async ({ page }) => {
  await gotoLauncher(page);
  await page.locator('#provider').selectOption('local');
  await page.locator('#settingsButton').click();
  await page.locator('#settingsRuntimeTab').click();
  await expect(page.locator('#localRuntimePath')).toBeVisible();

  await page.locator('#localRuntimePath').fill('D:\\Demo\\custom-runtime');
  await page.locator('#localRuntimePath').dispatchEvent('change');

  await expect(page.locator('#localRuntimePaths')).toContainText('D:\\Demo\\custom-runtime');
  await expect(page.locator('#localRuntimePathError')).toHaveText('');

  await page.locator('#localRuntimePath').fill('D:\\演示\\运行环境');
  await page.locator('#localRuntimePath').dispatchEvent('change');

  await expect(page.locator('#localRuntimePathError')).toContainText('非 ASCII');
  await expect(page.locator('#localRuntimePath')).toHaveClass(/invalid/);
  await expect(page.locator('#localRuntimePaths')).not.toContainText('演示');
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
      model: 'deepseek-flash',
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
  await expect(customOption).toHaveText('自定义接口（或本地模型）');
  await expect(settingsCustomOption).toHaveText('自定义接口（或本地模型）');

  await page.evaluate(() => document.getElementById('langEn').click());
  await expect(customOption).toHaveText('Custom API (or local model)');
  await expect(settingsCustomOption).toHaveText('Custom API (or local model)');
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
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('自定义接口（或本地模型）');
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
  await expect(page.locator('#llmModelError')).not.toContainText('官方控制台');
  await expect(page.locator('#llmModelError')).not.toContainText('test-only-key');

  await page.evaluate(() => { window.__llmFailureStatus = 429; });
  await page.locator('#getLlmModels').click();
  await expect(page.locator('#llmModelError')).toContainText('请求被限流或额度暂时耗尽（HTTP 429');
  await expect(page.locator('#llmModelError')).toContainText('稍后重试');
  await expect(page.locator('#llmModelError')).not.toContainText('官方控制台');
  await expect(page.locator('#llmModelError')).not.toContainText('HTTP 404');

  await page.evaluate(() => { window.__llmFailureStatus = 401; window.__llmFailureProvider = 'custom'; });
  await page.locator('#testLlmConnection').click();
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('认证失败（HTTP 401');
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('当前供应商：自定义接口（或本地模型）');
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('API URL、API Key 是否来自同一服务商');
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('正确配置模型名');
  await expect(page.locator('#llmSettingsSaveStatus')).toContainText('请勿在错误报告中粘贴你的个人 API Key');
  await expect(page.locator('#llmSettingsSaveStatus')).not.toContainText('官方控制台');
});

test('runtime errors show an actionable notice outside the log', async ({ page }) => {
  await gotoLauncher(page);
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
    detail: '处理步骤 translate 失败：LLM provider returned HTTP 400: invalid request. This is a provider response, not a network outage.',
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
  await gotoLauncher(page);
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
  await gotoLauncher(page);
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
  await gotoLauncher(page);
  await page.locator('#apiKey').fill('sk-secret-test-key');
  await page.evaluate(() => {
    window.MAWLauncher.appendLog('child output: duration probe failed');
    window.MAWLauncher.appendLog('Authorization: Bearer secret-bearer-token');
    window.MAWLauncher.appendLog('TOKEN=token-secret OPENAI_API_TOKEN=openai-token {"api_key":"json-secret"}');
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
  expect(report).not.toContain('token-secret');
  expect(report).not.toContain('openai-token');
  expect(report).not.toContain('json-secret');
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

test('server timeout diagnostics are visible and copied with the error report', async ({ page }) => {
  await gotoLauncher(page);
  await page.evaluate(() => {
    window.__copiedReports = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => window.__copiedReports.push(text) },
    });
    window.MAWLauncher.onBackendEvent({
      type: 'error',
      code: 'server_no_response',
      detail: 'http://127.0.0.1:8250/',
      diagnostics: {
        processState: 'running',
        pid: 4321,
        lastProbe: 'Connection refused',
        startupLogTail: 'MAWE started\n[http] probe pending',
      },
    });
  });
  await expect(page.locator('#errorNoticeDiagnostics')).toBeVisible();
  await expect(page.locator('#errorNoticeDiagnostics')).toContainText('进程状态: 仍在运行');
  await expect(page.locator('#errorNoticeDiagnostics')).toContainText('PID: 4321');
  await expect(page.locator('#errorNoticeDiagnostics')).toContainText('最后探测: Connection refused');
  await expect(page.locator('#errorNoticeDiagnostics')).toContainText('启动日志尾部: MAWE started');
  await page.locator('#errorNoticeCopy').click();
  await expect(page.locator('#errorNoticeCopy')).toHaveText('已复制');
  const report = await page.evaluate(() => window.__copiedReports[0]);
  expect(report).toContain('诊断信息:');
  expect(report).toContain('PID: 4321');
  expect(report).toContain('Connection refused');
});

test('launcher reports a server disconnect without manual refresh', async ({ page }) => {
  await gotoLauncher(page);
  await page.locator('#settingsButton').click();
  await page.locator('#langZh').click();
  await page.locator('#settingsClose').click();
  await page.evaluate(() => {
    const original = window.MAWLauncher.callBackend;
    window.__serverStatusCalls = 0;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'get_server_status') {
        window.__serverStatusCalls += 1;
        return { ok: true, running: false, url: 'http://127.0.0.1:8250/' };
      }
      return original(method, payload);
    };
  });

  await page.locator('#openMawe').click();
  await expect(page.locator('#status')).toContainText('字幕编辑服务器已断开', { timeout: 10_000 });
  await expect(page.locator('#openMawe')).toContainText('打开编辑器');
  await expect(page.locator('#stopServer')).toBeHidden();
  expect(await page.evaluate(() => window.__serverStatusCalls)).toBeGreaterThanOrEqual(2);
});

test('launcher scrolls a new hidden warning into view once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await gotoLauncher(page);
  const scroll = page.locator('.shell-scroll');
  const firstScroll = await page.evaluate(async () => {
    const shell = document.querySelector('.shell-scroll');
    shell.scrollTop = 0;
    const warning = document.createElement('p');
    warning.textContent = 'new warning test';
    warning.style.marginTop = '1200px';
    shell.append(warning);
    window.MAWLauncher.revealFeedback(warning, warning.textContent);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const result = shell.scrollTop;
    shell.scrollTop = 0;
    window.MAWLauncher.revealFeedback(warning, warning.textContent);
    await new Promise(resolve => requestAnimationFrame(resolve));
    return { first: result, duplicate: shell.scrollTop };
  });
  expect(firstScroll.first).toBeGreaterThan(0);
  expect(firstScroll.duplicate).toBe(0);

  const visibleScroll = await page.evaluate(async () => {
    const shell = document.querySelector('.shell-scroll');
    shell.scrollTop = 0;
    const warning = document.createElement('p');
    warning.textContent = 'visible warning test';
    shell.prepend(warning);
    window.MAWLauncher.revealFeedback(warning, warning.textContent);
    await new Promise(resolve => requestAnimationFrame(resolve));
    return shell.scrollTop;
  });
  expect(visibleScroll).toBe(0);
  await expect(scroll).toBeVisible();
});

test('restarting after a server disconnect does not reopen the editor page', async ({ page }) => {
  await gotoLauncher(page);
  await page.locator('#settingsButton').click();
  await page.locator('#langZh').click();
  await page.locator('#settingsClose').click();
  await page.evaluate(() => {
    const original = window.MAWLauncher.callBackend;
    window.__openUrlCalls = [];
    // openServerEditor 走内部 bridge → mockApi.open_url → window.open，直接拦截 window.open。
    window.open = (url) => { window.__openUrlCalls.push(String(url)); return null; };
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'get_server_status') {
        // 服务器先在线、后断开，让监控进入 disconnected 状态。
        return { ok: true, running: window.__serverHealthy !== false, url: 'http://127.0.0.1:8250/' };
      }
      return original(method, payload);
    };
  });

  // 先让服务器上线，使监控启动并处于 connected 状态。
  await page.locator('#openMawe').click();
  await expect(page.locator('#openMawe')).toContainText('打开编辑器', { timeout: 10_000 });
  await page.waitForFunction(() => window.__openUrlCalls.length === 1);

  // 模拟断开。
  await page.evaluate(() => { window.__serverHealthy = false; });
  await expect(page.locator('#status')).toContainText('字幕编辑服务器已断开', { timeout: 10_000 });
  await expect(page.locator('#openMawe')).toContainText('打开编辑器');

  // 模拟重启成功：只更新提示，不再调用 open_url 打开新页面。
  await page.evaluate(() => { window.__serverHealthy = true; });
  await page.locator('#openMawe').click();
  await expect(page.locator('#status')).toContainText('回到原编辑器页面', { timeout: 10_000 });
  await expect(page.locator('#openMawe')).toContainText('打开编辑器');
  await expect(page.locator('#stopServer')).toBeVisible();
  await page.waitForFunction(() => window.__openUrlCalls.length === 1, undefined, { timeout: 5_000 });
  expect(await page.evaluate(() => window.__openUrlCalls[0])).toBe('http://127.0.0.1:8250/');
});

test('unknown errors stay generic and do not expose FFmpeg actions', async ({ page }) => {
  await gotoLauncher(page);
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
  await gotoLauncher(page);
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
  await gotoLauncher(page);
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
  await expect(artifacts.nth(0)).toHaveAttribute('data-title', 'source.fixed.mosp\nD:\\Demo\\source.fixed.mosp');
  await expect(artifacts.nth(0)).toHaveAttribute('aria-label', /MOSP 工程.*source\.fixed\.mosp.*D:\\Demo\\source\.fixed\.mosp/);

  await page.evaluate(() => document.getElementById('langEn').click());
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
  await gotoLauncher(page);
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
  await page.evaluate(() => document.getElementById('langEn').click());
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
  await page.evaluate(() => document.getElementById('langEn').click());
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
  await gotoLauncher(page);
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
  await gotoLauncher(page);
  await page.locator('#batchMode').click();
  await page.evaluate(() => {
    window.__batchCalls = [];
    // mock 环境没有 API Key：#208 起 startBatch 会先做 Key 校验，桩掉它以免静默早退。
    window.MAWLauncher.validateApiKey = () => true;
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
  await gotoLauncher(page);
  await page.locator('#batchMode').click();
  await page.evaluate(() => {
    // mock 环境没有 API Key：#208 起 startBatch 会先做 Key 校验，桩掉它以免静默早退。
    window.MAWLauncher.validateApiKey = () => true;
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

test('AI cleanup notes persist in the automatic plan and reach the manual request', async ({ page }) => {
  await openLauncher(page);
  await page.evaluate(() => {
    Object.assign(window.MAWLauncher.config.postprocessProviders.find(p => p.id === 'deepseek'),
      { verified: true, hasApiKey: true, hasBaseUrl: true, hasModel: true });
    window.__notesPlans = [];
    window.__cleanupPayload = null;
    const original = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'save_postprocess_plan') window.__notesPlans.push(payload.plan);
      if (method === 'run_ai_cleanup') {
        window.__cleanupPayload = payload;
        return { ok: false, error: 'test stopped before sending to a model' };
      }
      return original(method, payload);
    };
  });
  // #224 起 AI 口播整理的备注统一走 LLM 工具箱的按任务提示词：自动计划的
  // cleanup 步骤记录 customPrompt，手动请求把它作为 notes 发给 run_ai_cleanup。
  await page.locator('#toolboxLlmTab').click();
  await page.locator('#postprocessOperation').selectOption('ai_cleanup');
  await page.locator('#postprocessPrompt').fill('  保留所有数字\n去除试麦  ');
  // 计划按原文保存提示词（不裁剪）；trim 只发生在手动请求的 notes 上。
  await expect.poll(() => page.evaluate(() => window.__notesPlans.at(-1)?.steps
    .find(s => s.id === 'cleanup')?.customPrompt)).toBe('  保留所有数字\n去除试麦  ');
  await page.locator('#toolboxInputPath').fill('source.mosp');
  await page.locator('#runLlmPostprocess').click();
  await expect.poll(() => page.evaluate(() => window.__cleanupPayload?.notes)).toBe('保留所有数字\n去除试麦');
  await page.locator('#postprocessOperation').selectOption('proofread');
  await expect(page.locator('#postprocessPrompt')).toHaveValue('');
  await page.locator('#postprocessOperation').selectOption('ai_cleanup');
  await expect(page.locator('#postprocessPrompt')).toHaveValue('  保留所有数字\n去除试麦  ');
});

async function prepareDeferredAiLauncher(page, entry) {
  await openLauncher(page);
  await page.evaluate(() => {
    Object.assign(window.MAWLauncher.config.postprocessProviders.find(p => p.id === 'deepseek'),
      { verified: true, hasApiKey: true, hasBaseUrl: true, hasModel: true });
    window.__aiLifecycleRuns = [];
    window.__aiLifecycleCancels = [];
    window.__aiLifecycleDeferCancel = false;
    const original = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (['run_ai_cleanup', 'run_llm_postprocess'].includes(method)) {
        return new Promise(resolve => window.__aiLifecycleRuns.push({ method, payload, resolve }));
      }
      if (method === 'cancel_postprocess') {
        window.__aiLifecycleCancels.push(payload);
        if (window.__aiLifecycleDeferCancel) {
          return new Promise(resolve => { window.__aiLifecycleResolveCancel = resolve; });
        }
        return { ok: true, active: true, cancelled: true };
      }
      return original(method, payload);
    };
  });
  // #224 起 AI 口播整理并入 LLM 工具箱的任务下拉；两个入口都经 #runLlmPostprocess 启动。
  await page.locator('#toolboxLlmTab').click();
  await page.locator('#toolboxInputPath').fill('D:\\Demo\\source.mosp');
  if (entry === 'cleanup') await page.locator('#postprocessOperation').selectOption('ai_cleanup');
  return page.locator('#runLlmPostprocess');
}

async function sendAiLifecycleEvents(page, index, events) {
  await page.evaluate(({ index, events }) => {
    const operationId = window.__aiLifecycleRuns[index].payload.operationId;
    window.MAWLauncher.onBackendEvents(events.map(event => ({ operationId, ...event })));
  }, { index, events });
}

async function resolveAiLifecycleRun(page, index, result) {
  await page.evaluate(({ index, result }) => window.__aiLifecycleRuns[index].resolve(result), { index, result });
}

const aiAdmissionEvent = { type: 'postprocess_status', stage: 'admitted', key: 'toolbox_status_starting' };
const aiSuccessResult = { ok: true, projectPath: 'D:\\Demo\\processed.mosp', warnings: [] };

for (const entry of ['cleanup', 'llm']) {
  test(`AI ${entry} admits Stop before use and keeps queued output after completion`, async ({ page }) => {
    const run = await prepareDeferredAiLauncher(page, entry);
    const stop = page.locator('#stopToolboxPostprocess');
    await run.click();
    await expect.poll(() => page.evaluate(() => window.__aiLifecycleRuns.length)).toBe(1);
    await expect(stop).toBeHidden();
    await expect(stop).toBeDisabled();
    // Even a dispatched click cannot cancel a request not yet admitted.
    await stop.evaluate(element => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(await page.evaluate(() => window.__aiLifecycleCancels.length)).toBe(0);
    await sendAiLifecycleEvents(page, 0, [{ ...aiAdmissionEvent, operationId: 'unrelated-operation' }]);
    await expect(stop).toBeHidden();
    await expect(stop).toBeDisabled();
    await sendAiLifecycleEvents(page, 0, [aiAdmissionEvent]);
    await expect(stop).toBeVisible();
    await expect(stop).toBeEnabled();

    await resolveAiLifecycleRun(page, 0, aiSuccessResult);
    await expect(run).toBeEnabled();
    await expect(stop).toBeHidden();
    await expect(stop).toBeDisabled();
    // The bridge Promise has settled; the event pump's final batch arrives now.
    await sendAiLifecycleEvents(page, 0, [
      aiAdmissionEvent,
      { type: 'postprocess_stream', kind: 'reset' },
      { type: 'postprocess_stream', kind: 'reasoning', text: 'queued reasoning', batch: 1 },
      { type: 'postprocess_stream', kind: 'content', text: 'queued result', batch: 1 },
    ]);
    await expect(stop).toBeHidden();
    await expect(page.locator('#toolboxThinkingOutput')).toHaveText('queued reasoning');
    await expect(page.locator('#toolboxModelOutput')).toHaveText('queued result');
    await sendAiLifecycleEvents(page, 0, [
      { type: 'postprocess_stream', operationId: 'unrelated-operation', kind: 'reset' },
      { type: 'postprocess_stream', operationId: 'unrelated-operation', kind: 'content', text: 'wrong result' },
    ]);
    await expect(page.locator('#toolboxModelOutput')).toHaveText('queued result');

    await run.click();
    await expect.poll(() => page.evaluate(() => window.__aiLifecycleRuns.length)).toBe(2);
    await sendAiLifecycleEvents(page, 0, [
      aiAdmissionEvent,
      { type: 'postprocess_stream', kind: 'reset' },
      { type: 'postprocess_stream', kind: 'content', text: 'previous completed result' },
    ]);
    await expect(stop).toBeHidden();
    await expect(page.locator('#toolboxModelOutput')).toBeEmpty();
    await sendAiLifecycleEvents(page, 1, [
      aiAdmissionEvent,
      { type: 'postprocess_stream', kind: 'content', text: 'next result' },
    ]);
    await resolveAiLifecycleRun(page, 1, aiSuccessResult);
    await expect(run).toBeEnabled();
    await sendAiLifecycleEvents(page, 0, [{ type: 'postprocess_stream', kind: 'reset' }]);
    await sendAiLifecycleEvents(page, 1, [{ type: 'postprocess_stream', kind: 'content', text: ' tail' }]);
    await expect(page.locator('#toolboxModelOutput')).toHaveText('next result tail');
  });

  test(`AI ${entry} rejects cancelled late events and isolates the following run`, async ({ page }) => {
    const run = await prepareDeferredAiLauncher(page, entry);
    const stop = page.locator('#stopToolboxPostprocess');
    await run.click();
    await expect.poll(() => page.evaluate(() => window.__aiLifecycleRuns.length)).toBe(1);
    await sendAiLifecycleEvents(page, 0, [
      aiAdmissionEvent,
      { type: 'postprocess_stream', kind: 'reasoning', text: 'partial reasoning' },
      { type: 'postprocess_stream', kind: 'content', text: 'partial result' },
    ]);
    await stop.click();
    await expect.poll(() => page.evaluate(() => window.__aiLifecycleCancels.length)).toBe(1);
    expect(await page.evaluate(() => window.__aiLifecycleCancels[0].operationId))
      .toBe(await page.evaluate(() => window.__aiLifecycleRuns[0].payload.operationId));
    await expect(stop).toBeDisabled();
    const lateEvents = [
      { type: 'postprocess_stream', kind: 'reset' },
      { type: 'postprocess_stream', kind: 'reasoning', text: 'late cancelled reasoning' },
      { type: 'postprocess_stream', kind: 'content', text: 'late cancelled result' },
    ];
    await sendAiLifecycleEvents(page, 0, lateEvents);
    await expect(page.locator('#toolboxModelOutput')).toHaveText('partial result');
    await resolveAiLifecycleRun(page, 0, { ok: false, code: 'postprocess_cancelled' });
    await expect(run).toBeEnabled();
    await expect(stop).toBeHidden();
    await expect(page.locator('#toolboxResultText')).toContainText('已取消');
    await sendAiLifecycleEvents(page, 0, lateEvents);
    await expect(page.locator('#toolboxThinkingOutput')).toHaveText('partial reasoning');
    await expect(page.locator('#toolboxModelOutput')).toHaveText('partial result');

    await run.click();
    await expect.poll(() => page.evaluate(() => window.__aiLifecycleRuns.length)).toBe(2);
    const ids = await page.evaluate(() => window.__aiLifecycleRuns.map(item => item.payload.operationId));
    expect(ids[1]).not.toBe(ids[0]);
    await sendAiLifecycleEvents(page, 0, [aiAdmissionEvent, ...lateEvents]);
    await expect(stop).toBeHidden();
    await expect(page.locator('#toolboxThinkingOutput')).toBeEmpty();
    await expect(page.locator('#toolboxModelOutput')).toBeEmpty();
    await sendAiLifecycleEvents(page, 1, [
      aiAdmissionEvent,
      { type: 'postprocess_stream', kind: 'reasoning', text: 'next reasoning' },
      { type: 'postprocess_stream', kind: 'content', text: 'next result' },
    ]);
    await expect(stop).toBeEnabled();
    await sendAiLifecycleEvents(page, 0, lateEvents);
    await expect(page.locator('#toolboxModelOutput')).toHaveText('next result');
    await resolveAiLifecycleRun(page, 1, aiSuccessResult);
    await expect(run).toBeEnabled();
    await sendAiLifecycleEvents(page, 0, lateEvents);
    await sendAiLifecycleEvents(page, 1, [
      { type: 'postprocess_stream', kind: 'reasoning', text: ' tail' },
      { type: 'postprocess_stream', kind: 'content', text: ' tail' },
    ]);
    await expect(page.locator('#toolboxThinkingOutput')).toHaveText('next reasoning tail');
    await expect(page.locator('#toolboxModelOutput')).toHaveText('next result tail');
  });

  test(`AI ${entry} keeps tail events while a pending Stop is later rejected`, async ({ page }) => {
    const run = await prepareDeferredAiLauncher(page, entry);
    await page.evaluate(() => { window.__aiLifecycleDeferCancel = true; });
    await run.click();
    await expect.poll(() => page.evaluate(() => window.__aiLifecycleRuns.length)).toBe(1);
    await sendAiLifecycleEvents(page, 0, [aiAdmissionEvent]);
    await page.locator('#stopToolboxPostprocess').click();
    await expect.poll(() => page.evaluate(() => window.__aiLifecycleCancels.length)).toBe(1);
    await sendAiLifecycleEvents(page, 0, [
      { type: 'postprocess_stream', kind: 'reasoning', text: 'pending reasoning' },
      { type: 'postprocess_stream', kind: 'content', text: 'pending result' },
    ]);
    await expect(page.locator('#toolboxThinkingOutput')).toHaveText('pending reasoning');
    await expect(page.locator('#toolboxModelOutput')).toHaveText('pending result');
    await page.evaluate(() => window.__aiLifecycleResolveCancel({ ok: true, active: true, cancelled: false }));
    await resolveAiLifecycleRun(page, 0, aiSuccessResult);
    await expect(run).toBeEnabled();
    await sendAiLifecycleEvents(page, 0, [{ type: 'postprocess_stream', kind: 'content', text: ' saved' }]);
    await expect(page.locator('#toolboxModelOutput')).toHaveText('pending result saved');
  });
}
