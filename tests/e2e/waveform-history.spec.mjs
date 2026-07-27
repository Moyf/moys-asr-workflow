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

test('current-cue text keeps the list and waveform labels in sync through undo and redo', async ({ page }) => {
  await page.goto(server.url);

  const waveformCue = page.locator('.waveform-cue-block[data-idx="0"]').first();
  const waveformLabel = waveformCue.locator('.waveform-cue-label');
  const listText = page.locator('.cue[data-idx="0"] .text');
  const panelText = page.locator('#cue-panel-text');
  const undo = page.getByRole('button', { name: /撤销/ });
  const redo = page.getByRole('button', { name: /重做/ });

  await waveformCue.click();
  await expect(panelText).toHaveValue('Alpha');
  await expect(listText).toHaveText('Alpha');
  await expect(waveformLabel).toHaveText('Alpha');

  await panelText.fill('Alpha revised');
  await expect(listText).toHaveText('Alpha revised');
  await expect(waveformLabel).toHaveText('Alpha revised');

  await panelText.blur();
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(listText).toHaveText('Alpha');
  await expect(waveformLabel).toHaveText('Alpha');
  await expect(redo).toBeEnabled();

  await redo.click();
  await expect(listText).toHaveText('Alpha revised');
  await expect(waveformLabel).toHaveText('Alpha revised');
});

test('B splits the subtitle under the waveform playhead and supports undo and redo', async ({ page }) => {
  await page.goto(server.url);
  await page.evaluate(() => {
    const player = document.getElementById('player');
    player.currentTime = 5;
    player.dispatchEvent(new Event('timeupdate'));
  });

  await page.keyboard.press('b');
  await expect.poll(() => page.locator('.cue').count()).toBe(7);
  await expect(page.locator('.cue .text').nth(0)).toHaveText('Al');
  await expect(page.locator('.cue .text').nth(1)).toHaveText('pha');

  await page.getByRole('button', { name: /撤销/ }).click();
  await expect.poll(() => page.locator('.cue').count()).toBe(6);
  await expect(page.locator('.cue .text').first()).toHaveText('Alpha');

  await page.getByRole('button', { name: /重做/ }).click();
  await expect.poll(() => page.locator('.cue').count()).toBe(7);
  await expect(page.locator('.cue .text').nth(0)).toHaveText('Al');
  await expect(page.locator('.cue .text').nth(1)).toHaveText('pha');
});

test('B does not split in a gap or while editing text', async ({ page }) => {
  await page.goto(server.url);
  await page.evaluate(() => {
    const player = document.getElementById('player');
    player.currentTime = 20;
    player.dispatchEvent(new Event('timeupdate'));
  });
  await page.keyboard.press('b');
  await expect(page.locator('.cue')).toHaveCount(6);
  await expect(page.locator('#hint')).toContainText('播放头位置没有可拆分字幕');

  const firstCue = page.locator('.waveform-cue-block[data-idx="0"]').first();
  await firstCue.click();
  const panelText = page.locator('#cue-panel-text');
  await panelText.focus();
  await page.keyboard.press('b');
  await expect(panelText).toHaveValue('Alphab');
  await expect(page.locator('.cue')).toHaveCount(6);
});

test('help reflects the selected subtitle-edit split key', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#help-toggle').click();

  const settingsPanel = page.locator('#editor-settings-panel');
  const displayRows = settingsPanel.locator('.editor-settings-display-row');
  const splitKey = page.locator('#split-key');
  const helpSplitKey = page.locator('#help-split-key');
  await expect(settingsPanel).not.toContainText('波形区拆分按键');
  await expect(displayRows).toHaveCount(2);
  const rowBoxes = await displayRows.evaluateAll((rows) => rows.map((row) => {
    const rect = row.getBoundingClientRect();
    const childTops = [...row.children].map((child) => child.getBoundingClientRect().top);
    return { top: rect.top, height: rect.height, childTops };
  }));
  expect(rowBoxes[1].top).toBeGreaterThanOrEqual(rowBoxes[0].top + rowBoxes[0].height);
  for (const row of rowBoxes) {
    expect(Math.max(...row.childTops) - Math.min(...row.childTops)).toBeLessThan(3);
  }
  await expect(helpSplitKey).toHaveText('Ctrl+Enter');
  await expect(page.locator('#help-waveform-split-key')).toHaveText('B');

  await splitKey.selectOption('enter');
  await expect(helpSplitKey).toHaveText('Enter');

  await splitKey.selectOption('ctrl-enter');
  await expect(helpSplitKey).toHaveText('Ctrl+Enter');
});

test('waveform toolbar exposes grouped icon controls and selected cues use a yellow border', async ({ page }) => {
  await page.goto(server.url);

  const utilityGroup = page.locator('.toolbar-utility-group');
  const selectTool = page.locator('[data-waveform-tool="select"]');
  const splitTool = page.locator('[data-waveform-tool="razor"]');
  await expect(utilityGroup).toHaveAttribute('role', 'group');
  await expect(utilityGroup.locator('#editor-settings-toggle')).toBeVisible();
  await expect(utilityGroup.locator('#help-toggle')).toBeVisible();
  await expect(selectTool.locator('svg')).toHaveCount(1);
  await expect(splitTool).toContainText('分割');
  await expect(splitTool.locator('svg')).toHaveCount(1);
  await expect(page.locator('#help-toggle svg')).toHaveCount(1);

  const cue = page.locator('.waveform-cue-block[data-idx="0"]').first();
  await cue.click();
  await expect(cue).toHaveCSS('border-top-color', 'rgb(255, 213, 74)');
});

test('context-menu subtitle deletion is immediate and undoable', async ({ page }) => {
  await page.goto(server.url);
  let confirmationShown = false;
  page.on('dialog', async (dialog) => {
    confirmationShown = true;
    await dialog.dismiss();
  });

  const cue = page.locator('.waveform-cue-block[data-idx="0"]').first();
  await cue.click({ button: 'right' });
  await page.locator('#ctxmenu .item', { hasText: '删除字幕' }).click();

  await expect(page.locator('.cue')).toHaveCount(5);
  expect(confirmationShown).toBe(false);
  await page.getByRole('button', { name: /撤销/ }).click();
  await expect(page.locator('.cue')).toHaveCount(6);
});
