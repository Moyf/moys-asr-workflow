import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  cleanupTempDir, disableOnboarding, findFreePort, generateProjectJson,
  generateWav, makeTempDir, startServer,
} from './helpers.mjs';

let tempDir;
let server;

const reviewName = '[AI] 你好 [ai]';
const reviewNote = '[AI] 复核：<img src=x onerror=alert(1)> a+b [ai]';

test.beforeAll(async () => {
  tempDir = makeTempDir('marker-feedback');
  const mediaPath = join(tempDir, 'synthetic.wav');
  const projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, 300);
  generateProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

async function seed(page) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(({ name, note }) => {
    MaweBoot.DATA.gap_remove = null;
    MaweGapRemoveUi.updateGapRemoveUi();
    MaweBoot.DATA.markers = window.AsrEditorUtils.normalizeMarkers([
      { id: 'review', start: 3000, end: 4000, name, note,
        review: { status: 'pending', reason: '需要复核' } },
      { id: 'human', start: 100, name: '人工标记', note: '请保留' },
    ]);
    MaweMarkerEditing.afterExternalMarkersChange();
    MaweMarkersPanel.openPanel();
  }, { name: reviewName, note: reviewNote });
  await expect(page.locator('#markers-panel')).toBeVisible();
  await expect(page.locator('.markers-item')).toHaveCount(2);
}

test('marker search highlights literal matches while preserving notes and editor text', async ({ page }) => {
  await seed(page);
  const row = page.locator('[data-marker-id="review"]');
  const search = page.locator('#markers-search');
  await page.locator('#markers-show-notes').check();
  const otherRow = page.locator('[data-marker-id="human"]');
  await page.mouse.move(0, 0);
  const normalBackground = await row.evaluate(element => getComputedStyle(element).backgroundColor);
  const otherBackground = await otherRow.evaluate(element => getComputedStyle(element).backgroundColor);
  await row.locator('.markers-item-main').hover();
  await expect.poll(() => row.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(normalBackground);
  await expect(row.locator('.markers-item-main')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(row.locator('.markers-item-note')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(otherRow).toHaveCSS('background-color', otherBackground);
  await page.locator('#markers-panel').screenshot({ path: test.info().outputPath('markers-card-hover.png') });
  await page.mouse.move(0, 0);
  await expect(row).toHaveCSS('background-color', normalBackground);
  await search.fill('  [ai]  ');
  await expect(page.locator('.markers-item')).toHaveCount(1);
  await expect(row.locator('.markers-item-title mark')).toHaveText(['[AI]', '[ai]']);
  await expect(row.locator('.markers-item-note mark')).toHaveText(['[AI]', '[ai]']);
  await expect(row.locator('.markers-item-title')).toHaveText(reviewName);
  await expect(row.locator('.markers-item-note')).toHaveText(reviewNote);
  await expect(row.locator('img')).toHaveCount(0);
  await row.locator('.markers-item-edit').click();
  await expect(row.locator('.markers-item-editor input[type="text"]').first()).toHaveValue(reviewName);
  await expect(row.locator('.markers-item-editor textarea')).toHaveValue(reviewNote);
  await expect(row.locator('.markers-item-editor mark')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.locator('#markers-panel').screenshot({ path: test.info().outputPath('markers-search-highlight.png') });

  await page.locator('#markers-show-notes').uncheck();
  await expect(row.locator('.markers-item-note')).toHaveCount(0);
  await expect(row.locator('.markers-item-title mark')).toHaveCount(2);
  await page.locator('#markers-show-notes').check();
  await expect(row.locator('.markers-item-note mark')).toHaveCount(2);
  await search.fill('a+b');
  await expect(row.locator('.markers-item-title mark')).toHaveCount(0);
  await expect(row.locator('.markers-item-note mark')).toHaveText(['a+b']);
  await search.fill('<img');
  await expect(row.locator('.markers-item-note mark')).toHaveText(['<img']);
  await expect(row.locator('img')).toHaveCount(0);
  await search.fill('你好');
  await expect(row.locator('.markers-item-title mark')).toHaveText(['你好']);
  await search.fill('');
  await expect(page.locator('.markers-item')).toHaveCount(2);
  await expect(page.locator('.markers-search-match')).toHaveCount(0);
  expect(await page.evaluate(() => {
    const marker = MaweMarkerEditing.findMarker('review');
    return { name: marker.name, note: marker.note };
  })).toEqual({ name: reviewName, note: reviewNote });
});

test('unnamed marker placeholder stays translated when its note matches the search', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => MaweMarkerEditing.updateMarkerFields('review', { name: '', note: '区段备注' }));
  await page.locator('#markers-show-notes').check();
  await page.locator('#markers-search').fill('区');
  const row = page.locator('[data-marker-id="review"]');
  await expect(row.locator('.markers-item-title')).toHaveText('区段');
  await expect(row.locator('.markers-item-title mark')).toHaveCount(0);
  await expect(row.locator('.markers-item-note mark')).toHaveText(['区']);
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(row.locator('.markers-item-title')).toHaveText('Region');
  await expect(row.locator('.markers-item-title mark')).toHaveCount(0);
  await expect(row.locator('.markers-item-note')).toHaveText('区段备注');
});

test('review and mute controls stay together at the left of marker editor actions', async ({ page }) => {
  await seed(page);
  const row = page.locator('[data-marker-id="review"]');
  await row.locator('.markers-item-edit').click();
  await expect(row.locator('.markers-review-toggle')).toHaveText('待复核');
  await expect(row.locator('.markers-ai-review-mute-toggle')).toHaveText('设静音');
  for (const language of ['zh', 'en']) {
    await page.evaluate(language => MAWE_I18N.applyLanguage(language), language);
    const geometry = await row.locator('.markers-item-actions').evaluate(actions => {
      const review = actions.querySelector('.markers-review-toggle').getBoundingClientRect();
      const mute = actions.querySelector('.markers-ai-review-mute-toggle').getBoundingClientRect();
      const locate = actions.querySelector(':scope > button').getBoundingClientRect();
      const outer = actions.getBoundingClientRect();
      return { reviewLeft: review.left - outer.left, gap: mute.left - review.right,
        topDifference: mute.top - review.top, locateGap: locate.left - mute.right };
    });
    expect(geometry.reviewLeft).toBeLessThanOrEqual(1);
    expect(geometry.gap).toBeGreaterThanOrEqual(7);
    expect(geometry.gap).toBeLessThanOrEqual(9);
    expect(Math.abs(geometry.topDifference)).toBeLessThanOrEqual(1);
    expect(geometry.locateGap).toBeGreaterThan(geometry.gap);
  }
  await page.mouse.move(0, 0);
  await page.locator('#markers-panel').screenshot({ path: test.info().outputPath('markers-review-mute-layout.png') });
  await row.locator('.markers-ai-review-mute-toggle').click();
  await expect(row.locator('.markers-ai-review-mute-toggle')).toHaveText('Muted');
  await expect(row.locator('.markers-review-toggle')).toHaveText('Removed');
  await expect(row.locator('.markers-review-toggle')).toBeDisabled();
});
