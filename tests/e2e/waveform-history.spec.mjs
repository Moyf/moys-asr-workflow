import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  cleanupTempDir,
  DURATION_MS,
  findFreePort,
  generateProjectJson,
  generateWav,
  makeFirstCueWordSplittable,
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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false }));
  });
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

test('blank waveform context menu disables subtitle creation over an existing cue', async ({ page }) => {
  await page.goto(server.url);
  const row = page.locator('.waveform-row').first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.click(box.x + box.width * 0.4, box.y + 20, { button: 'right' });
  const createItem = page.locator('#ctxmenu .item', { hasText: '创建字幕' });
  await expect(createItem).toHaveClass(/disabled/);
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(6);
});

test('N creates a subtitle at the waveform pointer and focuses the new cue', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('.player-stage').hover();
  await page.keyboard.press('n');
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(6);

  const row = page.locator('.waveform-row').first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  const pointer = { x: box.x + box.width * 0.85, y: box.y + 20 };
  await page.mouse.move(pointer.x, pointer.y);
  await page.keyboard.press('n');

  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);
  await expect(page.locator('.cue[data-idx="1"]')).toHaveClass(/selected/);
  await expect.poll(() => page.evaluate(() => window.MAWE_EDITOR_BRIDGE.currentCuePanelIdx)).toBe(1);
  await expect(page.locator('#cue-panel-text')).toHaveValue('');
  await expect(page.locator('#cue-panel-text')).toBeFocused();
  await expect(page.locator('.cue[data-idx="1"] .text')).not.toHaveAttribute('contenteditable', 'plaintext-only');
  const created = await page.evaluate(() => DATA.segments[1]);
  expect(created.start).toBeGreaterThanOrEqual(8000);
  expect(created.end - created.start).toBe(1000);
});

test('Ctrl+dragging blank waveform creates the dragged duration and focuses the new cue', async ({ page }) => {
  await page.goto(server.url);
  const row = page.locator('.waveform-row').first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  const startX = box.x + box.width * 0.84;
  const endX = box.x + box.width * 0.94;
  const y = box.y + 20;

  await page.keyboard.down('Control');
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(endX, y, { steps: 6 });
  const preview = page.locator('.waveform-create-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveClass(/waveform-cue-block/);
  const previewStyle = await preview.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      opacity: Number(style.opacity),
      height: Number.parseFloat(style.height),
      borderStyle: style.borderTopStyle,
      bottom: style.bottom,
    };
  });
  expect(previewStyle.opacity).toBeLessThan(1);
  expect(previewStyle.height).toBeLessThan(box.height);
  expect(previewStyle.borderStyle).toBe('dashed');
  expect(previewStyle.bottom).toBe('7px');
  await page.mouse.up();
  await page.keyboard.up('Control');

  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);
  await expect(page.locator('.cue[data-idx="1"]')).toHaveClass(/selected/);
  await expect.poll(() => page.evaluate(() => window.MAWE_EDITOR_BRIDGE.currentCuePanelIdx)).toBe(1);
  await expect(page.locator('#cue-panel-text')).toBeFocused();
  await expect(page.locator('.cue[data-idx="1"] .text')).not.toHaveAttribute('contenteditable', 'plaintext-only');
  const created = await page.evaluate(() => DATA.segments[1]);
  const expectedDuration = Math.round((((endX - startX) / box.width) * 10000) / 10) * 10;
  expect(Math.abs((created.end - created.start) - expectedDuration)).toBeLessThanOrEqual(10);
});

test('Ctrl+dragging a too-short range shows a warning toast', async ({ page }) => {
  await page.goto(server.url);
  const row = page.locator('.waveform-row').first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  const rowStart = Number(await row.getAttribute('data-start-ms'));
  const rowEnd = Number(await row.getAttribute('data-end-ms'));
  const startX = box.x + box.width * 0.84;
  const endX = startX + Math.max(2, box.width * (80 / (rowEnd - rowStart)));
  const y = box.y + 20;

  await page.keyboard.down('Control');
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(endX, y, { steps: 2 });
  await page.mouse.up();
  await page.keyboard.up('Control');

  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(6);
  const warning = page.locator('#hint-stack .hint-card.hint-warning', {
    hasText: '该空白区域不足 100ms，无法新增字幕',
  });
  await expect(warning).toBeVisible();
});

test('Ctrl+dragging an existing cue is rejected without a preview', async ({ page }) => {
  await page.goto(server.url);
  const cue = page.locator('.waveform-cue-block[data-idx="0"]').first();
  await expect(cue).toBeVisible();
  const box = await cue.boundingBox();
  expect(box).not.toBeNull();

  await page.keyboard.down('Control');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 2 });
  await expect(page.locator('.waveform-create-preview')).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up('Control');

  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(6);
  await expect(page.locator('#hint-stack .hint-card.hint-warning', {
    hasText: '该位置已有字幕，无法新增字幕',
  })).toBeVisible();
});

test('Ctrl+dragging from blank space stops at an existing cue boundary', async ({ page }) => {
  await page.goto(server.url);
  const row = page.locator('.waveform-row').first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  const anchorX = box.x + box.width * 0.9;
  const crossedX = box.x + box.width * 0.6;
  const y = box.y + 20;

  await page.keyboard.down('Control');
  await page.mouse.move(anchorX, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, y, { steps: 2 });

  const preview = page.locator('.waveform-create-preview');
  await expect(preview).toBeVisible();
  await page.mouse.move(crossedX, y, { steps: 6 });
  await expect(preview).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up('Control');
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);
  const created = await page.evaluate(() => DATA.segments[1]);
  expect(created.start).toBe(8000);
  expect(created.end).toBe(9000);
});

test('waveform background split supports undo and redo', async ({ page }) => {
  await page.goto(server.url);
  await makeFirstCueWordSplittable(page);
  const row = page.locator('.waveform-row').filter({ has: page.locator('[data-idx="0"]') }).first();
  await expect(row).toBeVisible();

  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box.x + box.width * 0.4, box.y + 20, { button: 'right' });
  const splitItem = page.locator('#ctxmenu .item', { hasText: '按音频位置拆分' });
  await expect(splitItem).toBeEnabled();
  await splitItem.click();
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);
  await expect.poll(() => page.evaluate(() => DATA.segments.slice(0, 2).map((segment) => segment.text))).toEqual([
    'Alpha',
    'Bravo',
  ]);

  await page.getByRole('button', { name: /撤销/ }).click();
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(6);
  await expect.poll(() => page.evaluate(() => DATA.segments[0].text)).toBe('Alpha Bravo');
  await expect(page.getByRole('button', { name: /重做/ })).toBeEnabled();

  await page.getByRole('button', { name: /重做/ }).click();
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);
  await expect.poll(() => page.evaluate(() => DATA.segments.slice(0, 2).map((segment) => segment.text))).toEqual([
    'Alpha',
    'Bravo',
  ]);
});

test('manual text split keeps malformed item timing inside both cues and restores it with undo', async ({ page }) => {
  await page.goto(server.url);
  const original = {
    id: 'manual-item-split',
    start: 25160,
    end: 26526,
    text: '有这么多新的模型来',
    items: [
      { text: '有', start: 25200, end: 25400 },
      { text: '这么多', start: 25400, end: 25760 },
      { text: '新的', start: 25760, end: 26000 },
      { text: '模型', start: 26000, end: 26680 },
      { text: '来', start: 26680, end: 26960 },
    ],
  };
  await page.evaluate((segment) => {
    DATA.segments[0] = segment;
    renderAll({ waveform: 'full' });
  }, original);

  const text = page.locator('.cue[data-idx="0"] .text');
  await text.dblclick();
  await text.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    // 在“模型”内部切开，覆盖 item.end 早于原始 item.end 的情况。
    range.setStart(node, 7);
    range.setEnd(node, 7);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('.cue[data-idx="0"]')).toHaveCount(1);
  await expect(page.locator('.cue[data-idx="1"]')).toHaveCount(1);

  const splitState = await page.evaluate(() => ({
    segments: DATA.segments.slice(0, 2).map((segment) => ({
      start: segment.start,
      end: segment.end,
      text: segment.text,
      items: segment.items,
    })),
  }));
  expect(splitState.segments.map((segment) => segment.text)).toEqual([
    '有这么多新的模',
    '型来',
  ]);
  for (const segment of splitState.segments) {
    for (const item of segment.items || []) {
      expect(item.start).toBeGreaterThanOrEqual(segment.start);
      expect(item.end).toBeLessThanOrEqual(segment.end);
      expect(item.end).toBeGreaterThan(item.start);
    }
  }
  expect(splitState.segments.flatMap((segment) => segment.items || []).map((item) => item.text))
    .toEqual(['有', '这么多', '新的', '模', '型', '来']);

  const saveResponse = page.waitForResponse((response) => (
    response.url().endsWith('/api/project') && response.request().method() === 'POST'
  ));
  await page.keyboard.press('Control+s');
  expect((await saveResponse).ok()).toBe(true);

  await page.getByRole('button', { name: /撤销/ }).click();
  await expect.poll(() => page.evaluate(() => JSON.stringify(DATA.segments[0]))).toBe(JSON.stringify(original));
  await expect(page.getByRole('button', { name: /重做/ })).toBeEnabled();

  await page.getByRole('button', { name: /重做/ }).click();
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);
  const redone = await page.evaluate(() => DATA.segments.slice(0, 2).map((segment) => ({
    start: segment.start,
    end: segment.end,
    items: segment.items,
  })));
  for (const segment of redone) {
    for (const item of segment.items || []) {
      expect(item.start).toBeGreaterThanOrEqual(segment.start);
      expect(item.end).toBeLessThanOrEqual(segment.end);
      expect(item.end).toBeGreaterThan(item.start);
    }
  }
});

test('current-cue text keeps the list and waveform labels in sync through undo and redo', async ({ page }) => {
  await page.goto(server.url);

  const waveformCue = page.locator('.waveform-cue-block[data-idx="0"]').first();
  const waveformLabel = waveformCue.locator('.waveform-cue-label');
  const listText = page.locator('.cue[data-idx="0"] .text');
  const panelText = page.locator('#cue-panel-text');
  const overlayText = page.locator('#overlay-main-text');
  const undo = page.getByRole('button', { name: /撤销/ });
  const redo = page.getByRole('button', { name: /重做/ });

  await waveformCue.click();
  await page.locator('#overlay-toggle').check();
  await page.evaluate(() => {
    const player = document.getElementById('player');
    player.currentTime = 1;
    player.dispatchEvent(new Event('timeupdate'));
  });
  await expect(panelText).toHaveValue('Alpha');
  await expect(listText).toHaveText('Alpha');
  await expect(waveformLabel).toHaveText('Alpha');
  await expect(overlayText).toHaveText('Alpha');

  await panelText.fill('Alpha revised');
  await expect(listText).toHaveText('Alpha revised');
  await expect(waveformLabel).toHaveText('Alpha revised');
  await expect(overlayText).toHaveText('Alpha revised');

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

test('current-cue Escape behavior follows the operation setting', async ({ page }) => {
  await page.goto(server.url);
  const panelText = page.locator('#cue-panel-text');
  const listText = page.locator('.cue[data-idx="0"] .text');
  await page.locator('.waveform-cue-block[data-idx="0"]').first().click();
  await expect(panelText).toHaveValue('Alpha');

  await panelText.fill('Alpha kept');
  await panelText.press('Escape');
  await expect(panelText).toHaveValue('Alpha kept');
  await expect(listText).toHaveText('Alpha kept');

  await page.locator('#cue-editor-settings-toggle').click();
  const cancelOnEscape = page.locator('#cue-editor-cancel-on-escape');
  await expect(cancelOnEscape).not.toBeChecked();
  await cancelOnEscape.check();
  await page.locator('#cue-editor-settings-toggle').click();

  await panelText.fill('Alpha reverted');
  await panelText.press('Escape');
  await expect(panelText).toHaveValue('Alpha kept');
  await expect(listText).toHaveText('Alpha kept');
});

test('C merge refreshes the paused main subtitle preview', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#overlay-toggle').check();
  await page.evaluate(() => {
    const player = document.getElementById('player');
    player.currentTime = 1;
    player.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.locator('#overlay-main-text')).toHaveText('Alpha');

  const cues = page.locator('.cue');
  await cues.nth(0).click();
  await cues.nth(1).click({ modifiers: ['Control'] });
  await page.keyboard.press('c');

  await expect(page.locator('.cue .text').first()).toHaveText('AlphaBravo');
  await expect(page.locator('#overlay-main-text')).toHaveText('AlphaBravo');
});

test('B splits the selected subtitle under the cue-list pointer and supports undo and redo', async ({ page }) => {
  await page.goto(server.url);
  await makeFirstCueWordSplittable(page);
  const text = page.locator('.cue[data-idx="0"] .text');
  await page.locator('#overlay-toggle').check();
  await page.evaluate(() => {
    const player = document.getElementById('player');
    player.currentTime = 1;
    player.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.locator('#overlay-main-text')).toHaveText('Alpha Bravo');
  await page.locator('.cue[data-idx="0"]').click();
  const splitPoint = await text.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 6);
    range.setEnd(node, 6);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(splitPoint.x, splitPoint.y);

  await page.keyboard.press('b');
  await expect.poll(() => page.locator('.cue').count()).toBe(7);
  await expect(page.locator('.cue .text').nth(0)).toHaveText('Alpha');
  await expect(page.locator('.cue .text').nth(1)).toHaveText('Bravo');
  await expect(page.locator('#overlay-main-text')).toHaveText('Alpha');

  await page.getByRole('button', { name: /撤销/ }).click();
  await expect.poll(() => page.locator('.cue').count()).toBe(6);
  await expect(page.locator('.cue .text').first()).toHaveText('Alpha Bravo');

  await page.getByRole('button', { name: /重做/ }).click();
  await expect.poll(() => page.locator('.cue').count()).toBe(7);
  await expect(page.locator('.cue .text').nth(0)).toHaveText('Alpha');
  await expect(page.locator('.cue .text').nth(1)).toHaveText('Bravo');
});

test('retries an inline split with B or Enter and clamps both halves to 100ms', async ({ page }) => {
  await page.goto(server.url);
  await page.evaluate(() => {
    const segment = DATA.segments[0];
    segment.text = 'Alpha Bravo';
    segment.items = [
      { start: segment.start, end: segment.start + 50, text: 'Alpha' },
      { start: segment.start + 50, end: segment.end, text: 'Bravo' },
    ];
    renderAll({ waveform: 'full' });
  });

  const cue = page.locator('.cue[data-idx="0"]');
  await cue.click();
  const text = cue.locator('.text');
  await text.dblclick();
  await text.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 5);
    range.setEnd(node, 5);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  // The first attempt leaves the editor open and only arms the forced retry.
  await page.keyboard.press('Enter');
  await expect(page.locator('.cue')).toHaveCount(6);
  await expect(text).toHaveAttribute('contenteditable', 'plaintext-only');
  await expect(page.locator('.hint-card.hint-warning', {
    hasText: '请再次按 B 或 Enter 强制拆分',
  })).toBeVisible();

  // B/Enter is accepted only for this armed retry while the inline editor is open.
  await page.keyboard.press('Enter');
  await expect.poll(() => page.locator('.cue').count()).toBe(7);
  const splitTiming = await page.evaluate(() => DATA.segments.slice(0, 2).map((segment) => ({
    text: segment.text,
    duration: segment.end - segment.start,
  })));
  expect(splitTiming).toEqual([
    { text: 'Alpha', duration: 100 },
    { text: 'Bravo', duration: 7900 },
  ]);
  await expect(page.locator('.cue[data-idx="1"]')).toHaveClass(/selected/);

  // The split history restores the original text, timing, selection and panel target.
  await page.getByRole('button', { name: /撤销/ }).click();
  await expect.poll(() => page.locator('.cue').count()).toBe(6);
  await expect(page.locator('.cue[data-idx="0"]')).toHaveClass(/selected/);
  await expect.poll(() => page.evaluate(() => window.MAWE_EDITOR_BRIDGE.currentCuePanelIdx)).toBe(0);
  await expect(page.locator('.cue[data-idx="0"] .text')).toHaveText('Alpha Bravo');
  expect(await page.evaluate(() => DATA.segments[0].end - DATA.segments[0].start)).toBe(8000);
});

test('long-only filtering temporarily keeps split results visible until focus leaves', async ({ page }) => {
  await page.goto(server.url);
  await makeFirstCueWordSplittable(page);

  await page.locator('#cue-list-settings-toggle').click();
  await page.locator('#charcount-threshold').fill('1');
  await expect(page.locator('#cue-list-keep-split-visible')).toBeChecked();
  await page.locator('#filter-over').click();
  await expect(page.locator('.cue:not(.hidden)')).toHaveCount(1);

  const text = page.locator('.cue[data-idx="0"] .text');
  await page.locator('.cue[data-idx="0"]').click();
  const splitPoint = await text.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 6);
    range.setEnd(node, 6);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(splitPoint.x, splitPoint.y);
  await page.keyboard.press('b');

  await expect.poll(() => page.locator('.cue').count()).toBe(7);
  await expect(page.locator('.cue:not(.hidden)')).toHaveCount(2);
  await expect(page.locator('#visible-count')).toHaveText('2');
  await expect(page.locator('.cue[data-idx="0"] .text')).toHaveText('Alpha');
  await expect(page.locator('.cue[data-idx="1"] .text')).toHaveText('Bravo');

  await page.locator('#search').click();
  await expect(page.locator('.cue:not(.hidden)')).toHaveCount(0);
  await expect(page.locator('#visible-count')).toHaveText('0');
});

test('B split makes the selected latter half the Shift+click anchor', async ({ page }) => {
  await page.goto(server.url);
  await makeFirstCueWordSplittable(page);
  const cues = page.locator('.cue');

  await cues.nth(0).click();
  const splitPoint = await cues.nth(0).locator('.text').evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 6);
    range.setEnd(node, 6);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(splitPoint.x, splitPoint.y);
  await page.keyboard.press('b');

  await expect.poll(() => page.locator('.cue').count()).toBe(7);
  await expect(page.locator('.cue[data-idx="1"]')).toHaveClass(/selected/);

  await page.locator('.cue[data-idx="3"]').click({ modifiers: ['Shift'] });
  await expect.poll(() => page.locator('.cue.selected').evaluateAll(
    (elements) => elements.map((element) => Number(element.dataset.idx)),
  )).toEqual([1, 2, 3]);
});

test('waveform navigation keeps a cue row in the comfort zone', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#waveform-settings-toggle').click();
  await page.locator('#waveform-seconds-per-row').selectOption('20');
  await page.locator('#waveform-row-height').selectOption('64');
  await page.locator('#waveform-settings-toggle').click();

  // 让下一条字幕所在行处于舒适区但不要正好居中，验证 A/D 不会强制重定位。
  await page.locator('.cue[data-idx="1"]').click();
  const before = await page.evaluate(() => {
    const scroll = document.getElementById('waveform-scroll');
    const rowIndex = Math.floor(DATA.segments[2].start / (20 * 1000));
    const stride = 64 + 10;
    const comfortInset = Math.min(120, Math.max(48, scroll.clientHeight * 0.2));
    scroll.scrollTop = Math.max(0, rowIndex * stride - comfortInset - 8);
    const rowTop = rowIndex * stride - scroll.scrollTop;
    return {
      scrollTop: scroll.scrollTop,
      rowInComfortZone: rowTop >= comfortInset
        && rowTop + 64 <= scroll.clientHeight - comfortInset,
    };
  });
  expect(before.rowInComfortZone).toBe(true);
  await page.evaluate(() => {
    const scroll = document.getElementById('waveform-scroll');
    const nativeScrollTo = scroll.scrollTo.bind(scroll);
    window.__waveformScrollBehaviors = [];
    scroll.scrollTo = (options) => {
      window.__waveformScrollBehaviors.push(options?.behavior || 'auto');
      nativeScrollTo(options);
    };
  });

  await page.keyboard.press('d');
  await expect(page.locator('.cue[data-idx="2"]')).toHaveClass(/selected/);
  await expect.poll(() => page.evaluate(
    () => document.getElementById('waveform-scroll').scrollTop,
  )).toBe(before.scrollTop);

  // 离开舒适区后仍应自动定位，避免把“减少无意义滚动”变成“不再跟随”。
  await page.evaluate(() => { document.getElementById('waveform-scroll').scrollTop = 0; });
  await page.keyboard.press('d');
  await expect(page.locator('.cue[data-idx="3"]')).toHaveClass(/selected/);
  await expect.poll(() => page.evaluate(
    () => document.getElementById('waveform-scroll').scrollTop,
  )).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__waveformScrollBehaviors)).toContain('smooth');
});

test('rapid subtitle navigation reuses cached waveform rows', async ({ page }) => {
  await page.goto(server.url);
  await expect(page.locator('.cue[data-idx="0"]')).toBeVisible();
  await page.locator('.cue[data-idx="0"]').click();

  await page.evaluate(() => {
    // Put all fixture cues inside the cached row band so this test isolates
    // keyboard navigation from the cross-row incremental-render path.
    waveformEditor.settings.secondsPerRow = 60;
    waveformEditor.multiRange = [-1, -1];
    waveformEditor.render();

    const original = waveformEditor.renderMultiVisible.bind(waveformEditor);
    window.__keyboardWaveformRenderStats = { calls: 0, forced: 0 };
    waveformEditor.renderMultiVisible = function wrappedRenderMultiVisible(force = false) {
      window.__keyboardWaveformRenderStats.calls += 1;
      if (force) window.__keyboardWaveformRenderStats.forced += 1;
      return original(force);
    };
  });

  await page.evaluate(() => {
    for (let index = 0; index < 20; index += 1) {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'd',
        bubbles: true,
        repeat: index > 0,
      }));
    }
  });
  await page.waitForTimeout(100);

  await expect(page.locator('.cue[data-idx="5"]')).toHaveClass(/selected/);
  const renderStats = await page.evaluate(() => window.__keyboardWaveformRenderStats);
  expect(renderStats.forced).toBe(0);
  expect(renderStats.calls).toBeLessThan(20);
});

test('B does not split when the playhead is in a gap or while editing text', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('.cue[data-idx="0"]').click();
  // 播放头位于空隙（20s）：列表外按 B 只提示、不拆分
  await page.evaluate(() => {
    const player = document.getElementById('player');
    player.currentTime = 20;
    player.dispatchEvent(new Event('timeupdate'));
  });
  await page.locator('#media-controls').hover();
  await page.keyboard.press('b');
  await expect(page.locator('.cue')).toHaveCount(6);
  await expect(page.locator('.hint-card', { hasText: '播放头位置没有可拆分字幕' })).toHaveCount(1);

  const panelText = page.locator('#cue-panel-text');
  await panelText.focus();
  await page.keyboard.press('b');
  await expect(panelText).toHaveValue('Alphab');
  await expect(page.locator('.cue')).toHaveCount(6);
});

test('B splits at the pointer audio position while hovering the waveform', async ({ page }) => {
  await page.goto(server.url);
  await makeFirstCueWordSplittable(page);
  const row = page.locator('.waveform-row').first();
  const box = await row.boundingBox();
  // 第一行覆盖 0–5s；40% 处约 2s，落在第一条字幕（0–8s）内部
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
  await page.keyboard.press('b');
  await expect(page.locator('.cue')).toHaveCount(7);
  await expect(page.locator('.cue .text').nth(0)).toHaveText('Alpha');
  await expect(page.locator('.cue .text').nth(1)).toHaveText('Bravo');
});

test('Home and End seek the player and reveal the media boundaries', async ({ page }) => {
  await page.goto(server.url);
  await expect.poll(() => page.evaluate(() => {
    const scroll = document.getElementById('waveform-scroll');
    return scroll.scrollHeight > scroll.clientHeight;
  })).toBe(true);
  await page.evaluate(() => {
    waveformEditor.settings.mode = 'multi';
    waveformEditor.settings.secondsPerRow = 10;
    waveformEditor.render();
    const scroll = document.getElementById('waveform-scroll');
    scroll.scrollTop = scroll.scrollHeight;
  });
  await expect.poll(() => page.evaluate(
    () => document.getElementById('waveform-scroll').scrollTop,
  )).toBeGreaterThan(0);
  await page.evaluate(() => {
    const media = document.getElementById('player');
    media.currentTime = 123;
    media.dispatchEvent(new Event('timeupdate'));
  });

  await page.keyboard.press('Home');
  await expect.poll(() => page.evaluate(() => document.getElementById('player').currentTime)).toBe(0);
  await expect.poll(() => page.evaluate(
    () => document.getElementById('waveform-scroll').scrollTop,
  )).toBeLessThan(1);

  await page.keyboard.press('End');
  await expect.poll(() => page.evaluate(() => {
    const media = document.getElementById('player');
    return Math.abs(media.currentTime - media.duration);
  })).toBeLessThan(0.01);
  await expect.poll(() => page.evaluate(() => {
    const scroll = document.getElementById('waveform-scroll');
    return scroll.scrollTop - (scroll.scrollHeight - scroll.clientHeight);
  })).toBeGreaterThan(-1);
});

test('hovering a selected subtitle shows the B split hint', async ({ page }) => {
  await page.goto(server.url);
  const cue = page.locator('.cue[data-idx="0"]');
  await cue.click();
  const text = cue.locator('.text');
  const splitPoint = await text.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 2);
    range.setEnd(node, 2);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(splitPoint.x, splitPoint.y);

  const preview = cue.locator('.cue-split-preview');
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((element) => getComputedStyle(element, '::after').content)).toBe('"B"');
});

test('the last multi-row waveform uses the media remainder width', async ({ page }) => {
  await page.goto(server.url);
  await page.evaluate(() => {
    waveformEditor.settings.mode = 'multi';
    waveformEditor.settings.secondsPerRow = 64;
    waveformEditor.settings.rowHeight = 72;
    waveformEditor.render();
    const scroll = document.getElementById('waveform-scroll');
    scroll.scrollTop = scroll.scrollHeight;
    waveformEditor.renderMultiVisible(true);
  });

  const lastRow = page.locator('.waveform-row[data-row-index="4"]');
  await expect(lastRow).toBeVisible();
  await expect(lastRow).toHaveAttribute('style', /width: 68\.75%/);
  await expect(lastRow).toHaveAttribute('data-end-ms', '300000');
});

test('requires a second B in the split dialog before forcing a short-side cut', async ({ page }) => {
  await page.addInitScript(() => {
    const key = 'moy.asr.editor.settings.v1';
    const settings = JSON.parse(localStorage.getItem(key) || '{}');
    localStorage.setItem(key, JSON.stringify({
      ...settings,
      autoSaveProject: false,
      splitUseWordTimestamps: false,
    }));
  });
  await page.goto(server.url);
  await page.evaluate(() => {
    const segment = DATA.segments[0];
    segment.text = 'Alpha Bravo';
    segment.items = [
      { start: segment.start, end: segment.start + 50, text: 'Alpha' },
      { start: segment.start + 50, end: segment.end, text: 'Bravo' },
    ];
    renderAll({ waveform: 'full' });
  });

  const row = page.locator('.waveform-row').first();
  const box = await row.boundingBox();
  const rowStart = Number(await row.getAttribute('data-start-ms'));
  const rowEnd = Number(await row.getAttribute('data-end-ms'));
  if (!box || !Number.isFinite(rowStart) || !Number.isFinite(rowEnd)) {
    throw new Error('波形行没有有效时间范围');
  }
  const pointerTime = 50;
  const pointerX = box.x + ((pointerTime - rowStart) / (rowEnd - rowStart)) * box.width;
  await page.mouse.move(pointerX, box.y + box.height / 2);
  await page.keyboard.press('b');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);

  // The first confirmation only arms the retry and keeps the dialog open.
  await page.keyboard.press('b');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('.cue')).toHaveCount(6);
  await expect(page.locator('.hint-card.hint-warning', {
    hasText: '请再次按 B 或 Enter 强制拆分',
  })).toBeVisible();

  await page.keyboard.press('b');
  await expect.poll(() => page.locator('.cue').count()).toBe(7);
  expect(await page.evaluate(() => DATA.segments.slice(0, 2).map((segment) => [
    segment.text,
    segment.end - segment.start,
  ]))).toEqual([
    ['Alpha', 100],
    ['Bravo', 7900],
  ]);
});

test('B and C refresh cue overlays without redrawing cached waveform canvases', async ({ page }) => {
  await page.goto(server.url);
  await makeFirstCueWordSplittable(page);
  await page.evaluate(() => {
    waveformEditor.settings.secondsPerRow = 60;
    waveformEditor.multiRange = [-1, -1];
    waveformEditor.render();
    window.__cueOverlayStats = { drawRows: 0, overlayRefreshes: 0 };
    window.__cachedWaveformCanvas = document.querySelector('.waveform-row canvas');
    const originalDrawRow = waveformEditor.drawRow.bind(waveformEditor);
    waveformEditor.drawRow = function wrappedDrawRow(...args) {
      window.__cueOverlayStats.drawRows += 1;
      return originalDrawRow(...args);
    };
    const originalRefreshCueOverlay = waveformEditor.refreshCueOverlay.bind(waveformEditor);
    waveformEditor.refreshCueOverlay = function wrappedRefreshCueOverlay(...args) {
      window.__cueOverlayStats.overlayRefreshes += 1;
      return originalRefreshCueOverlay(...args);
    };
  });

  const firstCueText = page.locator('.cue[data-idx="0"] .text');
  await page.locator('.cue[data-idx="0"]').click();
  const splitPoint = await firstCueText.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 6);
    range.setEnd(node, 6);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(splitPoint.x, splitPoint.y);
  await page.keyboard.press('b');
  await expect(page.locator('.cue')).toHaveCount(7);

  await page.locator('.cue[data-idx="1"]').click();
  await page.locator('.cue[data-idx="2"]').click({ modifiers: ['Control'] });
  await page.keyboard.press('c');
  await expect(page.locator('.cue')).toHaveCount(6);

  await expect.poll(() => page.evaluate(() => ({
    canvasReused: document.querySelector('.waveform-row canvas') === window.__cachedWaveformCanvas,
    stats: window.__cueOverlayStats,
  }))).toEqual({
    canvasReused: true,
    stats: { drawRows: 0, overlayRefreshes: 2 },
  });
});

test('waveform appearance wheel adjustments wait for input to settle', async ({ page }) => {
  await page.goto(server.url);
  await page.evaluate(() => {
    waveformEditor.settings.mode = 'multi';
    waveformEditor.settings.secondsPerRow = 300;
    waveformEditor.settings.rowHeight = 96;
    waveformEditor.settings.waveformScale = 1;
    waveformEditor.multiRange = [-1, -1];
    waveformEditor.render();

    const row = document.querySelector('.waveform-row[data-row-index="0"]');
    const canvas = row?.querySelector('canvas');
    if (!row || !canvas) throw new Error('没有可测试的波形 Canvas');
    window.__waveformAppearanceStats = { drawRows: 0, canvas };
    const originalDrawRow = waveformEditor.drawRow.bind(waveformEditor);
    waveformEditor.drawRow = function wrappedDrawRow(...args) {
      window.__waveformAppearanceStats.drawRows += 1;
      return originalDrawRow(...args);
    };
  });

  const scaleBefore = await page.evaluate(() => {
    const scroll = document.getElementById('waveform-scroll');
    for (let index = 0; index < 3; index += 1) {
      scroll.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -120,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    }
    return {
      scale: waveformEditor.settings.waveformScale,
      drawRows: window.__waveformAppearanceStats.drawRows,
    };
  });
  expect(scaleBefore).toEqual({ scale: 1, drawRows: 0 });
  await expect.poll(() => page.evaluate(() => waveformEditor.settings.waveformScale)).toBe(2.5);
  await expect.poll(() => page.evaluate(() => window.__waveformAppearanceStats.drawRows > 0)).toBe(true);

  await page.evaluate(() => {
    window.__waveformAppearanceStats.drawRows = 0;
    const scroll = document.getElementById('waveform-scroll');
    for (let index = 0; index < 2; index += 1) {
      scroll.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -120,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    }
  });
  expect(await page.evaluate(() => ({
    rowHeight: waveformEditor.settings.rowHeight,
    drawRows: window.__waveformAppearanceStats.drawRows,
  }))).toEqual({ rowHeight: 96, drawRows: 0 });
  await expect.poll(() => page.evaluate(() => waveformEditor.settings.rowHeight)).toBe(144);
  await expect.poll(() => page.evaluate(() => window.__waveformAppearanceStats.drawRows > 0)).toBe(true);
});

test('spectral color toggle shows pending state and ignores repeated clicks', async ({ page }) => {
  await page.goto(server.url);
  await page.evaluate(() => {
    waveformEditor.settings.mode = 'multi';
    waveformEditor.settings.secondsPerRow = 10;
    waveformEditor.settings.spectralColor = false;
    waveformEditor.multiRange = [-1, -1];
    waveformEditor.render();

    const peakCount = 1000;
    const bytes = new Uint8Array(peakCount * 4);
    for (let index = 0; index < peakCount; index += 1) {
      bytes[index * 4] = 232;
      bytes[index * 4 + 1] = 3;
      bytes[index * 4 + 2] = 255;
      bytes[index * 4 + 3] = 63;
    }
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    waveformEditor.setSpectralPayload({
      schema: 'moy.asr.spectral.v1',
      encoding: 'u16-freq-density-base64',
      sample_rate: 8000,
      division: 80,
      peak_count: peakCount,
      data: btoa(binary),
    }, { render: false });
    waveformEditor.spectralColorToggle.checked = false;

    window.__spectralColorStats = { renders: 0 };
    const originalRender = waveformEditor.render.bind(waveformEditor);
    waveformEditor.render = function wrappedRender(...args) {
      window.__spectralColorStats.renders += 1;
      return originalRender(...args);
    };
  });

  const immediate = await page.evaluate(() => {
    const toggle = document.getElementById('waveform-spectral-color');
    toggle.click();
    toggle.click();
    const status = document.getElementById('waveform-spectral-status');
    return {
      checked: toggle.checked,
      disabled: toggle.disabled,
      ariaBusy: toggle.getAttribute('aria-busy'),
      statusHidden: status.hidden,
      statusText: status.textContent,
      renders: window.__spectralColorStats.renders,
    };
  });
  expect(immediate).toMatchObject({
    checked: true,
    disabled: true,
    ariaBusy: 'true',
    statusHidden: false,
    renders: 0,
  });
  expect(immediate.statusText).toMatch(/应用频谱颜色|Applying spectral colors/);

  await expect.poll(() => page.evaluate(() => {
    const toggle = document.getElementById('waveform-spectral-color');
    return {
      checked: toggle.checked,
      disabled: toggle.disabled,
      ariaBusy: toggle.getAttribute('aria-busy'),
      statusHidden: document.getElementById('waveform-spectral-status').hidden,
      renders: window.__spectralColorStats.renders,
      setting: waveformEditor.settings.spectralColor,
    };
  })).toEqual({
    checked: true,
    disabled: false,
    ariaBusy: 'false',
    statusHidden: true,
    renders: 1,
    setting: true,
  });
});

test('settings gears stay at the end of their headers and rise above dividers', async ({ page }) => {
  await page.goto(server.url);
  const settings = [
    ['#subtitle-preview-settings-toggle', '.player-toolbar', '#subtitle-preview-settings-panel'],
    ['#cue-editor-settings-toggle', '.cue-editor-toolbar', '#cue-editor-settings-panel'],
    ['#waveform-settings-toggle', '.waveform-toolbar', '#waveform-settings-panel'],
    ['#cue-list-settings-toggle', '.cue-list-toolbar', '#cue-list-settings-panel'],
  ];

  for (const [toggleSelector, toolbarSelector, panelSelector] of settings) {
    await expect(page.locator(toggleSelector)).toHaveText('⚙️');
    const layout = await page.evaluate(({ toggleSelector: buttonSelector, toolbarSelector: headerSelector }) => {
      const button = document.querySelector(buttonSelector);
      const toolbar = document.querySelector(headerSelector);
      if (!button || !toolbar) return null;
      const children = [...toolbar.children]
        .filter((element) => getComputedStyle(element).display !== 'none')
        .map((element, index) => ({
          element,
          index,
          order: Number.parseInt(getComputedStyle(element).order, 10) || 0,
        }))
        .sort((left, right) => left.order - right.order || left.index - right.index);
      return {
        gearIsLast: children.at(-1)?.element.contains(button) === true,
        gearOrder: getComputedStyle(button.parentElement).order,
      };
    }, { toggleSelector, toolbarSelector });
    expect(layout).not.toBeNull();
    expect(layout.gearIsLast).toBe(true);
    expect(layout.gearOrder).toBe('99');

    await page.locator(toggleSelector).click();
    await expect(page.locator(panelSelector)).toBeVisible();
    await page.locator(toggleSelector).click();
    await expect(page.locator(panelSelector)).toBeHidden();
  }

  await page.locator('#waveform-settings-toggle').click();
  const layering = await page.evaluate(() => {
    const panel = document.getElementById('waveform-settings-panel');
    const owner = document.getElementById('waveform-pane');
    const dividerZIndexes = [...document.querySelectorAll(
      '.workspace-divider, .layout-split-divider, .layout-resizer',
    )].map((element) => Number.parseInt(getComputedStyle(element).zIndex, 10) || 0);
    return {
      panelZIndex: Number.parseInt(getComputedStyle(panel).zIndex, 10),
      ownerZIndex: Number.parseInt(getComputedStyle(owner).zIndex, 10),
      dividerZIndex: Math.max(0, ...dividerZIndexes),
    };
  });
  expect(layering.panelZIndex).toBeGreaterThan(layering.dividerZIndex);
  expect(layering.ownerZIndex).toBeGreaterThan(layering.dividerZIndex);
});

test('help reflects the selected subtitle-edit split key', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#help-toggle').click();
  const helpPanel = page.locator('#help-panel');
  await expect(helpPanel).toHaveClass(/show/);
  await expect(helpPanel).toHaveAttribute('aria-hidden', 'false');
  await helpPanel.getByRole('tab', { name: '波形区', exact: true }).click();

  const settingsPanel = page.locator('#editor-settings-panel');
  const displayRows = settingsPanel.locator('.editor-settings-display-row');
  const splitKey = page.locator('#split-key');
  const helpSplitKey = page.locator('#help-split-key');
  const editorSplitKey = page.locator('#cue-editor-split-key');
  const editorConfirmKey = page.locator('#cue-editor-confirm-key');
  await expect(page.locator('#cue-editor-key-hints')).toHaveClass(/waveform-status/);
  await expect(page.locator('.cue-editor-key-hint')).toHaveCount(4);
  await expect(page.locator('#cue-editor-key-hints')).toHaveCSS('gap', '14px');
  await expect(settingsPanel).not.toContainText('波形区拆分按键');
  await expect(displayRows).toHaveCount(0);
  const modKey = await page.evaluate(() => (
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgentData?.platform || '') ? 'Cmd' : 'Ctrl'
  ));
  await expect(helpSplitKey).toHaveText('Enter');
  await expect(page.locator('#help-waveform-split-key')).toHaveText('B');
  await expect(helpPanel).toContainText('绑定到主副字幕（自动匹配）');
  await expect(helpPanel).toContainText('解绑当前副字幕');
  await expect(helpPanel).toContainText('批量对齐选中的副字幕到各自主字幕时间轴');
  await expect(helpPanel).not.toContainText('波形轨道徽标');
  await expect(helpPanel).not.toContainText('语言类型：单词型适合英语等空格语言，字符型适合中文/日文等');
  await expect(helpPanel).not.toContainText('主字幕自动使用时间码拆分：单轨可直接拆分');
  await expect(helpPanel).not.toContainText('主字幕调整时副字幕只跟随');
  await expect(helpPanel).not.toContainText('副字幕调整时受主字幕轨道边界限制');
  await expect(helpPanel).not.toContainText('普通点击以最后点击的轨道为准；未绑定副字幕不会保留旧主字幕选区');

  const multiSubtitleHelp = helpPanel.locator('.help-subgroup').filter({ hasText: '绑定到主副字幕（自动匹配）' });
  await expect(multiSubtitleHelp).toHaveCount(1);
  await expect(helpPanel.locator('#help-tab-panel-waveform .help-title').filter({ hasText: '多重字幕' })).toHaveCount(1);

  await splitKey.selectOption('enter');
  await expect(helpSplitKey).toHaveText('Enter');
  await expect(editorSplitKey).toHaveText('Enter');
  await expect(editorConfirmKey).toHaveText('Ctrl+Enter');

  await splitKey.selectOption('ctrl-enter');
  await expect(helpSplitKey).toHaveText(`${modKey}+Enter`);
  await expect(editorSplitKey).toHaveText(`${modKey}+Enter`);
  await expect(editorConfirmKey).toHaveText('Enter');

  await page.keyboard.press('Escape');
  await expect(helpPanel).not.toHaveClass(/show/);
  await expect(helpPanel).toHaveAttribute('aria-hidden', 'true');
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
  await expect(selectTool).toHaveAttribute('title', /V/);
  await expect(splitTool).toHaveAttribute('title', /R/);
  await expect(page.locator('#help-toggle')).toContainText('帮助');

  await page.keyboard.press('r');
  await expect(splitTool).toHaveClass(/active/);
  await page.keyboard.press('v');
  await expect(selectTool).toHaveClass(/active/);

  const cue = page.locator('.waveform-cue-block[data-idx="0"]').first();
  await cue.click();
  // 选中字幕块用 outline 高亮（不再改 border-color）
  await expect(cue).toHaveCSS('outline-color', 'rgb(255, 213, 74)');
});

test('extends selected subtitles without remapping items and undoes the batch in one step', async ({ page }) => {
  await page.goto(server.url);
  const cues = page.locator('.cue');
  await cues.nth(0).click();
  await page.keyboard.down('Control');
  await cues.nth(1).click();
  await page.keyboard.up('Control');
  await expect(page.locator('.cue.selected')).toHaveCount(2);

  const before = await page.evaluate(() => JSON.parse(JSON.stringify({
    segments: DATA.segments.slice(0, 2),
  })));
  await page.locator('#subtitle-extend-manage').click();
  await expect(page.locator('#subtitle-extend-panel')).toHaveClass(/show/);
  await expect(page.locator('#subtitle-extend-forward-ms')).toHaveValue('120');
  await expect(page.locator('#subtitle-extend-backward-ms')).toHaveValue('60');

  await page.locator('#subtitle-extend-forward-ms').fill('-1');
  await page.locator('#subtitle-extend-run').click();
  await expect(page.locator('#hint-stack .hint-card.hint-invalid', {
    hasText: '向前延长时长必须是大于等于 0 的数字',
  })).toBeVisible();
  await expect.poll(() => page.evaluate(() => DATA.segments.slice(0, 2))).toEqual(before.segments);

  // 产品语义：「向前延长」作用于起点侧（不越过前一条/时间轴 0），「向后延长」作用于终点侧。
  // forward=250 时 seg0 起点已在 0 只能由向后 60ms 补终点；seg1 起点前移 250、终点后延 60。
  await page.locator('#subtitle-extend-forward-ms').fill('250');
  await page.locator('#subtitle-extend-run').click();
  await expect.poll(() => page.evaluate(() => DATA.segments.slice(0, 2).map((segment) => ({
    start: segment.start,
    end: segment.end,
    items: segment.items,
  })))).toEqual([
    { start: 0, end: 8060, items: before.segments[0].items },
    { start: 49750, end: 58060, items: before.segments[1].items },
  ]);
  await expect(page.locator('#hint-stack .hint-card.hint-success', {
    hasText: '已处理 2 个选中字幕：完整延长 1 条，部分延长 1 条，未延长 0 条',
  })).toBeVisible();

  await page.getByRole('button', { name: /撤销/ }).click();
  await expect.poll(() => page.evaluate(() => DATA.segments.slice(0, 2))).toEqual(before.segments);
});

test('C merges a common group and Shift+A/D extends the subtitle selection', async ({ page }) => {
  await page.goto(server.url);
  const cues = page.locator('.cue');
  await expect(cues).toHaveCount(6);

  await cues.nth(0).click();
  await expect(cues.nth(0)).toHaveClass(/selected/);
  await page.keyboard.press('c');
  await expect(cues).toHaveCount(6);
  await expect(page.locator('.hint-card', { hasText: '请选择至少两个字幕块！' })).toHaveCount(1);

  await cues.nth(2).click();
  await expect(cues.nth(2)).toHaveClass(/selected/);
  await page.keyboard.press('Shift+a');
  await expect(page.locator('.cue.selected')).toHaveCount(2);
  await expect.poll(() => page.locator('.cue.selected').evaluateAll(
    (elements) => elements.map((element) => Number(element.dataset.idx)),
  )).toEqual([1, 2]);
  await page.keyboard.press('Shift+d');
  await expect(page.locator('.cue.selected')).toHaveCount(3);

  await page.reload();
  await expect(cues).toHaveCount(6);
  await page.evaluate(() => {
    DATA.segments[0].color = {
      name: 'red',
      value: '#e74c3c',
      start: DATA.segments[0].start,
      end: DATA.segments[2].end,
    };
    DATA.segments[0].sticker = {
      name: 'reaction',
      path: 'reaction.png',
      start: DATA.segments[0].start,
      end: DATA.segments[2].end,
    };
    for (const index of [1, 2]) {
      DATA.segments[index].color_ref = { name: 'red', headIdx: 0 };
      DATA.segments[index].sticker_ref = { name: 'reaction', headIdx: 0 };
    }
    renderAll();
  });

  await cues.nth(1).locator('.text').click();
  await expect(cues.nth(1)).toHaveClass(/selected/);
  await page.keyboard.down('Control');
  await cues.nth(2).locator('.text').click();
  await page.keyboard.up('Control');
  await page.keyboard.press('c');

  await expect(cues).toHaveCount(5);
  await expect(cues.nth(1).locator('.text')).toHaveText('BravoCharlie');
  await expect.poll(() => page.evaluate(() => ({
    colorRef: DATA.segments[1].color_ref,
    stickerRef: DATA.segments[1].sticker_ref,
    colorEnd: DATA.segments[0].color.end,
    stickerEnd: DATA.segments[0].sticker.end,
  }))).toEqual({
    colorRef: { name: 'red', headIdx: 0 },
    stickerRef: { name: 'reaction', headIdx: 0 },
    colorEnd: 108000,
    stickerEnd: 108000,
  });
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

test('colored subtitles export per-color SRT files including the uncolored default group', async ({ page }) => {
  // 关闭「彩色字幕统一导出」，回到逐个下载的行为（默认勾选时会走目录选择器，自动化无法处理）
  await page.addInitScript(() => {
    const key = 'moy.asr.editor.settings.v1';
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    saved.exportColorUnified = false;
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.goto(server.url);
  await page.evaluate(() => {
    DATA.segments[0].color = { name: 'red', value: '#e74c3c', start: 0, end: 58000 };
    DATA.segments[1].color_ref = { name: 'red', headIdx: 0 };
    DATA.segments[2].color = { name: 'blue', value: '#168cff', start: 100000, end: 108000 };
    renderAll();
    window.showSaveFilePicker = undefined;
  });

  await expect(page.locator('#download-srt')).toBeHidden();
  await expect(page.locator('#subtitle-export-dropdown')).toBeVisible();
  await page.locator('#subtitle-export-btn').click();
  await expect(page.locator('#download-full-srt')).toBeVisible();
  await expect(page.locator('#download-color-srt')).toBeVisible();
  await expect(page.locator('#download-plain-text')).toBeVisible();

  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await page.locator('#download-color-srt').click();
  await expect.poll(() => downloads.length).toBe(3);
  expect(downloads.map((download) => download.suggestedFilename())).toEqual([
    'project_red.srt',
    'project_blue.srt',
    'project_default.srt',
  ]);
  expect(await downloads[0].createReadStream().then(async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  })).toContain('Alpha');

  await page.locator('#subtitle-export-btn').click();
  const textDownload = page.waitForEvent('download');
  await page.locator('#download-plain-text').click();
  expect((await textDownload).suggestedFilename()).toBe('project.txt');
});

test('subtitle export stays direct when only disabled subtitles have colors', async ({ page }) => {
  await page.goto(server.url);
  await expect(page.locator('#download-srt')).toBeVisible();
  await expect(page.locator('#subtitle-export-dropdown')).toBeHidden();

  await page.evaluate(() => {
    DATA.segments[0].color = { name: 'red', value: '#e74c3c', start: 0, end: 8000 };
    DATA.segments[0].disabled = true;
    renderAll();
  });
  await expect(page.locator('#download-srt')).toBeVisible();
  await expect(page.locator('#subtitle-export-dropdown')).toBeHidden();
});

test('gap-removed export includes color SRT and names OTIO as a timeline project', async ({ page }) => {
  // 关闭「彩色字幕统一导出」，回到逐个下载的行为（默认勾选时会走目录选择器，自动化无法处理）
  await page.addInitScript(() => {
    const key = 'moy.asr.editor.settings.v1';
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    saved.exportColorUnified = false;
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.goto(server.url);
  await page.evaluate(() => {
    DATA.segments[0].color = { name: 'red', value: '#e74c3c', start: 0, end: 58000 };
    DATA.segments[1].color_ref = { name: 'red', headIdx: 0 };
    DATA.gap_remove = {
      schema: 'moy.asr.gap_remove.v1',
      detector: 'audio_gate',
      minimum_ms: 500,
      threshold_db: -24,
      hysteresis_db: 2,
      lead_in_ms: 40,
      lead_out_ms: 80,
      skip_playback: true,
      operation_mode: 'middle_drag',
      manual_corrections: false,
      gaps: [{ start: 20000, end: 30000, removed: true }],
    };
    updateGapRemoveUi();
    renderAll();
    window.showSaveFilePicker = undefined;
  });

  await page.locator('#gap-removed-export-btn').click();
  await expect(page.locator('#download-gap-removed-color-srt')).toBeVisible();
  await expect(page.locator('#download-gap-removed-otio')).toHaveText('时间线 OTIO 工程');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-gap-removed-color-srt').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('project_gap-removed_red.srt');
});

test('server media loads from the resolved project path and OTIO keeps its absolute source URL', async ({ page }) => {
  await page.goto(server.url);
  const state = await page.evaluate(() => ({
    media: DATA.media,
    currentSrc: document.getElementById('player').currentSrc,
  }));
  expect(state.media).toMatch(/synthetic\.wav$/);
  expect(state.media).toMatch(/^(?:[A-Za-z]:[\\/]|\/)/);
  expect(state.currentSrc).toBe(`${server.url}media`);

  await page.evaluate(() => {
    DATA.gap_remove = {
      schema: 'moy.asr.gap_remove.v1',
      detector: 'audio_gate',
      minimum_ms: 500,
      threshold_db: -24,
      hysteresis_db: 2,
      lead_in_ms: 40,
      lead_out_ms: 80,
      skip_playback: true,
      operation_mode: 'middle_drag',
      manual_corrections: false,
      gaps: [{ start: 20000, end: 30000, removed: true }],
    };
    updateGapRemoveUi();
    renderAll();
    window.showSaveFilePicker = undefined;
  });
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#gap-removed-export-btn').click();
  await page.locator('#download-gap-removed-otio').click();
  const download = await downloadPromise;
  const payload = await download.createReadStream().then(async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  });
  const targetUrl = payload.tracks.children[0].children[0]
    .media_references.DEFAULT_MEDIA.target_url;
  expect(targetUrl).toMatch(/^file:\/\/\//);
  expect(decodeURI(targetUrl)).toContain('synthetic.wav');
});
