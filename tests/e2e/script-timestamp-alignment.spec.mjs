import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/launcher/index.html');

async function openScriptMode(page) {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#toolboxFab').click();
  await page.locator('#toolboxTimestampsTab').click();
  await page.locator('#toolboxTimestampMode').selectOption('script');
}

test('script input replaces subtitle input and only exposes Qwen without changing other timestamp modes', async ({ page }) => {
  await openScriptMode(page);
  await expect(page.locator('#toolboxInputDropZone')).toBeHidden();
  await expect(page.locator('#toolboxOutputField')).toBeHidden();
  await expect(page.locator('#toolboxTimestampScriptInputs')).toBeVisible();
  await expect(page.locator('#toolboxTimestampModel option')).toHaveCount(1);
  await expect(page.locator('#toolboxTimestampModel')).toHaveValue('qwen3-forced-aligner-0.6b');
  await expect(page.locator('#runTimestampAlignment')).toBeDisabled();
  await expect(page.locator('#checkScriptAlignment')).toBeEnabled();
  await expect(page.locator('#toolboxTimestampModeHint')).toContainText('不识别实际说了什么');
  await page.locator('#toolboxTimestampMode').selectOption('fill');
  await expect(page.locator('#toolboxInputDropZone')).toBeVisible();
  await expect(page.locator('#toolboxTimestampScriptInputs')).toBeHidden();
  await expect(page.locator('#toolboxTimestampModel option')).toHaveCount(2);
});

test('script mode sends script and media without a source project, displays artifacts and warnings', async ({ page }) => {
  await openScriptMode(page);
  await page.evaluate(() => {
    window.MAWLauncher.config.alignmentModels[0].installed = true;
    window.MAWLauncher.config.alignmentModels[0].runtimeAvailable = true;
    document.getElementById('toolboxTimestampModel').dispatchEvent(new Event('change'));
    const original = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method !== 'run_timestamp_alignment') return original(method, payload);
      window.scriptAlignmentPayload = payload;
      return { ok: true, projectPath: '/tmp/script.script-aligned.mosp', srtPath: '/tmp/script.script-aligned.srt', warnings: ['请听审录音'], report: { strategy: 'manual_anchors', scriptLines: 12, chunks: 2, durationMs: 10000, audioTrack: 1 } };
    };
  });
  await page.locator('#toolboxTimestampMediaPath').fill('/tmp/audio.wav');
  await page.locator('#toolboxTimestampScriptPath').fill('/tmp/script.txt');
  await page.locator('#toolboxTimestampAudioTrack').fill('1');
  await page.locator('#toolboxTimestampOutputDirectory').fill('/tmp/output');
  await page.locator('#runTimestampAlignment').click();
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
  await page.locator('#toolboxTimestampMediaPath').fill('/tmp/audio.wav');
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
  await expect(page.locator('#toolboxTimestampMode option[value="script"]')).toHaveText('Align from script only');
  await expect(page.locator('#toolboxTimestampScriptInputs h3')).toHaveText('Script-driven alignment');
});
