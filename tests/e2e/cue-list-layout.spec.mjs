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

test('checked sticker column stays collapsed until the project contains a sticker', async ({ page }) => {
  await page.addInitScript((settingsKey) => {
    localStorage.setItem(settingsKey, JSON.stringify({ cueListShowSticker: true }));
  }, EDITOR_SETTINGS_KEY);
  await page.goto(server.url);

  const cueList = page.locator('#cues-container');
  await expect(page.locator('#cue-list-show-sticker')).toBeChecked();
  await expect(cueList).toHaveClass(/hide-cue-sticker/);

  await page.evaluate(() => {
    DATA.segments[0].sticker = { name: 'test', filename: 'test.png' };
    renderAll();
  });
  await expect(cueList).not.toHaveClass(/hide-cue-sticker/);

  await page.evaluate(() => {
    DATA.segments[0].sticker = null;
    renderAll();
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
      const arrow = time.querySelector('.time-arrow').getBoundingClientRect();
      const end = time.querySelector('.time-end').getBoundingClientRect();
      return {
        width: time.getBoundingClientRect().width,
        startTop: start.top,
        arrowTop: arrow.top,
        endTop: end.top,
      };
    });
  }, width);

  const wide = await measureTimecodes(820);
  expect(new Set(wide.map(({ width }) => width)).size).toBe(1);
  for (const row of wide) {
    expect(Math.abs(row.startTop - row.arrowTop)).toBeLessThan(1);
    expect(Math.abs(row.startTop - row.endTop)).toBeLessThan(1);
  }

  const narrow = await measureTimecodes(620);
  expect(new Set(narrow.map(({ width }) => width)).size).toBe(1);
  expect(narrow[0].width).toBeLessThan(wide[0].width);
  for (const row of narrow) {
    expect(Math.abs(row.startTop - row.arrowTop)).toBeLessThan(1);
    expect(row.endTop).toBeGreaterThan(row.startTop);
  }
});
