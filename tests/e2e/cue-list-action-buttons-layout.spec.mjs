import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildPortableBlankEditor, cleanupTempDir, disableOnboarding, makeTempDir } from './helpers.mjs';

let dir, blankEditorUrl;
test.beforeAll(() => {
  dir = makeTempDir('cue-list-toolbar');
  const portable = join(dir, 'editor.html');
  buildPortableBlankEditor(portable);
  blankEditorUrl = pathToFileURL(portable).href;
});
test.afterAll(() => cleanupTempDir(dir));

test('ellipsizes cue-list action labels instead of wrapping', async ({ page }) => {
  await disableOnboarding(page);
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto(blankEditorUrl);
  await page.waitForSelector('#cues-container');

  const state = await page.evaluate(() => {
    const toolbar = document.querySelector('.cue-list-toolbar');
    if (toolbar) {
      toolbar.style.width = '180px';
      toolbar.style.maxWidth = '180px';
    }
    return ['#text-process-btn', '#filter-over'].map((selector) => {
      const button = document.querySelector(selector);
      const style = button ? getComputedStyle(button) : null;
      const rect = button?.getBoundingClientRect();
      return {
        selector,
        display: style?.display || '',
        overflow: style?.overflow || '',
        textOverflow: style?.textOverflow || '',
        whiteSpace: style?.whiteSpace || '',
        width: button?.clientWidth || 0,
        contentWidth: button?.scrollWidth || 0,
        height: rect?.height || 0,
      };
    });
  });

  for (const button of state) {
    expect(button.display).not.toBe('none');
    expect(button.overflow).toBe('hidden');
    expect(button.textOverflow).toBe('ellipsis');
    expect(button.whiteSpace).toBe('nowrap');
    expect(button.width).toBeGreaterThan(0);
    expect(button.width).toBeLessThan(button.contentWidth);
    expect(button.height).toBeLessThan(32);
  }
});
