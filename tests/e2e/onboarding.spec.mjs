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
  await expect(page.locator('#onboarding-description')).toHaveText('双击字幕列表中的字幕，光标会自动放置在点击位置，按 Enter 即可拆分。');
  await expect(page.locator('#onboarding-description kbd')).toHaveText('Enter');

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
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);
  await expect(page.locator('#onboarding-title')).toHaveText('完成！');
  await expect(page.locator('#onboarding-description')).toHaveText('已掌握基础操作。可以在右上角的【🤔 帮助】中随时查看。');
  await expect(page.locator('#onboarding-extra-tips')).toContainText('你也可以右键点击字幕后选择拆分');
  await expect(page.locator('#onboarding-extra-tips')).toContainText('鼠标在波形区时，可以右键拆分，也可以按B在鼠标位置拆分');
  await expect(page.locator('#onboarding-extra-tips')).toContainText('编辑字幕时，也可以选择用 Enter 直接拆分——在设置中可修改按键');
  await page.locator('#onboarding-split-settings').click();
  await expect(page.locator('#editor-settings-panel')).toBeVisible();
  await expect(layer).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('moy.asr.editor.onboarding.v1'))).toBe('completed');
});

test('quick start can be skipped and replayed from Help', async ({ page }) => {
  await page.goto(server.url);
  await expect(page.locator('#onboarding-skip')).toHaveText('跳过 (ESC)');
  await page.keyboard.press('Escape');
  await expect(page.locator('#onboarding-layer')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('moy.asr.editor.onboarding.v1'))).toBe('skipped');

  await page.locator('#help-toggle').click();
  expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('help-toggle');
  const helpPanel = page.locator('#help-panel');
  await expect(helpPanel).toHaveClass(/show/);
  await expect(helpPanel.getByRole('tab')).toHaveText(['基础操作', '快捷操作', '波形区', '播放与导航']);
  await expect(helpPanel.getByRole('tab').first()).toHaveCSS('font-size', '13px');
  await expect(helpPanel.locator('#help-advanced-toggle')).toHaveText('进阶');
  await expect(helpPanel.locator('#help-advanced-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(helpPanel.locator('#help-advanced-tabs')).toBeHidden();
  await expect(helpPanel.getByRole('tab', { name: '基础操作' })).toHaveAttribute('aria-selected', 'true');
  const basicPanel = helpPanel.locator('#help-tab-panel-basic');
  await expect(basicPanel).toHaveCSS('font-size', '13px');
  await expect(basicPanel.locator('.help-subtitle')).toHaveText(['鼠标操作', '编辑', '字幕操作']);
  await expect(basicPanel.locator('h5.help-subtitle').filter({ hasText: '选择操作' })).toHaveCount(0);
  await expect(basicPanel.locator('h5.help-subtitle').filter({ hasText: '字幕列表' })).toHaveCount(0);
  await expect(basicPanel.locator('kbd').first()).toHaveCSS('font-size', '13px');
  await expect(basicPanel.locator('.help-wasd')).toHaveCount(1);
  await expect(basicPanel.locator('.help-tip-callout')).toContainText('其实就是用 WASD 啦，从字幕列表看是上下跳，从波形区看是左右跳 😝');
  await expect(basicPanel.locator('.help-tip-callout')).toHaveCSS('margin-top', '8px');
  await expect(basicPanel.locator('.help-tip-text')).toHaveCSS('font-size', '12px');
  await expect(basicPanel).toContainText('Ctrl+Z');
  await expect(basicPanel).toContainText('Ctrl+Shift+Z');
  await expect(basicPanel).toContainText('WASD');
  await expect(basicPanel).toContainText('Ctrl+Shift+A/D');
  await helpPanel.getByRole('tab', { name: '快捷操作', exact: true }).click();
  const shortcutsPanel = helpPanel.locator('#help-tab-panel-shortcuts');
  await expect(shortcutsPanel).toBeVisible();
  await expect(shortcutsPanel.locator('.help-subtitle')).toHaveText(['编辑操作', '快捷功能', '切换工具']);
  await expect(shortcutsPanel).toContainText('B');
  await expect(shortcutsPanel).toContainText('1~5');
  await expect(shortcutsPanel).toContainText('选择工具');
  await expect(helpPanel.locator('#help-tab-panel-waveform')).toBeHidden();
  await helpPanel.getByRole('tab', { name: '波形区', exact: true }).click();
  const waveformPanel = helpPanel.locator('#help-tab-panel-waveform');
  await expect(waveformPanel).toBeVisible();
  await expect(helpPanel.getByRole('tab', { name: '波形区', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(waveformPanel.locator('.help-subtitle')).toHaveText(['空白波形区', '波形区字幕操作']);
  await expect(waveformPanel).toContainText('按当前时间基准拆分字幕');
  await expect(waveformPanel).not.toContainText('红色播放指针');
  await expect(waveformPanel.locator('.help-important').filter({ hasText: 'Shift+拖拽空白处' })).toHaveCount(1);
  await expect(waveformPanel.locator('.help-important').filter({ hasText: '绑定到主副字幕（自动匹配）' })).toHaveCount(1);
  await expect(waveformPanel.locator('.help-important').filter({ hasText: '将选中的副字幕的时长对齐到绑定主字幕' })).toHaveCount(1);
  await helpPanel.locator('#help-advanced-toggle').click();
  await expect(helpPanel.locator('#help-advanced-tabs')).toBeVisible();
  await expect(helpPanel.locator('#help-advanced-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(helpPanel.getByRole('tab')).toHaveText(['基础操作', '快捷操作', '波形区', '播放与导航', '微调字幕', '空隙操作', '批量操作']);
  await helpPanel.getByRole('tab', { name: '微调字幕', exact: true }).click();
  const fineTuningPanel = helpPanel.locator('#help-tab-panel-fine-tuning');
  await expect(fineTuningPanel).toBeVisible();
  await expect(fineTuningPanel.locator('.help-title')).toHaveText(['微调字幕']);
  await expect(fineTuningPanel.locator('.help-subtitle')).toHaveText(['选中字幕', '按住字幕']);
  await expect(fineTuningPanel).toContainText('无选中时作用于鼠标所在字幕');
  await expect(fineTuningPanel.locator('#help-open-waveform-keyboard-settings')).toHaveText('⚙️设置');
  await helpPanel.getByRole('tab', { name: '空隙操作', exact: true }).click();
  const gapPanel = helpPanel.locator('#help-tab-panel-gap');
  await expect(gapPanel).toBeVisible();
  await expect(gapPanel.locator('.help-title')).toHaveText(['空隙操作']);
  await expect(gapPanel.locator('.help-subgroup')).toHaveCount(4);
  await expect(gapPanel.locator('.help-subtitle')).toHaveText(['空隙状态', '移动与调整', '清理空隙', '批量操作']);
  await expect(helpPanel.locator('.help-title')).toHaveText(['基础操作', '快捷操作', '波形区操作', '多重字幕', '波形外观调整', '微调字幕', '空隙操作', '批量操作', '播放与导航']);
  await expect(helpPanel).toContainText('波形区字幕操作');
  await expect(helpPanel).toContainText('波形外观调整');
  await expect(helpPanel).toContainText('空隙操作');
  await expect(helpPanel).toContainText('切换空隙的启用/禁用状态');
  await expect(helpPanel).toContainText('添加新的移除空隙');
  await expect(helpPanel).toContainText('（也可以在右键中选择「添加空隙」）');
  await expect(helpPanel).toContainText('Alt+左键拖动');
  await expect(helpPanel).toContainText('移动与调整');
  await expect(helpPanel).toContainText('批量操作');
  await expect(helpPanel).toContainText('右侧显示可禁用数量');
  await expect(helpPanel).toContainText('在空隙上右键选择「清理空隙」');
  await expect(helpPanel.locator('#help-open-gap-remove-panel')).toHaveText('静音空隙');
  await expect(helpPanel).toContainText('中点击「全部清理」');
  await expect(gapPanel).toContainText('仅在拖动边界模式生效');
  await expect(gapPanel).toContainText('仅在中键拖动模式生效');
  await expect(gapPanel).toContainText('具体操作取决于波形区的');
  await expect(gapPanel.locator('#help-open-gap-settings')).toHaveText('⚙️设置');
  await expect(gapPanel).toContainText('中的「空隙区段操作方式」，其中「边界与中键」可同时使用两套操作。');
  await expect(gapPanel.locator('.help-important').filter({ hasText: 'Alt+左键拖动' })).toHaveCount(1);
  await helpPanel.getByRole('tab', { name: '批量操作', exact: true }).click();
  const batchPanel = helpPanel.locator('#help-tab-panel-batch');
  await expect(batchPanel).toBeVisible();
  await expect(batchPanel.locator('.help-title')).toHaveText(['批量操作']);
  await expect(batchPanel.locator('.help-subtitle')).toHaveText(['字幕列表', '处理范围']);
  await expect(batchPanel).toContainText('批量替换');
  await expect(batchPanel).toContainText('纯文本编辑');
  await expect(batchPanel).toContainText('文本处理');
  await expect(batchPanel).toContainText('仅处理选中的字幕');
  await helpPanel.getByRole('tab', { name: '播放与导航', exact: true }).click();
  const playbackPanel = helpPanel.locator('#help-tab-panel-playback');
  await expect(playbackPanel.locator('.help-subtitle')).toHaveText(['播放', '字幕导航']);
  await expect(playbackPanel).toContainText('播放与导航');
  await expect(playbackPanel).toContainText('无选中时前后跳转（时长：1000ms）');
  await expect(playbackPanel.locator('#help-open-media-settings')).toHaveText('⚙️设置');
  await expect(playbackPanel).toContainText('可在媒体区的');
  await page.locator('#help-onboarding').click();
  await expect(page.locator('#onboarding-layer')).toBeVisible();
  await expect(page.locator('#onboarding-title')).toHaveText('使用 WASD 选择前后字幕——就像游戏一样！');
});

test('Gap help translates the updated operations in English', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await page.goto(server.url);
  await page.locator('#help-toggle').click();
  await page.locator('#help-advanced-toggle').click();
  await page.getByRole('tab', { name: 'Gap operations', exact: true }).click();

  const gapHelp = page.locator('#help-tab-panel-gap');
  await expect(gapHelp.locator('.help-subtitle')).toHaveText(['Gap states', 'Movement and adjustment', 'Clear gap', 'Batch actions']);
  await expect(gapHelp).toContainText('Alt+left-drag');
  await expect(gapHelp).toContainText('Add a new removed gap');
  await expect(gapHelp).toContainText('Batch actions');
  await expect(gapHelp).toContainText('Right-click a gap and choose “Clear gap” to clear the current gap');
  await expect(gapHelp.locator('#help-open-gap-remove-panel')).toHaveText('Silent gaps');
  await expect(gapHelp).toContainText('”, click “Clear all” to clear all gaps');
  expect(await gapHelp.innerText()).not.toMatch(/[\u3400-\u9fff]/u);
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
