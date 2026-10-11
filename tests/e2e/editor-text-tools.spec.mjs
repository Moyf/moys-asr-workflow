import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { buildPortableBlankEditor, cleanupTempDir, disableOnboarding, findFreePort, generateProjectJson,
  generateWav, makeTempDir, openSettingsPage, startServer } from './helpers.mjs';

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
  portable = buildPortableBlankEditor(join(dir, 'portable.html'));
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
    MaweBoot.DATA.segments = [{ id: 'main-1', start: 1000, end: 5000, text,
      items: timed ? Array.from(text, (text, i) => ({ text, start: 1000 + i * 1000, end: 2000 + i * 1000 })) : null }];
    MaweBoot.DATA.multi_subtitle = { schema: 'moy.asr.multi_subtitle.v1', enabled: linked, display_mode: 'both',
      tracks: linked ? [{ id: 'ext-1', role: 'extension', name: '译文', split_mode: 'character',
        segments: [{ id: 'ext-cue', start: 1000, end: 5000, text: '一二三四' }] }] : [],
      bindings: linked ? [{ id: 'binding-1', track_id: 'ext-1', main_segment_ids: ['main-1'],
        extension_segment_ids: ['ext-cue'] }] : [] };
    MaweSettings.updateEditorSettings({ autoSaveProject: false });
    MaweSelection.clearSelection({ silent: true });
    MaweCuePanel.renderAll({ waveform: 'full' });
  }, { text, timed, linked });
}

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
      const result = await page.evaluate(() => MaweBoot.DATA.segments);
      expect(result.map(s => s.text)).toEqual(mode === 'progressive' ? ['甲乙', '甲乙丙丁'] : ['甲乙丙丁', '甲乙丙丁']);
      expect(result.map(s => [s.start, s.end])).toEqual([[1000, 3000], [3000, 5000]]);
      expect(result[1].items).toBeNull();
      if (mode === 'duplicate') expect(result[0].items).toBeNull();
      else if (path === 'timed') expect(result[0].items.map(i => i.text)).toEqual(['甲', '乙']);
      await page.locator('#undo-btn').click();
      expect(await page.evaluate(() => MaweBoot.DATA.segments.map(s => s.text))).toEqual(['甲乙丙丁']);
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
      const segment = MaweBoot.DATA.segments[0];
      segment.speaker = 'opaque-speaker';
      segment.items?.forEach(item => { item.speaker = segment.speaker; });
      MaweSplitContext.splitFromContextMenu(0, 10, 10, 3000, { splitTextMode: 'progressive' });
    });
    if (path !== 'timed') await page.locator('#multi-subtitle-split-confirm').click();
    expect(await page.evaluate(() => MaweBoot.DATA.segments.map(s => s.speaker)))
      .toEqual(['opaque-speaker', 'opaque-speaker']);
    const saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
    expect(saved.segments.map(s => s.speaker)).toEqual(['opaque-speaker', 'opaque-speaker']);
    expect(saved.segments.map(s => s.text)).toEqual(['甲乙', '甲乙丙丁']);
    await page.locator('#undo-btn').click();
    expect(await page.evaluate(() => MaweBoot.DATA.segments.map(s => s.speaker))).toEqual(['opaque-speaker']);
    await page.locator('#redo-btn').click();
    expect(await page.evaluate(() => MaweBoot.DATA.segments.map(s => s.speaker)))
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
    await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments.map(s => s.speaker)))
      .toEqual(['opaque-speaker', 'opaque-speaker']);
  });
}

test('custom wrapping isolates Delete and B while a button has focus', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => { MaweSelection.selectOnly(0); MaweTextProcess.openWrapCharsModal([0]); });
  await expect(page.locator('#wrap-chars-modal')).toHaveClass(/show/);
  await expect(page.locator('#wrap-chars-left')).toBeFocused();
  await page.locator('#wrap-chars-confirm').focus();
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => MaweBoot.DATA.segments.length)).toBe(1);
  await page.keyboard.press('Shift+B');
  expect(await page.evaluate(() => MaweBoot.DATA.segments.length)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#wrap-chars-modal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => [...MaweSelection.selectedIdxs])).toEqual([0]);
});

test('batch wrap presets skip existing wrappers and keep preview and undo consistent', async ({ page }) => {
  await seed(page, { text: '**甲乙**', timed: false });
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-mode-toggle').check();
  await page.locator('#project-settings-close').click();
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  await page.locator('#text-process-wrap-presets button').filter({ hasText: '强调文本' }).click();
  expect(await page.evaluate(() => MaweTextProcess.buildTextProcessPreview(MaweTextProcess.textProcessTargets(),
    MaweTextProcess.getTextProcessOptions())[0].after)).toBe('**甲乙**');
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
    expect(await page.evaluate(() => MaweBoot.DATA.segments.map(s => s.text)))
      .toEqual(gesture === 'Shift+B' ? ['甲乙', '甲乙丙丁'] : ['甲乙丙丁', '甲乙丙丁']);
  });
}


test('expanded wrapping menu stays inside a short viewport and keeps custom wrapping reachable', async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.evaluate(() => MaweContextMenus.showContextMenu(350, 350, 0));
  await page.locator('.word-timing-advanced > .item').hover();
  await page.getByText('左右添加字符', { exact: true }).click();
  const bounds = await page.locator('#ctxmenu').boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(496);
  await page.locator('#ctxmenu').getByText('自定义…', { exact: true }).click();
  await expect(page.locator('#wrap-chars-modal')).toHaveClass(/show/);
  await page.locator('#wrap-chars-left').fill('【');
  await page.locator('#wrap-chars-right').fill('】');
  const fields = await page.locator('.wrap-chars-field').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()));
  expect(fields[0].top).toBeCloseTo(fields[1].top, 0);
  expect(fields[1].left - fields[0].right).toBeGreaterThanOrEqual(8);
  await page.locator('#wrap-chars-right').press('Enter');
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('【甲乙丙丁】');
});
