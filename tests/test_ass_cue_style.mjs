import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const h = context.window.AsrEditorUtils;

for (const role of ['main', 'extension', 'overlay']) test(`independent ${role} style reaches ASS and the layout plan`, () => {
  const cue = { id: 'styled', start: 0, end: 1000, text: 'Styled',
    assStyle: { fontName: 'Arial', fontSize: 112, primaryColor: '#123456', alignment: 8, marginV: 20 },
    assOverride: { pos: { x: 800, y: 500 }, scale: 1.2 } };
  const peer = { id: 'peer', start: 1000, end: 2000, text: 'Peer' };
  const before = JSON.stringify(cue);
  let plan;
  const options = { assProfile: h.normalizeAssProfile({}), assStyle: { fontSize: 60 },
    assExtensionStyle: { fontSize: 50 }, onAssPlan: value => { plan = value; } };
  if (role === 'extension') options.extensionSegments = [cue, peer];
  if (role === 'overlay') options.overlaySegments = [cue, peer];
  const output = h.buildAssPayload(role === 'main' ? [cue, peer] : [], options);
  assert.match(output, /Style: Cue_0,Arial,112,/);
  const item = plan.slices.flatMap(slice => slice.items).find(entry => entry.segment.id === 'styled');
  assert.equal(item.style.fontSize, 112);
  assert.equal(item.style.primaryColor, '#123456');
  assert.equal(item.style.alignment, 8);
  assert.equal(JSON.stringify(cue), before);
  if (role !== 'extension') assert.ok(output.includes('\\pos(800,500)'));
});

test('batch processing preserves rows, timing and independent ASS style even for empty results', () => {
  const source = [{ id: 'one', start: 10, end: 1000, text: '嗯', items: [{ text: '嗯', start: 10, end: 1000 }], assStyle: { fontSize: 100 } }];
  const result = h.applyTimedTextEdit(source, [''], { preserveRows: true });
  assert.equal(result.length, 1);
  assert.equal(result[0].text, '');
  assert.equal(result[0].start, 10);
  assert.equal(result[0].end, 1000);
  assert.equal(result[0].assStyle.fontSize, 100);
  assert.equal(result[0].items, undefined);
  assert.equal(source[0].text, '嗯');
});

test('empty cues do not become ASS stack roots or steal first-cue alignment', () => {
  const empty = { id: 'empty', start: 1000, end: 2000, text: '', assStyle: { fontSize: 100 } };
  const overlay = { id: 'overlay', start: 1000, end: 2000, text: 'visible' };
  const options = { assProfile: h.normalizeAssProfile({}), assStyle: { fontSize: 60 }, overlaySegments: [overlay] };
  let withEmpty, without;
  h.buildAssPayload([empty], { ...options, onAssPlan: plan => { withEmpty = plan; } });
  h.buildAssPayload([], { ...options, onAssPlan: plan => { without = plan; } });
  assert.deepEqual(JSON.parse(JSON.stringify(withEmpty.slices)), JSON.parse(JSON.stringify(without.slices)));
  const cues = [empty, { id: 'next', start: 2500, end: 3000, text: 'next' }];
  const ass = h.buildAssPayload(cues, { ...options, overlaySegments: [], alignFirstStart: true, firstEnabledIndex: 0 });
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:03\.00,/);
  assert.equal(ass.includes('Style: Cue_0,'), false);
});

test('SRT skips empty enabled cues without removing disabled placeholders', () => {
  const cues = [{ start: 1000, end: 2000, text: '' }, { start: 2000, end: 3000, text: 'text' },
    { start: 3000, end: 4000, text: 'disabled', disabled: true }];
  const srt = h.buildSrtPayload(cues, { alignFirstStart: true, keepDisabledPlaceholder: true });
  assert.equal(h.getSrtExportFirstIndex(cues, true), 1);
  assert.match(srt, /^1\n0 --> 3000\ntext/);
  assert.match(srt, /2\n3000 --> 4000\n/);
});
