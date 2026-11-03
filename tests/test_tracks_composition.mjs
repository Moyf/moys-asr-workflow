import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

const utilsContext = { window: {}, TextDecoder };
loadEditorModule(utilsContext, 'shared/editor-utils.js');
const tracks = utilsContext.window.AsrEditorUtils;
const read = file => readFileSync(new URL(`../web/editor/${file}.js`, import.meta.url), 'utf8');

function compositionFixture() {
  const data = tracks.makeProject([{ id: 'cue-1', start: 1000, end: 2000, text: '保存中的字幕' }]);
  const context = {
    Blob, console,
    document: { getElementById: () => null, activeElement: null },
    AsrEditorUtils: { ...tracks, normalizeItemTimingRanges: () => 0 },
    MaweBoot: { DATA: data, SERVER_CONFIG: { saveUrl: '/api/project' }, PROJECT_NAME: 'original', FILENAME_BASE: 'original' },
    MaweInlineEdit: {}, MaweDom: {}, MaweCuePanel: { commitCuePanelEdit() {} },
    MaweCoreState: { player: null }, MaweHint: { flashHint() {} },
    MaweProjectLoad: { projectBindingEpoch: 0 },
    MaweSettings: { EDITOR_SETTINGS: { projectBackupEnabled: true, assMode: true } },
    MaweServerSave: {
      serverProjectSavingEnabled: () => true,
      showProjectSaveError(error) { throw error; },
      configureServerSaveControls() {}, scheduleAutoSave() {},
    },
    MaweHost: { server: {}, files: {} },
    MaweTimeline: { syncProjectTimebaseAndBindingOffsets() {} },
    MaweExportTimeline: { buildCurrentWorkspaceData: () => null },
    MaweAppearance: {
      getPreviewGeometry: () => ({ x: 0.1, y: 0.7, width: 0.8, height: 0.2 }),
      getSubtitleAppearance: () => ({ font_family: 'Noto Sans', font_size: 24 }),
      getStoredExtensionSubtitleAppearance: () => ({}),
    },
    MawePreviewGeometry: { getStickerGeometry: () => ({}) },
    MaweSpeakerLabels: { getSpeakerLabelSettings: () => ({ enabled: false }) },
    getOverlayTrack: () => null,
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['boot/editor-runtime', 'state/editor-state', 'media/editor-audio-processing',
    'io/editor-json-repair', 'io/editor-project-save']) {
    const initializers = { 'state/editor-state': 'initMaweState', 'io/editor-json-repair': 'initMaweJsonRepair', 'io/editor-project-save': 'initMaweProjectSave' };
    vm.runInContext(initializers[file] ? invokedInitModuleSource(`editor/${file}.js`, initializers[file]) : read(file), context, { filename: file });
  }
  context.MaweAudioProcessing.loadProject({ gain_db: 1, target_lufs: -16, peak_ceiling_dbtp: -1 });
  context.MaweState.setSnapshotReader(context.MaweJsonRepair.projectSnapshot);
  context.MaweState.beginProjectSession();
  context.MaweState.establishProjectCheckpoint();
  return context;
}

test('canonical content checkpoints include audio processing and never acknowledge later gain edits', async () => {
  const c = compositionFixture();
  assert.equal(c.MaweState.hasProjectChanges(), false);
  const beforeSnapshot = JSON.stringify(c.MaweBoot.DATA);
  const initial = c.MaweJsonRepair.projectSnapshot();
  assert.equal(initial.audio_processing.gain_db, 1);
  assert.equal(initial.audio_processing.target_lufs, -16);
  assert.equal(initial.preview.subtitle.font_family, 'Noto Sans');
  assert.equal(JSON.stringify(c.MaweBoot.DATA), beforeSnapshot, 'content snapshots must be pure');
  c.MaweAudioProcessing.change({ gain_db: 3 }, { recordHistory: false });
  assert.equal(c.MaweState.hasProjectChanges(), true);

  let acknowledge;
  const response = new Promise(resolve => { acknowledge = resolve; });
  let sent;
  c.MaweHost.server.fetch = (_url, options) => {
    sent = JSON.parse(options.body).project;
    return response;
  };
  const saving = c.MaweProjectSave.saveCurrentProject();
  assert.equal(sent.schema, 'moy.asr.project.v2');
  assert.equal(sent.tracks[0].segments[0].id, 'cue-1');
  assert.equal(sent.audio_processing.gain_db, 3);
  assert.equal(sent.audio_processing.target_lufs, -16);
  assert.equal(Object.hasOwn(sent, 'segments'), false);
  c.MaweAudioProcessing.change({ gain_db: 6 }, { recordHistory: false });
  acknowledge({ ok: true, json: async () => ({ ok: true, filename: 'saved.mosp' }) });
  assert.equal(await saving, true);
  assert.equal(c.MaweAudioProcessing.settings().gain_db, 6);
  assert.equal(c.MaweState.hasProjectChanges(), true, 'ACK covers gain 3, not the gain 6 edit made during saving');

  c.MaweAudioProcessing.change({ gain_db: 3 }, { recordHistory: false });
  assert.equal(c.MaweState.hasProjectChanges(), false, 'returning to the saved gain must match the content checkpoint');
  assert.doesNotThrow(() => { c.MaweState.changes.timedTextEditViewDirty = true; });
});
