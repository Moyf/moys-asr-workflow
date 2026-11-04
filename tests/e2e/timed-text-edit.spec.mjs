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

test.beforeEach(async ({ page }) => {
  // Tests share one server fixture; a view-only change is now a project edit.
  // Keep automatic saves from leaking one test's draft/project into the next.
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({autoSaveProject: false}));
  });
});

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

test('overall editing completes MASS styles in both preview and saved word timings', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed'));
  await page.goto(server.url);
  await page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule = 'both';
    MaweBoot.DATA.segments.splice(0, MaweBoot.DATA.segments.length, {
      id: 'styled', start: 0, end: 1500, text: '**甲乙丙**', items: [
        { text: '**甲', start: 0, end: 500 }, { text: '乙', start: 500, end: 1000 }, { text: '丙**', start: 1000, end: 1500 },
      ],
    });
    MaweCuePanel.renderAll();
  });
  await page.locator('#batch-operations-btn').click();
  await page.locator('#timed-text-edit-btn').click();
  await page.locator('#timed-text-edit-view [data-view="single"]').click();
  await page.locator('#timed-text-edit-single-textarea').fill('**甲\n乙\n丙**');
  const expected = ['**甲**', '**乙**', '**丙**'];
  await expect.poll(() => page.evaluate(() => MaweDom.timedTextEditDraft.report.previewSegments?.map(row => row.text) || [])).toEqual(expected);
  await page.locator('#timed-text-edit-apply').click();
  await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);
  const saved = await page.evaluate(() => MaweBoot.DATA.segments.map(row => ({ text: row.text, items: row.items })));
  expect(saved.map(row => row.text)).toEqual(expected);
  expect(saved.flatMap(row => row.items).map(item => [item.start, item.end])).toEqual([[0, 500], [500, 1000], [1000, 1500]]);
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

test('search navigation focuses the hit textarea with a visible caret, F3/Enter continue while armed', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed'));
  await page.goto(server.url);
  await page.evaluate(() => {
    MaweBoot.DATA.segments.splice(0, MaweBoot.DATA.segments.length,
      { id: 's-1', start: 0, end: 900, text: 'alpha beta' },
      { id: 's-2', start: 1000, end: 1900, text: 'gamma delta' },
    );
    MaweCuePanel.renderAll({ waveform: 'full' });
  });
  await page.locator('#timed-text-edit-btn').click();

  const find = page.locator('#timed-text-edit-find');
  await find.fill('a');
  // 在查找框输入时的预览定位不抢焦点：光标留在查找框继续输入。
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('1/6');
  await expect(find).toBeFocused();

  const rowSelection = () => page.evaluate(() => {
    const textarea = document.activeElement;
    if (!(textarea instanceof HTMLTextAreaElement)) return null;
    return {
      value: textarea.value,
      selected: textarea.value.slice(textarea.selectionStart, textarea.selectionEnd),
      row: textarea.closest('.timed-text-edit-row')?.dataset.index ?? null,
      // 行 textarea 必须叠在镜像层之上（与整体视图一致），caret 才不会被
      // 不透明镜像背景盖住。
      caretAboveMirror: getComputedStyle(textarea).zIndex === '2'
        && getComputedStyle(textarea).position === 'relative'
        && getComputedStyle(textarea).caretColor !== 'transparent',
    };
  });

  await page.locator('#timed-text-edit-find-next').click();
  // 显式导航把焦点移入命中所在 textarea：选区落在命中文字上，caret 可见。
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('2/6');
  expect(await rowSelection()).toEqual({
    value: 'alpha beta', selected: 'a', row: '0', caretAboveMirror: true,
  });

  await page.keyboard.press('F3');
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('3/6');
  expect((await rowSelection()).row).toBe('0');
  await page.keyboard.press('Enter');
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('4/6');
  expect((await rowSelection())).toMatchObject({ value: 'gamma delta', selected: 'a', row: '1' });
  await page.keyboard.press('Shift+F3');
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('3/6');

  // 方向键移动光标后选区不再等于命中，武装解除：Enter 恢复普通换行，
  // 不再跳转下一个命中（定位到命中后直接拆句的工作流不受影响）。
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  // 草稿在输入事件里同步拆行：row0 从命中字母处断开，且计数没有前进。
  const disarmed = await page.evaluate(() => MaweDom.timedTextEditDraft.texts.slice(0, 2));
  expect(disarmed).toEqual(['alpha bet', 'a']);
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('3/6');

  // Greptile P2 场景：拆行触发防抖重渲染，等第三行出现后再继续。
  await expect(page.locator('#timed-text-edit-rows .timed-text-edit-row[data-index="2"]')).toHaveCount(1);
  // 打字编辑（替换命中的 a）后即使退格删掉、光标回到原位置，武装也已
  // 解除——Enter 插入换行，而不是复活成跳转。
  await page.keyboard.press('Shift+F3');
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('2/6');
  expect(await rowSelection()).toMatchObject({ value: 'alpha bet', selected: 'a', row: '0' });
  await page.keyboard.type('X');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('a');
  await page.keyboard.press('Enter');
  const typedAndDisarmed = await page.evaluate(() => MaweDom.timedTextEditDraft.texts.slice(0, 2));
  expect(typedAndDisarmed).toEqual(['alpha', ' bet']);

  await page.keyboard.press('Control+f');
  await expect(find).toBeFocused();

  // 收尾关闭弹窗，避免脏草稿跨测试残留（有未应用修改时 Esc 会弹确认）。
  page.once('dialog', (dialog) => dialog.accept());
  await page.keyboard.press('Escape');
  await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);
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

test('English whole-text search mirror preserves subtitles through highlights and language switches', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed'));
  await page.goto(`${server.url}?lang=en`);
  await page.evaluate(() => {
    MaweBoot.DATA.segments[0].text = '查找';
    MaweBoot.DATA.segments[1].text = '查找保存';
    MaweCuePanel.renderAll({ waveform: 'full' });
  });
  await page.locator('#timed-text-edit-btn').click();
  await page.locator('#timed-text-edit-view [data-view="single"]').click();
  const mirror = page.locator('#timed-text-edit-search-mirror');
  const textarea = page.locator('#timed-text-edit-single-textarea');
  await expect(mirror).toHaveText('查找\n查找保存');
  await page.locator('#timed-text-edit-find').fill('查找');
  await expect(mirror.locator('.search-match')).toHaveText(['查找', '查找']);
  await expect(mirror).toHaveText('查找\n查找保存');
  await expect(textarea).toHaveValue('查找\n查找保存');
  for (const language of ['zh', 'en']) {
    await page.evaluate((value) => MAWE_I18N.applyLanguage(value), language);
    await expect(mirror).toHaveText('查找\n查找保存');
    await expect(textarea).toHaveValue('查找\n查找保存');
  }
  const spacing = await page.locator('.timed-text-edit-search').evaluate((element) => {
    const search = element.getBoundingClientRect();
    const controls = element.previousElementSibling.getBoundingClientRect();
    return {distance: search.left >= controls.right
      ? search.left - controls.right : search.top - controls.bottom};
  });
  expect(spacing.distance).toBeGreaterThanOrEqual(8);
  console.log('pure-text search spacing:', JSON.stringify(spacing));
  await page.locator('#timed-text-edit-modal').screenshot({ path: testInfo.outputPath('english-project-search.png') });
});

test('regex replacement uses captures, single replacement advances, and changes stay in the draft until applied', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed'));
  await page.goto(server.url);
  const before = await page.evaluate(() => JSON.parse(JSON.stringify(MaweBoot.DATA.segments)));
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
  await replacement.fill('$01$01');
  await page.locator('#timed-text-edit-replace-all').click();
  await expect(page.locator('#timed-text-edit-single-textarea')).toHaveValue('XX是这颗\naabbcc');
  expect(await page.evaluate(() => MaweBoot.DATA.segments[1].text)).toBe('abc');
  await page.locator('#timed-text-edit-apply').click();
  await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('XX是这颗');
  expect(await page.evaluate(() => MaweBoot.DATA.segments[1].text)).toBe('aabbcc');
  const applied = await page.evaluate(() => JSON.parse(JSON.stringify(MaweBoot.DATA.segments)));
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => JSON.parse(JSON.stringify(MaweBoot.DATA.segments)))).toEqual(before);
  await page.keyboard.press('Control+Shift+z');
  expect(await page.evaluate(() => JSON.parse(JSON.stringify(MaweBoot.DATA.segments)))).toEqual(applied);
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

test('immediate close and scope changes confirm the latest draft before its report debounce', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed'));
  await page.goto(server.url);
  await page.locator('#timed-text-edit-btn').click();
  const result = await page.evaluate(() => {
    let confirmations = 0;
    const originalConfirm = window.confirm;
    window.confirm = () => { confirmations += 1; return false; };
    try {
      const textarea = document.querySelector('#timed-text-edit-rows textarea');
      textarea.value = 'latest unreported edit';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#timed-text-edit-cancel').click();
      const openAfterClose = MaweDom.timedTextEditModal.classList.contains('show');
      document.querySelector('#timed-text-edit-show-disabled').click();
      return {
        confirmations, openAfterClose,
        showDisabled: MaweDom.timedTextEditDraft?.showDisabled,
        text: MaweDom.timedTextEditDraft?.texts[0],
        originalText: MaweBoot.DATA.segments[0].text,
      };
    } finally { window.confirm = originalConfirm; }
  });
  expect(result.confirmations).toBe(2);
  expect(result.openAfterClose).toBe(true);
  expect(result.showDisabled).toBe(false);
  expect(result.text).toBe('latest unreported edit');
  expect(result.originalText).toBe('就是这颗');
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

test('warning observer scans inserted rows without repeatedly traversing their parent list', async ({ page }) => {
  await page.goto(server.url);
  const scans = await page.evaluate(async () => {
    const list = document.createElement('div');
    document.body.appendChild(list);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const originalQuery = Element.prototype.querySelectorAll;
    let parentScans = 0;
    let visitedElements = 0;
    Element.prototype.querySelectorAll = function(selector) {
      if (selector.includes('[role="alert"]') && (this === list || list.contains(this))) {
        if (this === list) parentScans += 1;
        visitedElements += originalQuery.call(this, '*').length;
      }
      return originalQuery.call(this, selector);
    };
    try {
      for (let index = 0; index < 200; index += 1) {
        const row = document.createElement('div');
        row.appendChild(document.createElement('span'));
        list.appendChild(row);
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return { parentScans, visitedElements };
    } finally {
      Element.prototype.querySelectorAll = originalQuery;
      list.remove();
    }
  });
  expect(scans.parentScans).toBe(0);
  expect(scans.visitedElements).toBeLessThanOrEqual(200);
});


test('search clear, native focus order and row diff layout stay usable at narrow widths', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed'));
  await page.goto(server.url);
  await page.locator('#batch-operations-btn').click();
  await page.locator('#timed-text-edit-btn').click();
  await page.locator('#timed-text-edit-replace-toggle').click();
  const find = page.locator('#timed-text-edit-find');
  const replacement = page.locator('#timed-text-edit-replace');
  await find.fill('abc');
  await expect(find).toHaveAttribute('type', 'search');
  await find.press('Tab');
  await expect(replacement).toBeFocused();
  await replacement.press('Shift+Tab');
  await expect(find).toBeFocused();
  const box = await find.boundingBox();
  await page.mouse.click(box.x + box.width - 18, box.y + box.height / 2);
  await expect(find).toHaveValue('');
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('0/0');
  await expect(page.locator('.timed-text-edit-row.search-current')).toHaveCount(0);
  await page.locator('#timed-text-edit-rows textarea').first().fill('就是那颗');
  const row = page.locator('.timed-text-edit-row').first();
  await expect(row.locator('.timed-text-edit-row-diff')).toBeVisible();
  await expect(row.locator('.timed-text-edit-timing-change')).toHaveCount(0);
  const geometry = await row.evaluate(element => {
    const input = element.querySelector('textarea').getBoundingClientRect();
    const diff = element.querySelector('.timed-text-edit-row-diff').getBoundingClientRect();
    return {gap: diff.left - input.right, topDifference: Math.abs(input.top - diff.top)};
  });
  expect(geometry.gap).toBeGreaterThanOrEqual(8);
  expect(geometry.topDifference).toBeLessThan(2);
  await page.locator('#timed-text-edit-case').focus();
  expect(await page.locator('#timed-text-edit-case').evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
  await page.locator('#timed-text-edit-modal').screenshot({path: testInfo.outputPath('timed-text-wide.png')});
  await page.setViewportSize({width: 540, height: 760});
  const overflow = await page.locator('#timed-text-edit-modal').evaluate(element => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.locator('#timed-text-edit-modal').screenshot({path: testInfo.outputPath('timed-text-narrow.png')});
});

test('timed-text view preference survives save and reopen and rows is omitted', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed'));
  await page.goto(server.url);
  await page.evaluate(() => { MaweSettings.EDITOR_SETTINGS.autoSaveProject = false; });
  await page.locator('#batch-operations-btn').click();
  await page.locator('#timed-text-edit-btn').click();
  await page.locator('#timed-text-edit-view [data-view="single"]').click();
  expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(true);
  expect(await page.evaluate(() => MaweProjectSave.saveProjectToServer())).toBe(true);
  expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(false);
  await page.reload();
  await page.evaluate(() => { MaweSettings.EDITOR_SETTINGS.autoSaveProject = false; });
  await page.locator('#batch-operations-btn').click();
  await page.locator('#timed-text-edit-btn').click();
  await expect(page.locator('#timed-text-edit-single-textarea')).toBeVisible();
  await page.locator('#timed-text-edit-view [data-view="rows"]').click();
  expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(true);
  expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).timed_text_edit_view)).toBeUndefined();
  expect(await page.evaluate(() => MaweProjectSave.saveProjectToServer())).toBe(true);
  await page.reload();
  await page.locator('#batch-operations-btn').click();
  await page.locator('#timed-text-edit-btn').click();
  await expect(page.locator('#timed-text-edit-rows')).toBeVisible();
  expect(await page.evaluate(() => MaweBoot.DATA.timed_text_edit_view)).toBeUndefined();
});

test('unavailable single view falls back only at runtime and loading another project clears its preference', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed'));
  await page.goto(server.url);
  await page.evaluate(() => {
    const project = JSON.parse(MaweJsonRepair.buildJson());
    project.timed_text_edit_view = 'single';
    project.segments[0].text = '甲\n乙';
    MaweProjectLoad.applyCanonicalProject(project, 'multiline.mosp');
  });
  await page.locator('#batch-operations-btn').click();
  await page.locator('#timed-text-edit-btn').click();
  await expect(page.locator('#timed-text-edit-rows')).toBeVisible();
  await expect(page.locator('#timed-text-edit-view [data-view="single"]')).toBeDisabled();
  expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).timed_text_edit_view)).toBe('single');
  expect(await page.evaluate(() => MaweState.changes.timedTextEditViewDirty)).toBe(false);
  await page.evaluate(() => {
    MaweState.changes.timedTextEditViewDirty = true;
    MaweProjectLoad.applyCanonicalProject(MaweProjectLoad.buildBlankProject(), 'blank.mosp');
  });
  expect(await page.evaluate(() => MaweBoot.DATA.timed_text_edit_view)).toBe('rows');
  expect(await page.evaluate(() => MaweState.changes.timedTextEditViewDirty)).toBe(false);
  expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).timed_text_edit_view)).toBeUndefined();
});
