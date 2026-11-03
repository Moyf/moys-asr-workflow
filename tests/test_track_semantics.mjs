import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { readFixture, createProjectHarness, initializeStickerOverlay } from './helpers/track-golden.mjs';
const load = (context, file) => vm.runInNewContext(fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8'), context);

test('Z/X targets the current track and uses main when selection is empty', () => {
  const { data, h } = createProjectHarness(readFixture('three-tracks'));
  const main = h.getMainTrack(data), secondary = h.getExtensionTrack(data), overlay = h.getOverlayTrack(data);
  let refs = [], current = null;
  const context = { window: { AsrEditorUtils: h }, MaweBoot: { DATA: data },
    MaweState: { selection: { getSelectedCueRefs: () => refs, getCurrentCueRef: () => current,
      getCurrentTrack: () => data.tracks.find(t => t.id === current?.track_id) || main } },
    MaweContextMenus: { findWaveformCueAtTime: (time, segments) => segments.findIndex(s => s.start <= time && s.end >= time) },
    MaweMultiSubtitleCore: {},
  };
  load(context, 'editor/cues/editor-nav-preview.js');
  const target = context.window.MaweNavPreview.getPointerBoundaryEditTarget;
  assert.equal(target({ track: 'overlay', timeMs: 1800 }).segment, main.segments[0]);
  for (const track of [secondary, overlay]) {
    current = { track_id: track.id, segment_id: track.segments[0].id }; refs = [current];
    assert.equal(target({ track: 'main', timeMs: 1800 }).segment, track.segments[0]);
  }
});

function element() {
  const classes = new Set();
  return { children: [], get childElementCount() { return this.children.length; },
    replaceChildren(...children) { this.children = children; },
    classList: { contains: name => classes.has(name), remove: name => classes.delete(name),
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } };
}
test('disabled overlay is excluded from stickers; preview and burn share both sticker switches', () => {
  const { context, h } = createProjectHarness(readFixture('color-sticker-groups'));
  Object.assign(context, {
    document: { createElement: element },
    MaweStickerPreviewWiring: { activeStickerHasOverlay: false },
    MaweDom: { stickerOverlayToggle: { checked: true } },
    MaweSettings: { EDITOR_SETTINGS: { stickersEnabled: true } },
    MaweSelection: { stickerUrl: sticker => sticker.rel },
  });
  initializeStickerOverlay(context);
  context.window.MaweStickerOverlay.renderStickerOverlay(500);
  const api = context.window.MaweStickerOverlay;
  assert.equal(api.stickerOverlayContent.childElementCount, 1, 'disabled overlay sticker is excluded');
  assert.ok(api.stickerIntervals.every(interval => !interval.hasOverlay), 'disabled overlay does not contribute intervals');
  h.getOverlayTrack(context.MaweBoot.DATA).enabled = true;
  api.stickerOverlayDataVersion += 1;
  api.renderStickerOverlay(500);
  assert.equal(api.stickerOverlayContent.childElementCount, 2, 're-enabling overlay restores its sticker');
  load(context, 'editor/io/editor-sticker-burn-plan.js');
  const burn = context.window.MaweStickerBurnPlan;
  assert.equal(burn.stickerBurnEnabled(), true);
  context.MaweDom.stickerOverlayToggle.checked = false;
  api.renderStickerOverlay(500);
  assert.equal(api.stickerOverlayContent.childElementCount, 0);
  assert.equal(burn.stickerBurnEnabled(), false);
  context.MaweDom.stickerOverlayToggle.checked = true;
  context.MaweSettings.EDITOR_SETTINGS.stickersEnabled = false;
  api.renderStickerOverlay(500);
  assert.equal(api.stickerOverlayContent.childElementCount, 0);
  assert.equal(burn.stickerBurnEnabled(), false);
});
