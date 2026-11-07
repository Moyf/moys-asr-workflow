import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const load = async path => import(`data:text/javascript;base64,${(await readFile(new URL(path, import.meta.url))).toString('base64')}`);
const ass = (await load('../web/shared/utils/ass-style.js')).createUtilsModule({ getNavigator: () => ({}), cloneJsonValue: value => JSON.parse(JSON.stringify(value)) });
const h = { ...ass, ...(await load('../web/shared/utils/track-styles.js')).createUtilsModule(ass) };
const copy = value => JSON.parse(JSON.stringify(value));
const fixture = () => ({ tracks: [{ id: 'main', role: 'main', segments: [] },
  { id: 'secondary', role: 'secondary', segments: [] }] });

test('snapshot matches by name and normalized parameters, not library ID', () => {
  const library = h.defaultAssStyleLibrary();
  const project = fixture(), track = project.tracks[0];
  h.applyTrackStyle(project, track, library.styles[1]);
  assert.equal(h.resolveTrackStyle(project, track, library).status, 'linked');
  const changed = copy(library);
  changed.styles[1].fontSize += 1;
  assert.equal(h.resolveTrackStyle(project, track, changed).status, 'forked');
  const saved = copy(project);
  assert.equal(h.resolveTrackStyle(saved, saved.tracks[0], { styles: [] }).style.fontSize,
    project.styles[0].fontSize);
});

test('library edits propagate only from an equal, linked snapshot; project edits fork', () => {
  const library = h.defaultAssStyleLibrary();
  const project = fixture(), [main, secondary] = project.tracks;
  h.applyTrackStyle(project, main, library.styles[1]);
  h.applyTrackStyle(project, secondary, library.styles[1]);
  assert.equal(h.updateTrackStyle(project, secondary, { fontSize: 77 }), true);
  const changed = copy(library);
  changed.styles[1].fontSize = 55;
  assert.equal(h.updateLinkedTrackStyles(project, library, changed), true);
  assert.equal(h.resolveTrackStyle(project, main, changed).style.fontSize, 55);
  assert.equal(h.resolveTrackStyle(project, secondary, changed).style.fontSize, 77);
  assert.equal(h.resolveTrackStyle(project, secondary, changed).status, 'forked');
  [main.role, secondary.role] = [secondary.role, main.role];
  assert.equal(h.resolveTrackStyle(project, main, changed).style.fontSize, 55);
  assert.equal(h.resolveTrackStyle(project, secondary, changed).style.fontSize, 77);
});

test('save to library requires explicit replacement for a conflicting name', () => {
  const library = h.defaultAssStyleLibrary();
  const project = fixture(), track = project.tracks[0];
  h.applyTrackStyle(project, track, library.styles[1]);
  h.updateTrackStyle(project, track, { fontSize: 77 });
  assert.equal(h.saveTrackStyleToLibrary(project, track, library).reason, 'conflict');
  const result = h.saveTrackStyleToLibrary(project, track, library, { replace: true });
  assert.equal(result.ok, true);
  assert.equal(h.resolveTrackStyle(project, track, result.library).status, 'linked');
  assert.equal(result.style.fontSize, 77);
});

test('editing a shared snapshot separates just the edited track and library deletion preserves it', () => {
  const library = h.defaultAssStyleLibrary();
  const project = fixture(), [main, secondary] = project.tracks;
  h.applyTrackStyle(project, main, library.styles[1]);
  secondary.style = copy(main.style);
  main.style.vendor = { keep: true };
  project.styles[0].vendor = { keep: true };
  h.updateTrackStyle(project, main, { fontSize: 77 });
  assert.equal(h.resolveTrackStyle(project, main, library).style.fontSize, 77);
  assert.deepEqual(main.style.vendor, { keep: true });
  assert.deepEqual(h.resolveTrackStyle(project, main, library).style.vendor, { keep: true });
  assert.equal(h.resolveTrackStyle(project, secondary, library).style.fontSize, library.styles[1].fontSize);
  const changed = copy(library);
  changed.styles = changed.styles.filter(style => style.id !== library.styles[1].id);
  assert.equal(h.updateLinkedTrackStyles(project, library, changed), true);
  assert.equal(h.resolveTrackStyle(project, secondary, changed).status, 'forked');
  assert.equal(h.resolveTrackStyle(project, secondary, changed).style.fontSize, library.styles[1].fontSize);
});
