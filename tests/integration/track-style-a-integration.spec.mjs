import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer } from '../e2e/helpers.mjs';

const canonical = JSON.parse(readFileSync(new URL('../fixtures/project-tracks/legacy-three-tracks.expected.json', import.meta.url), 'utf8'));
let directory, server;
test.beforeAll(async () => { directory = makeTempDir('track-styles'); server = await startBlankServer(await findFreePort(), directory); });
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => window.MaweAssManagerWiring && window.MaweMultiImport);
  await page.evaluate(async project => {
    await MaweMultiImport.openProjectFile(new File([JSON.stringify({ ...project, media: '' })], 'styles.mosp', { type: 'application/json' }), { suppressMediaPrompt: true });
  }, canonical);
  await expect.poll(() => page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('main').status)).toBe('linked');
});

test('stale project style target cannot write the library after track creation is undone', async ({ page }) => {
  await page.evaluate(() => { MaweBoot.DATA.tracks = MaweBoot.DATA.tracks.filter(track => track.role !== 'overlay'); MaweHistory.editorHistory.clear(); });
  await page.evaluate(() => MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-project-tracks'));
  await page.locator('[data-track-role="overlay"] [data-track-field="enabled"]').check();
  await page.evaluate(() => MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-subtitle-style'));
  await page.locator('#overlay-ass-style-edit').click();
  const before = await page.evaluate(() => JSON.stringify(ASS_STYLE_LIBRARY));
  // The floating panel blocks the shortcut; its non-modal undo button remains reachable.
  await page.locator('#undo-btn').evaluate(element => element.click());
  expect(await page.evaluate(() => AsrEditorUtils.getOverlayTrack(MaweBoot.DATA))).toBeNull();
  await expect(page.locator('#ass-style-form')).toBeHidden();
  await page.locator('#ass-style-font-size').evaluate(element => { element.value = '121'; element.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(await page.evaluate(() => JSON.stringify(ASS_STYLE_LIBRARY))).toBe(before);
});


test('new secondary and overlay tracks capture styles in the same undo transaction', async ({ page }) => {
  await page.evaluate(() => {
    MaweBoot.DATA.tracks = MaweBoot.DATA.tracks.filter(track => track.role === 'main');
    MaweBoot.DATA.bindings = [];
    delete MaweBoot.DATA.bilingual.active_track_id;
    MaweHistory.editorHistory.clear();
    MaweDisplaySettings.updateMultiSubtitleUi();
    MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-project-tracks');
  });
  const secondary = page.locator('[data-track-role="secondary"] [data-track-field="enabled"]');
  page.once('dialog', dialog => dialog.dismiss());
  await secondary.check();
  expect(await page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('secondary').status)).toBe('linked');
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await page.evaluate(() => MaweBoot.DATA.tracks.some(track => track.role === 'secondary'))).toBe(false);
  await page.evaluate(() => MaweHistory.performRedo());
  expect(await page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('secondary').status)).toBe('linked');
  const overlay = page.locator('[data-track-role="overlay"] [data-track-field="enabled"]');
  await overlay.check();
  expect(await page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('overlay').status)).toBe('linked');
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await page.evaluate(() => MaweBoot.DATA.tracks.some(track => track.role === 'overlay'))).toBe(false);
  await page.evaluate(() => MaweHistory.performRedo());
  const saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  for (const role of ['secondary', 'overlay']) {
    const track = saved.tracks.find(track => track.role === role);
    expect(saved.styles.some(style => style.id === track.style.style_id)).toBe(true);
  }
});


test('preview switches hide stickers with their tracks without changing export', async ({ page }) => {
  await page.evaluate(() => {
    const h = AsrEditorUtils;
    for (const role of ['main', 'secondary']) {
      const track = MaweBoot.DATA.tracks.find(item => item.role === role);
      track.segments[0].start = 0;
      h.assignSubtitleGroup(MaweBoot.DATA, track.segments, [0], 'sticker', { name: role, rel: `${role}.png`, filename: `${role}.png` });
    }
    MaweDom.overlayToggle.checked = true;
    MaweDom.extensionOverlayToggle.checked = true;
    MaweDom.stickerOverlayToggle.checked = true;
    MaweSettings.EDITOR_SETTINGS.stickersEnabled = true;
    MaweStickerOverlay.stickerOverlayDataVersion += 1;
    MaweStickerOverlay.renderStickerOverlay(0);
  });
  const read = () => page.evaluate(() => ({
    preview: MaweStickerOverlay.rebuildStickerIntervals('preview').map(item => item.source.name).sort(),
    export: MaweStickerBurnPlan.collectStickerIntervals().map(item => item.rel).sort(),
  }));
  expect(await read()).toEqual({ preview: ['main', 'secondary'], export: ['main.png', 'secondary.png'] });
  await expect(page.locator('#sticker-overlay-layer img')).toHaveCount(2);
  await page.evaluate(() => { MaweDom.overlayToggle.checked = false; MaweDom.overlayToggle.dispatchEvent(new Event('change')); });
  expect(await read()).toEqual({ preview: ['secondary'], export: ['main.png', 'secondary.png'] });
  await expect(page.locator('#sticker-overlay-layer img')).toHaveCount(1);
  await page.evaluate(() => { MaweDom.extensionOverlayToggle.checked = false; MaweDom.extensionOverlayToggle.dispatchEvent(new Event('change')); });
  expect(await read()).toEqual({ preview: [], export: ['main.png', 'secondary.png'] });
  await expect(page.locator('#sticker-overlay-layer img')).toHaveCount(0);
});


test('project track preview controls hide stickers without changing export', async ({ page }) => {
  await page.evaluate(() => {
    const h = AsrEditorUtils;
    for (const role of ['main', 'secondary']) {
      const track = MaweBoot.DATA.tracks.find(item => item.role === role);
      track.segments[0].start = 0;
      h.assignSubtitleGroup(MaweBoot.DATA, track.segments, [0], 'sticker', { name: role, rel: `${role}.png`, filename: `${role}.png` });
    }
    MaweDom.overlayToggle.checked = true; MaweDom.extensionOverlayToggle.checked = true;
    MaweDom.stickerOverlayToggle.checked = true; MaweSettings.EDITOR_SETTINGS.stickersEnabled = true;
    MaweStickerOverlay.stickerOverlayDataVersion += 1; MaweStickerOverlay.renderStickerOverlay(0);
    MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-project-tracks');
  });
  const read = () => page.evaluate(() => ({ preview: MaweStickerOverlay.rebuildStickerIntervals('preview').map(item => item.source.name).sort(),
    export: MaweStickerBurnPlan.collectStickerIntervals().map(item => item.rel).sort() }));
  await expect(page.locator('#sticker-overlay-layer img')).toHaveCount(2);
  await page.locator('[data-track-role="main"] [data-track-field="preview"]').uncheck();
  expect(await read()).toEqual({ preview: ['secondary'], export: ['main.png', 'secondary.png'] });
  await expect(page.locator('#sticker-overlay-layer img')).toHaveCount(1);
  await page.locator('[data-track-role="secondary"] [data-track-field="preview"]').uncheck();
  expect(await read()).toEqual({ preview: [], export: ['main.png', 'secondary.png'] });
  await expect(page.locator('#sticker-overlay-layer img')).toHaveCount(0);
  const saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(saved.tracks.filter(track => ['main', 'secondary'].includes(track.role)).map(track => track.preview_visible)).toEqual([false, false]);
  await page.evaluate(() => MaweHistory.performUndo());
  await expect(page.locator('#sticker-overlay-layer img')).toHaveCount(1);
  expect(await read()).toEqual({ preview: ['secondary'], export: ['main.png', 'secondary.png'] });
  await page.evaluate(() => MaweHistory.performRedo());
  await expect(page.locator('#sticker-overlay-layer img')).toHaveCount(0);
});
