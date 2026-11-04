import { expect, test } from '@playwright/test';
import { writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, dragFloatingPanelAwayFrom, findFreePort, generateWav, generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';

let tempDir, server;
test('waveform ASS shortcuts mirror project settings and open the style library and actual frame', async ({ page }, testInfo) => {
  const toggle = page.locator('#ass-mode-quick-toggle');
  const palette = page.locator('#ass-style-quick-open');
  const camera = page.locator('#ass-frame-quick-open');
  await expect(toggle).toHaveText('ASS 字幕模式');
  await expect(palette).toBeHidden();
  await expect(camera).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#ass-mode-toggle')).toBeChecked();
  await expect(palette).toBeVisible();
  await expect(camera).toBeVisible();
  await expect(camera).toHaveText('📷');
  const gaps = await page.locator('#waveform-settings').evaluate(el => {
    const buttons = [...el.querySelectorAll(':scope > button')].map(button => button.getBoundingClientRect());
    return buttons.slice(1).map((button, index) => button.left - buttons[index].right);
  });
  expect(gaps.every(gap => gap >= 8)).toBe(true);
  await page.locator('#waveform-settings').screenshot({ path: testInfo.outputPath('ass-toolbar-camera.png') });
  await camera.click();
  await expect(page.locator('#ass-frame-window')).toHaveAttribute('aria-hidden', 'false');
  await expect(camera).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#ass-frame-window')).toHaveAttribute('aria-hidden', 'true');
  await expect(camera).not.toBeFocused();
  await expect(camera).toHaveAttribute('aria-expanded', 'false');
  await palette.click();
  await expect(page.locator('#ass-style-window')).toHaveAttribute('aria-hidden', 'false');
  await page.locator('#waveform-pane').screenshot({ path: testInfo.outputPath('ass-shortcuts.png') });
  await page.keyboard.press('Escape');
  await toggle.click();
  await expect(palette).toBeHidden();
  await expect(camera).toBeHidden();
  expect(await page.locator('#editor-settings-tab-subtitle-style').evaluate(el =>
    Boolean(el.compareDocumentPosition(document.getElementById('editor-settings-tab-project-tracks')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(page.locator('#word-timing-quick-toggle')).toHaveText('字词');
  await expect(page.locator('#markers-quick-toggle')).toHaveText('标记');
  await page.evaluate(() => MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-multi-subtitle'));
  const rows = await page.locator('.multi-subtitle-display-inline .multi-subtitle-setting-row').evaluateAll(elements =>
    elements.map(el => el.getBoundingClientRect().top));
  expect(Math.abs(rows[0] - rows[1])).toBeLessThanOrEqual(1);
});
test.beforeAll(async () => {
  // macOS 的 tmpdir 位于 /var（指向 /private/var 的符号链接）；服务器按
  // realpath 回显表情包目录，断言用的路径必须预先解析成同一形式。
  tempDir = realpathSync(makeTempDir('settings-structure'));
  const media = join(tempDir, 'synthetic.wav'), project = join(tempDir, 'settings.mosp');
  generateWav(media, 4);
  for (const folder of ['default-a', 'default-b', 'override']) {
    mkdirSync(join(tempDir, folder));
    writeFileSync(join(tempDir, folder, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwZkAAAAASUVORK5CYII=', 'base64'));
  }
  writeFileSync(project, JSON.stringify({ media, waveform: generateWaveformPayload(4000), segments: [
    { id: 'main-1', start: 500, end: 3000, text: '测试设置', items: [{ start: 500, end: 1500, text: '测试' }, { start: 1500, end: 3000, text: '设置' }] },
  ] }), 'utf8');
  server = await startServer(project, media, await findFreePort());
});
for (const tool of ['select', 'razor']) {
  test(`camera Escape preserves selected cues and the ${tool} tool`, async ({ page }, testInfo) => {
    await page.locator('#ass-mode-quick-toggle').click();
    await page.locator('.cue[data-idx="0"]').click();
    const selection = await page.evaluate(() => [...MaweSelection.selectedIdxs]);
    expect(selection).toEqual([0]);
    await page.evaluate(tool => MaweCoreState.waveformEditor.setTool(tool), tool);
    const camera = page.locator('#ass-frame-quick-open');
    await camera.click();
    await expect(page.locator('#ass-frame-window')).toHaveAttribute('aria-hidden', 'false');
    const snapshot = () => page.evaluate(() => ({
      selection: [...MaweSelection.selectedIdxs], tool: MaweCoreState.waveformEditor.tool,
      frameOpen: document.getElementById('ass-frame-window').classList.contains('show'),
      activeTag: document.activeElement?.tagName, activeId: document.activeElement?.id,
    }));
    const before = await snapshot();
    await page.keyboard.press('Escape');
    const after = await snapshot();
    writeFileSync(testInfo.outputPath('camera-selected-escape.json'), JSON.stringify({ before, after }, null, 2));
    await page.screenshot({ path: testInfo.outputPath('camera-selected-escape.png') });
    await expect(page.locator('#ass-frame-window')).toHaveAttribute('aria-hidden', 'true');
    await expect(camera).not.toBeFocused();
    await expect(camera).toHaveAttribute('aria-expanded', 'false');
    expect(after.selection).toEqual(selection);
    expect(after.tool).toBe(tool);
    // This panel's Esc listener is registered before the selection guards.
    // Its consumed event must not fall through and clear selection or razor.
    await page.locator('#auto-merge-manage').click();
    await expect(page.locator('#auto-merge-panel')).toHaveClass(/show/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#auto-merge-panel')).not.toHaveClass(/show/);
    expect(await page.evaluate(() => [...MaweSelection.selectedIdxs])).toEqual(selection);
    expect(await page.evaluate(() => MaweCoreState.waveformEditor.tool)).toBe(tool);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => [...MaweSelection.selectedIdxs])).toEqual([]);
    expect(await page.evaluate(() => MaweCoreState.waveformEditor.tool)).toBe('select');
  });
}
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => {
    if (!localStorage.getItem('moy.asr.editor.settings.v1')) localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false }));
  });
  await page.goto(server.url);
  await expect(page.locator('.waveform-row').first()).toBeVisible();
});
async function settings(page, tab = 'regions') {
  if (!await page.locator('#editor-settings-panel').isVisible()) await page.locator('#editor-settings-toggle').click();
  await page.locator(`#editor-settings-tab-${tab}`).click();
}

test('word timing help stays concise and translates when switching language', async ({ page }, testInfo) => {
  await page.locator('#help-toggle').click();
  await page.locator('#help-tab-waveform').click();
  const paragraphs = page.locator('#help-tab-panel-waveform .help-subgroup').first().locator('.help-category > span');
  await expect(paragraphs).toHaveCount(3);
  await expect(paragraphs.first()).toContainText('Q 快速切换开关');
  await expect(paragraphs.nth(1)).toContainText('F 试听选中的字幕或字词');
  await expect(paragraphs.last()).toContainText('右键菜单的「高级操作」');
  await page.locator('#help-panel').screenshot({ path: testInfo.outputPath('word-timing-help-zh.png') });
  await page.locator('#help-close').click();
  await settings(page, 'interface');
  await page.locator('#language-toggle').click();
  await page.locator('#help-toggle').click();
  await page.locator('#help-tab-waveform').click();
  await expect(paragraphs.first()).toContainText('Q toggles this mode');
  await expect(paragraphs.nth(1)).toContainText('F auditions the selected subtitles or words');
  await expect(paragraphs.last()).toContainText('Advanced actions in the context menu');
  expect((await paragraphs.allTextContents()).join('')).not.toMatch(/[\u4e00-\u9fff]/);
  await page.locator('#help-panel').screenshot({ path: testInfo.outputPath('word-timing-help-en.png') });
});

test('settings search lists cross-window destinations and navigates only after selection', async ({ page }, testInfo) => {
  await settings(page);
  const search = page.locator('#editor-settings-search');
  await search.fill('主字幕语言');
  const result = page.locator('#editor-settings-search-results button');
  await expect(result).toHaveCount(1);
  await expect(result.locator('span')).toHaveText('主字幕语言');
  await expect(result.locator('small')).toHaveText('工程设置 / 时间与语言');
  await expect(page.locator('#editor-settings-tab-regions')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#project-settings-panel')).toBeHidden();
  await expect(search).toBeFocused();
  await expect(page.locator('.settings-search-hit')).toHaveCount(0);
  await page.locator('#editor-settings-panel').screenshot({ path: testInfo.outputPath('settings-search-results.png') });
  await result.click();
  await expect(page.locator('#editor-settings-tab-timebase')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#multi-subtitle-main-language-mode')).toBeFocused();
  await expect(page.locator('#editor-settings-panel')).toBeVisible();
  await page.locator('#project-settings-panel').screenshot({ path: testInfo.outputPath('settings-search-project-destination.png') });
});

test('settings search handles no matches, native clearing and Escape without changing the page', async ({ page }) => {
  await settings(page, 'general');
  const search = page.locator('#editor-settings-search');
  await search.fill('主字幕语言');
  await page.keyboard.press('End');
  await page.keyboard.type('不存在的设置');
  await expect(search).toHaveValue('主字幕语言不存在的设置');
  await expect(page.locator('#editor-settings-search-results button')).toHaveCount(0);
  await expect(page.locator('#editor-settings-search-results')).toHaveText('未找到匹配的设置');
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(page.locator('#editor-settings-search-results')).toBeHidden();
  await expect(page.locator('#editor-settings-tab-general')).toBeVisible();
  await expect(page.locator('#editor-settings-tab-general')).toHaveAttribute('aria-selected', 'true');
  await search.fill('拆分');
  await search.fill('');
  await expect(page.locator('#editor-settings-search-results')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#editor-settings-panel')).toBeHidden();
});

test('settings search shows page and item matches with no nested duplicates', async ({ page }, testInfo) => {
  await settings(page, 'interface');
  const search = page.locator('#editor-settings-search');
  await search.fill('拆分');
  const results = page.locator('#editor-settings-search-results');
  await expect(results.getByRole('button', { name: '拆分合并', exact: true })).toBeVisible();
  await expect(results.getByRole('button', { name: '字幕（编辑状态下）拆分按键 拆分合并', exact: true })).toBeVisible();
  await expect(results.getByRole('button', { name: '主字幕自动使用时间码拆分 拆分合并', exact: true })).toHaveCount(1);
  await expect(page.locator('.settings-search-hit')).toHaveCount(0);
  await page.locator('#editor-settings-panel').screenshot({ path: testInfo.outputPath('settings-search-split.png') });
  await results.getByRole('button', { name: '主字幕自动使用时间码拆分 拆分合并', exact: true }).click();
  await expect(page.locator('#split-use-word-timestamps')).toBeFocused();
  await expect(page.locator('#editor-settings-page-split-merge')).toBeVisible();
  await search.fill('拆分合并');
  await page.keyboard.press('Enter');
  await expect(page.locator('#editor-settings-page-split-merge')).toBeVisible();
  await expect(page.locator('#split-key')).toBeFocused();
  await search.fill('');
  await expect(page.locator('#editor-settings-tab-split-merge')).toHaveAttribute('aria-selected', 'true');
});

test('project search can navigate to global settings by keyboard without modifying settings', async ({ page }) => {
  const before = await page.evaluate(() => JSON.stringify(MaweBoot.DATA));
  await projectSettings(page, 'timebase');
  const search = page.locator('#project-settings-search');
  await search.fill('主字幕自动使用时间码拆分');
  const result = page.locator('#project-settings-search-results button');
  await expect(result).toHaveCount(1);
  await expect(result).toContainText('全局设置');
  await expect(page.locator('#editor-settings-panel')).toBeHidden();
  await page.keyboard.press('ArrowDown');
  await expect(result).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(search).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#split-use-word-timestamps')).toBeFocused();
  await expect(page.locator('#editor-settings-page-split-merge')).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(MaweBoot.DATA))).toBe(before);
});

test('settings search uses translated labels and fits a narrow window', async ({ page }, testInfo) => {
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await page.setViewportSize({ width: 760, height: 700 });
  await settings(page, 'interface');
  const search = page.locator('#editor-settings-search');
  await search.fill('split');
  const results = page.locator('#editor-settings-search-results');
  await expect(results).not.toContainText('Global settings');
  await expect(results).toContainText('Split & merge');
  const geometry = await results.evaluate(el => {
    const rows = [...el.querySelectorAll('button')];
    return { overflow: el.scrollWidth - el.clientWidth,
      gaps: rows.slice(1).map((row, i) => row.getBoundingClientRect().top - rows[i].getBoundingClientRect().bottom),
      lineGaps: rows.filter(row => row.querySelector('small')).map(row => row.querySelector('small').getBoundingClientRect().top - row.querySelector('span').getBoundingClientRect().bottom) };
  });
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  for (const gap of geometry.gaps) expect(gap).toBeCloseTo(2, 1);
  for (const gap of geometry.lineGaps) expect(gap).toBeCloseTo(0, 1);
  await page.locator('#editor-settings-panel').screenshot({ path: testInfo.outputPath('settings-search-en-narrow.png') });
  await search.fill('main subtitle language');
  await page.keyboard.press('Enter');
  await expect(page.locator('#multi-subtitle-main-language-mode')).toBeFocused();
});

test('settings search finds interface controls outside label wrappers and updates after language changes', async ({ page }) => {
  await settings(page);
  const search = page.locator('#editor-settings-search');
  for (const [query, control] of [['主题', '[data-editor-theme="light"]'], ['显示语言', '#language-toggle'], ['消息提示显示位置', '#editor-toast-position']]) {
    await search.fill(query);
    const result = page.locator('#editor-settings-search-results button').filter({ hasText: query });
    await expect(result).toHaveCount(1);
    await result.click();
    await expect(page.locator(control)).toBeFocused();
  }
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await search.fill('Notification display position');
  await expect(page.locator('#editor-settings-search-results button > span')).toHaveText('Notification display position');
  await expect(page.locator('#editor-settings-search-results button > small')).toHaveText('Interface');
  await expect(page.locator('#editor-settings-search-results')).not.toContainText('全局设置');
});

test('settings search reaches style fields, external label controls and export option buttons', async ({ page }) => {
  await settings(page);
  const search = page.locator('#editor-settings-search');
  for (const [query, tab, control] of [
    ['背景不透明度', 'subtitle-style', '#subtitle-background-alpha'],
    ['默认目录', 'sticker', '#sticker-root-input'],
    ['工程目录', 'project-sticker', '#project-sticker-root-input'],
    ['Lottie 导出参数', 'export-more', '[data-settings-export="download-lottie"]'],
  ]) {
    await page.evaluate(() => {
      MaweSettingsPanels.projectFloatingPanel.close();
      MaweSettingsPanels.setEditorSettingsPanelOpen(true);
    });
    await search.fill(query);
    const result = page.locator('#editor-settings-search-results button[data-settings-search-tab="' + tab + '"]').filter({ hasText: query });
    await expect(result).toHaveCount(1);
    await result.click();
    await expect(page.locator('#editor-settings-page-' + tab)).toBeVisible();
    // Project override input stays disabled until explicitly enabled.
    if (tab === 'project-sticker') await expect(page.locator(control)).toBeDisabled();
    else await expect(page.locator(control)).toBeFocused();
  }
  await page.evaluate(() => MaweSettingsPanels.projectFloatingPanel.close());
  await search.fill('波形鼠标指针');
  const result = page.locator('#editor-settings-search-results button');
  await expect(result).toHaveCount(1);
  await expect(result).toContainText('对齐到帧');
  await result.click();
  await expect(page.locator('#editor-settings-page-special-edit')).toBeVisible();
});

test('settings search refreshes a destination hidden by a changed feature switch', async ({ page }) => {
  await settings(page);
  const search = page.locator('#editor-settings-search');
  await search.fill('预览');
  const results = page.locator('#editor-settings-search-results');
  const background = results.getByRole('button', { name: '背景不透明度 工程设置 / 字幕样式', exact: true });
  await expect(background).toBeVisible();
  await results.getByRole('button', { name: 'ASS 字幕模式 工程设置 / 字幕样式', exact: true }).click();
  await page.locator('#ass-mode-toggle').check();
  await expect(page.locator('#subtitle-background-alpha')).toBeHidden();
  await page.evaluate(() => MaweSettingsPanels.projectFloatingPanel.close());
  await background.click();
  await expect(background).toHaveCount(0);
  await expect(search).toBeFocused();
  await expect(page.locator('#project-settings-panel')).toBeHidden();
});

for (const language of ['zh', 'en']) for (const origin of ['global', 'project']) {
  test(`settings search uses compact unique paths from ${origin} settings in ${language}`, async ({ page }, testInfo) => {
    await page.evaluate(language => MAWE_I18N.applyLanguage(language), language);
    if (origin === 'global') await settings(page);
    else await projectSettings(page, 'timebase');
    const search = page.locator(origin === 'global' ? '#editor-settings-search' : '#project-settings-search');
    const results = page.locator(origin === 'global' ? '#editor-settings-search-results' : '#project-settings-search-results');
    const modeLabel = language === 'zh' ? 'ASS 字幕模式' : 'ASS subtitle mode';
    const exportLabel = language === 'zh' ? 'ASS 导出' : 'ASS export';
    const styleTab = language === 'zh' ? '字幕样式' : 'Subtitle style';
    const exportTab = language === 'zh' ? '字幕导出' : 'Subtitle export';
    const globalScope = language === 'zh' ? '全局设置' : 'Global settings';
    const projectScope = language === 'zh' ? '工程设置' : 'Project settings';
    const byLabel = text => results.locator('button').filter({ has: page.getByText(text, { exact: true }) });
    await search.fill('ASS');
    const mode = byLabel(modeLabel);
    const exported = byLabel(exportLabel);
    await expect(mode).toHaveCount(1);
    await expect(mode.locator('span')).toHaveText(modeLabel);
    await expect(mode.locator('small')).toHaveText(origin === 'project' ? styleTab : projectScope + ' / ' + styleTab);
    await expect(exported).toHaveCount(1);
    await expect(exported.locator('span')).toHaveText(exportLabel);
    await expect(exported.locator('small')).toHaveText(origin === 'global' ? exportTab : globalScope + ' / ' + exportTab);
    const values = await results.locator('button').evaluateAll(buttons => buttons.map(button =>
      [button.querySelector('span').textContent, button.querySelector('small')?.textContent || ''].join('|')));
    expect(new Set(values).size).toBe(values.length);
    await page.locator(origin === 'global' ? '#editor-settings-panel' : '#project-settings-panel')
      .screenshot({ path: testInfo.outputPath(`settings-search-ass-${origin}-${language}.png`) });
    await mode.click();
    await expect(page.locator('#ass-mode-toggle')).toBeFocused();

    // A tab result retains its own title, without repeating it in the hint.
    await search.fill(styleTab);
    const tab = byLabel(styleTab);
    await expect(tab.locator('span')).toHaveText(styleTab);
    if (origin === 'project') await expect(tab.locator('small')).toHaveCount(0);
    else await expect(tab.locator('small')).toHaveText(projectScope);
    await tab.click();
    await expect(page.locator('#editor-settings-tab-subtitle-style')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#export-srt-title')).toHaveText(language === 'zh' ? 'SRT 导出' : 'SRT export');
    await expect(page.locator('#export-ass-title')).toHaveText(exportLabel);
    await expect(page.locator('#export-otio-options')).toHaveText(language === 'zh' ? 'OTIO 导出' : 'OTIO Export');
  });
}

test('Toast position changes immediately, stays in the viewport and persists as a personal preference', async ({ page }, testInfo) => {
  await settings(page, 'interface');
  const select = page.locator('#editor-toast-position');
  await expect(select).toHaveValue('top-center');
  for (const position of ['top-center', 'top-right', 'bottom-right']) {
    await select.selectOption(position);
    await page.evaluate(() => {
      document.getElementById('hint-stack')?.remove();
      MaweHint.flashHint('位置测试一', 'success', { durationMs: 0 });
      MaweHint.flashHint('位置测试二', 'warning', { durationMs: 0 });
      MaweHint.flashHint('位置测试三', 'invalid', { durationMs: 0 });
    });
    const geometry = await page.locator('#hint-stack').evaluate(el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, center: rect.x + rect.width / 2,
        width: innerWidth, height: innerHeight, count: el.children.length };
    });
    expect(geometry.count).toBe(3);
    expect(geometry.x).toBeGreaterThanOrEqual(15);
    expect(geometry.y).toBeGreaterThanOrEqual(15);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width - 15);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.height - 15);
    if (position === 'top-center') expect(geometry.center).toBeCloseTo(geometry.width / 2, 0);
    else expect(geometry.right).toBeCloseTo(geometry.width - 16, 0);
    if (position === 'bottom-right') expect(geometry.bottom).toBeCloseTo(geometry.height - 16, 0);
    else expect(geometry.y).toBeCloseTo(16, 0);
    await page.screenshot({ path: testInfo.outputPath('toast-' + position + '.png') });
    const saved = await page.evaluate(() => ({
      personal: JSON.parse(localStorage.getItem(MaweSettings.EDITOR_SETTINGS_KEY)),
      project: JSON.parse(MaweJsonRepair.buildJson()),
    }));
    expect(saved.personal.toastPosition).toBe(position);
    expect(saved.project.toastPosition).toBeUndefined();
    await page.reload();
    await settings(page, 'interface');
    await expect(select).toHaveValue(position);
    await expect(page.locator('html')).toHaveAttribute('data-toast-position', position);
  }
  await page.setViewportSize({ width: 760, height: 700 });
  await page.evaluate(() => MaweHint.flashHint('窄屏位置测试', 'success', { durationMs: 0 }));
  const rect = await page.locator('#hint-stack').boundingBox();
  expect(rect.x + rect.width).toBeLessThanOrEqual(744.5);
  expect(rect.y + rect.height).toBeLessThanOrEqual(684.5);
});

test('English language type hints are concise and fully localized, and invalid Toast settings fall back', async ({ page }) => {
  await page.evaluate(() => {
    const preferences = JSON.parse(localStorage.getItem(MaweSettings.EDITOR_SETTINGS_KEY));
    localStorage.setItem(MaweSettings.EDITOR_SETTINGS_KEY, JSON.stringify({ ...preferences, toastPosition: 'invalid' }));
  });
  await page.reload();
  await settings(page, 'interface');
  await expect(page.locator('#editor-toast-position')).toHaveValue('top-center');
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(page.locator('#editor-toast-position')).toContainText('Top center');
  await expect(page.locator('#editor-toast-position')).toContainText('Bottom right');
  await settings(page, 'split-merge');
  const hint = page.locator('.merge-join-language-hint');
  await expect(hint).toHaveText('You can configure the subtitle language type in Project settings.');
  await expect(hint).not.toContainText('中配置');
  await page.evaluate(() => MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-timebase'));
  const languageHint = page.locator('#merge-join-mode-hint');
  await expect(languageHint).toContainText(/for (English, Russian|Chinese, Japanese), etc/);
  await expect(languageHint).not.toContainText('similar languages');
});

test('all four project track toggles share checked and unchecked styles', async ({ page }, testInfo) => {
  await projectSettings(page, 'project-tracks');
  for (const checked of [true, false]) {
    await page.evaluate(checked => {
      document.querySelectorAll('.project-track-toggle input').forEach(input => { input.checked = checked; });
    }, checked);
    // Move the pointer away so hover styles cannot influence this comparison.
    await page.mouse.move(1, 1);
    const styles = await page.locator('.project-track-toggle').evaluateAll(rows => rows.map(row => {
      const style = getComputedStyle(row);
      return [style.backgroundColor, style.borderColor, style.color, style.padding, style.fontSize];
    }));
    expect(styles).toHaveLength(4);
    for (const style of styles) expect(style).toEqual(styles[0]);
  }
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await page.locator('#project-settings-panel').screenshot({ path: testInfo.outputPath('project-track-unified-en.png') });
});

test('waveform gap labels translate on language changes and newly rendered rows', async ({ page }, testInfo) => {
  await page.evaluate(() => {
    MaweBoot.DATA.gap_remove = { schema: 'moy.asr.gap_remove.v1', skip_playback: true, gaps: [
      { start: 0, end: 200, removed: true }, { start: 3200, end: 3900, removed: false },
    ] };
    MaweGapRemoveUi.updateGapRemoveUi();
  });
  const labels = page.locator('.waveform-gap-block:not(.waveform-gap-drag-preview) .waveform-gap-label');
  await expect(labels).toHaveText(['空隙', '空隙（未激活）']);
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(labels).toHaveText(['Gap', 'Gap (inactive)']);
  await page.evaluate(() => MaweCoreState.waveformEditor.render());
  await expect(labels).toHaveText(['Gap', 'Gap (inactive)']);
  await page.screenshot({ path: testInfo.outputPath('waveform-gap-en.png') });
  await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
  await expect(labels).toHaveText(['空隙', '空隙（未激活）']);
});

test('region index opens each local panel and Esc releases its controls and gear focus', async ({ page }, testInfo) => {
  const before = await page.evaluate(() => JSON.stringify(MaweBoot.DATA));
  await settings(page);
  await expect(page.locator('#settings-regions-introduction')).toHaveText('波形区用于查看音频和调整时间，编辑区用于修改字幕，字幕列表用于浏览、筛选与选择字幕。');
  await expect(page.locator('#settings-regions-gear-hint')).toHaveText('也可点击各功能区右上角的 ⚙️ 按钮配置。');
  await page.locator('#editor-settings-panel').screenshot({ path: testInfo.outputPath('region-index.png') });
  for (const [region, panel, gear] of [
    ['waveform', '#waveform-settings-panel', '#waveform-settings-toggle'],
    ['cue-editor', '#cue-editor-settings-panel', '#cue-editor-settings-toggle'],
    ['cue-list', '#cue-list-settings-panel', '#cue-list-settings-toggle'],
  ]) {
    await settings(page);
    await page.locator(`#editor-settings-page-regions [data-settings-region="${region}"]`).click();
    await expect(page.locator('#editor-settings-panel')).toBeVisible();
    await expect(page.locator(panel)).toBeVisible();
    expect(await page.locator(panel).evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator(panel)).toBeHidden();
    await expect(page.locator(gear)).not.toBeFocused();
  }
  expect(await page.evaluate(() => JSON.stringify(MaweBoot.DATA))).toBe(before);
});

test('functional areas hide workspace and keep availability hints inside their card', async ({ page }) => {
  await settings(page);
  await expect(page.locator('[data-settings-region="workspace"]')).toHaveCount(0);
  // 双语字幕设置已并入工程设置的字幕轨道页，功能区不再提供入口。
  await expect(page.locator('[data-settings-region="multi-subtitle"]')).toHaveCount(0);
  await expect(page.locator('#editor-settings-tab-regions')).toHaveText('功能区');
});

test('editing pages separate selection, navigation, adjustment and project time units', async ({ page }, testInfo) => {
  await settings(page, 'general');
  await expect(page.locator('#editor-settings-tab-general')).toHaveText('通用编辑');
  await expect(page.locator('#editor-settings-page-general #keyboard-operation-reference')).toBeVisible();
  await expect(page.locator('#waveform-drag-playhead')).not.toBeVisible();
  await expect(page.locator('#subtitle-selection-title')).toHaveText('选择');
  await expect(page.locator('#subtitle-location-title')).toHaveText('定位');
  await page.locator('#editor-settings-panel').screenshot({ path: testInfo.outputPath('general-edit.png') });
  await settings(page, 'special-edit');
  await page.locator('#cue-move-step').fill('80');
  await page.locator('#cue-move-step').dispatchEvent('change');
  expect(await page.evaluate(() => MaweSettings.EDITOR_SETTINGS.cueMoveStepMs)).toBe(80);
  await expect(page.locator('#timeline-timecode-separator')).toBeVisible();
  await page.locator('#editor-settings-panel').screenshot({ path: testInfo.outputPath('special-edit.png') });
  await settings(page, 'subtitle-preview');
  await page.locator('#pause-on-mouse-click').check();
  await page.locator('#gap-skip-playback').uncheck();
  expect(await page.evaluate(() => MaweBoot.DATA.gap_remove.skip_playback)).toBe(false);
  await page.locator('#editor-settings-panel').screenshot({ path: testInfo.outputPath('playback-settings.png') });
  await page.locator('#editor-settings-close').click();
  await page.locator('#waveform-settings-toggle').click();
  await expect(page.locator('#waveform-settings-panel #gap-skip-playback')).toHaveCount(0);
  await expect(page.locator('#waveform-settings-panel .waveform-settings-title')).toHaveText(['外观', '显示']);
});

test('bilingual settings are grouped and the index never enables the mode implicitly', async ({ page }, testInfo) => {
  await settings(page);
  await expect(page.locator('#editor-settings-page-regions [data-settings-region="multi-subtitle"]')).toHaveCount(0);
  expect(await page.evaluate(() => MaweMultiSubtitleCore.getMultiSubtitleState().enabled === true)).toBe(false);
  await page.locator('#editor-settings-close').click();
  await page.locator('#project-settings-toggle').click();
  // 双语字幕是独立标签页；字词码设置归属字幕轨道。
  await page.locator('#editor-settings-tab-project-tracks').click();
  await expect(page.locator('#editor-settings-page-project-tracks #multi-subtitle-toggle')).toHaveCount(0);
  await expect(page.locator('#editor-settings-page-project-tracks #word-timing-row-height')).toHaveValue('168');
  await expect(page.locator('#editor-settings-page-project-tracks #word-timing-seconds-per-row')).toBeVisible();
  await page.locator('#editor-settings-tab-multi-subtitle').click();
  await page.locator('#multi-subtitle-toggle').check();
  await expect(page.locator('#editor-settings-page-multi-subtitle')).toBeVisible();
  await expect(page.locator('#editor-settings-page-multi-subtitle .settings-panel-title')).toHaveText(['联动', '字幕管理']);
  await page.locator('#multi-subtitle-cross-track-snap').uncheck();
  expect(await page.evaluate(() => MaweSettings.EDITOR_SETTINGS.crossTrackSnap)).toBe(false);
  await page.locator('#project-settings-panel').screenshot({ path: testInfo.outputPath('bilingual-settings.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('#project-settings-toggle')).not.toBeFocused();
});

test('both OTIO menus route to one persistent configuration and never export on navigation', async ({ page }, testInfo) => {
  const downloads = [];
  page.on('download', item => downloads.push(item.suggestedFilename()));
  await page.locator('#extra-export-btn').click();
  await page.locator('[aria-controls="extra-otio-menu"]').hover();
  await page.locator('#extra-otio-menu [data-settings-page="export-more"]').click();
  await expect(page.locator('#extra-export-dropdown')).not.toHaveClass(/open/);
  await expect(page.locator('[data-otio-export-option="srt"]')).toBeFocused();
  await expect(page.locator('input[data-otio-export-option]')).toHaveCount(4);
  await page.locator('[data-otio-export-option="srt"]').uncheck();
  await page.locator('#sticker-otio-export-mode').selectOption('portable');
  expect(await page.evaluate(() => MaweSettings.EDITOR_SETTINGS.otioExportIncludeSrt)).toBe(false);
  await page.locator('#editor-settings-panel').screenshot({ path: testInfo.outputPath('otio-settings.png') });
  await page.locator('#editor-settings-close').click();
  await page.evaluate(() => {
    MaweBoot.DATA.gap_remove = { schema: 'moy.asr.gap_remove.v1', skip_playback: true, gaps: [{ start: 2000, end: 2300, removed: true }] };
    MaweGapRemoveUi.updateGapRemoveUi();
  });
  await page.locator('#gap-removed-export-btn').click();
  await page.locator('[aria-controls="gap-removed-otio-menu"]').hover();
  await page.locator('#gap-removed-otio-menu [data-settings-page="export-more"]').click();
  await expect(page.locator('[data-otio-export-option="srt"]')).not.toBeChecked();
  await page.reload();
  await settings(page, 'export-more');
  await expect(page.locator('[data-otio-export-option="srt"]')).not.toBeChecked();
  await expect(page.locator('#sticker-otio-export-mode')).toHaveValue('portable');
  await page.locator('[data-settings-export="download-fcp7-export"]').click();
  await expect(page.locator('#fcp7-export-modal')).toHaveClass(/show/);
  expect(downloads).toEqual([]);
});

test('renamed tabs restore old keys and the English index fits a narrow window', async ({ page }, testInfo) => {
  for (const key of ['general', 'subtitle-preview', 'subtitle-color']) {
    await page.evaluate(key => localStorage.setItem(MaweDom.EDITOR_SETTINGS_WINDOW_TAB_KEY, key), key);
    await page.reload();
    await page.locator('#editor-settings-toggle').click();
    await expect(page.locator(`#editor-settings-tab-${key}`)).toHaveAttribute('aria-selected', 'true');
  }
  await settings(page, 'interface');
  await page.locator('#language-toggle').click();
  await expect(page.locator('#editor-settings-tab-subtitle-preview')).toHaveText('Playback & preview');
  await expect(page.locator('#editor-settings-tab-subtitle-color')).toHaveText('Palette');
  await page.setViewportSize({ width: 760, height: 700 });
  await settings(page);
  await expect(page.locator('#editor-settings-page-regions')).toContainText('Waveform area');
  await expect(page.locator('#editor-settings-page-regions')).toContainText('Appearance and content');
  await expect(page.locator('#settings-regions-introduction')).toContainText('view audio and adjust timing');
  await expect(page.locator('#settings-regions-gear-hint')).toHaveText('You can also configure each area with the ⚙️ button at its top right.');
  const spacing = await page.locator('#editor-settings-page-regions').evaluate(el => {
    const cards = [...el.querySelectorAll('.editor-settings-region-card')];
    return cards.map(card => card.querySelector('p').getBoundingClientRect().top - card.querySelector('strong').getBoundingClientRect().bottom);
  });
  for (const value of spacing) expect(value).toBeGreaterThanOrEqual(8);
  await page.locator('#editor-settings-panel').screenshot({ path: testInfo.outputPath('region-index-en-narrow.png') });
});

async function projectSettings(page, tab) {
  if (!await page.locator('#project-settings-panel').isVisible()) await page.locator('#project-settings-toggle').click();
  await page.locator('#editor-settings-tab-' + tab).click();
}
test('Escape closes only the top visible settings window in either opening order', async ({ page }) => {
  await settings(page, 'general');
  const drag = await dragFloatingPanelAwayFrom(page, '#editor-settings-panel',
    '#editor-settings-drag-handle', '#project-settings-toggle');
  expect(drag.overlaps, JSON.stringify(drag)).toBe(false);
  expect(Math.abs(drag.panelAfter.x - drag.panelBefore.x)).toBeGreaterThan(200);
  await projectSettings(page, 'timebase');
  await page.keyboard.press('Escape');
  await expect(page.locator('#project-settings-panel')).not.toBeVisible();
  await expect(page.locator('#editor-settings-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#editor-settings-panel')).not.toBeVisible();
  await projectSettings(page, 'timebase');
  const projectDrag = await dragFloatingPanelAwayFrom(page, '#project-settings-panel',
    '#project-settings-drag-handle', '#editor-settings-toggle');
  expect(projectDrag.overlaps, JSON.stringify(projectDrag)).toBe(false);
  await settings(page, 'general');
  await page.keyboard.press('Escape');
  await expect(page.locator('#editor-settings-panel')).not.toBeVisible();
  await expect(page.locator('#project-settings-panel')).toBeVisible();
});
test('project ASS and speaker exports are undoable, reloadable and isolated from browser preferences', async ({ page }) => {
  await projectSettings(page, 'subtitle-style');
  await expect(page.locator('#ass-mode-toggle')).not.toBeChecked();
  await page.locator('#ass-mode-toggle').check();
  await page.locator('#undo-btn').click();
  await expect(page.locator('#ass-mode-toggle')).not.toBeChecked();
  await page.locator('#redo-btn').click();
  await expect(page.locator('#ass-mode-toggle')).toBeChecked();
  await projectSettings(page, 'project-color');
  await page.locator('#export-speaker-labels').check();
  await projectSettings(page, 'timebase');
  await page.locator('#multi-subtitle-main-language-mode').selectOption('word');
  const saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(saved.preview.ass_mode).toBe(true);
  expect(saved.preview.subtitle.speaker_labels.export_enabled).toBe(true);
  expect(saved.multi_subtitle.main_split_mode).toBe('word');
  const personal = await page.evaluate(() => JSON.parse(localStorage.getItem(MaweSettings.EDITOR_SETTINGS_KEY)));
  expect(personal.assMode).toBeUndefined();
  expect(personal.exportSpeakerLabels).toBeUndefined();
  expect(personal.mainSplitModeOverride).toBeUndefined();
  await page.evaluate(saved => MaweProjectLoad.applyCanonicalProject({
    ...saved, preview: undefined, split_mode: 'continuous', multi_subtitle: undefined,
  }, 'next.mosp'), saved);
  await projectSettings(page, 'subtitle-style');
  await expect(page.locator('#ass-mode-toggle')).not.toBeChecked();
  await projectSettings(page, 'project-color');
  await expect(page.locator('#export-speaker-labels')).not.toBeChecked();
  await page.evaluate(saved => MaweProjectLoad.applyCanonicalProject(saved, 'saved.mosp'), saved);
  await projectSettings(page, 'subtitle-style');
  await expect(page.locator('#ass-mode-toggle')).toBeChecked();
  await projectSettings(page, 'project-color');
  await expect(page.locator('#export-speaker-labels')).toBeChecked();
  await projectSettings(page, 'timebase');
  await expect(page.locator('#multi-subtitle-main-language-mode')).toHaveValue('word');
});
test('default sticker directory and project override are independently validated and restored', async ({ page }) => {
  const roots = Object.fromEntries(['default-a', 'default-b', 'override'].map(key => [key, join(tempDir, key).replaceAll('\\', '/')]));
  await settings(page, 'sticker');
  await page.locator('#sticker-root-input').fill(roots['default-a']);
  await page.locator('#sticker-root-read').click();
  await expect(page.locator('#sticker-root-status')).toContainText('读取 1 张');
  expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).sticker_root)).toBe('');
  await page.locator('#editor-settings-close').click();
  await projectSettings(page, 'project-sticker');
  await page.locator('#project-sticker-root-override').check();
  await page.locator('#project-sticker-root-input').fill(roots.override);
  await page.locator('#project-sticker-root-read').click();
  await expect(page.locator('#project-sticker-root-status')).toContainText('读取 1 张');
  expect(await page.evaluate(() => MaweBoot.STICKER_ROOT)).toBe(roots.override);
  await page.locator('#project-settings-close').click();
  await settings(page, 'sticker');
  await page.locator('#sticker-root-input').fill(roots['default-b']);
  await page.locator('#sticker-root-read').click();
  await expect(page.locator('#sticker-root-status')).toContainText('读取 1 张');
  expect(await page.evaluate(() => MaweBoot.STICKER_ROOT)).toBe(roots.override);
  await page.locator('#sticker-root-input').fill(join(tempDir, 'missing'));
  await page.locator('#sticker-root-read').click();
  await expect(page.locator('#sticker-root-status')).toContainText('读取失败');
  expect(await page.evaluate(() => MaweStickerRoot.getDefaultRoot())).toBe(roots['default-b']);
  await page.locator('#editor-settings-close').click();
  await projectSettings(page, 'project-sticker');
  await page.locator('#project-sticker-root-override').uncheck();
  await expect(page.locator('#project-sticker-root-status')).toContainText('读取 1 张');
  expect(await page.evaluate(() => MaweBoot.STICKER_ROOT)).toBe(roots['default-b']);
  await expect(page.locator('#project-sticker-root-input')).toBeDisabled();
  await page.reload();
  expect(await page.evaluate(() => MaweBoot.STICKER_ROOT)).toBe(roots['default-b']);
});
test('all new settings pages have measured spacing in Chinese and English', async ({ page }, testInfo) => {
  for (const language of ['zh', 'en']) {
    await page.evaluate(language => MAWE_I18N.applyLanguage(language), language);
    await page.setViewportSize({ width: 760, height: 740 });
    for (const [scope, keys] of [['global', ['regions', 'general', 'special-edit', 'subtitle-preview', 'subtitle-color', 'export', 'export-more', 'sticker', 'about']],
      ['project', ['timebase', 'project-tracks', 'multi-subtitle', 'subtitle-style', 'project-color', 'project-sticker']]]) {
      await page.evaluate(() => { MaweSettingsPanels.setEditorSettingsPanelOpen(false); MaweSettingsPanels.projectFloatingPanel.close(); });
      for (const key of keys) {
        if (scope === 'project') await projectSettings(page, key); else await settings(page, key);
        await expect(page.locator('#editor-settings-page-' + key)).toBeVisible();
        if (scope === 'project') {
          expect(await page.locator('#editor-settings-page-' + key).evaluate(el => el.parentElement.classList.contains('editor-settings-pages'))).toBe(true);
        }
        if (scope === 'project' && key === 'project-tracks') {
          const geometry = await page.locator('#editor-settings-page-project-tracks .project-track-toggle').evaluateAll(labels => {
            const rows = labels.map(label => {
              const bounds = label.getBoundingClientRect();
              const checkbox = label.querySelector('input[type="checkbox"]').getBoundingClientRect();
              return { left: checkbox.left, top: bounds.top, bottom: bounds.bottom };
            });
            return {
              checkboxLefts: rows.map(row => row.left),
              rowGaps: rows.slice(1).map((row, index) => row.top - rows[index].bottom),
            };
          });
          expect(Math.max(...geometry.checkboxLefts) - Math.min(...geometry.checkboxLefts)).toBeLessThanOrEqual(1);
          for (const gap of geometry.rowGaps) expect(gap).toBeGreaterThanOrEqual(7.9);
        }
        if (scope === 'global' && key === 'about') {
          const version = await page.locator('#editor-about-version').innerText();
          expect(version.trim()).not.toBe('__APP_VERSION__');
          expect(await page.locator('#editor-settings-page-about a[href*="github.com/Moyf/moys-asr-workflow/releases/tag/"]').getAttribute('href')).toBe(`https://github.com/Moyf/moys-asr-workflow/releases/tag/${version.trim()}`);
          expect(await page.locator('#editor-settings-page-about a[href*="moyf.github.io/moys-asr-workflow/docs/"]').count()).toBe(1);
          expect(await page.locator('#editor-settings-page-about .editor-settings-about-placeholder').count()).toBeGreaterThanOrEqual(1);
        }
        const gaps = await page.locator('#editor-settings-page-' + key).evaluate(page => {
          const parents = [page, ...page.querySelectorAll('.editor-settings-group, .editor-settings-sub-group, .editor-settings-field')];
          return parents.flatMap(parent => {
            const children = [...parent.children].filter(el => el.getClientRects().length && el.getBoundingClientRect().height);
            return children.slice(1).map((el, i) => {
              const a = children[i].getBoundingClientRect(), b = el.getBoundingClientRect();
              return b.top >= a.bottom && Math.min(a.right,b.right) > Math.max(a.left,b.left) ? b.top - a.bottom : null;
            }).filter(gap => gap !== null);
          });
        });
        for (const gap of gaps) expect(gap, scope + ':' + key).toBeGreaterThanOrEqual(7.9);
        await page.locator(scope === 'project' ? '#project-settings-panel' : '#editor-settings-panel').screenshot({ path: testInfo.outputPath(scope + '-' + key + '-' + language + '.png') });
      }
    }
  }
});

test('personal marker and sticker feature preferences survive a reload', async ({ page }) => {
  await projectSettings(page, 'project-tracks');
  await page.locator('#project-marker-track-toggle').check();
  await page.locator('#project-settings-close').click();
  await settings(page, 'sticker');
  await page.locator('#sticker-feature-toggle').uncheck();
  await page.reload();
  await projectSettings(page, 'project-tracks');
  await expect(page.locator('#project-marker-track-toggle')).toBeChecked();
  await page.locator('#project-settings-close').click();
  await settings(page, 'sticker');
  await expect(page.locator('#sticker-feature-toggle')).not.toBeChecked();
});

test('a new project invalidates an in-flight directory change and keeps the saved override separate', async ({ page }) => {
  const roots = Object.fromEntries(['default-a', 'override'].map(key => [key, join(tempDir, key).replaceAll('\\', '/')]));
  await page.evaluate(root => MaweStickerRoot.applyRoot('default', root), roots['default-a']);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route('**/api/stickers/root', async route => {
    if (route.request().postDataJSON().path === roots.override) { started(); await gate; }
    await route.continue();
  });
  await page.evaluate(root => { window.pendingRoot = MaweStickerRoot.applyRoot('project', root); }, roots.override);
  await requestStarted;
  await page.evaluate(() => MaweProjectLoad.applyCanonicalProject({
    segments: [{ id: 'new-cue', start: 0, end: 1000, text: '新工程' }],
  }, 'next.mosp'));
  release();
  await page.evaluate(() => window.pendingRoot);
  await expect.poll(() => page.evaluate(() => MaweBoot.STICKER_ROOT)).toBe(roots['default-a']);
  expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).sticker_root)).toBe('');
  expect(await page.evaluate(() => MaweBoot.STICKERS.length)).toBe(1);
});

test('project timing and language restore through history and save without changing ASR metadata', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.evaluate(() => { MaweBoot.DATA.split_mode = 'continuous'; });
  await projectSettings(page, 'timebase');
  await expect(page.locator('#multi-subtitle-extension-language-mode')).not.toBeVisible();
  await page.locator('#multi-subtitle-main-language-mode').selectOption('word');
  await page.locator('#undo-btn').click();
  await expect(page.locator('#multi-subtitle-main-language-mode')).toHaveValue('continuous');
  await page.locator('#redo-btn').click();
  await expect(page.locator('#multi-subtitle-main-language-mode')).toHaveValue('word');
  await page.locator('#timeline-timebase').selectOption('frames');
  await page.locator('#timeline-fps').fill('25');
  await page.locator('#timeline-fps').dispatchEvent('change');
  const saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(saved.timebase).toMatchObject({ unit: 'frames', fps: 25 });
  expect(saved.split_mode).toBe('continuous');
  expect(saved.multi_subtitle.main_split_mode).toBe('word');
  for (const segment of saved.segments) expect(segment.start).toBe(Math.round(segment.start_frame * 1000 / 25));
  await page.evaluate(saved => MaweProjectLoad.applyCanonicalProject(saved, 'timing.mosp'), saved);
  await expect(page.locator('#timeline-timebase')).toHaveValue('frames');
  await expect(page.locator('#timeline-fps')).toHaveValue('25');
  await expect(page.locator('#multi-subtitle-main-language-mode')).toHaveValue('word');
});

test('enabling the sticker feature auto-checks the preview toggle without overriding saved preferences', async ({ page }) => {
  await settings(page, 'sticker');
  await expect(page.locator('#sticker-feature-toggle')).toBeChecked();
  await settings(page, 'subtitle-preview');
  await expect(page.locator('#sticker-overlay-toggle')).not.toBeChecked();

  // 关闭功能：预览开关被强制关闭并禁用（既有行为）。
  await settings(page, 'sticker');
  await page.locator('#sticker-feature-toggle').uncheck();
  await settings(page, 'subtitle-preview');
  await expect(page.locator('#sticker-overlay-toggle')).toBeDisabled();
  await expect(page.locator('#sticker-overlay-toggle')).not.toBeChecked();

  // 重新启用功能：预览开关自动勾选，无需去预览页手动打开。
  await settings(page, 'sticker');
  await page.locator('#sticker-feature-toggle').check();
  await settings(page, 'subtitle-preview');
  await expect(page.locator('#sticker-overlay-toggle')).toBeEnabled();
  await expect(page.locator('#sticker-overlay-toggle')).toBeChecked();

  // 用户随后单独关闭预览并刷新：启动恢复已保存的关闭，不被强行覆盖。
  await page.locator('#sticker-overlay-toggle').uncheck();
  await page.reload();
  await settings(page, 'subtitle-preview');
  await expect(page.locator('#sticker-overlay-toggle')).toBeEnabled();
  await expect(page.locator('#sticker-overlay-toggle')).not.toBeChecked();
});
