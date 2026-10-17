import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeTempDir, cleanupTempDir, generateWav, generateWaveformPayload,
  startServer, findFreePort, disableOnboarding, openSettingsPage } from './helpers.mjs';

for (const kind of ['audio', 'video']) {
  test(`green screen export is available for ${kind} and persists the audio preference`, async ({ page }, testInfo) => {
    const dir = makeTempDir('green-screen');
    let server;
    try {
      const media = join(dir, kind === 'audio' ? 'source.wav' : 'source.mp4');
      if (kind === 'audio') generateWav(media, 1);
      else execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i',
        'color=green:s=160x90:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media],
      { timeout: 30000, stdio: 'pipe' });
      const project = join(dir, 'source.mosp');
      fs.writeFileSync(project, JSON.stringify({ media, waveform: generateWaveformPayload(1000),
        segments: [{ id: 'a', start: 0, end: 800, text: 'Caption' }] }));
      server = await startServer(project, media, await findFreePort());
      await disableOnboarding(page);
      await page.goto(server.url);
      await page.waitForFunction(() => window.MaweBurnVideoExport && MaweCoreState.player.currentSrc.includes('/media'));
      expect(await page.evaluate(() => MaweSettings.EDITOR_SETTINGS.assMode)).toBe(false);
      await page.locator('#extra-export-btn').click();
      await expect(page.locator('#download-green-screen-video')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`green-menu-${kind}.png`) });
      await page.locator('#extra-export-btn').click();
      await openSettingsPage(page, 'export-more');
      const toggle = page.locator('#green-screen-include-audio');
      await expect(toggle).not.toBeChecked();
      await expect(page.locator('[data-settings-export="download-green-screen-video"]')).toBeEnabled();
      const gap = await page.locator('#export-green-screen-title + .editor-settings-group .editor-settings-sub-group').evaluate(el => {
        const [label, hint, button] = el.children;
        return { gap: parseFloat(getComputedStyle(el).rowGap),
          labelToHint: hint.getBoundingClientRect().top - label.getBoundingClientRect().bottom,
          hintToButton: button.getBoundingClientRect().top - hint.getBoundingClientRect().bottom };
      });
      expect(gap.gap).toBeGreaterThanOrEqual(8);
      expect(gap.labelToHint).toBeGreaterThanOrEqual(8);
      expect(gap.hintToButton).toBeGreaterThanOrEqual(8);
      console.log(`${kind} green screen settings spacing: ${JSON.stringify(gap)}`);
      await testInfo.attach('spacing', { body: JSON.stringify(gap), contentType: 'application/json' });
      await toggle.check();
      await page.screenshot({ path: testInfo.outputPath(`green-settings-${kind}.png`) });
      await page.reload();
      await page.waitForFunction(() => window.MaweBurnVideoExport);
      await openSettingsPage(page, 'export-more');
      await expect(toggle).toBeChecked();
      await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
      await expect(page.locator('#export-green-screen-title')).toHaveText('Green screen video export');
      await expect(page.locator('[data-settings-export="download-green-screen-video"]')).toHaveText('Generate green screen video');
      await page.evaluate(() => MaweProjectLoad.detachServerProjectSaving());
      await expect(page.locator('[data-settings-export="download-green-screen-video"]')).toBeDisabled();
      expect(await page.locator('#download-green-screen-video').evaluate(el => el.hidden)).toBe(true);
    } finally {
      await server?.stop();
      cleanupTempDir(dir);
    }
  });
}
