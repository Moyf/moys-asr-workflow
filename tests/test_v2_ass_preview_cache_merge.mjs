import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { TrackPolicy } from '../web/shared/utils/track-policy.js';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

test('ASS preview cache follows v2 track visibility and the current style library', () => {
  const main = { id: 'main', role: 'main', enabled: true, segments: [{ id: 'm', start: 0, end: 1000, text: 'main' }] };
  const secondary = { id: 'en', role: 'secondary', enabled: true, preview_visible: false,
    segments: [{ id: 'e', start: 0, end: 1000, text: 'english' }] };
  const overlay = { id: 'overlay', role: 'overlay', enabled: true, segments: [] };
  const project = { tracks: [main, secondary, overlay], bilingual: { active_track_id: 'en' } };
  const library = { styles: [{ id: 'ass', fontSize: 32 }] };
  let builds = 0, renders = 0;
  const context = {
    document: { addEventListener() {} }, MaweBoot: { DATA: project },
    AsrEditorUtils: { TrackPolicy, getMainTrack: () => main, getOverlayTrack: () => overlay,
      getSubtitleGroupValue: () => null, assStackFrame: () => ({ items: [], diagnostic: '' }) },
    MaweMultiSubtitleCore: { getActiveExtensionTrack: () => secondary },
    MaweExportSrt: { currentAssVideoResolution: () => ({ width: 1920, height: 1080 }),
      cleanupMainSegments: () => main.segments,
      buildAss({ onAssPlan }) { builds++; onAssPlan({ profile: { animations: {} } }); } },
    MaweCoreState: { player: {} },
    MaweSettings: { EDITOR_SETTINGS: {} }, MaweAppearance: { getSubtitleAppearance: () => ({}) },
    MaweColors: { COLOR_PALETTE: [] }, MaweSpeakerLabels: { getSpeakerLabelSettings: () => ({}) },
    MaweDom: { overlayEl: { dataset: {}, style: {}, classList: { add() {} } },
      overlayToggle: { checked: true }, extensionOverlayToggle: { checked: true } },
    MaweAssCanvas: { render() { renders++; } },
    getMaweDomPanels: () => ({}), getAssStyleLibrary: () => library,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/styles/editor-wiring-ass-preview.js', 'initMaweAssPreviewWiring'), context);
  context.MaweAssPreview.applyAssSubtitlePreview({ tMs: 500, overlaySegments: [] });
  assert.equal(builds, 1);
  secondary.segments[0].text = 'hidden changed';
  context.MaweAssPreview.applyAssSubtitlePreview({ tMs: 500, overlaySegments: [] });
  assert.equal(builds, 1);
  secondary.preview_visible = true;
  context.MaweAssPreview.applyAssSubtitlePreview({ tMs: 500, overlaySegments: [] });
  assert.equal(builds, 2);
  library.styles[0].fontSize = 40;
  context.MaweAssPreview.applyAssSubtitlePreview({ tMs: 500, overlaySegments: [] });
  assert.equal(builds, 3);
  assert.equal(renders, 4);
});
