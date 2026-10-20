import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWaveformPayload, generateWav, makeTempDir, startServer } from './helpers.mjs';

let directory, server, projectPath;
test.beforeAll(async () => {
  directory = makeTempDir('ai-local-export');
  const mediaPath = join(directory, 'synthetic.wav');
  projectPath = join(directory, 'project.mosp');
  generateWav(mediaPath, 2);
  writeFileSync(projectPath, JSON.stringify({
    media: 'synthetic.wav', waveform: generateWaveformPayload(2000),
    segments: [{ id: 'main-001', start: 0, end: 2000, text: '啊，我这……我这个功能呢',
      items: [{ text: '啊，', start: 0, end: 210 }, { text: '我这……', start: 220, end: 770 }, { text: '我这个功能呢', start: 900, end: 2000 }] }],
    gap_remove: { detector: 'audio_gate', provenance: { sources: { ai_cleanup: [{ start: 0, end: 770,
      cleanup_scope: { segment_id: 'main-001', item_start: 0, item_end: 2, text: '啊，我这……' } }] } } },
    markers: { schema: 'moy.asr.markers.v1', items: [{ id: 'review-local', start: 100, end: 400, name: '复核区段', note: '[AI] 复核：合成证据', review: { status: 'pending', reason: '合成证据' } }] },
  }), 'utf-8');
  server = await startServer(projectPath, mediaPath, await findFreePort());
});
test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(directory);
});

test('real editor saves/reopens trustworthy local scopes and keeps gap-only review history reversible', async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
  await page.goto(server.url);
  await expect(page.locator('.cue[data-idx="0"] .text')).toBeVisible();
  const preview = await page.evaluate(() => {
    MaweDom.overlayToggle.checked = true;
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const css = MaweDom.overlayMainTextNode.nodeValue;
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const canvas = window.MaweAssCanvas.lastRender.tracks.flatMap((track) => track.lines.flatMap((line) => line.items.map((item) => item.text))).join('');
    return { css, canvas };
  });
  expect(preview.css).toBe('我这个功能呢');
  expect(preview.canvas).toContain('我这个功能呢');
  expect(preview.canvas).not.toContain('我这……');
  await page.locator('.player-stage').screenshot({ path: test.info().outputPath('local-cleanup-canvas.png') });
  await page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  const initial = await page.evaluate(async () => ({
    source: MaweBoot.DATA.segments[0], ordinary: MaweExportSrt.buildSrt(), compressed: MaweExportSrt.buildGapRemovedSrt(),
    ass: MaweExportSrt.buildAss(), dynamic: MaweExportSrt.buildDynamicCaptionExportData(MaweBoot.DATA.segments, true),
    otio: MaweExportTimeline.buildTimelineOtio({ includeSubtitleMarkers: true }),
    saved: await MaweProjectSave.saveProjectToServer({ silent: true }),
  }));
  expect(initial.saved).toBe(true);
  expect(initial.source.disabled).not.toBe(true);
  expect(initial.source.text).toBe('啊  我这……我这个功能呢');
  for (const [kind, output] of Object.entries({ ordinary: initial.ordinary, compressed: initial.compressed, ass: initial.ass, otio: initial.otio })) {
    expect(output !== null, kind).toBe(true);
    expect(output, kind).toContain('我这个功能呢');
    expect(output, kind).not.toContain('我这……');
  }
  expect(initial.dynamic.segments[0].items.map((item) => item.text)).toEqual(['我这个功能呢']);
  const saved = JSON.parse(readFileSync(projectPath, 'utf-8'));
  expect(saved.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope.item_end).toBe(2);
  expect(saved.segments[0].items).toHaveLength(3);
  await page.reload();
  await expect(page.locator('.cue[data-idx="0"] .text')).toBeVisible();
  expect(await page.evaluate(() => MaweExportSrt.buildSrt())).not.toContain('我这……');

  const history = await page.evaluate(() => {
    const marker = MaweBoot.DATA.markers.find((item) => item.id === 'review-local');
    MaweGapRemoveUi.toggleAiCleanupReviewMute(marker);
    const mute = JSON.parse(JSON.stringify(MaweBoot.DATA.gap_remove.provenance));
    MaweHistory.performUndo();
    const undo = JSON.parse(JSON.stringify(MaweBoot.DATA.gap_remove.provenance));
    MaweHistory.performRedo();
    const redo = JSON.parse(JSON.stringify(MaweBoot.DATA.gap_remove.provenance));
    MaweHistory.pushGapRemoveUndo('恢复自动局部 AI');
    const state = MaweGapRemoveData.getGapRemoveData(false);
    const provenance = AsrGapRemoveCore.replaceGapRemoveProvenanceSource(state.provenance, 'ai_cleanup', []);
    MaweGapRemoveUi.setGapRemoveData(state, { provenance });
    const restored = MaweExportSrt.buildSrt();
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const restoredPreview = MaweDom.overlayMainTextNode.nodeValue;
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const restoredCanvas = window.MaweAssCanvas.lastRender.tracks.flatMap((track) => track.lines.flatMap((line) => line.items.map((item) => item.text))).join('');
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MaweHistory.performUndo();
    const reinstated = MaweExportSrt.buildSrt();
    MaweHistory.performRedo();
    return { mute, undo, redo, restored, reinstated, restoredPreview, restoredCanvas, source: MaweBoot.DATA.segments[0] };
  });
  expect(history.mute.sources.ai_cleanup_review[0].review_marker_id).toBe('review-local');
  expect(history.undo.sources.ai_cleanup_review).toHaveLength(0);
  expect(history.redo.sources.ai_cleanup_review).toHaveLength(1);
  expect(history.redo.sources.ai_cleanup[0].cleanup_scope.text).toBe('啊  我这……');
  expect(history.restored).toContain('我这……');
  expect(history.restoredPreview).toContain('我这……');
  expect(history.restoredCanvas).toContain('我这……');
  expect(history.reinstated).not.toContain('我这……');
  expect(history.source.text).toBe('啊  我这……我这个功能呢');
  await page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await page.locator('.player-stage').screenshot({ path: test.info().outputPath('local-restored-canvas.png') });
});

test('a newly imported project cannot reuse the previous server media for OTIO', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await expect(page.locator('.cue[data-idx="0"] .text')).toBeVisible();
  expect(await page.evaluate(() => MaweExportTimeline.buildTimelineOtio())).not.toBeNull();
  const result = await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ schema: 'moy.asr.project.v1', media: 'another.wav', segments: [{ id: 'new', start: 0, end: 1000, text: '新工程' }] }, 'other.mosp');
    return { path: MaweBoot.SERVER_CONFIG.autoLoadedMediaPath, timeline: MaweExportTimeline.buildTimelineOtio() };
  });
  expect(result.path).toBeNull();
  expect(result.timeline).toBeNull();
});
