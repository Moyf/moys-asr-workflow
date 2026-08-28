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
