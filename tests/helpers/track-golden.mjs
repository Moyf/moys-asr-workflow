// DOM-free production serializer/export harness. No golden writes during tests.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSources, readSources, readModules } from '../../scripts/build-editor.mjs';
import { loadEditorModule } from './editor-module-loader.mjs';
export const fixtureRoot = new URL('../fixtures/track-access/', import.meta.url);
export const fixtureNames = fs.readdirSync(fixtureRoot).filter(n => n.endsWith('.input.json')).map(n => n.slice(0, -11)).sort();
export const readFixture = name => JSON.parse(fs.readFileSync(new URL(`${name}.input.json`, fixtureRoot), 'utf8'));
// Compile the complete selected sources at their production manifest slots.
// This executes init functions and follows real static imports; no source slicing.
const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = readSources(root), modules = readModules(root);
const sourceGroups = {
  project: new Set([
    'editor/state/editor-state.js',
    'editor/state/editor-multi-subtitle-core.js',
    'editor/cues/editor-timeline.js',
    'editor/cues/editor-wiring-overlay-transfer.js',
    'editor/io/editor-wiring-export-context.js',
    'editor/io/editor-json-repair.js',
  ]),
  stickers: new Set(['editor/media/editor-sticker-overlay.js']),
};
const compiled = new Map(await Promise.all(Object.entries(sourceGroups).map(async ([name, selected]) => {
  const files = manifest.filter(file => selected.has(file));
  const result = await compileSources(root, files, modules.filter(item => selected.has(item.file)),
    file => fs.readFileSync(path.join(root, 'web', file), 'utf8'));
  return [name, result.code];
})));
const loadSources = (context, name) => vm.runInNewContext(compiled.get(name), context, { filename: `track-${name}-fixture.js` });
export const initializeStickerOverlay = context => loadSources(context, 'stickers');
export function createProjectHarness(input) {
  const context = { document: { getElementById: () => null }, MaweBoot: {},
    MaweHint: { flashHint() {} }, MaweSettings: { EDITOR_SETTINGS: { assMode: input.preview?.ass_mode === true } },
    MaweProjectMediaInputs: {},
    MawePreviewGeometry: { getStickerGeometry: () => input.preview?.sticker || {} },
    MaweAppearance: { getPreviewGeometry: () => ({}), getSubtitleAppearance: () => ({}), getStoredExtensionSubtitleAppearance: () => ({}) },
    MaweSpeakerLabels: { getSpeakerLabelSettings: () => ({}) },
    MaweExportTimeline: { buildCurrentWorkspaceData: () => null },
  };
  context.window = context; // Browser window and globalThis share the same live facades.
  loadEditorModule(context, 'shared/editor-utils.js');
  const h = context.window.AsrEditorUtils;
  context.MaweAppearance.getPreviewGeometry = () => h.normalizePreviewGeometry(input.preview?.subtitle);
  context.MawePreviewGeometry.getStickerGeometry = () => h.normalizePreviewGeometry(input.preview?.sticker, h.DEFAULT_STICKER_GEOMETRY);
  const data = h.importProject(structuredClone(input)).project;
  context.MaweBoot.DATA = data;
  h.normalizeMultiSubtitleProject(data);
  context.MULTI_SUBTITLE_UTILS = h;
  loadSources(context, 'project');
  return { data, h, context, save: () => JSON.parse(context.window.MaweJsonRepair.buildJson()) };
}
export function browserOutputs(input) {
  const { data, h, save } = createProjectHarness(input);
  const project = save();
  const main = h.getMainTrack(data).segments;
  const secondaryTrack = h.getExtensionTrack(data);
  const overlayTrack = h.getOverlayTrack(data);
  const secondary = secondaryTrack?.enabled ? secondaryTrack.segments : [];
  const overlay = overlayTrack?.enabled ? overlayTrack.segments : [];
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
