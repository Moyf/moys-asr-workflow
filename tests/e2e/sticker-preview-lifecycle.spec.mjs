import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, closeSettingsPanels, disableOnboarding, findFreePort,
  generateWaveformPayload, makeTempDir, openSettingsPage, startServer } from './helpers.mjs';

let directory, media, project, roots, server;
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

test.beforeAll(() => {
  const filters = execFileSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' });
  test.skip(!/\bass\s+V->V/u.test(filters), 'Requires a libass-enabled FFmpeg');
  directory = realpathSync(makeTempDir('sticker-preview-lifecycle'));
  media = join(directory, 'synthetic.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=s=640x360:d=4:r=30', '-c:v', 'libx264', '-crf', '10', '-y', media]);
  roots = ['red', 'blue'].map(name => join(directory, name));
  roots.forEach(root => mkdirSync(root));
  execFileSync(process.env.MAW_E2E_PYTHON || 'python', ['-c',
    "from PIL import Image; import sys; Image.new('RGB',(24,24),'red').save(sys.argv[1]); Image.new('RGB',(24,24),'blue').save(sys.argv[2])",
    ...roots.map(root => join(root, 'demo.png'))]);
  project = join(directory, 'legacy.mosp');
  writeFileSync(project, JSON.stringify({ media: 'synthetic.mp4', sticker_root: roots[0],
    segments: [
      { start: 0, end: 1000, text: '第一句',
        sticker: { name: 'demo', filename: 'demo.png', rel: 'demo.png', start: 0, end: 1000 } },
      { start: 1000, end: 2600, text: '第二句', sticker_ref: { name: 'demo', headIdx: 0 } },
    ], waveform: generateWaveformPayload(4000) }));
});

test.beforeEach(async ({ page }) => {
  server = await startServer(project, media, await findFreePort());
  await disableOnboarding(page);
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({
      autoSaveProject: false, stickerOverlayEnabled: true,
    }));
  });
  await page.goto(server.url);
  await expect.poll(() => page.evaluate(() => window.MaweCoreState?.player?.videoWidth)).toBe(640);
});

test.afterEach(async () => { await server?.stop(); server = null; });
test.afterAll(() => { if (directory) cleanupTempDir(directory); });

async function seek(page, seconds) {
  await page.evaluate(time => { window.MaweCoreState.player.currentTime = time; }, seconds);
  await expect.poll(() => page.evaluate(() => window.MaweCoreState.player.seeking)).toBe(false);
}

async function openFrame(page) {
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-mode-toggle').check();
  await closeSettingsPanels(page);
  await seek(page, 0.5);
  await page.locator('#ass-frame-quick-open').click();
  await expect(page.locator('#ass-frame-caption')).toContainText('00:00.500');
  await expect(page.locator('#ass-frame-sticker-layer')).toBeVisible();
}

function stickerBoxError(page) {
  return page.evaluate(() => {
    const image = document.getElementById('ass-frame-image');
    const rect = image.getBoundingClientRect();
    const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    const expected = [rect.left + (rect.width - width) / 2,
      rect.top + (rect.height - height) / 2, width, height];
    const layer = document.getElementById('ass-frame-sticker-layer').getBoundingClientRect();
    return Math.max(...[layer.left, layer.top, layer.width, layer.height]
      .map((value, index) => Math.abs(value - expected[index])));
  });
}

test('server startup repairs legacy sticker groups before the first render', async ({ page }) => {
  expect(await page.evaluate(() => ({
    end: MaweBoot.DATA.segments[0].sticker.end,
    count: MaweStickerOverlay.activeStickersAt(1500).length,
  }))).toEqual({ end: 2600, count: 1 });
});

test('the actual frame reloads a same-name sticker after changing its directory', async ({ page }) => {
  await openFrame(page);
  const sticker = page.locator('#ass-frame-sticker-layer img');
  const previous = await sticker.getAttribute('src');
  await openSettingsPage(page, 'project-sticker');
  await page.locator('#project-sticker-root-input').fill(roots[1]);
  await page.locator('#project-sticker-root-read').click();
  await expect(page.locator('#project-sticker-root-status')).toContainText('读取 1 张');
  await closeSettingsPanels(page);
  await expect(sticker).not.toHaveAttribute('src', previous);
  await expect.poll(() => sticker.evaluate(async image => {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  })).toEqual([0, 0, 255]);
});

test('native frame stickers stay aligned after scrolling and rendering another frame', async ({ page }, testInfo) => {
  await openFrame(page);
  await page.locator('#ass-frame-window').evaluate(panel => {
    panel.style.width = '400px'; panel.style.height = '320px';
  });
  await page.locator('#ass-frame-size').click();
  await expect.poll(() => stickerBoxError(page)).toBeLessThanOrEqual(1.1);
  const scroll = await page.locator('.ass-frame-image-wrap').evaluate(wrap => {
    wrap.scrollTo(80, 40);
    return { left: wrap.scrollLeft, top: wrap.scrollTop };
  });
  expect(scroll.left).toBeGreaterThan(0);
  expect(scroll.top).toBeGreaterThan(0);
  await seek(page, 0.7);
  await expect(page.locator('#ass-frame-caption')).toContainText('00:00.700');
  await expect.poll(() => stickerBoxError(page)).toBeLessThanOrEqual(1.1);
  await page.screenshot({ path: testInfo.outputPath('native-sticker-alignment.png') });
  // The comparison layer shares the media replacement lifecycle from PR 295.
  await page.locator('#load-media-file').setInputFiles(media);
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.currentSrc.startsWith('blob:'))).toBe(true);
  await expect(page.locator('#ass-frame-sticker-layer')).toBeHidden();
  await expect(page.locator('#ass-frame-sticker-layer img')).toHaveCount(0);
});
