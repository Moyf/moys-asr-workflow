import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  cleanupTempDir,
  disableOnboarding,
  DURATION_MS,
  findFreePort,
  generateProjectJson,
  generateWav,
  makeTempDir,
  startServer,
} from './helpers.mjs';

const EDITOR_SETTINGS_KEY = 'moy.asr.editor.settings.v1';
// 默认 secondsPerRow=10：第一行波形覆盖 0–10s，行内水平比例即时间比例。
const FIRST_ROW_DURATION_SEC = 10;

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('hover-seek-preview');
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

async function openEditorWithMedia(page) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await expect(page.locator('#player-empty')).toBeHidden();
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0;
  });
}

// 悬停预览用 rAF 合并、每帧最多 seek 一次；等够数帧后才能稳定断言“是否发生”。
async function waitForHoverSeekFrames(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
}

// 把指针移到第一行波形的水平 ratio 处，返回该行映射的媒体时间（秒）。
async function hoverFirstWaveformRow(page, ratio) {
  const row = page.locator('.waveform-row[data-row-index="0"]');
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width * ratio, box.y + box.height * 0.5, { steps: 5 });
  return ratio * FIRST_ROW_DURATION_SEC;
}

test('hover seek preview defaults off and hovering the waveform does not seek', async ({ page }) => {
  // Given: no persisted preference; the player 媒体设置 panel exposes the toggle unchecked.
  await openEditorWithMedia(page);
  await page.locator('#subtitle-preview-settings-toggle').click();
  const toggle = page.getByRole('checkbox', { name: '自动预览鼠标位置画面' });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await page.locator('#subtitle-preview-settings-toggle').click();

  // When: the pointer moves across the first waveform row.
  await hoverFirstWaveformRow(page, 0.5);
  await waitForHoverSeekFrames(page);

  // Then: the paused media stays at the beginning.
  const state = await page.evaluate(() => {
    const player = document.getElementById('player');
    return { currentTime: player.currentTime, paused: player.paused };
  });
  expect(state.paused).toBe(true);
  expect(state.currentTime).toBeLessThan(0.5);
});

test('hover seek preview seeks paused media to the pointer time', async ({ page }) => {
  // Given: the preference is enabled before the editor reads storage.
  await page.addInitScript((settingsKey) => {
    localStorage.setItem(settingsKey, JSON.stringify({ hoverSeekPreview: true }));
  }, EDITOR_SETTINGS_KEY);
  await openEditorWithMedia(page);

  // When: the pointer moves to the middle of the first waveform row.
  const targetSec = await hoverFirstWaveformRow(page, 0.5);

  // Then: the still-paused media seeks to the pointer time.
  await waitForHoverSeekFrames(page);
  await expect.poll(() => page.evaluate(() => document.getElementById('player').paused)).toBe(true);
  const currentTime = await page.evaluate(() => document.getElementById('player').currentTime);
  expect(currentTime).toBeGreaterThanOrEqual(targetSec - 0.5);
  expect(currentTime).toBeLessThanOrEqual(targetSec + 0.5);
});

test('hover seek preview does not seek while media is playing', async ({ page }) => {
  // Given: the preference is enabled and playback is running.
  await page.addInitScript((settingsKey) => {
    localStorage.setItem(settingsKey, JSON.stringify({ hoverSeekPreview: true }));
  }, EDITOR_SETTINGS_KEY);
  await openEditorWithMedia(page);
  await page.locator('#media-play-toggle').click();
  await page.waitForFunction(() => !document.getElementById('player').paused);

  // When: the pointer moves to the far end of the first waveform row.
  const hoverSec = await hoverFirstWaveformRow(page, 0.9);
  await waitForHoverSeekFrames(page);

  // Then: playback continues without jumping to the pointer time.
  const state = await page.evaluate(() => {
    const player = document.getElementById('player');
    return { currentTime: player.currentTime, paused: player.paused };
  });
  expect(state.paused).toBe(false);
  expect(state.currentTime).toBeLessThan(hoverSec - 1.5);
});
