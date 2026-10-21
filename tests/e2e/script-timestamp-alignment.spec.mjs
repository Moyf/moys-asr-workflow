import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/launcher/index.html');

async function openScriptMode(page) {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#toolboxFab').click();
  await page.locator('#openScriptAlignmentTool').click();
}

test('standalone script tool is before take review and leaves existing subtitle timestamp modes intact', async ({ page }) => {
  await openScriptMode(page);
  await expect(page.locator('#toolboxUtilitiesPrimaryTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#toolboxScriptAlignmentTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#toolboxUtilityMediaDropZone')).toBeVisible();
  const utilityTabs = await page.locator('#toolboxUtilitiesTabList [data-tool]:not(.hidden)').evaluateAll((items) => items.map((item) => item.dataset.tool));
  expect(utilityTabs).toEqual(['scriptAlignment', 'burnSubtitle', 'alignment', 'extractAudio', 'waveform']);
  const postprocessTabs = await page.locator('#toolboxPostprocessTabList [data-tool]:not(.hidden)').evaluateAll((items) => items.map((item) => item.dataset.tool));
  expect(postprocessTabs).toEqual(['llm', 'ocr', 'replace', 'match', 'timestamps']);
  await expect(page.locator('#toolboxMatchTab')).toHaveText('文稿修正');
  await expect(page.locator('#toolboxScriptAlignmentTab')).toHaveText('文稿匹配');
  await page.screenshot({ path: test.info().outputPath('media-tool-navigation.png') });
  await expect(page.locator('#toolboxInputDropZone')).toBeHidden();
  await expect(page.locator('#toolboxOutputField')).toBeHidden();
  await expect(page.locator('#toolboxTimestampScriptInputs')).toBeVisible();
  await expect(page.locator('#toolboxScriptAlignmentModel option')).toHaveCount(1);
  await expect(page.locator('#toolboxScriptAlignmentModel')).toHaveValue('qwen3-forced-aligner-0.6b');
  await expect(page.locator('#runScriptAlignment')).toBeDisabled();
  await expect(page.locator('#checkScriptAlignment')).toBeEnabled();
  await expect(page.locator('#toolboxScriptAlignmentPanel > .toolbox-panel-hint')).toContainText('不识别实际说了什么');
  await page.locator('#toolboxPostprocessPrimaryTab').click();
  await page.locator('#toolboxTimestampsTab').click();
  await expect(page.locator('#toolboxInputDropZone')).toBeVisible();
  await expect(page.locator('#toolboxTimestampScriptInputs')).toBeHidden();
  await expect(page.locator('#toolboxTimestampModel option')).toHaveCount(2);
  expect(await page.locator('#toolboxTimestampMode option').evaluateAll((items) => items.map((item) => item.value))).toEqual(['fill', 'generate']);
  await page.locator('#toolboxTimestampMode').selectOption('generate');
  await page.locator('#toolboxTimestampModel').selectOption('firered-asr2-ctc');
  await page.locator('#toolboxUtilitiesPrimaryTab').click();
  await page.locator('#toolboxScriptAlignmentTab').click();
  await expect(page.locator('#toolboxScriptAlignmentModel')).toHaveValue('qwen3-forced-aligner-0.6b');
  await page.locator('#toolboxPostprocessPrimaryTab').click();
  await expect(page.locator('#toolboxTimestampMode')).toHaveValue('generate');
  await expect(page.locator('#toolboxTimestampModel')).toHaveValue('firered-asr2-ctc');
});

test('script mode sends script and media without a source project, displays artifacts and warnings', async ({ page }) => {
  await openScriptMode(page);
  await page.evaluate(() => {
    window.MAWLauncher.config.alignmentModels[0].installed = true;
    window.MAWLauncher.config.alignmentModels[0].runtimeAvailable = true;
    document.getElementById('toolboxScriptAlignmentModel').dispatchEvent(new Event('change'));
    const original = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method !== 'run_timestamp_alignment') return original(method, payload);
      window.scriptAlignmentPayload = payload;
      return { ok: true, projectPath: '/tmp/script.script-aligned.mosp', srtPath: '/tmp/script.script-aligned.srt', warnings: ['请听审录音'], report: { strategy: 'manual_anchors', scriptLines: 12, chunks: 2, durationMs: 10000, audioTrack: 1 } };
    };
  });
  await page.locator('#toolboxUtilityMediaPath').fill('/tmp/audio.wav');
  await page.locator('#toolboxTimestampScriptPath').fill('/tmp/script.txt');
  await page.locator('#toolboxTimestampAudioTrack').fill('1');
  await page.locator('#toolboxTimestampOutputDirectory').fill('/tmp/output');
  await page.locator('#runScriptAlignment').click();
  await expect(page.locator('#toolboxResult')).toContainText('请听审录音');
  expect(await page.evaluate(() => window.scriptAlignmentPayload)).toMatchObject({
    alignmentMode: 'script', scriptPath: '/tmp/script.txt', mediaPath: '/tmp/audio.wav',
    silenceMs: '500', silenceDb: '-35', language: 'zh',
    audioTrack: '1', outputDirectory: '/tmp/output',
  });
  expect(await page.evaluate(() => window.scriptAlignmentPayload.projectPath)).toBeUndefined();
  await expect(page.locator('#jsonPath')).toHaveValue('/tmp/script.script-aligned.mosp');
  await expect(page.locator('#srtPath')).toHaveValue('/tmp/script.script-aligned.srt');
  await expect(page.locator('#toolboxResult')).toContainText('人工锚点 · 12 行 · 2 个块');
  await page.locator('#toolboxPostprocessPrimaryTab').click();
  await expect(page.locator('#toolboxResult')).toBeHidden();
  await page.locator('#toolboxUtilitiesPrimaryTab').click();
  await expect(page.locator('#toolboxResult')).toContainText('人工锚点 · 12 行 · 2 个块');
});

test('input check needs no model, keeps current project and invalidates on input changes', async ({ page }) => {
  await openScriptMode(page);
  await page.evaluate(() => {
    document.getElementById('jsonPath').value = '/tmp/existing.mosp';
    const original = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method !== 'check_script_alignment') return original(method, payload);
      window.scriptCheckPayload = payload;
      return { ok: true, report: { strategy: 'single', scriptLines: 2, chunks: 1, durationMs: 10000, audioTrack: 0 } };
    };
  });
  await page.locator('#toolboxUtilityMediaPath').fill('/tmp/audio.wav');
  await page.locator('#toolboxTimestampScriptPath').fill('/tmp/script.txt');
  await page.locator('#checkScriptAlignment').click();
  await expect(page.locator('#toolboxTimestampCheckResult')).toContainText('未加载模型、未生成字幕');
  await expect(page.locator('#toolboxTimestampCheckResult')).toContainText('整段对齐 · 2 行 · 1 个块');
  await expect(page.locator('#jsonPath')).toHaveValue('/tmp/existing.mosp');
  expect(await page.evaluate(() => window.scriptCheckPayload.projectPath)).toBeUndefined();
  expect(await page.locator('#toolboxTimestampCheckResult').evaluate((result) => result.getBoundingClientRect().top - result.previousElementSibling.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(8);
  await page.locator('#toolboxTimestampCheckResult').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('input-check.png') });
  await page.locator('#toolboxTimestampAudioTrack').fill('1');
  await expect(page.locator('#toolboxTimestampCheckResult')).toBeHidden();
  await page.locator('#checkScriptAlignment').click();
  await expect(page.locator('#toolboxTimestampCheckResult')).toBeVisible();
  await page.locator('#pickToolboxUtilityMedia').click();
  await expect(page.locator('#toolboxTimestampCheckResult')).toBeHidden();
});

test('script controls have measured spacing and bilingual labels', async ({ page }) => {
  await openScriptMode(page);
  const spacing = await page.locator('#toolboxTimestampScriptInputs').evaluate((group) => {
    const anchors = group.querySelector('#toolboxTimestampAnchorsPath').closest('.field');
    const hint = group.querySelector('.toolbox-settings-hint');
    return {
      groupGap: group.getBoundingClientRect().top - group.previousElementSibling.getBoundingClientRect().bottom,
      hintMargin: parseFloat(getComputedStyle(hint).marginTop),
      hintGap: hint.getBoundingClientRect().top - anchors.getBoundingClientRect().bottom,
      anchorsGap: anchors.getBoundingClientRect().top - anchors.previousElementSibling.getBoundingClientRect().bottom,
      controlsGap: group.querySelectorAll('.toolbox-grid')[1].getBoundingClientRect().top - group.querySelectorAll('.toolbox-grid')[0].getBoundingClientRect().bottom,
      outputGap: group.querySelector('#toolboxTimestampOutputDirectory').closest('.field').getBoundingClientRect().top - anchors.getBoundingClientRect().bottom,
      checkGap: group.querySelector('.script-alignment-check-actions').getBoundingClientRect().top - hint.getBoundingClientRect().bottom,
    };
  });
  for (const gap of Object.values(spacing)) expect(gap).toBeGreaterThanOrEqual(8);
  await page.locator('#toolboxTimestampScriptInputs').screenshot({ path: test.info().outputPath('script-controls.png') });
  await page.evaluate(() => document.getElementById('langEn').click());
  await expect(page.locator('#toolboxScriptAlignmentTab')).toHaveText('Script matching');
  await expect(page.locator('#toolboxMatchTab')).toHaveText('Script correction');
  await expect(page.locator('#runScriptMatch')).toHaveText('Correct subtitles from script');
  await expect(page.locator('#runScriptAlignment')).toHaveText('Generate subtitles');
  await expect(page.locator('#toolboxTimestampScriptInputs h3')).toHaveText('Script-driven alignment');
});

test('script matching guidance is bilingual, spaced and opens the standalone tool settings', async ({ page }) => {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#toolboxFab').click();
  await page.locator('#toolboxInputPath').fill('/tmp/existing.mosp');
  await page.locator('#postprocessScriptPath').fill('/tmp/corrected.txt');
  const guidance = page.locator('#toolboxScriptAlignmentGuidance');
  await expect(guidance).toContainText('如果不需要生成转录文本');
  const gap = await guidance.evaluate((element) => element.nextElementSibling.getBoundingClientRect().top - element.getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThanOrEqual(8);
  console.log(`Script guidance bottom spacing: ${gap}px`);
  await page.locator('#toolboxMatchPanel').screenshot({ path: test.info().outputPath('script-matching-guidance.png') });
  await page.evaluate(() => document.getElementById('langEn').click());
  await expect(page.locator('#openScriptAlignmentTool')).toHaveText('Media tools / Script matching');
  await page.locator('#openScriptAlignmentTool').click();
  await expect(page.locator('#toolboxScriptAlignmentTab')).toBeFocused();
  await expect(page.locator('#toolboxInputDropZone')).toBeHidden();
  await expect(page.locator('#toolboxUtilityMediaDropZone')).toBeVisible();
  await page.locator('#toolboxDrawer .toolbox-content').evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: test.info().outputPath('standalone-script-alignment.png') });
  await page.locator('#openScriptAlignmentModelSettings').click();
  await expect(page.locator('#settingsLlmTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#localAlignmentModelList [data-model-id="qwen3-forced-aligner-0.6b"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#settingsClose').click();
  await page.locator('#toolboxPostprocessPrimaryTab').click();
  await expect(page.locator('#toolboxInputPath')).toHaveValue('/tmp/existing.mosp');
  await expect(page.locator('#postprocessScriptPath')).toHaveValue('/tmp/corrected.txt');
});
