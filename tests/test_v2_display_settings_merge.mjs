import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

test('overlay controls reflect v2 main and overlay tracks, including an empty overlay', () => {
  const main = { role: 'main', segments: [] };
  const overlay = { role: 'overlay', enabled: true, segments: [] };
  const project = { schema: 'moy.asr.project.v2', tracks: [main, overlay], bilingual: { display_mode: 'both' } };
  const panels = { overlayTrackSeparator: {}, overlayTrackToggle: {} };
  const context = {
    document: { getElementById: () => null }, MaweBoot: { DATA: project },
    AsrEditorUtils: { getMainTrack: () => main }, MaweDom: {},
    MaweCoreState: { container: { classList: { toggle() {} }, dataset: {} } },
    MaweMultiSubtitleCore: { getActiveExtensionTrack: () => null },
    MaweSplitMode: { refreshMergeJoinModeHint() {} },
    MaweAssManagerWiring: { syncAssModeDependentControls() {}, syncAssStyleManager() {} },
    getMaweDomPanels: () => panels, getOverlayTrack: () => overlay,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/ui/editor-display-settings.js', 'initMaweDisplaySettings'), context);
  context.MaweDisplaySettings.updateMultiSubtitleUi();
  assert.equal(panels.overlayTrackSeparator.hidden, true);
  assert.equal(panels.overlayTrackToggle.checked, true);
  main.segments.push({ id: 'cue' });
  context.MaweDisplaySettings.updateMultiSubtitleUi();
  assert.equal(panels.overlayTrackSeparator.hidden, false);
  assert.equal(panels.overlayTrackToggle.checked, true);
  overlay.enabled = false;
  context.MaweDisplaySettings.updateMultiSubtitleUi();
  assert.equal(panels.overlayTrackToggle.checked, false);
});
