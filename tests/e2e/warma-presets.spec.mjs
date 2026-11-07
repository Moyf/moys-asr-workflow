import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildBrowserEditorFixture, cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer, addTextProcessStep, removeTextProcessPrefill } from './helpers.mjs';

let server, dir;
test.beforeAll(async () => { dir = makeTempDir('warma'); server = await startBlankServer(await findFreePort(), dir); });
test.afterAll(async () => { await server?.stop(); cleanupTempDir(dir); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments = [{ id: 'one', start: 0, end: 2000, text: '嗯 123' }];
    MaweCuePanel.renderAll();
  });
});

test('preset rules preview, persist, reload and undo', async ({ page }, info) => {
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  const status = page.locator('#text-preset-status');
  await expect(status).toHaveText('已与用户级配置同步');
  await expect(status).toHaveAttribute('data-state', 'success');
  // 打开弹窗时空步骤已预填一步「替换文本」，直接填它的查找内容。
  await page.getByRole('textbox', { name: '查找' }).fill('嗯');
  await addTextProcessStep(page, 'trim');
  await expect(page.locator('#text-process-preview')).toContainText('处理后：123');
  page.once('dialog', dialog => dialog.accept('游戏清理'));
  await page.locator('#text-preset-save-as').click();
  await expect(page.locator('#text-preset-select option:checked')).toHaveText('游戏清理');
  await expect(status).toHaveText('已与用户级配置同步');
  await expect(page.locator('#ass-style-library-status')).toHaveAttribute('data-state', 'success');
  const header = await status.evaluate((node) => {
    const title = document.querySelector('#text-process-title').getBoundingClientRect();
    const right = node.parentElement.getBoundingClientRect().right;
    const description = document.querySelector('#text-process-description').getBoundingClientRect();
    const statusRect = node.getBoundingClientRect();
    const assStatus = document.querySelector('#ass-style-library-status');
    const style = getComputedStyle(node);
    const assStyle = getComputedStyle(assStatus);
    return {
      titleGap: statusRect.left - title.right,
      rightGap: right - statusRect.right,
      descriptionGap: description.top - node.parentElement.getBoundingClientRect().bottom,
      sameStyle: style.color === assStyle.color && style.fontSize === assStyle.fontSize,
    };
  });
  expect(header).toMatchObject({ rightGap: 0, descriptionGap: 12, sameStyle: true });
  expect(header.titleGap).toBeGreaterThanOrEqual(8);
  await page.locator('#text-process-modal .modal').screenshot({ path: info.outputPath('text-presets.png') });
  await page.locator('#text-process-confirm').click();
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('123');
  await page.evaluate(() => MaweHistory.performUndo());
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('嗯 123');
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  await expect(page.locator('#text-preset-select option')).toHaveCount(2);
  await page.locator('#text-preset-select').selectOption({ label: '游戏清理' });
  await expect(page.locator('#text-process-preview')).toContainText('处理后：123');
});

test('single cue style is independent and undoable', async ({ page }, info) => {
  await page.evaluate(() => MaweCuePanel.setCuePanelTarget('main', 0));
  const heading = page.locator('.cue-panel-text-header');
  const measure = () => heading.evaluate((node) => {
    const title = node.querySelector('#cue-panel-target').getBoundingClientRect();
    const style = node.querySelector('#cue-ass-style-controls').getBoundingClientRect();
    return {
      gap: style.left - title.right,
      right: node.getBoundingClientRect().right - style.right,
      center: (style.top + style.bottom - title.top - title.bottom) / 2,
      textGap: document.querySelector('#cue-panel-text').getBoundingClientRect().top - node.getBoundingClientRect().bottom,
    };
  });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await measure();
    expect(layout.gap).toBeGreaterThanOrEqual(8);
    expect(layout.right).toBe(0);
    expect(Math.abs(layout.center)).toBeLessThan(1);
    expect(layout.textGap).toBeGreaterThanOrEqual(8);
    if (width === 1280) await page.locator('#current-cue-panel').screenshot({ path: info.outputPath('cue-style.png') });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const select = page.locator('#cue-ass-style');
  await select.selectOption('default');
  await expect(select).toHaveValue('default');
  await expect(select.locator('option', { hasText: /^SRT 渲染样式$/ })).toHaveCount(1);
  await expect(select.locator('option[value="__snapshot"]')).toHaveCount(0);
  await select.selectOption('');
  await select.selectOption('ass');
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].assStyle?.id)).toBe('ass');
  const output = await page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    return MaweExportSrt.buildAss();
  });
  expect(output).toContain('Style: Cue_0,');
  const saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(saved.tracks.find(track => track.role === 'main').segments[0].assStyle.id).toBe('ass');
  await page.evaluate(() => MaweHistory.performUndo());
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].assStyle)).toBeUndefined();
});

test('styles on all three tracks survive a project roundtrip', async ({ page }) => {
  await page.evaluate(() => {
    MaweBoot.DATA.tracks.push(
      { id: 'ext', role: 'secondary', name: '副字幕', enabled: true, segments: [{ id: 'ext-1', start: 0, end: 2000, text: 'Secondary' }] },
      { id: 'overlay', role: 'overlay', name: '叠加字幕', enabled: true, segments: [{ id: 'overlay-1', start: 0, end: 2000, text: 'Overlay' }] },
    );
    MaweBoot.DATA.bilingual.active_track_id = 'ext';
    MaweCuePanel.renderAll();
  });
  for (const [kind, track] of [['main', null], ['extension', 'ext'], ['overlay', null]]) {
    await page.evaluate(([kind, track]) => MaweCuePanel.setCuePanelTarget(kind, 0, track), [kind, track]);
    await page.locator('#cue-ass-style').selectOption('ass');
  }
  const result = await page.evaluate(async () => {
    const serialized = JSON.parse(MaweJsonRepair.buildJson());
    const opened = await MaweMultiImport.openProjectFile(new File([JSON.stringify(serialized)], 'snapshot.mosp', { type: 'application/json' }), { suppressMediaPrompt: true });
    return { opened, styles: [AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].assStyle, AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments[0].assStyle, AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).segments[0].assStyle] };
  });
  expect(result.opened).toBe(true);
  expect(result.styles.map(style => style?.id)).toEqual(['ass', 'ass', 'ass']);
});

test('ordered rules preview and apply literal replacement text', async ({ page }) => {
  await page.evaluate(() => {
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text = 'AbA';
    MaweCuePanel.renderAll(); MaweTextProcess.openTextProcessModal();
  });
  await removeTextProcessPrefill(page);
  for (const [find, replace] of [['a', 'x'], ['x', '$1'], ['b', 'wrong']]) {
    await page.locator('#text-preset-add-rule').click();
    const row = page.locator('.text-preset-rule').last();
    await row.locator('input[type="text"]').nth(0).fill(find);
    await row.locator('input[type="text"]').nth(1).fill(replace);
  }
  await page.locator('.text-preset-rule').last().getByLabel('启用').uncheck();
  await expect(page.locator('#text-process-preview')).toContainText('处理后：$1b$1');
  await page.locator('#text-process-confirm').click();
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('$1b$1');
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
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments = [
      { id: 'empty-after', start: 1000, end: 2000, text: '嗯' },
      { id: 'next', start: 2500, end: 3500, text: '保留' },
    ];
    MaweCuePanel.renderAll(); MaweTextProcess.openTextProcessModal();
  });
  await page.getByRole('textbox', { name: '查找' }).fill('嗯');
  await expect(page.locator('#text-process-preview')).toContainText('预计修改 1 条');
  await page.locator('#text-process-confirm').click();
  const output = await page.evaluate(() => {
    const text = MaweExportSrt.buildSrt({ alignFirstStart: true });
    return { source: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(segment => segment.text), parsed: MaweProjectLoad.parseSrtSegments(text) };
  });
  expect(output.source).toEqual(['', '保留']);
  expect(output.parsed.map(segment => segment.text)).toEqual(['保留']);
  expect(output.parsed[0].start).toBe(0);
});

test.skip('portable pages reject a stale preset library save (unsupported in 2.0)', async ({ browser }) => {
  const portable = buildBrowserEditorFixture(join(dir, 'portable.html'));
  const context = await browser.newContext({ locale: 'zh-CN' });
  try {
    const first = await context.newPage();
    const second = await context.newPage();
    for (const tab of [first, second]) {
      await disableOnboarding(tab);
      await tab.goto(pathToFileURL(portable).href);
      await tab.evaluate(() => {
        AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments = [{ id: 'one', start: 0, end: 1000, text: 'test' }];
        MaweCuePanel.renderAll(); MaweTextProcess.openTextProcessModal();
      });
      await expect(tab.locator('#text-preset-status')).toHaveText('仅保存在当前浏览器（便携模式）');
      await addTextProcessStep(tab, 'trim');
    }
    first.once('dialog', dialog => dialog.accept('First'));
    await first.locator('#text-preset-save-as').click();
    await expect(first.locator('#text-preset-select option:checked')).toHaveText('First');
    await expect(first.locator('#text-preset-status')).toHaveAttribute('data-state', 'local');
    second.once('dialog', dialog => dialog.accept('Second'));
    await second.locator('#text-preset-save-as').click();
    await expect(second.locator('#text-preset-status')).toContainText('预设库已被其他页面修改');
    await expect(second.locator('#text-preset-status')).toHaveAttribute('data-state', 'warning');
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
  await expect(page.locator('#text-preset-status')).toHaveAttribute('data-state', 'pending');
  release();
  await expect(page.locator('#text-preset-status')).toHaveText('已与用户级配置同步');
  await expect(page.locator('#text-preset-status')).toHaveAttribute('data-state', 'success');
  await expect(page.locator('#text-preset-select')).toHaveValue('');
  // 空的自定义步骤会预填一步「替换文本」，不再是空列表。
  await expect(page.locator('#text-preset-rules > li')).toHaveCount(1);
  await expect(page.locator('#text-preset-rules > li').first()).toContainText('替换文本');
});

test('a selected-only user default never falls back to the full main track', async ({ page }) => {
  await page.evaluate(() => {
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.push({ id: 'two', start: 2000, end: 4000, text: '  another cue  ' });
    MaweCuePanel.renderAll();
    MaweSelection.selectOnly(1);
    MaweTextProcess.openTextProcessModal();
  });
  const selectedOnly = page.locator('#text-process-selected-only');
  const presetSelect = page.locator('#text-preset-select');
  const apply = page.locator('#text-process-confirm');
  await expect(selectedOnly).toBeChecked();
  await removeTextProcessPrefill(page);
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
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(({ text }) => text))).toEqual(['嗯 123', 'another cue']);
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
    await expect(page.locator('#text-preset-status')).toHaveText('正在加载…');
    await expect(page.locator('#text-preset-status')).toHaveAttribute('data-state', 'pending');
    await expect(restore).toBeDisabled({ timeout: 1500 });
  } finally {
    releaseRead();
  }
  await page.locator('#text-process-project-menu summary').click();
  await restore.click();
  await expect(page.locator('#text-process-selected-only')).toBeChecked();
  await expect(page.locator('#text-process-preview')).toContainText('需要先选中至少1条字幕');
  await expect(page.locator('#text-process-confirm')).toBeDisabled();
});

test('import previews ordered steps and replaces presets only after confirmation', async ({ page }) => {
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  const select = page.locator('#text-preset-select');
  await expect(select).toBeEnabled();
  const before = await select.locator('option').allTextContents();
  const source = {
    schema: 'moy.asr.text_processing_presets.v2', defaultPresetId: 'imported',
    presets: [{ id: 'imported', name: '带有两步的预设', scope: 'all', steps: [
      { type: 'replace', find: '八', replacement: '8', regex: false, caseSensitive: false },
      { type: 'trim' },
    ] }],
  };
  const choose = async () => {
    await page.locator('#text-preset-file-menu summary').click();
    const fileChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '导入处理预设' }).click();
    await (await fileChooser).setFiles({
      name: 'presets.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)),
    });
  };
  await choose();
  const dialog = page.getByRole('dialog', { name: '导入处理预设' });
  await expect(dialog.getByText('带有两步的预设 ★')).toBeVisible();
  await expect(dialog.getByText('全部字幕', { exact: true })).toBeVisible();
  await expect(dialog.locator('ol > li')).toHaveText(['替换文本　"八" → "8"', '修剪前后空白']);
  await expect(select.locator('option')).toHaveText(before);
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(select.locator('option')).toHaveText(before);
  await choose();
  let releaseWrite;
  const pendingWrite = new Promise(resolve => { releaseWrite = resolve; });
  await page.route('**/api/text-processing-presets', async route => {
    if (route.request().method() === 'POST') await pendingWrite;
    await route.continue();
  }, { times: 1 });
  try {
    await dialog.getByRole('button', { name: '确认替换预设库' }).click();
    await expect(dialog.getByRole('button', { name: '取消' })).toBeDisabled();
    await expect(dialog.getByText('正在保存预设库…')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  } finally {
    releaseWrite();
  }
  await expect(dialog).not.toBeVisible();
  await expect(select.locator('option')).toHaveText(['自定义步骤', '带有两步的预设 ★']);
  await select.selectOption('imported');
  const toggle = page.locator('#text-preset-default');
  await expect(toggle).toHaveText('取消默认');
  await toggle.click();
  await expect(select.locator('option:checked')).toHaveText('带有两步的预设');
  await expect(toggle).toHaveText('设为默认');
  await toggle.click();
  await expect(select.locator('option:checked')).toHaveText('带有两步的预设 ★');
  // 导出整库：走「另存为」选择器（stub），文件名与内容为完整预设库。
  await page.evaluate(() => {
    window.__exportedFile = null;
    window.showSaveFilePicker = async ({ suggestedName }) => ({
      name: suggestedName,
      createWritable: async () => ({
        write: async (data) => { window.__exportedFile = { name: suggestedName, text: await data.text() }; },
        close: async () => {},
      }),
    });
  });
  await page.locator('#text-preset-file-menu summary').click();
  await page.getByRole('button', { name: '导出整个预设库' }).click();
  await expect.poll(() => page.evaluate(() => window.__exportedFile?.name)).toBe('处理预设库.json');
  const exported = JSON.parse(await page.evaluate(() => window.__exportedFile.text));
  expect(exported.presets.map((preset) => preset.name)).toEqual(['带有两步的预设']);
  expect(exported.defaultPresetId).toBe('imported');
  // 导出当前预设：文件名为「预设名.json」，内容是该预设对象本身。
  await page.locator('#text-preset-file-menu summary').click();
  await page.getByRole('button', { name: '导出当前预设' }).click();
  await expect.poll(() => page.evaluate(() => window.__exportedFile?.name)).toBe('带有两步的预设.json');
  const exportedPreset = JSON.parse(await page.evaluate(() => window.__exportedFile.text));
  expect(exportedPreset.name).toBe('带有两步的预设');
  expect(exportedPreset.steps.map((step) => step.type)).toEqual(['replace', 'trim']);
  // 环境不支持保存选择器时回退为普通下载。
  await page.evaluate(() => { window.showSaveFilePicker = undefined; });
  await page.locator('#text-preset-file-menu summary').click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出当前预设' }).click();
  expect((await download).suggestedFilename()).toBe('带有两步的预设.json');
});

test('importing a single preset keeps the current form and default intact', async ({ page }) => {
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  const select = page.locator('#text-preset-select');
  await expect(select).toBeEnabled();
  await select.selectOption('');
  const current = page.locator('#text-preset-export-current');
  await expect(current).toBeDisabled();
  const find = page.getByRole('textbox', { name: '查找', exact: true });
  const replacement = page.getByRole('textbox', { name: '替换为' });
  await find.fill('嗯');
  await replacement.fill('原步骤');
  page.once('dialog', dialog => dialog.accept('当前草稿'));
  await page.locator('#text-preset-save-as').click();
  await expect(select.locator('option:checked')).toHaveText('当前草稿');
  await expect(current).toBeEnabled();
  await replacement.fill('尚未保存');
  const initialDefault = await page.evaluate(() => MaweProcessing.library.defaultPresetId);

  const chooseFile = async (payload) => {
    await page.locator('#text-preset-file-menu summary').click();
    const fileChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '导入处理预设' }).click();
    await (await fileChooser).setFiles({
      name: 'single.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)),
    });
  };
  await chooseFile({ name: '修剪', scope: 'selected', steps: [{ type: 'trim' }] });
  const dialog = page.getByRole('dialog', { name: '导入单条处理预设' });
  await expect(dialog.getByText('确认后会作为新预设加入当前预设库，不会改动现有预设和默认设置。')).toBeVisible();
  await expect(dialog.locator('strong')).toHaveText('修剪');
  await expect(dialog.locator('ol > li')).toHaveText(['修剪前后空白']);
  await dialog.getByRole('button', { name: '加入预设库' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(select.locator('option:checked')).toHaveText('当前草稿');
  await expect(replacement).toHaveValue('尚未保存');
  await expect(page.locator('#text-process-selected-only')).not.toBeChecked();
  await select.selectOption({ label: '修剪' });
  await expect(page.locator('#text-preset-rules > li')).toHaveText(/修剪前后空白/);
  await expect(page.locator('#text-process-selected-only')).toBeChecked();

  await chooseFile({ name: '修剪', steps: [{ type: 'stripMarkdown' }] });
  await dialog.getByRole('button', { name: '加入预设库' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(select.locator('option:checked')).toHaveText('修剪');
  const library = await page.evaluate(async () => (await fetch(MaweBoot.SERVER_CONFIG.textProcessingPresetsUrl)).json());
  expect(library.presets.find(preset => preset.name === '修剪')).toMatchObject({ scope: 'selected', steps: [{ type: 'trim' }] });
  expect(library.presets.find(preset => preset.name === '修剪 (2)')).toMatchObject({ scope: 'all', steps: [{ type: 'stripMarkdown' }] });
  expect(library.defaultPresetId).toBe(initialDefault);
});


test('editing project defaults preserves extensions after saving and reopening', async ({ page }) => {
  await page.evaluate(() => {
    MaweBoot.DATA.processing_overrides = {
      text: [{ type: 'trim', enabled: true, vendor: { keep: 1 } }],
      join: { gapMs: 300, shortCount: 3, snapDirection: 'backward', absorbDirection: 'previous', absorbShort: true, vendor: { keep: 2 } },
      vendor: { keep: 3 },
    };
    MaweTextProcess.openTextProcessModal();
  });
  await page.locator('#text-process-project-menu summary').click();
  await page.locator('#text-process-project-save').click();
  await page.locator('#text-process-cancel').click();
  await page.locator('#auto-merge-manage').click();
  await page.locator('#auto-merge-gap-ms').fill('400');
  await page.locator('#auto-merge-project-save').click();
  const result = await page.evaluate(async () => {
    const saved = JSON.parse(MaweJsonRepair.buildJson());
    const opened = await MaweMultiImport.openProjectFile(new File([JSON.stringify(saved)], 'snapshot.mosp', { type: 'application/json' }), { suppressMediaPrompt: true });
    return { opened, overrides: MaweBoot.DATA.processing_overrides };
  });
  expect(result.opened).toBe(true);
  expect(result.overrides.text[0].vendor).toEqual({ keep: 1 });
  expect(result.overrides.join).toMatchObject({ gapMs: 400, vendor: { keep: 2 } });
  expect(result.overrides.vendor).toEqual({ keep: 3 });
});
