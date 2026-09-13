// Dev-only Playwright regression: loading a project whose preview.subtitle
// stores a scanned (non-builtin) font family must not crash the early-boot
// appearance sync. The boot call used to hit the GEO_UTILS alias while it was
// still in the temporal dead zone (uncaught ReferenceError on page load).
import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
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

let tempDir;
let server;
let projectPath;

test.beforeAll(async () => {
  tempDir = makeTempDir('subtitle-preview-boot');
  const mediaPath = join(tempDir, 'synthetic.wav');
  projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  generateProjectJson(projectPath);
  const project = JSON.parse(readFileSync(projectPath, 'utf-8'));
  project.preview = project.preview || {};
  project.preview.subtitle = {
    ...(project.preview.subtitle || {}),
    x: 0.1, y: 0.8, width: 0.8, height: 0.15,
    font_family: 'Microsoft YaHei',
  };
  writeFileSync(projectPath, JSON.stringify(project, null, 2), 'utf-8');
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test('a custom preview font family boots without GEO_UTILS TDZ errors', async ({ page }) => {
  const bootErrors = [];
  page.on('pageerror', (error) => bootErrors.push(String(error)));
  await page.goto(server.url);
  await page.waitForFunction(() => {
    const media = document.getElementById('player');
    return media && media.readyState >= 1;
  });

  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-subtitle-style').click();
  await expect(page.locator('#subtitle-font-family')).toHaveValue('Microsoft YaHei');
  // 共享工具层就绪后，启动期占位的自定义字体选项会被统一本地化。
  await expect(page.locator('#subtitle-font-family option:checked')).toHaveText('微软雅黑');
  expect(bootErrors).toEqual([]);
});
