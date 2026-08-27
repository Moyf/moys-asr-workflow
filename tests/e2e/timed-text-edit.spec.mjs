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
    texts: DATA.segments.map((segment) => segment.text),
    items: DATA.segments.map((segment) => segment.items),
    ranges: DATA.segments.map((segment) => [segment.start, segment.end]),
    dirty: DATA.segments.map((segment) => Boolean(segment._dirty)),
  }));
  expect(state.texts).toEqual(['就是那颗', 'abXc', 'disabled']);
  expect(state.ranges).toEqual([[0, 1000], [1200, 2200], [2300, 2800]]);
  expect(state.dirty).toEqual([true, true, false]);
  expect(state.items[0]).toEqual([
    { start: 0, end: 400, text: '就是' },
    { start: 400, end: 1000, text: '那颗' },
  ]);
  expect(state.items[1]).toEqual([
    { start: 1200, end: 1500, text: 'a' },
    { start: 1500, end: 1800, text: 'bX' },
    { start: 1800, end: 2200, text: 'c' },
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
    texts: DATA.segments.map((segment) => segment.text),
    disabled: DATA.segments.map((segment) => Boolean(segment.disabled)),
  }));
  expect(state.texts).toEqual(['就是那颗！', 'abc', 'disabled']);
  expect(state.disabled).toEqual([false, false, true]);
});
