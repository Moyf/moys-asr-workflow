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

test('后台拆句等待行内编辑结束，保留后方字幕的人工输入', async ({ page }) => {
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
  await expect(page.locator('#ai-task-progress-label')).toContainText('结果已生成，等待结束字幕编辑');
  await expect(target).toHaveAttribute('contenteditable', 'plaintext-only');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(2);
  await page.mouse.click(10, 10);
  await expect.poll(() => page.evaluate(() => MaweInlineEdit.editingState)).toBeNull();
  await expect(page.locator('#hint-stack')).toContainText('已按 AI 建议拆分');
  expect(errors).toEqual([]);
  const result = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(({ id, text }) => ({ id, text })));
  expect(result.find(segment => segment.id === 'b')?.text).toBe('manually revised B');
  expect(result[1].text).not.toBe('manually revised B');
});

test('按住丢弃按钮时不提前结束编辑或应用后台结果', async ({ page }) => {
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
  await expect(page.locator('#ai-task-progress-label')).toContainText('结果已生成，等待结束字幕编辑');
  const discard = page.getByRole('button', { name: '丢弃尚未应用的 AI 结果' });
  const rect = await discard.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(350); // 超过等待编辑的轮询周期，覆盖按住按钮的竞态。
  await expect(target).toHaveAttribute('contenteditable', 'plaintext-only');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(2);
  await page.mouse.up();
  await expect(page.locator('#ai-task-progress-label')).toContainText('已取消');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(2);
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
  await page.route('**/api/ai/task', route => route.fulfill({ json: { ok: true, task: { id: 'split', status: 'queued' } } }));
  await page.route('**/api/ai/tasks', route => route.fulfill({ json: { ok: true,
    tasks: [{ id: 'split', status: 'done', result: { texts: { a: 'hello⎪ world' } } }] } }));
  await page.evaluate(() => MaweContextMenus.showContextMenu(100, 100, 0));
  await page.locator('.ctxmenu-submenu.ai-actions').hover();
  await page.locator('.ctxmenu-submenu.ai-actions').getByRole('button', { name: 'AI 拆分建议…' }).click();
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  expect(await page.evaluate(() => MaweSplitCore.pendingLinkedSplit.mainOffset)).toBe(6);
  await page.locator('#multi-subtitle-split-cancel').click();
  expect(await page.evaluate(() => ({ main: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length,
    secondary: MaweBoot.DATA.tracks.find(track => track.role === 'secondary').segments.length,
    bindings: MaweBoot.DATA.bindings.length }))).toEqual({ main: 1, secondary: 1, bindings: 1 });
  await page.evaluate(() => { MaweSelection.selectOnly(0); MaweContextMenus.showContextMenu(100, 100, 0); });
  await page.locator('.ctxmenu-submenu.ai-actions').hover();
  await page.locator('.ctxmenu-submenu.ai-actions').getByRole('button', { name: 'AI 拆分建议…' }).click();
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await page.locator('#multi-subtitle-split-confirm').click();
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.bindings.length)).toBe(2);
  expect(await page.evaluate(() => ({ main: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length,
    secondary: MaweBoot.DATA.tracks.find(track => track.role === 'secondary').segments.length })))
    .toEqual({ main: 2, secondary: 2 });
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await page.evaluate(() => MaweBoot.DATA.bindings.length)).toBe(1);
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
