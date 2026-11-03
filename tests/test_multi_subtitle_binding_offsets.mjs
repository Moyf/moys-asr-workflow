import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createUtilsModule as data } from '../web/shared/utils/data.js';
import { createUtilsModule as multi } from '../web/shared/utils/multi-subtitle.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/project-tracks/legacy-three-tracks.expected.json', import.meta.url), 'utf8'));
const runtime = () => multi(data({}));

function compare(project) {
  const utils = runtime();
  utils.setBindingIndexEnabled(false);
  const linear = utils.rebuildBindingOffsets(structuredClone(project));
  utils.setBindingIndexEnabled(true);
  const indexed = utils.rebuildBindingOffsets(structuredClone(project));
  assert.deepEqual(indexed, linear);
  return indexed;
}
test('v2 binding index defaults on and preserves endpoint offsets, groups and record identities', () => {
  const utils = runtime(), project = fixture(), before = structuredClone(project);
  assert.equal(utils.isBindingIndexEnabled(), true);
  const binding = project.bindings[0], segment = project.tracks[0].segments[0];
  assert.equal(utils.rebuildBindingOffsets(project), project);
  assert.equal(project.bindings[0], binding);
  assert.equal(project.tracks[0].segments[0], segment);
  assert.deepEqual(project.subtitle_groups, before.subtitle_groups);
  assert.deepEqual(project, compare(before));
  utils.setBindingIndexEnabled(false);
  assert.equal(utils.isBindingIndexEnabled(), false);
});
test('index follows in-place edits, reorder, replacement, undo/redo and new projects', () => {
  const project = fixture(), history = structuredClone(project);
  for (const track of project.tracks) { track.segments.reverse(); track.segments.forEach(cue => { cue.start += 17; cue.end += 29; }); }
  compare(project);
  project.tracks[1].segments = structuredClone(project.tracks[1].segments);
  compare(project); compare(history); compare(project); compare(fixture());
});
test('main/secondary role exchange keeps CueRef resolution and group data identical', () => {
  const utils = runtime(), project = fixture();
  assert.equal(utils.swapMainAndExtensionSubtitle(project).swapped, true);
  compare(project);
});
test('missing references keep previous offsets; strict lookup keeps first duplicates and rejects NaN', () => {
  const project = fixture();
  const ref = project.bindings[0].target;
  const track = project.tracks.find(t => t.id === ref.track_id);
  const cue = track.segments.find(c => c.id === ref.segment_id);
  track.segments.unshift({ ...cue, start: cue.start + 100 });
  project.tracks.push({ ...track, segments: [{ ...cue, start: cue.start + 999 }] });
  project.bindings.push({ source: { track_id: 'missing', segment_id: 'missing' }, target: ref, start_offset_ms: 77, end_offset_ms: 88 });
  project.bindings.push({ source: project.bindings[0].source, target: { track_id: ref.track_id, segment_id: NaN }, start_offset_ms: 77, end_offset_ms: 88 });
  compare(project);
  assert.equal(compare(project).bindings.at(-1).start_offset_ms, 77);
  assert.equal(runtime().rebuildBindingOffsets(null), null);
});
test('indexed path traverses a referenced track once per sync, not once per binding', () => {
  const utils = runtime(), project = fixture();
  project.bindings = Array.from({ length: 100 }, () => structuredClone(project.bindings[0]));
  let finds = 0;
  for (const track of project.tracks) track.segments.find = function (...args) { finds++; return Array.prototype.find.apply(this, args); };
  utils.rebuildBindingOffsets(project);
  assert.equal(finds, 0);
  utils.setBindingIndexEnabled(false);
  utils.rebuildBindingOffsets(project);
  assert.equal(finds, 200);
});
