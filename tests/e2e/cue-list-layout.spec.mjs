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

test('subtitle toolbar stays single-line when narrowed and fully reachable when widened', async ({ page }, testInfo) => {
  await page.goto(server.url);
  const toolbar = page.locator('.cues-container > .cue-list-toolbar');
  const label = toolbar.locator(':scope > .layout-toolbar-label');
  // The label is clipped with CSS, never hidden/restored by a resize observer.
  let labelHeight;
  for (const width of [180, 1100, 180, 1100]) {
    // Resize the pane too: widening only the toolbar leaves its controls clipped
    // by the narrow ancestor even though their toolbar-relative bounds look valid.
    await page.locator('#cues-container').evaluate((element, width) => {
      Object.assign(element.style, {
        position: 'fixed', inset: '0 auto auto 0', width: `${width}px`, height: '400px', zIndex: '9999',
      });
    }, width);
    await expect(label).toBeVisible();
    const metrics = await toolbar.evaluate(element => {
      const label = element.querySelector(':scope > .layout-toolbar-label');
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(label);
      const children = [...element.children].filter(child => child.getBoundingClientRect().width > 0);
      return {
        wrap: getComputedStyle(element).flexWrap,
        whiteSpace: style.whiteSpace,
        shrink: style.flexShrink,
        labelHeight: label.getBoundingClientRect().height,
        inLine: children.every(child => {
          const box = child.getBoundingClientRect();
          return box.top >= rect.top - 1 && box.bottom <= rect.bottom + 1;
        }),
        reachable: children.every(child => {
          const box = child.getBoundingClientRect();
          return box.left >= rect.left - 1 && box.right <= rect.right + 1
            && child.scrollWidth <= child.clientWidth + 1
            && child.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        }),
      };
    });
    labelHeight ??= metrics.labelHeight;
    expect(metrics.wrap).toBe('nowrap');
    expect(metrics.whiteSpace).toBe('nowrap');
    expect(metrics.shrink).toBe('0');
    expect(metrics.labelHeight).toBe(labelHeight);
    expect(metrics.inLine).toBe(true);
    if (width === 1100) expect(metrics.reachable).toBe(true);
  }
  await toolbar.screenshot({ path: testInfo.outputPath('subtitle-toolbar-wide.png') });
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
    MaweBoot.DATA.segments[0].sticker = { name: 'test', filename: 'test.png' };
    MaweCuePanel.renderAll();
  });
  await expect(cueList).not.toHaveClass(/hide-cue-sticker/);

  await page.evaluate(() => {
    MaweBoot.DATA.segments[0].sticker = null;
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
