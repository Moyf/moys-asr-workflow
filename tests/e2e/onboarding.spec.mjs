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
  tempDir = makeTempDir('onboarding');
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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const settingsKey = 'moy.asr.editor.settings.v1';
    const saved = JSON.parse(localStorage.getItem(settingsKey) || '{}');
    saved.autoSaveProject = false;
    localStorage.setItem(settingsKey, JSON.stringify(saved));
    localStorage.removeItem('moy.asr.editor.onboarding.v1');
  });
});

test('quick start teaches WASD, real merge with undo, then real split', async ({ page }) => {
  await page.goto(server.url);
  const layer = page.locator('#onboarding-layer');
  await expect(layer).toBeVisible();
  await expect(page.locator('#onboarding-title')).toHaveText('使用 WASD 选择前后字幕——就像游戏一样！');

  await page.keyboard.press('d');
  await page.keyboard.press('d');
  await page.keyboard.press('d');
  await expect(page.locator('#onboarding-primary')).toHaveText('下一步');
  await expect(page.locator('#onboarding-primary')).toBeVisible();

  await page.locator('#onboarding-primary').click();
  await expect(page.locator('#onboarding-title')).toHaveText('Shift + WASD：扩展选择');
  await page.keyboard.press('Shift+d');
  await expect(page.locator('#onboarding-title')).toHaveText('按 C 合并字幕');
  await page.keyboard.press('c');
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(5);
  await expect(page.locator('#onboarding-title')).toHaveText('Ctrl+Z：撤销刚才的合并');

  await page.keyboard.press('Control+Z');
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(6);
  await expect(page.locator('#onboarding-title')).toHaveText('合并已撤销');
  await expect(page.locator('#onboarding-primary')).toHaveText('下一步');
  await page.locator('#onboarding-primary').click();
  await expect(page.locator('#onboarding-title')).toHaveText('最后：在光标处拆分字幕');
  await expect(page.locator('#onboarding-primary')).toBeHidden();
  await expect(page.locator('#onboarding-description')).toContainText('先看一个无风险演示；准备好后可以实际试一次。');

  const targetText = page.locator('.cue[data-idx="0"] .text');
  const splitPoint = await targetText.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 2);
    range.setEnd(node, 3);
    const rect = range.getBoundingClientRect();
    return { x: (rect.left + rect.right) / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.dblclick(splitPoint.x, splitPoint.y);
  await page.waitForFunction(() => {
    const selection = window.getSelection();
    return Boolean(selection?.isCollapsed && selection.anchorOffset > 0 && selection.anchorOffset < 5);
  });
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);
  await expect(page.locator('#onboarding-title')).toHaveText('完成！');
  await expect(page.locator('#onboarding-extra-tips')).toContainText('同样支持使用右键菜单拆分');
  await expect(page.locator('#onboarding-extra-tips')).toContainText('在波形区可以根据音频位置拆分');
  await expect(page.locator('#onboarding-extra-tips')).toContainText('修改编辑时的拆分按键');
  await expect(page.locator('#onboarding-extra-tips')).toContainText('Enter / Ctrl+Enter');
  await page.locator('#onboarding-split-settings').click();
  await expect(page.locator('#editor-settings-panel')).toBeVisible();
  await expect(layer).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('moy.asr.editor.onboarding.v1'))).toBe('completed');
});

test('quick start can be skipped and replayed from Help', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#onboarding-skip').click();
  await expect(page.locator('#onboarding-layer')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('moy.asr.editor.onboarding.v1'))).toBe('skipped');

  await page.locator('#help-toggle').click();
  expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('help-toggle');
  const helpPanel = page.locator('#help-panel');
  await expect(helpPanel).toHaveClass(/show/);
  await expect(helpPanel.locator('.help-title')).toHaveText(['字幕操作', '波形区', '播放与编辑', '波形区（拓展）']);
  await expect(helpPanel).toContainText('波形区字幕操作');
  await expect(helpPanel).toContainText('波形区显示');
  await page.locator('#help-onboarding').click();
  await expect(page.locator('#onboarding-layer')).toBeVisible();
  await expect(page.locator('#onboarding-title')).toHaveText('使用 WASD 选择前后字幕——就像游戏一样！');
});

test('quick start translates dynamically rendered steps in English', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await page.goto(server.url);
  const layer = page.locator('#onboarding-layer');
  const expectEnglish = async () => {
    expect(await layer.innerText()).not.toMatch(/[\u3400-\u9fff]/u);
  };

  await expect(layer).toBeVisible();
  await expectEnglish();
  await page.keyboard.press('d');
  await page.keyboard.press('d');
  await page.keyboard.press('d');
  await expect(page.locator('#onboarding-primary')).toHaveText('Next');

  await page.locator('#onboarding-primary').click();
  await expect(page.locator('#onboarding-title')).toHaveText('Shift + WASD: extend the selection');
  await expectEnglish();

  await page.keyboard.press('Shift+d');
  await expect(page.locator('#onboarding-title')).toHaveText('Press C to merge subtitles');
  await page.keyboard.press('c');
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(5);
  await expect(page.locator('#onboarding-title')).toHaveText('Ctrl+Z: undo the merge you just made');
  await expectEnglish();

  await page.keyboard.press('Control+Z');
  await expect(page.locator('#onboarding-title')).toHaveText('Merge undone');
  await page.locator('#onboarding-primary').click();
  await expect(page.locator('#onboarding-title')).toHaveText('Finally: split a subtitle at the cursor');
  await expectEnglish();
  await expect(page.locator('#onboarding-primary')).toBeHidden();
  await expectEnglish();
  await page.locator('#onboarding-secondary').click();
});
