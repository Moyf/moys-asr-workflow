import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, DURATION_MS, findFreePort,
  generateProjectJson, generateWav, makeTempDir, startServer } from './helpers.mjs';

let tempDir, server;
test.beforeAll(async () => {
  tempDir = makeTempDir('editor-transactions');
  const media = join(tempDir, 'synthetic.wav'), project = join(tempDir, 'project.json');
  generateWav(media, DURATION_MS / 1000);
  generateProjectJson(project);
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
});

async function snapshot(page) {
  return page.evaluate(() => ({
    segments: MaweBoot.DATA.segments,
    multi: MaweBoot.DATA.multi_subtitle,
    undo: MaweHistory.editorHistory.undoLength(),
    redo: MaweHistory.editorHistory.redoLength(),
    dirty: MaweServerSave.hasUnsavedProjectChanges(),
  }));
}
async function seedRedo(page) {
  await page.evaluate(() => {
    MaweSegmentOps.mergeSegments([0, 1]);
    MaweHistory.performUndo();
    MaweSelection.selectOnly(0);
  });
  expect((await snapshot(page)).redo).toBe(1);
}
async function beginDrag(page) {
  await page.evaluate(() => {
    const wave = MaweCoreState.waveformEditor;
    wave.settings.mode = 'multi'; wave.settings.secondsPerRow = 5; wave.render();
  });
  const handle = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"] .waveform-cue-handle.right').first();
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  if (!box) throw new Error('No cue boundary geometry');
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 30, point.y, { steps: 5 });
  await page.waitForFunction(() => MaweCoreState.waveformEditor.drag?.started === true);
  return point;
}

test('deleting a clean cue becomes dirty, and undo restores the previous clean state', async ({ page }) => {
  const before = await snapshot(page);
  expect(before.dirty).toBe(false);
  await page.locator('.cue[data-idx="1"] .text').click();
  await page.keyboard.press('Delete');
  const changed = await snapshot(page);
  expect(changed.segments.length).toBe(before.segments.length - 1);
  expect(changed.dirty).toBe(true);
  expect(changed.undo).toBe(before.undo + 1);
  await page.locator('#undo-btn').click();
  const restored = await snapshot(page);
  expect(restored.segments).toEqual(before.segments);
  expect(restored.dirty).toBe(false);
  await page.locator('#redo-btn').click();
  expect((await snapshot(page)).dirty).toBe(true);
});

test('cancelled waveform preview restores data and preserves redo without publishing an undo', async ({ page }) => {
  await seedRedo(page);
  const before = await snapshot(page);
  await beginDrag(page);
  const preview = await snapshot(page);
  expect(preview.undo).toBe(before.undo);
  expect(preview.redo).toBe(before.redo);
  await page.evaluate(() => {
    const pointerId = MaweCoreState.waveformEditor.drag.pointerId;
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId }));
  });
  await page.mouse.up();
  expect(await snapshot(page)).toEqual(before);
});

test('waveform preview returning to its origin preserves history and the clean state', async ({ page }) => {
  await seedRedo(page);
  const before = await snapshot(page);
  const point = await beginDrag(page);
  await page.mouse.move(point.x, point.y, { steps: 5 });
  await page.mouse.up();
  expect(await snapshot(page)).toEqual(before);
});

test('cancelling cue-panel text restores the original without clearing redo', async ({ page }) => {
  await page.evaluate(() => MaweSettings.updateEditorSettings({ cueEditorCancelOnEscape: true }));
  await seedRedo(page);
  const before = await snapshot(page);
  const panel = page.locator('#cue-panel-text');
  await panel.focus();
  await panel.press('End');
  await panel.pressSequentially(' added');
  expect((await snapshot(page)).undo).toBe(before.undo);
  await panel.press('Escape');
  expect(await snapshot(page)).toEqual(before);
});

async function bindMemoryFile(page) {
  await page.evaluate(() => {
    MaweServerSave.projectFileHandle = {
      name: 'saved.mosp',
      async createWritable() { return { async write() {}, async close() {} }; },
    };
  });
}

test('undo after saving marks changed content dirty and redo back to the saved content is clean', async ({ page }) => {
  await bindMemoryFile(page);
  await page.evaluate(() => MaweSegmentOps.mergeSegments([0, 1]));
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(true);
  expect((await snapshot(page)).dirty).toBe(false);
  await page.locator('#undo-btn').click();
  expect((await snapshot(page)).dirty).toBe(true);
  await page.locator('#redo-btn').click();
  expect((await snapshot(page)).dirty).toBe(false);
});

test('saving clears overlay and extension track dirty flags', async ({ page }) => {
  await bindMemoryFile(page);
  await page.evaluate(() => {
    MaweState.project.overlay_track._dirty = true;
    MaweState.project.overlay_track.segments.push({ id: 'overlay-save', start: 0, end: 1000, text: 'Overlay', _dirty: true });
    MaweState.project.multi_subtitle.tracks.push({ id: 'extension-save', name: 'Extension', _dirty: true,
      segments: [{ id: 'ext-save', start: 0, end: 1000, text: 'Extension', _dirty: true }] });
  });
  expect((await snapshot(page)).dirty).toBe(true);
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(true);
  expect((await snapshot(page)).dirty).toBe(false);
});

test('saving focused panel text publishes it once and preserves typing focus', async ({ page }) => {
  await bindMemoryFile(page);
  await page.evaluate(() => MaweSelection.selectOnly(0));
  const panel = page.locator('#cue-panel-text');
  await panel.focus();
  await panel.press('End');
  await panel.pressSequentially(' saved');
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(true);
  expect((await snapshot(page)).dirty).toBe(false);
  expect((await snapshot(page)).undo).toBe(1);
  await expect(panel).toBeFocused();
  await panel.pressSequentially(' later');
  await panel.press('Escape');
  expect((await snapshot(page)).undo).toBe(2);
  await page.locator('#undo-btn').click();
  expect((await snapshot(page)).segments[0].text).toBe('Alpha saved');
  expect((await snapshot(page)).dirty).toBe(false);
});

for (const saveAs of [false, true]) {
  test(`${saveAs ? 'save as' : 'save'} keeps overlay edits made during the write dirty`, async ({ page }) => {
    await page.evaluate(saveAs => {
      let releaseWrite;
      const writing = new Promise(resolve => { releaseWrite = resolve; });
      window.__transactionWrite = { ready: false, release: releaseWrite };
      const handle = { name: 'written.mosp', async createWritable() {
        return { async write(blob) {
          window.__transactionWrite.content = await blob.text();
          window.__transactionWrite.ready = true;
          await writing;
        }, async close() {} };
      } };
      if (saveAs) window.showSaveFilePicker = async () => handle;
      else MaweServerSave.projectFileHandle = handle;
      window.__transactionWrite.save = saveAs ? MaweProjectSave.saveProjectAsToFile()
        : MaweProjectSave.saveCurrentProject({ silent: true });
    }, saveAs);
    await page.waitForFunction(() => window.__transactionWrite.ready);
    await page.evaluate(() => {
      MaweCommands.run('add overlay during save', () => {
        MaweState.project.overlay_track.enabled = true;
        MaweState.project.overlay_track.segments.push({ id: 'in-flight', start: 0, end: 1000, text: 'Later' });
      }, { invalidate: { cueList: true } });
      window.__transactionWrite.release();
    });
    await page.evaluate(() => window.__transactionWrite.save);
    expect((await snapshot(page)).dirty).toBe(true);
    expect(await page.evaluate(() => JSON.parse(window.__transactionWrite.content).overlay_track?.segments?.length || 0)).toBe(0);
    await page.locator('#undo-btn').click();
    expect((await snapshot(page)).dirty).toBe(false);
  });
}

test('a failed command rolls back data and leaves the history branches intact', async ({ page }) => {
  await seedRedo(page);
  const before = await snapshot(page);
  const message = await page.evaluate(() => {
    try {
      MaweCommands.run('test rollback', () => {
        MaweState.project.segments[0].text = 'discard this mutation';
        throw new Error('mutation failed');
      });
    } catch (error) { return error.message; }
  });
  expect(message).toBe('mutation failed');
  expect(await snapshot(page)).toEqual(before);
});
