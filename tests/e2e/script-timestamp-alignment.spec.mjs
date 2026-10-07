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
      return { ok: true, projectPath: '/tmp/script.script-aligned.mosp', srtPath: '/tmp/script.script-aligned.srt', warnings: ['请听审录音'] };
    };
  });
  await page.locator('#toolboxTimestampMediaPath').fill('/tmp/audio.wav');
  await page.locator('#toolboxTimestampScriptPath').fill('/tmp/script.txt');
  await page.locator('#runTimestampAlignment').click();
  await expect(page.locator('#toolboxResult')).toContainText('请听审录音');
  expect(await page.evaluate(() => window.scriptAlignmentPayload)).toMatchObject({
    alignmentMode: 'script', scriptPath: '/tmp/script.txt', mediaPath: '/tmp/audio.wav',
    silenceMs: '500', silenceDb: '-35', language: 'zh',
  });
  expect(await page.evaluate(() => window.scriptAlignmentPayload.projectPath)).toBeUndefined();
  await expect(page.locator('#jsonPath')).toHaveValue('/tmp/script.script-aligned.mosp');
  await expect(page.locator('#srtPath')).toHaveValue('/tmp/script.script-aligned.srt');
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
    };
  });
  for (const gap of Object.values(spacing)) expect(gap).toBeGreaterThanOrEqual(8);
  await page.locator('#toolboxTimestampScriptInputs').screenshot({ path: '/private/tmp/maw-174-script-controls.png' });
  await page.evaluate(() => document.getElementById('langEn').click());
  await expect(page.locator('#toolboxTimestampMode option[value="script"]')).toHaveText('Script + audio (skip ASR)');
  await expect(page.locator('#toolboxTimestampScriptInputs h3')).toHaveText('Script-driven alignment');
});
