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
  tempDir = makeTempDir('playback-refresh');
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

test('playback refreshes the subtitle preview and playhead without timeupdate', async ({ page }) => {
  // Disable only the page's timeupdate listeners. Native playback still advances;
  // the test proves that the playback-frame loop is the independent visual path.
  await page.addInitScript(() => {
    const addEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function patchedAddEventListener(type, listener, options) {
      if (type === 'timeupdate' && this instanceof HTMLMediaElement) return;
      return addEventListener.call(this, type, listener, options);
    };
  });
  await page.goto(server.url);
  await page.waitForFunction(() => {
    const media = document.getElementById('player');
    return media.readyState >= 1 && Number.isFinite(media.duration) && media.duration > 0;
  });

  await page.evaluate(() => {
    DATA.segments.splice(
      0,
      DATA.segments.length,
      { start: 0, end: 100, text: 'First', items: [] },
      { start: 100, end: 10000, text: 'Second', items: [] },
    );
    DATA.multi_subtitle = {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1',
        role: 'extension',
        name: 'Extension',
        language: 'English',
        split_mode: 'word',
        source_name: 'extension.srt',
        segments: [
          { start: 0, end: 100, text: 'First extension' },
          { start: 100, end: 10000, text: 'Second extension' },
        ],
      }],
      bindings: [],
    };
    const media = document.getElementById('player');
    media.currentTime = 0.02;
    renderAll();
    document.getElementById('extension-overlay-toggle').checked = true;
    update();
  });
  await expect(page.locator('#overlay-main-text')).toHaveText('First');
  await expect(page.locator('#overlay-extension-text')).toHaveText('First extension');

  const before = await page.evaluate(() => {
    const playhead = [...document.querySelectorAll('.waveform-playhead')].find((element) => !element.hidden);
    return playhead ? Number.parseFloat(playhead.style.left) : null;
  });
  expect(before).not.toBeNull();

  await page.evaluate(async () => {
    const media = document.getElementById('player');
    media.playbackRate = 1;
    await media.play();
  });
  await expect(page.locator('#overlay-main-text')).toHaveText('Second', { timeout: 2000 });
  await expect(page.locator('#overlay-extension-text')).toHaveText('Second extension', { timeout: 2000 });

  const after = await page.evaluate(() => {
    const playhead = [...document.querySelectorAll('.waveform-playhead')].find((element) => !element.hidden);
    return playhead ? Number.parseFloat(playhead.style.left) : null;
  });
  expect(after).not.toBeNull();
  expect(after).toBeGreaterThan(before);
});

test('JKL direction mode drives the timeline backward and forward', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForFunction(() => {
    const media = document.getElementById('player');
    return media.readyState >= 1 && Number.isFinite(media.duration) && media.duration > 0;
  });

  await page.locator('#editor-settings-toggle').click();
  await expect(page.locator('#jkl-playback-mode')).toHaveValue('direction');
  await expect(page.locator('#jkl-playback-mode-hint')).toContainText('无反向声音');

  await page.evaluate(() => {
    const media = document.getElementById('player');
    media.pause();
    media.currentTime = 20;
    media.dispatchEvent(new Event('timeupdate'));
  });
  await page.keyboard.press('j');
  await expect.poll(() => page.evaluate(() => document.getElementById('player').currentTime)).toBeLessThan(19.8);
  await expect(page.locator('#media-playback-rate')).toHaveValue('-1');
  await expect(page.locator('#media-playback-rate option:checked')).toHaveText('-1×');
  for (const rate of ['-2', '-4', '-8', '-16']) {
    await page.keyboard.press('j');
    await expect(page.locator('#media-playback-rate')).toHaveValue(rate);
  }

  const stoppedAt = await page.evaluate(() => document.getElementById('player').currentTime);
  await page.keyboard.press('k');
  await expect(page.locator('#media-playback-rate')).toHaveValue('1');
  await expect.poll(() => page.evaluate(() => document.getElementById('player').paused)).toBe(true);
  await expect.poll(() => page.evaluate((expected) => {
    return Math.abs(document.getElementById('player').currentTime - expected);
  }, stoppedAt)).toBeLessThan(0.01);

  await page.keyboard.press('k');
  await expect(page.locator('#media-playback-rate')).toHaveValue('1');
  await expect.poll(() => page.evaluate(() => document.getElementById('player').paused)).toBe(false);
  await expect.poll(() => page.evaluate((expected) => {
    return document.getElementById('player').currentTime - expected;
  }, stoppedAt)).toBeGreaterThan(0.1);

  await page.keyboard.press(' ');
  await expect.poll(() => page.evaluate(() => document.getElementById('player').paused)).toBe(true);
  const pausedForwardAt = await page.evaluate(() => document.getElementById('player').currentTime);
  await page.keyboard.press('j');
  await expect(page.locator('#media-playback-rate')).toHaveValue('-1');
  await expect.poll(() => page.evaluate((expected) => {
    return expected - document.getElementById('player').currentTime;
  }, pausedForwardAt)).toBeGreaterThan(0.1);

  await page.keyboard.press('l');
  await expect(page.locator('#media-playback-rate')).toHaveValue('1');
  await expect.poll(() => page.evaluate((expected) => {
    return document.getElementById('player').currentTime - expected;
  }, pausedForwardAt)).toBeGreaterThan(0.1);

  await page.keyboard.press('k');
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#jkl-playback-mode').selectOption('speed');
  await page.locator('#editor-settings-toggle').click();
  await page.keyboard.press('j');
  await expect.poll(() => page.evaluate(() => document.getElementById('player').playbackRate)).toBe(0.5);
});
