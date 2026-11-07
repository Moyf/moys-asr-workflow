import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { buildBrowserEditorFixture, cleanupTempDir, disableOnboarding, findFreePort, generateProjectJson,
  generateWav, makeTempDir, openSettingsPage, startServer, addTextProcessStep, removeTextProcessPrefill } from './helpers.mjs';

let server;
let portable;
let tempDir;
test.beforeAll(async () => {
  const dir = makeTempDir('text-tools');
  tempDir = dir;
  const project = join(dir, 'project.json');
  const media = join(dir, 'synthetic.wav');
  generateProjectJson(project);
  generateWav(media, 300);
  portable = buildBrowserEditorFixture(join(dir, 'portable.html'));
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await disableOnboarding(page);
  await page.goto(server.url);
  await expect(page.locator('.cue[data-idx="0"] .text')).toBeVisible();
});

async function seed(page, { text = '甲乙丙丁', timed = true, linked = false } = {}) {
  await page.evaluate(({ text, timed, linked }) => {
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments = [{ id: 'main-1', start: 1000, end: 5000, text,
      items: timed ? Array.from(text, (text, i) => ({ text,
        start: i === 2 ? 3500 : 1000 + i * 1000,
        end: i === 2 ? 4000 : 2000 + i * 1000 })) : null }];
    MaweBoot.DATA.tracks = MaweBoot.DATA.tracks.filter(track => track.role !== 'secondary');
    MaweBoot.DATA.bindings = [];
    MaweBoot.DATA.bilingual = { display_mode: 'both' };
    if (linked) {
      const extension = AsrEditorUtils.ensureExtensionTrack(MaweBoot.DATA, { id: 'ext-1', name: '译文',
        enabled: true, split_mode: 'continuous', segments: [{ id: 'ext-cue', start: 1000, end: 5000, text: '一二三四' }] });
      const main = AsrEditorUtils.getMainTrack(MaweBoot.DATA);
      MaweBoot.DATA.bindings.push(AsrEditorUtils.buildSubtitleBinding(main.segments[0], extension.segments[0], extension.id, 'binding-1', main.id));
    }
    MaweSettings.updateEditorSettings({ autoSaveProject: false });
    MaweSelection.clearSelection({ silent: true });
    MaweCuePanel.renderAll({ waveform: 'full' });
  }, { text, timed, linked });
}

test('progressive right halves realign repeated timed suffix items from the end', async ({ page }) => {
  const result = await page.evaluate(() => {
    const source = { start: 1000, end: 5000, text: '甲乙甲乙', items: [
      { text: '甲', start: 1000, end: 2000 }, { text: '乙', start: 2000, end: 3000 },
      { text: '甲', start: 3000, end: 4000 }, { text: '乙', start: 4000, end: 5000 },
    ] };
    const first = MaweSplitCore.splitItemsAtChar(source, 2, 3000);
    const right = { ...source, start: first.splitMs, items: first.rightItems };
    const second = MaweSplitCore.splitItemsAtChar(right, 3);
    return { first: first.rightItems.map(({ text, start, end }) => [text, start, end]),
      splitMs: second.splitMs,
      left: second.leftItems.map(({ text, start, end }) => [text, start, end]),
      right: second.rightItems.map(({ text, start, end }) => [text, start, end]) };
  });
  expect(result.first).toEqual([['甲', 3000, 4000], ['乙', 4000, 5000]]);
  expect(result.splitMs).toBe(4000);
  expect(result.left).toEqual([['甲', 3000, 4000]]);
  expect(result.right).toEqual([['乙', 4000, 5000]]);
});

test('progressive suffix timings preserve the DE|F cut in a partially timed cue', async ({ page }) => {
  const result = await page.evaluate(() => {
    const segment = { start: 3000, end: 6000, text: 'ABCDEF', items: [
      { text: 'D', start: 3000, end: 4000 }, { text: 'E', start: 4000, end: 5000 },
      { text: 'F', start: 5000, end: 6000 },
    ] };
    const split = MaweSplitCore.splitItemsAtChar(segment, 5);
    return { splitMs: split.splitMs,
      left: split.leftItems.map(({ text, start, end }) => [text, start, end]),
      right: split.rightItems.map(({ text, start, end }) => [text, start, end]) };
  });
  expect(result.splitMs).toBe(5000);
  expect(result.left).toEqual([['D', 3000, 4000], ['E', 4000, 5000]]);
  expect(result.right).toEqual([['F', 5000, 6000]]);
});

test('progressive repeated multi-character words keep the suffix cut and timing', async ({ page }) => {
  const result = await page.evaluate(() => {
    const segment = { start: 3000, end: 5000, text: '上海上海前进', items: [
      { text: '上海', start: 3000, end: 4000 },
      { text: '前进', start: 4000, end: 5000 },
    ] };
    const split = MaweSplitCore.splitItemsAtChar(segment, 4);
    return { splitMs: split.splitMs,
      left: split.leftItems.map(({ text, start, end }) => [text, start, end]),
      right: split.rightItems.map(({ text, start, end }) => [text, start, end]) };
  });
  expect(result.splitMs).toBe(4000);
  expect(result.left).toEqual([['上海', 3000, 4000]]);
  expect(result.right).toEqual([['前进', 4000, 5000]]);
});

for (const mode of ['progressive', 'duplicate']) {
  for (const path of ['timed', 'untimed', 'linked']) {
    test(`${mode} split preserves its mode through the ${path} waveform path and undo`, async ({ page }) => {
      await seed(page, { timed: path === 'timed', linked: path === 'linked' });
      await page.evaluate((splitTextMode) => {
        MaweSplitContext.splitFromContextMenu(0, 10, 10, 3000, { splitTextMode });
      }, mode);
      if (path !== 'timed') {
        await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
        await page.locator('#multi-subtitle-split-confirm').click();
      }
      const result = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments);
      expect(result.map(s => s.text)).toEqual(mode === 'progressive' ? ['甲乙', '甲乙丙丁'] : ['甲乙丙丁', '甲乙丙丁']);
      expect(result.map(s => [s.start, s.end])).toEqual([[1000, 3000], [3000, 5000]]);
      expect(result[1].start).toBe(result[0].end);
      if (mode === 'duplicate') expect(result[1].items).toBeNull();
      else if (path === 'timed') {
        expect(result[1].items.map(({ text, start, end }) => ({ text, start, end }))).toEqual([
          { text: '丙', start: 3500, end: 4000 },
          { text: '丁', start: 4000, end: 5000 },
        ]);
      }
      if (mode === 'duplicate') expect(result[0].items).toBeNull();
      else if (path === 'timed') expect(result[0].items.map(i => i.text)).toEqual(['甲', '乙']);
      await page.locator('#undo-btn').click();
      expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.text))).toEqual(['甲乙丙丁']);
    });
  }
}

test('cue-list text offsets preserve the editable fade prefix', async ({ page }) => {
  await seed(page, { text: '>>甲乙丙丁<<', timed: false });
  await expect(page.locator('.cue[data-idx="0"] .text')).toHaveText('>>甲乙丙丁<<');
});

for (const path of ['timed', 'untimed', 'linked']) {
  test(`splitting and project save preserve the source speaker through the ${path} path`, async ({ page }) => {
    await seed(page, { timed: path === 'timed', linked: path === 'linked' });
    await page.evaluate(() => {
      MaweBoot.DATA.speakers = [{ id: 'opaque-speaker', name: '源说话人', color: '#49c5c1' }];
      const segment = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0];
      segment.speaker = 'opaque-speaker';
      MaweSplitContext.splitFromContextMenu(0, 10, 10, 3000, { splitTextMode: 'progressive' });
    });
    if (path !== 'timed') await page.locator('#multi-subtitle-split-confirm').click();
    expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.speaker)))
      .toEqual(['opaque-speaker', 'opaque-speaker']);
    const saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
    expect(await page.evaluate(project => AsrEditorUtils.validateTracksProject(project).errors, saved)).toEqual([]);
    expect(saved.speakers).toEqual([{ id: 'opaque-speaker', name: '源说话人', color: '#49c5c1' }]);
    const savedMain = saved.tracks.find(track => track.role === 'main');
    expect(savedMain.segments.map(s => s.speaker)).toEqual(['opaque-speaker', 'opaque-speaker']);
    expect(savedMain.segments.flatMap(s => s.items || []).every(item => !Object.hasOwn(item, 'speaker'))).toBe(true);
    expect(savedMain.segments.map(s => s.text)).toEqual(['甲乙', '甲乙丙丁']);
    await page.locator('#undo-btn').click();
    expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.speaker))).toEqual(['opaque-speaker']);
    await page.locator('#redo-btn').click();
    expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.speaker)))
      .toEqual(['opaque-speaker', 'opaque-speaker']);
    // Reopen through the real project drop loader in a fresh portable editor.
    await page.goto(`file://${portable}`);
    await expect(page.locator('#cues-container')).toBeVisible();
    const dataTransfer = await page.evaluateHandle((project) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([JSON.stringify(project)], 'speakers.mosp', { type: 'application/json' }));
      return transfer;
    }, saved);
    await page.dispatchEvent('body', 'drop', { dataTransfer });
    await dataTransfer.dispose();
    await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.speaker)))
      .toEqual(['opaque-speaker', 'opaque-speaker']);
    expect(await page.evaluate(() => MaweBoot.DATA.speakers)).toEqual(saved.speakers);
  });
}

test('custom wrapping isolates Delete and B while a button has focus', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => { MaweSelection.selectOnly(0); MaweTextProcess.openWrapCharsModal([0]); });
  await expect(page.locator('#wrap-chars-modal')).toHaveClass(/show/);
  await expect(page.locator('#wrap-chars-left')).toBeFocused();
  await page.locator('#wrap-chars-confirm').focus();
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(1);
  await page.keyboard.press('Shift+B');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#wrap-chars-modal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => [...MaweSelection.selectedIdxs])).toEqual([0]);
});

test('batch wrap presets skip existing wrappers and keep preview and undo consistent', async ({ page }) => {
  await seed(page, { text: '**甲乙**', timed: false });
  await page.evaluate(() => {
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.push({ id: 'main-2', start: 5000, end: 7000, text: '丙丁', items: null });
    MaweCuePanel.renderAll();
  });
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-mode-toggle').check();
  await page.locator('#project-settings-close').click();
  await page.evaluate(() => {
    MaweSelection.selectOnly(0);
    MaweTextProcess.openTextProcessModal();
  });
  await removeTextProcessPrefill(page);
  const step = await addTextProcessStep(page, 'wrap');
  await step.locator('[data-wrap-preset-id="emphasis"]').click();
  await expect(page.locator('#text-process-preview')).toContainText('不会发生变化');
  await expect(page.locator('#text-process-confirm')).toBeDisabled();
});

test('text processing uses the custom wrapping row and allows one-sided characters', async ({ page }) => {
  await seed(page);
  await page.locator('#text-process-btn').click();
  await removeTextProcessPrefill(page);
  const step = await addTextProcessStep(page, 'wrap');
  await expect(step.locator('[data-wrap-preset-id="emphasis"]')).toHaveCount(0);
  await expect(step.locator('[data-wrap-preset-id="note"]')).toBeVisible();
  await step.getByRole('button', { name: '自定义' }).click();
  await expect(step.getByRole('textbox', { name: '左侧添加' })).toBeVisible();
  await page.locator('#text-preset-rules').getByRole('textbox', { name: '左侧添加' }).fill('【');
  await expect(page.locator('#text-process-preview')).toContainText('处理后：【甲乙丙丁');
  await page.locator('#text-process-confirm').click();
  await expect(page.locator('.cue[data-idx="0"] .text')).toHaveText('【甲乙丙丁');
});

test('text process preview expands all rows and syncs the action label', async ({ page }) => {
  await page.evaluate(() => {
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments = [
      { id: 'main-a', start: 1000, end: 2000, text: ' 甲 ', items: null },
      { id: 'main-b', start: 2000, end: 3000, text: ' 乙 ', items: null },
      { id: 'main-c', start: 3000, end: 4000, text: '丙', items: null },
    ];
    MaweCuePanel.renderAll({ waveform: 'full' });
  });
  const follow = page.locator('#cue-list-follow');
  await expect(follow).toHaveText('跟随中');
  await page.evaluate(() => MaweCueListAnchor.interruptCueListFollowing());
  await expect(follow).toHaveText('恢复跟随');
  await follow.click();
  await expect(follow).toHaveText('跟随中');

  await expect(page.locator('#filter-over')).toHaveText('🧐');
  await expect(page.locator('#filter-over')).toHaveAttribute('aria-label', '仅看超长');
  expect(await page.locator('#timed-text-edit-btn').evaluate((button) => button.previousElementSibling?.classList.contains('sep')))
    .toBe(false);

  await page.locator('#text-process-btn').click();
  await removeTextProcessPrefill(page);
  await expect(page.locator('#text-process-scope-info')).toHaveText('当前范围：全部 3 条字幕');
  await addTextProcessStep(page, 'trim');
  const preview = page.locator('#text-process-preview');
  const rows = preview.locator('details.replace-preview-row');
  await expect(rows).toHaveCount(2);
  const expand = preview.locator('.text-process-preview-toggle');
  expect(await preview.locator('.text-process-preview-summary').evaluate((summary) => {
    return Number.parseFloat(getComputedStyle(summary).columnGap);
  })).toBeGreaterThanOrEqual(8);
  await expect(expand).toHaveText('全部展开');
  await expand.click();
  await expect(preview.locator('details[open]')).toHaveCount(2);
  await expect(expand).toHaveText('全部收缩');
  await rows.first().locator('summary').click();
  await expect(expand).toHaveText('全部展开');
  await expand.click();
  await expect(preview.locator('details[open]')).toHaveCount(2);
  const showAll = preview.locator('.text-process-preview-filter');
  await showAll.click();
  await expect(rows).toHaveCount(3);
  await expect(rows.last().locator('.replace-preview-before')).toHaveText('处理前：丙');
  await expect(rows.last().locator('.replace-preview-after')).toHaveText('处理后：丙');
  await expect(showAll).toBeFocused();
  await showAll.click();
  await expect(rows).toHaveCount(2);
});

test('the selected-cue shortcut uses the shared text processing preview', async ({ page }) => {
  await page.route('**/api/text-processing-presets', route => route.fulfill({ json: {
    schema: 'moy.asr.text_processing_presets.v2', revision: 1, defaultPresetId: 'default',
    presets: [{ id: 'default', name: 'User trim', scope: 'all', steps: [{ type: 'trim' }] }],
  } }));
  await page.evaluate(() => {
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments = [
      { id: 'one', start: 1000, end: 2000, text: '猫-狗\n猫-鸟' },
      { id: 'two', start: 2000, end: 3000, text: '猫-狗' },
      { id: 'three', start: 3000, end: 4000, text: '猫-鸟' },
    ];
    MaweCuePanel.renderAll({ waveform: 'full' });
    MaweSelection.selectOnly(0);
    MaweSelection.addManyToSelection([1]);
  });
  await expect(page.locator('#replace-btn')).toHaveCount(0);
  await expect(page.locator('#text-process-btn')).toBeVisible();

  await page.locator('.cue[data-idx="0"] .text').click({ button: 'right' });
  await page.locator('#ctxmenu').getByText('替换选中字幕…', { exact: true }).click();
  const find = page.getByRole('textbox', { name: '查找' });
  await expect(find).toBeFocused();
  await expect(page.locator('#text-preset-select')).toBeEnabled();
  await expect(page.locator('#text-preset-select')).toHaveValue('');
  await expect(page.locator('#text-process-scope-info')).toHaveText('当前范围：仅选中的 2 条字幕');
  await find.fill('(猫)-(狗|鸟)');
  await page.getByRole('checkbox', { name: '正则' }).check();
  await page.getByRole('textbox', { name: '替换为' }).fill('$02/$01');
  const preview = page.locator('#text-process-preview');
  await expect(preview.locator('details')).toHaveCount(2);
  await expect(preview).toContainText('鸟/猫');
  await page.locator('#text-process-cancel').focus();
  await page.keyboard.press('Delete');
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(3);
  await page.locator('#text-process-confirm').click();
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(({ text }) => text)))
    .toEqual(['狗/猫\n鸟/猫', '狗/猫', '猫-鸟']);
});

test('text processing converts clear Chinese numbers with surrounding spaces', async ({ page }) => {
  await seed(page, { text: '一百八十六，等三两分钟，八九不离十', timed: false });
  await page.locator('#text-process-btn').click();
  await removeTextProcessPrefill(page);
  await addTextProcessStep(page, 'convertChineseNumbers');
  await expect(page.locator('#text-process-preview')).toContainText('处理后： 186 ，等三两分钟，八九不离十');
  await page.locator('#text-process-confirm').click();
  await expect(page.locator('.cue[data-idx="0"] .text')).toHaveText(' 186 ，等三两分钟，八九不离十');
});

test('portable file uses the same fade rules and SRT export settings', async ({ page }) => {
  await page.goto(`file://${portable}`);
  await expect(page.locator('#cues-container')).toBeVisible();
  await seed(page, { text: '>甲乙<', timed: false });
  await page.evaluate(() => MaweSettings.updateEditorSettings({ assSpecialSymbolRule: 'both' }));
  expect(await page.evaluate(() => MaweExportSrt.buildSrt())).toContain('\n甲乙\n');
});

for (const gesture of ['Shift+B', 'Control+Shift+B', 'Meta+Shift+B']) {
  test(`${gesture} dispatches the requested split from the cue list`, async ({ page }) => {
    await seed(page);
    const text = page.locator('.cue[data-idx="0"] .text');
    await page.evaluate(() => MaweSelection.selectOnly(0));
    const point = await text.evaluate(el => {
      const range = document.createRange();
      range.setStart(el.firstChild, 2);
      range.setEnd(el.firstChild, 2);
      const rect = range.getBoundingClientRect();
      return { x: rect.left, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.keyboard.press(gesture);
    expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.text)))
      .toEqual(gesture === 'Shift+B' ? ['甲乙', '甲乙丙丁'] : ['甲乙丙丁', '甲乙丙丁']);
  });
}


test('custom wrapping leaves a user-selected input focused after delayed autofocus', async ({ page }) => {
  await seed(page);
  await page.evaluate(async () => {
    MaweTextProcess.openWrapCharsModal([0]);
    document.getElementById('wrap-chars-right').focus();
    await new Promise(resolve => setTimeout(resolve, 100));
  });
  await expect(page.locator('#wrap-chars-right')).toBeFocused();
});

test('expanded wrapping menu stays inside a short viewport and keeps custom wrapping reachable', async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.locator('.cue[data-idx="0"] .text').click({ button: 'right' });
  // 「左右添加字符」已提为顶层菜单行，无需先展开「高级操作」。
  await page.locator('#ctxmenu').getByText('左右添加字符', { exact: true }).click();
  const bounds = await page.locator('#ctxmenu').boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(496);
  await page.locator('#ctxmenu').getByText('自定义…', { exact: true }).click();
  await expect(page.locator('#wrap-chars-modal')).toHaveClass(/show/);
  await page.locator('#wrap-chars-left').fill('【');
  await page.locator('#wrap-chars-right').fill('】');
  await expect(page.locator('#wrap-chars-left')).toHaveValue('【');
  await expect(page.locator('#wrap-chars-right')).toHaveValue('】');
  const fields = await page.locator('.wrap-chars-field').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()));
  expect(fields[0].top).toBeCloseTo(fields[1].top, 0);
  expect(fields[1].left - fields[0].right).toBeGreaterThanOrEqual(8);
  await page.locator('#wrap-chars-right').press('Enter');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('【甲乙丙丁】');
});

async function openTextProcess(page) {
  await page.locator('#text-process-btn').click();
}

test('ordered text processing previews the final output and keeps empty cues and their timing', async ({ page }) => {
  await seed(page, { text: '  猫-狗  ', timed: false });
  await openTextProcess(page);
  await removeTextProcessPrefill(page);
  await addTextProcessStep(page, 'trim');
  let step = await addTextProcessStep(page, 'replace');
  await step.getByRole('textbox', { name: '查找' }).fill('^(?<cat>猫)-(狗)$');
  await step.getByRole('textbox', { name: '替换为' }).fill('$02/$<cat>');
  await step.getByRole('checkbox', { name: '正则' }).check();
  const preview = page.locator('#text-process-preview');
  await expect(preview.locator('.replace-preview-after')).toHaveText('处理后：狗/猫');
  step = await addTextProcessStep(page, 'replace');
  await step.getByRole('textbox', { name: '查找' }).fill('狗/猫');
  await expect(preview.locator('.replace-preview-after')).toHaveText('处理后：');
  await step.getByRole('button', { name: '上移' }).click();
  await expect(preview.locator('.replace-preview-after')).toHaveText('处理后：狗/猫');
  await page.locator('#text-preset-rules > li').nth(1).getByRole('button', { name: '下移' }).click();
  await expect(preview.locator('.replace-preview-after')).toHaveText('处理后：');
  await page.locator('#text-process-confirm').click();
  const cues = () => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(({ id, start, end, text }) => [id, start, end, text]));
  expect(await cues()).toEqual([['main-1', 1000, 5000, '']]);
  await page.locator('#undo-btn').click();
  expect(await cues()).toEqual([['main-1', 1000, 5000, '  猫-狗  ']]);
});

test('invalid and runaway regular expressions block apply and can be replaced', async ({ page }) => {
  await seed(page, { text: 'a'.repeat(64) + '!', timed: false });
  await openTextProcess(page);
  await removeTextProcessPrefill(page);
  const step = await addTextProcessStep(page, 'replace');
  const find = step.getByRole('textbox', { name: '查找' });
  await step.getByRole('checkbox', { name: '正则' }).check();
  await find.fill('(');
  const preview = page.locator('#text-process-preview');
  const apply = page.locator('#text-process-confirm');
  await expect(preview).toContainText('正则表达式无效');
  await expect(apply).toBeDisabled();
  await find.fill('^(?=(a+)+$).*$');
  await expect(preview).toContainText('规则运行超时', { timeout: 6000 });
  await expect(apply).toBeDisabled();
  await find.fill('a+');
  await expect(preview.locator('.replace-preview-after')).toHaveText('处理后：!');
  await expect(apply).toBeEnabled();
  await step.getByRole('checkbox', { name: '正则' }).uncheck();
  await find.fill('a');
  await step.locator('input[type="text"]').nth(1).fill('b'.repeat(5000));
  await expect(preview).toContainText('替换结果过长');
  await expect(apply).toBeDisabled();
});

test('user presets, text overrides and explicit join defaults survive project changes', async ({ page }, testInfo) => {
  await seed(page, { text: '  甲  ', timed: false });
  await page.evaluate(() => MaweSettings.updateEditorSettings({ autoMergeGapMs: 350 }));
  await openTextProcess(page);
  await removeTextProcessPrefill(page);
  await addTextProcessStep(page, 'trim');
  page.once('dialog', (dialog) => dialog.accept('清理空白'));
  await page.locator('#text-preset-save-as').click();
  await page.locator('#text-preset-default').click();
  await expect(page.locator('#text-preset-select')).toContainText('清理空白 ★');
  await addTextProcessStep(page, 'capitalize');
  await page.locator('#text-process-project-menu summary').click();
  await page.locator('#text-process-project-save').click();
  await expect(page.locator('#text-process-project-status')).toHaveText('已保存当前工程默认处理');
  const editor = page.locator('#text-process-modal .modal');
  const gap = await editor.locator('#text-preset-rules > li').evaluateAll(([first, second]) =>
    second.getBoundingClientRect().top - first.getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThanOrEqual(8);
  await editor.screenshot({ path: testInfo.outputPath('processing-zh.png') });
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(page.locator('#text-preset-add-rule')).toHaveText('Add step');
  await editor.screenshot({ path: testInfo.outputPath('processing-en.png') });
  await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
  await page.locator('#text-process-cancel').click();

  await page.locator('#auto-merge-manage').click();
  const threshold = page.locator('#auto-merge-gap-ms');
  await expect(threshold).toHaveValue('350');
  await threshold.fill('450');
  await page.locator('#auto-merge-project-save').click();
  const projects = await page.evaluate(() => {
    const project = JSON.parse(MaweJsonRepair.buildJson());
    const other = structuredClone(project);
    delete other.processing_overrides;
    return { project, other };
  });
  expect(projects.project.processing_overrides).toMatchObject({
    text: [{ type: 'trim' }, { type: 'capitalize' }], join: { gapMs: 450 },
  });
  const join = page.locator('#auto-merge-panel');
  const controlGap = await page.locator('#auto-merge-project-save').evaluate((button) => {
    const group = button.parentElement;
    return group.getBoundingClientRect().top - group.previousElementSibling.getBoundingClientRect().bottom;
  });
  expect(controlGap).toBeGreaterThanOrEqual(8);
  await join.screenshot({ path: testInfo.outputPath('join-zh.png') });
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  for (const id of ['auto-merge-snap-direction', 'auto-merge-absorb-direction']) {
    const labelGap = await page.locator('#' + id).evaluate((select) => {
      const label = select.previousElementSibling;
      const text = document.createRange();
      text.selectNodeContents(label);
      return select.getBoundingClientRect().left - text.getBoundingClientRect().right;
    });
    expect(labelGap).toBeGreaterThanOrEqual(8);
  }
  await join.screenshot({ path: testInfo.outputPath('join-en.png') });
  await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
  await page.evaluate((other) => MaweProjectLoad.applyCanonicalProject(other, 'other.mosp'), projects.other);
  await page.locator('#auto-merge-manage').click();
  await expect(threshold).toHaveValue('350');
  await threshold.fill('600');
  await page.locator('#auto-merge-user-save').click();
  await expect(page.locator('#auto-merge-settings-status')).toContainText('用户配置已保存');
  await page.locator('#auto-merge-close').click();
  await openTextProcess(page);
  await expect(page.locator('#text-preset-rules > li')).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#text-preset-delete').click();
  await expect(page.locator('#text-preset-select')).toHaveValue('');
  await page.locator('#text-process-cancel').click();
  await page.evaluate((project) => MaweProjectLoad.applyCanonicalProject(project, 'original.mosp'), projects.project);
  await openTextProcess(page);
  await expect(page.locator('#text-preset-rules > li')).toHaveCount(2);
  await page.locator('#text-process-project-menu summary').click();
  await page.locator('#text-process-project-empty').click();
  await expect(page.locator('#text-preset-rules > li')).toHaveCount(0);
  await page.locator('#text-process-project-menu summary').click();
  await page.locator('#text-process-project-reset').click();
  await expect(page.locator('#text-process-project-status')).toHaveText('工程内继承默认预设');
  await page.locator('#text-process-cancel').click();
  await page.locator('#auto-merge-manage').click();
  await expect(threshold).toHaveValue('450');
  await page.locator('#auto-merge-project-reset').click();
  await expect(threshold).toHaveValue('600');
});

test('portable editor saves and reloads presets in its browser storage', async ({ page }) => {
  const errors = [];
  const snapshots = {};
  page.on('pageerror', error => errors.push(String(error.stack || error)));
  await page.addInitScript(() => {
    try { window.__portablePresetAtDocumentStart = localStorage.getItem('moy.asr.text_processing_presets.v1'); }
    catch (error) { window.__portablePresetAtDocumentStart = `ERROR: ${String(error)}`; }
  });
  const snapshot = async () => {
    const state = await page.evaluate(() => {
      let storage;
      try { storage = localStorage.getItem('moy.asr.text_processing_presets.v1'); }
      catch (error) { storage = `ERROR: ${String(error)}`; }
      return { href: location.href, origin: location.origin, storage, documentStartStorage: window.__portablePresetAtDocumentStart,
        library: window.MaweProcessing?.library ?? null,
        projectOverride: window.MaweProcessing?.projectOverride('text') ?? null,
        selected: document.querySelector('#text-preset-select')?.value ?? null,
        status: document.querySelector('#text-preset-status')?.dataset.state ?? null };
    });
    let cdp;
    try {
      cdp = await page.context().newCDPSession(page);
      const { frameTree } = await cdp.send('Page.getFrameTree');
      const frameId = frameTree.frame.id;
      const { storageKey } = await cdp.send('Storage.getStorageKeyForFrame', { frameId });
      state.cdp = { frameId, storageKey };
    } catch (error) {
      state.cdp = { error: String(error) };
    } finally {
      if (cdp) await cdp.detach().catch(() => {});
    }
    return state;
  };
  try {
    await page.goto('file://' + portable);
    await seed(page, { text: '  甲  ', timed: false });
    await openTextProcess(page);
    await removeTextProcessPrefill(page);
    await expect(page.locator('#text-preset-status')).toHaveText('仅保存在当前浏览器（便携模式）');
    await expect(page.locator('#text-preset-status')).toHaveAttribute('data-state', 'local');
    await addTextProcessStep(page, 'trim');
    page.once('dialog', (dialog) => dialog.accept('便携清理'));
    await page.locator('#text-preset-save-as').click();
    await page.locator('#text-preset-default').click();
    const preset = page.locator('#text-preset-select option:checked');
    await expect(preset).toHaveText('便携清理 ★');
    snapshots.beforeReload = await snapshot();
    await page.reload();
    snapshots.afterReload = await snapshot();
    await seed(page, { text: '  甲  ', timed: false });
    await openTextProcess(page);
    await expect(page.locator('#text-preset-status')).toHaveAttribute('data-state', 'local');
    snapshots.afterOpen = await snapshot();
    await expect(preset).toHaveText('便携清理 ★');
    const preview = page.locator('#text-process-preview');
    await expect(preview).toContainText('将处理 1 条字幕，预计修改 1 条');
    await expect(preview.locator('.replace-preview-after')).toHaveText('处理后：甲');
  } catch (error) {
    try { snapshots.onFailure = await snapshot(); } catch (snapshotError) { snapshots.snapshotError = String(snapshotError); }
    throw error;
  } finally {
    console.log('portable preset synthetic diagnostics:', JSON.stringify({ snapshots, errors }));
  }
});

test('join actions wait for the current user defaults', async ({ page }) => {
  const join = { gapMs: 75, snapDirection: 'forward', absorbShort: false, shortCount: 3, absorbDirection: 'previous' };
  await page.evaluate(value => MaweProcessing.setProjectOverride('join', { ...value, gapMs: 400 }), join);
  let releaseRead;
  const pendingRead = new Promise(resolve => { releaseRead = resolve; });
  await page.route('**/api/text-processing-presets', async route => {
    await pendingRead;
    await route.fulfill({ json: {
      schema: 'moy.asr.text_processing_presets.v2', revision: 1, presets: [], defaultPresetId: null, join,
    } });
  });
  const run = page.locator('#auto-merge-run');
  const saveProject = page.locator('#auto-merge-project-save');
  const restore = page.locator('#auto-merge-project-reset');
  try {
    await page.locator('#auto-merge-manage').click();
    await expect(page.locator('#auto-merge-settings-status')).toContainText('正在读取用户配置');
    await expect(run).toBeDisabled({ timeout: 1500 });
    await expect(saveProject).toBeDisabled();
    await expect(restore).toBeDisabled();
  } finally {
    releaseRead();
  }
  await restore.click();
  await expect(page.locator('#auto-merge-gap-ms')).toHaveValue('75');
  await expect(run).toBeEnabled();
  await expect(saveProject).toBeEnabled();
});

test('processing columns scroll independently and group replacement and MASS controls', async ({ page }, info) => {
  await page.evaluate(() => {
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments = Array.from({ length: 26 }, (_, index) => ({
      id: 'layout-' + index, start: index * 2000, end: index * 2000 + 1800, text: '八百标兵',
    }));
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MaweCuePanel.renderAll();
  });
  await openTextProcess(page);
  await removeTextProcessPrefill(page);
  const preview = page.locator('#text-process-preview');
  await expect(preview).toHaveText('在左侧添加处理步骤，即可查看字幕改动。');
  await expect(page.locator('#text-process-preview-title')).toHaveText('处理后字幕预览');
  await expect(page.locator('.text-preset-group .text-process-control-label')).toHaveText('当前工程预设配置');
  const spacing = await page.locator('.text-process-modal').evaluate((element) => {
    const rect = (selector) => element.querySelector(selector).getBoundingClientRect();
    const rows = element.querySelectorAll('.text-preset-group > .text-preset-controls');
    const [first, second] = Array.from(rows, (row) => row.getBoundingClientRect());
    const project = element.querySelector('.text-process-project-controls');
    const label = rect('.text-process-scope-controls label');
    const hint = rect('#text-process-selected-only-hint');
    return {
      rows: second.top - first.bottom,
      editRight: first.right - rect('#text-preset-rename').right,
      fileRight: second.right - rect('#text-preset-file-menu').right,
      project: project.getBoundingClientRect().top - second.bottom,
      divider: getComputedStyle(project).borderTopWidth,
      scopeGap: hint.left - label.right,
      scopeCenter: (hint.top + hint.bottom - label.top - label.bottom) / 2,
    };
  });
  expect(spacing).toMatchObject({ rows: 8, editRight: 0, fileRight: 0, project: 8, divider: '1px' });
  expect(spacing.scopeGap).toBeGreaterThanOrEqual(8);
  expect(Math.abs(spacing.scopeCenter)).toBeLessThan(1);
  const controls = await page.evaluate(() => {
    const style = (selector) => {
      const node = document.querySelector(selector);
      const { fontSize, borderRadius, padding, minHeight, backgroundColor } = getComputedStyle(node);
      return { fontSize, borderRadius, padding, minHeight, backgroundColor };
    };
    const caret = (selector) => getComputedStyle(document.querySelector(selector), '::after').content;
    return {
      toolbar: style('#auto-merge-manage'),
      preset: style('#text-preset-save-as'),
      fileMenu: style('#text-preset-file-menu > summary'),
      projectMenu: style('#text-process-project-menu > summary'),
      fileCaret: caret('#text-preset-file-menu > summary'),
      projectCaret: caret('#text-process-project-menu > summary'),
    };
  });
  expect(controls.preset).toEqual(controls.toolbar);
  expect(controls.fileMenu).toEqual(controls.toolbar);
  expect(controls.projectMenu).toEqual(controls.fileMenu);
  expect(controls.projectCaret).toBe(controls.fileCaret);
  const types = page.getByLabel('处理步骤');
  await expect(types.locator('option').last()).toHaveText('去除格式符号');
  const steps = page.locator('#text-preset-rules');
  const stepScroll = page.locator('.text-process-step-scroll');
  await addTextProcessStep(page, 'replace');
  const replace = steps.locator('li').first();
  await expect(replace.getByRole('textbox', { name: '查找', exact: true })).toHaveAttribute('placeholder', '查找文本');
  await expect(replace.getByRole('textbox', { name: '替换为' })).toHaveAttribute('placeholder', '替换为（留空即删除）');
  await expect(replace.getByRole('group', { name: '选项' }).getByRole('checkbox')).toHaveCount(2);
  const fields = await replace.evaluate((step) => {
    const [find, replace] = step.querySelectorAll('input[type="text"]');
    const options = step.querySelector('.processing-replace-options').getBoundingClientRect();
    return { sameLine: find.offsetTop === replace.offsetTop, gap: options.top - replace.getBoundingClientRect().bottom };
  });
  expect(fields.sameLine).toBe(true);
  expect(fields.gap).toBeGreaterThanOrEqual(8);
  await replace.getByRole('textbox', { name: '查找', exact: true }).fill('八');
  await replace.getByRole('textbox', { name: '替换为' }).fill('8');
  await addTextProcessStep(page, 'wrap');
  const wrap = steps.locator('li').nth(1);
  await wrap.getByRole('group', { name: '普通字符' }).getByRole('button', { name: '中括号' }).click();
  await wrap.getByRole('group', { name: 'MASS 特殊样式' }).getByRole('button', { name: '强调' }).click();
  await wrap.getByRole('group', { name: 'MASS 整句动画' }).getByRole('button', { name: '淡出淡入' }).click();
  for (let i = 0; i < 12; i++) await addTextProcessStep(page, 'trim');
  await expect(preview.locator('details')).toHaveCount(26);
  await expect(preview.locator('.replace-preview-summary > span')).toHaveText('将处理 26 条字幕，预计修改 26 条');
  const modal = page.locator('.text-process-modal');
  const measure = () => modal.evaluate((element) => {
    const left = element.querySelector('.text-process-step-scroll');
    const right = element.querySelector('#text-process-preview');
    return {
      width: element.clientWidth, height: element.clientHeight, modalScroll: element.scrollHeight - element.clientHeight,
      left: left.scrollTop, right: right.scrollTop,
      leftOverflow: left.scrollHeight - left.clientHeight, rightOverflow: right.scrollHeight - right.clientHeight,
    };
  });
  await stepScroll.evaluate(node => { node.scrollTop = 0; });
  const initial = await measure();
  expect(initial.width).toBeGreaterThan(1000);
  expect(initial.leftOverflow).toBeGreaterThan(0);
  expect(initial.rightOverflow).toBeGreaterThan(0);
  expect(initial.modalScroll).toBe(0);
  for (const scroller of [stepScroll, preview]) {
    await expect(scroller).toHaveCSS('scrollbar-width', 'thin');
    await expect(scroller).toHaveCSS('scrollbar-color', / rgba\(0, 0, 0, 0\)$/);
  }
  await stepScroll.evaluate(node => { node.scrollTop = 100; });
  expect(await measure()).toMatchObject({ left: 100, right: 0, height: initial.height });
  await preview.evaluate(node => { node.scrollTop = 100; });
  expect(await measure()).toMatchObject({ left: 100, right: 100, height: initial.height });
  await stepScroll.evaluate(node => { node.scrollTop = 0; });
  await preview.evaluate(node => { node.scrollTop = 0; });
  await modal.screenshot({ path: info.outputPath('text-process-layout-zh.png') });
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(wrap.getByRole('group', { name: 'MASS sentence animations' })).toBeVisible();
  await expect(page.locator('#text-process-preview-title')).toHaveText('Processed subtitle preview');
  await expect(preview.locator('.replace-preview-summary > span')).toHaveText('Processing 26 subtitles, 26 will change');
  await modal.screenshot({ path: info.outputPath('text-process-layout-en.png') });
  for (const viewport of [{ width: 800, height: 360 }, { width: 390, height: 600 }]) {
    await page.setViewportSize(viewport);
    const layout = await modal.evaluate((element) => ({
      outerOverflow: getComputedStyle(element).overflowY,
      stepsHeight: element.querySelector('.text-process-step-scroll').clientHeight,
      previewHeight: element.querySelector('#text-process-preview').clientHeight,
      horizontalOverflow: element.scrollWidth - element.clientWidth,
    }));
    expect(layout.outerOverflow).toBe('auto');
    expect(layout.stepsHeight).toBeGreaterThan(100);
    expect(layout.previewHeight).toBeGreaterThan(80);
    expect(layout.horizontalOverflow).toBe(0);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    MAWE_I18N.applyLanguage('zh');
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    const checkbox = document.getElementById('ass-mode-toggle');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
  });
  await expect(wrap.getByRole('group')).toHaveCount(1);
  await expect(wrap.getByText('如需使用特殊文本样式（MASS），请先启用 ASS 字幕样式。')).toHaveCount(1);
  await expect(wrap.getByRole('button', { name: '强调' })).toHaveCount(0);
  await expect(preview).toContainText('请先开启 ASS 模式');
  await expect(page.locator('#text-process-confirm')).toBeDisabled();
});

test('empty custom steps prefill one replace step without fighting the user', async ({ page }) => {
  await seed(page);
  await openTextProcess(page);
  // 打开弹窗：空步骤预填一步「替换文本」，并显示常驻 hint。
  await expect(page.locator('#text-preset-rules > li')).toHaveCount(1);
  await expect(page.locator('#text-preset-rules > li').first()).toContainText('替换文本');
  const hint = page.locator('.text-process-steps-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toHaveCSS('font-size', '13px');
  const { color, amber, gap } = await hint.evaluate(node => {
    const sample = document.createElement('span');
    sample.style.color = 'var(--amber-hover)';
    node.append(sample);
    const styles = {
      color: getComputedStyle(node).color, amber: getComputedStyle(sample).color,
      gap: node.getBoundingClientRect().top - node.previousElementSibling.getBoundingClientRect().bottom,
    };
    sample.remove();
    return styles;
  });
  expect(color).toBe(amber);
  expect(gap).toBeGreaterThanOrEqual(8);
  expect(gap).toBeLessThan(24);
  // 删除预填步骤后不强制回填。
  await removeTextProcessPrefill(page);
  await expect(page.locator('#text-preset-rules > li')).toHaveCount(0);
  await page.locator('#text-process-cancel').click();
  // 显式「工程内默认留空」保持空步骤，不再预填。
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  await page.locator('#text-process-project-menu summary').click();
  await page.locator('#text-process-project-empty').click();
  await expect(page.locator('#text-process-project-status')).toHaveText('工程内默认留空');
  await expect(page.locator('#text-preset-rules > li')).toHaveCount(0);
  await page.locator('#text-process-cancel').click();
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  await expect(page.locator('#text-preset-rules > li')).toHaveCount(0);
  await page.locator('#text-process-cancel').click();
  // 工程覆盖存在时继承覆盖步骤；切到「自定义步骤」时才预填。
  await page.evaluate(() => MaweProcessing.setProjectOverride('text', [{ type: 'trim' }]));
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  await expect(page.locator('#text-preset-rules > li')).toHaveCount(1);
  await expect(page.locator('#text-preset-rules > li').first()).toContainText('修剪前后空白');
  await page.locator('#text-preset-select').selectOption('');
  await expect(page.locator('#text-preset-rules > li')).toHaveCount(1);
  await expect(page.locator('#text-preset-rules > li').first()).toContainText('替换文本');
});

test('adding a step replaces the untouched starter and preserves an edited replacement', async ({ page }) => {
  await seed(page, { text: '  甲乙  ', timed: false });
  await openTextProcess(page);
  const rows = page.locator('#text-preset-rules > li');
  const preview = page.locator('#text-process-preview');
  await expect(rows).toHaveCount(1);
  await expect(preview).toContainText('在左侧添加处理步骤');
  await expect(page.locator('#text-preset-save-as')).toBeDisabled();
  await addTextProcessStep(page, 'trim');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('修剪前后空白');
  await expect(preview.locator('.text-process-result-snippet')).toHaveText('甲乙');

  await page.locator('#text-process-cancel').click();
  await openTextProcess(page);
  await rows.first().getByRole('textbox', { name: '查找', exact: true }).fill('甲');
  await addTextProcessStep(page, 'trim');
  await expect(rows).toHaveCount(2);
  await expect(preview.locator('.text-process-result-snippet')).toHaveText('乙');
});

test('arrow keys inside the text process modal never move cues or seek media', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => MaweSelection.selectOnly(0));
  await page.evaluate(() => MaweTextProcess.openTextProcessModal({ replaceSelection: [0] }));
  await expect(page.locator('#text-preset-select')).toBeEnabled();
  const snapshot = () => page.evaluate(() => {
    const segment = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0];
    return { start: segment.start, end: segment.end, currentTime: MaweCoreState.player.currentTime };
  });
  await page.getByRole('textbox', { name: '查找', exact: true }).fill('甲');
  const preview = page.locator('#text-process-preview');
  await expect(preview).toContainText('预计修改 1 条');
  const summary = preview.locator('.replace-preview-row summary');
  await summary.click();
  await expect(summary).toBeFocused();
  const before = await snapshot();
  for (const key of ['ArrowLeft', 'ArrowRight', 'Control+ArrowLeft']) {
    await page.keyboard.press(key);
    expect(await snapshot()).toEqual(before);
  }
  // 关闭弹窗、焦点离开按钮后，方向键恢复原有的微调/seek 行为。
  await page.keyboard.press('Escape');
  await expect(page.locator('#text-process-modal')).not.toHaveClass(/show/);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].start))
    .not.toBe(before.start);
});
