import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir,
  disableOnboarding,
  DURATION_MS,
  findFreePort,
  generateProjectJson,
  generateWav,
  makeTempDir,
  startServer, closeSettingsPanels, openSettingsPage } from './helpers.mjs';

let tempDir;
let server;
let projectPath;

test.beforeAll(async () => {
  tempDir = makeTempDir('editor-i18n-save');
  const mediaPath = join(tempDir, 'synthetic.wav');
  projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  generateProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test('English markers panel translates controls and preserves project names', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await page.goto(server.url);
  await page.locator('#markers-manage').click();
  await expect(page.locator('#markers-panel-title')).toHaveText('Markers and regions');
  await expect(page.locator('#markers-add-current')).toHaveText('Add marker at playhead');
  await page.evaluate(() => MaweMarkerEditing.addMarkerAt(500, { name: '删除' }));
  await expect(page.locator('.markers-item-title')).toHaveText('删除');
  await expect(page.locator('.waveform-marker-label').first()).toHaveText('删除');
  await expect(page.locator('#markers-summary')).toHaveText('Total 1: markers 1 · regions 0');
  await page.locator('.markers-item-edit').click();
  await expect(page.locator('.markers-color-swatches button').first()).toHaveAttribute('aria-label', 'Use color Blue');
  await expect(page.locator('.markers-item-actions button').filter({ hasText: 'Seek and listen' })).toBeVisible();
  await expect(page.locator('#markers-search')).toHaveAttribute('placeholder', 'Search names or notes');
  await page.screenshot({ path: test.info().outputPath('markers-english.png') });
});

test('English waveform and sticker names preserve project text', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(`${server.url}?lang=en`);
  await page.evaluate(() => {
    const segment = MaweBoot.DATA.segments[0];
    segment.text = '删除';
    segment.items = [];
    segment.sticker = { name: '保存', path: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/%3E' };
    MaweBoot.DATA.segments[1].sticker_ref = { headIdx: 0, name: '保存' };
    MaweCuePanel.renderAll({ waveform: 'full' });
  });
  await expect(page.locator('.waveform-cue-block[data-idx="0"] .waveform-cue-label').first()).toHaveText('删除');
  const row = page.locator('.cue[data-idx="0"]');
  await expect(row.locator('.sname')).toHaveText('保存');
  await expect(row.locator('.sticker-slot img')).toHaveAttribute('title', '保存');
  const reference = page.locator('.cue[data-idx="1"] .sref');
  await expect(reference).toHaveText('↑ 保存');
  await expect(reference).toHaveAttribute('title', 'Inherits the sticker of subtitle 1');
  await row.locator('.sticker-slot img').click();
  await expect(page.locator('#sticker-preview-name')).toHaveText('保存');
  await page.evaluate(() => {
    window.MAWE_I18N.applyLanguage('zh');
    window.MAWE_I18N.applyLanguage('en');
  });
  await expect(page.locator('#sticker-preview-name')).toHaveText('保存');
  await expect(row.locator('.sname')).toHaveText('保存');
  await page.screenshot({ path: test.info().outputPath('literal-sticker-name.png') });
});

test('English overlay subtitles and the editing panel preserve literal input', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(`${server.url}?lang=en`);
  await page.evaluate(() => {
    MaweBoot.DATA.overlay_track = { enabled: true, segments: [
      { id: 'literal-overlay', start: 1000, end: 3000, text: '删除', items: [] },
    ] };
    MaweCuePanel.renderAll({ waveform: 'full' });
  });
  const text = page.locator('.overlay-track-cue .text').first();
  await expect(text).toHaveText('删除');
  await text.click();
  const panel = page.locator('#cue-panel-text');
  await panel.fill('');
  await page.keyboard.insertText('甲');
  expect(await panel.evaluate((element) => element.selectionStart)).toBe(1);
  await page.keyboard.insertText('乙');
  await expect(panel).toHaveValue('甲乙');
  await expect(text).toHaveText('甲乙');
});

test('English timed-text differences preserve literal subtitle content', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(`${server.url}?lang=en`);
  await page.evaluate(() => {
    MaweBoot.DATA.segments[0].text = '删除';
    MaweBoot.DATA.segments[0].items = [];
    MaweCuePanel.renderAll({ waveform: 'full' });
  });
  await page.locator('#batch-operations-btn').click();
  await page.locator('#timed-text-edit-btn').click();
  await page.locator('#timed-text-edit-rows textarea').first().fill('保存');
  const row = page.locator('.timed-text-edit-row[data-index="0"]');
  await expect(row.locator('.timed-text-edit-diff-part').filter({ hasText: '删除' }).first()).toHaveText('删除');
  await expect(row.locator('.timed-text-edit-diff-part').filter({ hasText: '保存' }).first()).toHaveText('保存');
  await expect(row.locator('.timed-text-edit-diff-label').first()).toHaveText('Before:');
  await page.screenshot({ path: test.info().outputPath('literal-diff.png') });
});

test('English split preview preserves both subtitle halves', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(`${server.url}?lang=en`);
  await page.evaluate(() => {
    MaweBoot.DATA.segments[0].text = '删除保存';
    MaweSettings.EDITOR_SETTINGS.mainSplitModeOverride = 'continuous';
    MaweBoot.DATA.segments[0].items = [];
    MaweCuePanel.renderAll({ waveform: 'full' });
    MaweSplitCore.openMainWaveformSplitModal(0, 4000);
  });
  await expect(page.locator('.multi-subtitle-split-preview-left').first()).toHaveText('删除');
  await expect(page.locator('.multi-subtitle-split-preview-right').first()).toHaveText('保存');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.screenshot({ path: test.info().outputPath('literal-split-preview.png') });
  await page.evaluate(() => {
    MaweBoot.DATA.segments[0].text = '主副无';
    MaweSplitCore.openMainWaveformSplitModal(0, 4000);
  });
  await expect(page.locator('#multi-subtitle-split-main-text .multi-subtitle-split-char'))
    .toHaveText(['主', '副', '无']);
});

test('English locale covers the editor shell and recent-project setting stays first', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await page.goto(server.url);

  await expect(page.locator('#open-project')).toHaveText('Open project');
  await expect(page.locator('#save-project')).toHaveText('Save project');
  await expect(page.locator('#recent-projects-toggle')).toHaveText('Recent projects');
  await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Filter subtitles…');
  await expect(page.locator('#cue-panel-text')).toHaveAttribute('placeholder', 'Select a subtitle to start editing…');
  await page.locator('#recent-projects-toggle').click();
  await expect(page.locator('#server-project-settings')).toContainText('Automatically open last project');

  const firstMenuControl = await page.locator('#recent-projects-menu')
    .evaluate((menu) => menu.querySelector('input, .dropdown-item')?.id);
  expect(firstMenuControl).toBe('server-project-settings');
  await page.locator('#recent-projects-toggle').click();

  await page.locator('#editor-settings-toggle').click();
  await expect(page.locator('#editor-settings-tab-interface')).toHaveText('Interface');
  await expect(page.locator('[data-editor-theme="light"]')).toHaveText('Light mode');
  await expect(page.locator('[data-editor-theme="dark"]')).toHaveText('Dark mode');
  await expect(page.locator('[data-editor-theme="system"]')).toHaveText('Follow System');
  await expect(page.locator('[data-editor-accent="blue"]')).toHaveText('Blue');
  await expect(page.locator('[data-editor-accent="red"]')).toHaveText('Red');
  await expect(page.locator('[data-editor-accent="orange"]')).toHaveText('Orange');
  await expect(page.locator('[data-editor-accent="custom"]')).toHaveText('Custom');
  await expect(page.locator('#editor-settings-page-interface')).toContainText('Accent Color');
  await expect(page.locator('#language-toggle')).toHaveText('🌐中文');
  const shellText = await page.locator('body').innerText();
  const untranslatedShellLines = shellText.split('\n')
    .map((line) => line.trim())
    .filter((line) => /[\u3400-\u9fff]/u.test(line) && line !== '🌐中文');
  expect(untranslatedShellLines).toEqual([]);
  const untranslatedUiStrings = await page.evaluate(() => {
    const skip = '.cue .text, .multi-cue-column .text, #cue-panel-text, #overlay, #sticker-overlay-layer, #media-name, #json-name, #sticker-grid, #language-toggle, script, style';
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

  // Sticky 工具栏在部分 Chromium 版本中会被 actionability 检测误判为拦截层；
  // DOM 命中点仍在字幕行，强制派发右键只验证菜单行为。
  await page.locator('.cue').first().click({ button: 'right', force: true });
  expect(await page.locator('#ctxmenu').innerText()).not.toMatch(/[\u3400-\u9fff]/u);
  await page.keyboard.press('Escape');

  await page.locator('#editor-settings-toggle').click();
  await openSettingsPage(page, 'interface');
  await page.locator('#language-toggle').click();
  await expect(page.locator('#save-project')).toHaveText('保存工程');
  await expect(page.locator('#search')).toHaveAttribute('placeholder', '过滤字幕…');
  await expect(page.locator('#cue-panel-text')).toHaveAttribute('placeholder', '选择一条字幕开始编辑…');
  expect(await page.evaluate(() => localStorage.getItem('mawe.language'))).toBe('zh');
});

test('Interface settings supports light, dark, and system themes', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#editor-settings-toggle').click();

  await expect(page.locator('#editor-settings-tab-interface')).toHaveClass(/active/);
  await expect(page.locator('[data-editor-theme="dark"]')).toHaveAttribute('aria-pressed', 'true');
  const themeStyles = await page.evaluate(() => {
    const active = getComputedStyle(document.querySelector('[data-editor-theme="dark"]'));
    const inactive = getComputedStyle(document.querySelector('[data-editor-theme="light"]'));
    return { activeBackground: active.backgroundColor, inactiveBackground: inactive.backgroundColor };
  });
  expect(themeStyles.activeBackground).not.toBe(themeStyles.inactiveBackground);

  await page.locator('[data-editor-theme="light"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('[data-editor-theme="light"]')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('[data-editor-theme="system"]').click();
  await expect(page.locator('[data-editor-theme="system"]')).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'light');
});

test('Interface settings applies preset and custom accent colors', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#editor-settings-toggle').click();

  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  const blueBackground = await page.locator('[data-editor-accent="blue"]')
    .evaluate((element) => getComputedStyle(element).backgroundColor);

  await page.locator('[data-editor-accent="red"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'red');
  await expect(page.locator('[data-editor-accent="red"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveCSS('--accent', '#c25656');
  const redBackground = await page.locator('[data-editor-accent="red"]')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(redBackground).not.toBe(blueBackground);

  await page.locator('[data-editor-theme="light"]').click();
  await page.locator('[data-editor-accent="orange"]').click();
  await expect(page.locator('html')).toHaveCSS('--accent', '#d9834a');
  await page.locator('[data-editor-accent="custom"]').click();
  await expect(page.locator('#editor-accent-custom-field')).toBeVisible();
  await page.locator('#editor-accent-custom').evaluate((input) => {
    input.value = '#25a7db';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const duringDrag = await page.evaluate(() => JSON.parse(localStorage.getItem('moy.asr.editor.settings.v1') || '{}'));
  expect(duringDrag.accentColorCustom).not.toBe('#25a7db');
  await page.locator('#editor-accent-custom').evaluate((input) => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom');
  await expect(page.locator('#editor-accent-custom-value')).toHaveText('#25a7db');
  await expect(page.locator('[data-editor-accent="custom"]')).toHaveAttribute('aria-pressed', 'true');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('moy.asr.editor.settings.v1') || '{}'));
  expect(stored.accentColor).toBe('custom');
  expect(stored.accentColorCustom).toBe('#25a7db');
});

test('GUI launch language overrides the saved editor language once and persists it', async ({ page }) => {
  await page.goto(server.url);
  await page.evaluate(() => localStorage.setItem('mawe.language', 'zh'));
  await page.goto(`${server.url}?lang=en`);

  await expect(page.locator('#save-project')).toHaveText('Save project');
  expect(await page.evaluate(() => localStorage.getItem('mawe.language'))).toBe('en');
  expect(new URL(page.url()).searchParams.has('lang')).toBe(false);

  await page.reload();
  await expect(page.locator('#save-project')).toHaveText('Save project');
});

test('Ctrl+S saves and Ctrl+Shift+S invokes save as', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mawe.language', 'en');
    window.__saveAsCapture = null;
    window.showSaveFilePicker = async (options) => ({
      name: options.suggestedName,
      async createWritable() {
        return {
          async write(blob) {
            window.__saveAsCapture = {
              suggestedName: options.suggestedName,
              content: await blob.text(),
            };
          },
          async close() {},
        };
      },
    });
  });
  await page.goto(server.url);

  const saveResponse = page.waitForResponse((response) => (
    response.url().endsWith('/api/project') && response.request().method() === 'POST'
  ));
  await page.keyboard.press('Control+s');
  expect((await saveResponse).ok()).toBe(true);
  await expect(page.locator('.hint-card').last()).toContainText('Saved!');
  await expect(page.locator('.hint-card').last()).toHaveClass(/hint-success/);

  await page.keyboard.press('Control+Shift+s');
  await expect.poll(() => page.evaluate(() => window.__saveAsCapture)).not.toBeNull();
  const saveAsCapture = await page.evaluate(() => window.__saveAsCapture);
  expect(saveAsCapture.suggestedName).toBe('project.mosp');
  expect(JSON.parse(saveAsCapture.content).segments).toHaveLength(6);
});

test('validation save error previews the item and jumps to its subtitle', async ({ page }) => {
  await page.goto(server.url);
  await page.route('**/api/project', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: '$.segments[1].items[1].start: must be >= previous item end',
      }),
    });
  });

  await page.keyboard.press('Control+s');
  const hint = page.locator('.hint-project-error');
  await expect(hint).toContainText('$.segments[1].items[1].start: must be >= previous item end');
  await expect(hint.locator('.hint-project-preview-value')).toHaveText('vo');
  await expect(hint.locator('.hint-project-action')).toHaveText('定位到第 2 条字幕');

  await hint.locator('.hint-project-action').click();
  await expect(page.locator('.cue[data-idx="1"]')).toHaveClass(/selected/);
  await expect(page.locator('#cue-panel-text')).toHaveValue('Bravo');
});

test('small subtitle-segment overlap can be auto-repaired and saved again', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  let saveAttempts = 0;
  await page.route('**/api/project', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    saveAttempts += 1;
    if (saveAttempts === 1) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: '$.segments[1].start: must be >= previous segment end',
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.evaluate(() => {
    // 重叠修复 UX 针对毫秒时间基准；帧模式下 1ms 会被对齐到帧抹平。
    MaweBoot.DATA.timebase = { unit: 'milliseconds', fps: 30 };
    MaweBoot.DATA.segments[0].end = MaweBoot.DATA.segments[1].start + 1;
    MaweBoot.DATA.segments[0]._dirty = true;
    MaweCuePanel.renderAll({ waveform: 'overlay' });
  });
  await page.keyboard.press('Control+s');
  const hint = page.locator('.hint-project-error');
  await expect(hint.locator('.hint-project-conflict')).toContainText('重叠 1ms');
  await expect(hint.locator('.hint-project-repair-auto')).toContainText('自动修复');

  const retry = page.waitForResponse((response) => (
    response.url().endsWith('/api/project') && response.request().method() === 'POST'
  ));
  await hint.locator('.hint-project-repair-auto').click();
  expect((await retry).ok()).toBe(true);
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments[1].start)).toBe(50001);
  await expect(page.locator('.hint-card').last()).toContainText('保存成功！');
  expect(saveAttempts).toBe(2);
});

test('larger subtitle-segment overlap requires an explicit repair direction', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.route('**/api/project', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: '$.segments[1].start: must be >= previous segment end',
      }),
    });
  });
  await page.evaluate(() => {
    // 同上：钉住毫秒时间基准，避免对齐到帧改写时间边界。
    MaweBoot.DATA.timebase = { unit: 'milliseconds', fps: 30 };
    MaweBoot.DATA.segments[0].end = MaweBoot.DATA.segments[1].start + 2000;
    MaweBoot.DATA.segments[0]._dirty = true;
    MaweCuePanel.renderAll({ waveform: 'overlay' });
  });

  await page.keyboard.press('Control+s');
  const hint = page.locator('.hint-project-error');
  await expect(hint.locator('.hint-project-conflict')).toContainText('重叠 2000ms');
  await expect(hint.locator('.hint-project-repair-trim')).toHaveText('缩短前一句');
  await expect(hint.locator('.hint-project-repair-shift')).toHaveText('推迟后一句');
});

test('auto-saves a text edit shortly after it loses focus', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('.cue').first().click();

  const saveResponse = page.waitForResponse((response) => (
    response.url().endsWith('/api/project') && response.request().method() === 'POST'
  ));
  const panelText = page.locator('#cue-panel-text');
  await panelText.fill('Alpha autosaved');
  await page.locator('#cue-panel-target').click();

  expect((await saveResponse).ok()).toBe(true);
  const savedProject = JSON.parse(readFileSync(projectPath, 'utf8'));
  expect(savedProject.segments[0].text).toBe('Alpha autosaved');
});

test('a disconnected save endpoint offers a JSON fallback download', async ({ page }) => {
  await page.goto(server.url);
  await page.route('**/api/project', (route) => route.abort('connectionrefused'));
  await page.evaluate(() => { window.showSaveFilePicker = undefined; });
  page.once('dialog', (dialog) => dialog.accept());
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  expect((await download).suggestedFilename()).toBe('project.mosp');
});

test('shows a persistent warning when the server connection is lost and clears after recovery', async ({ page }) => {
  await page.route('**/api/startup-status', (route) => route.abort('connectionrefused'));
  await page.goto(server.url);

  const banner = page.locator('#server-connection-banner');
  await expect(banner).toBeVisible({ timeout: 7000 });
  await expect(banner).toContainText('服务器连接已断开');
  await expect(banner).toContainText('请在 Launcher 中确认服务器状态；当前无法自动保存工程');

  await page.unroute('**/api/startup-status');
  await expect(banner).toBeHidden({ timeout: 7000 });
});
