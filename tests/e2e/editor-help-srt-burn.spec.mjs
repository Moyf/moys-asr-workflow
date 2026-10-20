import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, closeSettingsPanels, disableOnboarding, findFreePort,
  generateWaveformPayload, makeTempDir, openSettingsPage, startServer } from './helpers.mjs';

let dir, server;
test.beforeAll(async () => {
  dir = makeTempDir('help-srt-burn');
  const media = join(dir, 'source.mp4'), project = join(dir, 'project.mosp');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x180:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', media], { timeout: 30_000, windowsHide: true });
  writeFileSync(project, JSON.stringify({ media, waveform: generateWaveformPayload(3000),
    segments: [{ id: 'main-1', start: 100, end: 2500, text: 'HELLO' }] }), 'utf8');
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(dir); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
  await page.goto(server.url);
  await expect(page.locator('.cue[data-idx="0"] .text')).toBeVisible();
});

test('concise help entrances keep source panels open and translate without overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [settings, button, tab] of [['subtitle-style', '#ass-settings-help', 'ass'],
    ['multi-subtitle', '#multi-subtitle-settings-help', 'multi'], ['export', '#export-settings-help', 'export']]) {
    await openSettingsPage(page, settings);
    const gap = await page.locator(button).evaluate(button => {
      const label = button.previousElementSibling;
      return button.getBoundingClientRect().left - label.getBoundingClientRect().right;
    });
    expect(gap).toBeGreaterThanOrEqual(8);
    await page.locator(tab === 'export' ? '#editor-settings-panel' : '#project-settings-panel')
      .screenshot({ path: testInfo.outputPath(tab + '-help-entry.png'), animations: 'disabled' });
    await page.locator(button).click();
    await expect(page.locator('#help-tab-panel-' + tab)).toBeVisible();
    await expect(page.locator(tab === 'export' ? '#editor-settings-panel' : '#project-settings-panel')).toBeVisible();
    if (tab === 'ass') await page.locator('#help-panel').screenshot({ path: testInfo.outputPath('help-ass.png'), animations: 'disabled' });
    await page.locator('#help-close').click();
    await closeSettingsPanels(page);
  }
  await openSettingsPage(page, 'project-tracks');
  await page.locator('#project-marker-track-toggle').check();
  await closeSettingsPanels(page);
  await page.locator('#markers-manage').click();
  expect(await page.locator('#markers-help').evaluate(button =>
    button.getBoundingClientRect().left - button.previousElementSibling.getBoundingClientRect().right))
    .toBeGreaterThanOrEqual(8);
  await page.locator('#markers-panel').screenshot({ path: testInfo.outputPath('markers-help-entry.png'), animations: 'disabled' });
  await page.locator('#markers-help').click();
  await expect(page.locator('#markers-panel')).toBeVisible();
  await expect(page.locator('#help-tab-panel-markers')).toBeVisible();
  await expect(page.locator('#help-panel')).not.toContainText('多重字幕');
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  for (const key of ['ass', 'multi', 'export', 'markers']) {
    await page.locator('#help-tab-' + key).click();
    expect(await page.locator('#help-tab-panel-' + key).innerText()).not.toMatch(/[\u4e00-\u9fff]/);
  }
  await page.setViewportSize({ width: 800, height: 600 });
  await page.locator('#help-tab-ass').click();
  expect(await page.locator('#help-tab-panel-ass').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.locator('#help-panel').screenshot({ path: testInfo.outputPath('help-ass-en-narrow.png'), animations: 'disabled' });
});

test('right-click and batch wrapping preserve single fade markers with undo', async ({ page }) => {
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-mode-toggle').check();
  await closeSettingsPanels(page);
  await page.evaluate(() => {
    MaweSettings.updateEditorSettings({ assSpecialSymbolRule: 'both' });
    MaweBoot.DATA.segments[0].text = '>HELLO<';
    MaweCuePanel.renderAll({ waveform: 'full' });
    MaweContextMenus.showContextMenu(350, 350, 0);
  });
  await page.locator('.word-timing-advanced > .item').hover();
  await page.getByText('左右添加字符', { exact: true }).click();
  await page.locator('#ctxmenu').getByText('放大文本', { exact: true }).click();
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('>++HELLO++<');
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('>HELLO<');
  expect(await page.evaluate(() => MaweSettings.EDITOR_SETTINGS.assMode)).toBe(true);
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  await page.locator('#text-process-wrap-presets-ass button').filter({ hasText: '放大文本' }).click();
  await page.locator('#text-process-confirm').click();
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('>++HELLO++<');
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('>HELLO<');
  await page.evaluate(() => {
    MaweBoot.DATA.segments[0].text = '>>HELLO';
    MaweCuePanel.renderAll({ waveform: 'full' });
    MaweContextMenus.showContextMenu(350, 350, 0);
  });
  await page.locator('.word-timing-advanced > .item').hover();
  await page.getByText('左右添加字符', { exact: true }).click();
  await page.locator('#ctxmenu').getByText('淡出淡入', { exact: true }).click();
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('>>HELLO<<');
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('>>HELLO');
});

test('real editor burns SRT mode through the server job and saves an MP4', async ({ page }) => {
  const requests = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/exports/burned-video/jobs')) requests.push(request.postDataJSON());
  });
  await page.evaluate(() => {
    MaweSettings.updateEditorSettings({ assMode: false });
    window.burnSaved = false;
    window.burnBytes = [];
    window.showSaveFilePicker = async () => ({ name: 'result.mp4', createWritable: async () => ({
      write: async data => { burnBytes.push(...new Uint8Array(data)); },
      close: async () => { burnSaved = true; }, abort: async () => {},
    }) });
  });
  await expect(page.locator('#burn-video-export-btn')).toBeVisible();
  await page.locator('#burn-video-export-btn').click();
  await expect.poll(() => page.evaluate(() => window.burnSaved), { timeout: 45_000 }).toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0].srt).toContain('HELLO');
  expect(requests[0].ass).toBeUndefined();
  expect(await page.evaluate(() => String.fromCharCode(...burnBytes.slice(4, 8)))).toBe('ftyp');
  await expect(page.locator('#burn-video-export-btn')).toBeEnabled();
});
