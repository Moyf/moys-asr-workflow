import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, DURATION_MS, findFreePort, generateProjectJson, generateWav, makeTempDir, startServer } from './helpers.mjs';

let tempDir, server;

test.beforeAll(async () => {
  tempDir = makeTempDir('media-controls-layout');
  const mediaPath = join(tempDir, 'synthetic.wav');
  const projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  generateProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
});

test('media controls stay on one line and keep fullscreen visible at narrow widths', async ({ page }) => {
  for (const width of [620, 500, 340]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(server.url);

    const metrics = await page.locator('#media-controls').evaluate((controls) => {
      const fullscreen = document.getElementById('media-fullscreen');
      const seek = document.getElementById('media-seek');
      const stepBack = document.getElementById('media-step-back');
      const stepForward = document.getElementById('media-step-forward');
      const controlsRect = controls.getBoundingClientRect();
      const fullscreenRect = fullscreen.getBoundingClientRect();
      const visibleRects = [...controls.children]
        .filter(element => getComputedStyle(element).display !== 'none')
        .map(element => element.getBoundingClientRect());
      return {
        controlsHeight: controlsRect.height,
        fullscreenVisible: getComputedStyle(fullscreen).display !== 'none'
          && fullscreenRect.width > 0 && fullscreenRect.height > 0,
        fullscreenInLine: fullscreenRect.top >= controlsRect.top - 1
          && fullscreenRect.bottom <= controlsRect.bottom + 1
          && fullscreenRect.right <= controlsRect.right + 1,
        controlsInViewport: controlsRect.left >= -1 && controlsRect.right <= window.innerWidth + 1,
        seekWidth: seek.getBoundingClientRect().width,
        stepBackDisplay: getComputedStyle(stepBack).display,
        stepForwardDisplay: getComputedStyle(stepForward).display,
        sameLine: Math.max(...visibleRects.map(rect => rect.top)) < Math.min(...visibleRects.map(rect => rect.bottom)),
      };
    });

    expect(metrics.controlsHeight).toBeLessThan(60);
    expect(metrics.fullscreenVisible).toBe(true);
    expect(metrics.fullscreenInLine).toBe(true);
    expect(metrics.controlsInViewport).toBe(true);
    expect(metrics.sameLine).toBe(true);
    expect(metrics.seekWidth).toBeGreaterThan(0);
    expect(metrics.stepBackDisplay).toBe('none');
    expect(metrics.stepForwardDisplay).toBe('none');
    await page.locator('#media-fullscreen').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('player-wrap'))).toBe(true);
    await expect(page.locator('#media-fullscreen')).toHaveAttribute('aria-label', '退出全屏');
    await page.locator('#media-fullscreen').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
  }
});
