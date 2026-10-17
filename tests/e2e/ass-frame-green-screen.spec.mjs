import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, cleanupTempDir, generateWav, generateWaveformPayload,
  startServer, startBlankServer, findFreePort, disableOnboarding,
  openSettingsPage, closeSettingsPanels } from './helpers.mjs';

const hint = '当前缺少视频画面，使用绿幕预览，可在「更多导出」中导出绿幕视频';

for (const kind of ['audio', 'blank']) {
  test(`ASS actual frame uses green screen for ${kind} and preserves its hint`, async ({ page }, testInfo) => {
    const dir = makeTempDir('ass-green-screen');
    let server;
    try {
      if (kind === 'audio') {
        const media = join(dir, 'source.wav');
        generateWav(media, 3);
        const project = join(dir, 'source.mosp');
        writeFileSync(project, JSON.stringify({ media, waveform: generateWaveformPayload(3000),
          segments: [{ id: 'a', start: 1000, end: 2000, text: 'Green preview' }] }));
        server = await startServer(project, media, await findFreePort());
      } else server = await startBlankServer(await findFreePort(), join(dir, '.settings'));
      await disableOnboarding(page);
      await page.goto(server.url);
      await page.waitForFunction(() => window.MaweAssFrame);
      if (kind === 'audio') {
        await page.waitForFunction(() => MaweCoreState.player.readyState >= 1);
        await page.evaluate(() => { MaweCoreState.player.currentTime = 1.5; });
        await expect.poll(() => page.evaluate(() => MaweCoreState.player.seeking)).toBe(false);
      }
      await openSettingsPage(page, 'subtitle-style');
      await page.locator('#ass-mode-toggle').check();
      await closeSettingsPanels(page);
      await page.locator('#ass-frame-quick-open').click();
      const image = page.locator('#ass-frame-image');
      await expect(image).toBeVisible();
      await expect(page.locator('#ass-frame-window-status')).toHaveText(hint);
      await expect(page.locator('#ass-frame-caption')).toContainText('1920 × 1080');
      if (kind === 'audio') await expect(page.locator('#ass-frame-caption')).toContainText('00:01.500');
      const pixel = await image.evaluate(el => {
        const canvas = document.createElement('canvas');
        canvas.width = el.naturalWidth; canvas.height = el.naturalHeight;
        const ctx = canvas.getContext('2d'); ctx.drawImage(el, 0, 0);
        return [...ctx.getImageData(0, 0, 1, 1).data];
      });
      expect(pixel[0]).toBeLessThan(5); expect(pixel[1]).toBeGreaterThan(245); expect(pixel[2]).toBeLessThan(5);
      const statusLayout = await page.locator('#ass-frame-window-status').evaluate(el => ({
        wrapping: getComputedStyle(el).whiteSpace,
        clipped: el.scrollWidth > el.clientWidth,
        closeGap: el.nextElementSibling.getBoundingClientRect().left - el.getBoundingClientRect().right,
      }));
      expect(statusLayout.wrapping).toBe('normal');
      expect(statusLayout.clipped).toBe(false);
      expect(statusLayout.closeGap).toBeGreaterThanOrEqual(8);
      console.log(`${kind} actual frame status layout: ${JSON.stringify(statusLayout)}`);
      await page.locator('#ass-frame-window').screenshot({ path: testInfo.outputPath(`ass-green-${kind}.png`) });
      await page.locator('#ass-frame-auto-toggle').uncheck();
      await page.locator('#ass-frame-render').click();
      await expect(page.locator('#ass-frame-window-status')).toHaveText(hint);
      await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
      await expect(page.locator('#ass-frame-window-status')).toContainText('Using a green screen preview');
    } finally {
      await server?.stop();
      cleanupTempDir(dir);
    }
  });
}
