import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer } from './helpers.mjs';

let tempDir, server;
test.beforeAll(async () => {
  tempDir = makeTempDir('media-controls-layout');
  const envFile = join(tempDir, 'empty-settings.conf');
  writeFileSync(envFile, '', 'utf8');
  server = await startBlankServer(await findFreePort(), tempDir, { env: { MAW_ENV_FILE: envFile } });
});
test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
});

test('media controls stay on one line and keep fullscreen visible at narrow widths', async ({ page }, testInfo) => {
  for (const width of [620, 500, 340]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(server.url);

    // Volume is now a separate panel opened by this button, not an inline slider.
    for (const id of ['media-fullscreen', 'media-seek', 'media-step-back', 'media-step-forward', 'audio-processing-toggle']) {
      await expect(page.locator(`#${id}`)).toHaveCount(1);
    }
    await expect(page.locator('#audio-processing-toggle')).toBeVisible();

    const metrics = await page.locator('#media-controls').evaluate((controls) => {
      const fullscreen = document.getElementById('media-fullscreen');
      const seek = document.getElementById('media-seek');
      const stepBack = document.getElementById('media-step-back');
      const stepForward = document.getElementById('media-step-forward');
      const volume = document.getElementById('audio-processing-toggle');
      const controlsRect = controls.getBoundingClientRect();
      const fullscreenRect = fullscreen.getBoundingClientRect();
      return {
        controlsHeight: controlsRect.height,
        fullscreenVisible: getComputedStyle(fullscreen).display !== 'none'
          && fullscreenRect.width > 0 && fullscreenRect.height > 0,
        fullscreenInLine: fullscreenRect.top >= controlsRect.top - 1
          && fullscreenRect.bottom <= controlsRect.bottom + 1
          && fullscreenRect.right <= controlsRect.right + 1,
        seekWidth: seek.getBoundingClientRect().width,
        stepBackDisplay: getComputedStyle(stepBack).display,
        stepForwardDisplay: getComputedStyle(stepForward).display,
        volumeInLine: volume.getBoundingClientRect().top >= controlsRect.top - 1
          && volume.getBoundingClientRect().bottom <= controlsRect.bottom + 1,
      };
    });

    expect(metrics.controlsHeight).toBeLessThan(60);
    expect(metrics.fullscreenVisible).toBe(true);
    expect(metrics.fullscreenInLine).toBe(true);
    expect(metrics.seekWidth).toBeGreaterThan(0);
    expect(metrics.stepBackDisplay).toBe('none');
    expect(metrics.stepForwardDisplay).toBe('none');
    expect(metrics.volumeInLine).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`media-controls-${width}.png`) });
  }
});
