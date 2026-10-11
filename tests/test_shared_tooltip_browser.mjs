import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MAW_TEST_PLAYWRIGHT || 'playwright');

test('export capability changes preserve stored tooltips after title migration', async () => {
  const browser = await chromium.launch({ executablePath: process.env.MAW_E2E_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage();
    const ids = ['download-otioz', 'download-gap-removed-otioz', 'download-sticker-otioz', 'download-gap-removed-sticker-otioz', 'download-lottie', 'download-ograf'];
    await page.setContent(ids.map(id => `<button id="${id}" title="${id} help">Export</button>`).join(''));
    await page.addScriptTag({ path: 'web/shared/tooltip.js' });
    await page.addScriptTag({ path: 'web/editor/io/editor-export-timeline.js' });
    await page.addScriptTag({ path: 'web/editor/io/editor-dynamic-exports.js' });
    await page.evaluate(() => {
      window.MaweBoot = { SERVER_CONFIG: {} };
      window.MaweProjectSave = { translatedEditorText: text => text };
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
      MaweBoot.SERVER_CONFIG = { canOtozTimelineExport: true, otiozTimelineExportUrl: '/timeline', canOtozStickerExport: true, otiozStickerExportUrl: '/stickers', canLottieExport: true, lottieExportUrl: '/lottie', canOgrafExport: true, ografExportUrl: '/ograf' };
      updateExports();
    });
    for (const id of ids) {
      assert.equal(await page.locator(`#${id}`).getAttribute('data-title'), `${id} help`);
      assert.equal(await page.locator(`#${id}`).getAttribute('title'), null);
    }
  } finally { await browser.close(); }
});
