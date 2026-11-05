import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPortableBlankEditor, cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer, addTextProcessStep } from './helpers.mjs';

let server, dir;
test.beforeAll(async () => { dir = makeTempDir('warma'); server = await startBlankServer(await findFreePort(), dir); });
test.afterAll(async () => { await server?.stop(); cleanupTempDir(dir); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    MaweBoot.DATA.segments = [{ id: 'one', start: 0, end: 2000, text: '嗯 123', items: null }];
    MaweCuePanel.renderAll();
  });
});

test('preset rules preview, persist, reload and undo', async ({ page }, info) => {
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  await expect(page.locator('#text-preset-status')).toHaveText('');
  const removal = page.locator('.processing-fillers');
  await removal.getByText('批量添加文字删除步骤', { exact: true }).click();
  const hint = removal.locator('#text-preset-fillers-hint');
  await expect(hint).toContainText('替换为空');
  const removalGaps = await removal.evaluate(element => {
    const bounds = [...element.children].map(child => child.getBoundingClientRect());
    return bounds.slice(1).map((box, index) => box.top - bounds[index].bottom);
  });
  expect(Math.min(...removalGaps)).toBeGreaterThanOrEqual(8);
  await removal.screenshot({ path: info.outputPath('bulk-delete-zh.png') });
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(hint).toContainText('replaces matching text with nothing');
  await removal.screenshot({ path: info.outputPath('bulk-delete-en.png') });
  await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
  await page.getByRole('textbox', { name: '要删除的文字（每行一项）' }).fill('嗯');
  await page.locator('#text-preset-add-fillers').click();
  await addTextProcessStep(page, 'trim');
  await expect(page.locator('#text-process-preview')).toContainText('处理后：123');
  page.once('dialog', dialog => dialog.accept('游戏清理'));
  await page.locator('#text-preset-save-as').click();
  await expect(page.locator('#text-preset-status')).toHaveText('预设库已保存');
  await page.locator('#text-process-modal .modal').screenshot({ path: info.outputPath('text-presets.png') });
  const gap = await page.evaluate(() => {
    const a = document.querySelector('#text-preset-controls') || document.querySelector('.text-preset-controls');
    const b = document.querySelector('#text-process-scope-info');
    return b.getBoundingClientRect().top - a.getBoundingClientRect().bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(8);
  await page.locator('#text-process-confirm').click();
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('123');
  await page.evaluate(() => MaweHistory.performUndo());
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('嗯 123');
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  await expect(page.locator('#text-preset-select option')).toHaveCount(2);
  await page.locator('#text-preset-select').selectOption({ label: '游戏清理' });
  await expect(page.locator('#text-process-preview')).toContainText('处理后：123');
});

test('single cue style is independent and undoable', async ({ page }, info) => {
  await page.evaluate(() => MaweCuePanel.setCuePanelTarget('main', 0));
  await page.locator('#current-cue-panel').screenshot({ path: info.outputPath('cue-style.png') });
  await page.locator('#cue-ass-style').selectOption('ass');
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments[0].assStyle?.id)).toBe('ass');
  const output = await page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    return MaweExportSrt.buildAss();
  });
  expect(output).toContain('Style: Cue_0,');
  const saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(saved.segments[0].assStyle.id).toBe('ass');
  await page.evaluate(() => MaweHistory.performUndo());
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments[0].assStyle)).toBeUndefined();
});

test('styles on all three tracks survive a project roundtrip', async ({ page }) => {
  await page.evaluate(() => {
    MaweBoot.DATA.multi_subtitle = { schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both', main_split_mode: 'word',
      tracks: [{ id: 'ext', role: 'extension', name: '副字幕', split_mode: 'word', segments: [{ id: 'ext-1', start: 0, end: 2000, text: 'Secondary' }] }], bindings: [] };
    MaweBoot.DATA.overlay_track = { enabled: true, segments: [{ id: 'overlay-1', start: 0, end: 2000, text: 'Overlay' }] };
    MaweCuePanel.renderAll();
  });
  for (const [kind, track] of [['main', null], ['extension', 'ext'], ['overlay', null]]) {
    await page.evaluate(([kind, track]) => MaweCuePanel.setCuePanelTarget(kind, 0, track), [kind, track]);
    await page.locator('#cue-ass-style').selectOption('ass');
  }
  const result = await page.evaluate(async () => {
    const serialized = JSON.parse(MaweJsonRepair.buildJson());
    const opened = await MaweMultiImport.openProjectFile(new File([JSON.stringify(serialized)], 'snapshot.mosp', { type: 'application/json' }), { suppressMediaPrompt: true });
    return { opened, styles: [MaweBoot.DATA.segments[0].assStyle, MaweBoot.DATA.multi_subtitle.tracks[0].segments[0].assStyle, MaweBoot.DATA.overlay_track.segments[0].assStyle] };
  });
  expect(result.opened).toBe(true);
  expect(result.styles.map(style => style?.id)).toEqual(['ass', 'ass', 'ass']);
});

test('ordered rules preview and apply literal replacement text', async ({ page }) => {
  await page.evaluate(() => {
    MaweBoot.DATA.segments[0].text = 'AbA';
    MaweCuePanel.renderAll(); MaweTextProcess.openTextProcessModal();
  });
  for (const [find, replace] of [['a', 'x'], ['x', '$1'], ['b', 'wrong']]) {
    await page.locator('#text-preset-add-rule').click();
    const row = page.locator('.text-preset-rule').last();
    await row.locator('input[type="text"]').nth(0).fill(find);
    await row.locator('input[type="text"]').nth(1).fill(replace);
  }
  await page.locator('.text-preset-rule').last().getByLabel('启用').uncheck();
  await expect(page.locator('#text-process-preview')).toContainText('处理后：$1b$1');
  await page.locator('#text-process-confirm').click();
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('$1b$1');
});

test('preset endpoint rejects missing tokens and stale writes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = MaweBoot.SERVER_CONFIG.textProcessingPresetsUrl;
    const initial = await (await fetch(url)).json();
    const post = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const forbidden = await post({ ...initial, expected: initial });
    const changed = { ...initial, presets: [...initial.presets, { id: 'concurrent', name: 'Concurrent', scope: 'all', rules: [], operations: {} }] };
    const token = MaweBoot.SERVER_CONFIG.requestToken;
    const success = await post({ ...changed, expected: initial, requestToken: token });
    const stale = await post({ ...initial, expected: initial, requestToken: token });
    return { forbidden: forbidden.status, success: success.status, stale: stale.status, after: await (await fetch(url)).json() };
  });
  expect(result.forbidden).toBe(403);
  expect(result.success).toBe(200);
  expect(result.stale).toBe(409);
  expect(result.after.presets.some(preset => preset.id === 'concurrent')).toBe(true);
});

test('invalid imported operations are rejected and ASS wrappers require ASS mode', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = MaweBoot.SERVER_CONFIG.textProcessingPresetsUrl;
    const before = await (await fetch(url)).json();
    const post = (payload) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, expected: before, requestToken: MaweBoot.SERVER_CONFIG.requestToken }) });
    const base = { id: 'wrapped', name: 'ASS wrapper', scope: 'all', rules: [], operations: { wraps: [null] } };
    const invalid = await post({ ...before, presets: [...before.presets, base] });
    const unchanged = await (await fetch(url)).json();
    const valid = await post({ ...before, presets: [...before.presets, { ...base, operations: { wraps: [{ id: 'emphasis', left: '**', right: '**' }] } }] });
    return { invalid: invalid.status, unchanged, before, valid: valid.status };
  });
  expect(result.invalid).toBe(400);
  expect(result.unchanged).toEqual(result.before);
  expect(result.valid).toBe(200);
  await page.evaluate(() => { MaweSettings.EDITOR_SETTINGS.assMode = false; MaweTextProcess.openTextProcessModal(); });
  await expect(page.locator('#text-preset-select option').filter({ hasText: 'ASS wrapper' })).toHaveCount(1);
  await page.locator('#text-preset-select').selectOption({ label: 'ASS wrapper' });
  await expect(page.locator('#text-process-preview')).toContainText('请先开启 ASS 模式');
  await expect(page.locator('#text-process-confirm')).toBeDisabled();
});

test('deleting a complete cue keeps the project row and exports re-importable SRT', async ({ page }) => {
  await page.evaluate(() => {
    MaweBoot.DATA.segments = [
      { id: 'empty-after', start: 1000, end: 2000, text: '嗯', items: null },
      { id: 'next', start: 2500, end: 3500, text: '保留', items: null },
    ];
    MaweCuePanel.renderAll(); MaweTextProcess.openTextProcessModal();
  });
  await page.locator('.processing-fillers summary').click();
  await page.locator('#text-preset-fillers').fill('嗯');
  await page.locator('#text-preset-add-fillers').click();
  await expect(page.locator('#text-process-preview')).toContainText('预计修改 1 条');
  await page.locator('#text-process-confirm').click();
  const output = await page.evaluate(() => {
    const text = MaweExportSrt.buildSrt({ alignFirstStart: true });
    return { source: MaweBoot.DATA.segments.map(segment => segment.text), parsed: MaweProjectLoad.parseSrtSegments(text) };
  });
  expect(output.source).toEqual(['', '保留']);
  expect(output.parsed.map(segment => segment.text)).toEqual(['保留']);
  expect(output.parsed[0].start).toBe(0);
});

test('portable pages reject a stale preset library save', async ({ browser }) => {
  const portable = buildPortableBlankEditor(join(dir, 'portable.html'));
  const context = await browser.newContext({ locale: 'zh-CN' });
  try {
    const first = await context.newPage();
    const second = await context.newPage();
    for (const tab of [first, second]) {
      await disableOnboarding(tab);
      await tab.goto(pathToFileURL(portable).href);
      await tab.evaluate(() => {
        MaweBoot.DATA.segments = [{ id: 'one', start: 0, end: 1000, text: 'test' }];
        MaweCuePanel.renderAll(); MaweTextProcess.openTextProcessModal();
      });
      await expect(tab.locator('#text-preset-status')).toHaveText('');
      await addTextProcessStep(tab, 'trim');
    }
    first.once('dialog', dialog => dialog.accept('First'));
    await first.locator('#text-preset-save-as').click();
    await expect(first.locator('#text-preset-status')).toHaveText('预设库已保存');
    second.once('dialog', dialog => dialog.accept('Second'));
    await second.locator('#text-preset-save-as').click();
    await expect(second.locator('#text-preset-status')).toContainText('预设库已被其他页面修改');
  } finally { await context.close(); }
});

test('pending save cannot relabel a reopened custom form as the saved preset', async ({ page }) => {
  await page.evaluate(async () => {
    const url = MaweBoot.SERVER_CONFIG.textProcessingPresetsUrl;
    const library = await (await fetch(url)).json();
    const preset = { id: 'race', name: 'Race', scope: 'all', rules: [], operations: { trim: true } };
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...library, presets: [...library.presets, preset], expected: library, requestToken: MaweBoot.SERVER_CONFIG.requestToken }) });
    MaweTextProcess.openTextProcessModal();
  });
  await expect(page.locator('#text-preset-select option').filter({ hasText: 'Race' })).toHaveCount(1);
  await page.locator('#text-preset-select').selectOption('race');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/text-processing-presets', async route => {
    if (route.request().method() === 'POST') await gate;
    await route.continue();
  });
  await page.locator('#text-preset-save').click();
  await expect(page.locator('#text-preset-select')).toBeDisabled();
  await page.locator('#text-process-cancel').click();
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  await expect(page.locator('#text-preset-select')).toBeDisabled();
  release();
  await expect(page.locator('#text-preset-status')).toHaveText('预设库已保存');
  await expect(page.locator('#text-preset-select')).toHaveValue('');
  await expect(page.locator('#text-preset-rules > li')).toHaveCount(0);
});

test('a selected-only user default never falls back to the full main track', async ({ page }) => {
  await page.evaluate(() => {
    MaweBoot.DATA.segments.push({ id: 'two', start: 2000, end: 4000, text: '  another cue  ' });
    MaweCuePanel.renderAll();
    MaweSelection.selectOnly(1);
    MaweTextProcess.openTextProcessModal();
  });
  const selectedOnly = page.locator('#text-process-selected-only');
  const presetSelect = page.locator('#text-preset-select');
  const apply = page.locator('#text-process-confirm');
  await expect(selectedOnly).toBeChecked();
  await addTextProcessStep(page, 'trim');
  page.once('dialog', dialog => dialog.accept('Only selected cues'));
  await page.locator('#text-preset-save-as').click();
  await page.locator('#text-preset-default').click();
  await expect(presetSelect.locator('option:checked')).toHaveText('Only selected cues ★');
  await page.locator('#text-process-cancel').click();
  await page.evaluate(() => {
    MaweSelection.clearSelection({ silent: true });
    MaweTextProcess.openTextProcessModal();
  });
  await expect(presetSelect).toBeEnabled();
  await expect(presetSelect.locator('option:checked')).toHaveText('Only selected cues ★');
  await expect(selectedOnly).toBeChecked();
  await expect(page.locator('#text-process-preview')).toContainText('需要先选中至少1条字幕');
  await expect(apply).toBeDisabled();
  await page.locator('#text-process-cancel').click();

  await page.evaluate(() => { MaweSelection.selectOnly(1); MaweTextProcess.openTextProcessModal(); });
  await expect(page.locator('#text-process-scope-info')).toHaveText('当前范围：仅选中的 1 条字幕');
  await apply.click();
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments.map(({ text }) => text))).toEqual(['嗯 123', 'another cue']);
});

test('restoring inheritance waits for the latest user preset scope', async ({ page }) => {
  let scope = 'all';
  let pendingRead = Promise.resolve();
  await page.route('**/api/text-processing-presets', async route => {
    await pendingRead;
    await route.fulfill({ json: {
      schema: 'moy.asr.text_processing_presets.v2', revision: 1, defaultPresetId: 'cached',
      presets: [{ id: 'cached', name: 'User cleanup', scope, steps: [{ type: 'trim' }] }],
    } });
  });
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  await expect(page.locator('#text-preset-select option:checked')).toHaveText('User cleanup ★');
  await page.locator('#text-process-cancel').click();
  await page.evaluate(() => MaweProcessing.setProjectOverride('text', [{ type: 'capitalize' }]));

  let releaseRead;
  pendingRead = new Promise(resolve => { releaseRead = resolve; });
  scope = 'selected';
  const restore = page.locator('#text-process-project-reset');
  try {
    await page.evaluate(() => { MaweTextProcess.openTextProcessModal(); });
    await expect(page.locator('#text-preset-status')).toHaveText('正在读取用户配置…');
    await expect(restore).toBeDisabled({ timeout: 1500 });
  } finally {
    releaseRead();
  }
  await restore.click();
  await expect(page.locator('#text-process-selected-only')).toBeChecked();
  await expect(page.locator('#text-process-preview')).toContainText('需要先选中至少1条字幕');
  await expect(page.locator('#text-process-confirm')).toBeDisabled();
});
