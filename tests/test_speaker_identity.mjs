import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProjectSpeakers } from '../web/shared/utils/speaker-identity.js';
import { createUtilsModule } from '../web/shared/utils/project-tracks.js';

test('canonical import and validation enforce speaker references, settings and collapsed slots', () => {
  const model = createUtilsModule();
  const project = model.makeProject([{ start: 0, end: 100, text: 'x', speaker: null }], { projectFields: {
    speakers: [{ id: 'p1', name: '同名', color: '#969fab' }, { id: 'p2', name: '同名', color: '#969fab' }],
    annotation_mode: 'color', palette_size: 5, speaker_shortcuts: { 1: 'p1', 6: 'p2' }, vendor: { keep: 1 },
  } });
  assert.deepEqual(model.importProject(project).project, project);
  const oldCore = structuredClone(project);
  for (const field of ['speakers', 'annotation_mode', 'palette_size', 'speaker_shortcuts']) delete oldCore[field];
  assert.equal(model.validateTracksProject(oldCore).ok, false);
  assert.deepEqual(model.importProject(oldCore).project.speakers, []);
  for (const [fields, path] of [
    [{ palette_size: true }, '$.palette_size'], [{ annotation_mode: 'bad' }, '$.annotation_mode'],
    [{ speaker_shortcuts: { 0: 'p1' } }, '$.speaker_shortcuts.0'],
    [{ speaker_shortcuts: { 6: 'missing' } }, '$.speaker_shortcuts.6'],
    [{ speaker_shortcuts: null }, '$.speaker_shortcuts'],
  ]) {
    assert.ok(model.validateTracksProject({ ...project, ...fields }).errors.some(error => error.path === path));
  }
  const invalid = structuredClone(project);
  invalid.tracks[0].segments[0].speaker = 'missing';
  assert.throws(() => model.importProject(invalid), /must reference a project speaker/);
  invalid.tracks[0].segments[0].speaker = 'p1';
  invalid.tracks[0].segments[0].items = [{ start: 0, end: 100, text: 'x', speaker: 'p1' }];
  assert.throws(() => model.importProject(invalid), /speaker belongs to the segment/);
});

test('project speaker identities remain distinct when names and colors are equal', () => {
  const project = { speakers: [{ id: 'p1', name: '主持人', color: '#f9ca1f' },
    { id: 'p2', name: '主持人', color: '#f9ca1f' }],
  tracks: [{ segments: [{ speaker: 'p1' }, { speaker: 'p2' }, { speaker: null }] }] };
  assert.deepEqual(validateProjectSpeakers(project), []);
});

test('project speaker validation rejects dangling identities and per-word speaker fields', () => {
  const project = { speakers: [{ id: 'p1', name: '一', color: '#f9ca1f' }],
    tracks: [{ segments: [{ speaker: 'missing', items: [{ speaker: 'p1' }] }] }] };
  assert.deepEqual(validateProjectSpeakers(project).map(error => error.path),
    ['$.tracks[0].segments[0].speaker', '$.tracks[0].segments[0].items[0].speaker']);
});

test('project speaker validation rejects duplicate identities and invalid names or colors', () => {
  const project = { speakers: [{ id: 'p1', name: '一', color: '#f9ca1f' },
    { id: 'p1', name: 'bad\nname', color: 'grey' }], tracks: [] };
  assert.deepEqual(validateProjectSpeakers(project).map(error => error.path),
    ['$.speakers[1].id', '$.speakers[1].name', '$.speakers[1].color']);
});

test('project speaker validation reports invalid project shape', () => {
  assert.deepEqual(validateProjectSpeakers(null).map(error => error.path), ['$']);
  assert.deepEqual(validateProjectSpeakers({}).map(error => error.path), ['$.speakers', '$.tracks']);
});

test('unicode-only whitespace IDs are invalid across Python and JavaScript', () => {
  for (const id of ['\u0085', '\ufeff', '\u001c']) {
    const project = { speakers: [{ id, name: 'x', color: '#f9ca1f' }], tracks: [] };
    assert.deepEqual(validateProjectSpeakers(project).map(error => error.path), ['$.speakers[0].id']);
  }
});

import { readFileSync } from 'node:fs';
import { migrateSpeakerSegments } from '../web/shared/utils/speaker-identity.js';

test('legacy speaker migration matches the shared fixture and is idempotent', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/speaker-migration.json', import.meta.url), 'utf8'));
  const source = structuredClone(fixture.segments);
  const actual = migrateSpeakerSegments(source, fixture.mapping, fixture.reserved_ids);
  assert.deepEqual(actual, { segments: fixture.expected, mappings: fixture.expected_mappings });
  assert.deepEqual(source, fixture.segments);
  assert.deepEqual(migrateSpeakerSegments(actual.segments, { p6: 'p6', p01: 'p01', pold: 'pold' }).segments, actual.segments);
  assert.deepEqual(migrateSpeakerSegments(fixture.punctuation.segments, fixture.mapping).segments, fixture.punctuation.expected);
});

test('legacy migration refuses to invent text, time, frame boundaries, or identity', () => {
  const source = [{ id: 'a', text: 'ab', start: 0, end: 2, items: [
    { text: 'a', start: 0, end: 1, speaker: 'one' },
    { text: 'b', start: 1, end: 2, speaker: 'two' },
  ] }];
  const mapping = { one: 'p1', two: 'p2' };
  const badText = structuredClone(source); badText[0].text = 'changed';
  assert.throws(() => migrateSpeakerSegments(badText, mapping), /matching item text/);
  const badTime = structuredClone(source); delete badTime[0].items[1].start;
  assert.throws(() => migrateSpeakerSegments(badTime, mapping), /integer item timestamps/);
  const badFrames = structuredClone(source); Object.assign(badFrames[0], { start_frame: 0, end_frame: 2 });
  assert.throws(() => migrateSpeakerSegments(badFrames, mapping), /item frame boundaries/);
  assert.throws(() => migrateSpeakerSegments([{ speaker: 'one' }], {}), /unmapped source speaker/);
  assert.throws(() => migrateSpeakerSegments([{ id: 'a' }, { id: 'a' }], {}), /duplicate segment id/);
});
