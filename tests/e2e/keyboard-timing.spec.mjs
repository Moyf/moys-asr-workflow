import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  cleanupTempDir,
  DURATION_MS,
  findFreePort,
  generateProjectJson,
  generateWav,
  makeTempDir,
  startServer,
} from './helpers.mjs';

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('keyboardtiming');
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

async function loadAttachedCues(page) {
  await page.goto(server.url);
  await page.evaluate(() => {
    DATA.segments.splice(
      0,
      DATA.segments.length,
      { start: 5000, end: 10000, text: 'First', items: [{ start: 5000, end: 10000, text: 'First' }] },
      { start: 10000, end: 18000, text: 'Second', items: [{ start: 10000, end: 18000, text: 'Second' }] },
      { start: 25000, end: 30000, text: 'Third', items: [{ start: 25000, end: 30000, text: 'Third' }] },
    );
    renderAll();
  });
}

function readTimings(page) {
  return page.evaluate(() => DATA.segments.map(({ start, end }) => ({ start, end })));
}

async function selectedCueIndex(page) {
  return page.locator('.cue.selected').getAttribute('data-idx');
}

async function stableBoundingBox(locator) {
  let box = null;
  await expect.poll(async () => {
    try {
      box = await locator.boundingBox();
    } catch (_) {
      box = null;
    }
    return Boolean(box && box.width > 0 && box.height > 0);
  }).toBe(true);
  return box;
}

test('WASD during playback follows the playhead instead of the last selected cue', async ({ page }) => {
  await loadAttachedCues(page);
  await page.evaluate(() => {
    DATA.segments[2].start = 100000;
    DATA.segments[2].end = 110000;
    DATA.segments[2].items = [{ start: 100000, end: 110000, text: 'Third' }];
    renderAll();
  });
  await page.locator('.cue[data-idx="0"]').click();
  await page.evaluate(() => { player.currentTime = 101; });
  await page.locator('#media-play-toggle').click();
  await expect(page.locator('#media-play-toggle')).toHaveText('⏸');

  await page.keyboard.press('a');
  await expect.poll(() => selectedCueIndex(page)).toBe('1');
  await expect.poll(() => page.evaluate(() => player.currentTime)).toBeLessThan(11);

  await page.locator('#media-play-toggle').click();
  await page.locator('.cue[data-idx="0"]').click();
  await page.evaluate(() => { player.currentTime = 20; });
  await page.locator('#media-play-toggle').click();
  await expect(page.locator('#media-play-toggle')).toHaveText('⏸');

  await page.keyboard.press('d');
  await expect.poll(() => selectedCueIndex(page)).toBe('2');
  await expect.poll(() => page.evaluate(() => player.currentTime)).toBeGreaterThan(24);
});

test('selected arrow keys move cues, adjust boundaries, and honor the configured step', async ({ page }) => {
  await loadAttachedCues(page);
  await page.locator('#editor-settings-toggle').click();
  const step = page.locator('#cue-move-step');
  await expect(step).toHaveValue('50');
  await step.fill('250');
  await step.press('Tab');
  await page.locator('.cue[data-idx="0"]').click();

  await page.keyboard.press('ArrowRight');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5250, end: 10250 },
    { start: 10250, end: 18000 },
    { start: 25000, end: 30000 },
  ]);

  // Alt leaves the following cue fixed while the selected cue moves away.
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 10000 },
    { start: 10250, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
  // Moving back toward it still closes the gap, without moving the follower.
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5250, end: 10250 },
    { start: 10250, end: 18000 },
    { start: 25000, end: 30000 },
  ]);

  await page.keyboard.press('Control+ArrowLeft');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 10250 },
    { start: 10250, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
  await page.keyboard.press('Control+Shift+ArrowRight');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 10500 },
    { start: 10500, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
});

test('Shift+arrow keys snap selected subtitle boundaries to neighbors', async ({ page }) => {
  await loadAttachedCues(page);
  await page.evaluate(() => {
    DATA.segments[0].end = 9000;
    DATA.segments[1].start = 10000;
    DATA.segments[1].end = 18000;
    DATA.segments[2].start = 20000;
    renderAll();
  });
  await page.locator('.cue[data-idx="1"]').click();

  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9000 },
    { start: 9000, end: 18000 },
    { start: 20000, end: 30000 },
  ]);

  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9000 },
    { start: 9000, end: 20000 },
    { start: 20000, end: 30000 },
  ]);
});

test('A/D adjusts a held subtitle block and a held shared boundary', async ({ page }) => {
  await loadAttachedCues(page);
  await page.locator('#editor-settings-toggle').click();
  const step = page.locator('#cue-move-step');
  await step.fill('100');
  await step.press('Tab');

  const block = page.locator('.waveform-cue-block[data-idx="0"]').first();
  await expect(block).toBeVisible();
  const blockBox = await stableBoundingBox(block);
  await page.mouse.move(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2);
  await page.mouse.down();
  await page.keyboard.press('d');
  await page.mouse.up();
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5100, end: 10100 },
    { start: 10100, end: 18000 },
    { start: 25000, end: 30000 },
  ]);

  const boundary = page.locator('.waveform-cue-block[data-idx="0"] .waveform-cue-handle.right').first();
  await expect(boundary).toBeVisible();
  const boundaryBox = await stableBoundingBox(boundary);
  await page.mouse.move(boundaryBox.x + boundaryBox.width / 2, boundaryBox.y + boundaryBox.height / 2);
  await page.mouse.down();
  await page.keyboard.press('d');
  await page.mouse.up();
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5100, end: 10200 },
    { start: 10200, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
});

test('A also compresses an attached preceding cue', async ({ page }) => {
  await loadAttachedCues(page);
  await page.locator('#editor-settings-toggle').click();
  const step = page.locator('#cue-move-step');
  await step.fill('100');
  await step.press('Tab');

  const block = page.locator('.waveform-cue-block[data-idx="1"]').first();
  await expect(block).toBeVisible();
  const blockBox = await stableBoundingBox(block);
  await page.mouse.move(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2);
  await page.mouse.down();
  await page.keyboard.press('a');
  await page.mouse.up();
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9900 },
    { start: 9900, end: 17900 },
    { start: 25000, end: 30000 },
  ]);
});

test('Shift+A/D on a held subtitle snaps its outer boundaries to neighbors', async ({ page }) => {
  await loadAttachedCues(page);
  await page.evaluate(() => {
    DATA.segments[0].end = 9000;
    DATA.segments[1].start = 10000;
    DATA.segments[1].end = 18000;
    DATA.segments[2].start = 20000;
    renderAll();
  });
  await page.locator('#editor-settings-toggle').click();
  const block = page.locator('.waveform-cue-block[data-idx="1"]').first();
  await expect(block).toBeVisible();
  const blockBox = await stableBoundingBox(block);
  await page.mouse.move(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2);
  await page.mouse.down();
  await page.keyboard.press('Shift+a');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9000 },
    { start: 9000, end: 18000 },
    { start: 20000, end: 30000 },
  ]);
  await page.keyboard.press('Shift+d');
  await page.mouse.up();
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9000 },
    { start: 9000, end: 20000 },
    { start: 20000, end: 30000 },
  ]);
});
