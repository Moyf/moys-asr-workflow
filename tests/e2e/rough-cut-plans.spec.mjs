import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir,
  findFreePort,
  generateWav,
  generateWaveformPayload,
  makeTempDir,
  startServer,
} from './helpers.mjs';

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('rough-cut-plans');
  const mediaPath = join(tempDir, 'synthetic.wav');
  const projectPath = join(tempDir, 'rough-cut-plans.json');
  generateWav(mediaPath, 4);
  writeFileSync(projectPath, JSON.stringify({
    media: 'synthetic.wav',
    waveform: generateWaveformPayload(4000),
    segments: [
      { id: 'cue-1', start: 0, end: 900, text: '第一句' },
      { id: 'cue-2', start: 1000, end: 1900, text: '第二句' },
      { id: 'cue-3', start: 2000, end: 2900, text: '第三句' },
      { id: 'cue-4', start: 3000, end: 3900, text: '第四句' },
    ],
  }, null, 2), 'utf8');
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

async function openRoughCut(page) {
  await page.locator('#batch-operations-btn').click();
  await page.locator('#rough-cut-btn').click();
  await expect(page.locator('#rough-cut-modal')).toHaveClass(/show/);
}

test('keeps multiple named rough-cut plans independent and batch export continues after failure', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed');
  });
  await page.goto(server.url);
  await openRoughCut(page);

  const rows = page.locator('#rough-cut-rows .rough-cut-row');
  await expect(page.locator('#rough-cut-plan-count')).toHaveText('1 个方案');
  await rows.nth(1).locator('.rough-cut-toggle').click();
  await page.locator('#rough-cut-output-name').fill('default-output');
  await page.locator('#rough-cut-apply').click();

  await page.locator('#rough-cut-plan-new').click();
  await expect(page.locator('#rough-cut-plan-count')).toHaveText('2 个方案');
  await page.locator('#rough-cut-plan-name').fill('短片 B');
  await page.locator('#rough-cut-plan-rename').click();
  await page.locator('#rough-cut-output-name').fill('short-b-output');
  await rows.nth(0).locator('.rough-cut-toggle').click();
  await page.locator('#rough-cut-apply').click();

  const options = page.locator('#rough-cut-plan-select option');
  await expect(options).toHaveText(['默认方案', '短片 B']);
  const defaultPlanId = await options.nth(0).getAttribute('value');
  const shortPlanId = await options.nth(1).getAttribute('value');

  await page.locator('#rough-cut-plan-select').selectOption(defaultPlanId);
  await expect(rows.nth(0)).not.toHaveClass(/removed/);
  await expect(rows.nth(1)).toHaveClass(/removed/);
  await expect(page.locator('#rough-cut-output-name')).toHaveValue('default-output');

  await page.locator('#rough-cut-plan-select').selectOption(shortPlanId);
  await expect(rows.nth(0)).toHaveClass(/removed/);
  await expect(rows.nth(1)).not.toHaveClass(/removed/);
  await expect(page.locator('#rough-cut-output-name')).toHaveValue('short-b-output');

  await page.locator('#rough-cut-plan-copy').click();
  await expect(page.locator('#rough-cut-plan-count')).toHaveText('3 个方案');
  await page.locator('#rough-cut-plan-delete').click();
  await expect(page.locator('#rough-cut-plan-delete')).toHaveText('再次确认删除');
  await page.locator('#rough-cut-plan-delete').click();
  await expect(page.locator('#rough-cut-plan-count')).toHaveText('2 个方案');

  const state = await page.evaluate(() => DATA.rough_cut);
  expect(state.schema).toBe('moy.asr.rough_cut.v2');
  expect(state.plans).toHaveLength(2);
  expect(state.plans[0]).toMatchObject({
    name: '默认方案', output_name: 'default-output',
    kept_segment_ids: ['cue-1', 'cue-3', 'cue-4'],
  });
  expect(state.plans[1]).toMatchObject({
    name: '短片 B', output_name: 'short-b-output',
    kept_segment_ids: ['cue-2', 'cue-3', 'cue-4'],
  });

  await page.locator('#rough-cut-close').click();
  const saveResponse = page.waitForResponse((response) => (
    response.url().endsWith('/api/project') && response.request().method() === 'POST'
  ));
  await page.locator('#save-project').click();
  await expect((await saveResponse).ok()).toBeTruthy();
  await page.reload();
  await openRoughCut(page);
  await expect(page.locator('#rough-cut-plan-select option')).toHaveText(['默认方案', '短片 B']);
  await expect(page.locator('#rough-cut-output-name')).toHaveValue('short-b-output');
  await expect(page.locator('#rough-cut-rows .rough-cut-row').nth(0)).toHaveClass(/removed/);

  const exportRequests = [];
  await page.route('**/api/exports/rough-cut', async (route) => {
    const payload = route.request().postDataJSON();
    exportRequests.push(payload);
    if (exportRequests.length === 1) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({
        ok: false, error: '模拟首个方案失败',
      }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, videoPath: '/tmp/second.mp4', srtPath: '/tmp/second.srt',
    }) });
  });
  await page.locator('#rough-cut-export-all').click();
  await expect.poll(() => exportRequests.length).toBe(2);
  await expect(page.locator('#rough-cut-status')).toContainText('成功 1，失败 1，跳过 0');
  expect(exportRequests.map((request) => request.outputName)).toEqual([
    'default-output', 'short-b-output',
  ]);
});
