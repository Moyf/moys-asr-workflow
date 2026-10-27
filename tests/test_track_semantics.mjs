import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { readFixture } from './helpers/track-golden.mjs';
const load = (context, file) => vm.runInNewContext(fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8'), context);

test('P0 Z/X target is main/secondary only; overlay pointer still falls back to main', () => {
  const data = readFixture('three-tracks');
  const main = data.segments[0], secondary = data.multi_subtitle.tracks[0];
  const context = { window: {}, MaweBoot: { DATA: data },
    MaweSelection: { selectedIdxs: new Set(), selectedExtensionIdxs: new Set(), selectedOverlayIdxs: new Set([0]) },
    MaweContextMenus: { findWaveformCueAtTime: (time, segments) => segments.findIndex(s => s.start <= time && s.end >= time) },
    MaweMultiSubtitleCore: { multiSubtitleVisible: () => true, getExtensionTrack: () => secondary },
  };
  load(context, 'editor/cues/editor-nav-preview.js');
  const target = context.window.MaweNavPreview.getPointerBoundaryEditTarget;
  assert.equal(target({ track: 'main', timeMs: 1800 }).segment, main);
  assert.equal(target({ track: 'extension', trackId: secondary.id, timeMs: 1800 }).segment, secondary.segments[0]);
  assert.equal(target({ track: 'overlay', timeMs: 1800 }).segment, main, 'freeze the current upper-layer gap, do not enable overlay commands in P1');
});

function element() {
  const classes = new Set();
  return { children: [], get childElementCount() { return this.children.length; },
    replaceChildren(...children) { this.children = children; },
    classList: { contains: name => classes.has(name), remove: name => classes.delete(name),
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } };
}
test('P0 overlay text switch does not gate stickers; preview and burn share both sticker switches', () => {
  const data = readFixture('color-sticker-groups');
  const context = { window: {}, activeStickerHasOverlay: false, document: { createElement: element }, MaweBoot: { DATA: data },
    getOverlayTrack: () => data.overlay_track,
    MaweDom: { stickerOverlayToggle: { checked: true } },
    MaweSettings: { EDITOR_SETTINGS: { stickersEnabled: true } },
    MaweSelection: { stickerUrl: sticker => sticker.rel },
  };
  Object.assign(context.window, context);
  load(context, 'editor/media/editor-sticker-overlay.js');
  context.window.MaweStickerOverlay.renderStickerOverlay(500);
  const api = context.window.MaweStickerOverlay;
  assert.equal(api.stickerOverlayContent.childElementCount, 2, 'closed overlay text still supplies its sticker');
  assert.equal(api.stickerIntervals.length, 4, 'group members retain original head context');
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
