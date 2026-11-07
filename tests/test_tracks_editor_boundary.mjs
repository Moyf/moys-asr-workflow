import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createUtilsModule as createProjectTracks } from '../web/shared/utils/project-tracks.js';
const tracks = createProjectTracks();
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const canonical = () => JSON.parse(readFileSync(new URL('./fixtures/project-tracks/legacy-three-tracks.expected.json', import.meta.url), 'utf8'));
function run(context, module) {
  const initializers = { 'state/editor-state': 'initMaweState', 'io/editor-project-load': 'initMaweProjectLoad', 'io/editor-json-repair': 'initMaweJsonRepair', 'io/editor-multi-import': 'initMaweMultiImport' };
  const source = initializers[module] ? invokedInitModuleSource(`editor/${module}.js`, initializers[module]) : readFileSync(new URL(`../web/editor/${module}.js`, import.meta.url), 'utf8');
  vm.runInContext(source, context);
}

test('invalid import is rejected before retiring the current media or file binding', () => {
  const current = canonical();
  const context = { AsrEditorUtils: tracks, MaweBoot: { DATA: current }, effects: 0 };
  context.window = context;
  context.MaweState = { beginProjectLoad() { context.effects++; } };
  vm.createContext(context);
  run(context, 'io/editor-project-load');
  for (const invalid of [
    { ...canonical(), schema: 'moy.asr.project.v99' },
    { ...canonical(), tracks: [] },
    { ...canonical(), segments: [] },
  ]) {
    assert.throws(() => context.MaweProjectLoad.applyCanonicalProject(invalid, 'invalid.mosp'));
    assert.equal(context.effects, 0);
    assert.strictEqual(context.MaweBoot.DATA, current);
    assert.deepEqual(plain(context.MaweBoot.DATA), canonical());
  }
});

test('the real editor projection preserves every track and extension field without mutating DATA', () => {
  const data = canonical();
  for (const track of data.tracks) {
    track.metadata = { role: track.role, empty: [], zero: 0, flag: false };
    track._dirty = true; track.segments[0]._dirty = true;
  }
  data._dirty = true; data.waveform = { cache: true };
  const source = plain(data);
  const utils = { window: {}, TextDecoder };
  loadEditorModule(utils, 'shared/editor-utils.js');
  const context = {
    AsrEditorUtils: { ...utils.window.AsrEditorUtils, ...tracks }, MaweBoot: { DATA: data },
    MaweExportTimeline: { buildCurrentWorkspaceData: () => undefined },
    MaweSettings: { EDITOR_SETTINGS: { assMode: false } },
    MawePreviewGeometry: { getStickerGeometry: () => utils.window.AsrEditorUtils.normalizePreviewGeometry(
      undefined, utils.window.AsrEditorUtils.DEFAULT_STICKER_GEOMETRY) },
    MaweAppearance: { getPreviewGeometry: () => utils.window.AsrEditorUtils.normalizePreviewGeometry(),
      getSubtitleAppearance: () => ({}), getStoredExtensionSubtitleAppearance: () => ({}) },
    MaweSpeakerLabels: { getSpeakerLabelSettings: () => ({}) },
  };
  context.window = context;
  vm.createContext(context);
  run(context, 'boot/editor-runtime');
  run(context, 'state/editor-state');
  run(context, 'io/editor-json-repair');
  const snapshot = plain(context.MaweJsonRepair.projectSnapshot());
  assert.deepEqual(plain(data), source);
  assert.equal(snapshot._dirty, undefined);
  assert.equal(snapshot.waveform, undefined);
  assert.equal(snapshot.schema, tracks.PROJECT_TRACKS_SCHEMA);
  assert.equal(snapshot.segments, undefined);
  assert.equal(snapshot.overlay_track, undefined);
  assert.equal(snapshot.multi_subtitle, undefined);
  for (const [index, track] of snapshot.tracks.entries()) {
    assert.deepEqual(track.metadata, data.tracks[index].metadata);
    assert.equal(track._dirty, undefined);
    assert.equal(track.segments[0]._dirty, undefined);
  }
  assert.deepEqual(snapshot.tracks[1].custom_overlay, []);
  assert.equal(snapshot.tracks[2].custom_track, false);
  assert.deepEqual(snapshot.bindings, data.bindings);
  assert.deepEqual(snapshot.subtitle_groups, data.subtitle_groups);
  assert.deepEqual(tracks.validateTracksProject(snapshot).errors, []);
});

test('importing project subtitles keeps cue metadata and a detached source group table', async () => {
  const source = canonical();
  source.tracks[0].metadata = { vendor: 'track', empty: [] };
  source.tracks[0].segments[0].speaker = 'speaker';
  source.speakers.push({ id: 'speaker', name: 'Imported speaker', color: '#f9ca1f' });
  source.tracks[0].segments[0].assOverride = { scale: 1.2, pos: { x: 0, y: 1 } };
  source.tracks[0].segments[0].vendor = { zero: 0, flag: false };
  const utils = { window: {}, TextDecoder };
  loadEditorModule(utils, 'shared/editor-utils.js');
  const context = {
    AsrEditorUtils: { ...utils.window.AsrEditorUtils, ...tracks, cloneJsonValue: plain },
    MaweProjectValidation: utils.window.MaweProjectValidation,
    document: { getElementById: () => null },
    MaweDragDrop: { isSrtFile: () => false, isLrcFile: () => false },
    MaweJsonRepair: { noteImportReport() {} },
  };
  context.window = context;
  vm.createContext(context);
  run(context, 'io/editor-loading-progress');
  const input = plain(source);
  const parsed = await context.MaweLoadingProgress.parseSubtitleImportFile(new File([JSON.stringify(source)], 'source.mosp'));
  assert.deepEqual(plain(source), input);
  assert.deepEqual(plain(parsed[0]), source.tracks[0].segments[0]);
  assert.deepEqual(plain(parsed.sourceTrack.metadata), source.tracks[0].metadata);
  assert.equal(parsed.sourceTrack.language, 'zh');
  assert.equal(parsed.sourceTrack.segments, undefined);
  assert.deepEqual(plain(parsed.subtitle_groups), source.subtitle_groups);
  parsed[0].vendor.zero = 1;
  parsed.subtitle_groups.color[0].value.custom = 'changed';
  assert.deepEqual(source, input);
  await assert.rejects(context.MaweLoadingProgress.parseSubtitleImportFile(new File([
    JSON.stringify({ ...source, schema: 'moy.asr.project.v99' }),
  ], 'future.mosp')), /schema/);
  assert.equal(context.MaweLoadingProgress.editorLoadingDepth, 0);
});

test('project and subtitle file imports repair numeric timing without accepting invalid structure', async () => {
  const utils = { window: {}, TextDecoder };
  loadEditorModule(utils, 'shared/editor-utils.js');
  const previous = canonical();
  const context = {
    AsrEditorUtils: { ...utils.window.AsrEditorUtils, ...tracks, cloneJsonValue: plain },
    MaweProjectValidation: utils.window.MaweProjectValidation,
    document: { getElementById: () => null },
    MaweDragDrop: { isSrtFile: () => false, isLrcFile: () => false },
    MaweBoot: { DATA: previous, SERVER_CONFIG: {} },
    MaweState: { projectLoadGeneration: 0, beginProjectLoad() { return ++this.projectLoadGeneration; },
      waitForProjectLoad: promise => promise, finishProjectLoad() {} },
    MaweJsonRepair: { noteImportReport(changes) { context.report = changes; } },
    MaweProjectLoad: { applyCanonicalProject(data, _name, options) { context.loaded = { data, options }; context.MaweBoot.DATA = data; } },
    MaweServerSave: { configureServerSaveControls() {} },
    MaweExportTimeline: { updateStickerExportButtons() {} },
    MaweProjectMediaInputs: {}, MaweHint: { flashHint() {} }, console,
  };
  context.window = context;
  vm.createContext(context);
  run(context, 'io/editor-loading-progress');
  run(context, 'io/editor-multi-import');
  const raw = { segments: [{ start: 0, end: 0, text: 'repair me' }] };
  const file = input => new File([JSON.stringify(input)], 'legacy.mosp');
  const segments = await context.MaweLoadingProgress.parseSubtitleImportFile(file(raw));
  assert.equal(segments[0].end, 100);
  assert.equal(raw.segments[0].end, 0);
  assert.equal(await context.MaweMultiImport.openProjectFile(file(raw), { suppressMediaPrompt: true }), true);
  assert.equal(context.loaded.data.tracks[0].segments[0].end, 100);
  assert.equal(context.loaded.options.requiresMigrationSaveAs, true);
  assert.equal(context.loaded.options.repaired, true);
  const loaded = context.MaweBoot.DATA;
  const invalid = { segments: [{ start: 0, end: 0, text: 42 }] };
  await assert.rejects(context.MaweLoadingProgress.parseSubtitleImportFile(file(invalid)), /text/);
  assert.equal(await context.MaweMultiImport.openProjectFile(file(invalid), { suppressMediaPrompt: true }), false);
  assert.strictEqual(context.MaweBoot.DATA, loaded);
});
