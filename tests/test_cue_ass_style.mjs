import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const h = context.window.AsrEditorUtils;

for (const role of ['main', 'extension', 'overlay']) test(`cue style overrides only its ${role} event and retains position/scale`, () => {
  const cue = { id: 'styled', start: 0, end: 1000, text: 'Styled',
    assStyle: { fontName: 'Arial', fontSize: 112, primaryColor: '#123456', alignment: 8, marginV: 20 },
    assOverride: { pos: { x: 800, y: 500 }, scale: 1.2 } };
  const peer = { id: 'peer', start: 1000, end: 2000, text: 'Peer' };
  const before = JSON.stringify(cue);
  let plan;
  const options = { assProfile: h.normalizeAssProfile({}), assStyle: { fontSize: 60 },
    assExtensionStyle: { fontSize: 50 }, assOverlayStyle: { fontSize: 40 },
    onAssPlan: value => { plan = value; } };
  if (role === 'extension') options.extensionSegments = [cue, peer];
  if (role === 'overlay') options.overlaySegments = [cue, peer];
  const output = h.buildAssPayload(role === 'main' ? [cue, peer] : [], options);
  assert.match(output, /Style: Cue_0,Arial,112,/);
  assert.equal((output.match(/^Style: Cue_0,/gm) || []).length, 1);
  assert.match(output, /Dialogue: [^\n]*,Cue_0,,[^\n]*Styled/);
  const item = plan.slices.flatMap(slice => slice.items).find(item => item.segment.id === 'styled');
  assert.equal(item.style.fontSize, 112);
  assert.equal(item.style.primaryColor, '#123456');
  assert.equal(item.style.alignment, 8);
  const other = plan.slices.flatMap(slice => slice.items).find(item => item.segment.id === 'peer');
  assert.notEqual(other.style.fontSize, 112);
  assert.equal(JSON.stringify(cue), before);
  if (role !== 'extension') assert.ok(output.includes('\\pos(800,500)'));
});

test('cue style survives project roundtrip and rejects malformed snapshots', () => {
  const style = { name: 'Local', fontSize: 93, vendor: { retained: true } };
  const project = h.importProject({ segments: [{ start: 0, end: 1000, text: 'a', assStyle: style }] }).project;
  assert.deepEqual(JSON.parse(JSON.stringify(h.importProject(project).project)), JSON.parse(JSON.stringify(project)));
  assert.deepEqual(JSON.parse(JSON.stringify(project.tracks[0].segments[0].assStyle)), style);
  for (const invalid of [null, [], 'preset']) {
    const copy = JSON.parse(JSON.stringify(project)); copy.tracks[0].segments[0].assStyle = invalid;
    assert.throws(() => h.importProject(copy), /assStyle/);
  }
});
