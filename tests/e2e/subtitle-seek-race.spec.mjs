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
  tempDir = makeTempDir('subtitle-seek-race');
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

async function waitForMedia(page) {
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0;
  });
}

async function setClickTarget(page, value) {
  await page.evaluate((next) => {
    const select = document.getElementById('click-target');
    select.value = next;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test('clicking a waveform subtitle preserves the clicked time while playing', async ({ page }) => {
  await page.goto(server.url);
  await waitForMedia(page);
  await page.evaluate(() => {
    const player = document.getElementById('player');
    player.currentTime = 1;
  });
  await page.keyboard.press(' ');
  await page.waitForFunction(() => !document.getElementById('player').paused);

  await setClickTarget(page, 'pointer');
  await page.evaluate(() => {
    document.getElementById('waveform-scroll').scrollTop = 5 * (120 + 10);
  });
  const block = page.locator('.waveform-cue-block[data-idx="1"]').first();
  await expect(block).toBeVisible();
  const box = await block.boundingBox();
  expect(box).not.toBeNull();
  const clickX = box.x + box.width * 0.65;
  const clickY = box.y + box.height / 2;
  const row = page.locator('.waveform-row').filter({ has: block }).first();
  const rowBox = await row.boundingBox();
  expect(rowBox).not.toBeNull();
  const expectedTime = 50 + ((clickX - rowBox.x) / rowBox.width) * 10;

  await page.mouse.move(clickX, clickY);
  await page.mouse.down();
  const timeOnPointerDown = await page.evaluate(() => document.getElementById('player').currentTime);
  expect(timeOnPointerDown).toBeGreaterThan(45);
  await page.mouse.up();

  await page.waitForFunction((expected) => {
    const actual = document.getElementById('player').currentTime;
    return Math.abs(actual - expected) < 0.5;
  }, expectedTime);
  await page.waitForFunction(() => !document.getElementById('player').paused);
});

test('clicking a waveform subtitle while paused seeks to the pointer position', async ({ page }) => {
  await page.goto(server.url);
  await waitForMedia(page);
  await setClickTarget(page, 'pointer');
  await page.evaluate(() => {
    document.getElementById('waveform-scroll').scrollTop = 5 * (120 + 10);
  });
  const block = page.locator('.waveform-cue-block[data-idx="1"]').first();
  await expect(block).toBeVisible();
  const box = await block.boundingBox();
  expect(box).not.toBeNull();
  const row = page.locator('.waveform-row').filter({ has: block }).first();
  const rowBox = await row.boundingBox();
  expect(rowBox).not.toBeNull();
  const clickX = box.x + box.width * 0.65;
  const clickY = box.y + box.height / 2;
  const expectedTime = 50 + ((clickX - rowBox.x) / rowBox.width) * 10;

  await page.mouse.click(clickX, clickY);

  await page.waitForFunction((expected) => {
    const player = document.getElementById('player');
    return Math.abs(player.currentTime - expected) < 0.5 && player.paused;
  }, expectedTime);
});

test('the default waveform subtitle target follows the pointer', async ({ page }) => {
  await page.goto(server.url);
  await waitForMedia(page);
  await page.locator('#editor-settings-toggle').click();
  await expect(page.locator('#click-target')).toHaveValue('pointer');
  await expect(page.locator('#click-target-field')).toBeVisible();
  await page.evaluate(() => {
    document.getElementById('waveform-scroll').scrollTop = 5 * (120 + 10);
  });
  const block = page.locator('.waveform-cue-block[data-idx="1"]').first();
  await expect(block).toBeVisible();
  let box;
  await expect.poll(async () => {
    box = await block.boundingBox();
    return box !== null;
  }).toBe(true);

  await page.mouse.click(box.x + box.width * 0.65, box.y + box.height / 2);

  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return Math.abs(player.currentTime - 55.2) < 0.5 && player.paused;
  });
});

test('F seeks directly to the selected subtitle without an intermediate row-end seek', async ({ page }) => {
  await page.goto(server.url);
  await waitForMedia(page);
  await setClickTarget(page, 'pointer');
  await page.evaluate(() => { document.getElementById('player').currentTime = 100; });

  await page.evaluate(() => {
    document.getElementById('waveform-scroll').scrollTop = 5 * (120 + 10);
  });
  const block = page.locator('.waveform-cue-block[data-idx="1"]').first();
  await expect(block).toBeVisible();
  const box = await block.boundingBox();
  expect(box).not.toBeNull();
  await page.evaluate(() => {
    const player = document.getElementById('player');
    window.__seekTrace = [];
    player.addEventListener('seeking', () => window.__seekTrace.push(player.currentTime));
  });
  const clickX = box.x + box.width / 2;
  const clickY = box.y + box.height / 2;
  await page.mouse.move(clickX, clickY);
  await page.mouse.down();
  await page.evaluate(() => renderAll());
  await page.mouse.up();
  await page.keyboard.press('f');

  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return player.currentTime >= 50 && player.currentTime < 51 && !player.paused;
  });
  const seekTrace = await page.evaluate(() => window.__seekTrace);
  expect(seekTrace.some((time) => time >= 59.5 && time <= 60.5)).toBe(false);
});

test('waveform subtitle click keeps its time when the row is rebuilt before pointerup', async ({ page }) => {
  await page.goto(server.url);
  await waitForMedia(page);
  await setClickTarget(page, 'pointer');
  await page.evaluate(() => {
    document.getElementById('waveform-scroll').scrollTop = 5 * (120 + 10);
  });
  const block = page.locator('.waveform-cue-block[data-idx="1"]').first();
  await expect(block).toBeVisible();
  const box = await block.boundingBox();
  expect(box).not.toBeNull();
  const row = page.locator('.waveform-row').filter({ has: block }).first();
  const rowBox = await row.boundingBox();
  expect(rowBox).not.toBeNull();
  const clickX = box.x + box.width * 0.65;
  const clickY = box.y + box.height / 2;
  const expectedTime = 50 + ((clickX - rowBox.x) / rowBox.width) * 10;

  await page.mouse.move(clickX, clickY);
  await page.mouse.down();
  await page.evaluate(() => renderAll());
  await page.mouse.up();

  await page.waitForFunction((expected) => {
    const actual = document.getElementById('player').currentTime;
    return Math.abs(actual - expected) < 0.5;
  }, expectedTime);
});
