import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir,
  findFreePort,
  generateWav,
  generateWaveformPayload,
  makeTempDir,
  startServer,
} from './helpers.mjs';

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('timed-text-edit');
  const mediaPath = join(tempDir, 'synthetic.wav');
  const projectPath = join(tempDir, 'timed-text.json');
  generateWav(mediaPath, 3);
  writeFileSync(projectPath, JSON.stringify({
    media: 'synthetic.wav',
    waveform: generateWaveformPayload(3000),
    segments: [
      {
        id: 'cue-1', start: 0, end: 1000, text: '就是这颗',
        items: [
          { start: 0, end: 400, text: '就是' },
          { start: 400, end: 1000, text: '这颗' },
        ],
      },
      {
        id: 'cue-2', start: 1200, end: 2200, text: 'abc',
        items: [
          { start: 1200, end: 1500, text: 'a' },
          { start: 1500, end: 1800, text: 'b' },
          { start: 1800, end: 2200, text: 'c' },
        ],
      },
      {
        id: 'cue-3', start: 2300, end: 2800, text: 'disabled', disabled: true,
        items: [{ start: 2300, end: 2800, text: 'disabled' }],
      },
    ],
  }, null, 2), 'utf8');
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test('shows an invalid toast when applying unchanged text', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed');
  });
  await page.goto(server.url);

  await page.locator('#batch-operations-btn').click();
  await page.locator('#timed-text-edit-btn').click();
  await expect(page.locator('#timed-text-edit-apply')).toBeEnabled();

  await page.locator('#timed-text-edit-apply').click();
  await expect(page.locator('#timed-text-edit-modal')).toHaveClass(/show/);
  await expect(page.locator('#hint-stack .hint-card.hint-invalid')).toContainText('当前没有文本修改，未作改动');
});

test('previews text changes and applies the reported item-timing mapping', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed');
  });
  await page.goto(server.url);

  await page.locator('#batch-operations-btn').click();
  await page.locator('#timed-text-edit-btn').click();
  await expect(page.locator('#timed-text-edit-modal')).toHaveClass(/show/);
  await expect(page.locator('#timed-text-edit-source-info')).toContainText('主字幕');
  await expect(page.locator('#timed-text-edit-track-control')).toBeHidden();
  await expect(page.locator('#timed-text-edit-show-disabled')).not.toBeChecked();
  await expect(page.locator('#timed-text-edit-rows textarea')).toHaveCount(2);

  await page.locator('#timed-text-edit-view [data-view="single"]').click();
  await expect(page.locator('#timed-text-edit-single-textarea')).toBeVisible();
  await expect(page.locator('#timed-text-edit-single-textarea')).toHaveValue('就是这颗\nabc');
  const timedTextThreshold = page.locator('#timed-text-edit-charcount-threshold');
  await expect(timedTextThreshold).toBeVisible();
  await expect(timedTextThreshold).toHaveValue('16');
  await timedTextThreshold.fill('20');
  await expect(page.locator('#charcount-threshold')).toHaveValue('20');
  await expect.poll(() => page.locator('#timed-text-edit-single-editor').evaluate(
    (element) => getComputedStyle(element).getPropertyValue('--timed-text-edit-line-width').trim(),
  )).toBe('20em');
  // 模拟切换视图前浏览器尚未派发 input 的最后一次 DOM 更新。
  await page.locator('#timed-text-edit-single-textarea').evaluate((element) => {
    element.value = '就是那颗\nabc';
  });
  await page.locator('#timed-text-edit-view [data-view="rows"]').click();
  await expect(page.locator('#timed-text-edit-rows')).toBeVisible();
  await expect(page.locator('#timed-text-edit-rows textarea').nth(0)).toHaveValue('就是那颗');

  const rows = page.locator('#timed-text-edit-rows textarea');
  await rows.nth(0).fill('就是那颗');
  await rows.nth(1).fill('abXc');

  await expect(page.locator('#timed-text-edit-report-summary')).toContainText('2 条');
  await expect(page.locator('#timed-text-edit-report-mapping')).toContainText('修改后完整映射');
  await expect(page.locator('#timed-text-edit-report-mapping')).toContainText('部分保留');
  await expect(page.locator('#timed-text-edit-change-list')).toContainText('就是那颗');
  await expect(page.locator('#timed-text-edit-change-list')).toContainText('abXc');
  await expect(page.locator('#timed-text-edit-apply')).toBeEnabled();

  await page.locator('#timed-text-edit-report-mapping .timed-text-edit-stat-filter').filter({ hasText: '1 条' }).nth(1).click();
  await expect(page.locator('#timed-text-edit-rows .timed-text-edit-row').nth(0)).toBeHidden();
  await expect(page.locator('#timed-text-edit-rows .timed-text-edit-row').nth(1)).toBeVisible();
  await page.locator('#timed-text-edit-show-all').click();
  await expect(page.locator('#timed-text-edit-rows .timed-text-edit-row').nth(0)).toBeVisible();

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('未应用');
    await dialog.dismiss();
  });
  await page.locator('#timed-text-edit-cancel').click();
  await expect(page.locator('#timed-text-edit-modal')).toHaveClass(/show/);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#timed-text-edit-cancel').click();
  await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);

  await page.locator('#batch-operations-btn').click();
  await page.locator('#timed-text-edit-btn').click();

  const reopenedRows = page.locator('#timed-text-edit-rows textarea');
  await reopenedRows.nth(0).fill('就是那颗');
  await reopenedRows.nth(1).fill('abXc');
  await page.locator('#timed-text-edit-apply').click();
  await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);
  await expect(page.locator('#cues-container .cue[data-idx="0"]')).toHaveClass(/dirty/);
  const state = await page.evaluate(() => ({
    texts: MaweBoot.DATA.segments.map((segment) => segment.text),
    items: MaweBoot.DATA.segments.map((segment) => segment.items),
    ranges: MaweBoot.DATA.segments.map((segment) => [segment.start, segment.end]),
    dirty: MaweBoot.DATA.segments.map((segment) => Boolean(segment._dirty)),
  }));
  expect(state.texts).toEqual(['就是那颗', 'abXc', 'disabled']);
  expect(state.ranges).toEqual([[0, 1000], [1200, 2200], [2300, 2800]]);
  expect(state.dirty).toEqual([true, true, false]);
  // 帧时间基准下 items 额外携带成对帧字段（JSON_SCHEMA §1.4，30fps）。
  expect(state.items[0]).toEqual([
    { start: 0, end: 400, text: '就是', start_frame: 0, end_frame: 12 },
    { start: 400, end: 1000, text: '那颗', start_frame: 12, end_frame: 30 },
  ]);
  expect(state.items[1]).toEqual([
    { start: 1200, end: 1500, text: 'a', start_frame: 36, end_frame: 45 },
    { start: 1500, end: 1800, text: 'bX', start_frame: 45, end_frame: 54 },
    { start: 1800, end: 2200, text: 'c', start_frame: 54, end_frame: 66 },
  ]);
});

test('shows disabled subtitles on demand without replacing hidden cues', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed');
  });
  await page.goto(server.url);
  await page.locator('#batch-operations-btn').click();
  await page.locator('#timed-text-edit-btn').click();

  const showDisabled = page.locator('#timed-text-edit-show-disabled');
  const rows = page.locator('#timed-text-edit-rows textarea');
  await expect(showDisabled).not.toBeChecked();
  await expect(rows).toHaveCount(2);

  await showDisabled.check();
  await expect(rows).toHaveCount(3);
  await expect(page.locator('#timed-text-edit-rows .timed-text-edit-row').nth(2))
    .toHaveClass(/disabled/);

  await showDisabled.uncheck();
  await expect(rows).toHaveCount(2);
  await rows.nth(0).fill('就是那颗！');
  await page.locator('#timed-text-edit-apply').click();
  await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);

  const state = await page.evaluate(() => ({
    texts: MaweBoot.DATA.segments.map((segment) => segment.text),
    disabled: MaweBoot.DATA.segments.map((segment) => Boolean(segment.disabled)),
  }));
  expect(state.texts).toEqual(['就是那颗！', 'abc', 'disabled']);
  expect(state.disabled).toEqual([false, false, true]);
});

test('search follows disabled visibility, loops, handles invalid and zero-length regexes, and opens replace shortcuts', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed'));
  await page.goto(server.url);
  await page.locator('#timed-text-edit-btn').click();

  const find = page.locator('#timed-text-edit-find');
  await page.keyboard.press('Control+f');
  await expect(find).toBeFocused();
  await find.fill('d');
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('0/0');
  await page.locator('#timed-text-edit-show-disabled').check();
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('1/2');
  await page.locator('#timed-text-edit-find-next').click();
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('2/2');
  await page.locator('#timed-text-edit-find-next').click();
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('1/2');

  await page.locator('#timed-text-edit-regex').click();
  await find.fill('[');
  await expect(page.locator('#timed-text-edit-search-error')).toBeVisible();
  await expect(page.locator('#timed-text-edit-replace-all')).toBeDisabled();
  await find.fill('^|$');
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('1/6');
  await page.keyboard.press('Enter');
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('2/6');
  await page.keyboard.press('Shift+Enter');
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('1/6');

  await page.keyboard.press('Control+h');
  await expect(page.locator('#timed-text-edit-replace-row')).toBeVisible();
  await expect(page.locator('#timed-text-edit-replace')).toBeFocused();
});

test('search reveals filtered rows in the center and highlights/scrolls the matching text in overall view', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed'));
  await page.goto(server.url);
  await page.evaluate(() => {
    MaweBoot.DATA.segments = Array.from({ length: 24 }, (_, index) => ({
      id: `search-${index}`, start: index * 100, end: index * 100 + 80,
      text: index === 12 ? `${'x'.repeat(160)}needle target${'y'.repeat(160)}` : `caption ${index}`,
    }));
    MaweCuePanel.renderAll({ waveform: 'full' });
  });
  await page.locator('#timed-text-edit-btn').click();
  const rows = page.locator('#timed-text-edit-rows');
  const target = page.locator('#timed-text-edit-rows .timed-text-edit-row[data-index="12"]');
  await target.locator('textarea').fill(`${'x'.repeat(160)}changed needle target${'y'.repeat(160)}`);
  await page.evaluate(() => {
    MaweDom.timedTextEditDraft.filter = 'unchanged';
    MaweTimedTextEdit.flushTimedTextEditReport();
  });
  await expect(target).toBeHidden();

  const find = page.locator('#timed-text-edit-find');
  await find.fill('needle target');
  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/search-current/);
  const rowPosition = await page.evaluate(() => {
    const container = document.querySelector('#timed-text-edit-rows');
    const row = container.querySelector('.timed-text-edit-row.search-current');
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      scrollTop: container.scrollTop,
      centerError: Math.abs((rowRect.top + rowRect.height / 2) - (containerRect.top + container.clientHeight / 2)),
    };
  });
  expect(rowPosition.scrollTop).toBeGreaterThan(0);
  expect(rowPosition.centerError).toBeLessThan(2);
  await expect.poll(() => page.evaluate(() => MaweDom.timedTextEditDraft.filter)).toBeNull();

  await page.locator('#timed-text-edit-view [data-view="single"]').click();
  await find.fill('needle target');
  await expect(page.locator('#timed-text-edit-search-mirror .search-match.is-current')).toContainText('needle target');
  const overallPosition = await page.locator('#timed-text-edit-single-textarea').evaluate((textarea) => ({
    scrollTop: textarea.scrollTop,
    scrollLeft: textarea.scrollLeft,
  }));
  expect(overallPosition.scrollTop).toBeGreaterThan(0);
  expect(overallPosition.scrollLeft).toBeGreaterThan(0);
  await expect(rows).toBeHidden();
});

test('regex replacement uses captures, single replacement advances, and changes stay in the draft until applied', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed'));
  await page.goto(server.url);
  await page.locator('#timed-text-edit-btn').click();
  await page.locator('#timed-text-edit-view [data-view="single"]').click();
  const find = page.locator('#timed-text-edit-find');
  await page.locator('#timed-text-edit-regex').click();
  await find.fill('.');
  await page.keyboard.press('Control+h');
  const replacement = page.locator('#timed-text-edit-replace');
  await replacement.fill('X');
  await page.locator('#timed-text-edit-replace-one').click();
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('2/7');
  expect(await page.evaluate(() => MaweBoot.DATA.segments[1].text)).toBe('abc');
  await find.fill('([a-z])');
  await replacement.fill('$1$1');
  await page.locator('#timed-text-edit-replace-all').click();
  await expect(page.locator('#timed-text-edit-single-textarea')).toHaveValue('XX是这颗\naabbcc');
  expect(await page.evaluate(() => MaweBoot.DATA.segments[1].text)).toBe('abc');
  await page.locator('#timed-text-edit-apply').click();
  await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('XX是这颗');
  expect(await page.evaluate(() => MaweBoot.DATA.segments[1].text)).toBe('aabbcc');
});

test('cancelling pure-text replacement discards the draft', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed'));
  await page.goto(server.url);
  await page.locator('#timed-text-edit-btn').click();
  await page.locator('#timed-text-edit-find').fill('abc');
  await page.locator('#timed-text-edit-replace-toggle').click();
  await page.locator('#timed-text-edit-replace').fill('changed');
  await page.locator('#timed-text-edit-replace-one').click();
  expect(await page.evaluate(() => MaweBoot.DATA.segments[1].text)).toBe('abc');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#timed-text-edit-cancel').click();
  await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => MaweBoot.DATA.segments[1].text)).toBe('abc');
});

test('editor scrolls newly rendered inline warnings but leaves visible and repeated warnings in place', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(server.url);
  const positions = await page.evaluate(async () => {
    const container = document.createElement('div');
    container.style.cssText = 'height:100px; overflow-y:auto; position:fixed; top:20px; left:20px; width:240px;';
    const spacer = document.createElement('div');
    spacer.style.height = '500px';
    const warning = document.createElement('div');
    warning.className = 'warning';
    warning.textContent = 'new inline warning';
    warning.style.height = '28px';
    container.append(spacer, warning);
    document.body.appendChild(container);
    container.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const first = container.scrollTop;
    container.scrollTop = 0;
    warning.textContent = 'new inline warning';
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const duplicate = container.scrollTop;

    const visible = document.createElement('div');
    visible.className = 'warning';
    visible.textContent = 'visible warning';
    visible.style.cssText = 'position:fixed; top:30px; right:20px;';
    document.body.appendChild(visible);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const alreadyVisible = window.scrollY;
    container.remove();
    visible.remove();
    return { first, duplicate, alreadyVisible };
  });
  expect(positions.first).toBeGreaterThan(0);
  expect(positions.duplicate).toBe(0);
  expect(positions.alreadyVisible).toBe(0);
});
