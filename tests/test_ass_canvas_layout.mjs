// ass-canvas-layout 纯布局计算的单测：Alignment 网格、锚点、行切分与块偏移。
// 绘制层（editor-wiring-ass-canvas.js）依赖这些纯函数定位所有 ASS 文本，
// 布局错了画布整体就错，因此在 Node 里离线锁定行为。
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const h = context.window.AsrEditorUtils;

// 模块在 vm 上下文里创建对象，原型与测试 realm 不同；浅拷贝到测试 realm
// 后再做严格比较。
const same = (actual, expected) => assert.deepEqual({ ...actual }, expected);

const fakeMeasurer = (run, text) => ({
  width: [...text].length * 10,
  ascent: 8,
  descent: 2,
});

test('stack sweep renders all overlapping cues and fits the complete group at the top edge', () => {
  const style = h.normalizeAssStyle({ fontSize: 72, alignment: 8, marginV: 0 });
  const profile = h.normalizeAssProfile({ animations: {} });
  const item = (role, index, start, end, text) => ({ role, index, start, end, style,
    fontSize: 72, runs: [{ text }] });
  const plan = h.assCreateStackPlan({ profile, items: [item('main', 0, 0, 2000, 'MAIN\nLINE'),
    item('overlay', 0, 0, 2000, 'MMMMMMMM'), item('overlay', 1, 500, 1500, 'WWWWWWWW')] });
  assert.deepEqual(Array.from(plan.slices, slice => [slice.start, slice.end]), [[0, 500], [500, 1500], [1500, 2000]]);
  const frame = h.assStackFrame(plan, 1000);
  assert.equal(frame.items.length, 3);
  for (const entry of frame.items) {
    assert.ok(entry.anchor.y + entry.rect.top * entry.scale >= 0);
    assert.ok(entry.anchor.y + entry.rect.bottom * entry.scale <= 1080);
  }
  for (let i = 1; i < frame.items.length; i += 1) {
    const below = frame.items[i - 1], above = frame.items[i];
    assert.ok(above.anchor.y + above.rect.bottom * above.scale < below.anchor.y + below.rect.top * below.scale);
  }
});

test('fixed extension keeps its preset anchor alone and across main cue boundaries', () => {
  let plan;
  const ass = h.buildAssPayload([{ start: 500, end: 1500, text: 'MAIN' }], {
    assProfile: { animations: {} },
    assStyle: { fontSize: 72, marginV: 160 },
    assExtensionStyle: { fontSize: 36, alignment: 3, marginR: 50, marginV: 60 },
    extensionSegments: [{ start: 0, end: 2000, text: 'EXT' }],
    onAssPlan: value => { plan = value; },
  });
  for (const time of [0, 499, 500, 1499, 1500, 1999]) {
    const extension = h.assStackFrame(plan, time).items.find(item => item.role === 'extension');
    same(extension.anchor, { x: 1870, y: 1020 });
    assert.equal(extension.scale, 1);
  }
  const events = ass.split('\n').filter(line => line.startsWith('Dialogue: 1,'));
  assert.equal(events.length, 3);
  assert.ok(events.every(line => line.includes(String.raw`\pos(1870,1020)`)));
  assert.ok(events.every(line => !line.includes(String.raw`\move(`)));
});

test('three overlapping fixed extension cues accumulate absolute collision bounds', () => {
  const style = h.normalizeAssStyle({ fontSize: 54, alignment: 2, marginV: 60 });
  const items = Array.from({ length: 3 }, (_, index) => ({ role: 'extension', index,
    start: 0, end: 2000, style, fontSize: 54, runs: [{ text: `EXT ${index}` }] }));
  const plan = h.assCreateStackPlan({ items, profile: h.normalizeAssProfile({ animations: {} }) });
  const fixed = h.assStackFrame(plan, 1000).items;
  assert.equal(fixed.length, 3);
  assert.equal(fixed[0].anchor.y, 1020);
  for (let index = 1; index < fixed.length; index += 1) {
    const below = fixed[index - 1], above = fixed[index];
    assert.equal(above.anchor.x, below.anchor.x);
    assert.equal(above.scale, 1);
    assert.equal(above.anchor.y + above.rect.bottom,
      below.anchor.y + below.rect.top - Math.max(2, Math.round(below.fontSize * 0.2)));
    assert.ok(above.anchor.y + above.rect.top > 0);
  }
});

test('fixed extensions report cumulative stack overflow instead of clamping cues onto each other', () => {
  const style = h.normalizeAssStyle({ fontSize: 36, alignment: 2, marginV: 20, outline: 0, shadow: 0 });
  const items = Array.from({ length: 3 }, (_, index) => ({ role: 'extension', index,
    start: 0, end: 2000, style, fontSize: 36, runs: [{ text: 'EXT\nLINE' }] }));
  const plan = height => h.assCreateStackPlan({ items, width: 1280, height,
    profile: h.normalizeAssProfile({ animations: {} }) });
  assert.equal(plan(320).diagnostics.length, 0, 'the same fixed cues fit in a taller frame');
  const crowded = plan(240);
  assert.match(crowded.diagnostics[0]?.message || 'no diagnostic', /固定副字幕.*同时容纳/);
  assert.equal(h.assStackFrame(crowded, 1000).items.length, 0, 'unavailable placement cannot silently paint overlap');
});

test('fixed extension inline sizes and animation targets ignore the main overlay fit scale', () => {
  let plan;
  const output = h.buildAssPayload([{ start: 0, end: 2000, text: Array(10).fill('MAIN').join('\n') }], {
    assStyle: { fontSize: 96 },
    assExtensionStyle: { fontSize: 36, emphasisScale: 1.5, spacing: 3, outline: 2, shadow: 1 },
    extensionSegments: [{ start: 0, end: 2000, text: '**BIG** tail' }],
    overlaySegments: [{ start: 0, end: 2000, text: Array(5).fill('OVERLAY').join('\n') }],
    assProfile: { animations: { t: { enabled: true, startMs: 0, endMs: 1500,
      tags: String.raw`\fs120\fsp6\bord4\shad2` } } },
    onAssPlan: value => { plan = value; },
  });
  assert.ok(plan.slices[0].scale < 1, 'main and overlay must actually shrink in this fixture');
  const extension = output.split('\n').find(line => line.startsWith('Dialogue: 1,'));
  assert.ok(extension.includes(String.raw`\fs36\fsp3\bord2\shad1`));
  assert.ok(extension.includes(String.raw`\t(0,1500,1,\fs120\fsp6\bord4\shad2)`));
  assert.ok(extension.includes(String.raw`\fs54\t(0,1500,1,\fs180)`));
  assert.ok(extension.includes(String.raw`\fs36\t(0,1500,1,\fs120)`));
  assert.equal(h.assStackFrame(plan, 1000).items.find(item => item.role === 'extension').scale, 1);
});

test('fixed extension bounds cover the actual rotation sweep instead of a full circle', () => {
  const style = h.normalizeAssStyle({ fontSize: 36, marginV: 60 });
  const extension = { role: 'extension', index: 0, start: 0, end: 2000,
    style, fontSize: 36, runs: [{ text: 'Wide' }] };
  const measure = () => ({ width: 1000, ascent: 40, descent: 10 });
  const plan = angle => h.assCreateStackPlan({ width: 1280, height: 720, measure, items: [extension],
    profile: h.normalizeAssProfile({ animations: { t: { enabled: true, tags: `\\frz${angle}` } } }) });
  const narrow = plan(10);
  assert.equal(narrow.diagnostics.length, 0, 'a short sweep fits without shrinking the fixed layer');
  const padding = Math.ceil(style.outline + style.shadow + Math.max(2, 36 * 0.08));
  const expectedHeight = (50 + padding * 2) * Math.cos(Math.PI / 18)
    + (1000 + padding * 2) * Math.sin(Math.PI / 18);
  const bounds = narrow.slices[0].items[0].rect;
  assert.ok(Math.abs(bounds.bottom - bounds.top - expectedHeight) < 1e-9);
  assert.match(plan(180).diagnostics[0].message, /固定副字幕超出/, 'interior sweep extrema still prevent clipping');
});

test('stack plan refuses unknown geometry, while single main retains original motion', () => {
  const style = h.normalizeAssStyle({ fontSize: 72 });
  const profile = h.normalizeAssProfile({ animations: { t: { enabled: true, tags: String.raw`\frx89` } } });
  const main = { role: 'main', index: 0, start: 0, end: 1000, style, fontSize: 72, runs: [{ text: 'MAIN' }] };
  assert.equal(h.assCreateStackPlan({ profile, items: [main] }).slices[0].legacy, true);
  const plan = h.assCreateStackPlan({ profile, items: [main, { ...main, role: 'extension' }] });
  assert.equal(plan.diagnostics.length, 1);
  assert.equal(h.assStackFrame(plan, 500).items.length, 0);
  assert.throws(() => h.buildAssPayload([{ start: 0, end: 1000, text: 'MAIN' }],
    { assProfile: profile, assStyle: style, assExtensionStyle: style,
      extensionSegments: [{ start: 0, end: 1000, text: 'EXT' }] }), /不支持/);
});

test('stack planning uses Dialogue centiseconds and retains original cue clocks across boundaries', () => {
  let plan;
  const output = h.buildAssPayload([{ start: 14, end: 1013, text: 'MAIN' }], {
    assProfile: { animations: { t: { enabled: true, startMs: 0, endMs: 1000, tags: String.raw`\fs36.5` } } },
    assStyle: { fontSize: 48 }, assExtensionStyle: { fontSize: 36 },
    extensionSegments: [{ start: 505, end: 1014, text: 'EXT' }], onAssPlan: value => { plan = value; },
  });
  assert.deepEqual(Array.from(plan.slices, slice => [slice.start, slice.end]), [[10, 510], [510, 1010]]);
  assert.ok(output.includes(String.raw`\t(-500,500,1,\fs36.5)`));
  assert.equal(h.assTransformStyleTargets(String.raw`\fs36.5\frz45.5`).fontSize, 36.5);
});

test('stack movement follows libass instant and default whole-cue timing', () => {
  const style = h.normalizeAssStyle({ fontSize: 36, outline: 0 });
  const item = role => ({ role, index: 0, start: 0, end: 2000, style, fontSize: 36, runs: [{ text: 'TEXT' }] });
  const profile = h.normalizeAssProfile({ animations: { move: { enabled: true,
    x1: 400, y1: 700, x2: 1000, y2: 700, t1: 500, t2: 500 } } });
  const plan = h.assCreateStackPlan({ profile, items: [item('main'), item('extension')] });
  for (const time of [0, 250, 499, 500, 501, 505, 510]) {
    assert.equal(h.assStackFrame(plan, time).items[0].anchor.x, time <= 500 ? 400 : 1000);
  }
  profile.animations.move.t1 = 0; profile.animations.move.t2 = 0;
  const linear = h.assCreateStackPlan({ profile, items: [item('main'), item('extension')] });
  for (const time of [0, 250, 500, 1000, 1500]) {
    assert.equal(h.assStackFrame(linear, time).items[0].anchor.x, 400 + 600 * time / 2000);
  }
  const boundary = h.assCreateStackPlan({ profile: h.normalizeAssProfile({ animations: { move: {
    ...profile.animations.move, t1: 500, t2: 500,
  } } }), items: [item('main'), { ...item('extension'), start: 500 }] });
  assert.equal(h.assStackFrame(boundary, 500).items[0].anchor.x, 400);
  assert.equal(h.assStackFrame(boundary, 501).items[0].anchor.x, 1000);
  profile.animations.move.t1 = 500; profile.animations.move.t2 = 500;
  assert.match(h.assAnimationSliceTags(profile, { offsetMs: 500, durationMs: 2000 }), /\\move\(400,700,1000,700,0,1\)/);
  assert.match(h.assAnimationSliceTags(profile, { offsetMs: 1500, durationMs: 2000 }), /\\pos\(1000,700\)/);
  profile.animations.move.t1 = 0;
  assert.match(h.assAnimationSliceTags(profile, { offsetMs: 1500, durationMs: 2000 }), /\\pos\(1000,700\)/);
});

test('stack opacity respects libass fade-in precedence for overlapping short-cue fades', () => {
  const profile = h.normalizeAssProfile({ animations: { fad: { enabled: true, inMs: 800, outMs: 800 } } });
  assert.equal(h.assStackAnimationState(profile, 600, 1000).opacity, 0.75);
  assert.equal(h.assStackAnimationState(profile, 900, 1000).opacity, 0.125);
  assert.equal(h.assPreviewAnimationState(profile, 600, 1000).opacity, 0.5, 'legacy behaviour remains unchanged');
});

test('stack rejects negative spacing and does not silently fit tiny formatted runs', () => {
  const style = h.normalizeAssStyle({ fontSize: 72, smallTextScale: 0.1, spacing: -20 });
  const item = role => ({ role, index: 0, start: 0, end: 1000, style, fontSize: 72,
    runs: [{ text: 'TEXT', size: 'small' }] });
  const profile = h.normalizeAssProfile({ animations: {} });
  assert.equal(h.assCreateStackPlan({ profile, items: [item('main')] }).slices[0].legacy, true);
  assert.match(h.assCreateStackPlan({ profile, items: [item('main'), item('extension')] }).diagnostics[0].message, /负字距/);
  style.spacing = 0;
  const enormous = { ...item('extension'), runs: [{ text: ('BIG\n').repeat(200) }] };
  assert.match(h.assCreateStackPlan({ profile, items: [item('main'), enormous] }).diagnostics[0].message, /固定副字幕超出/);
  assert.match(h.assCreateStackPlan({ profile, items: [item('main'), { ...enormous, role: 'overlay' }] }).diagnostics[0].message, /可读/);
});

test('overlay cues honor per-cue scale and pos overrides like main cues', () => {
  const style = h.normalizeAssStyle({ fontSize: 48, alignment: 2, marginV: 60 });
  const profile = h.normalizeAssProfile({ animations: {} });
  const overlay = (assOverride, text = 'OVER') => ({ role: 'overlay', index: 0, start: 0, end: 2000,
    segment: { id: 'overlay-001', assOverride }, style, fontSize: 48, runs: [{ text }] });
  // 只有缩放：句仍留在自动排布内，测量尺寸按倍率放大，不产生 manual。
  const scaled = h.assCreateStackPlan({ profile, items: [overlay({ scale: 1.5 })] });
  const scaledCue = scaled.slices[0].items[0];
  assert.equal(scaledCue.manual, false);
  assert.equal(scaledCue.cueScale, 1.5);
  assert.equal(scaledCue.sharedStackCue, true);
  // 只有定位：句成为独立绝对事件，不参与整组包围盒与适配。
  const manual = h.assCreateStackPlan({ profile, items: [overlay({ pos: { x: 333, y: 444 } })] });
  const manualCue = manual.slices[0].items[0];
  assert.equal(manualCue.manual, true);
  assert.equal(manualCue.absolute, true);
  assert.deepEqual({ ...manualCue.offset }, { x: 333, y: 444 });
  const frame = h.assStackFrame(manual, 500).items[0];
  assert.deepEqual({ ...frame.anchor }, { x: 333, y: 444 });
  assert.equal(frame.scale, 1);
  // 两个字段相互独立，可同时设置。
  const both = h.assCreateStackPlan({ profile, items: [overlay({ scale: 1.5, pos: { x: 120, y: 80 } })] });
  const bothCue = both.slices[0].items[0];
  assert.equal(bothCue.manual, true);
  assert.equal(bothCue.cueScale, 1.5);
  // 扩展轨闸门保持关闭：带 override 的扩展句不受影响。
  const extension = { role: 'extension', index: 0, start: 0, end: 2000,
    segment: { id: 'ext-001', assOverride: { scale: 1.5, pos: { x: 10, y: 20 } } }, style, fontSize: 48, runs: [{ text: 'EXT' }] };
  const extensionPlan = h.assCreateStackPlan({ profile, items: [extension] });
  const extensionCue = extensionPlan.slices[0].items[0];
  assert.equal(extensionCue.cueScale, 1);
  assert.equal(extensionCue.manual, undefined);
});

test('formatted font transforms retain the source clock and plain fractional fit never resets font animation', () => {
  let plan;
  const output = h.buildAssPayload([{ start: 0, end: 2000, text: 'Plain **E** %%C%% -S-' }], {
    assProfile: { animations: { t: { enabled: true, startMs: 0, endMs: 1500, accel: 2, tags: String.raw`\fs120\frz25` } } },
    assStyle: { fontSize: 64, emphasisScale: 1.5, commentScale: 0.5 },
    assExtensionStyle: { fontSize: 48 },
    extensionSegments: [{ start: 500, end: 2000, text: 'E' }],
    overlaySegments: [{ start: 500, end: 2000, text: 'O' }], onAssPlan: value => { plan = value; },
  });
  const line = output.split('\n').find(event => event.startsWith('Dialogue: 0,0:00:00.50,'));
  assert.ok(line.includes('}Plain '), 'plain text follows the global animation without a local fs reset');
  const target = Number((120 * plan.slices[1].scale).toFixed(4));
  const targets = Array.from(line.matchAll(/\\t\(-500,1000,2,\\fs([\d.]+)\)/g), match => Number(match[1]));
  assert.ok(targets.some(value => Math.abs(value - target * 1.5) < 0.001), 'emphasis uses its proportional target');
  assert.ok(targets.some(value => Math.abs(value - target * 0.5) < 0.001), 'comment uses its proportional target');
  assert.ok(targets.some(value => value === target), 'restore base retains its source clock');
});

test('a formatted main cue keeps font clocks through solo, stacked and solo intervals', () => {
  const output = h.buildAssPayload([{ start: 0, end: 2000, text: '**BIG** tail' }], {
    assProfile: { animations: { t: { enabled: true, startMs: 0, endMs: 1000, accel: 2, tags: String.raw`\fs144` } } },
    assStyle: { fontSize: 72, emphasisScale: 1.5 }, assExtensionStyle: { fontSize: 54 },
    extensionSegments: [{ start: 500, end: 1500, text: 'E' }],
  });
  const main = output.split('\n').filter(line => line.startsWith('Dialogue: 0,'));
  assert.equal(main.length, 3);
  assert.ok(!main[0].includes('\\pos(') && !main[2].includes('\\pos('), 'solo positioning retains its original semantics');
  assert.match(main[0], /\\t\(0,1000,2,\\fs216\)/);
  assert.match(main[1], /\\t\(-500,500,2,\\fs216\)/);
  assert.match(main[2], /\\t\(-1500,-500,2,\\fs216\)/);
});

test('zero transform timing uses the source duration and equal nonzero timing remains an exact step', () => {
  const profile = h.normalizeAssProfile({ animations: { t: { enabled: true, startMs: 0, endMs: 0, accel: 1, tags: String.raw`\fs144` } } });
  assert.equal(h.assStackAnimationState(profile, 500, 2000).transformProgress, 0.25);
  assert.equal(h.assStackAnimationState(profile, 1500, 2000).transformProgress, 0.75);
  assert.match(h.assAnimationSliceTags(profile, { offsetMs: 500, durationMs: 2000 }), /\\t\(-500,1500,1,/);
  const output = h.buildAssPayload([{ start: 0, end: 2000, text: '**BIG** tail' }], {
    assProfile: profile, assStyle: { fontSize: 72, emphasisScale: 1.5 }, assExtensionStyle: { fontSize: 54 },
    extensionSegments: [{ start: 500, end: 1500, text: 'E' }],
  });
  const main = output.split('\n').filter(line => line.startsWith('Dialogue: 0,'));
  assert.match(main[0], /\\t\(0,2000,1,\\fs216\)/);
  assert.match(main[1], /\\t\(-500,1500,1,\\fs216\)/);
  assert.match(main[2], /\\t\(-1500,500,1,\\fs216\)/);
  profile.animations.t.startMs = 500; profile.animations.t.endMs = 500;
  assert.equal(h.assStackAnimationState(profile, 499, 2000).transformProgress, 0);
  assert.equal(h.assStackAnimationState(profile, 500, 2000).transformProgress, 1);
});

test('ever-stacked inline decorations restore immediate transform targets in both directions', () => {
  for (const [tag, key, marker] of [['u', 'underline', '_'], ['s', 'strikeOut', '~'], ['i', 'italic', '//']]) {
    for (const target of [0, 1]) {
      const output = h.buildAssPayload([{ start: 0, end: 2000, text: `MMMM ${marker}MMMM${marker} MMMM` }], {
        assProfile: { animations: { t: { enabled: true, startMs: 100, endMs: 1100, tags: `\\${tag}${target}` } } },
        assStyle: { fontSize: 72, [key]: !target }, assExtensionStyle: { fontSize: 54 },
        extensionSegments: [{ start: 500, end: 1500, text: 'Ext' }],
      });
      const main = output.split('\n').filter(line => line.startsWith('Dialogue: 0,'));
      assert.equal(main.length, 3);
      for (const event of main) {
        if (target) assert.ok(event.endsWith('MMMM MMMM MMMM'), 'all runs inherit the immediate on target');
        else assert.ok(event.endsWith(`MMMM {\\${tag}1}MMMM{\\${tag}0} MMMM`), 'only the marker enables decoration and restores off');
      }
    }
  }
});

test('solo italic runs use the transform baseline without changing the legacy animation clock', () => {
  for (const target of [0, 1]) {
    let plan;
    const output = h.buildAssPayload([{ start: 0, end: 2000, text: 'MAIN //MMMM// TAIL' }], {
      assProfile: { animations: { t: { enabled: true, startMs: 100, endMs: 1100, tags: `\\i${target}` } } },
      assStyle: { fontSize: 72, italic: !target }, onAssPlan: value => { plan = value; },
    });
    assert.equal(plan.slices.length, 1);
    assert.equal(plan.slices[0].legacy, true);
    const events = output.split('\n').filter(line => line.startsWith('Dialogue:'));
    assert.equal(events.length, 1);
    assert.ok(events[0].includes(`\\t(100,1100,1,\\i${target})`));
    assert.ok(events[0].endsWith(target ? 'MAIN MMMM TAIL' : String.raw`MAIN {\i1}MMMM{\i0} TAIL`));
  }
});

test('alignment 网格映射到列/行（屏幕语义：1-3 底行，7-9 顶行）', () => {
  same(h.assCanvasAlignmentGrid(2), { column: 1, row: 2 });
  same(h.assCanvasAlignmentGrid(1), { column: 0, row: 2 });
  same(h.assCanvasAlignmentGrid(3), { column: 2, row: 2 });
  same(h.assCanvasAlignmentGrid(5), { column: 1, row: 1 });
  same(h.assCanvasAlignmentGrid(7), { column: 0, row: 0 });
  same(h.assCanvasAlignmentGrid(9), { column: 2, row: 0 });
  same(h.assCanvasAlignmentGrid(0), { column: 1, row: 2 });
  same(h.assCanvasAlignmentGrid(99), { column: 2, row: 0 });
  same(h.assCanvasAlignmentGrid('abc'), { column: 1, row: 2 });
});

test('锚点按 Alignment 贴边距，\\pos 的 move 坐标直接接管', () => {
  const margins = { left: 10, right: 20, vertical: 88 };
  same(h.assCanvasAnchorPoint({ alignment: 2, margins, playResX: 1920, playResY: 1080 }),
    { x: 960, y: 992 });
  same(h.assCanvasAnchorPoint({ alignment: 1, margins, playResX: 1920, playResY: 1080 }),
    { x: 10, y: 992 });
  same(h.assCanvasAnchorPoint({ alignment: 9, margins, playResX: 1920, playResY: 1080 }),
    { x: 1900, y: 88 });
  same(h.assCanvasAnchorPoint({ alignment: 5, margins, playResX: 1920, playResY: 1080 }),
    { x: 960, y: 540 });
  // \move：锚点就是移动坐标，边距不再参与。
  same(
    h.assCanvasAnchorPoint({ alignment: 2, margins, playResX: 1920, playResY: 1080, move: { x: 500, y: 300 } }),
    { x: 500, y: 300 },
  );
});

test('行切分：跨 run 的 \\N 拆行、行内 x 累计、行高取最大 ascent/descent', () => {
  const layout = h.assCanvasLayoutLines(
    [{ text: 'Hello' }, { text: '\nWorld!' }],
    fakeMeasurer,
  );
  assert.equal(layout.lines.length, 2);
  assert.equal(layout.lines[0].items.length, 1);
  assert.equal(layout.lines[0].items[0].x, 0);
  assert.equal(layout.lines[0].width, 50);
  assert.equal(layout.lines[1].items[0].x, 0);
  assert.equal(layout.lines[1].width, 60);
  assert.equal(layout.blockWidth, 60);
  assert.equal(layout.blockHeight, 20);

  const inline = h.assCanvasLayoutLines(
    [{ text: 'AB' }, { text: 'C' }],
    fakeMeasurer,
  );
  assert.equal(inline.lines.length, 1);
  assert.deepEqual([...inline.lines[0].items.map((item) => item.x)], [0, 20]);
  assert.equal(inline.lines[0].width, 30);

  const midRunBreak = h.assCanvasLayoutLines([{ text: 'A\nB' }], fakeMeasurer);
  assert.equal(midRunBreak.lines.length, 2);
  assert.deepEqual([...midRunBreak.lines.map((line) => line.width)], [10, 10]);
});

test('显式空行按基准 run 行高占位，整条空文本仍为 0 高', () => {
  const interior = h.assCanvasLayoutLines([{ text: 'A\n\nB' }], fakeMeasurer);
  assert.equal(interior.lines.length, 3);
  assert.equal(interior.lines[1].items.length, 0);
  assert.equal(interior.lines[1].ascent, 8);
  assert.equal(interior.lines[1].descent, 2);
  assert.equal(interior.blockHeight, 30);

  const trailing = h.assCanvasLayoutLines([{ text: 'A\n' }], fakeMeasurer);
  assert.equal(trailing.lines.length, 2);
  assert.equal(trailing.blockHeight, 20);

  const empty = h.assCanvasLayoutLines([{ text: '' }], fakeMeasurer);
  assert.equal(empty.lines.length, 1);
  assert.equal(empty.blockWidth, 0);
  assert.equal(empty.blockHeight, 0);
});

test('行偏移与块顶偏移：中列逐行居中、底行块底贴锚点', () => {
  assert.equal(h.assCanvasLineOffsetX(0, 100), 0);
  assert.equal(h.assCanvasLineOffsetX(1, 100), -50);
  assert.equal(h.assCanvasLineOffsetX(2, 100), -100);
  assert.equal(h.assCanvasBlockTopY(2, 30), -30);
  assert.equal(h.assCanvasBlockTopY(1, 30), -15);
  assert.equal(h.assCanvasBlockTopY(0, 30), 0);
});

test('stacked anchors move upward for all vertical rows and preserve horizontal alignment', () => {
  const expectedY = new Map([[2, 920 - 86], [5, 540 - 86 + 36], [8, 160 - 86 + 72]]);
  for (const belowAlignment of [2, 5, 8]) {
    const belowAnchor = h.assCanvasAnchorPoint({
      alignment: belowAlignment, margins: { vertical: 160 }, playResX: 1920, playResY: 1080,
    });
    for (let alignment = 1; alignment <= 9; alignment += 1) {
      const position = h.assCanvasStackedAnchor({
        belowAnchor, belowAlignment, belowFontSize: 72,
        alignment, margins: { left: 40, right: 50 }, playResX: 1920, playResY: 1080,
      });
      assert.equal(position.alignment, (alignment - 1) % 3 + 1);
      assert.equal(position.anchor.x, [40, 960, 1870][(alignment - 1) % 3]);
      assert.equal(position.anchor.y, expectedY.get(belowAlignment));
      assert.ok(position.anchor.y < belowAnchor.y);
      const overlay = h.assCanvasStackedAnchor({
        belowAnchor: position.anchor, belowAlignment: position.alignment, belowFontSize: 54,
        alignment, margins: { left: 40, right: 50 }, playResX: 1920, playResY: 1080,
      });
      assert.equal(overlay.anchor.y, position.anchor.y - 65);
    }
  }
});

test('stacked anchors preserve negative positions above top-aligned cues near the edge', () => {
  const position = h.assCanvasStackedAnchor({
    belowAnchor: { x: 960, y: 0 }, belowAlignment: 8, belowFontSize: 72, alignment: 2,
  });
  assert.equal(position.anchor.y, -14);
});
