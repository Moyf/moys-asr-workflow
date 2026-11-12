import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUtilsModule } from '../../web/shared/utils/project-tracks.js';
import { getMainTrack, getOverlayTrack, getExtensionTrack,
  cleanupTempDir, disableOnboarding, findFreePort, generateWaveformPayload,
  generateWav, makeTempDir, startServer,
} from './helpers.mjs';

const INITIAL_TEXT = 'deleted words kept';
const MAIN_CUE = '.multi-dual-cue[data-main-idx="0"] .multi-cue-column.main';
const MAIN_CUE_TEXT = `${MAIN_CUE} .text`;
const INITIAL_ITEMS = [
  { text: 'deleted ', start: 0, end: 300 },
  { text: 'words ', start: 300, end: 1200 },
  { text: 'kept', start: 2000, end: 5000 },
];

let directory;
let server;
let projectPath;

function cue(id, start, end, text) {
  return { id, start, end, text, items: [{ text, start, end }] };
}

function projectData({ neighbor = false } = {}) {
  const legacy = {
    media: 'synthetic.wav',
    waveform: generateWaveformPayload(10000),
    segments: [{
      id: 'main-001', start: 0, end: 5000, text: INITIAL_TEXT,
      items: INITIAL_ITEMS.map((item) => ({ ...item })),
    }],
    overlay_track: {
      enabled: true,
      // Keep the overlay lane clear of the scoped gap so the real context-menu hit target remains clickable.
      segments: [cue('overlay-001', 2000, 4500, 'overlay-only')],
    },
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
      tracks: [{
        id: 'translation', role: 'extension', segments: [
          cue('extension-001', 100, 5100, 'extension-only'),
          ...(neighbor ? [cue('extension-neighbor', 6000, 7000, 'neighbor-only')] : []),
        ],
      }],
      bindings: [{ id: 'bound', track_id: 'translation', main_segment_ids: ['main-001'],
        extension_segment_ids: ['extension-001'], start_offset_ms: 100, end_offset_ms: 100 }],
    },
    gap_remove: {
      detector: 'audio_gate',
      provenance: { sources: { ai_cleanup: [{
        id: 'local-scope', start: 0, end: 1200,
        cleanup_scope: { segment_id: 'main-001', item_start: 0, item_end: 2, text: 'deleted words ' },
      }] } },
    },
  };
  // The save/reopen cases start from a canonical file; legacy imports must use
  // Save As and are covered by the separate v2 migration tests.
  const project = createUtilsModule().importProject(legacy).project;
  project.speakers.push(
    { id: 'diag-a', name: '诊断 A', color: '#f9ca1f' },
    { id: 'diag-b', name: '诊断 B', color: '#66bb6a' },
  );
  return project;
}

test.beforeAll(async () => {
  directory = makeTempDir('ai-cleanup-scope-integration');
  const mediaPath = join(directory, 'synthetic.wav');
  projectPath = join(directory, 'project.mosp');
  generateWav(mediaPath, 10);
  writeFileSync(projectPath, JSON.stringify(projectData()), 'utf-8');
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(directory);
});

test.beforeEach(async ({ page }, testInfo) => {
  await server?.stop();
  const mediaPath = join(directory, 'synthetic.wav');
  const withNeighbor = testInfo.title.startsWith('S3-T03');
  writeFileSync(projectPath, JSON.stringify(projectData({ neighbor: withNeighbor })), 'utf-8');
  server = await startServer(projectPath, mediaPath, await findFreePort());
  await disableOnboarding(page);
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false }));
  });
  await page.goto(server.url);
  await expect(page.locator(MAIN_CUE_TEXT)).toBeVisible();
});

test.afterEach(async () => {
  await server?.stop();
  server = null;
});

async function setWordTiming(page) {
  const toggle = page.locator('#word-timing-quick-toggle');
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
}

async function editCueThroughWordTiming(page, replacement) {
  await setWordTiming(page);
  await page.locator(MAIN_CUE).click();
  const editor = page.locator('#cue-panel-text');
  await expect(editor).toHaveValue(INITIAL_TEXT);
  await editor.fill(replacement);
  await editor.blur();
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe(replacement);
  return page.evaluate(() => JSON.parse(JSON.stringify(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0])));
}

async function saveAndReload(page) {
  await expect.poll(() => page.evaluate(() => MaweProjectSave.saveProjectToServer({ silent: true })))
    .toBe(true);
  const saved = JSON.parse(readFileSync(projectPath, 'utf-8'));
  await page.reload();
  await expect(page.locator(MAIN_CUE_TEXT)).toBeVisible();
  return saved;
}

async function renderOutputs(page, timeMs) {
  return page.evaluate((currentTimeMs) => {
    const ordinary = MaweExportSrt.buildSrt();
    const gapRemoved = MaweExportSrt.buildGapRemovedSrt();
    const ass = MaweExportSrt.buildAss();
    MaweDom.overlayToggle.checked = true;
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MawePlaybackLoop.refreshSubtitlePreview(currentTimeMs, 0);
    const css = MaweDom.overlayMainTextNode?.nodeValue || '';
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MawePlaybackLoop.refreshSubtitlePreview(currentTimeMs, 0);
    const canvas = window.MaweAssCanvas.lastRender.tracks
      .flatMap((track) => (Array.isArray(track.lines)
        ? track.lines.flatMap((line) => line.items.map((item) => item.text)) : [])).join('');
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    return {
      ordinary, gapRemoved, ass, css, canvas,
      overlay: AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).segments[0].text,
      extension: AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments[0].text,
    };
  }, timeMs);
}

function expectAllMainOutputs(outputs, ...texts) {
  for (const text of texts) {
    for (const output of [outputs.ordinary, outputs.gapRemoved, outputs.ass, outputs.css, outputs.canvas]) {
      expect(output).toContain(text);
    }
  }
}

function expectRestoredMainOutputs(outputs, ...texts) {
  expect(outputs.gapRemoved).toBeNull();
  for (const text of texts) {
    for (const output of [outputs.ordinary, outputs.ass, outputs.css, outputs.canvas]) {
      expect(output).toContain(text);
    }
  }
}

test('S3-T01 #220 edit of a scoped item revokes stale clipping on save and reopen', async ({ page }) => {
  const edited = await editCueThroughWordTiming(page, 'deleted substantially-rewritten kept');
  expect(edited.text).toBe('deleted substantially-rewritten kept');
  expect(edited.items.map((item) => item.text)).toEqual(['deleted ', 'substantially-rewritten ', 'kept']);

  const saved = await saveAndReload(page);
  expect(getMainTrack(saved).segments[0].items.map((item) => item.text))
    .toEqual(['deleted ', 'substantially-rewritten ', 'kept']);
  expect(saved.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope)
    .toEqual({ segment_id: 'main-001', item_start: 0, item_end: 2, text: 'deleted words ' });
  expect(await page.evaluate(() => AsrGapRemoveCore.getCleanupScopeItems(
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0], MaweBoot.DATA.gap_remove.provenance.sources.ai_cleanup[0]).length)).toBe(0);

  const outputs = await renderOutputs(page, 500);
  expectAllMainOutputs(outputs, 'deleted', 'substantially-rewritten', 'kept');
  expect(outputs.overlay).toBe('overlay-only');
  expect(outputs.extension).toBe('extension-only');
});

test('S3-T02 editing an unscoped item keeps the scope until the user restores its range', async ({ page }) => {
  const edited = await editCueThroughWordTiming(page, 'deleted words retained-expanded');
  expect(edited.text).toBe('deleted words retained-expanded');
  expect(edited.items.map((item) => item.text))
    .toEqual(['deleted ', 'words ', 'retained-expanded']);

  const saved = await saveAndReload(page);
  expect(getMainTrack(saved).segments[0].items.map((item) => item.text))
    .toEqual(['deleted ', 'words ', 'retained-expanded']);
  expect(saved.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope)
    .toEqual({ segment_id: 'main-001', item_start: 0, item_end: 2, text: 'deleted words ' });

  const clipped = await renderOutputs(page, 2500);
  expectAllMainOutputs(clipped, 'retained-expanded');
  for (const output of [clipped.ordinary, clipped.gapRemoved, clipped.ass, clipped.css, clipped.canvas]) {
    expect(output).not.toContain('deleted');
    expect(output).not.toContain('words');
  }

  await page.evaluate(() => {
    const wave = MaweCoreState.waveformEditor;
    wave.settings.mode = 'multi';
    wave.settings.secondsPerRow = 10;
    wave.scroll.style.width = '720px';
    wave.render();
  });
  const gap = page.locator('.waveform-gap-block[data-gap-index="0"]').first();
  await expect(gap).toBeVisible();
  await gap.click({ button: 'right' });
  const menu = page.locator('#ctxmenu');
  await expect(menu).toHaveClass(/show/);
  await menu.locator('.item').filter({ hasText: '恢复区段' }).click();

  const restored = await renderOutputs(page, 2500);
  expectRestoredMainOutputs(restored, 'deleted', 'words', 'retained-expanded');
  expect(restored.overlay).toBe('overlay-only');
  expect(restored.extension).toBe('extension-only');
  const restoredSaved = await saveAndReload(page);
  expect(restoredSaved.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope)
    .toEqual({ segment_id: 'main-001', item_start: 0, item_end: 2, text: 'deleted words ' });
  expect(restoredSaved.gap_remove.provenance.manual_overrides)
    .toEqual(expect.arrayContaining([expect.objectContaining({ start: 0, end: 1200, removed: false })]));
  expectRestoredMainOutputs(await renderOutputs(page, 2500), 'deleted', 'words', 'retained-expanded');
});

async function trackRanges(page) {
  return page.evaluate(() => [
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments,
    AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).segments,
    AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments,
  ].map((segments) => segments.map((segment) => ({
    id: segment.id,
    start: segment.start,
    end: segment.end,
    text: segment.text,
    items: segment.items.map((item) => ({ start: item.start, end: item.end, text: item.text })),
  }))));
}

async function grab(page, selector) {
  const block = page.locator(selector).first();
  const box = await block.boundingBox();
  expect(box).not.toBeNull();
  const geometry = await block.evaluate((element) => {
    const row = element.closest('.waveform-row');
    const rect = row.getBoundingClientRect();
    return {
      left: rect.left + row.clientLeft,
      width: row.clientWidth,
      start: Number(row.dataset.startMs),
      end: Number(row.dataset.endMs),
    };
  });
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  return { x, y, msPerPixel: (geometry.end - geometry.start) / geometry.width };
}

test('S3-T03 multi-track drag fail-opens the moved scope and saves independent tracks', async ({ page }) => {
  await page.evaluate(() => {
    const wave = MaweCoreState.waveformEditor;
    wave.settings.mode = 'multi';
    wave.settings.secondsPerRow = 10;
    wave.scroll.style.width = '720px';
    wave.render();
    MaweSelection.selectAll();
    MaweState.selection.clear('extension');
    wave.updateSelection();
  });
  const before = await trackRanges(page);
  const drag = await grab(page, '.waveform-cue-block[data-track="main"]');
  await page.keyboard.down('Alt');
  await page.mouse.move(drag.x + 1000 / drag.msPerPixel, drag.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');

  const moved = await trackRanges(page);
  expect(moved[0][0].start).toBe(before[0][0].start + 1000);
  expect(moved[1][0].start).toBe(before[1][0].start + 1000);
  expect(moved[2][0].start).toBe(before[2][0].start + 1000);
  expect(moved[2][1].start).toBeGreaterThan(before[2][1].start);
  expect(moved[2][1].start).toBeGreaterThanOrEqual(moved[2][0].end);
  expect(moved[0][0].items.map((item) => item.text)).toEqual(['deleted ', 'words ', 'kept']);

  const live = await renderOutputs(page, 2500);
  expectAllMainOutputs(live, 'deleted', 'words', 'kept');
  expect(live.overlay).toBe('overlay-only');
  expect(live.extension).toBe('extension-only');

  const saved = await saveAndReload(page);
  expect(saved.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope)
    .toEqual({ segment_id: 'main-001', item_start: 0, item_end: 2, text: 'deleted words ' });
  expect(await page.evaluate(() => AsrGapRemoveCore.getCleanupScopeItems(
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0], MaweBoot.DATA.gap_remove.provenance.sources.ai_cleanup[0]).length)).toBe(0);
  expect(getOverlayTrack(saved).segments[0].text).toBe('overlay-only');
  expect(getExtensionTrack(saved).segments.map((segment) => segment.text))
    .toEqual(['extension-only', 'neighbor-only']);
  const reopened = await renderOutputs(page, 2500);
  expectAllMainOutputs(reopened, 'deleted', 'words', 'kept');
  expect(reopened.overlay).toBe('overlay-only');
  expect(reopened.extension).toBe('extension-only');
});

test('S3-T04 playback reuses cleanup projections and observes direct edits, restoration, history and project switches', async ({ page }) => {
  const stable = await page.evaluate(() => {
    const ranges = MaweBoot.DATA.gap_remove.provenance.sources.ai_cleanup;
    window.cleanupSourceNormalizations = 0;
    ranges.map = function (...args) {
      window.cleanupSourceNormalizations += 1;
      return Array.prototype.map.apply(this, args);
    };
    // Replacing the source object starts a fresh projection lifetime.
    MaweBoot.DATA.gap_remove = { ...MaweBoot.DATA.gap_remove, skip_playback: false };
    MaweDom.overlayToggle.checked = true;
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MawePlaybackLoop.refreshSubtitlePreview(2500, 0);
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MawePlaybackLoop.refreshSubtitlePreview(2500, 0);
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MawePlaybackLoop.refreshSubtitlePreview(2500, 0);
    const prepared = window.cleanupSourceNormalizations;
    for (let frame = 0; frame < 30; frame += 1) MawePlaybackLoop.refreshSubtitlePreview(2500 + frame, 0);
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    for (let frame = 0; frame < 30; frame += 1) MawePlaybackLoop.refreshSubtitlePreview(2500 + frame, 0);
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MaweCoreState.player.currentTime = 2.5;
    return { prepared, after: window.cleanupSourceNormalizations };
  });
  expect(stable.prepared).toBeGreaterThan(0);
  expect(stable.after).toBe(stable.prepared);
  await expect(page.locator('#overlay-main-text')).toHaveText('kept');
  await page.evaluate(() => MaweCoreState.player.play());
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.currentTime)).toBeGreaterThan(2.8);
  await page.evaluate(() => MaweCoreState.player.pause());

  await page.evaluate(() => {
    const cue = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0];
    cue.text = 'deleted words expanded';
    cue.items[2].text = 'expanded';
  });
  expectAllMainOutputs(await renderOutputs(page, 2500), 'expanded');

  await page.evaluate(() => {
    MaweHistory.pushGapRemoveUndo('restore scoped words');
    const state = MaweGapRemoveData.getGapRemoveData(true);
    MaweGapRemoveUi.commitManualGapRemoveChange(state, [{ start: 0, end: 1200, removed: false }]);
  });
  expectRestoredMainOutputs(await renderOutputs(page, 2500), 'deleted', 'words', 'expanded');
  await page.evaluate(() => MaweHistory.performUndo());
  const undone = await renderOutputs(page, 2500);
  expectAllMainOutputs(undone, 'expanded');
  expect(undone.css).not.toContain('deleted');
  await page.evaluate(() => MaweHistory.performRedo());
  expectRestoredMainOutputs(await renderOutputs(page, 2500), 'deleted', 'words', 'expanded');

  const switched = await page.evaluate(() => {
    const project = JSON.parse(JSON.stringify(MaweBoot.DATA));
    project.tracks = [{ id: 'new-main', role: 'main', name: '新主轨', enabled: true,
      segments: [{ id: 'new-cue', start: 0, end: 5000, text: 'new project', items: [] }] }];
    project.bindings = [];
    project.bilingual = { display_mode: 'main' };
    delete project.gap_remove;
    MaweProjectLoad.applyCanonicalProject(project, 'new-project.mosp');
    MaweDom.overlayToggle.checked = true;
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MawePlaybackLoop.refreshSubtitlePreview(2500, 0);
    return { text: MaweDom.overlayMainTextNode.nodeValue, srt: MaweExportSrt.buildSrt() };
  });
  expect(switched.text).toBe('new project');
  expect(switched.srt).toContain('new project');
  expect(switched.srt).not.toContain('deleted');
});

test('S3-T05 unrelated current cues return immediately and re-enter cleanup after scope edits and undo/redo', async ({ page }) => {
  await page.evaluate(() => {
    MaweDom.overlayToggle.checked = true;
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MaweCoreState.player.currentTime = 2.5;
    MawePlaybackLoop.refreshSubtitlePreview(2500, 0);
  });
  await expect(page.locator('#overlay-main-text')).toHaveText('kept');
  await page.evaluate(() => {
    MaweHistory.pushGapRemoveUndo('move scope away from current cue');
    MaweBoot.DATA.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope.segment_id = 'other-cue';
    MawePlaybackLoop.refreshSubtitlePreview(2500, 0);
  });
  await expect(page.locator('#overlay-main-text')).toHaveText(INITIAL_TEXT);
  await page.evaluate(() => MaweHistory.performUndo());
  await expect(page.locator('#overlay-main-text')).toHaveText('kept');
  await page.evaluate(() => MaweHistory.performRedo());
  await expect(page.locator('#overlay-main-text')).toHaveText(INITIAL_TEXT);
  await page.evaluate(() => {
    MaweBoot.DATA.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope.segment_id = 'main-001';
    MawePlaybackLoop.refreshSubtitlePreview(2500, 0);
  });
  await expect(page.locator('#overlay-main-text')).toHaveText('kept');
  expectAllMainOutputs(await renderOutputs(page, 2500), 'kept');
  await page.evaluate(() => {
    MaweBoot.DATA.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope.segment_id = 'other-cue';
  });
  const outputs = await renderOutputs(page, 2500);
  expectAllMainOutputs(outputs, 'deleted', 'words', 'kept');
});

test('S3-T06 diagnostic on/off preserves preview, covered export paths and saved v2 content', async ({ page }) => {
  expect(await page.evaluate(() => MaweExportSrt.isCleanupProjectionCacheEnabled())).toBe(true);
  async function equivalent() {
    await page.evaluate(() => MaweExportSrt.setCleanupProjectionCacheEnabled(false));
    const off = await renderOutputs(page, 2500);
    const exportOff = await page.evaluate(() => ({ secondary: MaweExportSrt.buildExtensionSrt(), bilingual: MaweExportSrt.buildBilingualSrt(), json: MaweJsonRepair.buildJson() }));
    await page.evaluate(() => MaweExportSrt.setCleanupProjectionCacheEnabled(true));
    expect(await renderOutputs(page, 2500)).toEqual(off);
    expect(await page.evaluate(() => ({ secondary: MaweExportSrt.buildExtensionSrt(), bilingual: MaweExportSrt.buildBilingualSrt(), json: MaweJsonRepair.buildJson() }))).toEqual(exportOff);
    expect(exportOff.json).not.toContain('cleanupProjectionCache');
  }
  await equivalent();
  await page.evaluate(() => { AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].speaker = 'diag-b'; });
  await equivalent();
  expect(await page.evaluate(() => MaweExportSrt.cleanupMainSegments()[0].speaker)).toBe('diag-b');
  await page.evaluate(() => { AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].speaker = 'diag-a'; });
  await equivalent();
  expect(await page.evaluate(() => MaweExportSrt.cleanupMainSegments()[0].speaker)).toBe('diag-a');
  await page.evaluate(() => { delete AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].speaker; });
  await page.evaluate(() => {
    MaweHistory.pushGapRemoveUndo('restore for diagnostic');
    MaweGapRemoveUi.commitManualGapRemoveChange(MaweGapRemoveData.getGapRemoveData(true), [{ start: 0, end: 1200, removed: false }]);
  });
  await equivalent();
  await page.evaluate(() => MaweHistory.performUndo()); await equivalent();
  await page.evaluate(() => MaweHistory.performRedo()); await equivalent();
  const saved = await page.evaluate(async () => {
    let text;
    window.showSaveFilePicker = async () => ({ name: 'cleanup-v2.mosp', getFile: async () => new File([], 'cleanup-v2.mosp'),
      createWritable: async () => ({ write: async blob => { text = await blob.text(); }, close: async () => {} }) });
    await MaweProjectSave.saveProjectAsToFile(); return JSON.parse(text);
  });
  expect(saved.schema).toBe('moy.asr.project.v2');
  await page.evaluate(saved => MaweProjectLoad.applyCanonicalProject(saved, 'cleanup-reopened.mosp'), saved);
  await equivalent();
  const timing = await page.evaluate(() => {
    const original = MaweBoot.DATA.gap_remove;
    const scope = original.provenance.sources.ai_cleanup[0];
    MaweBoot.DATA.gap_remove = AsrEditorUtils.normalizeGapRemoveData({ provenance: { sources: { ai_cleanup:
      Array.from({ length: 100 }, (_, i) => ({ start: scope.start + i * 6000, end: scope.end + i * 6000,
        cleanup_scope: { ...scope.cleanup_scope, segment_id: i ? `other-${i}` : scope.cleanup_scope.segment_id } })) } } });
    const samples = { off: [], on: [] };
    try {
      for (let round = 0; round < 6; round++) for (const enabled of round % 2 ? [true, false] : [false, true]) {
        MaweExportSrt.setCleanupProjectionCacheEnabled(enabled);
        MawePlaybackLoop.refreshSubtitlePreview(2500, 0);
        const start = performance.now();
        for (let frame = 0; frame < 10; frame++) MawePlaybackLoop.refreshSubtitlePreview(2500 + frame, 0);
        if (round) samples[enabled ? 'on' : 'off'].push((performance.now() - start) / 10);
      }
    } finally {
      MaweBoot.DATA.gap_remove = original;
      MaweExportSrt.setCleanupProjectionCacheEnabled(true);
    }
    return Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, values.sort((a, b) => a - b)[2]]));
  });
  console.log('cleanup browser preview 100 scopes median ms/frame', timing);
});
