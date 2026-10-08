import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';

let tempDir, server;
test.beforeAll(async () => {
  tempDir = makeTempDir('settings-structure');
  const media = join(tempDir, 'synthetic.wav'), project = join(tempDir, 'settings.mosp');
  generateWav(media, 4);
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
  await expect(page.locator('[data-settings-region="multi-subtitle"]')).toBeDisabled();
  await expect(page.locator('#settings-region-multi-unavailable')).toBeVisible();
  await page.locator('#editor-settings-panel').screenshot({ path: testInfo.outputPath('region-index.png') });
  for (const [region, panel, gear] of [
    ['waveform', '#waveform-settings-panel', '#waveform-settings-toggle'],
    ['cue-editor', '#cue-editor-settings-panel', '#cue-editor-settings-toggle'],
    ['cue-list', '#cue-list-settings-panel', '#cue-list-settings-toggle'],
  ]) {
    await settings(page);
    await page.locator(`#editor-settings-page-regions [data-settings-region="${region}"]`).click();
    await expect(page.locator('#editor-settings-panel')).toBeHidden();
    await expect(page.locator(panel)).toBeVisible();
    expect(await page.locator(panel).evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator(panel)).toBeHidden();
    await expect(page.locator(gear)).toBeFocused();
  }
  expect(await page.evaluate(() => JSON.stringify(MaweBoot.DATA))).toBe(before);
});

test('workspace index uses the existing menu without changing layout data', async ({ page }) => {
  await settings(page);
  const before = await page.evaluate(() => JSON.stringify(MaweBoot.DATA.workspace));
  await page.locator('[data-settings-region="workspace"]').click();
  await expect(page.locator('#workspace-transfer-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#workspace-transfer-btn')).toBeFocused();
  expect(await page.evaluate(() => JSON.stringify(MaweBoot.DATA.workspace))).toBe(before);
});

test('editing and playback controls retain their preferences and route to gap skipping', async ({ page }, testInfo) => {
  await settings(page, 'general');
  await expect(page.locator('#editor-settings-tab-general')).toHaveText('编辑操作');
  await page.locator('#cue-move-step').fill('80');
  await page.locator('#cue-move-step').dispatchEvent('change');
  expect(await page.evaluate(() => MaweSettings.EDITOR_SETTINGS.cueMoveStepMs)).toBe(80);
  await page.locator('#editor-settings-panel').screenshot({ path: testInfo.outputPath('editing-settings.png') });
  await settings(page, 'subtitle-preview');
  await page.locator('#pause-on-mouse-click').check();
  expect(await page.evaluate(() => MaweSettings.EDITOR_SETTINGS.pauseOnMouseClick)).toBe(true);
  await page.locator('#editor-settings-panel').screenshot({ path: testInfo.outputPath('playback-settings.png') });
  await page.locator('#editor-settings-page-subtitle-preview [data-settings-region="waveform"]').click();
  await expect(page.locator('#gap-skip-playback')).toBeFocused();
  await page.locator('[data-settings-page="subtitle-preview"]').click();
  await expect(page.locator('#waveform-settings-panel')).toBeHidden();
  await expect(page.locator('#editor-settings-page-subtitle-preview')).toBeVisible();
  await page.reload();
  await settings(page, 'subtitle-preview');
  await expect(page.locator('#pause-on-mouse-click')).toBeChecked();
});

test('bilingual settings are grouped and the index never enables the mode implicitly', async ({ page }, testInfo) => {
  await settings(page);
  await expect(page.locator('[data-settings-region="multi-subtitle"]')).toBeDisabled();
  await page.locator('#editor-settings-close').click();
  await page.locator('#multi-subtitle-toggle').check();
  await settings(page);
  await page.locator('[data-settings-region="multi-subtitle"]').click();
  await expect(page.locator('#multi-subtitle-settings-menu .settings-panel-title')).toHaveText(['显示', '联动', '语言', '字幕管理']);
  await page.locator('#multi-subtitle-cross-track-snap').uncheck();
  expect(await page.evaluate(() => MaweSettings.EDITOR_SETTINGS.crossTrackSnap)).toBe(false);
  await page.locator('#multi-subtitle-settings-menu').screenshot({ path: testInfo.outputPath('bilingual-settings.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('#multi-subtitle-settings-toggle')).toBeFocused();
});

test('both OTIO menus route to one persistent configuration and never export on navigation', async ({ page }, testInfo) => {
  const downloads = [];
  page.on('download', item => downloads.push(item.suggestedFilename()));
  await page.locator('#extra-export-btn').click();
  await page.locator('[aria-controls="extra-otio-menu"]').hover();
  await page.locator('#extra-otio-menu [data-settings-page="export"]').click();
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
  await page.locator('#gap-removed-otio-menu [data-settings-page="export"]').click();
  await expect(page.locator('[data-otio-export-option="srt"]')).not.toBeChecked();
  await page.reload();
  await settings(page, 'export');
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
  await expect(page.locator('#editor-settings-tab-subtitle-color')).toHaveText('Colors and speakers');
  await page.setViewportSize({ width: 760, height: 700 });
  await settings(page);
  await expect(page.locator('#editor-settings-page-regions')).toContainText('Region settings');
  const spacing = await page.locator('#editor-settings-page-regions').evaluate(el => {
    const cards = [...el.querySelectorAll('.editor-settings-region-card')];
    return cards.map(card => card.querySelector('p').getBoundingClientRect().top - card.querySelector('strong').getBoundingClientRect().bottom);
  });
  for (const value of spacing) expect(value).toBeGreaterThanOrEqual(8);
  await page.locator('#editor-settings-panel').screenshot({ path: testInfo.outputPath('region-index-en-narrow.png') });
});
