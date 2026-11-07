import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEditorModule } from '../helpers/editor-module-loader.mjs';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';

let tempDir, server;

test.beforeAll(async () => {
  tempDir = makeTempDir('ass-position-hit-order');
  const media = join(tempDir, 'synthetic.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=640x360:r=25:d=5', '-c:v', 'libx264', '-y', media]);
  const context = {}; context.window = context;
  loadEditorModule(context, 'shared/editor-utils.js');
  const project = join(tempDir, 'project.mosp');
  writeFileSync(project, JSON.stringify(context.AsrEditorUtils.importProject({ media: 'synthetic.mp4',
    segments: [{ id: 'main', start: 0, end: 2000, text: 'MAIN' }], waveform: generateWaveformPayload(5000) }).project));
  server = await startServer(project, media, await findFreePort());
});

test.afterAll(async () => { await server?.stop(); if (tempDir) cleanupTempDir(tempDir); });

test('overlapping hit targets follow Canvas order when secondary position is set and reset', async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
  await page.goto(server.url);
  await page.waitForFunction(() => window.MaweCoreState?.player?.videoWidth > 0 && window.MaweAssCuePosition);
  await page.evaluate(async () => {
    await loadAssStyleLibrary({ force: true });
    ASS_STYLE_LIBRARY = AsrEditorUtils.defaultAssStyleLibrary();
    Object.assign(MaweSettings.EDITOR_SETTINGS, { assMode: true, assFrameAutoRender: false, autoSaveProject: false });
    MaweDom.overlayToggle.checked = true;
    const secondary = AsrEditorUtils.ensureExtensionTrack(MaweBoot.DATA);
    Object.assign(secondary, { enabled: true, segments: [{ id: 'secondary-cue', start: 0, end: 2000, text: 'SECONDARY' }] });
    MaweBoot.DATA.bilingual.active_track_id = secondary.id;
    MaweDom.extensionOverlayToggle.checked = true;
    const overlay = AsrEditorUtils.ensureOverlayTrack(MaweBoot.DATA);
    Object.assign(overlay, { enabled: true, segments: [{ id: 'automatic-overlay', start: 0, end: 2000, text: 'OVERLAY' }] });
    MaweCoreState.player.currentTime = 1;
    MaweSelection.selectOnly(0);
    // Create both automatic hit targets first. The overlay is appended last.
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const cue = secondary.segments[0];
    const original = MaweAssCanvas.lastRender.tracks.find(record => record.cueId === cue.id);
    cue.assOverride = { pos: { ...(original.positionAnchor || original.anchor) } };
    // Center the manually positioned cue over the existing automatic overlay.
    // Refresh first because moving the cue can change the automatic stack.
    for (let i = 0; i < 3; i++) {
      MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
      const records = MaweAssCanvas.lastRender.tracks;
      const a = records.find(record => record.cueId === 'automatic-overlay').bounds;
      const b = records.find(record => record.cueId === 'secondary-cue').bounds;
      cue.assOverride.pos.x += Math.round((a.left + a.right - b.left - b.right) / 2);
      cue.assOverride.pos.y += Math.round((a.top + a.bottom - b.top - b.bottom) / 2);
    }
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });

  const overlap = await page.evaluate(() => {
    const secondary = document.querySelector('.ass-cue-drag-target[data-cue-id="secondary-cue"]');
    const overlay = document.querySelector('.ass-cue-drag-target[data-cue-id="automatic-overlay"]');
    const a = secondary.getBoundingClientRect(), b = overlay.getBoundingClientRect();
    const left = Math.max(a.left, b.left), right = Math.min(a.right, b.right);
    const top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom);
    const x = (left + right) / 2, y = (top + bottom) / 2;
    const hit = () => document.elementFromPoint(x, y)?.dataset.cueId;
    const actualHit = hit();
    // Reproduce the old fixed CSS z-index without changing DOM creation order.
    const boxes = [...document.querySelectorAll('.ass-cue-drag-target')];
    const oldZ = boxes.map(box => box.style.zIndex);
    boxes.forEach(box => { box.style.zIndex = '8'; });
    const fixedLayerHit = hit();
    boxes.forEach((box, index) => { box.style.zIndex = oldZ[index]; });
    return { x, y, width: right - left, height: bottom - top, actualHit, fixedLayerHit,
      order: MaweAssCanvas.lastRender.tracks.map(record => record.cueId),
      overlayWasAppendedLast: !!(secondary.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  expect(overlap.width).toBeGreaterThan(4);
  expect(overlap.height).toBeGreaterThan(4);
  expect(overlap.overlayWasAppendedLast).toBe(true);
  expect(overlap.order.indexOf('secondary-cue')).toBeGreaterThan(overlap.order.indexOf('automatic-overlay'));
  expect(overlap.fixedLayerHit).toBe('automatic-overlay');
  expect(overlap.actualHit).toBe('secondary-cue');

  // The first gesture selects the visible top cue; the next one moves it.
  await page.mouse.click(overlap.x, overlap.y);
  const secondaryBox = page.locator('.ass-cue-drag-target[data-cue-id="secondary-cue"]');
  await expect(secondaryBox).toHaveClass(/selected/);
  const handle = await page.evaluate(() => {
    const element = document.querySelector('.ass-cue-scale-handle[data-cue-id="secondary-cue"][data-corner="se"]');
    const rect = element.getBoundingClientRect();
    return { hidden: element.hidden, hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element,
      z: Number(getComputedStyle(element).zIndex),
      maxBoxZ: Math.max(...[...document.querySelectorAll('.ass-cue-drag-target')].map(box => Number(getComputedStyle(box).zIndex))) };
  });
  expect(handle.hidden).toBe(false);
  expect(handle.z).toBeGreaterThan(handle.maxBoxZ);
  expect(handle.hit).toBe(true);
  const before = await page.evaluate(() => structuredClone(MaweMultiSubtitleCore.getActiveExtensionTrack().segments[0].assOverride.pos));
  await page.mouse.move(overlap.x, overlap.y);
  await page.mouse.down();
  await page.mouse.move(overlap.x + 20, overlap.y + 10);
  await page.mouse.up();
  const after = await page.evaluate(() => structuredClone(MaweMultiSubtitleCore.getActiveExtensionTrack().segments[0].assOverride.pos));
  expect(after).not.toEqual(before);
  expect(await page.evaluate(() => AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).segments[0].assOverride ?? null)).toBeNull();

  await page.locator('#ass-cue-reset').click();
  const reset = await page.evaluate(() => {
    const records = MaweAssCanvas.lastRender.tracks;
    const secondary = document.querySelector('.ass-cue-drag-target[data-cue-id="secondary-cue"]');
    const overlay = document.querySelector('.ass-cue-drag-target[data-cue-id="automatic-overlay"]');
    return { pos: MaweMultiSubtitleCore.getActiveExtensionTrack().segments[0].assOverride?.pos ?? null,
      order: records.map(record => record.cueId), secondaryZ: Number(getComputedStyle(secondary).zIndex),
      overlayZ: Number(getComputedStyle(overlay).zIndex) };
  });
  expect(reset.pos).toBeNull();
  expect(reset.order.indexOf('secondary-cue')).toBeLessThan(reset.order.indexOf('automatic-overlay'));
  expect(reset.secondaryZ).toBeLessThan(reset.overlayZ);
});

test('secondary remains selectable, draggable and wheel-scalable with main preview off', async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
  await page.goto(server.url);
  await page.waitForFunction(() => window.MaweCoreState?.player?.videoWidth > 0 && window.MaweAssCuePosition);
  await page.evaluate(async () => {
    await loadAssStyleLibrary({ force: true });
    ASS_STYLE_LIBRARY = AsrEditorUtils.defaultAssStyleLibrary();
    Object.assign(MaweSettings.EDITOR_SETTINGS, { assMode: true, assFrameAutoRender: false, autoSaveProject: false });
    const secondary = AsrEditorUtils.ensureExtensionTrack(MaweBoot.DATA);
    Object.assign(secondary, { enabled: true, segments: [{ id: 'secondary-only', start: 0, end: 2000, text: 'SECONDARY' }] });
    MaweBoot.DATA.bilingual.active_track_id = secondary.id;
    MaweCoreState.player.currentTime = 1;
    MaweDom.extensionOverlayToggle.checked = true;
    MaweDom.extensionOverlayToggle.dispatchEvent(new Event('change'));
    MaweDom.overlayToggle.checked = false;
    MaweDom.overlayToggle.dispatchEvent(new Event('change'));
  });
  const box = page.locator('.ass-cue-drag-target[data-cue-id="secondary-only"]');
  await expect(box).toBeVisible();
  await box.click();
  await expect(box).toHaveClass(/selected/);
  const bounds = await box.boundingBox();
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 20, y + 10);
  await page.mouse.up();
  expect(await page.evaluate(() => MaweMultiSubtitleCore.getActiveExtensionTrack().segments[0].assOverride?.pos)).toBeTruthy();
  await page.mouse.move(x + 20, y + 10);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => page.evaluate(() => MaweMultiSubtitleCore.getActiveExtensionTrack().segments[0].assOverride?.scale)).toBeGreaterThan(1);
  const positioned = await page.evaluate(() => structuredClone(MaweMultiSubtitleCore.getActiveExtensionTrack().segments[0].assOverride));
  await page.evaluate(() => {
    MaweMultiSubtitleCore.getActiveExtensionTrack().preview_visible = false;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await expect(box).toHaveCount(0);
  await page.evaluate(() => {
    const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
    track.preview_visible = true; track.export = { enabled: false };
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await expect(box).toBeVisible();
  expect(await page.evaluate(() => MaweMultiSubtitleCore.getActiveExtensionTrack().segments[0].assOverride)).toEqual(positioned);
  expect(await page.evaluate(() => MaweExportSrt.buildAss())).not.toContain('SECONDARY');
  await page.evaluate(() => { MaweMultiSubtitleCore.getActiveExtensionTrack().export.enabled = true; });
  expect(await page.evaluate(() => MaweExportSrt.buildAss())).toContain('SECONDARY');
});
