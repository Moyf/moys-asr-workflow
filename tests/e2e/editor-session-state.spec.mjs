import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateProjectJson,
  generateWav, makeTempDir, startServer } from './helpers.mjs';

let tempDir, server, projectPath;
test.beforeAll(async () => {
  tempDir = makeTempDir('session-state');
  const mediaPath = join(tempDir, 'synthetic.wav');
  projectPath = join(tempDir, 'project.mosp');
  generateWav(mediaPath, 1);
  generateProjectJson(projectPath);
  const project = JSON.parse(readFileSync(projectPath, 'utf8'));
  project.preserve_punctuation = true;
  project.segments.forEach((segment, index) => { segment.id = `s${index}`; segment._dirty = true; });
  project.multi_subtitle = { enabled: true, tracks: [{ id: 'e', name: 'extension', _dirty: true,
    segments: [{ id: 'e1', start: 0, end: 1000, text: 'Extension', items: [], _dirty: true }] }] };
  project.overlay_track = { enabled: true, _dirty: true,
    segments: [{ id: 'o1', start: 0, end: 1000, text: 'Overlay', items: [], _dirty: true }] };
  writeFileSync(projectPath, JSON.stringify(project));
  server = await startServer(projectPath, mediaPath, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => window.MaweState && window.MaweProjectSave);
  await page.evaluate(() => MaweSettings.updateEditorSettings({ autoSaveProject: false }));
});
const dirty = page => page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges());

for (const saveAs of [false, true]) {
  test(`file ${saveAs ? 'save-as' : 'save'} rebases media without leaving the runtime checkpoint dirty`, async ({ page }) => {
    const result = await page.evaluate(async saveAs => {
      const originalMedia = MaweBoot.DATA.media;
      const nativeMedia = MaweBoot.SERVER_CONFIG.autoLoadedMediaPath;
      let written;
      const handle = { name: 'relocated.mosp', async createWritable() {
        return { async write(blob) { written = JSON.parse(await blob.text()); }, async close() {} };
      } };
      if (saveAs) window.showSaveFilePicker = async () => handle;
      else MaweServerSave.projectFileHandle = handle;
      if (saveAs) await MaweProjectSave.saveProjectAsToFile();
      else await MaweProjectSave.saveCurrentProject({ silent: true });
      const clean = !MaweServerSave.hasUnsavedProjectChanges();
      MaweBoot.DATA.media = 'another.wav';
      const mediaEditIsDirty = MaweServerSave.hasUnsavedProjectChanges();
      MaweBoot.DATA.media = originalMedia;
      return { originalMedia, nativeMedia, writtenMedia: written.media, clean, mediaEditIsDirty,
        restoredIsClean: !MaweServerSave.hasUnsavedProjectChanges(),
        sessionFlagsSaved: JSON.stringify(written).includes('"_dirty"') };
    }, saveAs);
    expect(result.nativeMedia).toBeTruthy();
    expect(result.writtenMedia).toBe(result.nativeMedia);
    expect(result.writtenMedia).not.toBe(result.originalMedia);
    expect(result.clean).toBe(true);
    expect(result.mediaEditIsDirty).toBe(true);
    expect(result.restoredIsClean).toBe(true);
    expect(result.sessionFlagsSaved).toBe(false);
  });
}

test('legacy flags vanish; real panel edit saves without clearing highlight, then reload resets it', async ({ page }) => {
  expect(await dirty(page)).toBe(false);
  expect(await page.evaluate(() => JSON.stringify(MaweBoot.DATA).includes('"_dirty":true'))).toBe(false);
  await page.locator('.cue[data-idx="0"]').click();
  await page.locator('#cue-panel-text').fill('Session edited');
  expect(await dirty(page)).toBe(true);
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0]._dirty)).toBe(true);
  await page.keyboard.press('Control+s');
  await expect.poll(() => dirty(page)).toBe(false);
  await expect(page.locator('.cue[data-idx="0"] .multi-cue-column.main')).toHaveClass(/dirty/);
  const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
  expect(saved.segments[0].text).toBe('Session edited');
  expect(JSON.stringify(saved)).not.toContain('"_dirty"');
  await page.screenshot({ path: test.info().outputPath('saved-session-highlight.png') });
  await page.reload();
  await expect(page.locator('.cue[data-idx="0"] .multi-cue-column.main')).not.toHaveClass(/dirty/);
  expect(await dirty(page)).toBe(false);
});

test('save in flight acknowledges only sent bytes; undo reaches checkpoint and failure leaves changes', async ({ page }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let arrived;
  const received = new Promise(resolve => { arrived = resolve; });
  await page.route('**/api/project', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    arrived();
    await held;
    await route.continue();
  });
  await page.evaluate(() => {
    MaweCommands.run('first edit', () => { MaweBoot.DATA.segments[0].text = 'First'; MaweBoot.DATA.segments[0].items = []; MaweBoot.DATA.segments[0]._dirty = true; });
    window.sessionSave = MaweProjectSave.saveCurrentProject();
  });
  await received;
  await page.evaluate(() => MaweCommands.run('during save', () => { MaweBoot.DATA.segments[1].text = 'Later'; MaweBoot.DATA.segments[1].items = []; MaweBoot.DATA.segments[1]._dirty = true; }));
  release();
  expect(await page.evaluate(() => window.sessionSave)).toBe(true);
  expect(await dirty(page)).toBe(true);
  expect(JSON.parse(readFileSync(projectPath, 'utf8')).segments[1].text).not.toBe('Later');
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await dirty(page)).toBe(false);
  expect(await page.evaluate(() => MaweBoot.DATA.segments[1]._dirty)).toBe(true);
  await page.unroute('**/api/project');
  await page.route('**/api/project', route => route.fulfill({ status: 500, json: { ok: false, error: 'test write failure' } }));
  await page.evaluate(() => MaweHistory.performRedo());
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject())).toBe(false);
  expect(await dirty(page)).toBe(true);
});

test('late save response cannot rename or clear a newly loaded project', async ({ page }) => {
  let release, arrived;
  const held = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { arrived = resolve; });
  await page.route('**/api/project', async route => {
    arrived(); await held;
    await route.fulfill({ json: { ok: true, filename: 'stale.mosp' } });
  });
  await page.evaluate(() => { window.sessionSave = MaweProjectSave.saveCurrentProject(); });
  await received;
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ segments: [{ id: 'new', start: 0, end: 1000, text: 'new', items: [], _dirty: true }] }, 'new.mosp');
    MaweBoot.DATA.segments[0].text = 'new edit';
  });
  release();
  expect(await page.evaluate(() => window.sessionSave)).toBe(false);
  expect(await page.evaluate(() => MaweBoot.PROJECT_NAME)).toBe('new');
  expect(await dirty(page)).toBe(true);
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0]._dirty)).toBeUndefined();
});

test('pure snapshot covers non-subtitle persistence, preserves pos and never repairs invalid timing', async ({ page }) => {
  const result = await page.evaluate(() => {
    const changes = [];
    const check = mutation => {
      MaweState.establishProjectCheckpoint(); mutation();
      changes.push(MaweServerSave.hasUnsavedProjectChanges());
    };
    check(() => { MaweBoot.DATA.timebase.fps = 25; });
    check(() => { MaweBoot.DATA.media = 'another.wav'; });
    check(() => { MaweBoot.DATA.markers = [{ id: 'm1', start: 200, end: 200, name: 'marker', color: '#ffffff' }]; });
    check(() => { MaweBoot.DATA.segments[0].assOverride = { pos: { x: -12, y: 80 } }; });
    MaweState.establishProjectCheckpoint();
    MaweBoot.DATA.segments[0].end = -1;
    const before = JSON.stringify(MaweBoot.DATA);
    const fingerprint = MaweState.projectFingerprint();
    MaweServerSave.hasUnsavedProjectChanges();
    return { changes, unchanged: before === JSON.stringify(MaweBoot.DATA),
      pos: JSON.parse(fingerprint).segments[0].assOverride.pos };
  });
  expect(result.changes).toEqual([true, true, true, true]);
  expect(result.unchanged).toBe(true);
  expect(result.pos).toEqual({ x: -12, y: 80 });
});


test('browser import distinguishes ignored legacy flags from actual timing repairs', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const make = end => new File([JSON.stringify({ segments: [
      { id: 'imported', start: 100, end, text: 'Imported', items: [], _dirty: true },
    ] })], 'imported.mosp', { type: 'application/json' });
    const loaded = await MaweMultiImport.openProjectFile(make(1000));
    const clean = !MaweServerSave.hasUnsavedProjectChanges();
    const unhighlighted = !MaweBoot.DATA.segments[0]._dirty;
    const repairedLoaded = await MaweMultiImport.openProjectFile(make(100));
    return { loaded, clean, unhighlighted, repairedLoaded,
      dirty: MaweServerSave.hasUnsavedProjectChanges(), end: MaweBoot.DATA.segments[0].end,
      report: MaweJsonRepair.lastImportReport };
  });
  expect(result).toMatchObject({ loaded: true, clean: true, unhighlighted: true, repairedLoaded: true, dirty: true, end: 200 });
  expect(result.report).toContainEqual({ path: '$.segments[0].end', kind: 'replace', before: 100, after: 200 });
});
