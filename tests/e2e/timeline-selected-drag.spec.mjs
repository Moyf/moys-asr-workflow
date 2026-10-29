import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  buildBrowserEditorFixture, cleanupTempDir, disableOnboarding, findFreePort,
  generateWaveformPayload, makeTempDir, startStaticServer,
} from './helpers.mjs';

let tempDir;
let server;
test.beforeAll(async () => {
  tempDir = makeTempDir('timeline-selected-drag');
  server = await startStaticServer(buildBrowserEditorFixture(join(tempDir, 'blank.html')), await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });

async function seed(page, { neighbor = false, frames = false } = {}) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(({ waveform, neighbor, frames }) => {
    const cue = (id, start, end) => ({ id, start, end, text: id, items: [{ start, end, text: id }] });
    MaweProjectLoad.applyCanonicalProject({
      segments: [cue('main', 1000, 2000)],
      overlay_track: { enabled: true, segments: [cue('overlay', 1300, 2300)] },
      multi_subtitle: {
        schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
        tracks: [{ id: 'translation', role: 'extension', segments: [
          cue('extension', 1100, 2100),
          ...(neighbor ? [cue('unselected', 2600, 3600)] : []),
        ] }],
        bindings: [{ id: 'bound', track_id: 'translation', main_segment_ids: ['main'],
          extension_segment_ids: ['extension'], start_offset_ms: 100, end_offset_ms: 100 }],
      },
      markers: { schema: 'moy.asr.markers.v1', items: [
        { id: 'point', start: 9000, name: 'Point' },
        { id: 'region', start: 7000, end: 9000, name: 'Region' },
      ] },
      waveform,
      ...(frames ? { timebase: { unit: 'frames', fps: 25 } } : {}),
    }, 'drag.mosp');
    MaweSettings.EDITOR_SETTINGS.autoSnapAdjacentCues = true;
    MaweSettings.EDITOR_SETTINGS.crossTrackSnap = true;
    MaweSettings.EDITOR_SETTINGS.clickBehavior = 'select-only';
    MaweSettings.EDITOR_SETTINGS.markerEditingEnabled = true;
    const wave = MaweCoreState.waveformEditor;
    wave.settings.mode = 'multi';
    wave.settings.secondsPerRow = 10;
    wave.scroll.style.width = '720px';
    wave.render();
    MaweSelection.selectAll();
    if (neighbor) { MaweState.selection.remove('extension', 1); wave.updateSelection(); }
  }, { waveform: generateWaveformPayload(60000), neighbor, frames });
  await expect(page.locator('.waveform-row[data-row-index="0"]')).toBeVisible();
}

function ranges(page) {
  return page.evaluate(() => [AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).segments,
    AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments].map((segments) =>
    segments.map(({ start, end, items }) => ({ start, end, items: items.map(({ start, end }) => [start, end]) }))));
}

async function grab(page, selector) {
  const block = page.locator(selector).first();
  const box = await block.boundingBox();
  expect(box).not.toBeNull();
  const geometry = await block.evaluate((element) => {
    const row = element.closest('.waveform-row');
    const rect = row.getBoundingClientRect();
    return { left: rect.left + row.clientLeft, width: row.clientWidth,
      start: Number(row.dataset.startMs), end: Number(row.dataset.endMs) };
  });
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  return { x, y, geometry, msPerPixel: (geometry.end - geometry.start) / geometry.width };
}

for (const track of ['main', 'overlay', 'extension']) {
  test(`dragging selected ${track} moves all three tracks once and undoes together`, async ({ page }) => {
    await seed(page);
    const before = await ranges(page);
    const drag = await grab(page, `.waveform-cue-block[data-track="${track}"]`);
    await page.mouse.move(drag.x + 1000 / drag.msPerPixel, drag.y, { steps: 6 });
    await expect.poll(async () => (await ranges(page))[0][0].start).toBeGreaterThan(1900);
    const after = await ranges(page);
    const delta = after[0][0].start - before[0][0].start;
    expect(delta).toBeCloseTo(1000, -1);
    after.forEach((segments, trackIndex) => segments.forEach((segment, index) => {
      const original = before[trackIndex][index];
      expect(segment).toEqual({ start: original.start + delta, end: original.end + delta,
        items: original.items.map(([start, end]) => [start + delta, end + delta]) });
    }));
    await page.mouse.up();
    expect(await ranges(page)).toEqual(after);
    await page.locator('#undo-btn').click();
    expect(await ranges(page)).toEqual(before);
    await page.locator('#redo-btn').click();
    expect(await ranges(page)).toEqual(after);
  });
}

test('an unselected neighbor clamps the entire selection; Escape restores every track', async ({ page }) => {
  await seed(page, { neighbor: true });
  const before = await ranges(page);
  const drag = await grab(page, '.waveform-cue-block[data-track="overlay"]');
  await page.mouse.move(drag.x + 1500 / drag.msPerPixel, drag.y, { steps: 6 });
  const after = await ranges(page);
  expect(after.map((track) => track[0].start)).toEqual([1500, 1800, 1600]);
  expect(after[2][1]).toEqual(before[2][1]);
  await page.keyboard.press('Escape');
  expect(await ranges(page)).toEqual(before);
  await page.mouse.up();
});

for (const action of ['undo', 'redo']) {
  for (const entry of ['keyboard', 'toolbar']) {
    test(`${entry} ${action} cancels a held multi-track drag and preserves the existing history`, async ({ page }) => {
      await seed(page);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(() => MaweCommands.run('edit main text', () => {
        AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text = 'previous edit';
      }, { invalidate: { cueList: true } }));
      if (action === 'redo') await page.evaluate(() => MaweHistory.performUndo());
      await page.evaluate(() => MaweSelection.selectAll());
      const before = await ranges(page);
      const lengths = await page.evaluate(() => [MaweHistory.editorHistory.undoLength(), MaweHistory.editorHistory.redoLength()]);
      // The fixture edit must update the cue panel as a normal edit does;
      // otherwise selecting cues commits the stale panel text as another edit.
      expect(lengths).toEqual(action === 'undo' ? [1, 0] : [0, 1]);
      const request = async () => {
        if (entry === 'keyboard') await page.keyboard.press(action === 'undo' ? 'Control+z' : 'Control+y');
        // Dispatch the actual button handler while the pointer is still held.
        else await page.locator(`#${action}-btn`).dispatchEvent('click');
      };
      const drag = await grab(page, '.waveform-cue-block[data-track="overlay"]');
      await page.mouse.move(drag.x + 500 / drag.msPerPixel, drag.y, { steps: 4 });
      expect(await ranges(page)).not.toEqual(before);
      await request();
      expect(await page.evaluate(() => Boolean(MaweCoreState.waveformEditor.drag))).toBe(false);
      expect(await ranges(page)).toEqual(before);
      expect(await page.evaluate(() => [MaweHistory.editorHistory.undoLength(), MaweHistory.editorHistory.redoLength()])).toEqual(lengths);
      await page.mouse.move(drag.x + 700 / drag.msPerPixel, drag.y);
      await page.mouse.up();
      expect(await ranges(page)).toEqual(before);
      if (entry === 'keyboard') expect(await page.evaluate(() => MaweHistory.historyGuarded())).toBe(false);
      await request();
      expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe(action === 'undo' ? 'main' : 'previous edit');
      expect(errors).toEqual([]);
    });
  }
}

async function expectPointerAtPending(page, edge) {
  const line = page.locator('.waveform-pointer-line.boundary-snapped:not([hidden])');
  await expect(line).toHaveCount(1);
  expect(await line.evaluate((element, edge) => {
    const wave = MaweCoreState.waveformEditor;
    const time = wave.markerDrag.pending[edge];
    const row = element.closest('.waveform-row');
    const expected = (time - Number(row.dataset.startMs))
      / (Number(row.dataset.endMs) - Number(row.dataset.startMs)) * row.clientWidth;
    return Math.abs(parseFloat(element.style.left) - expected);
  }, edge)).toBeLessThan(1);
}

for (const [id, handle, edge] of [['point', '', 'start'], ['region', '', 'start'],
  ['region', ' .waveform-marker-handle.right', 'end'], ['region', ' .waveform-marker-handle.left', 'start']]) {
  test(`${id}${handle || ' body'} crosses the row edge with the pointer at its actual time`, async ({ page }) => {
    await seed(page);
    if (handle.includes('right')) await page.evaluate(() => {
      MaweMarkerEditing.findMarker('point').start = 5000;
      MaweMarkerEditing.afterExternalMarkersChange();
    });
    const original = await page.evaluate((id) => ({ ...MaweMarkerEditing.findMarker(id) }), id);
    const drag = await grab(page, `.waveform-marker-item[data-marker-id="${id}"]${handle}`);
    expect(await page.evaluate(() => MaweCoreState.waveformEditor.markerDrag.markerId)).toBe(id);
    await expectPointerAtPending(page, edge);
    const target = handle.includes('left') ? -2000 : 13000;
    await page.mouse.move(drag.geometry.left + (target - drag.geometry.start) / drag.msPerPixel, drag.y, { steps: 8 });
    await expect.poll(() => page.evaluate((edge) => MaweCoreState.waveformEditor.markerDrag.pending[edge], edge))
      .toBe(handle.includes('left') ? 0 : handle ? 13000 : 13000 - Math.round((drag.x - drag.geometry.left) * drag.msPerPixel - original.start));
    await expectPointerAtPending(page, edge);
    const pending = await page.evaluate(() => ({ ...MaweCoreState.waveformEditor.markerDrag.pending }));
    if (id === 'region' && !handle) expect(pending.end - pending.start).toBe(original.end - original.start);
    if (id === 'region' && !handle) await page.locator('#waveform-pane').screenshot({ path: test.info().outputPath('region-drag-actual-time.png') });
    await page.mouse.up();
    await expect(page.locator('.waveform-pointer-line.boundary-snapped')).toHaveCount(0);
    expect(await page.evaluate((id) => MaweMarkerEditing.findMarker(id).start, id)).toBe(pending.start);
    await page.locator('#undo-btn').click();
    expect(await page.evaluate((id) => MaweMarkerEditing.findMarker(id).start, id)).toBe(original.start);
  });
}

test('marker cancellation clears previews and leaves persisted times unchanged', async ({ page }) => {
  await seed(page);
  const selection = await page.evaluate(() => [...MaweSelection.selectedIdxs]);
  const drag = await grab(page, '.waveform-marker-item[data-marker-id="region"] .waveform-marker-handle.right');
  await page.mouse.move(drag.x + 1000 / drag.msPerPixel, drag.y, { steps: 4 });
  await expect(page.locator('.waveform-marker-item.drag-preview')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.waveform-marker-item.drag-preview')).toHaveCount(0);
  await expect(page.locator('.waveform-pointer-line.boundary-snapped')).toHaveCount(0);
  expect(await page.evaluate(() => MaweMarkerEditing.findMarker('region').end)).toBe(9000);
  expect(await page.evaluate(() => [...MaweSelection.selectedIdxs])).toEqual(selection);
  await page.mouse.up();
  expect(await page.evaluate(() => MaweMarkerEditing.findMarker('region').end)).toBe(9000);
});

test('selected blocks render together on their destination row while held', async ({ page }) => {
  await seed(page);
  const drag = await grab(page, '.waveform-cue-block[data-track="main"]');
  await page.mouse.move(drag.x + 10500 / drag.msPerPixel, drag.y, { steps: 8 });
  for (const track of ['main', 'overlay', 'extension']) {
    await expect(page.locator(`.waveform-row[data-row-index="1"] .waveform-cue-block[data-track="${track}"]`)).toBeVisible();
  }
  await page.mouse.up();
});
test('Escape cancels marker creation without changing selected cues or saved markers', async ({ page }) => {
  await seed(page);
  const before = await page.evaluate(() => ({
    selection: [...MaweSelection.selectedIdxs], markers: JSON.stringify(MaweBoot.DATA.markers),
    history: [MaweHistory.editorHistory.undoLength(), MaweHistory.editorHistory.redoLength()],
  }));
  const drag = await grab(page, '.waveform-marker-track');
  await page.mouse.move(drag.x + 1000 / drag.msPerPixel, drag.y, { steps: 4 });
  expect(await page.evaluate(() => Boolean(MaweCoreState.waveformEditor.markerCreateDrag))).toBe(true);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => Boolean(MaweCoreState.waveformEditor.markerCreateDrag))).toBe(false);
  await expect(page.locator('.waveform-marker-item.drag-preview')).toHaveCount(0);
  await page.mouse.move(drag.x + 1200 / drag.msPerPixel, drag.y);
  await page.mouse.up();
  expect(await page.evaluate(() => ({
    selection: [...MaweSelection.selectedIdxs], markers: JSON.stringify(MaweBoot.DATA.markers),
    history: [MaweHistory.editorHistory.undoLength(), MaweHistory.editorHistory.redoLength()],
  }))).toEqual(before);
});

test('held A/D and frame snapping keep the selected tracks in sync', async ({ page }) => {
  await seed(page, { frames: true });
  const before = await ranges(page);
  const drag = await grab(page, '.waveform-cue-block[data-track="extension"]');
  await page.mouse.move(drag.x + 1015 / drag.msPerPixel, drag.y, { steps: 6 });
  expect(await page.evaluate(() => MaweCoreState.waveformEditor.drag.timing.unit)).toBe('frames');
  const first = await ranges(page);
  const delta = first[0][0].start - before[0][0].start;
  expect(delta % 40).toBe(0);
  first.forEach((track, index) => expect(track[0].start - before[index][0].start).toBe(delta));
  await page.keyboard.press('d');
  const stepped = await ranges(page);
  const step = stepped[0][0].start - first[0][0].start;
  expect(step).toBeGreaterThan(0);
  stepped.forEach((track, index) => expect(track[0].start - first[index][0].start).toBe(step));
  await page.mouse.move(drag.x + 1015 / drag.msPerPixel, drag.y);
  expect(await ranges(page)).toEqual(stepped);
  await page.mouse.up();
});

test('Alt squeeze previews restore unselected neighbors when the group is dragged back', async ({ page }) => {
  await seed(page, { neighbor: true });
  const before = await ranges(page);
  const drag = await grab(page, '.waveform-cue-block[data-track="main"]');
  await page.keyboard.down('Alt');
  await page.mouse.move(drag.x + 1000 / drag.msPerPixel, drag.y, { steps: 5 });
  expect((await ranges(page))[2][1].start).toBeGreaterThan(before[2][1].start);
  await page.mouse.move(drag.x, drag.y, { steps: 5 });
  expect(await ranges(page)).toEqual(before);
  await page.mouse.up();
  await page.keyboard.up('Alt');
});

test('all selected indices on each track move together and are saved together', async ({ page }) => {
  await page.addInitScript(() => {
    window.showSaveFilePicker = async () => ({
      name: 'drag.mosp',
      async createWritable() {
        return { async write(blob) { window.__savedDrag = JSON.parse(await blob.text()); }, async close() {} };
      },
    });
  });
  await seed(page);
  await page.evaluate(() => {
    for (const [track, id] of [[AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, 'main2'], [AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).segments, 'overlay2'],
      [AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments, 'extension2']]) {
      track.push({ id, start: 4500, end: 5500, text: id, items: [] });
    }
    MaweCuePanel.renderAll();
    MaweSelection.selectAll();
  });
  const before = await ranges(page);
  const drag = await grab(page, '.waveform-cue-block[data-track="overlay"]');
  await page.mouse.move(drag.x + 1000 / drag.msPerPixel, drag.y, { steps: 5 });
  const after = await ranges(page);
  const delta = after[0][0].start - before[0][0].start;
  after.forEach((track, index) => track.forEach((segment, cueIndex) => {
    expect(segment.start - before[index][cueIndex].start).toBe(delta);
    expect(segment.end - before[index][cueIndex].end).toBe(delta);
  }));
  await page.mouse.up();
  await page.evaluate(() => MaweProjectSave.saveProjectAsToFile());
  await expect.poll(() => page.evaluate(() => Boolean(window.__savedDrag))).toBe(true);
  expect(await page.evaluate(() => [window.__savedDrag.segments, window.__savedDrag.overlay_track.segments,
    window.__savedDrag.multi_subtitle.tracks[0].segments].map((segments) => segments.map(({ start, end }) => [start, end]))))
    .toEqual(after.map((track) => track.map(({ start, end }) => [start, end])));
});

for (const cancel of ['pointercancel', 'blur']) {
  test(`${cancel} restores marker visuals and clears its pointer override`, async ({ page }) => {
    await seed(page);
    const drag = await grab(page, '.waveform-marker-item[data-marker-id="point"]');
    await page.mouse.move(drag.x + 1500 / drag.msPerPixel, drag.y, { steps: 5 });
    await expectPointerAtPending(page, 'start');
    await page.evaluate((cancel) => {
      const drag = MaweCoreState.waveformEditor.markerDrag;
      window.dispatchEvent(cancel === 'pointercancel'
        ? new PointerEvent(cancel, { pointerId: drag.pointerId, clientX: drag.lastEvent.clientX, clientY: drag.lastEvent.clientY })
        : new Event(cancel));
    }, cancel);
    await expect(page.locator('.waveform-marker-item.drag-preview')).toHaveCount(0);
    await expect(page.locator('.waveform-pointer-line.boundary-snapped')).toHaveCount(0);
    expect(await page.evaluate(() => MaweMarkerEditing.findMarker('point').start)).toBe(9000);
    await page.mouse.up();
  });
}

test('a snap to a fractional playhead keeps all selected times on the timing grid', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => { MaweCoreState.waveformEditor.currentTimeMs = () => 2517; });
  const drag = await grab(page, '.waveform-cue-block[data-track="main"]');
  await page.mouse.move(drag.x + 1480 / drag.msPerPixel, drag.y, { steps: 5 });
  const after = await ranges(page);
  expect(after.map((track) => track[0].start)).toEqual([2520, 2820, 2620]);
  await page.mouse.up();
});

for (const [id, handle] of [['point', ''], ['region', ' .waveform-marker-handle.left']]) {
  test(`${id} can drag backwards from the second row to the first`, async ({ page }) => {
    await seed(page);
    await page.evaluate(() => {
      MaweMarkerEditing.findMarker('point').start = 12000;
      Object.assign(MaweMarkerEditing.findMarker('region'), { start: 11000, end: 14000 });
      MaweMarkerEditing.afterExternalMarkersChange();
    });
    const drag = await grab(page, `.waveform-row[data-row-index="1"] .waveform-marker-item[data-marker-id="${id}"]${handle}`);
    await page.mouse.move(drag.x - 5000 / drag.msPerPixel, drag.y, { steps: 6 });
    await expect.poll(() => page.evaluate(() => MaweCoreState.waveformEditor.markerDrag.pending.start)).toBeLessThan(10000);
    await expectPointerAtPending(page, 'start');
    await expect(page.locator('.waveform-row[data-row-index="0"] .waveform-pointer-line.boundary-snapped')).toBeVisible();
    await page.mouse.up();
  });
}

for (const [id, handle, edge, rowIndex] of [['point', '', 'start', 1],
  ['region', ' .waveform-marker-handle.right', 'end', 0]]) {
  test(`an exact row seam aligns the ${id} ${edge} with its visible fragment`, async ({ page }) => {
    await seed(page);
    if (handle) await page.evaluate(() => {
      MaweMarkerEditing.findMarker('point').start = 5000;
      MaweMarkerEditing.afterExternalMarkersChange();
    });
    const drag = await grab(page, `.waveform-marker-item[data-marker-id="${id}"]${handle}`);
    const x = handle ? drag.geometry.left + 10000 / drag.msPerPixel : drag.x + 1000 / drag.msPerPixel;
    await page.mouse.move(x, drag.y, { steps: 4 });
    await expect.poll(() => page.evaluate((edge) => MaweCoreState.waveformEditor.markerDrag.pending[edge], edge)).toBe(10000);
    await expect(page.locator(`.waveform-row[data-row-index="${rowIndex}"] .waveform-pointer-line.boundary-snapped`)).toBeVisible();
    await expectPointerAtPending(page, edge);
    await page.mouse.up();
  });
}

test('a bound follower that is outside the selection still follows a selected main cue', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    MaweState.selection.clear('extension');
    MaweCoreState.waveformEditor.updateSelection();
  });
  const before = await ranges(page);
  const drag = await grab(page, '.waveform-cue-block[data-track="overlay"]');
  await page.mouse.move(drag.x + 1000 / drag.msPerPixel, drag.y, { steps: 5 });
  const after = await ranges(page);
  const delta = after[0][0].start - before[0][0].start;
  expect(after[2][0].start - before[2][0].start).toBe(delta);
  expect(after[2][0].end - before[2][0].end).toBe(delta);
  await page.mouse.up();
  await page.locator('#undo-btn').click();
  expect(await ranges(page)).toEqual(before);
});

test('held Shift+D rebases every selected track before further mouse and keyboard movement', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.push({ id: 'neighbor', start: 4000, end: 5000, text: 'neighbor', items: [] });
    MaweCuePanel.renderAll();
    MaweSelection.selectAll();
    MaweState.selection.remove('main', 1);
    MaweCoreState.waveformEditor.updateSelection();
  });
  const before = await ranges(page);
  const drag = await grab(page, '.waveform-cue-block[data-track="main"]');
  await page.mouse.move(drag.x + 500 / drag.msPerPixel, drag.y, { steps: 4 });
  await page.keyboard.press('Shift+d');
  const snapped = await ranges(page);
  expect(snapped[0][0].end).toBe(4000);
  await page.mouse.move(drag.x + 400 / drag.msPerPixel, drag.y, { steps: 4 });
  const moved = await ranges(page);
  moved.forEach((track, index) => {
    expect(track[0].start - snapped[index][0].start).toBe(-100);
    expect(track[0].end - snapped[index][0].end).toBe(-100);
  });
  await page.keyboard.press('d');
  const stepped = await ranges(page);
  await page.mouse.move(drag.x + 400 / drag.msPerPixel, drag.y);
  expect(await ranges(page)).toEqual(stepped);
  await page.mouse.up();
  await page.locator('#undo-btn').click();
  expect(await ranges(page)).toEqual(before);
});

test('point marker preview and commit use the same final millisecond at the media end', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    MaweMarkerEditing.findMarker('point').start = 59000;
    MaweMarkerEditing.afterExternalMarkersChange();
    const wave = MaweCoreState.waveformEditor;
    wave.settings.mode = 'basic';
    wave.settings.visibleSeconds = 10;
    wave.basicWindowStartMs = 50000;
    wave.render();
  });
  const drag = await grab(page, '.waveform-marker-item[data-marker-id="point"]');
  await page.mouse.move(drag.x + 2000 / drag.msPerPixel, drag.y, { steps: 5 });
  await expect.poll(() => page.evaluate(() => MaweCoreState.waveformEditor.markerDrag.pending.start)).toBe(59999);
  await expectPointerAtPending(page, 'start');
  await expect(page.locator('.waveform-marker-item.drag-preview')).toBeVisible();
  await page.mouse.up();
  expect(await page.evaluate(() => MaweMarkerEditing.findMarker('point').start)).toBe(59999);
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => MaweMarkerEditing.findMarker('point').start)).toBe(59000);
});

test('mixed selection preserves a bound follower snapshot through Alt squeeze and reversal', async ({ page }) => {
  await seed(page, { neighbor: true });
  await page.evaluate(() => {
    MaweState.selection.clear('extension');
    MaweState.selection.add('extension', 1);
    MaweCoreState.waveformEditor.updateSelection();
  });
  const before = await ranges(page);
  const drag = await grab(page, '.waveform-cue-block[data-track="overlay"]');
  await page.keyboard.down('Alt');
  await page.mouse.move(drag.x - 1000 / drag.msPerPixel, drag.y, { steps: 5 });
  const moved = await ranges(page);
  moved.forEach((track, index) => track.forEach((segment, cueIndex) => {
    expect(segment.start).toBe(before[index][cueIndex].start - 1000);
    expect(segment.end).toBe(before[index][cueIndex].end - 1000);
  }));
  await page.mouse.move(drag.x, drag.y, { steps: 5 });
  expect(await ranges(page)).toEqual(before);
  await page.mouse.move(drag.x - 1000 / drag.msPerPixel, drag.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  expect(await ranges(page)).toEqual(moved);
  await page.locator('#undo-btn').click();
  expect(await ranges(page)).toEqual(before);
});

for (const track of ['main', 'overlay', 'extension']) {
  test(`a removed unselected bound-track neighbor preserves a drag anchored on ${track}`, async ({ page }) => {
    await seed(page, { neighbor: true });
    await page.evaluate(() => {
      const track = AsrEditorUtils.getExtensionTrack(MaweBoot.DATA);
      track.segments.splice(1, 0, { id: 'covered', start: 2200, end: 2500, text: 'covered', items: [] });
      MaweCuePanel.renderAll();
      MaweSelection.selectAll();
      MaweState.selection.clear('extension');
      MaweState.selection.add('extension', 2);
      MaweCoreState.waveformEditor.updateSelection();
    });
    const before = await ranges(page);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const selector = `.waveform-cue-block[data-track="${track}"]${track === 'extension' ? '[data-ext-idx="2"]' : ''}`;
    const drag = await grab(page, selector);
    await page.mouse.move(drag.x + 500 / drag.msPerPixel, drag.y, { steps: 4 });
    await expect.poll(() => page.evaluate(() => AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments.length)).toBe(2);
    await page.mouse.move(drag.x + 1000 / drag.msPerPixel, drag.y, { steps: 4 });
    expect(errors).toEqual([]);
    const moved = await ranges(page);
    expect(moved[0][0].start).toBe(2000);
    expect(moved[1][0].start).toBe(2300);
    expect(moved[2].map(({ start, end }) => [start, end])).toEqual([[2100, 3100], [3600, 4600]]);
    await expect(page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="1"]')).toHaveClass(/dragging/);
    await page.keyboard.press('d');
    await page.keyboard.press('a');
    await page.mouse.move(drag.x + 1000 / drag.msPerPixel, drag.y);
    expect(await ranges(page)).toEqual(moved);
    await page.mouse.move(drag.x, drag.y, { steps: 4 });
    expect(await ranges(page)).toEqual(before);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await ranges(page)).toEqual(before);
    const nextDrag = await grab(page, selector);
    await page.mouse.move(nextDrag.x + 1000 / nextDrag.msPerPixel, nextDrag.y, { steps: 4 });
    await page.mouse.up();
    expect(await ranges(page)).toEqual(moved);
    await page.locator('#undo-btn').click();
    expect(await ranges(page)).toEqual(before);
  });
}
