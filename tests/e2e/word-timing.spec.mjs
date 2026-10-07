import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';

let tempDir, server;
test.beforeAll(async () => {
  tempDir = makeTempDir('word-timing');
  const media = join(tempDir, 'synthetic.wav'), project = join(tempDir, 'word-timing.mosp');
  generateWav(media, 12);
  writeFileSync(project, JSON.stringify({ media, waveform: generateWaveformPayload(12000), segments: [
    { id: 'main-a', start: 500, end: 7000, text: '我很喜欢！', items: [
      { text: '我', start: 1000, end: 2500 }, { text: '很喜欢', start: 3000, end: 6000 },
    ] },
    { id: 'main-b', start: 7500, end: 8500, text: '没有时间码' },
    { id: 'main-c', start: 9000, end: 11000, text: '今天好开心', items: [{ text: '今天', start: 9200, end: 9700 }] },
  ] }), 'utf8');
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false, autoSnapAdjacentCues: false }));
  });
  await page.goto(server.url);
  await expect(page.locator('.waveform-row').first()).toBeVisible();
});
const word = (page, index) => page.locator(`.waveform-word-block[data-segment-idx="0"][data-item-idx="${index}"]`).first();
const source = page => page.evaluate(() => JSON.parse(JSON.stringify(MaweBoot.DATA.segments[0])));

test('temporary display handles partial and absent timings in both waveform modes', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('#word-timing-toggle')).not.toBeChecked();
  await page.locator('#word-timing-toggle').check();
  await expect(word(page, 1)).toContainText('很喜欢！');
  await expect(word(page, 1)).toHaveAttribute('title', /00:03\.000.*00:06\.000/s);
  await expect(page.locator('.waveform-word-time')).toHaveCount(0);
  await expect(page.locator('.waveform-word-block[data-segment-idx="1"]')).toHaveCount(0);
  await expect(page.locator('.waveform-word-block[data-segment-idx="2"]')).toHaveCount(1);
  await expect(page.locator('.word-timing-background .waveform-cue-handle')).toHaveCount(0);
  const toggleSpacing = await page.locator('#word-timing-toggle').evaluate(el => {
    const toggle = el.closest('label').getBoundingClientRect();
    const row = document.querySelector('.waveform-row').getBoundingClientRect();
    return row.top - toggle.bottom;
  });
  expect(toggleSpacing).toBeGreaterThanOrEqual(8);
  await page.locator('[data-waveform-mode="basic"]').click();
  await expect(word(page, 0)).toBeVisible();
  await page.locator('#waveform-pane').screenshot({ path: testInfo.outputPath('word-basic.png') });
  await page.locator('[data-waveform-mode="multi"]').click();
  await expect(word(page, 0)).toBeVisible();
  await page.locator('#waveform-pane').screenshot({ path: testInfo.outputPath('word-multi.png') });
  await page.locator('#word-timing-toggle').uncheck();
  await expect(page.locator('.waveform-word-block')).toHaveCount(0);
  await expect(page.locator('.waveform-cue-block[data-track="main"] .waveform-cue-handle').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('partially missing text displays matched word punctuation but stays unavailable for conversion', async ({ page }) => {
  await page.evaluate(() => { MaweBoot.DATA.segments[0].text = '我，真的很喜欢！'; });
  await page.locator('#word-timing-toggle').check();
  await expect(word(page, 0).locator('.waveform-word-label')).toHaveText('我，');
  await expect(word(page, 1).locator('.waveform-word-label')).toHaveText('很喜欢！');
  expect((await source(page)).items.map(item => item.text)).toEqual(['我', '很喜欢']);
  await page.evaluate(() => MaweWordTiming.openConversion([0]));
  await expect(page.locator('#word-conversion-confirm')).toBeDisabled();
  await expect(page.locator('#word-conversion-skipped')).toContainText('文字未被完整覆盖');
});

test('drag only changes items, cancellation and undo restore exact data', async ({ page }) => {
  await page.locator('#word-timing-toggle').check();
  const before = await source(page);
  const box = await word(page, 0).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  const after = await source(page);
  expect(after.items[0].start).toBeGreaterThan(before.items[0].start);
  expect([after.start, after.end, after.text]).toEqual([before.start, before.end, before.text]);
  await page.keyboard.press('Control+z');
  expect((await source(page)).items).toEqual(before.items);
  await page.keyboard.press('Control+Shift+z');
  expect((await source(page)).items).toEqual(after.items);
  const next = await word(page, 0).boundingBox();
  await page.mouse.move(next.x + next.width / 2, next.y + 10);
  await page.mouse.down();
  await page.mouse.move(next.x + next.width / 2 + 20, next.y + 10);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await source(page)).items).toEqual(after.items);
});

test('range selection merges items and unsupported shortcuts never edit the parent', async ({ page }) => {
  await page.locator('#word-timing-toggle').check();
  await word(page, 0).click();
  await page.keyboard.press('Delete');
  await page.keyboard.press('r');
  await page.keyboard.press('b');
  await page.keyboard.press('z');
  await page.keyboard.press('x');
  await page.keyboard.press('h');
  await page.keyboard.press('ArrowLeft');
  expect([...(await source(page)).items.map(item => [item.start, item.end])]).toEqual([[1000, 2500], [3000, 6000]]);
  expect(await page.evaluate(() => MaweBoot.DATA.segments.length)).toBe(3);
  await word(page, 1).click({ modifiers: ['Shift'] });
  await page.keyboard.press('c');
  expect((await source(page)).items).toEqual([expect.objectContaining({ text: '我很喜欢', start: 1000, end: 6000 })]);
  expect((await source(page)).text).toBe('我很喜欢！');
  await page.keyboard.press('Control+z');
  expect((await source(page)).items.length).toBe(2);
});

test('word context menu preserves multi-selection until merge is applied', async ({ page }) => {
  await page.locator('#word-timing-toggle').check();
  await word(page, 0).click();
  await word(page, 1).click({ modifiers: ['Control'] });
  await word(page, 1).click({ button: 'right' });
  await page.locator('#ctxmenu .item').filter({ hasText: '合并选中的字词块' }).click();
  expect((await source(page)).items).toEqual([expect.objectContaining({ text: '我很喜欢', start: 1000, end: 6000 })]);
  await page.keyboard.press('Control+z');
  expect((await source(page)).items.length).toBe(2);
});

test('Tab outside the waveform cannot redirect word shortcuts to their parent sentence', async ({ page }) => {
  await page.locator('#word-timing-toggle').check();
  const before = await source(page);
  await word(page, 0).click();
  await word(page, 1).click({ modifiers: ['Shift'] });
  for (let count = 0; count < 30; count += 1) {
    if (await page.locator('#cue-list-follow').evaluate(el => el === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(page.locator('#cue-list-follow')).toBeFocused();
  await expect(page.locator('.waveform-word-block.selected')).toHaveCount(2);
  for (const key of ['Delete', 'b', 'Shift+b', 'Control+Shift+d', 'Alt+ArrowRight']) {
    await page.keyboard.press(key);
  }
  expect(await source(page)).toEqual(before);
  expect(await page.evaluate(() => MaweBoot.DATA.segments.length)).toBe(3);
  await page.keyboard.press('c');
  expect((await source(page)).items.length).toBe(1);
  expect((await source(page)).text).toBe(before.text);
});

test('conversion reviews skips and bindings, is atomic and preserves items on save', async ({ page }, testInfo) => {
  await page.evaluate(() => {
    MaweBoot.DATA.multi_subtitle = { schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
      tracks: [{ id: 'secondary', segments: [{ id: 'secondary-a', start: 500, end: 7000, text: 'I like it' }] }],
      bindings: [{ id: 'binding-a', track_id: 'secondary', main_segment_ids: ['main-a'], extension_segment_ids: ['secondary-a'] }],
    };
    MaweMultiSubtitleCore.normalizeMultiSubtitleState();
    MaweSelection.selectOnly(0);
    MaweSelection.addToSelection(1);
    MaweSelection.addToSelection(2);
    MaweContextMenus.showContextMenu(100, 100, 0);
  });
  await page.locator('.word-timing-advanced summary').click();
  expect(await page.locator('.word-timing-advanced button').evaluate(el =>
    el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().bottom,
  )).toBeGreaterThanOrEqual(8);
  await page.locator('.word-timing-advanced button').click();
  await expect(page.locator('#word-conversion-summary')).toContainText('可转换 1 句，生成 2 条字幕；跳过 2 句，解除 1 个副字幕绑定');
  await expect(page.locator('#word-conversion-skipped')).toContainText('文字未被完整覆盖');
  const spacing = await page.locator('.word-conversion-actions').evaluate(el => ({
    margin: parseFloat(getComputedStyle(el).marginTop),
    distance: el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().bottom,
  }));
  expect(spacing.margin).toBeGreaterThanOrEqual(8);
  expect(spacing.distance).toBeGreaterThanOrEqual(8);
  await page.locator('#word-conversion-dialog').screenshot({ path: testInfo.outputPath('word-conversion.png') });
  await page.locator('#word-conversion-confirm').click();
  await expect(page.locator('#word-conversion-dialog')).not.toBeVisible();
  const converted = await page.evaluate(() => ({
    segments: MaweBoot.DATA.segments, multi: MaweBoot.DATA.multi_subtitle,
  }));
  expect(converted.segments.length).toBe(4);
  expect(converted.segments.slice(0, 2).map(s => s.text).join('')).toBe('我很喜欢！');
  expect(converted.segments[1].items[0].text).toBe('很喜欢！');
  expect(converted.multi.bindings).toEqual([]);
  expect(converted.multi.tracks[0].segments[0].text).toBe('I like it');
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => MaweBoot.DATA.segments.length)).toBe(3);
  expect(await page.evaluate(() => MaweBoot.DATA.multi_subtitle.bindings.length)).toBe(1);
  await page.keyboard.press('Control+Shift+z');
  expect(await page.evaluate(() => MaweBoot.DATA.segments.length)).toBe(4);
  const saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(saved.segments[1].items[0].text).toBe('很喜欢！');
  expect(JSON.stringify(saved)).not.toContain('wordTiming');
  await page.locator('#word-timing-toggle').check();
  await page.evaluate(data => MaweProjectLoad.applyCanonicalProject(data, 'reloaded.mosp'), saved);
  await expect(page.locator('#word-timing-toggle')).not.toBeChecked();
  expect(await page.evaluate(() => MaweBoot.DATA.segments[1].items[0].text)).toBe('很喜欢！');
});

test('classic linked edges and Alt independence edit only in-sentence items', async ({ page }) => {
  await page.evaluate(() => {
    MaweBoot.DATA.timebase = { unit: 'milliseconds', fps: 30 };
    MaweSettings.EDITOR_SETTINGS.autoSnapAdjacentCues = true;
    MaweSettings.EDITOR_SETTINGS.adjacentBoundaryMode = 'classic';
    MaweBoot.DATA.segments[0].items = [{ text: '我', start: 1000, end: 3000 }, { text: '很喜欢', start: 3000, end: 6000 }];
  });
  await page.locator('#word-timing-toggle').check();
  let handle = await word(page, 0).locator('.right').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 20, handle.y + handle.height / 2, { steps: 3 });
  await page.mouse.up();
  let items = (await source(page)).items;
  expect(items[0].end).toBeGreaterThan(3000);
  expect(items[0].end).toBe(items[1].start);
  await page.keyboard.press('Control+z');
  handle = await word(page, 0).locator('.right').boundingBox();
  await page.keyboard.down('Alt');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 20, handle.y + handle.height / 2, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  items = (await source(page)).items;
  expect(items[0].end).toBeLessThan(3000);
  expect(items[1].start).toBe(3000);
  expect((await source(page)).end).toBe(7000);
});

test('dual seam links both sides, cross-row fragments retain only their real edge handles', async ({ page }) => {
  await page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.adjacentBoundaryMode = 'dual';
    MaweBoot.DATA.segments[0].items[0].end = 3000;
    MaweBoot.DATA.segments[0].items[0].end_frame = 90;
    MaweCoreState.waveformEditor.settings.secondsPerRow = 5;
    MaweCoreState.waveformEditor.render();
  });
  await page.locator('#word-timing-toggle').check();
  const fragments = page.locator('.waveform-word-block[data-segment-idx="0"][data-item-idx="1"]');
  await expect(fragments).toHaveCount(2);
  await expect(fragments.first()).toHaveClass(/continues-to-next-row/);
  await expect(fragments.first().locator('.right')).toHaveCount(0);
  await expect(fragments.last().locator('.left')).toHaveCount(0);
  const seam = await page.locator('.waveform-word-boundary').first().boundingBox();
  await page.mouse.move(seam.x + seam.width / 2, seam.y + seam.height / 2);
  await page.mouse.down();
  await page.mouse.move(seam.x + 20, seam.y + seam.height / 2, { steps: 3 });
  await page.mouse.up();
  const items = (await source(page)).items;
  expect(items[0].end).toBe(items[1].start);
  expect(items[0].end).toBeGreaterThan(3000);
});

test('frame editing and conversion preserve narrow one-frame words through save and reload', async ({ page }, testInfo) => {
  await page.evaluate(() => {
    MaweBoot.DATA.timebase = { unit: 'frames', fps: 30 };
    const segment = MaweBoot.DATA.segments[0];
    segment.start_frame = 15;
    segment.end_frame = 210;
    segment.items = [
      { text: '我', start: 1000, end: 1033, start_frame: 30, end_frame: 31 },
      { text: '很喜欢', start: 3000, end: 6000, start_frame: 90, end_frame: 180 },
    ];
  });
  await page.locator('#word-timing-toggle').check();
  await expect(word(page, 0)).toHaveAttribute('title', /00:00:01:00.*00:00:01:01/s);
  await expect(page.locator('.waveform-word-time')).toHaveCount(0);
  await page.locator('#waveform-pane').screenshot({ path: testInfo.outputPath('word-narrow-frame.png') });
  const handle = await word(page, 1).locator('.right').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 18, handle.y + handle.height / 2, { steps: 3 });
  await page.mouse.up();
  const edited = (await source(page)).items;
  expect(edited[1].end_frame).toBeGreaterThan(180);
  expect(edited[1].end).toBe(Math.round(edited[1].end_frame * 1000 / 30));
  await page.evaluate(() => MaweWordTiming.openConversion([0]));
  await page.locator('#word-conversion-confirm').click();
  const saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(saved.segments[0]).toMatchObject({ start: 1000, end: 1033, start_frame: 30, end_frame: 31 });
  expect(saved.segments[0].items).toEqual([expect.objectContaining({ start: 1000, end: 1033, start_frame: 30, end_frame: 31 })]);
  await page.evaluate(data => MaweProjectLoad.applyCanonicalProject(data, 'frames.mosp'), saved);
  expect((await source(page)).items[0]).toMatchObject({ start: 1000, end: 1033, start_frame: 30, end_frame: 31 });
});

test('narrow word centers move without stretching and both edge handles remain usable', async ({ page }) => {
  await page.evaluate(() => {
    MaweBoot.DATA.timebase = { unit: 'milliseconds', fps: 30 };
    MaweBoot.DATA.segments[0].items[0] = { text: '我', start: 1000, end: 1033 };
  });
  await page.locator('#word-timing-toggle').check();
  const box = await word(page, 0).boundingBox();
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(await page.evaluate(point => Boolean(document.elementFromPoint(point.x, point.y)?.closest('.waveform-cue-handle')), center)).toBe(false);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 15, center.y, { steps: 3 });
  await page.mouse.up();
  const moved = (await source(page)).items[0];
  expect(moved.start).toBeGreaterThan(1000);
  expect(moved.end - moved.start).toBe(33);
  for (const edge of ['right', 'left']) {
    const before = (await source(page)).items[0];
    const handle = await word(page, 0).locator(`.${edge}`).boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + (edge === 'right' ? 10 : -10), handle.y + handle.height / 2, { steps: 3 });
    await page.mouse.up();
    const after = (await source(page)).items[0];
    if (edge === 'right') {
      expect(after.start).toBe(before.start);
      expect(after.end).toBeGreaterThan(before.end);
    } else {
      expect(after.end).toBe(before.end);
      expect(after.start).toBeLessThan(before.start);
    }
  }
});

test('redo during an active word drag cancels the gesture and preserves pending redo', async ({ page }) => {
  await page.locator('#word-timing-toggle').check();
  const before = (await source(page)).items;
  const startDrag = async distance => {
    const box = await word(page, 0).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + distance, box.y + box.height / 2, { steps: 3 });
  };
  await startDrag(12);
  await page.mouse.up();
  const committed = (await source(page)).items;
  await page.keyboard.press('Control+z');
  expect((await source(page)).items).toEqual(before);
  await startDrag(18);
  await page.keyboard.press('Control+y');
  await page.mouse.up();
  expect(await page.evaluate(() => Boolean(MaweCoreState.waveformEditor.wordDrag))).toBe(false);
  expect((await source(page)).items).toEqual(before);
  expect(await page.evaluate(() => MaweHistory.editorHistory.redoLength())).toBe(1);
  await page.keyboard.press('Control+y');
  expect((await source(page)).items).toEqual(committed);
});

test('merge cannot nest inside an active word drag or be overwritten by its snapshot', async ({ page }) => {
  await page.locator('#word-timing-toggle').check();
  await word(page, 0).click();
  await word(page, 1).click({ modifiers: ['Control'] });
  const box = await word(page, 0).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 3 });
  await page.keyboard.press('c');
  expect((await source(page)).items.length).toBe(2);
  expect(await page.evaluate(() => MaweHistory.editorHistory.undoLength())).toBe(0);
  await page.mouse.up();
  const moved = (await source(page)).items;
  expect(await page.evaluate(() => MaweHistory.editorHistory.undoLength())).toBe(1);
  await page.keyboard.press('c');
  expect((await source(page)).items.length).toBe(1);
  await page.keyboard.press('Control+z');
  expect((await source(page)).items).toEqual(moved);
});

test('conversion disables unavailable targets and requires review if data changes while open', async ({ page }) => {
  await page.evaluate(() => MaweWordTiming.openConversion([1, 2]));
  await expect(page.locator('#word-conversion-confirm')).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.evaluate(() => MaweWordTiming.openConversion([0]));
  await page.evaluate(() => {
    MaweBoot.DATA.segments[0].items[0].start = 1100;
    MaweBoot.DATA.segments[0].items[0].start_frame = 33;
  });
  await page.locator('#word-conversion-confirm').click();
  await expect(page.locator('#word-conversion-dialog')).toBeVisible();
  expect(await page.evaluate(() => MaweBoot.DATA.segments.length)).toBe(3);
  await page.locator('#word-conversion-confirm').click();
  await expect(page.locator('#word-conversion-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].start)).toBe(1100);
});

test('English UI does not translate project words or their hover text', async ({ page }) => {
  await page.evaluate(() => {
    MaweBoot.DATA.segments[0].text = '字词时间码';
    MaweBoot.DATA.segments[0].items = [{ text: '字词时间码', start: 1000, end: 6000 }];
    MAWE_I18N.applyLanguage('en');
  });
  await page.locator('#word-timing-toggle').check();
  await expect(page.locator('.word-timing-toggle')).toContainText('Word timings');
  await expect(word(page, 0).locator('.waveform-word-label')).toHaveText('字词时间码');
  await expect(word(page, 0)).toHaveAttribute('title', /^字词时间码/);
  await page.evaluate(() => MaweWordTiming.openConversion([0]));
  await expect(page.locator('#word-conversion-warning')).toContainText('has not been realigned to audio');
});

test('no-op gestures do not create undo history and leaving words clears their highlight', async ({ page }) => {
  await page.locator('#word-timing-toggle').check();
  await expect(page.locator('#undo-btn')).toBeDisabled();
  await word(page, 0).click();
  await expect(page.locator('#undo-btn')).toBeDisabled();
  await expect(word(page, 0)).toHaveClass(/selected/);
  await page.locator('.waveform-cue-block[data-track="main"][data-idx="1"]').first().click();
  await expect(page.locator('.waveform-word-block.selected')).toHaveCount(0);
  const box = await word(page, 0).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + 10);
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.up();
  await expect(page.locator('#undo-btn')).toBeDisabled();
});
