import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  cleanupTempDir,
  findFreePort,
  makeTempDir,
  startAlignmentServer,
} from './helpers.mjs';

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('server-align');
  const projectPath = join(tempDir, 'source.mosp');
  const scriptPath = join(tempDir, 'script.txt');
  writeFileSync(projectPath, JSON.stringify({
    media: '',
    duration: 7000,
    segments: [
      { id: 's1', start: 500, end: 2000, text: '第一句测试', items: [] },
      { id: 's2', start: 2600, end: 3900, text: '失败尝试', items: [] },
      { id: 's3', start: 4500, end: 6200, text: '第二句测试', items: [] },
    ],
  }, null, 2), 'utf-8');
  writeFileSync(scriptPath, '第一句测试\n第二句测试\n', 'utf-8');
  server = await startAlignmentServer(projectPath, scriptPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test('fully overlapping candidate takes remain independently clickable', async ({ page }) => {
  await page.goto(server.url);
  const selected = page.locator('#take-overlay [data-candidate-id][aria-pressed="true"]').first();
  const incomplete = page.locator('#take-overlay [data-candidate-id][aria-pressed="false"]', {
    hasText: '不完整',
  }).first();
  await expect(selected).toBeVisible();
  await expect(incomplete).toBeVisible();
  const candidateId = await incomplete.getAttribute('data-candidate-id');

  await incomplete.click();

  await expect(page.locator(`#take-overlay [data-candidate-id="${candidateId}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('candidate locate button scrolls the basic waveform to its range', async ({ page }) => {
  await page.setViewportSize({width: 520, height: 800});
  await page.goto(server.url);
  await page.locator('[data-waveform-mode="basic"]').click();

  const timeline = page.locator('#timeline-scroll');
  const locateRow = page.locator('#lines .candidate-locate-row').filter({hasText: '第二句测试'}).first();
  await expect(locateRow.locator('.candidate-waveform-jump')).toHaveAttribute(
    'aria-label',
    /在上方波形中定位/,
  );

  const before = await timeline.evaluate((element) => element.scrollLeft);
  await locateRow.locator('.candidate-waveform-jump').click();
  await expect.poll(
    () => timeline.evaluate((element) => element.scrollLeft),
    {timeout: 2000},
  ).toBeGreaterThan(before);
});

test('defaults to multi-row mode and adopted takes toggle manual disable', async ({ page }) => {
  await page.goto(server.url);

  const multiMode = page.locator('.waveform-mode[data-waveform-mode="multi"]');
  const basicMode = page.locator('.waveform-mode[data-waveform-mode="basic"]');
  await expect(multiMode).toHaveClass(/active/);
  await expect(basicMode).not.toHaveClass(/active/);
  await expect(page.locator('#multi-row-seconds-setting')).toBeVisible();
  await expect(page.locator('#multi-row-height-setting')).toBeVisible();

  const selected = page.locator('#take-overlay [data-candidate-id][aria-pressed="true"]').first();
  await expect(selected).toBeVisible();
  const selectedCandidateId = await selected.getAttribute('data-candidate-id');
  expect(selectedCandidateId).toBeTruthy();
  const selectedTake = page.locator(`#take-overlay [data-candidate-id="${selectedCandidateId}"]`).first();
  await selectedTake.click();
  await expect(selectedTake).toHaveClass(/manual-disabled/);
  await expect(selectedTake).toHaveClass(/manual-correction/);
  await expect(selectedTake).toHaveAttribute('aria-pressed', 'false');

  await selectedTake.click();
  await expect(selectedTake).not.toHaveClass(/manual-disabled/);
  await expect(selectedTake).not.toHaveClass(/manual-correction/);
  await expect(selectedTake).toHaveAttribute('aria-pressed', 'true');
});

test('dragging one gap boundary highlights only that gap', async ({ page }) => {
  await page.goto(server.url);
  const gaps = page.locator('#gap-overlay .gap-range:not(.gap-range-preview)');
  await expect(gaps).toHaveCount(2);

  const handle = gaps.nth(0).locator('.gap-handle.right');
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, {steps: 4});

  await expect(page.locator('#gap-overlay .gap-range-boundary-preview')).toHaveCount(1);
  await expect(gaps.nth(0)).toHaveClass(/hidden-source/);
  await expect(gaps.nth(1)).not.toHaveClass(/hidden-source/);

  await page.mouse.up();
});

test('Alt-clicking a gap toggles its disabled state without starting a move', async ({ page }) => {
  await page.goto(server.url);
  const gap = page.locator('#gap-overlay .gap-range:not(.gap-range-preview)').first();
  await expect(gap).toBeVisible();
  await expect(gap).not.toHaveClass(/restored/);

  await gap.click({modifiers: ['Alt']});
  await expect(gap).toHaveClass(/restored/);

  await gap.click({modifiers: ['Alt']});
  await expect(gap).not.toHaveClass(/restored/);
});
