import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createUtilsModule } from '../web/shared/utils/project-tracks.js';
const model = createUtilsModule();
const mixed = id => ({ id, start: 0, end: 200, text: '甲乙', vendor: { keep: 1 }, items: [
  { start: 0, end: 100, text: '甲', speaker: 'source-A' }, { start: 100, end: 200, text: '乙', speaker: 'source-B' },
] });
const legacy = () => ({ schema: 'moy.asr.project.v1', segments: [mixed('a')],
  multi_subtitle: { enabled: true, tracks: [{ id: 'secondary', segments: [mixed('b')] }],
    bindings: [{ id: 'binding', track_id: 'secondary', main_segment_ids: ['a'], extension_segment_ids: ['b'] }] } });

test('JS/Python input boundaries agree on split identities and one-to-one bindings', () => {
  for (const variant of ['paired', 'independent', 'old-v2', 'long']) {
    const raw = legacy();
    if (variant === 'long') {
      raw.segments[0].id = '😀'.repeat(160);
      raw.multi_subtitle.tracks[0].segments[0].id = '乙'.repeat(160);
      Object.assign(raw.multi_subtitle.bindings[0], { id: '绑'.repeat(160),
        main_segment_ids: [raw.segments[0].id], extension_segment_ids: [raw.multi_subtitle.tracks[0].segments[0].id] });
    }
    if (variant === 'independent') {
      raw.multi_subtitle.tracks[0].segments[0].items.forEach(item => { delete item.speaker; });
    }
    let input = raw;
    if (variant === 'old-v2') {
      input = { schema: 'moy.asr.project.v2', tracks: [{ id: 'main', name: 'Main', role: 'main', enabled: true, segments: [mixed('a')] }],
        bindings: [], bilingual: { display_mode: 'both' }, subtitle_groups: { next_id: 1, color: [], sticker: [] } };
    }
    const before = JSON.parse(JSON.stringify(input));
    const actual = model.importProject(input);
    assert.deepEqual(input, before);
    assert.equal(actual.project.speakers.length, 2);
    assert.equal(actual.project.palette_size, 5);
    assert.equal(actual.project.tracks[0].segments.length, 2);
    assert.deepEqual(actual.project.tracks[0].segments.map(cue => cue.text), ['甲', '乙']);
    assert.equal(actual.project.bindings.length, ['paired', 'long'].includes(variant) ? 2 : 0);
    for (const id of [...actual.project.tracks.flatMap(track => track.segments.map(cue => cue.id)),
      ...actual.project.bindings.map(binding => binding.id)]) assert.ok(Array.from(id).length <= 160);
    if (variant === 'independent') assert.ok(actual.changes.some(change => change.path === '$.bindings' && change.before.length === 1 && change.after.length === 0));
    const python = spawnSync(process.env.MAW_TEST_PYTHON || 'python', ['-c',
      'import json,sys; from maw.project_tracks import import_project; result=import_project(json.load(sys.stdin)); print(json.dumps(dict(project=result.project,changes=result.changes),ensure_ascii=True))'],
    { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
    assert.equal(python.status, 0, python.stderr);
    const expected = JSON.parse(python.stdout);
    assert.deepEqual(actual.project, expected.project);
    assert.deepEqual(model.importProject(actual.project), { project: actual.project, changes: [] });
    if (variant === 'independent') assert.deepEqual(actual.changes.find(c => c.path === '$.bindings'), expected.changes.find(c => c.path === '$.bindings'));
  }
});
