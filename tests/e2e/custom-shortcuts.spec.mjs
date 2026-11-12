import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { disableOnboarding, cleanupTempDir, findFreePort, generateProjectJson, generateWav, makeTempDir, startServer } from './helpers.mjs';
let tempDir;
let server;
test.beforeAll(async () => {
  tempDir = makeTempDir('custom-shortcuts');
  const media = join(tempDir, 'synthetic.wav');
  const project = join(tempDir, 'project.json');
  generateWav(media, 60);
  generateProjectJson(project);
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-shortcuts').click();
});
const keyButton = (page, id) => page.locator(`[data-shortcut-id="${id}"][data-shortcut-control="key"]`);
async function record(page, id, key) {
  const button = keyButton(page, id);
  if (!await button.evaluate(el => el.closest('details').open)) {
    await page.locator('.shortcut-settings-group').filter({ has: button }).locator('summary').click();
  }
  await button.click();
  await page.keyboard.press(key);
}
async function closeSettings(page) {
  await page.locator('#editor-settings-close').click();
  await page.locator('body').click({ position: { x: 4, y: 4 } });
}
test('records, checks conflicts, cancels, persists and resets with real command dispatch', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await record(page, 'nav-d', 'q');
  await expect(keyButton(page, 'nav-d')).toHaveText('Q');
  await expect(page.locator('.shortcut-settings-row').filter({has: keyButton(page, 'nav-d')})).toHaveClass(/is-customized/);
  await expect(page.locator('.shortcut-settings-row').filter({has: keyButton(page, 'nav-d')}).locator('.shortcut-settings-customized')).toHaveText('已自定义');
  await record(page, 'merge', 'q');
  await expect(page.locator('#shortcuts-status')).toContainText('快捷键冲突');
  await expect(page.locator('#shortcuts-status')).toHaveCSS('color', 'rgb(239, 68, 68)');
  await expect(page.locator('#hint-stack .hint-warning').last()).toContainText('快捷键冲突');
  await expect(page.locator('#hint-stack .hint-warning').last()).toBeVisible();
  await expect.poll(() => page.locator('#hint-stack .hint-warning').last().evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
  await page.screenshot({ path: '/tmp/maw-shortcuts-conflict.png' });
  await page.keyboard.press('Escape');
  await expect(keyButton(page, 'merge')).toHaveText('C');
  await record(page, 'merge', 'Control+l');
  await expect(page.locator('#shortcuts-status')).toContainText('保留');
  await page.keyboard.press('Escape');
  await closeSettings(page);
  await page.evaluate(() => { MaweSelection.selectOnly(0); MaweCoreState.player.pause(); });
  await page.keyboard.press('d');
  expect(await page.evaluate(() => [...MaweSelection.selectedIdxs])).toEqual([0]);
  await page.keyboard.press('q');
  expect(await page.evaluate(() => [...MaweSelection.selectedIdxs])).toEqual([1]);
  await page.reload();
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-shortcuts').click();
  await expect(keyButton(page, 'nav-d')).toHaveText('Q');
  await page.locator('#shortcuts-reset').click();
  await expect(keyButton(page, 'nav-d')).toHaveText('D');
  await expect(page.locator('.shortcut-settings-row').filter({has: keyButton(page, 'nav-d')})).not.toHaveClass(/is-customized/);
  await closeSettings(page);
  await page.evaluate(() => { MaweSelection.selectOnly(0); MaweCoreState.player.pause(); });
  await page.keyboard.press('d');
  expect(await page.evaluate(() => [...MaweSelection.selectedIdxs])).toEqual([1]);
  expect(errors).toEqual([]);
});
test('combination keys, recording isolation, typing, spacing and English settings', async ({ page }) => {
  await record(page, 'nav-d', 'Control+Shift+e');
  await expect(keyButton(page, 'nav-d')).toHaveText(/^(Ctrl|Cmd)\+Shift\+E$/);
  await closeSettings(page);
  await page.evaluate(() => { MaweSelection.selectOnly(0); MaweCoreState.player.pause(); });
  await page.keyboard.press('Control+Shift+e');
  expect(await page.evaluate(() => [...MaweSelection.selectedIdxs])).toEqual([1]);
  await page.locator('#search').fill('');
  await page.locator('#search').press('d');
  await expect(page.locator('#search')).toHaveValue('d');
  await page.locator('#search').fill('');
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-shortcuts').click();
  await keyButton(page, 'play').click();
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => MaweCoreState.player.paused)).toBe(true);
  await expect(page.locator('#editor-settings-page-shortcuts')).toBeVisible();
  const gaps = await page.locator('.shortcut-settings').evaluate(panel => {
    const rects = [...panel.children].map(node => node.getBoundingClientRect());
    return rects.slice(1).map((rect, index) => rect.top - rects[index].bottom);
  });
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(8);
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(page.locator('#editor-settings-tab-shortcuts')).toHaveText('Keyboard shortcuts');
  await expect(keyButton(page, 'play')).toHaveText('Space');
  await expect(page.locator('#shortcuts-reset')).toHaveText('Reset all shortcuts');
  await expect(page.locator('.shortcut-settings-row').filter({ has: keyButton(page, 'color-6') }).locator('.shortcut-settings-label')).toHaveText('Assign color 6');
  await expect(page.locator('.shortcut-settings-row').filter({ has: keyButton(page, 'color-9') }).locator('.shortcut-settings-label')).toHaveText('Assign color 9');
  await page.screenshot({ path: '/tmp/maw-custom-shortcuts-en.png' });
  await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
  await page.screenshot({ path: '/tmp/maw-custom-shortcuts.png' });
});
test('split aliases follow the customized key through real keyboard events', async ({ page }) => {
  await record(page, 'split', 'e');
  await expect(page.locator('#help-shortcut-split-key')).toHaveText('E');
  await expect(page.locator('#help-waveform-split-key')).toHaveText('E');
  await closeSettings(page);
  await page.evaluate(() => {
    window.__splitEvents = [];
    window.addEventListener('keydown', event => {
      if (['e', 'E', 'b', 'B'].includes(event.key)) {
        const mapped = MaweShortcuts.resolveEvent(event);
        window.__splitEvents.push([mapped.key, mapped.ctrlKey, mapped.shiftKey]);
      }
    }, true);
  });
  await page.keyboard.press('e');
  await page.keyboard.press('Shift+e');
  await page.keyboard.press('Control+Shift+e');
  await page.keyboard.press('Shift+b');
  expect(await page.evaluate(() => window.__splitEvents)).toEqual([
    ['b', false, false], ['b', false, true], ['b', true, true], ['Unidentified', false, false],
  ]);
});
test('remapped play key clears its intercepted keyup when modifiers release first', async ({ page }) => {
  await record(page, 'play', 'Shift+p');
  await closeSettings(page);
  await page.keyboard.down('Shift');
  await page.keyboard.down('p');
  await page.keyboard.up('Shift');
  await page.keyboard.up('p');
  expect(await page.evaluate(() => MaweShortcuts.interceptedSpace)).toBe(false);
  await page.keyboard.down('Shift');
  await page.keyboard.down('p');
  await page.keyboard.up('Shift');
  expect(await page.evaluate(() => MaweShortcuts.interceptedSpace)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  expect(await page.evaluate(() => MaweShortcuts.interceptedSpace)).toBe(false);
  await page.keyboard.up('p');
});
test('remapped playback, time adjustment and undo use their domain commands', async ({ page }) => {
  await record(page, 'play', 'Shift+p');
  await record(page, 'seek-ArrowRight', 'e');
  await record(page, 'undo', 'Control+u');
  await closeSettings(page);
  await page.evaluate(() => { MaweSelection.selectOnly(0); MaweCoreState.player.pause(); });
  const before = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].start);
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].start)).toBe(before);
  await page.keyboard.press('e');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].start)).toBe(before + 50);
  await page.keyboard.press('Control+u');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].start)).toBe(before);
  await page.keyboard.press('Shift+p');
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.paused)).toBe(false);
  await page.keyboard.press('Shift+p');
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.paused)).toBe(true);
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => MaweCoreState.player.paused)).toBe(true);
});
const displayedIds = page => page.locator('.shortcut-settings-row').evaluateAll(rows => rows.map(row => row.querySelector('.shortcut-settings-key').dataset.shortcutId));
async function searchByKey(page, key) {
  await page.locator('#shortcuts-key-search').click();
  await page.keyboard.press(key);
}
test('grouped layout uses smaller labels, collapses and preserves expanded groups across filters', async ({ page }) => {
  const groups = page.locator('.shortcut-settings-group');
  await expect(groups).toHaveCount(7);
  expect(await groups.evaluateAll(els => els.filter(el => el.open).map(el => el.dataset.shortcutGroup))).toEqual(['playback', 'navigation', 'timing', 'editing', 'bilingual', 'appearance', 'project']);
  expect(await groups.evaluateAll(els => els.reduce((count, el) => count + el.querySelectorAll('.shortcut-settings-row').length, 0))).toBe(64);
  await expect(page.locator('.shortcut-settings-label').first()).toHaveCSS('font-size', '13px');
  const metrics = await page.locator('[data-shortcut-group="playback"]').evaluate(group => {
    const summary = group.querySelector('summary').getBoundingClientRect();
    const body = group.querySelector('.shortcut-settings-group-body').getBoundingClientRect();
    const rows = [...group.querySelectorAll('.shortcut-settings-row')].map(row => row.getBoundingClientRect());
    return { summaryGap: body.top - summary.bottom, rowGaps: rows.slice(1).map((row, i) => row.top - rows[i].bottom) };
  });
  expect(metrics.summaryGap).toBeGreaterThanOrEqual(8);
  expect(Math.min(...metrics.rowGaps)).toBeGreaterThanOrEqual(8);
  await page.screenshot({ path: '/tmp/maw-shortcuts-grouped.png' });
  await page.locator('[data-shortcut-group="playback"] > summary').click();
  await expect(page.locator('[data-shortcut-group="playback"]')).not.toHaveAttribute('open');
  for (const id of ['timing', 'editing', 'bilingual', 'appearance', 'project']) {
    await page.locator(`[data-shortcut-group="${id}"] > summary`).click();
  }
  await expect(page.locator('[data-shortcut-group="navigation"]')).toHaveAttribute('open');
  await page.locator('#shortcuts-filter').fill('拆分');
  expect(await displayedIds(page)).toEqual(['split']);
  await expect(page.locator('[data-shortcut-group="editing"]')).toHaveAttribute('open');
  await page.locator('#shortcuts-filter-clear').click();
  expect(await groups.evaluateAll(els => els.filter(el => el.open).map(el => el.dataset.shortcutGroup))).toEqual(['navigation']);
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(page.locator('#shortcuts-key-search')).toHaveText('Search by key');
  await page.locator('#shortcuts-filter').fill('split');
  expect(await displayedIds(page)).toEqual(['split']);
});
test('key search matches current chords exactly, cancels safely and never executes a command', async ({ page }) => {
  await searchByKey(page, 'b');
  expect(await displayedIds(page)).toEqual(['split']);
  await expect(page.locator('#shortcuts-filter')).toHaveValue('B');
  await record(page, 'split', 'q');
  await searchByKey(page, 'b');
  await expect(page.locator('#shortcuts-list')).toHaveText('没有匹配的快捷键');
  await searchByKey(page, 'q');
  expect(await displayedIds(page)).toEqual(['split']);
  await searchByKey(page, 'Control+s');
  expect(await displayedIds(page)).toEqual(['save']);
  await searchByKey(page, 'Control+Shift+s');
  expect(await displayedIds(page)).toEqual(['save-as']);
  await page.locator('#shortcuts-key-search').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#shortcuts-key-search')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#editor-settings-page-shortcuts')).toBeVisible();
  expect(await displayedIds(page)).toEqual(['save-as']);
  await searchByKey(page, 'Space');
  expect(await displayedIds(page)).toEqual(['play']);
  expect(await page.evaluate(() => MaweCoreState.player.paused)).toBe(true);
  await page.locator('#shortcuts-filter-clear').click();
  await expect(page.locator('.shortcut-settings-group')).toHaveCount(7);
});
test('only customized or cleared shortcuts show an individual reset button', async ({ page }) => {
  const reset = page.locator('[data-shortcut-control="reset"]');
  await expect(reset).toHaveCount(0);
  await record(page, 'play', 'q');
  await expect(reset).toHaveCount(1);
  await expect(page.locator('[data-shortcut-id="play"][data-shortcut-control="reset"]')).toBeVisible();
  await page.locator('[data-shortcut-id="play"][data-shortcut-control="reset"]').click();
  await expect(reset).toHaveCount(0);
  await expect(keyButton(page, 'play')).toHaveText('Space');
  await expect(page.locator('.shortcut-settings-customized')).toHaveCount(0);
  await page.locator('[data-shortcut-id="play"][data-shortcut-control="clear"]').click();
  await expect(keyButton(page, 'play')).toHaveText('未分配');
  await expect(reset).toHaveCount(1);
  await page.locator('[data-shortcut-id="play"][data-shortcut-control="reset"]').click();
  await expect(reset).toHaveCount(0);
  await expect(keyButton(page, 'play')).toHaveText('Space');
});
