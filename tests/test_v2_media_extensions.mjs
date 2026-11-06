import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

const fixture = { window: {} };
loadEditorModule(fixture, 'shared/editor-utils.js');
const utils = fixture.window.AsrEditorUtils;
const plain = value => JSON.parse(JSON.stringify(value));

test('media metadata normalization retains project and audio track extensions', () => {
  const input = { video_width: 1920, video_height: 1080, video_fps: 30000 / 1001,
    video_fps_ratio: ' 30000/1001 ', vendor: { flag: false, zero: 0, empty: [] },
    audio_tracks: [{ stream_index: 2, codec: ' aac ', language: ' en ', channels: null,
      sample_rate: 48000, default: true, vendor: { flag: false, zero: 0, empty: [] } }] };
  const before = structuredClone(input);
  const normalized = plain(utils.normalizeMediaMetadata(input));
  assert.deepEqual(input, before);
  assert.deepEqual(normalized, { video_width: 1920, video_height: 1080, video_fps: 29.97,
    video_fps_ratio: '30000/1001', vendor: before.vendor,
    audio_tracks: [{ audio_index: 0, stream_index: 2, codec: 'aac', language: 'en', channels: null,
      sample_rate: 48000, default: true, vendor: before.audio_tracks[0].vendor }] });
  assert.deepEqual(plain(utils.normalizeMediaMetadata({ vendor: before.vendor })), { vendor: before.vendor });
  assert.equal(utils.normalizeMediaMetadata({}), null);
});

test('invalid managed metadata still fails instead of being revived by extension preservation', () => {
  for (const input of [
    { vendor: false, video_width: 1920 },
    { vendor: false, video_fps: 300 },
    { vendor: false, video_fps: 30, video_fps_ratio: ' ' },
    { vendor: false, audio_tracks: [{ stream_index: -1, vendor: 0 }] },
    { vendor: false, audio_tracks: [{ stream_index: 0, default: 'false', vendor: [] }] },
    { vendor: false, selected_audio_track: -1 },
  ]) {
    const before = structuredClone(input);
    assert.equal(utils.normalizeMediaMetadata(input), null);
    assert.deepEqual(input, before);
  }
});

test('video dimensions update and clear keep media and audio extension fields', () => {
  const media = { video_width: 640, video_height: 360, vendor: { empty: [], keep: false },
    audio_tracks: [{ stream_index: 3, codec: ' opus ', vendor: { flag: false, value: 0 } }] };
  const player = { tagName: 'VIDEO', videoWidth: 1920, videoHeight: 1080 };
  let saves = 0;
  const context = { window: { AsrEditorUtils: utils }, MaweBoot: { DATA: { media_metadata: media } },
    MaweCoreState: { player }, MaweServerSave: { projectImportDirty: false, scheduleAutoSaveFlush() { saves++; } } };
  vm.runInNewContext(readFileSync(new URL('../web/editor/cues/editor-timeline.js', import.meta.url), 'utf8'), context);
  const timeline = context.window.MaweTimeline;
  assert.equal(timeline.captureProjectVideoDimensions(player), true);
  assert.deepEqual(plain(context.MaweBoot.DATA.media_metadata), {
    video_width: 1920, video_height: 1080, vendor: media.vendor,
    audio_tracks: [{ audio_index: 0, stream_index: 3, codec: 'opus', channels: null, sample_rate: null, default: false,
      vendor: media.audio_tracks[0].vendor }] });
  assert.equal(timeline.captureProjectVideoDimensions(player), false);
  assert.equal(saves, 1);
  assert.equal(timeline.clearProjectVideoDimensions(), true);
  assert.deepEqual(plain(context.MaweBoot.DATA.media_metadata.vendor), media.vendor);
  assert.deepEqual(plain(context.MaweBoot.DATA.media_metadata.audio_tracks[0].vendor), media.audio_tracks[0].vendor);
  assert.equal(Object.hasOwn(context.MaweBoot.DATA.media_metadata, 'video_width'), false);
  assert.equal(Object.hasOwn(context.MaweBoot.DATA.media_metadata, 'video_height'), false);
  assert.equal(saves, 2);
  context.MaweBoot.DATA.media_metadata = { video_width: 640, video_height: 360, vendor: { keep: false } };
  assert.equal(timeline.clearProjectVideoDimensions(), true);
  assert.deepEqual(plain(context.MaweBoot.DATA.media_metadata), { vendor: { keep: false } });
});
