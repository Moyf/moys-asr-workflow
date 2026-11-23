import assert from 'node:assert/strict';
import test from 'node:test';
import { createUtilsModule } from '../web/shared/utils/project-tracks.js';
import { cueStyleUpdates, cueStyleWriter } from '../web/shared/utils/cue-styles.js';

const model = createUtilsModule();

test('1000 legacy snapshots migrate to one fixed entry, including extension fields', () => {
  const style = { id: 'custom', fontSize: 54, vendor: { field: 1 } };
  const segments = Array.from({ length: 1000 }, (_, i) => ({
    start: i * 10, end: i * 10 + 10, text: 'A',
    assStyle: i % 2 ? style : { vendor: { field: 1 }, fontSize: 54, id: 'custom' },
  }));
  const project = model.importProject({ segments }).project;
  assert.equal(project.cue_styles?.length, 1);
  const [entry] = project.cue_styles;
  assert.deepEqual(entry.style, style);
  assert.equal(entry.library_id, undefined);
  assert.ok(project.tracks[0].segments.every(cue => cue.cue_style_id === entry.id && !('assStyle' in cue)));
  assert.deepEqual(model.importProject(project).changes, []);
  assert.equal(segments[0].assStyle.fontSize, 54);
});

test('following, fixed and missing-library entries keep independent definitions', () => {
  const project = model.makeProject([{ start: 0, end: 10, text: 'A' }]);
  const style = { id: 'custom', name: 'Old', fontSize: 44 };
  const store = cueStyleWriter(project);
  const fixed = store({ style });
  const follow = store({ style, library_id: style.id });
  assert.notEqual(fixed, follow);
  assert.equal(store({ style, library_id: style.id }), follow);
  project.tracks[0].segments[0].cue_style_id = follow;
  const library = { styles: [{ ...style, name: 'New', fontSize: 55 }] };
  assert.deepEqual(cueStyleUpdates(project, { styles: [] }), []);
  assert.deepEqual(cueStyleUpdates(project, library, library), []);
  const changes = cueStyleUpdates(project, library, { styles: [style] });
  assert.deepEqual(changes.map(change => change.entry.id), [follow]);
  assert.equal(changes[0].style.name, 'New');
  assert.equal(model.importProject(project).project.cue_styles[0].style.fontSize, 44);
  project.tracks[0].segments[0].cue_style_id = 'unknown';
  assert.throws(() => model.importProject(project), /cue_style_id/);
});

test('linked snapshots that converge are written once without changing the open project', () => {
  const project = model.makeProject([{ start: 0, end: 10, text: 'A' }, { start: 10, end: 20, text: 'B' }]);
  const store = cueStyleWriter(project);
  const [a, b] = project.tracks[0].segments;
  const updated = { id: 'preset', fontSize: 72 };
  a.cue_style_id = store({ style: { ...updated, fontSize: 55 }, library_id: 'preset' });
  b.cue_style_id = store({ style: updated, library_id: 'preset' });
  for (const { entry, style } of cueStyleUpdates(project, { styles: [updated] })) entry.style = style;
  const saved = model.snapshotProjectContent(project);
  assert.equal(saved.cue_styles.length, 1);
  assert.deepEqual(saved.tracks[0].segments.map(cue => cue.cue_style_id), [a.cue_style_id, a.cue_style_id]);
  assert.notEqual(a.cue_style_id, b.cue_style_id);
  assert.equal(model.requiresProjectMigrationSaveAs(saved), false);
  const old = model.makeProject([{ start: 0, end: 10, text: 'old' }]);
  old.tracks[0].segments[0].assStyle = updated;
  assert.equal(model.requiresProjectMigrationSaveAs(old), true);
});
