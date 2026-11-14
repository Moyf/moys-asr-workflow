import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir, DURATION_MS, findFreePort, generateProjectJson, generateWav, makeTempDir, startServer,
} from './helpers.mjs';

let server, tempDir, projectPath;
test.beforeAll(async () => {
  tempDir = makeTempDir('waveform-drag-save');
  projectPath = join(tempDir, 'project.json');
  const media = join(tempDir, 'synthetic.wav');
  generateWav(media, DURATION_MS / 1000);
  generateProjectJson(projectPath);
  server = await startServer(projectPath, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });

async function openProject(page) {
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed');
    localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({autoSaveProject: false, cueMoveStepMs: 100}));
  });
  await page.goto(server.url);
  await page.evaluate(() => {
    const cues = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments;
    cues.splice(0, cues.length,
      {id: 'cue-a', start: 5000, end: 10000, text: 'First', items: []},
      {id: 'cue-b', start: 10000, end: 18000, text: 'Second', items: []},
      {id: 'cue-c', start: 25000, end: 30000, text: 'Third', items: []});
    MaweCuePanel.renderAll();
    MaweCoreState.waveformEditor.refreshCueOverlay();
  });
  expect(await page.evaluate(() => MaweServerSave.requiresMigrationSaveAs)).toBe(false);
}

async function holdBoundary(page, adjust = true) {
  const boundary = page.locator('.waveform-cue-boundary').first();
  await expect(boundary).toBeVisible();
  const box = await boundary.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator('#waveform-pane')).toHaveClass(/shared-boundary-drag-active/);
  if (adjust) await page.keyboard.press('d');
}

const expected = [{start: 5000, end: 10100}, {start: 10100, end: 18000}, {start: 25000, end: 30000}];
const original = [{start: 5000, end: 10000}, {start: 10000, end: 18000}, {start: 25000, end: 30000}];
const timings = project => project.tracks.find(track => track.role === 'main').segments.map(({start, end}) => ({start, end}));
const readTimings = page => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(({start, end}) => ({start, end})));

for (const finish of ['commit', 'cancel', 'no movement']) {
  test(`autosave waits for the held boundary and saves ${finish}`, async ({ page }) => {
    await openProject(page);
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.evaluate(label => {
      AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[2].text = `Prior edit: ${label}`;
      MaweState.markProjectDirty();
      MaweSettings.updateEditorSettings({autoSaveProject: true, cueMoveStepMs: 100});
    }, finish);
    const saves = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/project') saves.push(request.postDataJSON());
    });
    await holdBoundary(page, finish !== 'no movement');
    const preview = finish === 'no movement' ? original : expected;
    await expect.poll(() => readTimings(page)).toEqual(preview);
    await page.evaluate(() => {
      window.__snapshotReads = 0;
      MaweState.setSnapshotReader(() => { window.__snapshotReads++; return MaweJsonRepair.projectSnapshot(); });
      MaweServerSave.scheduleAutoSaveFlush();
    });
    await page.clock.runFor(400);
    expect(saves).toHaveLength(0);
    expect(await page.evaluate(() => window.__snapshotReads)).toBe(0);
    expect(await readTimings(page)).toEqual(preview);
    if (finish === 'cancel') await page.keyboard.press('Escape');
    await page.mouse.up();
    const result = finish === 'commit' ? expected : original;
    await expect.poll(() => readTimings(page)).toEqual(result);
    await page.clock.runFor(400);
    await expect.poll(() => saves.length).toBeGreaterThan(0);
    await expect.poll(() => timings(JSON.parse(readFileSync(projectPath, 'utf8')))).toEqual(result);
    await expect.poll(() => page.evaluate(() => MaweServerSave.projectSaveInFlight)).toBe(false);
    await page.reload();
    await expect.poll(() => readTimings(page)).toEqual(result);
    expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[2].text)).toBe(`Prior edit: ${finish}`);
  });
}

test('periodic backup skips an unfinished waveform preview', async ({ page }) => {
  await openProject(page);
  await page.evaluate(() => MaweSettings.updateEditorSettings({projectBackupEnabled: true, autoSaveProject: false}));
  const saves = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/project') saves.push(request.postDataJSON());
  });
  await holdBoundary(page);
  expect(await page.evaluate(() => MaweProjectSave.saveProjectToServer({silent: true, backupOnly: true}))).toBe(false);
  expect(saves).toHaveLength(0);
  expect(await readTimings(page)).toEqual(expected);
  await page.mouse.up();
});

for (const saveAs of [false, true]) {
  test(`explicit ${saveAs ? 'save as' : 'save'} completes a held drag once`, async ({ page }) => {
    await openProject(page);
    const historyBefore = await page.evaluate(() => MaweHistory.editorHistory.undoLength());
    await holdBoundary(page);
    await page.evaluate(asNew => {
      window.__heldSave = {writes: 0, content: ''};
      const handle = {name: 'saved.mosp', async createWritable() {
        return {async write(blob) { window.__heldSave.writes++; window.__heldSave.content = await blob.text(); }, async close() {}};
      }};
      if (asNew) window.showSaveFilePicker = async () => handle;
      else MaweServerSave.projectFileHandle = handle;
    }, saveAs);
    await page.keyboard.press(saveAs ? 'Control+Shift+s' : 'Control+s');
    await expect.poll(() => page.evaluate(() => window.__heldSave.writes)).toBe(1);
    expect(timings(JSON.parse(await page.evaluate(() => window.__heldSave.content)))).toEqual(expected);
    await page.mouse.up();
    expect(await readTimings(page)).toEqual(expected);
    expect(await page.evaluate(() => MaweHistory.editorHistory.undoLength())).toBe(historyBefore + 1);
    await page.keyboard.press('Control+z');
    await expect.poll(() => readTimings(page)).toEqual(original);
  });
}
