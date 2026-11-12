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
  await record(page, 'nav-d', 'p');
  await expect(keyButton(page, 'nav-d')).toHaveText('P');
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
  await page.keyboard.press('p');
  expect(await page.evaluate(() => [...MaweSelection.selectedIdxs])).toEqual([1]);
  await page.reload();
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-shortcuts').click();
  await expect(keyButton(page, 'nav-d')).toHaveText('P');
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
test('Q split variants and Mac/browser reserved shortcuts are rejected with a visible reason', async ({ page }) => {
  await record(page, 'split', 'q');
  await expect(page.locator('#shortcuts-status')).toContainText('Ctrl+Shift+Q');
  await expect(page.locator('#shortcuts-status')).toContainText('macOS');
  await expect(page.locator('#shortcuts-status')).toContainText('Windows/Linux Chromium');
  await page.keyboard.press('Escape');
  await expect(keyButton(page, 'split')).toHaveText('B');

  await record(page, 'nav-d', 'Control+h');
  await expect(page.locator('#shortcuts-status')).toContainText('保留');
  await expect(page.locator('#shortcuts-status')).toContainText('H');
  await expect(page.locator('#shortcuts-status')).toContainText('历史记录');
  await page.keyboard.press('Escape');
  await expect(keyButton(page, 'nav-d')).toHaveText('D');
});
test('invalid saved split shortcut is discarded with a warning while other shortcuts survive saving', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ split: ['q'], merge: ['b'], play: ['p'] }));
  });
  await page.reload();
  await expect(page.locator('#hint-stack .hint-warning').last()).toContainText('Ctrl+Shift+Q');
  await expect(page.locator('#hint-stack .hint-warning').last()).toContainText('合并选中字幕');
  await expect(page.locator('#hint-stack .hint-warning').last()).toContainText('快捷键冲突');
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-shortcuts').click();
  await expect(keyButton(page, 'split')).toHaveText('B');
  await expect(keyButton(page, 'merge')).toHaveText('C');
  await expect(keyButton(page, 'play')).toHaveText('P');

  await record(page, 'nav-d', 'y');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('moy.asr.editor.shortcuts.v1')));
  expect(saved.play).toEqual(['p']);
  expect(saved['nav-d']).toEqual(['y']);
  expect(saved.split).toBeUndefined();
  expect(saved.merge).toBeUndefined();
});
test('legacy Mod+C cannot consume physical copy or merge selected subtitles', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ merge: ['Mod+c'], play: ['p'] }));
  });
  await page.reload();
  await page.evaluate(() => {
    const segments = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments;
    segments.forEach((segment, index) => { segment.id ||= `legacy-copy-${index}`; });
    MaweCuePanel.renderAll();
    MaweSelection.selectOnly(0);
    MaweSelection.addToSelection(1);
    window.__copyDispatch = [];
    window.__copyDefaultEvents = 0;
    const text = document.querySelector('.cue[data-idx="0"] .text');
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.addEventListener('copy', () => { window.__copyDefaultEvents += 1; });
    window.addEventListener('keydown', event => {
      if (event.key.toLowerCase() !== 'c' || !(event.ctrlKey || event.metaKey)) return;
      const result = { prevented: null };
      window.__copyDispatch.push(result);
      setTimeout(() => { result.prevented = event.defaultPrevented; }, 0);
    }, true);
  });
  const initialSegmentCount = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length);
  const nativeCopyModifier = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');
  const otherCopyModifier = nativeCopyModifier === 'Meta' ? 'Control' : 'Meta';
  await page.keyboard.press(`${nativeCopyModifier}+c`);
  await expect.poll(() => page.evaluate(() => window.__copyDispatch[0]?.prevented)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__copyDefaultEvents)).toBe(1);
  await page.keyboard.press(`${otherCopyModifier}+c`);
  await expect.poll(() => page.evaluate(() => window.__copyDispatch.map(({ prevented }) => prevented))).toEqual([false, false]);
  expect(await page.evaluate(() => window.__copyDispatch.map(({ prevented }) => prevented))).toEqual([false, false]);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(initialSegmentCount);
});
test('legacy Mod+C migration warning is translated in English and keeps other shortcuts', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('mawe.language', 'en');
    localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ merge: ['Mod+c'], play: ['p'] }));
  });
  await page.reload();
  const warning = page.locator('#hint-stack .hint-warning').last();
  const expectedCopyChord = await page.evaluate(() => MaweShortcuts.displayChord('Mod+c'));
  await expect(warning).toContainText('Ignored invalid saved shortcut');
  await expect(warning).toContainText('Merge selected subtitles');
  await expect(warning).toContainText(expectedCopyChord);
  await expect(warning).toContainText('The system copy shortcut must remain available');
  await expect(warning).toContainText('Other valid custom shortcuts were kept');
  await expect(warning).not.toContainText('快捷键');
  expect(await page.evaluate(() => MaweShortcuts.bindings(MaweShortcuts.commands.find(item => item.id === 'play')))).toEqual(['p']);
});
test('English migration warning separates the dynamic reserved chord from its translated reason', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('mawe.language', 'en');
    localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ split: ['q'], play: ['p'] }));
  });
  await page.reload();
  const warning = page.locator('#hint-stack .hint-warning').last();
  const expectedSplitChord = await page.evaluate(() => MaweShortcuts.displayChord('Mod+Shift+q'));
  await expect(warning).toContainText('Ignored invalid saved shortcut');
  await expect(warning).toContainText('Split subtitle');
  await expect(warning).toContainText(expectedSplitChord);
  await expect(warning).toContainText('macOS uses Cmd+Shift+Q to log out');
  await expect(warning).not.toContainText('快捷键');
});
test('remapped save does not leave the old Ctrl/Cmd+S active in a modal', async ({ page }) => {
  await record(page, 'save', 'F2');
  await closeSettings(page);
  const saveUrl = new URL(await page.evaluate(() => MaweBoot.SERVER_CONFIG.saveUrl), server.url).href;
  let saveRequests = 0;
  page.on('request', request => {
    if (request.url() === saveUrl && request.method() === 'POST') saveRequests += 1;
  });
  await page.evaluate(async () => {
    window.__saveKeyEvents = [];
    window.__modalSaveKeyEvents = 0;
    window.addEventListener('keydown', event => {
      if (event.key.toLowerCase() !== 's' || !(event.ctrlKey || event.metaKey)) return;
      const result = { prevented: null };
      window.__saveKeyEvents.push(result);
      setTimeout(() => { result.prevented = event.defaultPrevented; }, 0);
    }, true);
    await MaweTextProcess.openTextProcessModal();
    document.getElementById('text-process-modal').addEventListener('keydown', event => {
      if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) window.__modalSaveKeyEvents += 1;
    });
  });
  await expect(page.locator('#text-process-modal')).toHaveClass(/show/);
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__saveKeyEvents[0]?.prevented)).toBe(true);
  await page.keyboard.press('Meta+s');
  await expect.poll(() => page.evaluate(() => window.__saveKeyEvents.map(({ prevented }) => prevented))).toEqual([true, true]);
  expect(saveRequests).toBe(0);
  expect(await page.evaluate(() => window.__saveKeyEvents.map(({ prevented }) => prevented))).toEqual([true, true]);
  expect(await page.evaluate(() => window.__modalSaveKeyEvents)).toBe(2);
  await expect(page.locator('#text-process-modal')).toHaveClass(/show/);
});
test('default Ctrl+S still saves pending inline text without leaving edit mode', async ({ page }) => {
  await closeSettings(page);
  const saveUrl = new URL(await page.evaluate(() => MaweBoot.SERVER_CONFIG.saveUrl), server.url).href;
  await page.evaluate(() => {
    const cue = document.querySelector('.cue[data-idx="0"]');
    MaweInlineEdit.startEdit(cue, 0);
    MaweInlineEdit.editingState.textEl.innerText = 'Saved by Ctrl S';
  });
  const saveRequest = page.waitForRequest(request => request.url() === saveUrl && request.method() === 'POST');
  await page.keyboard.press('Control+s');
  await saveRequest;
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('Saved by Ctrl S');
  expect(await page.evaluate(() => Boolean(MaweInlineEdit.editingState))).toBe(true);
});
test('saved reverse and play key exchange survives reload and dispatches both commands', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ play: ['j'], reverse: ['p'] }));
  });
  await page.reload();
  const bindings = await page.evaluate(() => ({
    play: MaweShortcuts.bindings(MaweShortcuts.commands.find(item => item.id === 'play')),
    reverse: MaweShortcuts.bindings(MaweShortcuts.commands.find(item => item.id === 'reverse')),
    warnings: MaweShortcuts.takeSavedBindingWarnings(),
    playTarget: MaweShortcuts.resolveEvent(new KeyboardEvent('keydown', { key: 'j' })).key,
    reverseTarget: MaweShortcuts.resolveEvent(new KeyboardEvent('keydown', { key: 'p' })).key,
  }));
  expect(bindings).toEqual({ play: ['j'], reverse: ['p'], warnings: [], playTarget: ' ', reverseTarget: 'j' });
});
test('fixed marker M cannot collide with a saved split shortcut and dispatches only marker editing', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ split: ['m'] }));
  });
  await page.reload();
  await expect(page.locator('#hint-stack .hint-warning').last()).toContainText('切换标记编辑');
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-shortcuts').click();
  await expect(keyButton(page, 'split')).toHaveText('B');
  await closeSettings(page);

  await page.evaluate(() => {
    MaweMarkerEditing.setEditingEnabled(false);
    window.__beforeMarkerKeySegments = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length;
    window.__mResolvedKey = null;
    document.addEventListener('keydown', event => {
      if (event.key.toLowerCase() === 'm') window.__mResolvedKey = MaweShortcuts.resolveEvent(event).key;
    }, true);
  });
  await page.keyboard.press('m');
  expect(await page.evaluate(() => window.__mResolvedKey)).toBe('m');
  expect(await page.evaluate(() => MaweMarkerEditing.isEditingEnabled())).toBe(true);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length))
    .toBe(await page.evaluate(() => window.__beforeMarkerKeySegments));
});
test('split aliases follow the customized key through real keyboard events', async ({ page }) => {
  await record(page, 'split', 'Alt+e');
  await expect(page.locator('#help-shortcut-split-key')).toHaveText('Alt+E');
  await expect(page.locator('#help-waveform-split-key')).toHaveText('Alt+E');
  await closeSettings(page);
  await page.evaluate(() => {
    window.__splitEvents = [];
    window.addEventListener('keydown', event => {
      if (['e', 'E', 'b', 'B'].includes(event.key)) {
        const mapped = MaweShortcuts.resolveEvent(event);
      window.__splitEvents.push([mapped.key, mapped.ctrlKey, mapped.shiftKey, mapped.altKey]);
      }
    }, true);
  });
  await page.keyboard.press('Alt+e');
  await page.keyboard.press('Alt+Shift+e');
  await page.keyboard.press('Control+Alt+Shift+e');
  await page.keyboard.press('Shift+b');
  expect(await page.evaluate(() => window.__splitEvents)).toEqual([
    ['b', false, false, false], ['b', false, true, false], ['b', true, true, false], ['Unidentified', false, false, false],
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
  await searchByKey(page, 'Shift+b');
  expect(await displayedIds(page)).toEqual(['split']);
  await record(page, 'split', 'Alt+e');
  await searchByKey(page, 'b');
  await expect(page.locator('#shortcuts-list')).toHaveText('没有匹配的快捷键');
  await searchByKey(page, 'Alt+Shift+e');
  expect(await displayedIds(page)).toEqual(['split']);
  await searchByKey(page, 'Control+Alt+Shift+e');
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
  await record(page, 'play', 'e');
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
