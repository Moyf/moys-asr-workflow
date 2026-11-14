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
test('records, checks conflicts, cancels, persists and resets with real command dispatch', async ({ page }, testInfo) => {
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
  await page.screenshot({ path: testInfo.outputPath('maw-shortcuts-conflict.png') });
  await page.keyboard.press('Escape');
  await expect(keyButton(page, 'merge')).toHaveText('C');
  await record(page, 'merge', 'Control+l');
  await expect(page.locator('#shortcuts-status')).toContainText('可能被系统或浏览器截获');
  await expect(keyButton(page, 'merge')).toHaveText(/^(Ctrl|Cmd)\+L$/);
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
test('combination keys, recording isolation, typing, spacing and English settings', async ({ page }, testInfo) => {
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
  await page.screenshot({ path: testInfo.outputPath('maw-custom-shortcuts-en.png') });
  await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
  await page.screenshot({ path: testInfo.outputPath('maw-custom-shortcuts.png') });
});
test('fixed Q conflicts stay protected while system shortcuts are allowed', async ({ page }) => {
  await record(page, 'split', 'q');
  await expect(page.locator('#shortcuts-status')).toContainText('快捷键冲突');
  await expect(page.locator('#shortcuts-status')).toContainText('字词时间码');
  await page.keyboard.press('Escape');
  await expect(keyButton(page, 'split')).toHaveText('B');
  await record(page, 'nav-d', 'Control+h');
  await expect(page.locator('#shortcuts-status')).toContainText('可能被系统或浏览器截获');
  await expect(keyButton(page, 'nav-d')).toHaveText(/^(Ctrl|Cmd)\+H$/);
});
test('invalid saved split shortcut is discarded with a warning while other shortcuts survive saving', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ split: ['q'], merge: ['b'], play: ['p'] }));
  });
  await page.reload();
  await expect(page.locator('#hint-stack .hint-warning').last()).toContainText('字词时间码');
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
test('saved Mod+C is discarded while unrelated bindings survive', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ merge: ['Mod+c'], play: ['p'] })));
  await page.reload();
  await expect(page.locator('#hint-stack .hint-warning').last()).toContainText('保留给复制、粘贴和剪切');
  expect(await page.evaluate(() => MaweShortcuts.bindings(MaweShortcuts.commands.find(item => item.id === 'merge')))).toEqual(['c']);
  expect(await page.evaluate(() => MaweShortcuts.bindings(MaweShortcuts.commands.find(item => item.id === 'play')))).toEqual(['p']);
  await page.evaluate(() => { MaweSelection.selectOnly(0); MaweSelection.addToSelection(1); });
  const before = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length);
  await page.keyboard.press('Control+c');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(before);
});
test('English migration warning reports real fixed Q conflict', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('mawe.language', 'en');
    localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ split: ['q'], play: ['p'] }));
  });
  await page.reload();
  const warning = page.locator('#hint-stack .hint-warning').last();
  await expect(warning).toContainText('Ignored invalid saved shortcut');
  await expect(warning).toContainText('Split subtitle');
  await expect(warning).toContainText('Fixed shortcut Q');
  await expect(warning).not.toContainText('快捷键');
  expect(await page.evaluate(() => MaweShortcuts.bindings(MaweShortcuts.commands.find(item => item.id === 'play')))).toEqual(['p']);
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
test('Ctrl/Cmd+S retains edit-only save after remap and does not steal browser save outside editing', async ({ page }) => {
  await closeSettings(page);
  const saveUrl = new URL(await page.evaluate(() => MaweBoot.SERVER_CONFIG.saveUrl), server.url).href;
  let saveRequests = 0;
  page.on('request', request => {
    if (request.url() === saveUrl && request.method() === 'POST') saveRequests += 1;
  });
  await page.evaluate(() => {
    window.__saveShortcutAudit = [];
    document.addEventListener('keydown', event => {
      if (event.key.toLowerCase() !== 's' || !(event.ctrlKey || event.metaKey)) return;
      const entry = { chord: event.metaKey ? 'Meta+s' : 'Control+s', editing: Boolean(event.target?.isContentEditable), prevented: null };
      window.__saveShortcutAudit.push(entry);
      setTimeout(() => { entry.prevented = event.defaultPrevented; }, 0);
    }, true);
  });

  const waitForSave = () => page.waitForResponse(response => response.url() === saveUrl && response.request().method() === 'POST');
  const settleKey = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const key of ['Control+s', 'Meta+s']) {
    const request = waitForSave();
    await page.keyboard.press(key);
    await request;
  }
  await settleKey();
  expect(await page.evaluate(() => window.__saveShortcutAudit.slice(0, 2).map(item => item.prevented))).toEqual([true, true]);

  await page.evaluate(() => {
    const cue = document.querySelector('.cue[data-idx="0"]');
    MaweInlineEdit.startEdit(cue, 0);
    MaweInlineEdit.editingState.textEl.innerText = 'Pending text before save remap';
  });
  const beforeRemapSave = waitForSave();
  await page.keyboard.press('Control+s');
  await beforeRemapSave;
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('Pending text before save remap');
  expect(await page.evaluate(() => Boolean(MaweInlineEdit.editingState))).toBe(true);
  await page.evaluate(() => MaweInlineEdit.finishEdit(true));

  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-shortcuts').click();
  await record(page, 'save', 'F2');
  await expect(keyButton(page, 'save')).toHaveText('F2');
  await closeSettings(page);

  const staleStart = await page.evaluate(() => window.__saveShortcutAudit.length);
  const requestCountAfterRemap = saveRequests;
  await page.keyboard.press('Control+s');
  await page.keyboard.press('Meta+s');
  await settleKey();
  expect(saveRequests).toBe(requestCountAfterRemap);
  expect(await page.evaluate(index => window.__saveShortcutAudit.slice(index).map(item => item.prevented), staleStart)).toEqual([false, false]);

  const f2Save = waitForSave();
  await page.keyboard.press('F2');
  await f2Save;

  await page.evaluate(() => {
    const cue = document.querySelector('.cue[data-idx="0"]');
    MaweInlineEdit.startEdit(cue, 0);
    MaweInlineEdit.editingState.textEl.innerText = 'Pending text after save remap';
  });
  const editRequestsBeforeF2 = saveRequests;
  await page.keyboard.press('F2');
  await settleKey();
  expect(saveRequests).toBe(editRequestsBeforeF2);
  const editingAuditStart = await page.evaluate(() => window.__saveShortcutAudit.length);
  for (const key of ['Control+s', 'Meta+s']) {
    const request = waitForSave();
    await page.keyboard.press(key);
    await request;
  }
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('Pending text after save remap');
  expect(await page.evaluate(() => Boolean(MaweInlineEdit.editingState))).toBe(true);
  await settleKey();
  expect(await page.evaluate(index => window.__saveShortcutAudit.slice(index).map(item => item.prevented), editingAuditStart)).toEqual([true, true]);
});
test('Mod+S can merge outside editing but saves only while editing', async ({ page }) => {
  await record(page, 'save', 'F2');
  await record(page, 'merge', 'Control+s');
  await expect(keyButton(page, 'merge')).toHaveText(/^(Ctrl|Cmd)\+S$/);
  await closeSettings(page);
  await page.evaluate(() => {
    MaweSelection.selectOnly(0);
    MaweSelection.addToSelection(1);
  });
  const before = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length);
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(before - 1);
  await page.evaluate(() => {
    MaweInlineEdit.startEdit(document.querySelector('.cue[data-idx="0"]'), 0);
    MaweInlineEdit.editingState.textEl.innerText = 'Save, not merge';
  });
  const saveUrl = new URL(await page.evaluate(() => MaweBoot.SERVER_CONFIG.saveUrl), server.url).href;
  let savedBody;
  await page.route(saveUrl, async route => {
    savedBody = route.request().postData();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  const saved = page.waitForResponse(response => response.url() === saveUrl && response.request().method() === 'POST');
  await page.keyboard.press('Control+s');
  await saved;
  expect(savedBody).toContain('Save, not merge');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(before - 1);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('Save, not merge');
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
test('old global JKL chords are suppressed in the real split modal while its own keys work', async ({ page }) => {
  await record(page, 'reverse', 'p');
  await closeSettings(page);
  const opened = await page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.jklPlaybackMode = 'speed';
    MaweCoreState.player.playbackRate = 1;
    window.__splitModalKeys = [];
    const modal = MaweDom.multiSubtitleSplitModal;
    modal.addEventListener('keydown', event => window.__splitModalKeys.push(event.key), true);
    return MaweSplitCore.openMainWaveformSplitModal(0, 4000);
  });
  expect(opened).toBe(true);
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await page.locator('#multi-subtitle-split-cancel').focus();
  await page.keyboard.press('j');
  expect(await page.evaluate(() => window.__splitModalKeys)).toContain('j');
  expect(await page.evaluate(() => MaweCoreState.player.playbackRate)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
});
test('legacy Shift+ArrowLeft snap variant is suppressed and follows remapped E', async ({ page }) => {
  await record(page, 'snap-ArrowLeft', 'e');
  await closeSettings(page);
  await page.evaluate(() => MaweSelection.selectOnly(1));
  const before = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[1].start);
  await page.keyboard.press('Alt+Shift+ArrowLeft');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[1].start)).toBe(before);
  await page.keyboard.press('Alt+e');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[1].start)).toBe(8000);
});
test('English migration warning separates Shift+E split collision from translated text and keeps play P', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('mawe.language', 'en');
    localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ split: ['Shift+e'], play: ['p'] }));
  });
  await page.reload();
  const warning = page.locator('#hint-stack .hint-warning').last();
  await expect(warning).toContainText('Ignored invalid saved shortcut');
  await expect(warning).toContainText('Split subtitle');
  await expect(warning).toContainText('Shift+E');
  await expect(warning).toContainText('Derived split shortcuts collide, so the three split operations cannot be distinguished:');
  await expect(warning).not.toContainText('无法区分');
  expect(await page.evaluate(() => MaweShortcuts.bindings(MaweShortcuts.commands.find(item => item.id === 'play')))).toEqual(['p']);
});
test('native open dialog suppresses remapped Delete without stealing its own F2 key', async ({ page }) => {
  await record(page, 'delete', 'F2');
  await closeSettings(page);
  await page.evaluate(() => MaweSelection.selectOnly(0));
  const before = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length);
  await page.locator('.cue[data-idx="0"]').click({ button: 'right' });
  await page.locator('.word-timing-advanced > .ctxmenu-submenu-toggle').click();
  await page.getByRole('button', { name: '调整时间…' }).click();
  const dialog = page.locator('#subtitle-time-offset-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveJSProperty('open', true);
  await dialog.evaluate(element => {
    window.__offsetDialogKeys = [];
    element.addEventListener('keydown', event => window.__offsetDialogKeys.push(event.key), true);
  });
  await page.locator('#project-media-modal').evaluate(element => element.classList.add('show'));
  for (const selector of ['#fcp7-export-modal', '#lottie-export-modal', '#ograf-export-modal']) {
    await page.locator(selector).evaluate(element => element.classList.add('show'));
  }
  const nativeToggles = await page.evaluate(() => [
    document.getElementById('markers-quick-toggle').getAttribute('aria-pressed'),
    document.getElementById('word-timing-quick-toggle').getAttribute('aria-pressed'),
  ]);
  await page.locator('#subtitle-time-offset-cancel').focus();
  await page.keyboard.press('F2');
  await page.keyboard.press('m');
  await page.keyboard.press('q');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(before);
  expect(await page.evaluate(() => window.__offsetDialogKeys)).toEqual(['F2', 'm', 'q']);
  expect(await page.evaluate(() => [
    document.getElementById('markers-quick-toggle').getAttribute('aria-pressed'),
    document.getElementById('word-timing-quick-toggle').getAttribute('aria-pressed'),
  ])).toEqual(nativeToggles);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#project-media-modal')).toHaveClass(/show/);
  for (const selector of ['#fcp7-export-modal', '#lottie-export-modal', '#ograf-export-modal']) {
    await expect(page.locator(selector)).toHaveClass(/show/);
  }
  await page.locator('#project-media-modal').evaluate(element => element.classList.remove('show'));
  for (const selector of ['#fcp7-export-modal', '#lottie-export-modal', '#ograf-export-modal']) {
    await page.locator(selector).evaluate(element => element.classList.remove('show'));
  }
});
test('English migration warning translates Alt-derived conflict and keeps play P', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('mawe.language', 'en');
    localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ 'nav-a': ['Alt+Shift+e'], play: ['p'] }));
  });
  await page.reload();
  const warning = page.locator('#hint-stack .hint-warning').last();
  await expect(warning).toContainText('Ignored invalid saved shortcut');
  await expect(warning).toContainText('Previous subtitle (horizontal)');
  await expect(warning).toContainText('Alt+Shift+E');
  await expect(warning).toContainText('This Alt-modified shortcut conflicts, so the original modifier behavior cannot be preserved:');
  await expect(warning).not.toContainText('快捷键');
  await expect(warning).not.toContainText('无法保留');
  expect(await page.evaluate(() => MaweShortcuts.bindings(MaweShortcuts.commands.find(item => item.id === 'play')))).toEqual(['p']);
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
test('grouped layout uses smaller labels, collapses and preserves expanded groups across filters', async ({ page }, testInfo) => {
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
  await page.screenshot({ path: testInfo.outputPath('maw-shortcuts-grouped.png') });
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

for (const modalKind of ['native', 'split']) {
  test(`Shift JKL stays with the ${modalKind} dialog without changing background playback`, async ({ page }) => {
    await closeSettings(page);
    await page.evaluate(kind => {
      MaweSettings.EDITOR_SETTINGS.jklPlaybackMode = 'speed';
      window.__shiftJklKeys = [];
      if (kind === 'native') MaweSegmentOps.openSubtitleTimeOffsetModal([0]);
      else MaweSplitCore.openMainWaveformSplitModal(0, 4000);
      const modal = kind === 'native' ? document.getElementById('subtitle-time-offset-dialog') : MaweDom.multiSubtitleSplitModal;
      modal.addEventListener('keydown', event => { if (/^[jkl]$/i.test(event.key)) window.__shiftJklKeys.push(event.key); });
    }, modalKind);
    const modal = page.locator(modalKind === 'native' ? '#subtitle-time-offset-dialog' : '#multi-subtitle-split-modal');
    await expect(modal).toBeVisible();
    await page.locator(modalKind === 'native' ? '#subtitle-time-offset-cancel' : '#multi-subtitle-split-cancel').focus();
    for (const [key, rate] of [['J', 1], ['K', 2], ['L', 1]]) {
      await page.evaluate(value => { MaweCoreState.player.playbackRate = value; }, rate);
      await page.keyboard.press(`Shift+${key}`);
      expect.soft(await page.evaluate(() => MaweCoreState.player.playbackRate), `${modalKind} Shift+${key}`).toBe(rate);
    }
    expect(await page.evaluate(() => window.__shiftJklKeys)).toEqual(['J', 'K', 'L']);
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await page.evaluate(() => { MaweCoreState.player.playbackRate = 1; });
    await page.keyboard.press('Shift+J');
    expect(await page.evaluate(() => MaweCoreState.player.playbackRate)).toBe(0.5);
  });
}

for (const modalKind of ['native', 'split']) {
  for (const key of ['Delete', 'Backspace']) {
    test(`Shift+${key} in ${modalKind} dialog cannot delete background subtitles`, async ({ page }) => {
      await closeSettings(page);
      await page.evaluate(kind => {
        MaweSelection.selectOnly(0);
        window.__modalDeletionKeys = [];
        if (kind === 'native') MaweSegmentOps.openSubtitleTimeOffsetModal([0]);
        else MaweSplitCore.openMainWaveformSplitModal(0, 4000);
        const dialog = kind === 'native' ? document.getElementById('subtitle-time-offset-dialog') : MaweDom.multiSubtitleSplitModal;
        dialog.addEventListener('keydown', event => window.__modalDeletionKeys.push([event.key, event.shiftKey]));
      }, modalKind);
      const dialog = page.locator(modalKind === 'native' ? '#subtitle-time-offset-dialog' : '#multi-subtitle-split-modal');
      await expect(dialog).toBeVisible();
      await page.locator(modalKind === 'native' ? '#subtitle-time-offset-cancel' : '#multi-subtitle-split-cancel').focus();
      const before = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length);
      await page.keyboard.press(`Shift+${key}`);
      expect(await page.evaluate(() => window.__modalDeletionKeys)).toContainEqual([key, true]);
      expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(before);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await page.keyboard.press(`Shift+${key}`);
      expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(before - 1);
    });
  }
}


for (const surface of ['inline', 'panel']) {
  test(`remapped Mod+E does not save ${surface} subtitle text while physical Mod+S does`, async ({ page }) => {
    await closeSettings(page);
    await page.evaluate(() => MaweShortcuts.setBinding('save', 'Mod+e'));
    const url = new URL(await page.evaluate(() => MaweBoot.SERVER_CONFIG.saveUrl), server.url).href;
    const payloads = [];
    await page.route(url, async route => {
      payloads.push(route.request().postDataJSON().project);
      await route.fulfill({ json: { ok: true, filename: 'test.mosp' } });
    });
    await page.keyboard.press('Control+e');
    await expect.poll(() => payloads.length).toBe(1);
    await expect.poll(() => page.evaluate(() => MaweServerSave.projectSaveInFlight)).toBe(false);
    if (surface === 'inline') {
      await page.evaluate(() => {
        MaweInlineEdit.startEdit(document.querySelector('.cue[data-idx="0"]'), 0);
        MaweInlineEdit.editingState.textEl.innerText = 'Inline pending text';
        MaweInlineEdit.editingState.textEl.focus();
      });
    } else {
      await page.evaluate(() => MaweSelection.selectOnly(0));
      await page.locator('#cue-panel-text').fill('Panel pending text');
    }
    for (const key of ['Control+e', 'Meta+e']) await page.keyboard.press(key);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(payloads).toHaveLength(1);
    if (surface === 'inline') {
      expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).not.toBe('Inline pending text');
    } else {
      expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('Panel pending text');
      expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(true);
    }
    await page.keyboard.press('Control+s');
    await expect.poll(() => payloads.length).toBe(2);
    expect(payloads[1].tracks.find(track => track.role === 'main').segments[0].text)
      .toBe(surface === 'inline' ? 'Inline pending text' : 'Panel pending text');
  });
}


test('remapped Mod+E does not save secondary subtitle inline editing', async ({ page }) => {
  await closeSettings(page);
  const url = new URL(await page.evaluate(() => MaweBoot.SERVER_CONFIG.saveUrl), server.url).href;
  const payloads = [];
  await page.route(url, async route => {
    payloads.push(route.request().postDataJSON().project);
    await route.fulfill({ json: { ok: true, filename: 'test.mosp' } });
  });
  await page.evaluate(() => {
    MaweShortcuts.setBinding('save', 'Mod+e');
    MaweBoot.DATA.tracks.push({ id: 'test-secondary', role: 'secondary', name: 'Secondary', enabled: true,
      segments: [{ id: 'test-ext-1', start: 0, end: 8000, text: 'Original secondary', items: [] }] });
    MaweBoot.DATA.bilingual = { ...MaweBoot.DATA.bilingual, active_track_id: 'test-secondary', display_mode: 'extension' };
    MaweMultiSubtitleCore.normalizeMultiSubtitleState();
    MaweCuePanel.renderAll();
    MaweDisplaySettings.updateMultiSubtitleUi();
  });
  const text = page.locator('.multi-extension-cue[data-ext-idx="0"] .text').first();
  await text.dblclick();
  await expect(text).toHaveAttribute('contenteditable', 'plaintext-only');
  await text.evaluate(element => { element.innerText = 'Secondary pending text'; });
  await page.keyboard.press('Control+e');
  await page.keyboard.press('Meta+e');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(payloads).toHaveLength(0);
  expect(await page.evaluate(() => AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments[0].text)).toBe('Original secondary');
  await page.keyboard.press('Control+s');
  await expect.poll(() => payloads.length).toBe(1);
  expect(payloads[0].tracks.find(track => track.role === 'secondary').segments[0].text).toBe('Secondary pending text');
});


test('shifted playback and delete follow their remapped keys with collision protection', async ({ page }) => {
  await closeSettings(page);
  await page.evaluate(() => { MaweSettings.EDITOR_SETTINGS.jklPlaybackMode = 'speed'; MaweCoreState.player.playbackRate = 1; });
  await page.keyboard.press('Shift+j');
  expect(await page.evaluate(() => MaweCoreState.player.playbackRate)).toBe(0.5);
  await page.keyboard.press('Shift+l');
  expect(await page.evaluate(() => MaweCoreState.player.playbackRate)).toBe(1);
  await page.keyboard.press('Shift+l');
  expect(await page.evaluate(() => MaweCoreState.player.playbackRate)).toBe(2);
  await page.keyboard.press('Shift+k');
  expect(await page.evaluate(() => MaweCoreState.player.playbackRate)).toBe(1);
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-shortcuts').click();
  await record(page, 'reverse', 'F2');
  await expect(keyButton(page, 'reverse')).toHaveText('F2');
  await record(page, 'stop', 'F3');
  await record(page, 'forward', 'F4');
  await record(page, 'delete', 'F6');
  await closeSettings(page);
  await page.keyboard.press('Shift+j');
  expect(await page.evaluate(() => MaweCoreState.player.playbackRate)).toBe(1);
  await page.keyboard.press('Shift+F2');
  expect(await page.evaluate(() => MaweCoreState.player.playbackRate)).toBe(0.5);
  await page.keyboard.press('Shift+F4');
  expect(await page.evaluate(() => MaweCoreState.player.playbackRate)).toBe(1);
  await page.keyboard.press('Shift+F4');
  expect(await page.evaluate(() => MaweCoreState.player.playbackRate)).toBe(2);
  await page.keyboard.press('Shift+F3');
  expect(await page.evaluate(() => MaweCoreState.player.playbackRate)).toBe(1);
  await page.evaluate(() => MaweSelection.selectOnly(0));
  const count = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length);
  await page.keyboard.press('Shift+Delete');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(count);
  await page.keyboard.press('Shift+F6');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(count - 1);
});


test('shifted playback and delete derived keys reject collisions', async ({ page }) => {
  await record(page, 'reverse', 'F2');
  await record(page, 'delete', 'F6');
  await record(page, 'preview', 'Shift+F2');
  await expect(page.locator('#shortcuts-status')).toContainText('快捷键冲突');
  await page.keyboard.press('Escape');
  await record(page, 'preview', 'Shift+F6');
  await expect(page.locator('#shortcuts-status')).toContainText('快捷键冲突');
});


test('shifted space and delete follow their remapped keys', async ({ page }) => {
  await closeSettings(page);
  await page.evaluate(() => MaweCoreState.player.pause());
  await page.keyboard.press('Shift+Space');
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.paused)).toBe(false);
  await page.keyboard.press('Shift+Space');
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.paused)).toBe(true);
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-shortcuts').click();
  await record(page, 'play', 'F7');
  await record(page, 'delete', 'F6');
  await closeSettings(page);
  await page.keyboard.press('Shift+Space');
  expect(await page.evaluate(() => MaweCoreState.player.paused)).toBe(true);
  await page.keyboard.press('Shift+F7');
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.paused)).toBe(false);
  await page.keyboard.press('Shift+F7');
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.paused)).toBe(true);
  await page.evaluate(() => MaweSelection.selectOnly(0));
  const count = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length);
  await page.keyboard.press('Shift+Delete');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(count);
  await page.keyboard.press('Shift+F6');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(count - 1);
});


for (const [command, binding, variant] of [
  ['undo', 'F2', 'Alt+F2'],
  ['redo', 'F3', 'Alt+F3'],
  ['redo', 'F3', 'Shift+F3'],
  ['redo', 'F3', 'Alt+Shift+F3'],
]) {
  test(`history ${command} keeps modifier variant ${variant} after remapping`, async ({ page }) => {
    await closeSettings(page);
    await page.evaluate(() => { MaweSelection.selectOnly(0); MaweCoreState.player.pause(); });
    const readStart = () => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].start);
    const before = await readStart();
    await page.keyboard.press('ArrowRight');
    expect(await readStart()).toBe(before + 50);
    await page.keyboard.press('Control+Alt+z');
    expect(await readStart()).toBe(before);
    await page.keyboard.press('Control+Shift+y');
    expect(await readStart()).toBe(before + 50);
    await page.keyboard.press('Control+Alt+z');
    expect(await readStart()).toBe(before);
    await page.keyboard.press('Control+Alt+Shift+y');
    expect(await readStart()).toBe(before + 50);
    await page.locator('#editor-settings-toggle').click();
    await page.locator('#editor-settings-tab-shortcuts').click();
    await record(page, command, binding);
    await expect(keyButton(page, command)).toHaveText(binding);
    await closeSettings(page);
    if (command === 'redo') await page.evaluate(() => MaweHistory.performUndo());
    await page.keyboard.press(variant);
    expect(await readStart()).toBe(command === 'undo' ? before : before + 50);
  });
}


for (const [key, display, reloadRisk] of [
  ['Control+h', /^(Ctrl|Cmd)\+H$/, false], ['Meta+h', /^(Ctrl|Cmd)\+H$/, false],
  ['Control+r', /^(Ctrl|Cmd)\+R$/, true], ['Meta+r', /^(Ctrl|Cmd)\+R$/, true],
  ['F5', /^F5$/, true], ['Control+Space', /^(Ctrl|Cmd)\+Space$/, false],
  ['Meta+Space', /^(Ctrl|Cmd)\+Space$/, false], ['Control+Shift+3', /^(Ctrl|Cmd)\+Shift\+3$/, false],
  ['Meta+Shift+3', /^(Ctrl|Cmd)\+Shift\+3$/, false],
]) {
  test(`system shortcut ${key} can be recorded with an explicit warning`, async ({ page }) => {
    await record(page, 'nav-d', key);
    await expect(keyButton(page, 'nav-d')).toHaveText(display);
    await expect(page.locator('#shortcuts-status')).toContainText('可能被系统或浏览器截获');
    if (reloadRisk) await expect(page.locator('#shortcuts-status')).toContainText('可能刷新页面');
    await page.reload();
    await page.locator('#editor-settings-toggle').click();
    await page.locator('#editor-settings-tab-shortcuts').click();
    await expect(keyButton(page, 'nav-d')).toHaveText(display);
    if (reloadRisk) await expect(page.locator('.shortcut-settings-row').filter({ has: keyButton(page, 'nav-d') })).toContainText('可能刷新页面');
  });
}


test('English system-key warning persists for refresh bindings and internal conflicts still reject', async ({ page }, testInfo) => {
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await record(page, 'nav-d', 'F5');
  await expect(page.locator('#shortcuts-status')).toContainText('system or browser may intercept');
  await expect(page.locator('#shortcuts-status')).toContainText('may reload the page');
  await expect(page.locator('.shortcut-settings-row').filter({ has: keyButton(page, 'nav-d') })).toContainText('May reload the page');
  const gaps = await page.locator('.shortcut-settings').evaluate(panel => {
    const boxes = [...panel.children].map(node => node.getBoundingClientRect());
    return boxes.slice(1).map((box, index) => box.top - boxes[index].bottom);
  });
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(8);
  await page.screenshot({ path: testInfo.outputPath('system-shortcut-warning-en.png') });
  await record(page, 'merge', 'F5');
  await expect(page.locator('#shortcuts-status')).toContainText('Shortcut conflict');
  await page.keyboard.press('Escape');
  await expect(keyButton(page, 'merge')).toHaveText('C');
  await expect(keyButton(page, 'nav-d')).toHaveText('F5');
});


test('saved system bindings migrate together and survive an unrelated edit', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({
    'nav-d': ['Mod+h'], preview: ['F5'], merge: ['F3'], play: ['p'],
  })));
  await page.reload();
  const bindings = await page.evaluate(() => Object.fromEntries(['nav-d', 'preview', 'merge', 'play'].map(id => [
    id, MaweShortcuts.bindings(MaweShortcuts.commands.find(entry => entry.id === id)),
  ])));
  expect(bindings).toEqual({ 'nav-d': ['Mod+h'], preview: ['F5'], merge: ['F3'], play: ['p'] });
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-shortcuts').click();
  await expect(page.locator('.shortcut-settings-row').filter({ has: keyButton(page, 'preview') })).toContainText('可能刷新页面');
  await record(page, 'nav-a', 'e');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('moy.asr.editor.shortcuts.v1')));
  expect(saved).toMatchObject({ 'nav-d': ['Mod+h'], preview: ['F5'], merge: ['F3'], play: ['p'], 'nav-a': ['e'] });
});


test('arrow keys remain reserved for their original commands in recording and migration', async ({ page }) => {
  const clearUp = page.locator('[data-shortcut-id="track-up"][data-shortcut-control="clear"]');
  if (!await clearUp.evaluate(el => el.closest('details').open)) {
    await page.locator('.shortcut-settings-group').filter({ has: clearUp }).locator('summary').click();
  }
  await clearUp.click();
  await record(page, 'delete', 'ArrowUp');
  await expect(page.locator('#shortcuts-status')).toContainText('方向键');
  await page.keyboard.press('Escape');
  await expect(keyButton(page, 'delete')).toHaveText('Delete / Backspace');
  await page.evaluate(() => localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ 'track-up': [], delete: ['ArrowUp'], play: ['p'] })));
  await page.reload();
  await expect(page.locator('#hint-stack .hint-warning').last()).toContainText('方向键');
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-shortcuts').click();
  await expect(keyButton(page, 'delete')).toHaveText('Delete / Backspace');
  await expect(keyButton(page, 'play')).toHaveText('P');
});


test('English arrow reservation explains recording and saved-binding migration', async ({ page }) => {
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await record(page, 'delete', 'ArrowUp');
  await expect(page.locator('#shortcuts-status')).toContainText('Arrow keys are reserved');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    localStorage.setItem('mawe.language', 'en');
    localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ delete: ['ArrowUp'], play: ['p'] }));
  });
  await page.reload();
  await expect(page.locator('#hint-stack .hint-warning').last()).toContainText('Arrow keys are reserved');
  await expect(page.locator('#hint-stack .hint-warning').last()).toContainText('Delete selected subtitles');
});


test('saved arrow migration retains a valid sibling binding on the same command', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ 'track-up': [], delete: ['ArrowUp', 'F2'], play: ['p'] })));
  await page.reload();
  await expect(page.locator('#hint-stack .hint-warning').last()).toContainText('方向键');
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-shortcuts').click();
  await expect(keyButton(page, 'delete')).toHaveText('F2');
  await expect(keyButton(page, 'play')).toHaveText('P');
  await closeSettings(page);
  await page.evaluate(() => MaweSelection.selectOnly(0));
  const count = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length);
  await page.keyboard.press('F2');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(count - 1);
});


test('Escape in plain text modal leaves an existing settings panel open', async ({ page }) => {
  await closeSettings(page);
  await page.locator('#cue-list-settings-toggle').click();
  await expect(page.locator('#cue-list-settings-panel')).toBeVisible();
  await page.evaluate(() => MaweTimedTextEdit.openTimedTextEdit());
  await expect(page.locator('#timed-text-edit-rows textarea').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);
  await expect(page.locator('#cue-list-settings-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#cue-list-settings-panel')).toBeHidden();
});

test('Escape in plain text modal leaves an existing export menu open', async ({ page }) => {
  await closeSettings(page);
  await page.locator('#subtitle-export-btn').click();
  await expect(page.locator('#subtitle-export-dropdown')).toHaveClass(/open/);
  await page.evaluate(() => MaweTimedTextEdit.openTimedTextEdit());
  await expect(page.locator('#timed-text-edit-rows textarea').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);
  await expect(page.locator('#subtitle-export-dropdown')).toHaveClass(/open/);
});


test('Escape in plain text modal leaves a background help window open', async ({ page }) => {
  await closeSettings(page);
  await page.locator('#help-toggle').click();
  await expect(page.locator('#help-panel')).toBeVisible();
  await page.evaluate(() => MaweTimedTextEdit.openTimedTextEdit());
  await expect(page.locator('#timed-text-edit-rows textarea').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);
  await expect(page.locator('#help-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#help-panel')).toBeHidden();
});

test('Escape in plain text modal preserves an armed waveform split retry', async ({ page }) => {
  await closeSettings(page);
  const first = await page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.splitUseWordTimestamps = true;
    const segment = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0];
    segment.text = 'Alpha Bravo';
    segment.items = [{ start: segment.start, end: segment.start + 50, text: 'Alpha' },
      { start: segment.start + 50, end: segment.end, text: 'Bravo' }];
    MaweCuePanel.renderAll({ waveform: 'full' });
    return MaweSplitContext.splitFromContextMenu(0, 10, 10, segment.start + 50);
  });
  expect(first).toBe(false);
  await expect(page.locator('#hint-stack .hint-warning').last()).toContainText('100ms');
  const count = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length);
  await page.evaluate(() => MaweTimedTextEdit.openTimedTextEdit());
  await expect(page.locator('#timed-text-edit-rows textarea').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);
  const second = await page.evaluate(() => {
    const segment = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0];
    return MaweSplitContext.splitFromContextMenu(0, 10, 10, segment.start + 50);
  });
  expect(second).toBe(true);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(count + 1);
});


test('Escape in plain text modal leaves background context menu open', async ({ page }) => {
  await closeSettings(page);
  await page.locator('.cue[data-idx="0"]').click({ button: 'right' });
  await expect(page.locator('#ctxmenu')).toHaveClass(/show/);
  await page.evaluate(() => MaweTimedTextEdit.openTimedTextEdit());
  await expect(page.locator('#timed-text-edit-rows textarea').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);
  await expect(page.locator('#ctxmenu')).toHaveClass(/show/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#ctxmenu')).not.toHaveClass(/show/);
});

test('Escape in plain text modal leaves background gap window open', async ({ page }) => {
  await closeSettings(page);
  await page.locator('#gap-remove-manage').click();
  await expect(page.locator('#gap-remove-panel')).toBeVisible();
  await page.evaluate(() => MaweTimedTextEdit.openTimedTextEdit());
  await expect(page.locator('#timed-text-edit-rows textarea').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);
  await expect(page.locator('#gap-remove-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#gap-remove-panel')).toBeHidden();
});

test('clipboard shortcuts are rejected when recording in Chinese and English', async ({ page }) => {
  for (const [language, message] of [['zh-CN', '保留给复制、粘贴和剪切'], ['en', 'reserved for copy, paste, and cut']]) {
    await page.evaluate(lang => MAWE_I18N.applyLanguage(lang), language);
    for (const modifier of ['Control', 'Meta']) {
      for (const key of ['c', 'v', 'x']) {
        await record(page, 'delete', `${modifier}+${key}`);
        await expect(page.locator('#shortcuts-status')).toContainText(message);
        await page.keyboard.press('Escape');
        await expect(keyButton(page, 'delete')).toHaveText('Delete / Backspace');
      }
    }
  }
});

test('clipboard migration retains valid sibling bindings and native copy, cut, and paste', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => {
    localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({
      delete: ['Mod+c', 'F2'], merge: ['Mod+v', 'F3'], add: ['Mod+x', 'F4'], play: ['p'],
    }));
  });
  await page.reload();
  const warning = page.locator('#hint-stack .hint-warning').last();
  await expect(warning).toContainText('保留给复制、粘贴和剪切');
  expect(await page.evaluate(() => Object.fromEntries(['delete', 'merge', 'add', 'play'].map(id => [
    id, MaweShortcuts.bindings(MaweShortcuts.commands.find(entry => entry.id === id)),
  ])))).toEqual({ delete: ['F2'], merge: ['F3'], add: ['F4'], play: ['p'] });
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-shortcuts').click();
  await record(page, 'nav-a', 'e');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moy.asr.editor.shortcuts.v1')))).toMatchObject({
    delete: ['F2'], merge: ['F3'], add: ['F4'], play: ['p'], 'nav-a': ['e'],
  });
  await closeSettings(page);
  const before = await page.evaluate(() => {
    MaweSelection.selectOnly(0);
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#media-name'));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    window.__clipboardEvents = [];
    for (const type of ['copy', 'cut', 'paste']) document.addEventListener(type, () => window.__clipboardEvents.push(type));
    window.__clipboardKeys = [];
    window.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && ['c', 'v', 'x'].includes(event.key.toLowerCase())) {
        setTimeout(() => window.__clipboardKeys.push({ key: event.key.toLowerCase(), prevented: event.defaultPrevented }), 0);
      }
    }, true);
    return { text: window.getSelection().toString(), segments: structuredClone(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments),
      modifier: /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control' };
  });
  expect(before.text.length).toBeGreaterThan(0);
  await page.keyboard.press(`${before.modifier}+c`);
  await expect.poll(() => page.evaluate(() => window.__clipboardEvents)).toEqual(['copy']);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(before.text);
  const otherModifier = before.modifier === 'Meta' ? 'Control' : 'Meta';
  await page.keyboard.press(`${otherModifier}+c`);
  await expect.poll(() => page.evaluate(() => window.__clipboardKeys.length)).toBe(2);
  expect(await page.evaluate(() => window.__clipboardKeys.every(key => !key.prevented))).toBe(true);
  expect(await page.evaluate(() => window.__clipboardEvents)).toEqual(['copy']);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments)).toEqual(before.segments);
  await page.evaluate(() => {
    window.getSelection().removeAllRanges();
    document.activeElement?.blur();
    window.__clipboardKeys = [];
  });
  for (const modifier of ['Control', 'Meta']) {
    for (const key of ['c', 'v', 'x']) await page.keyboard.press(`${modifier}+${key}`);
  }
  await expect.poll(() => page.evaluate(() => window.__clipboardKeys.length)).toBe(6);
  expect(await page.evaluate(() => window.__clipboardKeys.every(key => !key.prevented))).toBe(true);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments)).toEqual(before.segments);
  await page.evaluate(() => { window.__clipboardEvents = []; window.__clipboardKeys = []; });
  const input = page.locator('#search');
  await input.fill('clipboard sample');
  await input.selectText();
  await page.keyboard.press(`${before.modifier}+x`);
  await expect(input).toHaveValue('');
  await page.keyboard.press(`${before.modifier}+v`);
  await expect(input).toHaveValue('clipboard sample');
  await expect.poll(() => page.evaluate(() => window.__clipboardEvents)).toEqual(['cut', 'paste']);
  await expect.poll(() => page.evaluate(() => window.__clipboardKeys.length)).toBe(2);
  expect(await page.evaluate(() => window.__clipboardKeys)).toEqual([
    { key: 'x', prevented: false }, { key: 'v', prevented: false },
  ]);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments)).toEqual(before.segments);
});

test('English clipboard migration warning identifies the key and retains its sibling', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('mawe.language', 'en');
    localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ delete: ['Mod+c', 'F2'], play: ['p'] }));
  });
  await page.reload();
  const warning = page.locator('#hint-stack .hint-warning').last();
  await expect(warning).toContainText('reserved for copy, paste, and cut');
  await expect(warning).toContainText(/(Ctrl|Cmd)\+C/);
  await expect(warning).toContainText('Delete selected subtitles');
  expect(await page.evaluate(() => MaweShortcuts.bindings(MaweShortcuts.commands.find(item => item.id === 'delete')))).toEqual(['F2']);
});

test('invalid saved sibling chords are reported individually while valid siblings work', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({
    delete: ['Bogus', 'F2'], split: ['F3', 'Shift+F3'], play: ['p'],
  })));
  await page.reload();
  const warning = page.locator('#hint-stack .hint-warning').last();
  await expect(warning).toContainText('该按键不可用');
  await expect(warning).toContainText('派生组合发生冲突');
  expect(await page.evaluate(() => Object.fromEntries(['delete', 'split', 'play'].map(id => [
    id, MaweShortcuts.bindings(MaweShortcuts.commands.find(entry => entry.id === id)),
  ])))).toEqual({ delete: ['F2'], split: ['F3'], play: ['p'] });
  await page.evaluate(() => MaweSelection.selectOnly(0));
  const count = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length);
  await page.keyboard.press('F2');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(count - 1);
});

test('mouse-selected page text copies after an old clipboard binding is discarded', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({ delete: ['Mod+c', 'F2'] })));
  await page.reload();
  await page.evaluate(() => MaweSelection.selectOnly(0));
  const box = await page.locator('#media-name').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  const before = await page.evaluate(() => ({
    text: window.getSelection().toString(),
    segments: structuredClone(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments),
    modifier: /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control',
    selected: [...MaweSelection.selectedIdxs],
  }));
  expect(before.text.length).toBeGreaterThan(0);
  expect(before.selected).toContain(0);
  await page.keyboard.press(`${before.modifier}+c`);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(before.text);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments)).toEqual(before.segments);
});

test('saved derived conflicts keep the other binding on the same command', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('moy.asr.editor.shortcuts.v1', JSON.stringify({
    play: ['Shift+F3'], delete: ['F2', 'F3'],
  })));
  await page.reload();
  const warning = page.locator('#hint-stack .hint-warning').last();
  await expect(warning).toContainText('快捷键冲突');
  await expect(warning).toContainText('F3');
  expect(await page.evaluate(() => Object.fromEntries(['delete', 'play'].map(id => [
    id, MaweShortcuts.bindings(MaweShortcuts.commands.find(entry => entry.id === id)),
  ])))).toEqual({ delete: ['F2'], play: ['Shift+F3'] });
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-shortcuts').click();
  await record(page, 'nav-a', 'e');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moy.asr.editor.shortcuts.v1')))).toMatchObject({
    delete: ['F2'], play: ['Shift+F3'], 'nav-a': ['e'],
  });
  await closeSettings(page);
  await page.evaluate(() => MaweSelection.selectOnly(0));
  const count = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length);
  await page.keyboard.press('F2');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(count - 1);
});
