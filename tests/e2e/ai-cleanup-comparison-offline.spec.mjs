import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanupTempDir, makeTempDir } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('cleanup comparison stays searchable and complete offline after the project changes', async ({ page, context }, testInfo) => {
  const directory = makeTempDir('cleanup-comparison-offline');
  try {
    const python = process.env.MAW_E2E_PYTHON;
    const args = ['tests/fixtures/create_cleanup_comparison.py', directory];
    const output = execFileSync(python || 'uv', python ? args : ['run', '--no-sync', 'python', ...args], { cwd: root, encoding: 'utf8' });
    const artifact = JSON.parse(output.trim());
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await context.setOffline(true);
    await page.goto(pathToFileURL(artifact.comparison).href);
    await expect(page.locator('#rows article')).toHaveCount(3);
    await page.locator('summary').click();
    await expect(page.locator('#before')).toContainText('这个这个方法');
    await expect(page.locator('#after')).toContainText('这个方法');
    await expect(page.locator('#rows del')).toHaveText('这个');
    await page.locator('#filter').selectOption('review');
    await expect(page.locator('#rows article')).toHaveCount(1);
    await expect(page.locator('#rows .reason')).toContainText('否定条件需要回听');
    await page.locator('#search').fill('不存在的文字');
    await expect(page.locator('#empty')).toBeVisible();
    await page.locator('#search').fill('否定条件');
    await expect(page.locator('#rows article')).toHaveCount(1);
    const snapshot = readFileSync(artifact.comparison, 'utf8');
    const project = JSON.parse(readFileSync(artifact.project, 'utf8'));
    project.segments[0].text = '后续工程修改';
    writeFileSync(artifact.project, JSON.stringify(project), 'utf8');
    await page.reload();
    await expect(page.locator('#rows article')).toHaveCount(3);
    await page.locator('summary').click();
    await expect(page.locator('#before')).toContainText('这个这个方法');
    await expect(page.locator('#before')).not.toContainText('后续工程修改');
    expect(readFileSync(artifact.comparison, 'utf8')).toBe(snapshot);
    await page.screenshot({ path: testInfo.outputPath('offline-comparison.png'), fullPage: true });
    expect(pageErrors).toEqual([]);
  } finally {
    cleanupTempDir(directory);
  }
});

test('comparison theme switch follows the system and remembers an explicit choice', async ({ page }) => {
  const directory = makeTempDir('cleanup-comparison-theme');
  try {
    const python = process.env.MAW_E2E_PYTHON;
    const args = ['tests/fixtures/create_cleanup_comparison.py', directory];
    const output = execFileSync(python || 'uv', python ? args : ['run', '--no-sync', 'python', ...args], { cwd: root, encoding: 'utf8' });
    const artifact = JSON.parse(output.trim());
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme || 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(pathToFileURL(artifact.comparison).href);
    expect(await theme()).toBe('light');
    await expect(page.getByRole('button', { name: '自动' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '深色' }).click();
    expect(await theme()).toBe('dark');
    await page.reload();
    expect(await theme()).toBe('dark');
    await expect(page.getByRole('button', { name: '深色' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '自动' }).click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(theme).toBe('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(theme).toBe('light');
  } finally {
    cleanupTempDir(directory);
  }
});
