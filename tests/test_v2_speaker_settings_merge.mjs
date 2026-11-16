import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

function fixture() {
  const project = { schema: 'moy.asr.project.v2', speakers: [{ id: 's', name: 'A' }],
    preview: { subtitle: { vendor: { keep: true }, speaker_labels: { names: {}, separator: ': ' } } } };
  const calls = [];
  const context = {
    MaweBoot: { DATA: project },
    AsrEditorUtils: { normalizeSpeakerLabelSettings: value => value },
    MaweAppearance: {}, MaweSettings: { EDITOR_SETTINGS: { exportSpeakerLabels: true } },
    getPreviewGeometry: () => ({ anchor: 'bottom' }),
    getSubtitleAppearance: () => ({ fontSize: 32 }),
    applySubtitleAppearance: value => calls.push(value),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/styles/editor-speaker-labels.js', 'initMaweSpeakerLabels'), context);
  return { context, project, calls };
}

test('speaker settings preserve unknown v2 preview fields through static appearance calls', () => {
  const { context, project, calls } = fixture();
  const settings = { names: { red: 'A' }, separator: ': ' };
  context.MaweSpeakerLabels.setSpeakerLabelSettings(settings);
  assert.equal(project.preview.subtitle.vendor.keep, true);
  assert.equal(project.preview.subtitle.anchor, 'bottom');
  assert.equal(project.preview.subtitle.fontSize, 32);
  assert.equal(project.preview.subtitle.speaker_labels, settings);
  assert.equal(context.MaweAppearance.previewGeometryDirty, true);
  assert.equal(calls[0], project.preview.subtitle);
});

test('speaker export uses the canonical project and respects the export toggle', () => {
  const { context, project } = fixture();
  let options = context.MaweSpeakerLabels.speakerLabelExportOptions();
  assert.equal(options.speakerLabelsEnabled, true);
  assert.equal(options.speakerProject, project);
  context.MaweSettings.EDITOR_SETTINGS.exportSpeakerLabels = false;
  options = context.MaweSpeakerLabels.speakerLabelExportOptions();
  assert.equal(options.speakerLabelsEnabled, false);
});
