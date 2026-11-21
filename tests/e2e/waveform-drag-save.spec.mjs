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

test('select all while a boundary is held preserves the live waveform edit', async ({ page }) => {
  await openProject(page);
  await page.evaluate(() => MaweSelection.selectOnly(1));
  await holdBoundary(page);
  await expect.poll(() => readTimings(page)).toEqual(expected);
  await page.keyboard.press('Control+a');
  expect(await page.evaluate(() => [...MaweState.selection.indices('main')].sort())).toEqual([0, 1, 2]);
  expect(await readTimings(page)).toEqual(expected);
  await page.mouse.up();
  expect(await readTimings(page)).toEqual(expected);
});

for (const adjusted of [true, false]) {
  test(`keyboard panel edit after a held boundary ${adjusted ? 'move' : 'without movement'} is retained`, async ({ page }) => {
    await openProject(page);
    await page.locator('#cue-editor-settings-toggle').click();
    await page.locator('#cue-editor-show-time-actions').check();
    await page.locator('#cue-editor-settings-toggle').click();
    await page.evaluate(() => {
      MaweSettings.updateEditorSettings({clickBehavior: 'select-and-play'});
      MaweSelection.selectOnly(1);
    });
    await holdBoundary(page, adjusted);
    const duration = page.locator('#cue-panel-duration');
    await expect(duration).toBeVisible();
    for (let n = 0; n < 100 && !(await duration.evaluate(el => document.activeElement === el)); n++) {
      await page.keyboard.press('Shift+Tab');
    }
    await expect(duration).toBeFocused();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('7.000');
    await page.keyboard.press('Tab');
    await page.mouse.up();
    const seam = adjusted ? 10100 : 10000;
    await expect.poll(() => readTimings(page)).toEqual([{start: 5000, end: seam}, {start: seam, end: seam + 7000}, {start: 25000, end: 30000}]);
    expect(await page.locator('#player').evaluate(player => player.paused)).toBe(true);
  });
}

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
    await page.evaluate(() => MaweServerSave.scheduleAutoSaveFlush());
    await page.clock.runFor(400);
    expect(saves).toHaveLength(0);
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
      const saved = {writes: 0, content: ''};
      window.__heldSave = saved;
      const handle = {
        name: 'saved.mosp',
        async createWritable() {
          return {
            async write(blob) {
              saved.dragActiveAtWrite = Boolean(MaweCoreState.waveformEditor.drag);
              saved.undoLengthAtWrite = MaweHistory.editorHistory.undoLength();
              saved.content = await blob.text();
              saved.writes++;
            },
            async close() {},
          };
        },
      };
      if (asNew) window.showSaveFilePicker = async () => handle;
      else MaweServerSave.projectFileHandle = handle;
    }, saveAs);
    await page.keyboard.press(saveAs ? 'Control+Shift+s' : 'Control+s');
    await expect.poll(() => page.evaluate(() => window.__heldSave.writes)).toBe(1);
    const saved = await page.evaluate(() => window.__heldSave);
    expect(saved.dragActiveAtWrite).toBe(false);
    expect(saved.undoLengthAtWrite).toBe(historyBefore + 1);
    expect(timings(JSON.parse(saved.content))).toEqual(expected);
    await page.mouse.up();
    expect(await readTimings(page)).toEqual(expected);
    expect(await page.evaluate(() => MaweHistory.editorHistory.undoLength())).toBe(historyBefore + 1);
    await page.keyboard.press('Control+z');
    await expect.poll(() => readTimings(page)).toEqual(original);
  });
}

for (const gesture of ['alt cue', 'shared boundary']) {
  test(`explicit save cancels unchanged ${gesture} without clicking`, async ({ page }) => {
    await openProject(page);
    await page.evaluate(() => {
      MaweSettings.updateEditorSettings({ autoSaveProject: false, clickBehavior: 'select-and-play' });
      window.__heldSave = { writes: 0, content: '' };
      MaweServerSave.projectFileHandle = { name: 'saved.mosp', async createWritable() {
        return { async write(blob) { window.__heldSave.writes++; window.__heldSave.content = await blob.text(); }, async close() {} };
      } };
    });
    const target = gesture === 'alt cue'
      ? page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first()
      : page.locator('.waveform-cue-boundary[data-track="main"][data-left-idx="0"]').first();
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    const historyBefore = await page.evaluate(() => MaweHistory.editorHistory.undoLength());
    if (gesture === 'alt cue') await page.keyboard.down('Alt');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    if (gesture === 'alt cue') await page.keyboard.up('Alt');
    await expect(page.locator('#waveform-pane')).toHaveClass(/cue-drag-active/);
    const selection = await page.evaluate(() => [...MaweState.selection.indices('main')].sort());
    expect(await page.locator('#player').evaluate(player => player.paused)).toBe(true);
    await page.evaluate(() => MaweProjectSave.saveCurrentProject());
    expect(await page.locator('#player').evaluate(player => player.paused)).toBe(true);
    await expect(page.locator('#waveform-pane')).not.toHaveClass(/cue-drag-active/);
    await page.mouse.up();
    expect(await page.locator('#player').evaluate(player => player.paused)).toBe(true);
    expect(await page.evaluate(() => [...MaweState.selection.indices('main')].sort())).toEqual(selection);
    expect(await page.evaluate(() => Boolean(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].disabled))).toBe(false);
    expect(await page.evaluate(() => MaweHistory.editorHistory.undoLength())).toBe(historyBefore);
    expect(await page.evaluate(() => ({ writes: window.__heldSave.writes, disabled: Boolean(AsrEditorUtils.getMainTrack(JSON.parse(window.__heldSave.content)).segments[0].disabled) })))
      .toEqual({ writes: 1, disabled: false });
  });
}

test('quick-edit text and a held boundary both survive save and undo separately', async ({ page }) => {
  await openProject(page);
  const historyBefore = await page.evaluate(() => MaweHistory.editorHistory.undoLength());
  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="2"]').first();
  await block.dblclick();
  const input = page.locator('.waveform-cue-quick-edit textarea');
  await expect(input).toHaveValue('Third');
  await input.fill('Quick edit retained');
  await holdBoundary(page);
  await expect(page.locator('.waveform-cue-quick-edit')).toHaveCount(0);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/project')
    && response.request().method() === 'POST');
  await page.keyboard.press('Control+s');
  expect((await saved).ok()).toBe(true);
  await page.mouse.up();
  const project = JSON.parse(readFileSync(projectPath, 'utf8'));
  expect(timings(project)).toEqual(expected);
  expect(project.tracks.find(track => track.role === 'main').segments[2].text).toBe('Quick edit retained');
  expect(await page.evaluate(() => MaweHistory.editorHistory.undoLength())).toBe(historyBefore + 2);
  await page.keyboard.press('Control+z');
  await expect.poll(() => readTimings(page)).toEqual(original);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[2].text)).toBe('Quick edit retained');
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[2].text)).toBe('Third');
});
