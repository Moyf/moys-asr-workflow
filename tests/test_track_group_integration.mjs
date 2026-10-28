import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectHarness, readFixture } from './helpers/track-golden.mjs';

test('v1 groups migrate and cross-track groups survive v1.5 save, reopen and TrackStore lookup', () => {
  const fixture = createProjectHarness(readFixture('color-sticker-groups'));
  const { data, h } = fixture;
  const [main, mainRef] = data.segments;
  const [overlay, overlayRef] = data.overlay_track.segments;
  const secondary = data.multi_subtitle.tracks[0].segments[0];
  assert.equal(main.color_group_id, mainRef.color_group_id);
  assert.equal(main.sticker_group_id, mainRef.sticker_group_id);
  assert.equal(overlay.sticker_group_id, overlayRef.sticker_group_id);
  assert.notEqual(main.sticker_group_id, overlay.sticker_group_id);
  const stickerId = main.sticker_group_id, colorId = main.color_group_id;
  h.assignSubtitleGroup(data, data.multi_subtitle.tracks[0].segments, [0], 'sticker', null, stickerId);
  h.assignSubtitleGroup(data, data.overlay_track.segments, [0], 'sticker', null, stickerId);
  h.assignSubtitleGroup(data, data.multi_subtitle.tracks[0].segments, [0], 'color', null, colorId);
  const saved = fixture.save();
  assert.equal(saved.schema, 'moy.asr.project.v1.5');
  assert.equal(saved.multi_subtitle.tracks[0].segments[0].sticker_group_id, stickerId);
  assert.equal(saved.multi_subtitle.tracks[0].segments[0].color_group_id, colorId);
  assert.deepEqual(saved.multi_subtitle.tracks[0].segments[0].custom, { nested: [1, 2] });
  assert.equal(saved.overlay_track.segments[0].sticker_group_id, stickerId);
  assert.equal(saved.subtitle_groups.sticker.find(group => group.id === stickerId).value.filename, 'main.png');
  assert.equal(saved.subtitle_groups.color.find(group => group.id === colorId).value.name, 'red');
  for (const cue of [...saved.segments, ...saved.overlay_track.segments, saved.multi_subtitle.tracks[0].segments[0]]) {
    for (const key of ['color', 'color_ref', 'sticker', 'sticker_ref']) assert.equal(Object.hasOwn(cue, key), false);
  }
  const reopened = createProjectHarness(saved);
  const store = reopened.context.MaweMultiSubtitleCore.getTrackStore();
  assert.equal(store.resolve({ track_id: 'secondary:translation', segment_id: 'secondary' }).segment.sticker_group_id, stickerId);
  assert.equal(store.resolve({ track_id: 'overlay', segment_id: 'overlay-head' }).segment.sticker_group_id, stickerId);
  assert.deepEqual(reopened.save(), saved);
});

test('v1 duplicate cross-track cue IDs migrate without losing bindings or word data', () => {
  const saved = createProjectHarness(readFixture('three-tracks')).save();
  const main = saved.segments[0], secondary = saved.multi_subtitle.tracks[0].segments[0], overlay = saved.overlay_track.segments[0];
  assert.equal(new Set([main.id, secondary.id, overlay.id]).size, 3);
  assert.deepEqual(saved.multi_subtitle.bindings[0].main_segment_ids, [main.id]);
  assert.deepEqual(saved.multi_subtitle.bindings[0].extension_segment_ids, [secondary.id]);
  assert.equal(main.speaker, '示例');
  assert.deepEqual(main.items, [{ start: 1000, end: 3000, text: '主字幕\n第二行', start_frame: 30, end_frame: 90 }]);
  const store = createProjectHarness(saved).context.MaweMultiSubtitleCore.getTrackStore();
  assert.equal(store.resolve({ track_id: 'main', segment_id: main.id }).segment.text, main.text);
  assert.equal(store.resolve({ track_id: 'secondary:translation', segment_id: secondary.id }).segment.text, secondary.text);
  assert.equal(store.resolve({ track_id: 'overlay', segment_id: overlay.id }).segment.text, overlay.text);
});
