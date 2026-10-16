import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const h = context.window.AsrEditorUtils;
const plain = value => JSON.parse(JSON.stringify(value));
const main = [{ start: 0, end: 2000, text: 'Plain **bold** _under_ //comment//', color: { name: 'red' }, speaker: 'Alice' },
  { start: 2500, end: 4000, text: 'Second\nline' }];

test('unpositioned legacy and multi-track exports match original a34d502 bytes', () => {
  // Pin the historical input colors: this protects positioning/export bytes
  // independently of intentional changes to defaults for new projects.
  const colorStyles = [{ name: 'yellow', value: '#c4a019' }];
  const fixtures = [{ colorStyles }, { colorStyles, assStyle: { fontSize: 64, alignment: 8 }, assProfile: { animations: {
    move: { enabled: true, x1: 400, y1: 150, x2: 800, y2: 200, t1: 0, t2: 1000 },
    t: { enabled: true, tags: String.raw`\fs96\bord3` } } }, assExtensionStyle: { fontSize: 36, primaryColor: '#eac953' },
    extensionSegments: [{ start: 500, end: 1500, text: 'Translation' }], overlaySegments: [{ start: 1000, end: 3000, text: 'Overlay' }] }];
  const expected = ['a84bafdfbb8599b8b060c63b20b703bb70b9850d7af1a1749f12976f02d91341',
    '1488098ff538ae0dcfd7c16335f140b3fe2ee089343ace2a4b901fc151f625bf'];
  fixtures.forEach((options, index) => assert.equal(createHash('sha256').update(h.buildAssPayload(main, options)).digest('hex'), expected[index]));
});

test('strict override normalization rejects coercion and returns independent canonical copies', () => {
  for (const bad of [null, [], 1, { an: 2 }, { an: 0 }, { an: 10 }, { an: 1.5 }, { an: '2' }, { an: true },
    { scale: null }, { scale: true }, { scale: '1.2' }, { scale: NaN }, { scale: Infinity }, { scale: 0.09 }, { scale: 5.01 },
    { pos: {} }, { pos: { x: '1', y: 2 } }, { pos: { x: Infinity, y: 2 } }, { pos: { x: 1, y: NaN } }]) {
    assert.throws(() => h.normalizeAssOverride(bad), /assOverride/);
  }
  assert.equal(h.normalizeAssOverride({}), undefined);
  assert.equal(h.normalizeAssOverride(undefined), undefined);
  assert.equal(h.normalizeAssOverride({ scale: 1 }), undefined);
  assert.deepEqual(plain(h.normalizeAssOverride({ scale: 1.225 })), { scale: 1.23 });
  assert.deepEqual(plain(h.normalizeAssOverride({ scale: 1.125 })), { scale: 1.13 });
  assert.deepEqual(plain(h.normalizeAssOverride({ scale: 2.675 })), { scale: 2.67 });
  assert.equal(h.normalizeAssOverride({ scale: 1.005 }), undefined);
  assert.deepEqual(plain(h.normalizeAssOverride({ scale: 1.22, pos: { x: 331.5, y: -161.5 } })),
    { scale: 1.22, pos: { x: 331.5, y: -161.5 } }, 'normalization preserves imported fractional coordinates');
  const original = { pos: { x: -42.125, y: 1200 } };
  const copy = h.normalizeAssOverride(original);
  assert.deepEqual(plain(copy), original);
  copy.pos.x = 1;
  assert.equal(original.pos.x, -42.125);
  const project = { segments: [{ start: 0, end: 1000, text: 'old' }, { start: 1000, end: 2000, text: 'empty', assOverride: {} }] };
  h.normalizeMultiSubtitleProject(project);
  assert.ok(project.segments.every(segment => !Object.hasOwn(segment, 'assOverride')));
});

test('scale-only overrides keep the global anchor and remain in automatic layout', () => {
  const measure = (style, fontSize, run, text) => ({ width: [...text].length * fontSize / 2,
    ascent: fontSize * 0.8, descent: fontSize * 0.2 });
  const profile = { animations: {} };
  const makePlan = scale => {
    let plan;
    h.buildAssPayload([{ id: 'scaled', start: 0, end: 2000, text: 'MAIN', assOverride: { scale } }], {
      assProfile: profile, assStyle: { fontSize: 72 }, overlaySegments: [{ id: 'overlay', start: 0, end: 2000, text: 'OVERLAY' }],
      measureAssRun: measure, onAssPlan: value => { plan = value; },
    });
    return plan;
  };
  const base = makePlan(1);
  const scaled = makePlan(1.22);
  const cue = scaled.slices[0].items.find(item => item.segment.id === 'scaled');
  const frame = h.assStackFrame(scaled, 1000).items.find(item => item.segment.id === 'scaled');
  const baseFrame = h.assStackFrame(base, 1000).items.find(item => item.segment.id === 'scaled');
  const baseRect = base.slices[0].items.find(item => item.segment.id === 'scaled').rect;
  assert.equal(cue.manual, false);
  assert.equal(cue.cueScale, 1.22);
  assert.ok(cue.rect.right - cue.rect.left > baseRect.right - baseRect.left);
  assert.equal(frame.scale, scaled.slices[0].scale);
  assert.deepEqual(plain(frame.anchor), plain(baseFrame.anchor));

  const output = h.buildAssPayload([{ id: 'scaled', start: 0, end: 2000, text: 'MAIN', assOverride: { scale: 1.22 } }], {
    assProfile: {}, assStyle: { fontSize: 72 },
  });
  assert.match(output, /\\fs87\.84/);
  assert.doesNotMatch(output, /\\pos\(/, 'scale alone does not create a per-cue position');
});

test('scaled automatic stack export keeps measured offsets at group scale', () => {
  const measure = (style, fontSize, run, text) => ({ width: [...text].length * fontSize / 2,
    ascent: fontSize * 0.8, descent: fontSize * 0.2 });
  const segments = [
    { id: 'base', start: 0, end: 2000, text: Array(10).fill('BASE').join('\n') },
    { id: 'scaled', start: 0, end: 2000, text: Array(10).fill('SCALED').join('\n'), assOverride: { scale: 0.62 } },
  ];
  let plan;
  const output = h.buildAssPayload(segments, { assProfile: {}, assStyle: { fontSize: 150, alignment: 2, marginV: 40 },
    playResX: 640, playResY: 360,
    measureAssRun: measure, onAssPlan: value => { plan = value; } });
  const slice = plan.slices[0];
  const item = slice.items.find(entry => entry.segment.id === 'scaled');
  const frameItem = h.assStackFrame(plan, 500).items.find(entry => entry.segment.id === 'scaled');
  const line = output.split('\n').find(entry => entry.startsWith('Dialogue: 0,') && entry.includes('SCALED'));
  const position = line.match(/\\pos\(([-\d.]+),([-\d.]+)\)/);
  assert.equal(slice.legacy, false);
  assert.ok(slice.scale < 1, 'fixture exercises both group fitting and per-cue scale');
  assert.ok(Math.abs(item.offset.y) > 1, 'automatic stack gives the cue a measured nonzero offset');
  assert.ok(position, 'automatic stacked cue uses an explicit exported position');
  for (const [index, axis] of ['x', 'y'].entries()) {
    assert.ok(Math.abs(Number(position[index + 1]) - frameItem.anchor[axis]) < 0.0001,
      `${axis} offset agrees with the shared preview layout`);
  }
  assert.match(line, /\\fs[\d.]+/, 'the cue scale still applies to emitted text');
});

test('global alignments and explicit anchors override profile move without losing fade or transform', () => {
  for (let an = 1; an <= 9; an++) {
    let plan;
    const output = h.buildAssPayload([{ id: 'main', start: 0, end: 2000, text: '**Cue**', assOverride: { pos: { x: 300.25, y: 200.5 } } }], {
      assStyle: { fontSize: 64, alignment: an }, assProfile: { animations: {
        move: { enabled: true, x1: 10, y1: 20, x2: 500, y2: 700 },
        fad: { enabled: true, inMs: 250, outMs: 250 }, t: { enabled: true, startMs: 0, endMs: 1000, tags: String.raw`\fs96\bord3` },
      } }, onAssPlan: value => { plan = value; },
    });
    const line = output.split('\n').find(line => line.startsWith('Dialogue:'));
    assert.ok(line.includes(`\\an${an}`));
    assert.equal((line.match(/\\(?:pos|move)\(/g) || []).length, 1);
    assert.ok(line.includes(String.raw`\pos(300.25,200.5)`));
    assert.ok(line.includes(String.raw`\fad(250,250)`));
    assert.ok(line.includes(String.raw`\t(0,1000,1,\fs96\bord3)`));
    for (const time of [0, 500, 1500, 1999]) {
      const cue = h.assStackFrame(plan, time).items[0];
      assert.equal(cue.alignment, an);
      assert.deepEqual(plain(cue.anchor), { x: 300.25, y: 200.5 });
      assert.equal(cue.scale, 1);
    }
  }
});

test('manual cues do not move, shrink or obstruct automatic main/overlay and fixed extension', () => {
  const options = { assProfile: {}, assStyle: { fontSize: 96 }, assExtensionStyle: { fontSize: 36 },
    extensionSegments: [{ start: 0, end: 2000, text: 'Ext' }],
    overlaySegments: [{ start: 0, end: 2000, text: Array(8).fill('Overlay').join('\n') }] };
  const auto = { id: 'auto', start: 0, end: 2000, text: Array(8).fill('Main').join('\n') };
  const manual = { id: 'manual', start: 0, end: 2000, text: Array(30).fill('Manual').join('\n'), assOverride: { pos: { x: -100.5, y: 1200.5 } } };
  let before, after;
  h.buildAssPayload([auto], { ...options, onAssPlan: value => { before = value; } });
  const output = h.buildAssPayload([auto, manual], { ...options, onAssPlan: value => { after = value; } });
  const oldFrame = h.assStackFrame(before, 500).items;
  const frame = h.assStackFrame(after, 500).items;
  for (const cue of oldFrame) {
    const actual = frame.find(item => item.role === cue.role && item.index === cue.index);
    assert.deepEqual(plain(actual.anchor), plain(cue.anchor));
    assert.equal(actual.scale, cue.scale);
  }
  const positioned = frame.find(item => item.segment.id === 'manual');
  assert.equal(positioned.scale, 1);
  assert.deepEqual(plain(positioned.anchor), manual.assOverride.pos);
  assert.ok(output.includes(String.raw`\pos(-100.5,1200.5)`));
  assert.ok(frame.find(item => item.role === 'extension').scale === 1);
});

test('secondary tracks ignore positioning metadata, but track swaps retain it for return to main', () => {
  const override = { pos: { x: 123, y: 456 } };
  const project = { segments: [{ id: 'a', start: 0, end: 1000, text: 'Main', assOverride: override }],
    multi_subtitle: { enabled: true, tracks: [{ id: 'e', segments: [{ id: 'e1', start: 0, end: 1000, text: 'Ext' }] }] } };
  h.normalizeMultiSubtitleProject(project);
  h.swapMainAndExtensionSubtitle(project, 'e');
  assert.deepEqual(plain(project.multi_subtitle.tracks[0].segments[0].assOverride), override);
  h.swapMainAndExtensionSubtitle(project, 'e');
  assert.deepEqual(plain(project.segments[0].assOverride), override);
  let plan;
  h.buildAssPayload([], { assProfile: {}, assExtensionStyle: {}, extensionSegments: [{ start: 0, end: 1000, text: 'Ext', assOverride: override }], onAssPlan: value => { plan = value; } });
  assert.ok(plan.slices[0].items.every(item => !item.manual));
});

test('copy split makes independent overrides and merge preserves the leftmost value', () => {
  const splitContext = { window: { AsrEditorUtils: h }, MULTI_SUBTITLE_UTILS: h, MaweMultiSubtitleCore: { SUBTITLE_MIN_DURATION_MS: 100 } };
  vm.runInNewContext(fs.readFileSync(new URL('../web/editor/cues/editor-split-core.js', import.meta.url), 'utf8'), splitContext);
  const original = { id: 'a', start: 0, end: 2000, text: 'AB', assOverride: { pos: { x: 100, y: 200 } } };
  const parts = splitContext.window.MaweSplitCore.buildSplitPair(original, 1, 1000, 'a', false, 'continuous', { headIndex: 0, duplicateText: true });
  parts.left.assOverride.pos.x = 111;
  assert.equal(parts.right.assOverride.pos.x, 100);
  assert.equal(original.assOverride.pos.x, 100);
  const segs = [parts.left, parts.right];
  const mergeContext = { window: { AsrEditorUtils: h }, MaweBoot: { DATA: { segments: segs } },
    MaweMultiSubtitleCore: { getMultiSubtitleState: () => ({ tracks: [] }), multiSubtitleVisible: () => false,
      getMainSubtitleSplitMode: () => 'continuous', mergeJoinSeparatorForMode: () => '', removeBindingsForSegmentIds() {} },
    MaweTextCleanup: { syncTimelineGroupRanges() {} },
    MaweSettings: { EDITOR_SETTINGS: { assSpecialSymbolRule: 'both' } } };
  vm.runInNewContext(fs.readFileSync(new URL('../web/editor/cues/editor-segment-ops.js', import.meta.url), 'utf8'), mergeContext);
  const merged = mergeContext.window.MaweSegmentOps.mergeContiguousIndices([0, 1]);
  assert.deepEqual(plain(merged.assOverride), plain(parts.left.assOverride));
  merged.assOverride.pos.x = 333;
  assert.equal(parts.left.assOverride.pos.x, 111);
});


test('manual-only main does not make fixed extension the overlay placement root', () => {
  let plan;
  const options = { assProfile: {}, assStyle: { fontSize: 72, marginV: 160 }, assExtensionStyle: { fontSize: 36, marginV: 60 },
    extensionSegments: [{ start: 0, end: 2000, text: 'Ext' }], overlaySegments: [{ start: 0, end: 2000, text: 'Overlay' }],
    onAssPlan: value => { plan = value; } };
  h.buildAssPayload([{ start: 0, end: 2000, text: 'Main', assOverride: { pos: { x: 300, y: 100 } } }], options);
  const frame = h.assStackFrame(plan, 500).items;
  assert.equal(plan.slices[0].root.role, 'overlay');
  assert.equal(frame.find(item => item.role === 'extension').anchor.y, 1020);
  assert.equal(frame.find(item => item.role === 'overlay').anchor.y, 1080 - 160 - Math.round(1.2 * 72));
});
