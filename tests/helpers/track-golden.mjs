// DOM-free production serializer/export harness. No golden writes during tests.
import fs from 'node:fs';
import vm from 'node:vm';
import { loadEditorModule } from './editor-module-loader.mjs';
export const fixtureRoot = new URL('../fixtures/track-access/', import.meta.url);
export const fixtureNames = fs.readdirSync(fixtureRoot).filter(n => n.endsWith('.input.json')).map(n => n.slice(0, -11)).sort();
export const readFixture = name => JSON.parse(fs.readFileSync(new URL(`${name}.input.json`, fixtureRoot), 'utf8'));
const evaluate = (context, file) => vm.runInNewContext(fs.readFileSync(new URL(`../../web/${file}`, import.meta.url), 'utf8'), context);
export function createProjectHarness(input) {
  const data = structuredClone(input);
  const context = { window: {}, MaweBoot: { DATA: data },
    MaweHint: { flashHint() {} }, MaweSettings: { EDITOR_SETTINGS: { assMode: input.preview?.ass_mode === true } },
    MaweProjectMediaInputs: {}, MaweState: { markProjectDirty() {} },
    MaweAppearance: { getPreviewGeometry: () => ({}), getSubtitleAppearance: () => ({}), getStoredExtensionSubtitleAppearance: () => ({}) },
    MaweSpeakerLabels: { getSpeakerLabelSettings: () => ({}) },
    MaweExportTimeline: { buildCurrentWorkspaceData: () => null },
  };
  loadEditorModule(context, 'shared/editor-utils.js');
  const h = context.window.AsrEditorUtils;
  h.normalizeMultiSubtitleProject(data);
  context.MULTI_SUBTITLE_UTILS = h;
  const exportWiring = fs.readFileSync(new URL('../../web/editor/io/editor-wiring-export-context.js', import.meta.url), 'utf8');
  vm.runInNewContext(exportWiring.slice(0, exportWiring.indexOf('// 保存/导出前')), context);
  evaluate(context, 'editor/state/editor-multi-subtitle-core.js');
  context.MaweMultiSubtitleCore = context.window.MaweMultiSubtitleCore;
  evaluate(context, 'editor/cues/editor-wiring-overlay-transfer.js');
  evaluate(context, 'editor/cues/editor-timeline.js');
  context.MaweTimeline = context.window.MaweTimeline;
  evaluate(context, 'editor/io/editor-json-repair.js');
  return { data, h, context, save: () => JSON.parse(context.window.MaweJsonRepair.buildJson()) };
}
export function browserOutputs(input) {
  const { data, h, save } = createProjectHarness(input);
  const project = save();
  const main = data.segments;
  const secondary = data.multi_subtitle.enabled ? data.multi_subtitle.tracks[0]?.segments || [] : [];
  const overlay = data.overlay_track.enabled ? data.overlay_track.segments : [];
  const combined = h.mergeMainAndOverlaySegments(main, overlay);
  const options = { formatTime: time => {
    const ms = Math.round(time);
    return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;
  } };
  return { project, ass: h.buildAssPayload(main, { title: 'track-golden', fontFamily: 'Arial', extensionSegments: secondary,
    overlaySegments: overlay, ...(input.preview?.ass_mode ? { assProfile: {}, assStyle: { fontName: 'Arial' }, assExtensionStyle: { fontName: 'Arial' } } : {}) }),
    srt: h.buildSrtPayload(combined, options), secondarySrt: h.buildSrtPayload(secondary, options),
    bilingualSrt: h.buildBilingualSrtPayload(combined, secondary, options),
    redSrt: h.buildSrtPayload(combined, { ...options, colorName: 'red', colorContextResolver: segment => main.includes(segment) ? main : overlay }) };
}
