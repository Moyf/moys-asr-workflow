import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, makeTempDir, startServer } from './helpers.mjs';

let dir, server, projectPath;
test.beforeEach(async ({ page }) => {
  dir = makeTempDir('view-save-integration');
  projectPath = join(dir, 'view.mosp');
  const media = join(dir, 'synthetic.wav');
  generateWav(media, 5);
  writeFileSync(join(dir, 'cat.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5V8AAAAASUVORK5CYII=', 'base64'));
  writeFileSync(projectPath, JSON.stringify({ schema: 'moy.asr.project.v1', media,
    sticker_root: dir, timebase: { unit: 'milliseconds', fps: 30, fps_source: 'user' },
    segments: [{ id: 'a', start: 0, end: 3000, text: '甲乙丙',
      items: [{ text: '甲', start: 0, end: 1000 }, { text: '乙', start: 1000, end: 2000 },
        { text: '丙', start: 2000, end: 3000 }], sticker: { name: 'cat', rel: 'cat.png' } }],
    overlay_track: { enabled: true, segments: [] },
  }), 'utf8');
  server = await startServer(projectPath, media, await findFreePort());
  await disableOnboarding(page);
  await page.goto(server.url);
  await expect(page.locator('#cues-container')).toBeVisible();
  await page.evaluate(() => MaweSettings.updateEditorSettings({ autoSaveProject: false }));
});
test.afterEach(async () => { await server?.stop(); cleanupTempDir(dir); });
const dirty = page => page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges());
const selectView = (page, view) => page.locator(`#timed-text-edit-view [data-view="${view}"]`).click();
async function openView(page) {
  await page.evaluate(() => MaweTimedTextEdit.openTimedTextEdit());
  await expect(page.locator('#timed-text-edit-modal')).toHaveClass(/show/);
}

test('view-only edits return to the saved default and persist with v1.5 groups and FPS through real Server reopen', async ({ page }) => {
  expect(await dirty(page)).toBe(false);
  await openView(page);
  await selectView(page, 'single');
  expect(await dirty(page)).toBe(true);
  await selectView(page, 'rows');
  expect(await dirty(page)).toBe(false);
  expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).timed_text_edit_view)).toBeUndefined();
  await selectView(page, 'single');
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject())).toBe(true);
  expect(await dirty(page)).toBe(false);
  const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
  expect(saved.timed_text_edit_view).toBe('single');
  expect(saved.schema).toBe('moy.asr.project.v1.5');
  expect(saved.subtitle_groups.sticker).toHaveLength(1);
  expect(saved.segments[0].sticker_group_id).toBe(saved.subtitle_groups.sticker[0].id);
  expect(saved.timebase.fps_source).toBe('user');
  expect(saved.waveform).toBeUndefined();
  await page.reload();
  await expect(page.locator('#cues-container')).toBeVisible();
  await openView(page);
  await expect(page.locator('#timed-text-edit-single-textarea')).toBeVisible();
  expect(await dirty(page)).toBe(false);
  await selectView(page, 'rows');
  expect(await dirty(page)).toBe(true);
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject())).toBe(true);
  expect(JSON.parse(readFileSync(projectPath, 'utf8')).timed_text_edit_view).toBeUndefined();
  expect(await dirty(page)).toBe(false);
});

test('a view switch reaches real autosave without a separate dirty flag', async ({ page }) => {
  await openView(page);
  await page.evaluate(() => MaweSettings.updateEditorSettings({ autoSaveProject: true }));
  const response = page.waitForResponse(r => r.url().endsWith('/api/project') && r.request().method() === 'POST');
  await selectView(page, 'single');
  expect((await response).ok()).toBe(true);
  await expect.poll(() => dirty(page)).toBe(false);
  expect(JSON.parse(readFileSync(projectPath, 'utf8')).timed_text_edit_view).toBe('single');
});

test('an in-flight view save confirms the sent preference while subsequent UI switches stay unsaved', async ({ page }) => {
  let release, arrived;
  const held = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { arrived = resolve; });
  await page.route('**/api/project', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    arrived();
    await held;
    await route.continue();
  });
  try {
    await openView(page);
    await selectView(page, 'single');
    await page.evaluate(() => { window.pendingViewSave = MaweProjectSave.saveCurrentProject(); });
    await received;
    await selectView(page, 'rows');
    release();
    expect(await page.evaluate(() => window.pendingViewSave)).toBe(true);
    expect(JSON.parse(readFileSync(projectPath, 'utf8')).timed_text_edit_view).toBe('single');
    expect(await dirty(page)).toBe(true);
    await selectView(page, 'single');
    expect(await dirty(page)).toBe(false);
  } finally { release(); }
});

test('invalid view import is atomic and runtime fallback preserves the saved single preference', async ({ page }) => {
  const rejected = await page.evaluate(async () => {
    const before = JSON.stringify(MaweBoot.DATA);
    const invalid = MaweJsonRepair.projectSnapshot();
    invalid.timed_text_edit_view = 'invalid';
    const accepted = await MaweMultiImport.openProjectFile(
      new File([JSON.stringify(invalid)], 'bad.mosp', { type: 'application/json' }),
      { suppressMediaPrompt: true },
    );
    return !accepted && before === JSON.stringify(MaweBoot.DATA);
  });
  expect(rejected).toBe(true);
  expect(await page.evaluate(async () => {
    MaweBoot.DATA.timed_text_edit_view = 'single';
    MaweBoot.DATA.segments[0].text = '甲\n乙';
    MaweBoot.DATA.segments[0].items = [];
    // Keep this fixture server-bound. Installing a different browser project
    // now intentionally retires the old server destination before publication.
    return MaweProjectSave.saveCurrentProject();
  })).toBe(true);
  await openView(page);
  await expect(page.locator('#timed-text-edit-rows')).toBeVisible();
  await expect(page.locator('#timed-text-edit-view [data-view="single"]')).toBeDisabled();
  expect(await dirty(page)).toBe(false);
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject())).toBe(true);
  expect(JSON.parse(readFileSync(projectPath, 'utf8')).timed_text_edit_view).toBe('single');
  expect(await dirty(page)).toBe(false);
});

test('backup-only writes preserve the preference without confirming the unsaved project', async ({ page }) => {
  const original = readFileSync(projectPath, 'utf8');
  await openView(page);
  await selectView(page, 'single');
  await page.evaluate(() => MaweSettings.updateEditorSettings({ projectBackupEnabled: true, projectBackupLimit: 5 }));
  expect(await page.evaluate(() => MaweProjectSave.saveProjectToServer({ backupOnly: true }))).toBe(true);
  expect(await dirty(page)).toBe(true);
  expect(readFileSync(projectPath, 'utf8')).toBe(original);
  const files = readdirSync(dir, { recursive: true }).filter(name => name.endsWith('.mosp-bak'));
  expect(files).toHaveLength(1);
  const backup = readFileSync(join(dir, files[0]), 'utf8');
  expect(JSON.parse(backup).timed_text_edit_view).toBe('single');
  const restored = await page.evaluate(async backup => {
    const accepted = await MaweMultiImport.openProjectFile(
      new File([backup], 'restored.mosp', { type: 'application/json' }), { suppressMediaPrompt: true },
    );
    return { accepted, preferred: MaweBoot.DATA.timed_text_edit_view,
      dirty: MaweServerSave.hasUnsavedProjectChanges() };
  }, backup);
  expect(restored).toEqual({ accepted: true, preferred: 'single', dirty: false });
});

test('style-aware splitting keeps stable group membership and globally unique IDs through undo and save', async ({ page }) => {
  const group = await page.evaluate(() => {
    MaweBoot.DATA.segments[0].text = '++甲乙丙++';
    MaweBoot.DATA.segments[0].items = [{ text: '甲乙丙', start: 0, end: 3000 }];
    MaweSettings.updateEditorSettings({ assMode: true, assSpecialSymbolRule: 'both' });
    MaweCuePanel.renderAll({ waveform: 'full' });
    const id = MaweBoot.DATA.segments[0].sticker_group_id;
    if (!MaweSplitCore.openMainWaveformSplitModal(0, 1000)) throw new Error('split modal did not open');
    MaweSplitCore.updateLinkedSplitPreview(3, 'main');
    return id;
  });
  await page.locator('#multi-subtitle-split-confirm').click();
  const result = await page.evaluate(() => {
    const cues = MaweBoot.DATA.segments;
    return { texts: cues.map(s => s.text), groups: cues.map(s => s.sticker_group_id),
      ids: window.AsrEditorUtils.subtitleGroupTracks(MaweBoot.DATA).flatMap(t => t.segments.map(s => s.id)),
      ranges: window.AsrEditorUtils.subtitleGroupRanges(MaweBoot.DATA).map(r => [r.start, r.end]) };
  });
  expect(result.texts).toEqual(['++甲++', '++乙丙++']);
  expect(result.groups).toEqual([group, group]);
  expect(new Set(result.ids).size).toBe(result.ids.length);
  expect(result.ranges).toEqual([[0, 3000]]);
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => MaweBoot.DATA.segments.map(s => s.text))).toEqual(['++甲乙丙++']);
  await page.locator('#redo-btn').click();
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject())).toBe(true);
  const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
  expect(saved.segments.map(s => s.sticker_group_id)).toEqual([group, group]);
});
