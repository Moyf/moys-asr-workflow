import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUtilsModule as createProjectTracks } from '../../web/shared/utils/project-tracks.js';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav,
  makeTempDir, startServer } from './helpers.mjs';

let dir, server, projectPath, legacyProject;
test.beforeEach(async () => {
  dir = makeTempDir('stable-groups');
  projectPath = join(dir, 'groups.mosp');
  const media = join(dir, 'synthetic.wav');
  generateWav(media, 15);
  const stickerPath = join(dir, 'cat.png');
  writeFileSync(stickerPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5V8AAAAASUVORK5CYII=', 'base64'));
  legacyProject = { schema: 'moy.asr.project.v1', media, sticker_root: dir,
    segments: [
      { id: 'a', start: 1000, end: 3000, text: '甲乙', sticker: { name: 'cat', filename: 'cat.png', rel: 'cat.png', path: stickerPath }, color: { name: 'blue', value: '#0000ff' } },
      { id: 'b', start: 5000, end: 7000, text: '丙丁', sticker_ref: { name: 'cat', headIdx: 0 }, color_ref: { name: 'blue', headIdx: 0 } },
      { id: 'c', start: 8000, end: 10000, text: '戊己', sticker_ref: { name: 'cat', headIdx: 0 }, color_ref: { name: 'blue', headIdx: 0 } },
    ] };
  const project = createProjectTracks().importProject(legacyProject).project;
  writeFileSync(projectPath, JSON.stringify(project), 'utf8');
  server = await startServer(projectPath, media, await findFreePort());
});
test.afterEach(async () => { await server?.stop(); cleanupTempDir(dir); });

test('groups stay continuous across track moves, split, delete-head, undo, save/reopen and export', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await disableOnboarding(page);
  await page.goto(server.url);
  await expect(page.locator('#cues-container')).toBeVisible();
  await page.evaluate(() => MaweSettings.updateEditorSettings({ autoSaveProject: false }));
  const initial = await page.evaluate(() => {
    const u = window.AsrEditorUtils;
    return { ids: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.sticker_group_id),
      active: [4000, 7500, 9900].map(t => MaweStickerOverlay.activeStickersAt(t).length),
      range: u.subtitleGroupRanges(MaweBoot.DATA).map(r => [r.start, r.end]) };
  });
  expect(new Set(initial.ids).size).toBe(1);
  expect(initial.active).toEqual([1, 1, 1]);
  expect(initial.range).toEqual([[1000, 10000]]);
  await page.evaluate(() => {
    MaweCommands.run('延长末尾', command => {
      AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[2].end = 12000;
      MaweTextCleanup.syncTimelineGroupRanges();
      command.commit({ cueList: true, waveform: 'full' });
    });

  });
  await page.locator('.cue[data-idx="1"]').click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  await page.locator('.word-timing-advanced > .item').first().click();
  await page.getByText('转为叠加字幕', { exact: true }).click();
  expect(await page.evaluate(() => ({
    range: window.AsrEditorUtils.subtitleGroupRanges(MaweBoot.DATA).map(r => [r.start, r.end]),
    moved: AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).segments[0].sticker_group_id,
    active: MaweStickerOverlay.activeStickersAt(11000).length,
  }))).toEqual({ range: [[1000, 12000]], moved: initial.ids[0], active: 1 });
  // Real controls exercise the single history stack for the move.
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(3);
  await page.locator('#redo-btn').click();
  expect(await page.evaluate(() => AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).segments.length)).toBe(1);
  await page.evaluate(() => {
    MaweSegmentOps.deleteSegments([0]);
    MaweSplitCore.openMainWaveformSplitModal(0, 10000);
  });
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await page.locator('#multi-subtitle-split-confirm').click();
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.sticker_group_id)))
    .toEqual([initial.ids[0], initial.ids[0]]);
  await page.evaluate(() => MaweSegmentOps.mergeSegments([0, 1]));
  expect(await page.evaluate(() => window.AsrEditorUtils.subtitleGroupRanges(MaweBoot.DATA)
    .map(r => [r.start, r.end]))).toEqual([[5000, 12000]]);
  const exportRange = await page.evaluate(() => {
    const plan = window.AsrEditorUtils.buildProjectExportPlan(MaweBoot.DATA, { durationMs: 15000, timelineMode: 'source' });
    return { clips: [...plan.stickers, ...plan.overlayStickers].map(s => [s.startMs, s.endMs]),
      otio: MaweExportTimeline.collectStickerOtioEntries([]).entries?.map(s => [s.startMs, s.endMs]),
      resolve: JSON.parse(MaweExportTimeline.buildResolveJson()).stickers.map(s => [s.start_ms, s.end_ms]),
      serializedOtio: JSON.parse(MaweExportTimeline.buildStickerOtio()).tracks.children[0].children
        .filter(clip => clip.OTIO_SCHEMA === 'Clip.2').map(clip => [clip.metadata.moy.start_ms, clip.metadata.moy.end_ms]) };
  });
  expect(exportRange).toEqual({ clips: [[5000, 12000]], otio: [[5000, 12000]],
    resolve: [[5000, 12000]], serializedOtio: [[5000, 12000]] });
  const response = page.waitForResponse(r => r.url().endsWith('/api/project') && r.request().method() === 'POST');
  await page.keyboard.press('Control+s');
  expect((await response).ok()).toBe(true);
  const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
  expect(saved.schema).toBe('moy.asr.project.v2');
  expect(JSON.stringify(saved)).not.toContain('headIdx');
  await page.reload();
  await expect(page.locator('#cues-container')).toBeVisible();
  expect(await page.evaluate(() => window.AsrEditorUtils.subtitleGroupRanges(MaweBoot.DATA)
    .map(r => [r.id, r.start, r.end]))).toEqual([[initial.ids[0], 5000, 12000]]);
  await page.evaluate(() => {
    MaweCommands.run('另一个组', command => {
      AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.push({ id: 'other', start: 13000, end: 14000, text: '另一组' });
      window.AsrEditorUtils.assignSubtitleGroup(MaweBoot.DATA, AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, [1], 'sticker', { name: 'cat', rel: 'cat.png' });
      command.commit({ cueList: true });
    });
    MaweSegmentOps.mergeSegments([0, 1]);
  });
  expect(await page.evaluate(() => ({ group: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].sticker_group_id || null,
    ranges: window.AsrEditorUtils.subtitleGroupRanges(MaweBoot.DATA).map(r => [r.start, r.end]) })))
    .toEqual({ group: null, ranges: [[5000, 7000]] });
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => MaweBoot.DATA.subtitle_groups.sticker.length)).toBe(2);
  mkdirSync('.artifacts/issue234-stable-groups', { recursive: true });
  await page.screenshot({ path: '.artifacts/issue234-stable-groups/browser.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('imported project cues get independent groups and IDs; failed loading and SRT undo preserve the current project', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await expect(page.locator('#cues-container')).toBeVisible();
  await page.evaluate(() => MaweSettings.updateEditorSettings({ autoSaveProject: false }));
  const source = structuredClone(legacyProject);
  source.segments[0].vendor = { nested: ['keep'] };
  source.segments[0].assOverride = { pos: { x: 123, y: 456 } };
  const importedIds = [];
  for (let round = 0; round < 2; round++) {
    await page.evaluate(async source => {
      const file = new File([JSON.stringify(source)], 'import.mosp', { type: 'application/json' });
      const segments = await MaweLoadingProgress.parseSubtitleImportFile(file);
      await MaweMultiImport.showMultiSubtitleImportChoice(file, segments, { projectFile: file });
    }, source);
    await page.locator('#multi-subtitle-import-extension').click();
    await page.locator('#multi-subtitle-import-result-confirm').click();
    const result = await page.evaluate(() => {
      const cue = AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments[0];
      const cues = window.AsrEditorUtils.subtitleGroupTracks(MaweBoot.DATA).flatMap(t => t.segments);
      return { group: cue.sticker_group_id, mainGroup: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].sticker_group_id,
        uniqueIds: new Set(cues.map(s => s.id)).size === cues.length,
        vendor: cue.vendor, pos: cue.assOverride.pos };
    });
    expect(result.uniqueIds).toBe(true);
    expect(result.group).not.toBe(result.mainGroup);
    expect(result.vendor).toEqual({ nested: ['keep'] });
    expect(result.pos).toEqual({ x: 123, y: 456 });
    importedIds.push(result.group);
  }
  expect(importedIds[0]).not.toBe(importedIds[1]);
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments[0].sticker_group_id)).toBe(importedIds[0]);
  await page.locator('#redo-btn').click();
  const rejected = await page.evaluate(() => {
    const before = JSON.stringify(MaweBoot.DATA);
    try {
      MaweProjectLoad.applyCanonicalProject({ schema: 'moy.asr.project.v1.5',
        subtitle_groups: { color: [], sticker: [] },
        segments: [{ id: 'bad', start: 0, end: 1000, text: 'bad', sticker_group_id: 'missing' }] }, 'bad.mosp');
    } catch (_) { return JSON.stringify(MaweBoot.DATA) === before; }
    return false;
  });
  expect(rejected).toBe(true);
  await page.evaluate(() => MaweProjectLoad.replaceMainTrack([{ start: 0, end: 1000, text: 'SRT' }], 'new.srt'));
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.text))).toEqual(['SRT']);
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments[0].sticker_group_id)).toBe(importedIds[1]);
});

test('overlay-only groups export once, hidden tracks stay hidden, and end-boundary sampling expires the sticker cache', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await expect(page.locator('#cues-container')).toBeVisible();
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.duration)).toBeGreaterThan(0);
  const actual = await page.evaluate(({ media, stickerPath }) => {
    const u = window.AsrEditorUtils;
    const legacy = { schema: 'moy.asr.project.v1',
      segments: [{ id: 'plain', start: 0, end: 500, text: 'plain' }],
      overlay_track: { enabled: true, segments: [{ id: 'overlay', start: 1000, end: 3000, text: 'overlay',
        sticker: { name: 'overlay', rel: 'cat.png', path: stickerPath, start_ms: 0, end_ms: 1, group_id: 'vendor-value' } }] },
      multi_subtitle: { enabled: false, tracks: [{ id: 'ext', segments: [{ id: 'extension', start: 5000, end: 7000, text: 'hidden',
        sticker: { name: 'hidden', rel: 'cat.png', path: stickerPath } }] }] } };
    const fixture = u.importProject(legacy).project;
    const { tracks, bindings, bilingual, subtitle_groups } = fixture;
    Object.assign(MaweBoot.DATA, { tracks, bindings, bilingual, subtitle_groups });
    // Server playback uses a relative URL; OTIO requires the original disk path.
    MaweBoot.DATA.media = media;
    MaweSettings.updateEditorSettings({ autoSaveProject: false });
    MaweCuePanel.renderAll();
    const ranges = timeline => {
      if (!timeline) throw new Error(`Timeline rejected: ${document.querySelector('#hint-stack')?.textContent}; media=${MaweExportTimeline.mediaTargetUrl()}; duration=${MaweCoreState.player.duration}`);
      return JSON.parse(timeline).tracks.children.flatMap(track => track.children || [])
      .filter(clip => clip.OTIO_SCHEMA === 'Clip.2' && clip.metadata?.moy?.sticker_rel)
      .map(clip => [clip.metadata.moy.start_ms, clip.metadata.moy.end_ms]);
    };
    const preview = [2999, 3000, 3001, 6000].map(t => MaweStickerOverlay.activeStickersAt(t).map(s => s.name));
    const plan = u.buildProjectExportPlan(MaweBoot.DATA, { durationMs: 15000, timelineMode: 'source' });
    MaweBoot.DATA.gap_remove = { gaps: [{ start: 1500, end: 2000, removed: true }] };
    return { preview, standalone: ranges(MaweExportTimeline.buildStickerOtio()),
      gapRemoved: ranges(MaweExportTimeline.buildGapRemovedStickerOtio()),
      timeline: ranges(MaweExportTimeline.buildTimelineOtio({ includeStickers: true })),
      resolve: JSON.parse(MaweExportTimeline.buildResolveJson()).stickers.map(s => ({
        id: s.group_id, start: s.start_ms, end: s.end_ms,
      })),
      id: fixture.subtitle_groups.sticker[0].id,
      plan: [...plan.stickers, ...plan.overlayStickers].map(s => [s.startMs, s.endMs]) };
  }, { media: join(dir, 'synthetic.wav'), stickerPath: join(dir, 'cat.png') });
  expect(actual.preview).toEqual([['overlay'], [], [], []]);
  expect(actual.standalone).toEqual([[1000, 3000]]);
  expect(actual.gapRemoved).toEqual([[1000, 2500]]);
  expect(actual.timeline).toEqual([[1000, 3000]]);
  expect(actual.resolve).toEqual([{ id: actual.id, start: 1000, end: 3000 }]);
  expect(actual.plan).toEqual([[1000, 3000]]);
  const response = page.waitForResponse(r => r.url().endsWith('/api/project') && r.request().method() === 'POST');
  await page.keyboard.press('Control+s');
  expect((await response).ok()).toBe(true);
  const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
  expect(saved.subtitle_groups.sticker).toHaveLength(2);
  expect(saved.tracks.find(track => track.role === 'secondary').enabled).toBe(false);
  await page.reload();
  await expect(page.locator('#cues-container')).toBeVisible();
  expect(await page.evaluate(() => ({
    active: [2999, 3000, 6000].map(t => MaweStickerOverlay.activeStickersAt(t).map(s => s.name)),
    groups: MaweBoot.DATA.subtitle_groups.sticker.length,
  }))).toEqual({ active: [['overlay'], [], []], groups: 2 });
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.duration)).toBeGreaterThan(0);
  expect(await page.evaluate(() => {
    AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).enabled = true;
    MaweCuePanel.renderAll();
    return MaweStickerOverlay.activeStickersAt(6000).map(s => s.name);
  })).toEqual(['hidden']);
  expect(await page.evaluate(media => {
    AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).enabled = false;
    MaweBoot.DATA.media = media;
    MaweCuePanel.renderAll();
    const ranges = timeline => JSON.parse(timeline).tracks.children.flatMap(track => track.children || [])
      .filter(clip => clip.OTIO_SCHEMA === 'Clip.2' && clip.metadata?.moy?.sticker_rel)
      .map(clip => [clip.metadata.moy.start_ms, clip.metadata.moy.end_ms]);
    const plan = window.AsrEditorUtils.buildProjectExportPlan(MaweBoot.DATA, { durationMs: 15000, timelineMode: 'source' });
    return { standalone: ranges(MaweExportTimeline.buildStickerOtio()),
      gapRemoved: ranges(MaweExportTimeline.buildGapRemovedStickerOtio()),
      timeline: ranges(MaweExportTimeline.buildTimelineOtio({ includeStickers: true })),
      plan: [...plan.stickers, ...plan.overlayStickers].map(s => [s.startMs, s.endMs]) };
  }, join(dir, 'synthetic.wav'))).toEqual({ standalone: [[5000, 7000]], gapRemoved: [[4500, 6500]],
    timeline: [[5000, 7000]], plan: [[5000, 7000]] });
});

test('mixed groups retain overlay preview layout only while overlay members are active', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await expect(page.locator('#cues-container')).toBeVisible();
  const states = await page.evaluate(() => {
    const u = window.AsrEditorUtils;
    const legacy = { segments: [{ id: 'main', start: 0, end: 1000, text: 'main', sticker: { name: 'cat', rel: 'cat.png' } }],
      overlay_track: { enabled: true, segments: [{ id: 'overlay', start: 1000, end: 2000, text: 'overlay' }] } };
    const fixture = u.importProject(legacy).project;
    const overlay = u.getOverlayTrack(fixture);
    overlay.segments[0].sticker_group_id = u.getMainTrack(fixture).segments[0].sticker_group_id;
    const { tracks, bindings, bilingual, subtitle_groups } = fixture;
    Object.assign(MaweBoot.DATA, { tracks, bindings, bilingual, subtitle_groups });
    MaweSettings.updateEditorSettings({ autoSaveProject: false, stickersEnabled: true });
    MaweDom.stickerOverlayToggle.checked = true;
    const sample = () => {
      MaweStickerOverlay.stickerOverlayDataVersion += 1;
      MaweStickerOverlay.renderStickerOverlay(500);
      return MaweStickerOverlay.stickerOverlayContent.classList.contains('has-overlay-sticker');
    };
    const enabled = sample();
    overlay.segments[0].disabled = true;
    const disabled = sample();
    overlay.segments[0].disabled = false;
    overlay.enabled = false;
    return [enabled, disabled, sample()];
  });
  expect(states).toEqual([true, false, false]);
  await page.evaluate(() => {
    AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).enabled = true;
    MaweStickerOverlay.stickerOverlayDataVersion += 1;
    MaweStickerOverlay.renderStickerOverlay(500);
  });
  mkdirSync('.artifacts/e-last-audit', { recursive: true });
  await page.screenshot({ path: '.artifacts/e-last-audit/mixed-overlay.png', fullPage: true });
});
