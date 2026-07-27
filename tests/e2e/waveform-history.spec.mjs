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
  tempDir = makeTempDir('history');
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

test('undoing a waveform-created subtitle keeps redo available', async ({ page }) => {
  await page.goto(server.url);
  const row = page.locator('.waveform-row').filter({ has: page.locator('[data-idx="0"]') }).first();
  await expect(row).toBeVisible();

  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box.x + box.width * 0.9, box.y + 20, { button: 'right' });
  await page.locator('#ctxmenu .item', { hasText: '创建字幕' }).click();
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);

  await page.getByRole('button', { name: /撤销/ }).click();

  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(6);
  await expect(page.getByRole('button', { name: /重做/ })).toBeEnabled();
  await page.getByRole('button', { name: /重做/ }).click();
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);
});

test('waveform background split supports undo and redo', async ({ page }) => {
  await page.goto(server.url);
  const row = page.locator('.waveform-row').filter({ has: page.locator('[data-idx="0"]') }).first();
  await expect(row).toBeVisible();

  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box.x + box.width * 0.4, box.y + 20, { button: 'right' });
  const splitItem = page.locator('#ctxmenu .item', { hasText: '按音频位置拆分当前字幕' });
  await expect(splitItem).toBeEnabled();
  await splitItem.click();
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);
  await expect.poll(() => page.evaluate(() => DATA.segments.slice(0, 2).map((segment) => segment.text))).toEqual([
    'Al',
    'pha',
  ]);

  await page.getByRole('button', { name: /撤销/ }).click();
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(6);
  await expect.poll(() => page.evaluate(() => DATA.segments[0].text)).toBe('Alpha');
  await expect(page.getByRole('button', { name: /重做/ })).toBeEnabled();

  await page.getByRole('button', { name: /重做/ }).click();
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);
  await expect.poll(() => page.evaluate(() => DATA.segments.slice(0, 2).map((segment) => segment.text))).toEqual([
    'Al',
    'pha',
  ]);
});
