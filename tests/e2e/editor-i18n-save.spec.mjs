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

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('editor-i18n-save');
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

test('English locale covers the editor shell and recent-project setting stays first', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await page.goto(server.url);

  await expect(page.locator('#open-project')).toHaveText('Open project');
  await expect(page.locator('#save-project')).toHaveText('Save project');
  await expect(page.locator('#recent-projects-toggle')).toHaveText('Recent projects');
  await page.locator('#recent-projects-toggle').click();
  await expect(page.locator('#server-project-settings')).toContainText('Automatically open last project');

  const firstMenuControl = await page.locator('#recent-projects-menu')
    .evaluate((menu) => menu.querySelector('input, .dropdown-item')?.id);
  expect(firstMenuControl).toBe('server-project-settings');
  await page.locator('#recent-projects-toggle').click();

  await page.locator('#editor-settings-toggle').click();
  const shellText = await page.locator('body').innerText();
  const untranslatedShellLines = shellText.split('\n')
    .map((line) => line.trim())
    .filter((line) => /[\u3400-\u9fff]/u.test(line));
  expect(untranslatedShellLines).toEqual([]);
  const untranslatedUiStrings = await page.evaluate(() => {
    const skip = '#cue-list, #cue-panel-text, #overlay, #sticker-overlay-layer, #media-name, #json-name, #sticker-grid, script, style';
    const found = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest(skip)) continue;
      const value = node.nodeValue.trim();
      if (/[\u3400-\u9fff]/u.test(value)) found.add(value);
    }
    document.querySelectorAll('[title], [placeholder], [aria-label]').forEach((element) => {
      if (element.closest(skip)) return;
      ['title', 'placeholder', 'aria-label'].forEach((name) => {
        const value = element.getAttribute(name) || '';
        if (/[\u3400-\u9fff]/u.test(value)) found.add(value);
      });
    });
    return [...found];
  });
  expect(untranslatedUiStrings).toEqual([]);

  await page.locator('.cue').first().click({ button: 'right' });
  expect(await page.locator('#ctxmenu').innerText()).not.toMatch(/[\u3400-\u9fff]/u);
  await page.keyboard.press('Escape');

  await page.locator('#language-toggle').click();
  await expect(page.locator('#save-project')).toHaveText('保存工程');
  expect(await page.evaluate(() => localStorage.getItem('mawe.language'))).toBe('zh');
});

test('Ctrl+S saves and Ctrl+Shift+S invokes save as', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await page.goto(server.url);

  const saveResponse = page.waitForResponse((response) => (
    response.url().endsWith('/api/project') && response.request().method() === 'POST'
  ));
  await page.keyboard.press('Control+s');
  expect((await saveResponse).ok()).toBe(true);
  await expect(page.locator('.hint-card').last()).toContainText('Project saved:');

  page.once('dialog', (dialog) => dialog.accept('shortcut-copy.json'));
  const saveAsResponse = page.waitForResponse((response) => (
    response.url().endsWith('/api/project')
    && response.request().postDataJSON()?.filename === 'shortcut-copy.json'
  ));
  await page.keyboard.press('Control+Shift+s');
  const response = await saveAsResponse;
  expect(response.ok()).toBe(true);
  expect((await response.json()).filename).toBe('shortcut-copy.json');
});

test('a disconnected save endpoint offers a JSON fallback download', async ({ page }) => {
  await page.goto(server.url);
  await page.route('**/api/project', (route) => route.abort('connectionrefused'));
  await page.evaluate(() => { window.showSaveFilePicker = undefined; });
  page.once('dialog', (dialog) => dialog.accept());
  const currentFilename = (await page.locator('#json-name').innerText()).trim();

  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  expect((await download).suggestedFilename()).toBe(currentFilename);
});
