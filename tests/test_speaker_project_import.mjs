import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareImportedSpeakerIdentities } from '../web/shared/utils/speaker-project-import.js';

const person = (id, extra = {}) => ({ id, name: '同名', color: '#969fab', ...extra });
const targetProject = () => ({
  speakers: [person('spk-001')],
  annotation_mode: 'color', palette_size: 5, speaker_shortcuts: { 1: 'spk-001' },
  tracks: [{ segments: [{ id: 'main', speaker: 'spk-001' }] }],
});

test('separate source people receive fresh IDs even when source IDs, names and colours match', () => {
  const target = targetProject();
  const source = [person('spk-001', { vendor: { keep: 1 } }), person('spk-002'), person('unused')];
  const segments = [{ speaker: 'spk-001', items: [{ text: 'x', start: 0, end: 1 }] },
    { speaker: 'spk-002' }, { speaker: 'spk-001' }, { speaker: null }, {}];
  const before = structuredClone({ target, source, segments });
  const result = prepareImportedSpeakerIdentities(target, source, segments);
  assert.deepEqual(result.segments.map(segment => segment.speaker), ['spk-002', 'spk-003', 'spk-002', null, undefined]);
  assert.deepEqual(result.speakers, [person('spk-001'), person('spk-002', { vendor: { keep: 1 } }), person('spk-003')]);
  assert.deepEqual({ target, source, segments }, before);
  result.speakers[1].vendor.keep = 2;
  result.segments[0].items[0].text = 'changed';
  assert.equal(source[0].vendor.keep, 1);
  assert.equal(segments[0].items[0].text, 'x');
});

test('each independent import allocates again without changing project palette, mode or shortcuts', () => {
  const target = targetProject();
  const first = prepareImportedSpeakerIdentities(target, [person('spk-001')], [{ speaker: 'spk-001' }]);
  target.speakers = first.speakers;
  const second = prepareImportedSpeakerIdentities(target, [person('spk-001')], [{ speaker: 'spk-001' }]);
  assert.equal(second.segments[0].speaker, 'spk-003');
  assert.equal(target.annotation_mode, 'color');
  assert.equal(target.palette_size, 5);
  assert.deepEqual(target.speaker_shortcuts, { 1: 'spk-001' });
});

test('unassigned subtitles create no identities and retain all subtitle payloads', () => {
  const target = targetProject();
  const segments = [{ speaker: null, text: 'x', color_group_id: 'c', vendor: { keep: [] } }];
  const result = prepareImportedSpeakerIdentities(target, [person('unused')], segments);
  assert.deepEqual(result.speakers, target.speakers);
  assert.deepEqual(result.segments, segments);
  assert.deepEqual(prepareImportedSpeakerIdentities(target, undefined, segments), result);
});

test('missing tables, dangling references and word-level identities fail without changing either project', () => {
  const target = targetProject();
  const before = structuredClone(target);
  for (const [source, segments] of [[undefined, [{ speaker: 'spk-001' }]],
    [[person('other')], [{ speaker: 'spk-001' }]],
    [[person('spk-001')], [{ speaker: 'spk-001', items: [{ speaker: 'spk-001' }] }]]]) {
    const sourceBefore = structuredClone({ source, segments });
    assert.throws(() => prepareImportedSpeakerIdentities(target, source, segments), /speaker/);
    assert.deepEqual({ source, segments }, sourceBefore);
    assert.deepEqual(target, before);
  }
  assert.throws(() => prepareImportedSpeakerIdentities({ ...target, speakers: null }, [], []), /speakers/);
});
