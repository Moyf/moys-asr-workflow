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
test('word presets apply immediately and restore across bilingual mode changes', async ({ page }) => {
  await page.locator('[data-waveform-mode="multi"]').click();
  await page.evaluate(() => {
    MaweCoreState.waveformEditor.setRowHeight(192);
    MaweCoreState.waveformEditor.setSecondsPerRow(20);
  });
  await setWordTiming(page);
  expect(await page.evaluate(() => MaweCoreState.waveformEditor.settings.secondsPerRow)).toBe(5);
  await page.evaluate(() => {
    const input = document.getElementById('word-timing-seconds-per-row');
    input.value = '10'; input.dispatchEvent(new Event('change'));
  });
  expect(await page.evaluate(() => MaweCoreState.waveformEditor.settings.secondsPerRow)).toBe(10);
  await page.locator('#multi-subtitle-quick-toggle').click();
  expect(await page.evaluate(() => MaweCoreState.waveformEditor.getRowHeight())).toBe(168);
  await setWordTiming(page, false);
  expect(await page.evaluate(() => MaweCoreState.waveformEditor.getRowHeight())).toBe(168);
  expect(await page.evaluate(() => MaweCoreState.waveformEditor.settings.secondsPerRow)).toBe(20);
  await page.locator('#multi-subtitle-quick-toggle').click();
  expect(await page.evaluate(() => MaweCoreState.waveformEditor.getRowHeight())).toBe(192);
});

test('bilingual compact words expose the sentence and low-height overlays stay inside its lane', async ({ page }, testInfo) => {
  await page.locator('[data-waveform-mode="multi"]').click();
  await page.locator('#multi-subtitle-quick-toggle').click();
  await setWordTiming(page);
  const row = page.locator('.waveform-row.multi-subtitle-row').first();
  const geometry = await row.evaluate(el => {
    const main = el.querySelector('.waveform-cue-block[data-track="main"]').getBoundingClientRect();
    const word = el.querySelector('.waveform-word-block').getBoundingClientRect();
    return { mainHeight: main.height, wordHeight: word.height, exposed: word.top - main.top };
  });
  expect(geometry.mainHeight).toBe(44);
  expect(geometry.wordHeight).toBe(31);
  expect(geometry.exposed).toBeGreaterThanOrEqual(8);
  await setWordTiming(page, false);
  await page.evaluate(() => {
    MaweBoot.DATA.overlay_track = { enabled: true, segments: [{ id: 'overlay-short', start: 1000, end: 2000, text: 'overlay' }] };
    MaweCoreState.waveformEditor.setRowHeight(64);
  });
  const short = await row.evaluate(el => {
    const overlay = el.querySelector('.waveform-overlay-block');
    const a = el.getBoundingClientRect(), b = overlay.getBoundingClientRect();
    const main = el.querySelector('.waveform-cue-block[data-track="main"]').getBoundingClientRect();
    return { cover: overlay.classList.contains('overlay-cover-mode'), top: b.top - a.top, bottom: b.bottom - a.top,
      mainTop: main.top - a.top, mainBottom: main.bottom - a.top, rowHeight: a.height };
  });
  expect(short.cover).toBe(true);
  expect(short.top).toBeGreaterThanOrEqual(0);
  expect(short.bottom).toBeLessThanOrEqual(short.rowHeight);
  expect(short.top).toBeCloseTo(short.mainTop, 0);
  expect(short.bottom).toBeCloseTo(short.mainBottom, 0);
  await page.locator('#waveform-pane').screenshot({ path: testInfo.outputPath('compact-overlay.png') });
});
const source = page => page.evaluate(() => JSON.parse(JSON.stringify(MaweBoot.DATA.segments[0])));
for (const mode of ['basic', 'multi']) {
test(`full word layout preserves sentence height, highlight and body dragging in ${mode}`, async ({ page }, testInfo) => {
  await page.locator(`[data-waveform-mode="${mode}"]`).click();
  await setWordTiming(page);
  const main = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first();
  await expect(main).toHaveClass(/word-timing-full/);
  expect(await main.evaluate(el => el.getBoundingClientRect().height)).toBe(35);
  expect(await word(page, 0).evaluate(el => el.getBoundingClientRect().height)).toBe(35);
  await main.click({ position: { x: 20, y: 18 } });
  await expect(main).toHaveClass(/selected/);
  expect(await main.evaluate(el => parseFloat(getComputedStyle(el).opacity))).toBe(1);
  const before = await source(page);
  const box = await main.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 18);
  await page.mouse.down();
  await page.mouse.move(box.x + 45, box.y + 18, { steps: 3 });
  await page.mouse.up();
  expect((await source(page)).start).toBeGreaterThan(before.start);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await source(page)).toEqual(before);
  await page.locator('#waveform-pane').screenshot({ path: testInfo.outputPath(`word-full-${mode}.png`) });
});
}

test('bilingual overlays keep their lane after creation, undo and redo at 192px', async ({ page }) => {
  await page.locator('#multi-subtitle-quick-toggle').click();
  await page.evaluate(() => {
    MaweBoot.DATA.overlay_track = { enabled: true, segments: [] };
    MaweCoreState.waveformEditor.setRowHeight(192);
    MaweCoreState.waveformEditor.setSecondsPerRow(10);
  });
  const row = page.locator('.waveform-row.multi-subtitle-row').first();
  const points = await row.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const position = time => rect.left + (time - Number(el.dataset.startMs)) / (Number(el.dataset.endMs) - Number(el.dataset.startMs)) * rect.width;
    return { x1: position(1000), x2: position(2000), y: rect.top + 30 };
  });
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.move(points.x1, points.y); await page.mouse.down();
  await page.mouse.move(points.x2, points.y, { steps: 8 }); await page.mouse.up();
  await page.keyboard.up('ControlOrMeta');
  const overlay = row.locator('.waveform-overlay-block');
  await expect(overlay).toHaveCount(1);
  const gap = () => row.evaluate(el => el.querySelector('.waveform-cue-block[data-track="main"]').getBoundingClientRect().top
    - el.querySelector('.waveform-overlay-block').getBoundingClientRect().bottom);
  expect(await gap()).toBeGreaterThanOrEqual(1);
  // 新建后焦点进入字幕文本框；使用工具栏历史动作，避免触发输入框原生撤销。
  await page.locator('#undo-btn').click();
  await expect(overlay).toHaveCount(0);
  await page.locator('#redo-btn').click();
  await expect(overlay).toHaveCount(1);
  expect(await gap()).toBeGreaterThanOrEqual(1);
});
async function setWordTiming(page, enabled = true) {
  // 字词时间码开关已收敛到工具栏 🔤 快捷按钮（与项目设置镜像联动）。
  const quick = page.locator('#word-timing-quick-toggle');
  if (await quick.getAttribute('aria-pressed') === String(enabled)) return;
  await quick.click();
  await expect(quick).toHaveAttribute('aria-pressed', String(enabled));
}

test('word timing separation stays within multi-row single-track waveforms', async ({ page }, testInfo) => {
  await setWordTiming(page);
  await page.locator('[data-waveform-mode="multi"]').click();
  const multi = await word(page, 0).evaluate(el => ({
    height: parseFloat(getComputedStyle(el).height), bottom: parseFloat(getComputedStyle(el).bottom),
  }));
  await page.locator('[data-waveform-mode="basic"]').click();
  const basic = await word(page, 0).evaluate(el => ({
    height: parseFloat(getComputedStyle(el).height), bottom: parseFloat(getComputedStyle(el).bottom),
  }));
  await page.evaluate(() => {
    MaweBoot.DATA.multi_subtitle = { enabled: true, tracks: [{ id: 'timing-extension', segments: [
      { start: 500, end: 7000, text: 'extension text' },
    ] }] };
    MaweCuePanel.renderAll();
  });
  await page.locator('[data-waveform-mode="multi"]').click();
  const row = page.locator('.waveform-row.multi-subtitle-row').first();
  await expect(row.locator('.waveform-cue-block[data-track="extension"]').first()).toBeVisible();
  const lanes = await row.evaluate(el => {
    const main = el.querySelector('.waveform-cue-block[data-track="main"]');
    const extension = el.querySelector('.waveform-cue-block[data-track="extension"]');
    return {
      mainBottom: parseFloat(getComputedStyle(main).bottom),
      extensionBottom: parseFloat(getComputedStyle(extension).bottom),
      mainRectBottom: main.getBoundingClientRect().bottom,
      extensionRectTop: extension.getBoundingClientRect().top,
    };
  });
  console.log('word timing geometry', JSON.stringify({ multi, basic, lanes }));
  await page.locator('#waveform-pane').screenshot({ path: testInfo.outputPath('word-bilingual-lanes.png') });
  expect(multi).toEqual({ height: 35, bottom: 44 });
  expect(basic).toEqual({ height: 35, bottom: 44 });
  expect(lanes.mainBottom).toBeGreaterThan(lanes.extensionBottom);
  expect(lanes.mainRectBottom).toBeLessThanOrEqual(lanes.extensionRectTop + 1);
});

test('word timing lives on the toolbar toggle and waveform settings keep appearance groups', async ({ page }, testInfo) => {
  await expect(page.locator('.waveform-toolbar > .word-timing-toggle, .waveform-toolbar > .gap-skip-toggle')).toHaveCount(0);
  await page.locator('#waveform-settings-toggle').click();
  const panel = page.locator('#waveform-settings-panel');
  await expect(panel.locator('#word-timing-toggle')).toHaveCount(0);
  await expect(panel.locator('#gap-skip-playback')).toHaveCount(0);
  await expect(panel.locator('.waveform-settings-title')).toHaveText(['外观', '显示']);
  await expect(panel.locator('#waveform-settings-appearance #waveform-scale-fit')).toBeVisible();
  const spacing = await panel.evaluate(el => {
    const groups = [...el.querySelectorAll('.waveform-settings-section')];
    const rects = groups.map(group => group.getBoundingClientRect());
    return {
      groups: rects.slice(1).map((rect, index) => rect.top - rects[index].bottom),
      titles: groups.map(group => {
        const title = group.firstElementChild.getBoundingClientRect();
        const next = [...group.children].slice(1).map(child => child.getBoundingClientRect()).find(rect => rect.height > 0);
        return next.top - title.bottom;
      }),
    };
  });
  for (const distance of [...spacing.groups, ...spacing.titles]) {
    expect(distance, JSON.stringify(spacing)).toBeGreaterThanOrEqual(8);
  }
  await testInfo.attach('settings spacing', { body: JSON.stringify(spacing), contentType: 'application/json' });
  await panel.screenshot({ path: testInfo.outputPath('waveform-settings-groups.png') });
  await page.screenshot({ path: testInfo.outputPath('waveform-options.png') });
  await page.locator('#waveform-settings-toggle').click();
  // 🪶 在工具栏；🔖 标记编辑默认关闭且「标记与区段」入口隐藏。
  const quick = page.locator('#word-timing-quick-toggle');
  await expect(quick).toHaveAttribute('aria-pressed', 'false');
  await quick.click();
  await expect(quick).toHaveAttribute('aria-pressed', 'true');
  await expect(word(page, 0)).toBeVisible();
  const markerQuick = page.locator('#markers-quick-toggle');
  await expect(markerQuick).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#markers-manage')).toBeHidden();
  await page.locator('[data-waveform-mode="basic"]').click();
  await expect(quick).toHaveAttribute('aria-pressed', 'true');
  await expect(word(page, 0)).toBeVisible();
});

test('temporary display handles partial and absent timings in both waveform modes', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('#word-timing-quick-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#markers-manage')).toBeHidden();
  await setWordTiming(page);
  await expect(word(page, 1)).toContainText('很喜欢！');
  await expect(word(page, 1)).toHaveAttribute('data-title', /00:03\.000.*00:06\.000/s);
  await expect(page.locator('.waveform-word-time')).toHaveCount(0);
  await expect(page.locator('.waveform-word-block[data-segment-idx="1"]')).toHaveCount(0);
  await expect(page.locator('.waveform-word-block[data-segment-idx="2"]')).toHaveCount(1);
  await expect(page.locator('.word-timing-background .waveform-cue-handle')).toHaveCount(0);
  await page.locator('[data-waveform-mode="basic"]').click();
  await expect(word(page, 0)).toBeVisible();
  await page.locator('#waveform-pane').screenshot({ path: testInfo.outputPath('word-basic.png') });
  await page.locator('[data-waveform-mode="multi"]').click();
  await expect(word(page, 0)).toBeVisible();
  await page.locator('#waveform-pane').screenshot({ path: testInfo.outputPath('word-multi.png') });
  await setWordTiming(page, false);
  await expect(page.locator('.waveform-word-block')).toHaveCount(0);
  await expect(page.locator('.waveform-cue-block[data-track="main"] .waveform-cue-handle').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('partially missing text displays matched word punctuation but stays unavailable for conversion', async ({ page }) => {
  await page.evaluate(() => { MaweBoot.DATA.segments[0].text = '我，真的很喜欢！'; });
  await setWordTiming(page);
  await expect(word(page, 0).locator('.waveform-word-label')).toHaveText('我，');
  await expect(word(page, 1).locator('.waveform-word-label')).toHaveText('很喜欢！');
  expect((await source(page)).items.map(item => item.text)).toEqual(['我', '很喜欢']);
  await page.evaluate(() => MaweWordTiming.openConversion([0]));
  await expect(page.locator('#word-conversion-confirm')).toBeDisabled();
  await expect(page.locator('#word-conversion-skipped')).toContainText('文字未被完整覆盖');
});

test('drag only changes items, cancellation and undo restore exact data', async ({ page }) => {
  await setWordTiming(page);
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
  await setWordTiming(page);
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
  await setWordTiming(page);
  await word(page, 0).click();
  await word(page, 1).click({ modifiers: ['Control'] });
  await word(page, 1).click({ button: 'right' });
  await page.locator('#ctxmenu .item').filter({ hasText: '合并选中的字词块' }).click();
  expect((await source(page)).items).toEqual([expect.objectContaining({ text: '我很喜欢', start: 1000, end: 6000 })]);
  await page.keyboard.press('Control+z');
  expect((await source(page)).items.length).toBe(2);
});

test('Tab outside the waveform cannot redirect word shortcuts to their parent sentence', async ({ page }) => {
  await setWordTiming(page);
  const before = await source(page);
  await word(page, 0).click();
  await word(page, 1).click({ modifiers: ['Shift'] });
  for (let count = 0; count < 30; count += 1) {
    if (await page.locator('#cue-list-follow').evaluate(el => el === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(page.locator('#cue-list-follow')).toBeFocused();
  expect(await page.locator('.waveform-word-block.selected').evaluateAll(elements =>
    [...new Set(elements.map(el => Number(el.dataset.itemIdx)))].sort())).toEqual([0, 1]);
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
    MaweWordTiming.setEnabled(true);
    MaweContextMenus.showContextMenu(100, 100, 0);
  });
  await page.locator('.word-timing-advanced > .item').first().click();
  await page.locator('.word-timing-advanced .danger').click();
  await expect(page.locator('#word-conversion-summary')).toContainText('将转换1句，生成2条新的字幕（跳过2句，解除1个副字幕绑定）');
  await expect(page.locator('#word-conversion-warning')).toHaveText('可通过撤销恢复；不提供反向转换工具。');
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(page.locator('#word-conversion-warning')).toHaveText('You can undo this conversion; no reverse-conversion tool is provided.');
  await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
  await expect(page.locator('#word-conversion-skipped')).toContainText('文字未被完整覆盖');
  const spacing = await page.locator('.word-conversion-actions').evaluate(el => ({
    margin: parseFloat(getComputedStyle(el).marginTop),
    distance: el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().bottom,
  }));
  expect(spacing.margin).toBeGreaterThanOrEqual(8);
  expect(spacing.distance).toBeGreaterThanOrEqual(8);
  console.log('word conversion spacing:', JSON.stringify(spacing));
  const confirmStyle = await page.locator('#word-conversion-confirm').evaluate((button) => getComputedStyle(button).backgroundColor);
  expect(confirmStyle).not.toBe('rgba(0, 0, 0, 0)');
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
  await setWordTiming(page);
  await page.evaluate(data => MaweProjectLoad.applyCanonicalProject(data, 'reloaded.mosp'), saved);
  await expect(page.locator('#word-timing-quick-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#markers-manage')).toBeHidden();
  expect(await page.evaluate(() => MaweBoot.DATA.segments[1].items[0].text)).toBe('很喜欢！');
});

test('classic linked edges and Alt independence edit only in-sentence items', async ({ page }) => {
  await page.evaluate(() => {
    MaweBoot.DATA.timebase = { unit: 'milliseconds', fps: 30 };
    MaweSettings.EDITOR_SETTINGS.autoSnapAdjacentCues = true;
    MaweSettings.EDITOR_SETTINGS.adjacentBoundaryMode = 'classic';
    MaweBoot.DATA.segments[0].items = [{ text: '我', start: 1000, end: 3000 }, { text: '很喜欢', start: 3000, end: 6000 }];
  });
  await setWordTiming(page);
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
  await setWordTiming(page);
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
  await setWordTiming(page);
  await expect(word(page, 0)).toHaveAttribute('data-title', /00:00:01:00.*00:00:01:01/s);
  await expect(page.locator('.waveform-word-time')).toHaveCount(0);
  await page.locator('#waveform-pane').screenshot({ path: testInfo.outputPath('word-narrow-frame.png') });
  const handle = await page.locator('.waveform-word-block[data-segment-idx="0"][data-item-idx="1"] .right').last().boundingBox();
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
  await setWordTiming(page);
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
  await setWordTiming(page);
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
  await setWordTiming(page);
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
  await setWordTiming(page);
  await expect(page.locator('#word-timing-quick-toggle')).toBeVisible();
  await expect(page.locator('#waveform-settings-panel .waveform-settings-title')).toHaveText(['Appearance', 'Display']);
  await expect(word(page, 0).locator('.waveform-word-label')).toHaveText('字词时间码');
  await expect(word(page, 0)).toHaveAttribute('data-title', /^字词时间码/);
  await page.evaluate(() => MaweWordTiming.openConversion([0]));
  await expect(page.locator('#word-conversion-description')).toContainText('split each complete sentence into individual word subtitles');
});

test('no-op gestures do not create undo history and leaving words clears their highlight', async ({ page }) => {
  await setWordTiming(page);
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

test('equal-length typo replacement syncs item texts through the cue panel', async ({ page }) => {
  await page.evaluate(() => MaweSettings.updateEditorSettings({ cueEditorCancelOnEscape: true }));
  await setWordTiming(page);
  await page.locator('.cue[data-idx="0"]').click();
  const panel = page.locator('#cue-panel-text');
  await expect(panel).toHaveValue('我很喜欢！');
  await panel.fill('我最喜欢！');
  expect((await source(page)).items.map(item => item.text)).toEqual(['我', '很喜欢']);
  await panel.blur();
  await expect(page.locator('#hint-stack')).toContainText('已同步字词时间码文字');
  expect((await source(page)).items.map(item => item.text)).toEqual(['我', '最喜欢！']);
  // 长度变化落在单个字词块 span 内时同样同步；提交时提示实际差异。
  await panel.fill('我非常喜欢！');
  expect((await source(page)).items.map(item => item.text)).toEqual(['我', '最喜欢！']);
  await panel.blur();
  await expect(page.locator('#hint-stack')).toContainText('已同步字词时间码文字（共1处：[最喜欢！ -> 非常喜欢！]）');
  expect((await source(page)).items.map(item => item.text)).toEqual(['我', '非常喜欢！']);
  // Esc 取消整次编辑：文字与字词一起回到会话开始的状态（上一次 blur 提交后）
  await panel.fill('我非常有喜欢！');
  await page.keyboard.press('Escape');
  const restored = await source(page);
  expect([restored.text, restored.items.map(item => item.text)]).toEqual(['我非常喜欢！', ['我', '非常喜欢！']]);
});

for (const { timebase, startFrame } of [
  { timebase: { unit: 'milliseconds', fps: 30 }, startFrame: 30 },
  ...[30, 29.97].flatMap(fps => [1, 30].map(startFrame => ({ timebase: { unit: 'frames', fps }, startFrame }))),
]) {
  for (const adjacent of [true, false]) {
    test(`pure text edits preserve narrow ${timebase.unit} cues at ${timebase.fps} FPS from frame ${startFrame} with ${adjacent ? 'adjacent' : 'spaced'} neighbors`, async ({ page }) => {
      await page.evaluate(({ timebase, startFrame, adjacent }) => {
        MaweSettings.updateEditorSettings({ autoSaveProject: false, cueEditorCancelOnEscape: true });
        MaweCuePanelState.currentCuePanelIdx = -1;
        MaweCuePanelState.resetCuePanelEditState({ discard: true });
        MaweSelection.clearSelection({ commitCuePanel: false });
        MaweHistory.editorHistory.clear();
        const start = timebase.unit === 'frames' ? MaweTimeline.millisecondsFromFrameNumber(startFrame, timebase.fps) : 1000;
        const end = timebase.unit === 'frames' ? MaweTimeline.millisecondsFromFrameNumber(startFrame + 1, timebase.fps) : 1060;
        MaweBoot.DATA.timebase = timebase;
        MaweBoot.DATA.segments.splice(0, MaweBoot.DATA.segments.length,
          { id: 'narrow-before', start: 0, end: start, text: 'Before' },
          { id: 'narrow-text', start, end, text: 'a', items: [{ start, end, text: 'a' }] },
          { id: 'narrow-after', start: adjacent ? end : 4000, end: 5000, text: 'After' },
        );
        MaweCuePanel.renderAll();
      }, { timebase, startFrame, adjacent });
      await page.locator('.cue[data-idx="1"]').click();
      const read = () => page.evaluate(() => JSON.parse(JSON.stringify(MaweBoot.DATA.segments)));
      const before = await read();
      const expected = structuredClone(before);
      expected[1].text = 'b';
      expected[1].items[0].text = 'b';
      const withoutDirty = segments => segments.map(({ _dirty, ...segment }) => segment);
      const panel = page.locator('#cue-panel-text');
      await panel.fill('b');
      await panel.blur();
      expect(withoutDirty(await read())).toEqual(withoutDirty(expected));
      expect(await page.evaluate(() => MaweHistory.editorHistory.undoLength())).toBe(1);
      await page.evaluate(() => MaweHistory.performUndo());
      expect(withoutDirty(await read())).toEqual(withoutDirty(before));
      await page.evaluate(() => MaweHistory.performRedo());
      expect(withoutDirty(await read())).toEqual(withoutDirty(expected));
      await page.locator('.cue[data-idx="1"]').click();
      await panel.fill('c');
      await panel.press('Escape');
      expect(withoutDirty(await read())).toEqual(withoutDirty(expected));
      const saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).segments[1]);
      expect(saved).toMatchObject({ start: expected[1].start, end: expected[1].end, text: 'b' });
      expect(saved.items[0]).toMatchObject({ start: expected[1].items[0].start, end: expected[1].items[0].end, text: 'b' });
    });
  }
}

test('saving focused cue panel text syncs word labels before resetting the edit snapshot', async ({ page }) => {
  await page.evaluate(() => {
    MaweSettings.updateEditorSettings({ cueEditorCancelOnEscape: true });
    MaweServerSave.projectFileHandle = {
      name: 'word-label-save.mosp',
      async createWritable() {
        return {
          async write(blob) { window.__savedWordLabelProject = JSON.parse(await blob.text()); },
          async close() {},
        };
      },
    };
  });
  await page.locator('.cue[data-idx="0"]').click();
  const panel = page.locator('#cue-panel-text');
  await panel.fill('我最喜欢！');
  await panel.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__savedWordLabelProject?.segments[0].text)).toBe('我最喜欢！');
  expect(await page.evaluate(() => window.__savedWordLabelProject.segments[0].items.map(item => item.text)))
    .toEqual(['我', '最喜欢！']);
  await expect(panel).toBeFocused();
  expect((await source(page)).items.map(item => item.text)).toEqual(['我', '最喜欢！']);
  await panel.fill('我更喜欢！');
  await panel.blur();
  expect((await source(page)).items.map(item => item.text)).toEqual(['我', '更喜欢！']);
  await panel.fill('我很喜欢！');
  await page.keyboard.press('Escape');
  expect([ (await source(page)).text, (await source(page)).items.map(item => item.text) ])
    .toEqual(['我更喜欢！', ['我', '更喜欢！']]);
});

test('selected sentence gains edge handles in word timing mode and drags only its own range', async ({ page }) => {
  await setWordTiming(page);
  // 此用例验证 compact 降级；足够行高的 full 模式保持常显手柄与整句拖动。
  await page.evaluate(() => {
    MaweCoreState.waveformEditor.setRowHeight(80);
    MaweCoreState.waveformEditor.setSecondsPerRow(10);
  });
  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first();
  await expect(block.locator('.waveform-cue-handle')).toHaveCount(0);
  // The upper sentence strip is exposed above the foreground word blocks.
  await block.click({ position: { x: 10, y: 3 } });
  await expect(block).toHaveClass(/selected/);
  await expect(block.locator('.waveform-cue-handle')).toHaveCount(2);
  expect(await block.evaluate(el => parseFloat(getComputedStyle(el).opacity))).toBeCloseTo(0.45);
  const before = await source(page);
  const handle = block.locator('.waveform-cue-handle.right');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 15, box.y + box.height / 2, { steps: 3 });
  await page.mouse.up();
  const after = await source(page);
  expect(after.end).toBeGreaterThan(before.end);
  expect(after.start).toBe(before.start);
  expect(after.items.at(-1).end).toBeLessThanOrEqual(after.end);
  await page.keyboard.press('Control+z');
  expect((await source(page)).end).toBe(before.end);
  // 取消选中后手柄再次隐藏
  await page.keyboard.press('Escape');
  await expect(block.locator('.waveform-cue-handle')).toHaveCount(0);
});

test('audition plays the picked range once from both word and sentence menus', async ({ page }) => {
  await setWordTiming(page);
  // 句块菜单：试听位于跳转区
  await page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first().click({ button: 'right', position: { x: 10, y: 3 } });
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '试听' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  // 字词菜单：试听选中字词范围并在终点自动暂停
  await word(page, 1).click({ button: 'right' });
  await page.locator('#ctxmenu .item').filter({ hasText: '试听' }).click();
  await expect.poll(async () => page.evaluate(() => MaweCoreState.player.paused), { timeout: 8000 }).toBe(true);
  const seconds = await page.evaluate(() => MaweCoreState.player.currentTime);
  expect(seconds).toBeGreaterThanOrEqual(2.9);
  expect(seconds).toBeLessThanOrEqual(6.3);
});

test('context menu keeps clip actions up front and moves low-frequency entries into advanced', async ({ page }) => {
  await page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').click({ button: 'right' });
  const menu = page.locator('#ctxmenu');
  await expect(menu.locator(':scope > .item > span').filter({ hasText: '转为叠加字幕' })).toHaveCount(0);
  await expect(menu.locator(':scope > .item > span').filter({ hasText: '左右添加字符' })).toHaveCount(0);
  await menu.locator('.word-timing-advanced > .item').first().click();
  await expect(menu.locator('.word-timing-advanced .danger')).toHaveCount(0);
  await page.evaluate(() => {
    MaweWordTiming.setEnabled(true);
    MaweContextMenus.showContextMenu(100, 100, 0);
  });
  await menu.locator('.word-timing-advanced > .item').first().hover();
  const overlayButton = menu.locator('.word-timing-advanced button').filter({ hasText: '转为叠加字幕' });
  const wrapHeading = menu.locator('.word-timing-advanced').locator('span', { hasText: '左右添加字符' });
  const convertButton = menu.locator('.word-timing-advanced .danger');
  await expect(overlayButton).toHaveCount(1);
  await expect(convertButton).toHaveCount(1);
  await expect(wrapHeading).toBeVisible();
  const parentBox = await menu.boundingBox();
  const submenuBox = await menu.locator('.word-timing-advanced-list').boundingBox();
  expect(submenuBox.x).toBeGreaterThanOrEqual(parentBox.x + parentBox.width - 2);
});

for (const trigger of ['menu', 'shortcut']) test(`word audition converts frame ranges to media milliseconds via ${trigger}`, async ({ page }) => {
  await page.evaluate(() => {
    MaweBoot.DATA.timebase = { unit: 'frames', fps: 30 };
    MaweWordTiming.setEnabled(true);
  });
  if (trigger === 'menu') {
    await word(page, 1).click({ button: 'right' });
    await page.locator('#ctxmenu .item').filter({ hasText: '试听' }).click();
  } else {
    await word(page, 1).click();
    await page.keyboard.press('f');
  }
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.currentTime)).toBeGreaterThanOrEqual(3);
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.paused), { timeout: 8000 }).toBe(true);
  const end = await page.evaluate(() => MaweCoreState.player.currentTime);
  expect(end).toBeGreaterThanOrEqual(5.9);
  expect(end).toBeLessThanOrEqual(6.3);
});
