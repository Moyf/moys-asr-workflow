import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  cleanupTempDir,
  DURATION_MS,
  findFreePort,
  generateProjectJson,
  generateWav,
  makeTempDir,
  startServer,
} from './helpers.mjs';

const EDITOR_SETTINGS_KEY = 'moy.asr.editor.settings.v1';

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('cue-list-layout');
  const mediaPath = join(tempDir, 'synthetic.wav');
  const projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  generateProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test('subtitle toolbar label returns after the pane is widened', async ({ page }, testInfo) => {
  await page.goto(server.url);
  const toolbar = page.locator('.cues-container > .cue-list-toolbar');
  const label = toolbar.locator(':scope > .layout-toolbar-label');
  await toolbar.evaluate(element => { element.style.width = '180px'; });
  await expect(label).toHaveCSS('white-space', 'nowrap');
  await expect(label).toHaveCSS('overflow', 'hidden');
  const narrow = await label.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()].map(rect => rect.top);
  });
  expect(narrow.length).toBeGreaterThan(0);
  expect(new Set(narrow).size).toBe(1);
  const settings = toolbar.locator('#cue-list-settings-toggle');
  await settings.click();
  await expect(toolbar.locator('#cue-list-settings-panel')).toBeVisible();
  await settings.click();
  await toolbar.evaluate(element => { element.style.width = '1100px'; });
  await expect(label).toBeVisible();
  const wideTextFits = await label.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    const labelRect = element.getBoundingClientRect();
    const toolbarRect = element.parentElement.getBoundingClientRect();
    return text.width > 0 && text.left >= Math.max(labelRect.left, toolbarRect.left) - 1
      && text.right <= Math.min(labelRect.right, toolbarRect.right) + 1;
  });
  expect(wideTextFits).toBe(true);
  await toolbar.screenshot({ path: testInfo.outputPath('subtitle-label-restored.png') });
});

test('checked sticker column stays collapsed until the project contains a sticker', async ({ page }) => {
  await page.addInitScript((settingsKey) => {
    localStorage.setItem(settingsKey, JSON.stringify({ cueListShowSticker: true }));
  }, EDITOR_SETTINGS_KEY);
  await page.goto(server.url);

  const cueList = page.locator('#cues-container');
  await expect(page.locator('#cue-list-show-sticker')).toBeChecked();
  await expect(cueList).toHaveClass(/hide-cue-sticker/);

  await page.evaluate(() => {
    AsrEditorUtils.assignSubtitleGroup(MaweBoot.DATA, AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments,
      [0], 'sticker', { name: 'test', filename: 'test.png' });
    MaweCuePanel.renderAll();
  });
  await expect(cueList).not.toHaveClass(/hide-cue-sticker/);

  await page.evaluate(() => {
    AsrEditorUtils.clearSubtitleGroupMembers(MaweBoot.DATA, AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, [0], 'sticker');
    MaweCuePanel.renderAll();
  });
  await expect(cueList).toHaveClass(/hide-cue-sticker/);
});

test('all timecodes switch together between wide one-line and narrow two-line layouts', async ({ page }) => {
  await page.goto(server.url);

  const measureTimecodes = (width) => page.evaluate((cueListWidth) => {
    const cueList = document.getElementById('cues-container');
    Object.assign(cueList.style, {
      position: 'fixed',
      inset: '0 auto auto 0',
      width: `${cueListWidth}px`,
      height: '400px',
      zIndex: '9999',
    });
    return [...cueList.querySelectorAll('.cue .time')].map((time) => {
      const start = time.querySelector('.time-start').getBoundingClientRect();
      const arrow = time.querySelector('.time-arrow');
      const end = time.querySelector('.time-end').getBoundingClientRect();
      return {
        width: time.getBoundingClientRect().width,
        startTop: start.top,
        arrowTop: arrow.getBoundingClientRect().top,
        arrowHidden: getComputedStyle(arrow).display === 'none',
        endTop: end.top,
      };
    });
  }, width);

  const wide = await measureTimecodes(820);
  expect(new Set(wide.map(({ width }) => width)).size).toBe(1);
  for (const row of wide) {
    expect(row.arrowHidden).toBe(false);
    expect(Math.abs(row.startTop - row.arrowTop)).toBeLessThan(1);
    expect(Math.abs(row.startTop - row.endTop)).toBeLessThan(1);
  }

  const narrow = await measureTimecodes(620);
  expect(new Set(narrow.map(({ width }) => width)).size).toBe(1);
  expect(narrow[0].width).toBeLessThan(wide[0].width);
  for (const row of narrow) {
    expect(row.arrowHidden).toBe(true);
    expect(row.endTop).toBeGreaterThan(row.startTop);
  }
});
