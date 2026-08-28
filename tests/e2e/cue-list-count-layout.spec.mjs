import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { disableOnboarding } from './helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const blankEditorUrl = pathToFileURL(path.join(repoRoot, 'blank-editor.html')).href;

test('hides the cue-list visible count at narrow widths', async ({ page }) => {
  await disableOnboarding(page);

  for (const width of [620, 480, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(blankEditorUrl);
    await page.waitForSelector('#cues-container');

    const state = await page.evaluate(() => {
      const count = document.querySelector('.cue-list-count');
      const settings = document.querySelector('#cue-list-settings-toggle');
      return {
        countDisplay: count ? getComputedStyle(count).display : '',
        settingsWidth: settings?.getBoundingClientRect().width || 0,
      };
    });

    expect(state.countDisplay).toBe('none');
    expect(state.settingsWidth).toBeGreaterThan(0);
  }
});
