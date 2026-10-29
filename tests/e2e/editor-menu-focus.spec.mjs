import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPortableBlankEditor, disableOnboarding, generateWav } from './helpers.mjs';

// Static current-source fixture: no persistent server, no root portable rewrite.
let pageUrl, mediaPath;
test.beforeAll(() => {
  const directory = join(process.cwd(), '.artifacts', 'editor-menu-focus', 'fixture');
  mkdirSync(directory, { recursive: true });
  mediaPath = generateWav(join(directory, 'test.wav'), 20);
  pageUrl = pathToFileURL(buildPortableBlankEditor(join(directory, 'editor.html'))).href;
});
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(pageUrl);
  await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
});

for (const menuId of ['extra-otio-menu', 'gap-removed-otio-menu']) {
  for (const language of ['zh', 'en']) {
    test(`${menuId} settings button has left and right breathing room (${language})`, async ({ page }, testInfo) => {
      await page.evaluate(({menuId, language}) => {
        MAWE_I18N.applyLanguage(language);
        if (menuId === 'gap-removed-otio-menu') {
          AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.push({id: 'test', start: 0, end: 1000, text: 'Test'});
          MaweBoot.DATA.gap_remove = {gaps: [{start: 100, end: 300}], enabled: true};
          document.getElementById('gap-removed-export-dropdown').hidden = false;
        }
      }, {menuId, language});
      const button = menuId.startsWith('extra') ? '#extra-export-btn' : '#gap-removed-export-btn';
      await page.locator(button).click();
      await page.locator(`[aria-controls="${menuId}"]`).hover();
      await expect(page.locator(`#${menuId}`)).toBeVisible();
      const gaps = await page.locator(`#${menuId}`).evaluate(menu => {
        const rect = menu.getBoundingClientRect();
        const item = menu.querySelector('[data-settings-target="export-otio-options"]');
        const itemRect = item.getBoundingClientRect();
        return {left: itemRect.left - rect.left, right: rect.right - itemRect.right,
          marginLeft: getComputedStyle(item).marginLeft, marginRight: getComputedStyle(item).marginRight};
      });
      expect(gaps.left).toBeGreaterThanOrEqual(8);
      expect(gaps.right).toBeGreaterThanOrEqual(8);
      await page.locator(`#${menuId}`).screenshot({path: testInfo.outputPath(`${menuId}-${language}.png`)});
      writeFileSync(testInfo.outputPath('menu-spacing.json'), JSON.stringify(gaps, null, 2));
      await testInfo.attach('menu-spacing', {body: JSON.stringify(gaps), contentType: 'application/json'});
    });
  }
}

async function loadMedia(page) {
  // This blank-page fixture tests keyboard routing, not the new-project save
  // checkpoint. Simulate its already-confirmed media selection before import.
  await page.evaluate(() => { MaweProjectMediaInputs.pendingProjectMediaSelection = {}; });
  await page.locator('#load-media-file').setInputFiles(mediaPath);
  await page.waitForFunction(() => document.getElementById('player').readyState >= 2);
  await page.evaluate(() => {
    MaweCoreState.player.pause();
    MaweCoreState.player.currentTime = 0;
    MaweCoreState.player.muted = true;
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.push({id: 'selection-test', start: 0, end: 1000, text: 'Test'});
    MaweCuePanel.renderAll({waveform: 'full'});
    MaweSelection.selectOnly(0);
  });
}

for (const [buttonId, panelId] of [
  ['editor-settings-toggle', 'editor-settings-panel'],
  ['project-settings-toggle', 'project-settings-panel'],
  ['help-toggle', 'help-panel'],
  ['auto-merge-manage', 'auto-merge-panel'],
  ['timed-text-edit-btn', 'timed-text-edit-modal'],
  ['cue-list-settings-toggle', 'cue-list-settings-panel'],
  ['waveform-settings-toggle', 'waveform-settings-panel'],
  ['cue-editor-settings-toggle', 'cue-editor-settings-panel'],
]) {
  test(`Escape releases ${buttonId} so Space toggles playback rather than reopening`, async ({ page }, testInfo) => {
    await loadMedia(page);
    const button = page.locator(`#${buttonId}`);
    await button.focus();
    await page.keyboard.press('Enter');
    const panel = page.locator(`#${panelId}`);
    await expect(panel).toBeVisible();
    const input = panel.locator('input:not([type="hidden"]), select, textarea').filter({visible: true}).first();
    if (await input.count()) await input.focus();
    await page.keyboard.press('Escape');
    await expect(panel).not.toBeVisible();
    await expect(button).not.toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
    expect(await page.evaluate(() => [...MaweSelection.selectedIdxs])).toEqual([0]);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.getElementById('player').paused);
    await expect(panel).not.toBeVisible();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.getElementById('player').paused);
    if (buttonId === 'editor-settings-toggle') {
      await page.locator('#editor-settings-toggle').screenshot({path: testInfo.outputPath('settings-after-escape.png')});
    }
  });
}

test('OTIO menu keyboard navigation works but Escape does not restore its toolbar button', async ({ page }) => {
  await loadMedia(page);
  await page.locator('#extra-export-btn').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#download-fcp7-export')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#download-otio')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#extra-export-dropdown')).not.toHaveClass(/open/);
  await expect(page.locator('#extra-export-btn')).not.toBeFocused();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !document.getElementById('player').paused);
  await expect(page.locator('#extra-export-dropdown')).not.toHaveClass(/open/);
});

test('Space still activates a deliberately keyboard-focused button inside an open window', async ({ page }) => {
  await loadMedia(page);
  await page.locator('#editor-settings-toggle').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#editor-settings-panel')).toBeVisible();
  await page.locator('#editor-settings-close').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#editor-settings-panel')).not.toBeVisible();
  expect(await page.evaluate(() => MaweCoreState.player.paused)).toBe(true);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !document.getElementById('player').paused);
});
