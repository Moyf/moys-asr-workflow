import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  cleanupTempDir, disableOnboarding, findFreePort, generateProjectJson,
  generateWav, makeTempDir, startServer,
} from './helpers.mjs';

let tempDir;
let server;
let projectPath;

test.beforeAll(async () => {
  tempDir = makeTempDir('markers-batch');
  const media = join(tempDir, 'synthetic.wav');
  projectPath = join(tempDir, 'project.json');
  generateWav(media, 300);
  generateProjectJson(projectPath);
  server = await startServer(projectPath, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });

async function seed(page) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    MaweBoot.DATA.markers = window.AsrEditorUtils.normalizeMarkers([
      { id: 'human', start: 100, name: '人工标记', note: '请保留' },
      { id: 'ai-delete', start: 1000, end: 2000, name: '试麦', color: '#8e4ec6', note: '[AI] 删除：试麦' },
      { id: 'ai-review', start: 3000, end: 4000, name: '有效步骤', color: '#f5a623', note: '[AI] 替代项：信息覆盖待决策',
        review: { status: 'pending', reason: '步骤没有被覆盖' } },
    ]);
    MaweBoot.DATA.segments[0].disabled = true;
    MaweMarkerEditing.afterExternalMarkersChange();
  });
  await page.locator('#markers-manage').click();
  await expect(page.locator('.markers-item')).toHaveCount(3);
}

test('notes toggle and custom colors preserve marker content', async ({ page }) => {
  await seed(page);
  await expect(page.locator('.markers-item-note')).toHaveCount(0);
  await page.evaluate(() => MaweMarkerEditing.updateMarkerFields('human', { note: '' }));
  await page.locator('#markers-show-notes').check();
  await expect(page.locator('[data-marker-id="human"] .markers-item-note')).toHaveText('-');
  await expect(page.locator('[data-marker-id="ai-delete"] .markers-item-note')).toHaveText('[AI] 删除：试麦');
  const spacing = await page.locator('.markers-item-note').first().evaluate(el => parseFloat(getComputedStyle(el).marginTop));
  expect(spacing).toBeGreaterThanOrEqual(8);
  await page.locator('[data-marker-id="human"] .markers-item-edit').click();
  await expect(page.locator('.markers-color-swatches button')).toHaveCount(8);
  await page.locator('.markers-color-picker').evaluate(el => {
    el.value = '#b18be8';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.markers-edit-hex')).toHaveValue('#b18be8');
  expect(await page.evaluate(() => MaweMarkerEditing.findMarker('human').color)).toBe('#b18be8');
  await page.locator('.markers-edit-hex').fill('#ffffff');
  await page.locator('.markers-edit-hex').press('Tab');
  await expect(page.locator('.markers-color-picker')).toHaveValue('#ffffff');
  await page.locator('#markers-show-notes').uncheck();
  await expect(page.locator('.markers-item-note')).toHaveCount(0);
});

test('filter-select-delete is one undo and preserves manual markers and clip decisions', async ({ page }) => {
  await seed(page);
  await page.locator('#markers-search').fill('[AI]');
  await expect(page.locator('.markers-item')).toHaveCount(2);
  await page.locator('#markers-batch-select').click();
  await expect(page.locator('.markers-item-checkbox')).toHaveCount(2);
  await page.locator('#markers-select-all').click();
  await expect(page.locator('.markers-item-checkbox:checked')).toHaveCount(2);
  await page.locator('#markers-delete-selected').click();
  expect(await page.evaluate(() => MaweMarkerEditing.getMarkers().map(m => m.id))).toEqual(['human']);
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].disabled)).toBe(true);
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => MaweMarkerEditing.getMarkers().map(m => m.id)))
    .toEqual(['human', 'ai-delete', 'ai-review']);
  await page.locator('#redo-btn').click();
  expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).markers.items.map(m => m.id)))
    .toEqual(['human']);
  const response = page.waitForResponse(res => res.url().endsWith('/api/project') && res.request().method() === 'POST');
  await page.locator('#save-project').click();
  expect((await response).ok()).toBe(true);
  await page.reload();
  expect(await page.evaluate(() => MaweMarkerEditing.getMarkers().map(m => m.id))).toEqual(['human']);
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].disabled)).toBe(true);
});

test('changing filters drops hidden selections and all-select matches kind/review filters', async ({ page }) => {
  await seed(page);
  await page.locator('#markers-batch-select').click();
  await page.locator('[data-marker-id="human"] .markers-item-checkbox').check();
  await expect(page.locator('#markers-selection-summary')).toHaveText('已选 1 项');
  await page.locator('#markers-search').fill('[AI]');
  await expect(page.locator('#markers-delete-selected')).toBeDisabled();
  await page.locator('#markers-filter-review').selectOption('pending');
  await page.locator('#markers-filter-kind').selectOption('marker');
  await expect(page.locator('#markers-select-all')).toBeDisabled();
  await page.locator('#markers-filter-kind').selectOption('region');
  await page.locator('#markers-filter-color').selectOption('#f5a623');
  await page.locator('#markers-select-all').click();
  await expect(page.locator('.markers-item-checkbox:checked')).toHaveCount(1);
  await page.locator('#markers-delete-selected').click();
  expect(await page.evaluate(() => MaweMarkerEditing.getMarkers().map(m => m.id))).toEqual(['human', 'ai-delete']);
  await page.locator('#markers-search').fill('不存在');
  await expect(page.locator('#markers-select-all')).toBeDisabled();
  await expect(page.locator('#markers-delete-selected')).toBeDisabled();
});

test('checkbox selection does not seek; exit clears checks and selection is reset on project import', async ({ page }) => {
  await seed(page);
  await page.locator('#markers-batch-select').click();
  const time = await page.evaluate(() => MaweCoreState.player.currentTime);
  await page.locator('[data-marker-id="ai-review"] .markers-item-checkbox').check();
  expect(await page.evaluate(() => MaweCoreState.player.currentTime)).toBe(time);
  await page.locator('#markers-batch-select').click();
  await expect(page.locator('.markers-item-checkbox')).toHaveCount(0);
  await page.locator('#markers-batch-select').click();
  await expect(page.locator('#markers-delete-selected')).toBeDisabled();
  await page.locator('#markers-select-all').click();
  await page.evaluate(() => MaweProjectLoad.applyCanonicalProject({
    segments: [{ id: 'new', start: 0, end: 1000, text: '新工程' }],
    markers: { schema: 'moy.asr.markers.v1', items: [{ id: 'human', start: 100, name: '另一个工程' }] },
  }, 'new.mosp'));
  await expect(page.locator('#markers-batch-select')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.markers-item-checkbox')).toHaveCount(0);
});

test('batch controls translate and have measured spacing without translating AI notes', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await seed(page);
  await expect(page.locator('#markers-batch-select')).toHaveText('Batch select');
  await page.locator('#markers-batch-select').click();
  await expect(page.locator('#markers-select-all')).toHaveText('Select all');
  await expect(page.locator('#markers-delete-selected')).toHaveText('Delete selected');
  await page.locator('[data-marker-id="ai-delete"] .markers-item-checkbox').check();
  await expect(page.locator('#markers-selection-summary')).toHaveText('Selected 1 item(s)');
  const distances = await page.evaluate(() => {
    const filters = document.querySelector('.markers-filters-field').getBoundingClientRect();
    const actions = document.querySelector('#markers-batch-actions').getBoundingClientRect();
    const list = document.querySelector('#markers-list').getBoundingClientRect();
    return [actions.top - filters.bottom, list.top - actions.bottom];
  });
  expect(distances.every(distance => distance >= 8)).toBe(true);
  expect(await page.evaluate(() => MaweMarkerEditing.findMarker('ai-delete').note)).toBe('[AI] 删除：试麦');
  await page.screenshot({ path: test.info().outputPath('markers-batch-english.png') });
});
