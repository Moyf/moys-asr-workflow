import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectHarness, readFixture } from './helpers/track-golden.mjs';

test('v1 groups migrate and cross-track groups survive v2 save, reopen and TrackStore lookup', () => {
  const fixture = createProjectHarness(readFixture('color-sticker-groups'));
  const { data, h } = fixture;
  const [main, mainRef] = h.getMainTrack(data).segments;
  const [overlay, overlayRef] = h.getOverlayTrack(data).segments;
  const secondaryTrack = h.getExtensionTrack(data);
  assert.equal(main.color_group_id, mainRef.color_group_id);
  assert.equal(main.sticker_group_id, mainRef.sticker_group_id);
  assert.equal(overlay.sticker_group_id, overlayRef.sticker_group_id);
  assert.notEqual(main.sticker_group_id, overlay.sticker_group_id);
  const stickerId = main.sticker_group_id, colorId = main.color_group_id;
  const stickerValue = h.getSubtitleGroupValue(data, main, 'sticker');
  const colorValue = h.getSubtitleGroupValue(data, main, 'color');
  h.assignSubtitleGroup(data, secondaryTrack.segments, [0], 'sticker', stickerValue, stickerId);
  h.assignSubtitleGroup(data, h.getOverlayTrack(data).segments, [0], 'sticker', stickerValue, stickerId);
  h.assignSubtitleGroup(data, secondaryTrack.segments, [0], 'color', colorValue, colorId);
  const saved = fixture.save();
  assert.equal(saved.schema, 'moy.asr.project.v2');
  assert.equal(h.getExtensionTrack(saved).segments[0].sticker_group_id, stickerId);
  assert.equal(h.getExtensionTrack(saved).segments[0].color_group_id, colorId);
  assert.deepEqual(h.getExtensionTrack(saved).segments[0].custom, { nested: [1, 2] });
  assert.equal(h.getOverlayTrack(saved).segments[0].sticker_group_id, stickerId);
  assert.equal(saved.subtitle_groups.sticker.find(group => group.id === stickerId).value.filename, 'main.png');
  assert.equal(saved.subtitle_groups.color.find(group => group.id === colorId).value.name, 'red');
  for (const cue of [...h.getMainTrack(saved).segments, ...h.getOverlayTrack(saved).segments, h.getExtensionTrack(saved).segments[0]]) {
    for (const key of ['color', 'color_ref', 'sticker', 'sticker_ref']) assert.equal(Object.hasOwn(cue, key), false);
  }
  const reopened = createProjectHarness(saved);
  const store = reopened.context.MaweMultiSubtitleCore.getTrackStore();
  assert.equal(store.resolve({ track_id: 'translation', segment_id: 'secondary' }).segment.sticker_group_id, stickerId);
  assert.equal(store.resolve({ track_id: 'overlay', segment_id: 'overlay-head' }).segment.sticker_group_id, stickerId);
  assert.deepEqual(reopened.save(), saved);
});

test('v1 duplicate cross-track cue IDs migrate without losing bindings or word data', () => {
  const fixture = createProjectHarness(readFixture('three-tracks'));
  const saved = fixture.save(), h = fixture.h;
  const main = h.getMainTrack(saved).segments[0], secondary = h.getExtensionTrack(saved).segments[0], overlay = h.getOverlayTrack(saved).segments[0];
  assert.equal(new Set([main.id, secondary.id, overlay.id]).size, 3);
  assert.deepEqual(saved.bindings[0].source, { track_id: h.getMainTrack(saved).id, segment_id: main.id });
  assert.deepEqual(saved.bindings[0].target, { track_id: h.getExtensionTrack(saved).id, segment_id: secondary.id });
  assert.equal(main.speaker, 'spk-001');
  assert.equal(saved.speakers.find(speaker => speaker.id === main.speaker).name, '说话人 1');
  assert.deepEqual(main.items, [{ start: 1000, end: 3000, text: '主字幕\n第二行', start_frame: 30, end_frame: 90 }]);
  const store = createProjectHarness(saved).context.MaweMultiSubtitleCore.getTrackStore();
  assert.equal(store.resolve({ track_id: 'main', segment_id: main.id }).segment.text, main.text);
  assert.equal(store.resolve({ track_id: 'translation', segment_id: secondary.id }).segment.text, secondary.text);
  assert.equal(store.resolve({ track_id: 'overlay', segment_id: overlay.id }).segment.text, overlay.text);
});
