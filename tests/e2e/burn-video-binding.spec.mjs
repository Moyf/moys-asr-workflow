import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { stubAssFontCoverage } from './ass-font-readiness.mjs';
import { makeTempDir, cleanupTempDir, generateWav, generateWaveformPayload, startServer, findFreePort, disableOnboarding } from './helpers.mjs';

test('direct editor keeps the completed browser burn visible until dismissed', async ({ page }, info) => {
  test.setTimeout(120000);
  const dir = makeTempDir('burn-result');
  let server;
  try {
    const media = join(dir, 'source.mp4'), project = join(dir, 'captions.mosp');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=160x90:r=25:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media], { timeout: 30000 });
    fs.writeFileSync(project, JSON.stringify({ media, waveform: generateWaveformPayload(1000),
      segments: [{ id: 'a', start: 0, end: 800, text: 'Caption' }] }));
    server = await startServer(project, media, await findFreePort());
    await disableOnboarding(page);
    await stubAssFontCoverage(page);
    await page.addInitScript(() => {
      const chunks = [];
      window.showSaveFilePicker = async () => ({ name: 'completed.mp4', createWritable: async () => ({
        write: async chunk => chunks.push(chunk),
        close: async () => { window.savedBurn = new Blob(chunks); },
      }) });
    });
    await page.goto(server.url);
    await page.waitForFunction(() => window.MaweCoreState?.player?.currentSrc.includes('/media'));
    const toggle = page.locator('#ass-mode-quick-toggle');
    if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
    await page.locator('#burn-video-export-btn').click();
    const actions = page.locator('.hint-burn-actions');
    await expect(actions).toBeVisible({ timeout: 90000 });
    const card = actions.locator('..');
    await expect(card).toContainText('completed.mp4');
    expect(await page.evaluate(async () => new TextDecoder().decode(await window.savedBurn.slice(4, 8).arrayBuffer()))).toBe('ftyp');
    await page.evaluate(() => MaweHint.flashHint('Another action', 'info'));
    await expect(card).toBeVisible();
    expect(await actions.evaluate(el => el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(8);
    await card.screenshot({ path: info.outputPath('completed-burn.png') });
    await actions.getByRole('button').click();
    await expect(card).toHaveCount(0);
  } finally {
    await server?.stop();
    cleanupTempDir(dir);
  }
});

for (const kind of ['audio', 'video']) {
  test(`real editor revokes burn after replacing its source with browser ${kind}`, async ({ page }, testInfo) => {
    const dir = makeTempDir('burn-binding');
    let server;
    try {
      const source = join(dir, 'source.mp4'), project = join(dir, 'source.mosp');
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=green:s=160x90:r=25:d=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { timeout: 30000, stdio: 'pipe' });
      fs.writeFileSync(project, JSON.stringify({ media: source, waveform: generateWaveformPayload(1000),
        segments: [{ id: 'a', start: 0, end: 800, text: 'Caption' }] }));
      const replacement = kind === 'audio' ? generateWav(join(dir, 'replacement.wav'), 1) : source;
      const bytes = [...fs.readFileSync(replacement)];
      server = await startServer(project, source, await findFreePort());
      await disableOnboarding(page);
      await page.goto(server.url);
      await page.waitForFunction(() => window.MaweMediaLoad && window.MaweCoreState.player.currentSrc.includes('/media'));
      const toggle = page.locator('#ass-mode-quick-toggle');
      if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
      const burnButton = page.locator('#burn-video-export-btn');
      await expect(burnButton).toBeVisible();
      const jobsUrl = await page.evaluate(() => new URL(MaweBoot.SERVER_CONFIG.burnVideoJobsUrl, location.href).href);
      const admissions = [];
      page.on('request', request => {
        if (request.method() === 'POST' && request.url() === jobsUrl) admissions.push(request.url());
      });
      await page.route(jobsUrl, route => route.abort());
      await page.evaluate(() => {
        window.showSaveFilePicker = () => new Promise(resolve => {
          window.finishBurnPicker = () => resolve({
            name: 'result.mp4',
            createWritable: async () => { throw new Error('Stale burn unexpectedly opened the output'); },
          });
        });
      });
      await burnButton.click();
      await page.waitForFunction(() => typeof window.finishBurnPicker === 'function');
      await page.evaluate(async ({ bytes, kind }) => {
        await MaweMediaLoad.loadMediaFile(new File([new Uint8Array(bytes)],
          kind === 'audio' ? 'replacement.wav' : 'replacement.mp4', { type: kind === 'audio' ? 'audio/wav' : 'video/mp4' }));
      }, { bytes, kind });
      expect(await page.evaluate(() => ({ capable: MaweBoot.SERVER_CONFIG.canBurnVideoExport,
        source: MaweBoot.SERVER_CONFIG.burnVideoSourceName, jobs: MaweBoot.SERVER_CONFIG.burnVideoJobsUrl,
        blob: MaweCoreState.player.currentSrc.startsWith('blob:') }))).toEqual({ capable: false, source: null, jobs: null, blob: true });
      await page.evaluate(() => window.finishBurnPicker());
      await expect(page.locator('#hint-stack')).toContainText('工程或媒体绑定已变更');
      expect(admissions).toEqual([]);
      await expect(burnButton).toBeHidden();
      await page.evaluate(() => { MAWE_I18N.applyLanguage('en'); MaweGapRemovedMediaExport.updateButton(); });
      expect(await page.locator('#download-gap-removed-burn-video').evaluate(el => el.hidden)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('replaced-source.png') });
      await page.reload();
      await page.waitForFunction(() => window.MaweMediaLoad && window.MaweCoreState.player.currentSrc.includes('/media'));
      await page.evaluate(() => {
        MaweSettings.updateEditorSettings({ assMode: true });
        MaweProjectLoad.detachServerProjectSaving();
      });
      await expect(page.locator('#burn-video-export-btn')).toBeHidden();
      expect(await page.evaluate(() => MaweBoot.SERVER_CONFIG.canBurnVideoExport)).toBe(false);
    } finally {
      await server?.stop();
      cleanupTempDir(dir);
    }
  });
}
