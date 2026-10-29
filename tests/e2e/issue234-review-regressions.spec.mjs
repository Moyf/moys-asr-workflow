import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, makeTempDir, startServer } from './helpers.mjs';

let dir, server, projectPath;
test.beforeEach(async ({ page }) => {
  dir = makeTempDir('issue234-review');
  projectPath = join(dir, 'project.mosp');
  const media = join(dir, 'synthetic.wav');
  generateWav(media, 5);
  writeFileSync(join(dir, 'cat.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5V8AAAAASUVORK5CYII=', 'base64'));
  writeFileSync(join(dir, 'dog.png'), readFileSync(join(dir, 'cat.png')));
  writeFileSync(projectPath, JSON.stringify({ media, sticker_root: dir,
    segments: [{ id: 'a', start: 0, end: 3000, text: '甲乙丙',
      items: [{ text: '甲', start: 0, end: 1000 }, { text: '乙', start: 1000, end: 2000 },
        { text: '丙', start: 2000, end: 3000 }], sticker: { name: 'cat', rel: 'cat.png' } }],
  }), 'utf8');
  server = await startServer(projectPath, media, await findFreePort());
  await disableOnboarding(page);
  await page.goto(server.url);
  await expect(page.locator('#cues-container')).toBeVisible();
  await page.evaluate(() => MaweSettings.updateEditorSettings({ autoSaveProject: false }));
});
test.afterEach(async () => { await server?.stop(); cleanupTempDir(dir); });

test('repeat text split and track move remain unique through undo, save and reopen', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const split = async text => {
    await page.evaluate(() => MaweTimedTextEdit.openTimedTextEdit());
    await page.locator('#timed-text-edit-view [data-view="single"]').click();
    await page.locator('#timed-text-edit-single-textarea').fill(text);
    await page.locator('#timed-text-edit-apply').click();
    await expect(page.locator('#timed-text-edit-modal')).not.toHaveClass(/show/);
  };
  await split('甲乙\n丙');
  await page.locator('.cue[data-idx="1"]').click({ button: 'right', force: true });
  await page.locator('.word-timing-advanced > .item').first().click();
  await page.getByText('转为叠加字幕', { exact: true }).click();
  await split('甲\n乙');
  const ids = () => page.evaluate(() => window.AsrEditorUtils.subtitleGroupTracks(MaweBoot.DATA).flatMap(t => t.segments.map(s => s.id)));
  const expected = await ids();
  expect(new Set(expected).size).toBe(3);
  await page.locator('#undo-btn').click();
  expect((await ids()).length).toBe(2);
  await page.locator('#redo-btn').click();
  expect(await ids()).toEqual(expected);
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject())).toBe(true);
  await page.reload();
  await expect(page.locator('#cues-container')).toBeVisible();
  expect(await ids()).toEqual(expected);
  expect(errors).toEqual([]);
});

test('disabled track groups disappear from preview and all timeline exporters without losing membership', async ({ page }) => {
  const result = await page.evaluate(() => {
    const u = window.AsrEditorUtils, data = MaweBoot.DATA;
    // Resolve requires a color or sticker payload; a visible color keeps that
    // export meaningful while the only sticker's track is disabled.
    data.segments.push({ id: 'visible-main', start: 3500, end: 4500, text: 'visible' });
    u.moveSegmentBetweenTracks(data.segments, data.overlay_track.segments, 0);
    data.overlay_track.enabled = false;
    u.assignSubtitleGroup(data, data.segments, [0], 'color', { name: 'blue', value: '#0000ff' });
    u.refreshSubtitleGroupViews(data);
    MaweStickerOverlay.stickerOverlayDataVersion += 1;
    const plan = u.buildProjectExportPlan(data, { durationMs: 5000 });
    return { preview: MaweStickerOverlay.activeStickersAt(1000).length,
      fcp: u.buildFcp7ExportArtifacts(plan, { fps: '30', nativeTextObjects: true })[0].content.includes('cat.png'),
      resolve: JSON.parse(MaweExportTimeline.buildResolveJson()).stickers.length,
      otio: MaweExportTimeline.collectStickerOtioEntries([], data.overlay_track.segments).entries.length,
      groups: data.subtitle_groups.sticker.length };
  });
  expect(result).toEqual({ preview: 0, fcp: false, resolve: 0, otio: 0, groups: 1 });
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject())).toBe(true);
  await page.reload();
  await expect(page.locator('#cues-container')).toBeVisible();
  expect(await page.evaluate(() => {
    MaweBoot.DATA.overlay_track.enabled = true;
    MaweStickerOverlay.stickerOverlayDataVersion += 1;
    return MaweStickerOverlay.activeStickersAt(1000).length;
  })).toBe(1);
});

test('sticker geometry participates in saved checkpoints, undo and actual save/reopen', async ({ page }) => {
  await page.evaluate(async () => {
    MaweDom.stickerOverlayToggle.checked = true;
    MaweDom.stickerOverlayToggle.dispatchEvent(new Event('change'));
    await MaweProjectSave.saveCurrentProject();
  });
  const initial = await page.evaluate(() => MawePreviewGeometry.getStickerGeometry());
  await page.locator('#sticker-overlay-layer').focus();
  await page.keyboard.press('ArrowLeft');
  expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(true);
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(false);
  await page.locator('#redo-btn').click();
  const moved = await page.evaluate(() => MawePreviewGeometry.getStickerGeometry());
  expect(moved.x).toBeLessThan(initial.x);
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject())).toBe(true);
  expect(JSON.parse(readFileSync(projectPath, 'utf8')).preview.sticker).toEqual(moved);
  expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(false);
  await page.reload();
  await expect(page.locator('#cues-container')).toBeVisible();
  expect(await page.evaluate(() => MawePreviewGeometry.getStickerGeometry())).toEqual(moved);
  expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(false);
});

test('manual creation and word conversion reserve IDs after track transfers', async ({ page }) => {
  const ids = await page.evaluate(() => {
    const u = window.AsrEditorUtils, data = MaweBoot.DATA;
    data.segments[0].id = 'main-1';
    u.moveSegmentBetweenTracks(data.segments, data.overlay_track.segments, 0);
    MaweAddCue.addCueRangeFromWaveform(3200, 4200);
    return u.subtitleGroupTracks(data).flatMap(t => t.segments.map(s => s.id));
  });
  expect(ids).toEqual(['main-1-2', 'main-1']);
  // Recreate a timed main cue whose converted first item already exists on a
  // different track, then apply the production conversion dialog.
  await page.evaluate(() => {
    const data = MaweBoot.DATA;
    MaweCuePanel.commitCuePanelEdit();
    MaweCuePanelState.currentCuePanelIdx = -1;
    data.overlay_track.segments[0].id = 'a-item-1';
    data.segments[0] = { id: 'a', start: 3200, end: 4200, text: '甲乙', items: [
      { text: '甲', start: 3200, end: 3700 }, { text: '乙', start: 3700, end: 4200 },
    ] };
    MaweWordTiming.openConversion([0]);
  });
  await expect(page.locator('#word-conversion-summary')).toContainText('生成2条');
  await page.locator('#word-conversion-confirm').click();
  await expect(page.locator('#word-conversion-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject())).toBe(true);
  await page.reload();
  await expect(page.locator('#cues-container')).toBeVisible();
  const saved = await page.evaluate(() => window.AsrEditorUtils.subtitleGroupTracks(MaweBoot.DATA).flatMap(t => t.segments.map(s => s.id)));
  expect(new Set(saved).size).toBe(3);
  expect(saved).toContain('a-item-1-2');
});

test('same-name groups render their own asset and clear at the exact final boundary', async ({ page }) => {
  const result = await page.evaluate(() => {
    const u = window.AsrEditorUtils, data = MaweBoot.DATA;
    data.segments.push({ id: 'second', start: 3100, end: 4000, text: 'second' });
    u.assignSubtitleGroup(data, data.segments, [1], 'sticker', { name: 'cat', rel: 'dog.png' });
    MaweDom.stickerOverlayToggle.checked = true;
    MaweStickerOverlay.stickerOverlayDataVersion += 1;
    MaweStickerOverlay.renderStickerOverlay(1000);
    const first = MaweStickerOverlay.stickerOverlayContent.querySelector('img').src;
    MaweStickerOverlay.renderStickerOverlay(3500);
    const second = MaweStickerOverlay.stickerOverlayContent.querySelector('img').src;
    return { first, second, atEnd: MaweStickerOverlay.activeStickersAt(4000).length,
      afterEnd: MaweStickerOverlay.activeStickersAt(4500).length };
  });
  expect(result.first).toContain('cat.png');
  expect(result.second).toContain('dog.png');
  expect(result.atEnd).toBe(0);
  expect(result.afterEnd).toBe(0);
});
