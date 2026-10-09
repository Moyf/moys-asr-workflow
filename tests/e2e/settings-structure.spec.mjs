import { expect, test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';

let tempDir, server;
test.beforeAll(async () => {
  tempDir = makeTempDir('settings-structure');
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

test('region index opens each local panel and Esc returns focus to its visible gear', async ({ page }, testInfo) => {
  const before = await page.evaluate(() => JSON.stringify(MaweBoot.DATA));
  await settings(page);
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
    await expect(page.locator(gear)).toBeFocused();
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
  await page.locator('#editor-settings-tab-project-tracks').click();
  await expect(page.locator('#project-multi-subtitle-settings')).toBeHidden();
  await page.locator('#multi-subtitle-toggle').check();
  await expect(page.locator('#project-multi-subtitle-settings')).toBeVisible();
  await expect(page.locator('#project-multi-subtitle-settings .settings-panel-title')).toHaveText(['显示', '联动', '字幕管理']);
  await page.locator('#multi-subtitle-cross-track-snap').uncheck();
  expect(await page.evaluate(() => MaweSettings.EDITOR_SETTINGS.crossTrackSnap)).toBe(false);
  await page.locator('#project-settings-panel').screenshot({ path: testInfo.outputPath('bilingual-settings.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('#project-settings-toggle')).toBeFocused();
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
  await expect(page.locator('#editor-settings-tab-subtitle-preview')).toHaveText('Playback and preview');
  await expect(page.locator('#editor-settings-tab-subtitle-color')).toHaveText('Custom palette');
  await page.setViewportSize({ width: 760, height: 700 });
  await settings(page);
  await expect(page.locator('#editor-settings-page-regions')).toContainText('Adjust waveform appearance and content.');
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
  // Move the floating window aside before using the adjacent toolbar entry.
  const handle = await page.locator('#editor-settings-drag-handle').boundingBox();
  await page.mouse.move(handle.x + 40, handle.y + 15);
  await page.mouse.down();
  await page.mouse.move(45, 130, { steps: 5 });
  await page.mouse.up();
  await projectSettings(page, 'timebase');
  await page.keyboard.press('Escape');
  await expect(page.locator('#project-settings-panel')).not.toBeVisible();
  await expect(page.locator('#editor-settings-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#editor-settings-panel')).not.toBeVisible();
  await projectSettings(page, 'timebase');
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
    for (const [scope, keys] of [['global', ['regions', 'general', 'special-edit', 'subtitle-preview', 'subtitle-color', 'export', 'export-more', 'sticker']],
      ['project', ['timebase', 'project-tracks', 'subtitle-style', 'project-color', 'project-sticker']]]) {
      await page.evaluate(() => { MaweSettingsPanels.setEditorSettingsPanelOpen(false); MaweSettingsPanels.projectFloatingPanel.close(); });
      for (const key of keys) {
        if (scope === 'project') await projectSettings(page, key); else await settings(page, key);
        await expect(page.locator('#editor-settings-page-' + key)).toBeVisible();
        if (scope === 'project') {
          expect(await page.locator('#editor-settings-page-' + key).evaluate(el => el.parentElement.classList.contains('editor-settings-pages'))).toBe(true);
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
