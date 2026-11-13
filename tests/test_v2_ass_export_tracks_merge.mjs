import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { TrackPolicy } from '../web/shared/utils/track-policy.js';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

function fixture() {
  const main = { id: 'main', role: 'main', enabled: true, segments: [{ id: 'm', start: 0, end: 1000, text: 'main' }] };
  const secondary = { id: 'en', role: 'secondary', enabled: true, segments: [{ id: 'e', start: 0, end: 1000, text: 'english' }] };
  const overlay = { id: 'overlay', role: 'overlay', enabled: true, segments: [{ id: 'o', start: 0, end: 1000, text: 'overlay' }] };
  const project = { schema: 'moy.asr.project.v2', tracks: [main, secondary, overlay], bilingual: { active_track_id: 'en' } };
  const calls = [];
  const context = {
    MaweBoot: { DATA: project, PROJECT_NAME: 'demo' },
    AsrGapRemoveCore: {},
    AsrEditorUtils: {
      TrackPolicy,
      createCleanupProjectionCache: () => ({ retainedCue: segment => segment, exportSegments: segments => segments }),
      getMainTrack: data => data.tracks.find(track => track.role === 'main'),
      getExtensionTrack: data => data.tracks.find(track => track.role === 'secondary'),
      getOverlayTrack: data => data.tracks.find(track => track.role === 'overlay'),
      getSrtExportFirstIndex: () => 0,
      normalizeMediaMetadata: () => null,
      normalizeAssStyleLibrary: value => value,
      assProfileForId: () => ({ styleId: 'style' }),
      assStyleForId: (_library, id) => ({ id }),
      buildAssPayload(segments, options) { calls.push({ segments, options }); return 'ass'; },
    },
    MaweSettings: { EDITOR_SETTINGS: { exportStartAtZero: false } },
    MaweDom: { overlayToggle: { checked: true }, extensionOverlayToggle: { checked: true } },
    MaweCoreState: { player: {} },
    MaweSpeakerLabels: { speakerLabelExportOptions: () => ({}), getSpeakerLabelSettings: () => ({ enabled: true }) },
    MaweAppearance: { getSubtitleAppearance: () => ({}) }, MaweColors: { COLOR_PALETTE: [] },
    MaweTimeline: { normalizeMediaMetadata: () => null },
    getAssStyleLibrary: () => ({ assignments: {} }),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/io/editor-export-srt.js', 'initMaweExportSrt'), context);
  return { context, main, secondary, overlay, calls };
}

test('ASS export includes canonical tracks and forwards FCP image event names', () => {
  const { context, main, secondary, overlay, calls } = fixture();
  assert.equal(context.MaweExportSrt.buildAss({ pngEventNames: true }), 'ass');
  assert.equal(calls[0].segments, main.segments);
  assert.equal(calls[0].options.extensionSegments, secondary.segments);
  assert.equal(calls[0].options.overlaySegments, overlay.segments);
  assert.equal(calls[0].options.pngEventNames, true);
});

test('preview and export honor separate secondary-track switches', () => {
  const { context, secondary, calls } = fixture();
  secondary.export = { enabled: false };
  context.MaweExportSrt.buildAss();
  assert.equal(calls[0].options.extensionSegments.length, 0);
  context.MaweExportSrt.buildAss({ preview: true });
  assert.equal(calls[1].options.extensionSegments, secondary.segments);
  context.MaweDom.extensionOverlayToggle.checked = false;
  context.MaweExportSrt.buildAss({ preview: true });
  assert.equal(calls[2].options.extensionSegments.length, 0);
});
