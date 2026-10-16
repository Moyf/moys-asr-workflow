import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { compileEditorUnitFixture } from './helpers/editor-module-loader.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MAW_TEST_PLAYWRIGHT || 'playwright');

// 共享 tooltip 与导出按钮接线：在真浏览器里验证「能力变化 → title 迁移后
// 提示保持」的行为。三源都是普通 ESM，经 import 边连带
// tooltip and export-button behavior are tested here; unrelated page wiring is
// supplied as explicit browser stubs rather than pulled in through ESM closure.
test('export capability changes preserve stored tooltips after title migration', async () => {
  const browser = await chromium.launch({ executablePath: process.env.MAW_E2E_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    const ids = ['download-otioz', 'download-gap-removed-otioz', 'download-sticker-otioz', 'download-gap-removed-sticker-otioz', 'download-lottie', 'download-ograf'];
    await page.setContent(
      ids.map(id => `<button id="${id}" title="${id} help">Export</button>`).join('')
      + '<div id="overlay" class="subtitle-overlay hidden"><span id="overlay-main-text"></span>'
      + '<span id="overlay-extension-text" class="subtitle-extension-text hidden"></span></div>');
    await page.evaluate(() => {
      window.MaweBoot = { SERVER_CONFIG: { canOtozTimelineExport: true, otiozTimelineExportUrl: '/timeline', canOtozStickerExport: true, otiozStickerExportUrl: '/stickers', canLottieExport: true, lottieExportUrl: '/lottie', canOgrafExport: true, ografExportUrl: '/ograf' }, maweDomContractCheck: () => [], maweDebug() {}, DATA: { segments: [], overlay_track: {}, multi_subtitle: { tracks: [] } }, PROJECT_NAME: 'test' };
      window.MaweProjectSave = { translatedEditorText: text => text };
      window.AsrEditorUtils = { defaultAssStyleLibrary: () => ({ styles: [], assProfiles: [] }) };
      window.MaweHost = { runtime: { getNavigator: () => window.navigator } };
      const element = { addEventListener() {}, removeEventListener() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        setAttribute() {}, removeAttribute() {}, querySelector: () => null, querySelectorAll: () => [], append() {}, appendChild() {},
        style: { setProperty() {} }, dataset: {}, checked: false, disabled: false, value: '', title: '' };
      window.MaweDom = new Proxy({}, { get: (_target, key) => key === 'ctxmenu' ? element : element });
      window.MaweBoot.DATA.media_metadata = {};
      window.MaweTimeline = { normalizeMediaMetadata: value => value };
      window.MaweSettings = { GAP_REMOVE_SCHEMA: 'moy.asr.gap_remove.v1', EDITOR_SETTINGS: {}, updateEditorSettings() {} };
      window.MaweCoreState = { waveformEditor: null };
      window.MaweSpeakerLabels = { subtitleExportText: segment => segment.text };
      window.MaweSelection = { stickerAbsPath: () => '' };
      window.MaweExportSrt = { cleanupMainSegments: () => [] };
      window.MaweColors = {};
      window.MaweDisplaySettings = { getEditorDisplaySettings: () => ({}) };
      window.MaweWorkspaces = {};
      window.MaweHint = { flashHint() {} };
      window.MaweInlineEdit = {};
      window.MaweCuePanel = {};
      window.MaweMultiSubtitleCore = { getActiveExtensionTrack: () => null };
    });
    for (const file of ['shared/tooltip.js', 'editor/io/editor-export-timeline.js', 'editor/io/editor-dynamic-exports.js']) {
      await page.addScriptTag({ content: compileEditorUnitFixture(file) });
    }
    assert.equal(await page.evaluate(() => typeof window.MaweExportTimeline), 'object', pageErrors.join('\n'));
    assert.equal(await page.evaluate(() => typeof window.MaweDynamicExports), 'object', pageErrors.join('\n'));
    await page.evaluate(() => {
      window.updateExports = () => {
        MaweExportTimeline.updateTimelineOtiozExportButtons();
        MaweExportTimeline.updateStickerExportButtons();
        MaweDynamicExports.updateLottieExportButton();
        MaweDynamicExports.updateOgrafExportButton();
      };
      updateExports();
    });
    for (const id of ids) assert.equal(await page.locator(`#${id}`).getAttribute('data-original-title'), `${id} help`);
    await page.evaluate(() => {
      Object.assign(MaweBoot.SERVER_CONFIG, { canOtozTimelineExport: true, otiozTimelineExportUrl: '/timeline', canOtozStickerExport: true, otiozStickerExportUrl: '/stickers', canLottieExport: true, lottieExportUrl: '/lottie', canOgrafExport: true, ografExportUrl: '/ograf' });
      updateExports();
    });
    for (const id of ids) {
      assert.equal(await page.locator(`#${id}`).getAttribute('data-title'), `${id} help`);
      assert.equal(await page.locator(`#${id}`).getAttribute('title'), null);
    }
  } finally { await browser.close(); }
});
