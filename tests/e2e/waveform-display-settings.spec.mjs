import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';

let tempDir, server;
test.beforeAll(async () => {
  tempDir = makeTempDir('waveform-display-settings');
  const media = join(tempDir, 'sample.wav'), project = join(tempDir, 'sample.mosp');
  generateWav(media, 4);
  writeFileSync(project, JSON.stringify({ media, waveform: generateWaveformPayload(4000),
    segments: [{ id: 'main', start: 500, end: 3000, text: 'main full text',
      items: [{ start: 500, end: 3000, text: 'main full text' }] }],
    overlay_track: { enabled: true, segments: [{ id: 'overlay', start: 500, end: 3000, text: 'overlay full text' }] },
    multi_subtitle: { enabled: true, tracks: [{ id: 'secondary', segments: [{ id: 'ext', start: 500, end: 3000, text: 'extension full text' }] }] },
  }));
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });

test('full text preference also controls word hover in both waveform modes', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.locator('#word-timing-quick-toggle').click();
  const word = page.locator('.waveform-word-block').first();
  await expect(word).toHaveAttribute('data-title', /^main full text\n/);
  await word.hover();
  await expect(page.locator('.mawe-tooltip.show .mawe-tooltip-text')).toContainText('main full text');

  await page.locator('#waveform-settings-toggle').click();
  const toggle = page.locator('#waveform-cue-tooltip');
  await expect(toggle.locator('..')).toContainText('悬浮时显示完整文本');
  await toggle.uncheck();
  for (const mode of ['multi', 'basic']) {
    await page.locator('#waveform-settings-toggle').click();
    await page.locator(`[data-waveform-mode="${mode}"]`).click();
    await expect(word).not.toHaveAttribute('data-title', /.+/);
    await word.hover();
    await page.waitForTimeout(500); // shared tooltip opens after 350 ms
    await expect(page.locator('.mawe-tooltip.show')).toHaveCount(0);
    await page.locator('#waveform-settings-toggle').click();
  }
  await page.reload();
  await page.locator('#word-timing-quick-toggle').click();
  await expect(word).not.toHaveAttribute('data-title', /.+/);
  await page.locator('#waveform-settings-toggle').click();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(word).toHaveAttribute('data-title', /^main full text\n/);
  await expect(word.locator('.waveform-cue-handle.left')).toHaveAttribute('data-title', /.+/);
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(toggle.locator('..')).toContainText('Show full text on hover');
});

test('waveform display preferences and spacing', async ({ page }, testInfo) => {
  await disableOnboarding(page);
  await page.addInitScript(() => {
    if (!localStorage.getItem('moy.asr.waveform.settings.v1')) {
      localStorage.setItem('moy.asr.waveform.settings.v1', JSON.stringify({ showGroupBadges: false }));
    }
  });
  await page.goto(server.url);
  await expect(page.locator('.waveform-cue-block').first()).toBeVisible();
  await page.locator('#waveform-settings-toggle').click();
  const toggle = page.locator('#waveform-cue-tooltip');
  await expect(toggle).toBeChecked();
  await expect(page.locator('#waveform-show-group-badges')).not.toBeChecked();
  const cue = page.locator('.waveform-cue-block[data-idx="0"]').first();
  const overlay = page.locator('.waveform-cue-block[data-track="overlay"]').first();
  const extension = page.locator('.waveform-cue-block[data-track="extension"]').first();
  await expect(cue).toHaveAttribute('data-title', 'main full text');
  await expect(overlay).toHaveAttribute('data-title', 'overlay full text');
  await expect(extension).toHaveAttribute('data-title', 'extension full text');
  await page.locator('#waveform-settings-toggle').click();
  await extension.hover();
  await expect(page.locator('.mawe-tooltip.show .mawe-tooltip-text')).toHaveText('extension full text');
  await page.locator('#waveform-settings-toggle').click();
  await toggle.uncheck();
  await expect(cue).not.toHaveAttribute('data-title', /.+/);
  await expect(overlay).not.toHaveAttribute('data-title', /.+/);
  await expect(extension).not.toHaveAttribute('data-title', /.+/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moy.asr.waveform.settings.v1')).showCueTooltip)).toBe(false);
  await page.reload();
  await page.locator('#waveform-settings-toggle').click();
  await expect(toggle).not.toBeChecked();
  await expect(cue).not.toHaveAttribute('data-title', /.+/);
  await page.locator('#waveform-settings-toggle').click();
  await extension.hover();
  await page.waitForTimeout(500); // shared tooltip opens after 350 ms
  await expect(page.locator('.mawe-tooltip.show')).toHaveCount(0);
  await page.locator('#waveform-settings-toggle').click();
  await toggle.check();
  await expect(cue).toHaveAttribute('data-title', 'main full text');
  await expect(overlay).toHaveAttribute('data-title', 'overlay full text');
  await expect(extension).toHaveAttribute('data-title', 'extension full text');

  await page.evaluate(() => {
    const wave = MaweCoreState.waveformEditor;
    MaweBoot.SERVER_CONFIG.thumbnailBinding = 'test-video';
    wave.thumbnailController.setMode('strip');
    wave.updateThumbnailStatus();
  });
  const decode = page.locator('#waveform-thumbnail-decode-setting');
  await expect(decode).toBeVisible();
  for (const language of ['zh', 'en']) {
    await page.evaluate(language => MAWE_I18N.applyLanguage(language), language);
    const geometry = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const shape = rect('#waveform-shape-source'), spectral = rect('#waveform-spectral-color');
      const mode = rect('#waveform-thumbnail-mode'), decode = rect('#waveform-thumbnail-decode');
      const toggle = rect('#waveform-cue-tooltip'), label = rect('#waveform-show-group-badges');
      const next = rect('#waveform-disabled-display');
      return { spectralGap: spectral.left - shape.right, thumbnailGap: decode.left - mode.right,
        thumbnailRowOffset: Math.abs(decode.top + decode.height / 2 - mode.top - mode.height / 2),
        aboveToggle: toggle.top - label.bottom, belowToggle: next.top - toggle.bottom };
    });
    console.log(language, JSON.stringify(geometry));
    expect(geometry.spectralGap).toBeGreaterThanOrEqual(12);
    expect(geometry.thumbnailGap).toBeGreaterThanOrEqual(12);
    expect(geometry.thumbnailRowOffset).toBeLessThan(2);
    expect(geometry.aboveToggle).toBeGreaterThanOrEqual(8);
    expect(geometry.belowToggle).toBeGreaterThanOrEqual(8);
    await page.locator('#waveform-settings-panel').screenshot({ path: testInfo.outputPath(`waveform-settings-${language}.png`) });
  }
  await page.setViewportSize({ width: 360, height: 800 });
  const narrow = await decode.evaluate(element => {
    const mode = document.getElementById('waveform-thumbnail-mode').getBoundingClientRect();
    const checkbox = element.querySelector('input').getBoundingClientRect();
    const row = element.parentElement;
    return { offset: Math.abs(checkbox.top + checkbox.height / 2 - mode.top - mode.height / 2),
      overflow: row.scrollWidth - row.clientWidth };
  });
  expect(narrow.offset).toBeLessThan(2);
  expect(narrow.overflow).toBeGreaterThan(0);
  await page.locator('#waveform-thumbnail-mode').selectOption('hidden');
  await expect(decode).toBeHidden();
  await page.locator('#waveform-thumbnail-mode').selectOption('marks');
  await expect(decode).toBeVisible();
  await expect(page.locator('#waveform-thumbnail-decode')).toBeDisabled();
});
