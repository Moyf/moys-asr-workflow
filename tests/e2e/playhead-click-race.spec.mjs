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
  tempDir = makeTempDir('playhead-click-race');
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

test('blank waveform click keeps its time when the row is rebuilt before pointerup', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0;
  });
  await page.evaluate(() => {
    MaweBoot.DATA.segments.push(
      { start: 60000, end: 62000, text: 'Next row first cue', items: [] },
      { start: 67000, end: 68000, text: 'Next row second cue', items: [] },
    );
    MaweCuePanel.renderAll();
  });

  await page.evaluate(() => {
    document.getElementById('waveform-scroll').scrollTop = 5 * (120 + 10);
  });
  const selectedWaveformCue = page.locator('.waveform-cue-block[data-idx="1"]').first();
  await expect(selectedWaveformCue).toBeVisible();
  await selectedWaveformCue.click();
  await expect(selectedWaveformCue).toHaveClass(/selected/);
  await page.keyboard.press('f');
  await page.waitForFunction(() => !document.getElementById('player').paused);

  await page.evaluate(() => {
    document.getElementById('waveform-scroll').scrollTop = 6 * (120 + 10);
  });
  const row = page.locator('.waveform-row[data-row-index="6"]');
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  const clickX = box.x + box.width * 0.5;
  const expectedTime = 60 + ((clickX - box.x) / box.width) * 10;
  await page.mouse.move(clickX, box.y + 20);
  await page.mouse.down();
  await page.evaluate(() => document.querySelector('.waveform-row[data-row-index="6"]')?.remove());
  await page.mouse.up();

  await page.waitForFunction((expected) => {
    const player = document.getElementById('player');
    return player.currentTime >= expected - 0.5 && player.currentTime <= expected + 0.5;
  }, expectedTime, { timeout: 5000 });
  await page.waitForFunction(() => !document.getElementById('player').paused);
});
