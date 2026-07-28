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

const EDITOR_SETTINGS_KEY = 'moy.asr.editor.settings.v1';
const JUMP_AND_PLAY_LABEL = '跳转到字幕并播放';
const TARGET_CUE_IDX = 1;
const TARGET_CUE_START_SEC = 50;

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('cue-context-seek');
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

async function openCueListContextMenu(page, idx) {
  const cue = page.locator(`.cue[data-idx="${idx}"]`);
  await expect(cue).toBeVisible();
  await cue.click({ button: 'right' });
}

test('cue-list context menu jumps to the subtitle and plays when click behavior is select-only', async ({ page }) => {
  // Given: the editor opens with the default select-only click behavior and loaded media.
  await page.goto(server.url);
  await expect(page.locator('#player-empty')).toBeHidden();

  // When: the user right-clicks a cue-list row and chooses the explicit jump-and-play action.
  await openCueListContextMenu(page, TARGET_CUE_IDX);
  const jumpAndPlayItem = page.locator('#ctxmenu .item', { hasText: JUMP_AND_PLAY_LABEL });
  await expect(jumpAndPlayItem).toBeVisible();
  await jumpAndPlayItem.click();

  // Then: the media playhead seeks to that cue start and playback is running.
  await expect.poll(() => page.evaluate(() => {
    const media = document.getElementById('player');
    return { currentTime: media.currentTime, paused: media.paused };
  })).toMatchObject({ paused: false });
  const currentTime = await page.evaluate(() => document.getElementById('player').currentTime);
  expect(currentTime).toBeGreaterThanOrEqual(TARGET_CUE_START_SEC - 0.5);
  expect(currentTime).toBeLessThanOrEqual(TARGET_CUE_START_SEC + 0.5);
});

test('cue-list context menu omits jump-and-play when click behavior is select-and-seek', async ({ page }) => {
  // Given: persisted settings switch the cue click behavior before the editor script reads storage.
  await page.addInitScript((settingsKey) => {
    localStorage.setItem(settingsKey, JSON.stringify({ clickBehavior: 'select-and-seek' }));
  }, EDITOR_SETTINGS_KEY);
  await page.goto(server.url);

  // When: the user opens the cue-list context menu.
  await openCueListContextMenu(page, TARGET_CUE_IDX);

  // Then: the explicit jump-and-play action is not shown because normal clicks already seek.
  await expect(page.locator('#ctxmenu .item', { hasText: JUMP_AND_PLAY_LABEL })).toHaveCount(0);
});
