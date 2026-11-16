import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir, disableOnboarding, findFreePort, generateWaveformPayload,
  generateWav, makeTempDir, startServer,
} from './helpers.mjs';

let folder, server;
test.beforeAll(async () => {
  folder = makeTempDir('waveform-click-seek');
  const media = join(folder, 'synthetic.wav');
  const project = join(folder, 'project.json');
  generateWav(media, 20);
  writeFileSync(project, JSON.stringify({
    media: 'synthetic.wav',
    segments: [{ id: 'main-a', start: 1000, end: 9000, text: '>>FADE and HOLD A B<<', items: [] }],
    overlay_track: { enabled: true, segments: [{ id: 'overlay-a', start: 1000, end: 9000, text: 'OVERLAY subtitle' }] },
    multi_subtitle: { schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
      tracks: [{ id: 'secondary', role: 'extension', name: 'Translation', segments: [
        { id: 'secondary-a', start: 1000, end: 9000, text: 'Extension subtitle' },
      ] }], bindings: [] },
    waveform: generateWaveformPayload(20_000),
  }));
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(folder);
});

for (const target of ['pointer', 'cue-start']) {
  for (const track of ['main', 'overlay', 'extension']) {
    test(`${target}: ${track} block follows the saved jump target at two interior positions`, async ({ page }, testInfo) => {
      await disableOnboarding(page);
      await page.addInitScript(clickTarget => {
        localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({
          autoSaveProject: false, clickBehavior: 'select-and-seek', clickTarget,
          assMode: true, assSpecialSymbolRule: 'both',
        }));
      }, target);
      await page.goto(server.url);
      await page.waitForFunction(() => document.getElementById('player').readyState >= 1);
      await expect(page.locator('#click-target')).toHaveValue(target);
      const selector = `.waveform-cue-block[data-track="${track}"]`;
      for (const fraction of [0.35, 0.7]) {
        const block = page.locator(selector).first();
        await block.scrollIntoViewIfNeeded();
        const point = await block.evaluate((element, ratio) => {
          const row = element.closest('.waveform-row');
          const rect = row.getBoundingClientRect();
          const cue = element.getBoundingClientRect();
          const x = cue.left + cue.width * ratio;
          const start = Number(row.dataset.startMs), end = Number(row.dataset.endMs);
          return { x, y: cue.top + cue.height / 2,
            time: (start + (x - rect.left - row.clientLeft) / row.clientWidth * (end - start)) / 1000 };
        }, fraction);
        await page.mouse.move(point.x, point.y);
        const row = page.locator('.waveform-row').filter({ has: page.locator(selector) }).first();
        await expect.poll(async () => {
          const box = await row.locator('.waveform-pointer-line').boundingBox();
          return box ? Math.abs(box.x + box.width / 2 - point.x) : Infinity;
        }).toBeLessThan(2);
        await page.mouse.click(point.x, point.y);
        const expected = target === 'pointer' ? point.time : 1;
        await expect.poll(() => page.evaluate(
          time => Math.abs(document.getElementById('player').currentTime - time), expected,
        )).toBeLessThan(0.05);
        await expect.poll(async () => row.evaluate((element, time) => {
          const red = element.querySelector('.waveform-playhead');
          const start = Number(element.dataset.startMs), end = Number(element.dataset.endMs);
          const expectedLeft = (time * 1000 - start) / (end - start) * element.clientWidth;
          const actualLeft = Number.parseFloat(red.style.left) / 100 * element.clientWidth;
          return red.hidden ? Infinity : Math.abs(actualLeft - expectedLeft);
        }, expected)).toBeLessThan(2);
      }
      if (track === 'main') await page.locator('#waveform-pane').screenshot({ path: testInfo.outputPath(`${target}.png`) });
    });
  }
}
