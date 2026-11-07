import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer } from './helpers.mjs';

let directory;
let server;
test.beforeAll(async () => {
  directory = makeTempDir('editor-ai-assist');
  server = await startBlankServer(await findFreePort(), join(directory, 'settings'));
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });

async function openSuggestions(page) {
  await expect(page.locator('#ai-preview-open')).toBeVisible();
  await page.locator('#ai-preview-open').click();
  await expect(page.locator('#ai-preview-dialog')).toBeVisible();
}

test('智能合并经过真实合并命令、AI 回写并可撤销', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ schema: 'moy.asr.project.v1', media: '', segments: [
      { id: 'a', start: 0, end: 1000, text: 'can' },
      { id: 'b', start: 1100, end: 2000, text: 'not' },
    ] }, 'test.mosp');
    MaweSettings.updateEditorSettings({ aiEnabled: true, autoSaveProject: false });
    MaweSelection.selectRange(0, 1);
  });
  let submitted;
  await page.route('**/api/ai/task', route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, task: { id: 'task-1', status: 'queued' } } });
  });
  await page.route('**/api/ai/tasks', route => route.fulfill({ json: {
    ok: true, tasks: [{ id: 'task-1', status: 'done', result: { texts: { a: 'cannot' } } }],
  } }));
  await page.evaluate(() => MaweContextMenus.showContextMenu(100, 100, 0));
  await page.locator('.ctxmenu-submenu.ai-actions').hover();
  await page.locator('.ctxmenu-submenu.ai-actions').getByRole('button', { name: 'AI 智能合并…' }).click();
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(1);
  await expect.poll(() => submitted?.kind).toBe('ai-smart-merge');
  await openSuggestions(page);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe(submitted.payload.mergedText);
  await page.locator('#ai-preview-apply').click();
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('cannot');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(1);
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe(submitted.payload.mergedText);
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(segment => segment.text))).toEqual(['can', 'not']);
});

test('智能合并遵守不同说话人不可合并的规则', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ schema: 'moy.asr.project.v1', media: '', segments: [
      { id: 'a', start: 0, end: 1000, text: 'Hello' },
      { id: 'b', start: 1100, end: 2000, text: 'world' },
    ] }, 'test.mosp');
    MaweBoot.DATA.speakers = [
      { id: 'speaker-a', name: 'A', color: '#f9ca1f' }, { id: 'speaker-b', name: 'B', color: '#66bb6a' },
    ];
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.forEach((segment, index) => { segment.speaker = index ? 'speaker-b' : 'speaker-a'; });
    MaweSettings.updateEditorSettings({ aiEnabled: true, autoSaveProject: false });
    MaweSelection.selectRange(0, 1);
  });
  let requested = false;
  await page.route('**/api/ai/task', route => { requested = true; return route.abort(); });
  await page.evaluate(() => MaweContextMenus.showContextMenu(100, 100, 0));
  await page.locator('.ctxmenu-submenu.ai-actions').hover();
  await page.locator('.ctxmenu-submenu.ai-actions').getByRole('button', { name: 'AI 智能合并…' }).click();
  await expect(page.locator('#hint-stack')).toContainText('不同说话人的字幕不能合并');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(2);
  expect(requested).toBe(false);
});

test('后台拆句保留行内编辑焦点，显式应用后保留后方字幕的人工输入', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ schema: 'moy.asr.project.v1', media: '', segments: [
      { id: 'a', start: 0, end: 3000, text: 'hello world' },
      { id: 'b', start: 3500, end: 6000, text: 'second line' },
    ] }, 'test.mosp');
    MaweSettings.updateEditorSettings({ aiEnabled: true, autoSaveProject: false });
    MaweSelection.selectOnly(0);
  });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/ai/task', route => route.fulfill({ json: { ok: true, task: { id: 'task-2', status: 'queued' } } }));
  await page.route('**/api/ai/tasks', async route => {
    await held;
    await route.fulfill({ json: { ok: true, tasks: [{ id: 'task-2', status: 'done', result: { texts: { a: 'hello⎪ world' } } }] } });
  });
  await page.evaluate(() => MaweContextMenus.showContextMenu(100, 100, 0));
  await page.locator('.ctxmenu-submenu.ai-actions').hover();
  await page.locator('.ctxmenu-submenu.ai-actions').getByRole('button', { name: 'AI 拆分建议…' }).click();
  const target = page.locator('.cue[data-idx="1"] .text');
  await target.dblclick();
  await target.fill('manually revised B');
  release();
  await expect(page.locator('#ai-preview-open')).toBeVisible();
  await expect(target).toHaveAttribute('contenteditable', 'plaintext-only');
  await expect(target).toBeFocused();
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(2);
  await page.mouse.click(10, 10);
  await expect.poll(() => page.evaluate(() => MaweInlineEdit.editingState)).toBeNull();
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(2);
  await openSuggestions(page);
  await page.locator('#ai-preview-apply').click();
  await expect(page.locator('#hint-stack')).toContainText('已按 AI 建议拆分');
  expect(errors).toEqual([]);
  const result = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(({ id, text }) => ({ id, text })));
  expect(result.find(segment => segment.id === 'b')?.text).toBe('manually revised B');
  expect(result[1].text).not.toBe('manually revised B');
});

test('关闭预览保留结果，丢弃全部不修改字幕', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ schema: 'moy.asr.project.v1', media: '', segments: [
      { id: 'a', start: 0, end: 3000, text: 'hello world' },
      { id: 'b', start: 3500, end: 6000, text: 'second line' },
    ] }, 'test.mosp');
    MaweSettings.updateEditorSettings({ aiEnabled: true, autoSaveProject: false });
    MaweSelection.selectOnly(0);
  });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/ai/task', route => route.fulfill({ json: { ok: true, task: { id: 'discard-test', status: 'queued' } } }));
  await page.route('**/api/ai/tasks', async route => {
    await held;
    await route.fulfill({ json: { ok: true, tasks: [{ id: 'discard-test', status: 'done', result: { texts: { a: 'hello⎪ world' } } }] } });
  });
  await page.evaluate(() => MaweContextMenus.showContextMenu(100, 100, 0));
  await page.locator('.ctxmenu-submenu.ai-actions').hover();
  await page.locator('.ctxmenu-submenu.ai-actions').getByRole('button', { name: 'AI 拆分建议…' }).click();
  const target = page.locator('.cue[data-idx="1"] .text');
  await target.dblclick();
  await target.fill('manually revised B');
  release();
  await expect(page.locator('#ai-preview-open')).toBeVisible();
  await expect(target).toHaveAttribute('contenteditable', 'plaintext-only');
  await expect(target).toBeFocused();
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(2);
  await page.mouse.click(10, 10);
  await openSuggestions(page);
  await page.locator('#ai-preview-close').click();
  await expect(page.locator('#ai-preview-dialog')).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => MaweAiPreview.hasPending())).toBe(true);
  await expect(page.locator('#ai-task-progress')).toBeHidden();
  await expect(page.locator('#ai-preview-open')).toBeVisible();
  await openSuggestions(page);
  await page.locator('#ai-preview-discard').click();
  await expect(page.locator('#ai-preview-open')).not.toBeVisible();
  expect(await page.evaluate(() => MaweAiPreview.hasPending())).toBe(false);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(2);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[1].text)).toBe('manually revised B');
});

test('AI 拆句对已绑定双语字幕打开联动窗口，取消保留绑定', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ schema: 'moy.asr.project.v1', media: '', segments: [
      { id: 'a', start: 0, end: 3000, text: 'hello world' },
    ] }, 'test.mosp');
    const main = AsrEditorUtils.getMainTrack(MaweBoot.DATA);
    const track = AsrEditorUtils.ensureExtensionTrack(MaweBoot.DATA, { id: 'ext', enabled: true,
      segments: [{ id: 'translated', start: 0, end: 3000, text: '你好世界' }] });
    MaweBoot.DATA.bilingual.active_track_id = track.id;
    MaweBoot.DATA.bilingual.display_mode = 'both';
    MaweBoot.DATA.bindings.push(AsrEditorUtils.buildSubtitleBinding(main.segments[0], track.segments[0], track.id, 'binding-1', main.id));
    MaweSettings.updateEditorSettings({ aiEnabled: true, autoSaveProject: false });
    MaweCuePanel.renderAll({ waveform: 'full' });
    MaweSelection.selectOnly(0);
  });
  let submissions = 0;
  await page.route('**/api/ai/task', route => {
    submissions += 1;
    return route.fulfill({ json: { ok: true, task: { id: 'split', status: 'queued' } } });
  });
  await page.route('**/api/ai/tasks', route => route.fulfill({ json: { ok: true,
    tasks: [{ id: 'split', status: 'done', result: { texts: { a: 'hello⎪ world' } } }] } }));
  await page.evaluate(() => MaweContextMenus.showContextMenu(100, 100, 0));
  await page.locator('.ctxmenu-submenu.ai-actions').hover();
  await page.locator('.ctxmenu-submenu.ai-actions').getByRole('button', { name: 'AI 拆分建议…' }).click();
  await openSuggestions(page);
  await page.locator('#ai-preview-apply').click();
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  expect(await page.evaluate(() => MaweSplitCore.pendingLinkedSplit.mainOffset)).toBe(6);
  const beforeShortcut = await page.evaluate(() => JSON.stringify(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0]));
  await page.locator('#multi-subtitle-split-main-text').focus();
  await page.keyboard.press('1');
  expect(await page.evaluate(() => JSON.stringify(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0]))).toBe(beforeShortcut);
  await page.locator('#multi-subtitle-split-cancel').click();
  expect(await page.evaluate(() => ({ main: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length,
    secondary: MaweBoot.DATA.tracks.find(track => track.role === 'secondary').segments.length,
    bindings: MaweBoot.DATA.bindings.length }))).toEqual({ main: 1, secondary: 1, bindings: 1 });
  expect(await page.evaluate(() => MaweAiPreview.hasPending())).toBe(true);
  await openSuggestions(page);
  await page.locator('#ai-preview-apply').click();
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await page.locator('#multi-subtitle-split-confirm').click();
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.bindings.length)).toBe(2);
  expect(await page.evaluate(() => ({ main: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length,
    secondary: MaweBoot.DATA.tracks.find(track => track.role === 'secondary').segments.length })))
    .toEqual({ main: 2, secondary: 2 });
  expect(submissions).toBe(1);
  expect(await page.evaluate(() => MaweAiPreview.hasPending())).toBe(false);
  await expect(page.locator('#ai-preview-open')).not.toBeVisible();
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await page.evaluate(() => MaweBoot.DATA.bindings.length)).toBe(1);
});

test('AI 联动拆分打开后撤销原文编辑，确认关闭窗口并保留过期建议', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ schema: 'moy.asr.project.v1', media: '', segments: [
      { id: 'a', start: 0, end: 3000, text: 'hello before editing' },
    ] }, 'test.mosp');
    const main = AsrEditorUtils.getMainTrack(MaweBoot.DATA);
    const track = AsrEditorUtils.ensureExtensionTrack(MaweBoot.DATA, { id: 'ext', enabled: true,
      segments: [{ id: 'translated', start: 0, end: 3000, text: '你好世界' }] });
    MaweBoot.DATA.bilingual.active_track_id = track.id;
    MaweBoot.DATA.bilingual.display_mode = 'both';
    MaweBoot.DATA.bindings.push(AsrEditorUtils.buildSubtitleBinding(main.segments[0], track.segments[0], track.id, 'binding-1', main.id));
    MaweSettings.updateEditorSettings({ aiEnabled: true, autoSaveProject: false });
    MaweCuePanel.renderAll({ waveform: 'full' });
    MaweSelection.selectOnly(0);
  });
  // Produce a real editing history record that can subsequently be undone.
  const sourceEditor = page.locator('#cue-panel-text');
  await expect(sourceEditor).toHaveValue('hello before editing');
  await sourceEditor.fill('hello world');
  await sourceEditor.press('Tab');
  await expect(page.locator('#undo-btn')).toBeEnabled();
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('hello world');
  await page.route('**/api/ai/task', route => route.fulfill({ json: { ok: true, task: { id: 'stale-split', status: 'queued' } } }));
  await page.route('**/api/ai/tasks', route => route.fulfill({ json: { ok: true,
    tasks: [{ id: 'stale-split', status: 'done', result: { texts: { a: 'hello⎪ world' } } }] } }));
  await page.evaluate(() => MaweContextMenus.showContextMenu(100, 100, 0));
  await page.locator('.ctxmenu-submenu.ai-actions').hover();
  await page.locator('.ctxmenu-submenu.ai-actions').getByRole('button', { name: 'AI 拆分建议…' }).click();
  await openSuggestions(page);
  await page.locator('#ai-preview-apply').click();
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  // Exercise the editor history command against that real input record while
  // the linked split still holds its older text/cut snapshot.
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('hello before editing');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await page.locator('#multi-subtitle-split-confirm').click();
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  await expect(page.locator('#hint-stack')).toContainText('字幕已修改，请重新查看 AI 建议');
  expect(await page.evaluate(() => ({
    main: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(({ id, text }) => ({ id, text })),
    secondary: MaweBoot.DATA.tracks.find(track => track.role === 'secondary').segments.map(({ id, text }) => ({ id, text })),
    bindings: MaweBoot.DATA.bindings.length,
  }))).toEqual({
    main: [{ id: 'a', text: 'hello before editing' }],
    secondary: [{ id: 'translated', text: '你好世界' }],
    bindings: 1,
  });
  expect(await page.evaluate(() => MaweAiPreview.hasPending())).toBe(true);
  await openSuggestions(page);
  await expect(page.locator('.ai-preview-row')).toHaveCount(1);
  await expect(page.locator('.ai-preview-row')).toContainText('原字幕已修改或删除');
  await expect(page.locator('.ai-preview-row textarea')).toHaveValue('hello⎪ world');
  await expect(page.locator('.ai-preview-row input[type="checkbox"]')).toBeDisabled();
  await expect(page.locator('#ai-preview-apply')).toBeDisabled();
});

test('中文选区翻译到新建副轨并可撤销', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ schema: 'moy.asr.project.v1', media: '', segments: [
      { id: 'a', start: 0, end: 1000, text: '你好世界' },
    ] }, 'test.mosp');
    MaweBoot.DATA.speakers = [{ id: 'speaker-a', name: 'A', color: '#f9ca1f' }];
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].speaker = 'speaker-a';
    MaweSettings.updateEditorSettings({ aiEnabled: true, autoSaveProject: false });
    MaweSelection.selectOnly(0);
  });
  let submitted;
  await page.route('**/api/ai/task', route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, task: { id: 'task-3', status: 'queued' } } });
  });
  await page.route('**/api/ai/tasks', route => route.fulfill({ json: {
    ok: true, tasks: [{ id: 'task-3', status: 'done', result: { texts: { a: 'Hello world' } } }],
  } }));
  await page.evaluate(() => MaweContextMenus.showContextMenu(100, 100, 0));
  await page.locator('.ctxmenu-submenu.ai-actions').hover();
  await page.screenshot({ path: '.artifacts/pr347-ai-translation-menu.png' });
  await page.locator('.ctxmenu-submenu.ai-actions').getByRole('button', { name: '译为英文副字幕（建议）' }).click();
  await expect.poll(() => submitted?.payload?.lang).toBe('en');
  await openSuggestions(page);
  expect(await page.evaluate(() => MaweBoot.DATA.tracks.filter(track => track.role === 'secondary').length)).toBe(0);
  await page.locator('#ai-preview-apply').click();
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.tracks.find(track => track.role === 'secondary')?.segments[0]?.text)).toBe('Hello world');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('你好世界');
  expect(await page.evaluate(() => MaweBoot.DATA.bindings.length)).toBe(1);
  expect(await page.evaluate(() => {
    const main = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0];
    const translated = MaweBoot.DATA.tracks.find(track => track.role === 'secondary').segments[0];
    return { speaker: translated.speaker, sameFrames: translated.start_frame === main.start_frame && translated.end_frame === main.end_frame };
  })).toEqual({ speaker: 'speaker-a', sameFrames: true });
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await page.evaluate(() => MaweBoot.DATA.tracks.filter(track => track.role === 'secondary').length)).toBe(0);
  submitted = null;
  await page.evaluate(() => { MaweSelection.selectOnly(0); MaweContextMenus.showContextMenu(100, 100, 0); });
  await page.locator('.ctxmenu-submenu.ai-actions').hover();
  await page.locator('.ctxmenu-submenu.ai-actions').getByRole('button', { name: '译为中文副字幕' }).click();
  await expect.poll(() => submitted?.payload?.lang).toBe('zh');
});

test('多句翻译仅应用勾选并保留草稿，已有译文和后台人工修改受到保护', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ schema: 'moy.asr.project.v1', media: '', segments: [
      { id: 'a', start: 0, end: 1000, text: '已有译文的原句' },
      { id: 'b', start: 1100, end: 2000, text: '需要翻译的第二句' },
      { id: 'c', start: 2100, end: 3000, text: '暂不应用的第三句' },
      { id: 'd', start: 3100, end: 4000, text: '稍后人工修改的第四句' },
    ] }, 'test.mosp');
    const main = AsrEditorUtils.getMainTrack(MaweBoot.DATA);
    const track = AsrEditorUtils.ensureExtensionTrack(MaweBoot.DATA, { id: 'ext', enabled: true,
      segments: [{ id: 'translated-a', start: 0, end: 1000, text: 'Existing translation' }] });
    MaweBoot.DATA.bilingual.active_track_id = track.id;
    MaweBoot.DATA.bilingual.display_mode = 'both';
    MaweBoot.DATA.bindings.push(AsrEditorUtils.buildSubtitleBinding(main.segments[0], track.segments[0], track.id, 'binding-a', main.id));
    MaweSettings.updateEditorSettings({ aiEnabled: true, autoSaveProject: false });
    MaweCuePanel.renderAll({ waveform: 'full' });
    MaweSelection.selectRange(0, 3);
  });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/ai/task', route => route.fulfill({ json: { ok: true, task: { id: 'partial-translation', status: 'queued' } } }));
  await page.route('**/api/ai/tasks', async route => {
    await held;
    await route.fulfill({ json: { ok: true, tasks: [{ id: 'partial-translation', status: 'done', result: {
      texts: { a: 'Existing translation', b: 'Second suggestion', c: 'Third suggestion', d: 'Stale fourth suggestion' },
    } }] } });
  });
  await page.evaluate(() => MaweContextMenus.showContextMenu(100, 100, 0));
  await page.locator('.ctxmenu-submenu.ai-actions').hover();
  await page.locator('.ctxmenu-submenu.ai-actions').getByRole('button', { name: '译为英文副字幕（建议）' }).click();
  // selectRange leaves the final cue in the editing panel. Use that normal
  // entry point while the task float covers the bottom of the narrow cue list.
  const fourth = page.locator('#cue-panel-text');
  await expect(fourth).toHaveValue('稍后人工修改的第四句');
  await fourth.fill('人工修改后的第四句');
  await fourth.press('Tab');
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[3].text))
    .toBe('人工修改后的第四句');
  release();
  await openSuggestions(page);
  const rows = page.locator('.ai-preview-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Second suggestion');
  await expect(rows.nth(2)).toContainText('原字幕已修改或删除');
  await expect(rows.nth(0)).not.toHaveAttribute('open');
  await page.screenshot({ path: '.artifacts/pr347-ai-preview.png' });
  const verticalGaps = await page.locator('#ai-preview-dialog').evaluate(dialog => {
    const gap = (above, below) => below.getBoundingClientRect().top - above.getBoundingClientRect().bottom;
    const list = dialog.querySelector('#ai-preview-rows');
    return {
      'header to description': gap(dialog.querySelector('.ai-preview-header'), dialog.querySelector('#ai-preview-hint')),
      'first to second cue': gap(list.children[0], list.children[1]),
      'cue list to actions': gap(list, dialog.querySelector('.actions')),
    };
  });
  console.log('AI preview vertical gaps (px):', JSON.stringify(verticalGaps));
  for (const [adjacentElements, pixels] of Object.entries(verticalGaps)) {
    expect(pixels, `${adjacentElements} must have at least 8px of vertical spacing`).toBeGreaterThanOrEqual(8);
  }
  await page.getByRole('button', { name: '查看全部', exact: true }).click();
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Existing translation');
  await expect(rows.nth(0).locator('input[type="checkbox"]')).not.toBeChecked();
  await expect(rows.nth(0).locator('input[type="checkbox"]')).toBeDisabled();
  await expect(rows.nth(0)).toContainText('没有变化');
  await expect(rows.nth(1).locator('input[type="checkbox"]')).toBeChecked();
  await expect(rows.nth(2).locator('input[type="checkbox"]')).toBeChecked();
  await expect(rows.nth(3).locator('input[type="checkbox"]')).toBeDisabled();
  await expect(rows.nth(3)).toContainText('原字幕已修改或删除');
  await rows.nth(0).locator('summary').click();
  const existingDraft = rows.nth(0).locator('textarea');
  const existingEditorNode = await existingDraft.elementHandle();
  await existingDraft.fill('Edited existing translation draft');
  await expect(rows.nth(0).locator('input[type="checkbox"]')).toBeEnabled();
  await expect(rows.nth(0)).not.toContainText('没有变化');
  expect(await existingEditorNode.evaluate(node => node === document.activeElement)).toBe(true);
  expect(await existingDraft.evaluate(node => node.selectionStart)).toBe('Edited existing translation draft'.length);
  await rows.nth(0).locator('input[type="checkbox"]').check();
  await existingDraft.fill('');
  await expect(rows.nth(0).locator('input[type="checkbox"]')).toBeDisabled();
  await expect(rows.nth(0).locator('input[type="checkbox"]')).not.toBeChecked();
  await expect(rows.nth(0)).toContainText('模型未返回有效结果');
  await existingDraft.fill('Edited existing translation draft');
  await expect(rows.nth(0).locator('input[type="checkbox"]')).toBeEnabled();
  await expect(rows.nth(0).locator('input[type="checkbox"]')).not.toBeChecked();
  await rows.nth(1).locator('summary').click();
  await rows.nth(1).locator('textarea').fill('User edited second translation');
  await rows.nth(1).locator('summary').click();
  await expect(rows.nth(1).locator('textarea')).not.toBeVisible();
  await rows.nth(1).locator('summary').click();
  await expect(rows.nth(1).locator('textarea')).toHaveValue('User edited second translation');
  await rows.nth(2).locator('input[type="checkbox"]').uncheck();
  await expect(page.locator('#ai-preview-apply')).toHaveText('应用勾选 1 条');
  await page.locator('#ai-preview-close').click();
  await openSuggestions(page);
  await expect(rows.nth(1).locator('textarea')).toBeVisible();
  await expect(rows.nth(1).locator('textarea')).toHaveValue('User edited second translation');
  await expect(rows.nth(2).locator('input[type="checkbox"]')).not.toBeChecked();
  await page.locator('#ai-preview-apply').click();
  await expect(rows).toHaveCount(3);
  expect(await page.evaluate(() => MaweMultiSubtitleCore.getActiveExtensionTrack().segments.map(({ text }) => text)))
    .toEqual(['Existing translation', 'User edited second translation']);
  expect(await page.evaluate(() => MaweBoot.DATA.bindings.length)).toBe(2);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[3].text)).toBe('人工修改后的第四句');
  await expect(page.locator('#ai-preview-apply')).toBeDisabled();
  await expect(rows.nth(2).locator('textarea')).toHaveValue('Stale fourth suggestion');
  expect(await page.evaluate(() => MaweAiPreview.hasPending())).toBe(true);
  await page.locator('#ai-preview-discard').click();
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await page.evaluate(() => MaweMultiSubtitleCore.getActiveExtensionTrack().segments.map(({ text }) => text)))
    .toEqual(['Existing translation']);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[3].text)).toBe('人工修改后的第四句');
});

test('启动时 AI 设置读取失败，进入设置页后可重试', async ({ page }) => {
  await disableOnboarding(page);
  let calls = 0;
  await page.route('**/api/ai/settings', route => {
    calls += 1;
    if (calls === 1) return route.fulfill({ status: 503, json: { ok: false, error: '暂时无法读取' } });
    return route.fulfill({ json: { ok: true, providerId: 'custom', providers: [
      { id: 'custom', label: 'Custom', baseUrl: 'http://127.0.0.1:1234/v1', model: 'test', reasoningMode: 'auto' },
    ] } });
  });
  await page.goto(server.url);
  await expect.poll(() => calls).toBe(1);
  await expect(page.locator('#ai-settings-status')).toHaveText('暂时无法读取');
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-ai').click();
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator('#ai-provider-select')).toHaveValue('custom');
  await expect(page.locator('#ai-settings-status')).toHaveText('');
});
