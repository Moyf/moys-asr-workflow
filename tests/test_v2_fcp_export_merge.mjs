import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

function fixture(format) {
  const project = { schema: 'moy.asr.project.v2', tracks: [
    { id: 'main', role: 'main', enabled: true, segments: [] },
    { id: 'overlay', role: 'overlay', enabled: true, segments: [] },
  ] };
  const calls = { plans: [], png: [], native: [], gates: [] };
  const node = () => ({ value: '', hidden: false, disabled: false, dataset: {}, textContent: '',
    addEventListener() {}, removeEventListener() {}, append() {},
    classList: { add() {}, remove() {} }, querySelectorAll: () => [] });
  const elements = new Map();
  const getElementById = id => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  getElementById('fcp7-export-format').value = format;
  const context = {
    AbortController, document: { getElementById,
      querySelector: selector => ({ value: selector.includes('scope') ? 'media' : 'source' }),
      createElement: node, createTextNode: value => ({ textContent: value }) },
    MaweBoot: { DATA: project, FILENAME_BASE: 'demo', SERVER_CONFIG: {} },
    AsrEditorUtils: {
      getOverlayTrack: data => data.tracks.find(track => track.role === 'overlay'),
      TrackPolicy: { assertExportable: (...args) => calls.gates.push(args) },
      normalizeExportOptions: options => options,
      buildProjectExportPlan(data, options) { calls.plans.push({ data, options }); return { id: 'v2-plan' }; },
      buildFcp7ExportArtifacts: () => [{ content: '<xml/>', filename: 'demo.xml', mime: 'application/xml' }],
    },
    MaweDom: { fcp7ExportConfirm: node(), fcp7ExportCancel: node(), fcp7ExportModal: node(),
      fcp7ExportFps: { value: '30' }, fcp7ExportSubtitleTracks: { value: 'all' },
      fcp7ExportNativeText: { checked: true } },
    MaweCoreState: { player: { duration: 2 } },
    MaweSpeakerLabels: { speakerLabelExportOptions: () => ({}) },
    MaweSettings: { EDITOR_SETTINGS: {} },
    MaweProjectSave: { translatedEditorText: value => value },
    MaweGapRemovedMediaExport: { dynamicExportCanvasSize: () => ({ width: 1920, height: 1080 }) },
    MaweGapRemoveData: { getRemovedGapRanges: () => [] },
    MaweExportSrt: { buildAss: () => '[ass]' },
    MaweExportTimeline: { async downloadFile(...args) { calls.native.push(args); return { status: 'saved' }; } },
    MaweHint: { flashHint() {} },
    async runFcp7PngExport(options) { calls.png.push(options); return { imageCount: 1, packagePath: 'demo' }; },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/io/editor-dynamic-exports.js', 'initMaweDynamicExports'), context);
  return { context, project, calls };
}

test('native FCP export consumes the canonical project and checks overlay export policy', async () => {
  const { context, project, calls } = fixture('native');
  await context.MaweDynamicExports.exportFcp7Xml();
  assert.equal(calls.plans[0].data, project);
  assert.equal(calls.gates[0][0], project);
  assert.equal(calls.gates[0][1], 'overlay');
  assert.equal(calls.native[0][1], 'demo.xml');
  assert.equal(calls.png.length, 0);
});

test('image FCP export forwards the canonical plan and all selected subtitle layers', async () => {
  const { context, project, calls } = fixture('png');
  await context.MaweDynamicExports.exportFcp7Xml();
  assert.equal(calls.plans[0].data, project);
  assert.equal(calls.png.length, 1);
  assert.deepEqual(Array.from(calls.png[0].layers), [0, 1, 2]);
  assert.equal(calls.png[0].plan.id, 'v2-plan');
  assert.equal(calls.png[0].ass, '[ass]');
  assert.equal(calls.native.length, 0);
});
