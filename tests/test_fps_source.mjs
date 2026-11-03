import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { runtimeProject } from './helpers/runtime-project.mjs';

function harness(timebase, acceptRemap = true) {
  const data = runtimeProject([{
    id: 's', start: 101, end: 899, start_frame: 3, end_frame: 27, text: 'hello',
    items: [{ start: 101, end: 899, start_frame: 3, end_frame: 27, text: 'hello' }],
  }], { timebase, media_metadata: { video_fps: 25 }, extensions: [{ id: 'translation', enabled: true,
    segments: [{ id: 'translated', start: 118, end: 916, text: 'translation' }] }], bindings: [{ id: 'binding',
    source: { track_id: 'main', segment_id: 's' }, target: { track_id: 'translation', segment_id: 'translated' },
    start_offset_ms: 17, end_offset_ms: 17 }] });
  let saves = 0, confirms = 0;
  const context = { window: { confirm: () => { confirms++; return acceptRemap; } },
    MaweBoot: { DATA: data }, MaweDom: {}, MaweSettings: { EDITOR_SETTINGS: {} },
    MaweMediaPlayback: { refreshMediaSeekStepHelp() {}, refreshMediaSeekControlLabels() {} },
    MaweServerSave: { scheduleAutoSaveFlush() { saves++; } },
    MaweCuePanel: { renderAll() {} }, MaweHint: { flashHint() {} },
  };
  loadEditorModule(context, 'shared/editor-utils.js');
  vm.runInNewContext(fs.readFileSync(new URL('../web/editor/cues/editor-timeline.js', import.meta.url), 'utf8'), context);
  return { data, api: context.window.MaweTimeline, utils: context.window.AsrEditorUtils,
    state: context.MaweServerSave, saves: () => saves, confirms: () => confirms };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('source round trips without inventing missing legacy intent; rejects invalid enum values', () => {
  const { utils } = harness();
  for (const source of ['auto', 'user', undefined]) {
    const input = { unit: 'frames', fps: 23.976, ...(source ? { fps_source: source } : {}) };
    assert.deepEqual(plain(utils.normalizeTimelineTimebase(input)), input);
  }
  for (const source of [null, '', false, 0, [], {}, 'AUTO']) {
    assert.throws(() => utils.normalizeTimelineTimebase({ fps_source: source }), /fps_source/);
  }
});

test('same-value 30 commits user source and schedules saving without touching any timing or offsets', () => {
  for (const unit of ['milliseconds', 'frames']) {
    for (const source of [undefined, 'auto']) {
      const h = harness({ unit, fps: 30, ...(source ? { fps_source: source } : {}) });
      const before = plain(h.data);
      h.api.setTimelineTimebase({ fps: '30' });
      assert.deepEqual(plain(h.data), { ...before, timebase: { unit, fps: 30, fps_source: 'user' } });
      assert.equal(h.saves(), 1);
      assert.equal(h.confirms(), 0);
      assert.equal(h.state.projectImportDirty, true);
      h.api.setTimelineTimebase({ fps: '30' });
      assert.equal(h.saves(), 1);
    }
  }
});

test('explicit sources override legacy inference and reflect project restoration immediately', () => {
  const h = harness({ unit: 'milliseconds', fps: 30 });
  for (const [timebase, manual] of [
    [{ unit: 'milliseconds', fps: 30 }, false],
    [{ unit: 'milliseconds', fps: 25 }, true],
    [{ unit: 'frames', fps: 30 }, true],
    [{ unit: 'frames', fps: 25, fps_source: 'auto' }, false],
    [{ unit: 'milliseconds', fps: 30, fps_source: 'user' }, true],
  ]) {
    h.data.timebase = timebase;
    h.api.timelineFpsManuallySet = h.api.hasExplicitTimelineFps(timebase);
    assert.equal(h.api.timelineFpsManuallySet, manual);
  }
});

test('automatic media adoption survives reopen and uses replacement metadata only on frame entry', () => {
  const h = harness({ unit: 'milliseconds', fps: 30 });
  h.api.setTimelineTimebase({ unit: 'frames' });
  assert.deepEqual(plain(h.data.timebase), { unit: 'frames', fps: 25, fps_source: 'auto' });
  const reopened = harness(plain(h.data.timebase));
  reopened.data.media_metadata.video_fps = 24;
  assert.equal(reopened.data.timebase.fps, 25);
  reopened.api.setTimelineTimebase({ unit: 'milliseconds' });
  reopened.api.setTimelineTimebase({ unit: 'frames' });
  assert.deepEqual(plain(reopened.data.timebase), { unit: 'frames', fps: 24, fps_source: 'auto' });
});

test('user 30 and fractional FPS survive replacement media and frame entry', () => {
  for (const fps of [30, 23.976]) {
    const h = harness({ unit: 'milliseconds', fps: 30 });
    h.api.setTimelineTimebase({ fps });
    const reopened = harness(plain(h.data.timebase));
    reopened.data.media_metadata.video_fps = 24;
    reopened.api.setTimelineTimebase({ unit: 'frames' });
    assert.equal(reopened.data.timebase.fps, fps);
    assert.equal(reopened.data.timebase.fps_source, 'user');
  }
});


test('cancelling a frame remap preserves both timing and FPS intent', () => {
  const h = harness({ unit: 'frames', fps: 25, fps_source: 'auto' }, false);
  const before = plain(h.data);
  h.api.setTimelineTimebase({ fps: 23.976 });
  assert.deepEqual(plain(h.data), before);
  assert.equal(h.confirms(), 1);
  assert.equal(h.saves(), 0);
  assert.equal(h.api.timelineFpsManuallySet, false);
});


test('legacy frame 30 preserves its original session inference through mode switches', () => {
  const h = harness({ unit: 'frames', fps: 30 });
  h.api.setTimelineTimebase({ unit: 'milliseconds' });
  assert.equal(h.api.timelineFpsManuallySet, true);
  h.api.setTimelineTimebase({ unit: 'frames' });
  assert.deepEqual(plain(h.data.timebase), { unit: 'frames', fps: 30 });
});
