import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';


const source = fs.readFileSync(new URL('../web/editor-utils.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const helpers = context.window.AsrEditorUtils;
const i18nSource = fs.readFileSync(new URL('../web/editor-i18n.js', import.meta.url), 'utf8');
const i18nContext = { window: {} };
vm.runInNewContext(i18nSource, i18nContext);
const i18n = i18nContext.window.MAWE_I18N;


test('translates editor project controls and dynamic save messages to English', () => {
  assert.equal(i18n.translateText('保存工程', 'en'), 'Save project');
  assert.equal(i18n.translateText('自动打开上次工程', 'en'), 'Automatically open last project');
  assert.equal(i18n.translateText('上次打开：demo.json', 'en'), 'Last opened: demo.json');
  assert.equal(i18n.translateText('保存成功！', 'en'), 'Saved!');
  assert.equal(i18n.translateText('字幕忍者', 'en'), 'Subtitle Ninja');
  assert.equal(i18n.translateText('显示刀光特效', 'en'), 'Show slash effect');
  assert.equal(i18n.translateText('字幕大小', 'en'), 'Font size');
  assert.equal(i18n.translateText('字幕预览设置', 'en'), 'Subtitle preview settings');
  assert.equal(i18n.translateText('保存工程', 'zh'), '保存工程');
});


test('builds expandable replacement rows with before and after text', () => {
  const result = helpers.buildReplacementPreview(
    [
      { text: '猫喜欢鱼' },
      { text: '狗喜欢骨头' },
    ],
    [0, 1],
    '喜欢',
    '不讨厌',
    { caseSensitive: true, useRegex: false },
  );
  assert.equal(result.matchCount, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(result.rows)), [
    { index: 0, before: '猫喜欢鱼', after: '猫不讨厌鱼', matchCount: 1 },
    { index: 1, before: '狗喜欢骨头', after: '狗不讨厌骨头', matchCount: 1 },
  ]);
});


test('reports invalid regex without changing any rows', () => {
  const result = helpers.buildReplacementPreview(
    [{ text: 'abc' }],
    [0],
    '(',
    'x',
    { caseSensitive: false, useRegex: true },
  );
  assert.match(result.error, /Invalid|Unterminated|括号/i);
  assert.equal(result.rows.length, 0);
});


test('calculates current cue length and characters per second', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.cueMetrics('Hiya fellas.', 34690, 35550))),
    { totalLength: 6, charsPerSecond: 6.98 },
  );
});

test('uses one shared text-unit rule for lists and current-cue metrics', () => {
  assert.equal(helpers.countTextUnits('猫A\n😀!'), 3);
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.cueMetrics('猫A\n😀!', 0, 1000))),
    { totalLength: 3, charsPerSecond: 3 },
  );
});

test('joins merged subtitle text with the configured separator', () => {
  assert.equal(helpers.joinSegmentTexts([{ text: '第一句' }, { text: '第二句' }], '  '), '第一句  第二句');
  assert.equal(helpers.joinSegmentTexts([{ text: '第一句' }, { text: '第二句' }], ''), '第一句第二句');
});

test('measures Chinese characters and English words for short-subtitle detection', () => {
  assert.equal(helpers.subtitleTextLength('什么？'), 2);
  assert.equal(helpers.subtitleTextLength('一拍即合'), 4);
  assert.equal(helpers.subtitleTextLength('好的。'), 2);
  assert.equal(helpers.subtitleTextLength('hello world'), 2);
  assert.equal(helpers.subtitleTextLength('hello, world!'), 2);
  assert.equal(helpers.subtitleTextLength('one  two   three'), 3);
  assert.equal(helpers.subtitleTextLength('   '), 0);
  assert.equal(helpers.subtitleTextLength('--'), 0);
  assert.equal(helpers.isShortSubtitleText('什么？', 3), true);
  assert.equal(helpers.isShortSubtitleText('一拍即合', 3), false);
  assert.equal(helpers.isShortSubtitleText('yes', 3), true);
  assert.equal(helpers.isShortSubtitleText('one two three', 3), false);
  assert.equal(helpers.isShortSubtitleText('', 3), true);
});

test('plans gap snaps only within the threshold', () => {
  const segments = [
    { start: 0, end: 1000, text: '第一句字幕在这里' },
    { start: 1150, end: 2400, text: '第二句字幕在这里' },
    { start: 3000, end: 4200, text: '第三句字幕在这里' },
  ];
  const plan = JSON.parse(JSON.stringify(helpers.planAutoMerge(segments, { gapMs: 200, shortCount: 1 })));
  assert.deepEqual(plan.snaps, [{ index: 1, edge: 'start', time: 1000 }]);
  assert.deepEqual(plan.groups, []);
  // 阈值为 0 时不拼合任何间隔
  const disabled = JSON.parse(JSON.stringify(helpers.planAutoMerge(segments, { gapMs: 0, shortCount: 1 })));
  assert.deepEqual(disabled.snaps, []);
  // 输入不被改动
  assert.equal(segments[1].start, 1150);
});

test('snaps by extending the earlier subtitle forward when direction is forward', () => {
  const segments = [
    { start: 0, end: 1000, text: '第一句字幕在这里' },
    { start: 1150, end: 2400, text: '第二句字幕在这里' },
  ];
  const plan = JSON.parse(JSON.stringify(helpers.planAutoMerge(segments, {
    gapMs: 200, snapDirection: 'forward', shortCount: 1,
  })));
  assert.deepEqual(plan.snaps, [{ index: 0, edge: 'end', time: 1150 }]);
});

test('plans short-subtitle merges into the previous subtitle', () => {
  const segments = [
    { start: 0, end: 2000, text: '用卫星拍照片能得到' },
    { start: 2100, end: 2600, text: '什么？' },
    { start: 3000, end: 5000, text: '这个东西卖一亿元' },
  ];
  const plan = JSON.parse(JSON.stringify(helpers.planAutoMerge(segments, { gapMs: 200, shortCount: 3 })));
  assert.deepEqual(plan.snaps, [{ index: 1, edge: 'start', time: 2000 }]);
  assert.deepEqual(plan.groups, [[0, 1]]);
  // 关闭吸收后不产生任何合并组
  const noAbsorb = JSON.parse(JSON.stringify(helpers.planAutoMerge(segments, {
    gapMs: 200, shortCount: 3, absorbShort: false,
  })));
  assert.deepEqual(noAbsorb.groups, []);
});

test('absorbs short subtitles into the next subtitle when direction is next', () => {
  const segments = [
    { start: 0, end: 2000, text: '用卫星拍照片能得到' },
    { start: 2100, end: 2600, text: '什么？' },
    { start: 3000, end: 5000, text: '这个东西卖一亿元' },
    { start: 5100, end: 5400, text: '对吧' },
  ];
  const plan = JSON.parse(JSON.stringify(helpers.planAutoMerge(segments, {
    gapMs: 200, shortCount: 3, absorbDirection: 'next',
  })));
  // 「什么？」与下一条间隔超过阈值，因此退回并入上一条；「对吧」并入上一条。
  assert.deepEqual(plan.groups, [[0, 1], [2, 3]]);
});

test('merges a short first subtitle forward and chains consecutive shorts backward', () => {
  const segments = [
    { start: 0, end: 800, text: '嗯' },
    { start: 900, end: 2500, text: '我们今天来看看卫星' },
    { start: 2600, end: 2900, text: '对吧' },
    { start: 3000, end: 3300, text: '没错' },
    { start: 3400, end: 5000, text: '这个东西卖一亿元' },
  ];
  const plan = JSON.parse(JSON.stringify(helpers.planAutoMerge(segments, { gapMs: 200, shortCount: 3 })));
  // 首条「嗯」向前并入 1；「对吧」「没错」各自过短，链式并入上一条所在组
  assert.deepEqual(plan.groups, [[0, 1, 2, 3]]);
});

test('skips auto-merge pairs that are disabled or have different speakers', () => {
  const segments = [
    { start: 0, end: 2000, text: '第一句长字幕内容', speaker: 'S1' },
    { start: 2100, end: 2600, text: '什么？', speaker: 'S2' },
    { start: 3000, end: 5000, text: '第二句长字幕内容' },
    { start: 5100, end: 5600, text: '嗯', disabled: true },
  ];
  const plan = JSON.parse(JSON.stringify(helpers.planAutoMerge(segments, { gapMs: 200, shortCount: 3 })));
  assert.deepEqual(plan.groups, []);
});

test('only absorbs short subtitles when their adjacent gap is within the threshold', () => {
  const segments = [
    { start: 0, end: 2000, text: '前一句较长字幕' },
    { start: 2100, end: 2500, text: '短句' },
    { start: 3000, end: 3400, text: '短句' },
    { start: 3500, end: 5000, text: '后一句较长字幕' },
  ];
  const plan = JSON.parse(JSON.stringify(helpers.planAutoMerge(segments, { gapMs: 200, shortCount: 3 })));
  // 第一条短字幕与前句间隔 100ms，可吸收；第二条与前条间隔 500ms，不能沿链吸收，
  // 但它与后句间隔 100ms，因此仍可独立并入后句。
  assert.deepEqual(plan.groups, [[0, 1], [2, 3]]);

  const farShort = [
    { start: 0, end: 1000, text: '前一句较长字幕' },
    { start: 1500, end: 1800, text: '短句' },
    { start: 3000, end: 4000, text: '后一句较长字幕' },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.planAutoMerge(farShort, { gapMs: 200, shortCount: 3 }).groups)),
    [],
  );
});

test('applies backward snaps by extending the later subtitle start earlier', () => {
  const segments = [
    { start: 0, end: 1000, text: '前一句字幕' },
    { start: 1150, end: 2400, text: '后一句字幕' },
  ];
  const changed = helpers.applyAutoMergeSnaps(segments, [{ index: 1, edge: 'start', time: 1000 }]);
  assert.equal(changed, 1);
  assert.deepEqual([segments[1].start, segments[1].end], [1000, 2400]);
  assert.equal(segments[1]._dirty, true);
});

test('applies forward snaps by extending the earlier subtitle end later', () => {
  const segments = [
    { start: 0, end: 1000, text: '前一句字幕' },
    { start: 1150, end: 2400, text: '后一句字幕' },
  ];
  const changed = helpers.applyAutoMergeSnaps(segments, [{ index: 0, edge: 'end', time: 1150 }]);
  assert.equal(changed, 1);
  assert.deepEqual([segments[0].start, segments[0].end], [0, 1150]);
});

test('never shortens a subtitle when applying snaps', () => {
  const segments = [
    { start: 100, end: 1000, text: '前一句字幕' },
    { start: 1200, end: 2400, text: '后一句字幕' },
  ];
  // start 只会变小（前拓）、end 只会变大（后延）；相反方向的 snap 被忽略
  const changed = helpers.applyAutoMergeSnaps(segments, [
    { index: 0, edge: 'start', time: 500 },
    { index: 1, edge: 'end', time: 1000 },
  ]);
  assert.equal(changed, 0);
  assert.deepEqual([segments[0].start, segments[0].end], [100, 1000]);
  assert.deepEqual([segments[1].start, segments[1].end], [1200, 2400]);
});

test('translates snap-subtitles flash hints to English', () => {
  assert.equal(i18n.translateText('拼合字幕', 'en'), 'Snap subtitles');
  assert.equal(i18n.translateText('没有需要拼合的间隔或过短字幕', 'en'), 'No intervals or short subtitles to snap');
  assert.equal(
    i18n.translateText('已拼合字幕：拼合 2 处间隔，吸收 1 条短字幕', 'en'),
    'Snap subtitles: snapped 2 intervals, absorbed 1 short subtitles',
  );
  assert.equal(
    i18n.translateText('已拼合字幕：吸收 3 条短字幕', 'en'),
    'Snap subtitles: absorbed 3 short subtitles',
  );
});

test('widens a zero-length trailing item and extends its segment', () => {
  const segments = [
    {
      start: 17790,
      end: 20340,
      text: '用卫星拍照片 能得到什么？',
      items: [
        { text: '用卫星拍照片 能得到', start: 17790, end: 20340 },
        { text: '什么？', start: 20340, end: 20340 },
      ],
    },
  ];
  const fixed = helpers.normalizeSegmentTimings(segments);
  assert.ok(fixed >= 1);
  assert.equal(segments[0].end, 20440);
  assert.equal(segments[0].items[1].end, 20440);
});

test('widens a zero-length segment and keeps following segments ordered', () => {
  const segments = [
    { start: 0, end: 1000, text: '第一句' },
    { start: 1000, end: 1000, text: '嗯' },
    { start: 1000, end: 2000, text: '第二句' },
  ];
  const fixed = helpers.normalizeSegmentTimings(segments);
  assert.ok(fixed >= 2);
  assert.deepEqual([segments[1].start, segments[1].end], [1000, 1100]);
  assert.equal(segments[2].start, 1100);
});

test('widens inverted items without touching genuine short timings', () => {
  const segments = [
    {
      start: 0,
      end: 300,
      text: 'The end.',
      items: [
        { text: 'The', start: 0, end: 60 },
        { text: ' end.', start: 60, end: 300 },
      ],
    },
    {
      start: 400,
      end: 460,
      text: 'short but valid',
      items: [{ text: 'oops', start: 460, end: 400 }],
    },
  ];
  const fixed = helpers.normalizeSegmentTimings(segments);
  assert.equal(fixed, 2);
  // 合法的 60ms 词保持不变
  assert.equal(segments[0].items[0].end, 60);
  assert.deepEqual([segments[0].start, segments[0].end], [0, 300]);
  // 倒挂 item 拉齐到 100ms，段 end 随之延伸
  assert.deepEqual([segments[1].items[0].start, segments[1].items[0].end], [460, 560]);
  assert.equal(segments[1].end, 560);
});

test('translates timing-repair flash hints to English', () => {
  assert.equal(
    i18n.translateText('已自动修复 2 处 0 长时间码（保底 100ms）', 'en'),
    'Auto-repaired 2 zero-length timings (100 ms minimum)',
  );
});

test('formats removed silence duration and media share for the summary', () => {
  assert.equal(helpers.formatHumanDuration(45_890), '45秒');
  assert.equal(helpers.formatHumanDuration(1_455_890), '24分15秒');
  assert.equal(helpers.formatHumanDuration(3_661_999), '1小时1分1秒');
  assert.equal(
    helpers.formatGapRemoveDuration(1_455_890, 5_823_560),
    '24分15秒（占比 25%）',
  );
  assert.equal(
    helpers.formatGapRemoveDuration(45_890, 100_000),
    '45秒（占比 45.9%）',
  );
  assert.equal(helpers.formatGapRemoveDuration(45_890, 0), '45秒');
});


test('finds previous and next visible cue for the current cue panel', () => {
  const segments = [
    { start: 0, end: 999, disabled: false },
    { start: 1000, end: 1999, disabled: true },
    { start: 2000, end: 2999, disabled: false },
    { start: 3000, end: 3999, disabled: false },
  ];
  assert.equal(helpers.findAdjacentCueIndex(segments, 2, -1, true), 0);
  assert.equal(helpers.findAdjacentCueIndex(segments, 0, 1, true), 2);
  assert.equal(helpers.findAdjacentCueIndex(segments, 2, 1, false), 3);
});

test('extends keyboard selection from its outer edge and skips hidden disabled cues', () => {
  const segments = [
    { start: 0, end: 999, disabled: false },
    { start: 1000, end: 1999, disabled: true },
    { start: 2000, end: 2999, disabled: false },
    { start: 3000, end: 3999, disabled: false },
  ];

  assert.equal(
    helpers.findCueSelectionExtensionTarget(segments, new Set([2]), 2, 0, -1, true),
    0,
  );
  assert.equal(
    helpers.findCueSelectionExtensionTarget(segments, new Set([0, 2]), 2, 0, 1, true),
    3,
  );
  assert.equal(
    helpers.findCueSelectionExtensionTarget(segments, new Set(), -1, 2500, 1, false),
    3,
  );
});

test('merge group inheritance keeps a common head or reference and rejects mixed groups', () => {
  const segments = [
    {
      color: { name: 'red', value: '#e74c3c', start: 0, end: 3000 },
    },
    {
      color_ref: { name: 'red', headIdx: 0 },
    },
    {
      color_ref: { name: 'red', headIdx: 0 },
    },
    {
      color: { name: 'blue', value: '#3498db', start: 3000, end: 4000 },
    },
  ];

  const refsOnly = helpers.resolveMergedGroupInheritance(
    segments, [1, 2], 'color', 'color_ref',
  );
  assert.equal(refsOnly.head, null);
  assert.deepEqual(JSON.parse(JSON.stringify(refsOnly.ref)), { name: 'red', headIdx: 0 });

  const includingHead = helpers.resolveMergedGroupInheritance(
    segments, [0, 1], 'color', 'color_ref',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(includingHead.head)), segments[0].color);
  assert.equal(includingHead.ref, null);
  includingHead.head.name = 'changed';
  assert.equal(segments[0].color.name, 'red', 'inherited head must be cloned');

  const mixed = helpers.resolveMergedGroupInheritance(
    segments, [2, 3], 'color', 'color_ref',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(mixed)), {
    head: null,
    ref: null,
    headIdx: null,
  });
});

test('finds A/D navigation targets from selection or playhead', () => {
  const segments = [
    { start: 1000, end: 2000 },
    { start: 2500, end: 3000, disabled: true },
    { start: 3500, end: 4500 },
    { start: 5000, end: 6000 },
  ];

  assert.equal(helpers.findCueNavigationTarget(segments, 2, 3500, -1, false), 1);
  assert.equal(helpers.findCueNavigationTarget(segments, 2, 3500, -1, true), 0);
  assert.equal(helpers.findCueNavigationTarget(segments, -1, 4000, -1, false), 1);
  assert.equal(helpers.findCueNavigationTarget(segments, -1, 4000, -1, true), 0);
  assert.equal(helpers.findCueNavigationTarget(segments, -1, 4000, 1, true), 3);
  assert.equal(helpers.findCueNavigationTarget(segments, -1, 3200, -1, true), 0);
  assert.equal(helpers.findCueNavigationTarget(segments, -1, 3200, 1, true), 2);
});


test('finds the first enabled subtitle for optional SRT alignment', () => {
  const segments = [
    { start: 1200, disabled: true },
    { start: 2450, disabled: false },
    { start: 4000 },
  ];
  assert.equal(helpers.getSrtExportFirstIndex(segments, true), 1);
  assert.equal(helpers.getSrtExportFirstIndex(segments, false), -1);
  assert.equal(helpers.getSrtExportOffset(segments, true), 2450);
  assert.equal(helpers.getSrtExportOffset(segments, false), 0);
  assert.equal(helpers.getSrtExportOffset(segments), 0);
  assert.equal(helpers.getSrtExportOffset([{ start: 500, disabled: true }], true), 0);
});


test('only extends the first SRT cue to zero without shifting later cues', () => {
  const segments = [
    { start: 1200, end: 1800, text: 'first' },
    { start: 2400, end: 3000, text: 'later' },
  ];
  assert.equal(helpers.buildSrtPayload(segments, {
    alignFirstStart: true,
    formatTime: (timeMs) => `${timeMs}ms`,
  }), [
    '1',
    '0ms --> 1800ms',
    'first',
    '',
    '2',
    '2400ms --> 3000ms',
    'later',
    '',
  ].join('\n'));
});


test('keeps the shared timeline when a color export starts after the first cue', () => {
  const segments = [
    { start: 1200, end: 1800, text: 'blue', color: { name: 'blue' } },
    { start: 2400, end: 3000, text: 'red', color: { name: 'red' } },
  ];
  assert.equal(helpers.buildSrtPayload(segments, {
    colorName: 'red',
    alignFirstStart: true,
    firstEnabledIndex: 0,
    formatTime: (timeMs) => `${timeMs}ms`,
  }), ['1', '2400ms --> 3000ms', 'red', ''].join('\n'));
});


test('resolves referenced subtitle colors from their head when available', () => {
  const segments = [
    { color: { name: 'red' } },
    { color_ref: { name: 'stale', headIdx: 0 } },
    { color_ref: { name: 'blue', headIdx: 99 } },
    {},
  ];
  assert.equal(helpers.effectiveColorName(segments[0], segments), 'red');
  assert.equal(helpers.effectiveColorName(segments[1], segments), 'red');
  assert.equal(helpers.effectiveColorName(segments[2], segments), 'blue');
  assert.equal(helpers.effectiveColorName(segments[3], segments), null);
});


test('shifts color and sticker references when a subtitle is inserted', () => {
  const segments = [
    { color: { name: 'blue' }, sticker: { name: 'blue-sticker' } },
    { color: { name: 'red' }, sticker: { name: 'red-sticker' } },
    {
      color_ref: { name: 'red', headIdx: 1 },
      sticker_ref: { name: 'red-sticker', headIdx: 1 },
    },
  ];
  segments.splice(0, 0, { start: 0, end: 1000, text: '' });

  assert.equal(helpers.shiftGroupReferenceIndices(segments, 0), 2);
  assert.equal(segments[3].color_ref.headIdx, 2);
  assert.equal(segments[3].sticker_ref.headIdx, 2);
  assert.equal(helpers.effectiveColorName(segments[3], segments), 'red');
});


test('repairs stale group references by the saved head name', () => {
  const segments = [
    { color: { name: 'blue' } },
    { color: { name: 'red' } },
    { color_ref: { name: 'red', headIdx: 0 } },
  ];

  assert.equal(helpers.repairGroupReferenceIndices(segments), 1);
  assert.equal(segments[2].color_ref.headIdx, 1);
  assert.equal(helpers.effectiveColorName(segments[2], segments), 'red');
});


test('builds a color SRT on the shared full-export timeline and excludes disabled cues', () => {
  const segments = [
    { start: 500, end: 900, text: 'plain' },
    { start: 1000, end: 1800, text: 'lead', color: { name: 'red' } },
    { start: 2000, end: 2800, text: 'member', color_ref: { name: 'red', headIdx: 1 } },
    { start: 3000, end: 3800, text: 'disabled', color_ref: { name: 'red', headIdx: 1 }, disabled: true },
  ];
  assert.equal(helpers.buildSrtPayload(segments, {
    colorName: 'red',
    timeOffset: 500,
    formatTime: (timeMs) => `${timeMs}ms`,
  }), [
    '1',
    '500ms --> 1300ms',
    'lead',
    '',
    '2',
    '1500ms --> 2300ms',
    'member',
    '',
  ].join('\n'));
});

test('builds the default-color SRT from enabled subtitles without a color', () => {
  const segments = [
    { start: 0, end: 500, text: 'plain' },
    { start: 500, end: 1000, text: 'red', color: { name: 'red' } },
    { start: 1000, end: 1500, text: 'disabled plain', disabled: true },
  ];
  assert.equal(helpers.buildSrtPayload(segments, {
    colorName: 'default',
    formatTime: (timeMs) => `${timeMs}ms`,
  }), ['1', '0ms --> 500ms', 'plain', ''].join('\n'));
});

test('builds plain text as enabled subtitle lines', () => {
  assert.equal(helpers.buildPlainTextPayload([
    { text: '第一行' },
    { text: '第二行\n续行' },
    { text: '不导出', disabled: true },
  ]), '第一行\n第二行\n续行');
});


test('builds a gap-mapped color SRT with positive cue durations', () => {
  const segments = [
    { start: 1000, end: 1400, text: 'red', color: { name: 'red' } },
    { start: 1500, end: 1600, text: 'blue', color: { name: 'blue' } },
  ];
  assert.equal(helpers.buildSrtPayload(segments, {
    colorName: 'red',
    mapTime: () => 500,
    ensurePositiveDuration: true,
    formatTime: (timeMs) => `${timeMs}ms`,
  }), [
    '1',
    '500ms --> 501ms',
    'red',
    '',
  ].join('\n'));
});


test('finds only internal audio gaps that pass the gate threshold and minimum duration', () => {
  const gaps = helpers.detectAudioGapRemoveGaps({
    peaks: new Int8Array([
      -100, 100, 0, 0, 0, 0, 0, 0, 0, 0, -100, 100, 0, 0,
    ]),
    peaks_per_second: 10,
    duration_ms: 700,
  }, {
    minimumMs: 300,
    thresholdDb: -20,
    hysteresisDb: 6,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)), [
    { start: 100, end: 500, removed: true },
  ]);
});


test('uses hysteresis so a quieter but still audible section does not make a false gap', () => {
  const waveform = {
    peaks: new Int8Array([-30, 30, -10, 10, -10, 10, -30, 30]),
    peaks_per_second: 10,
    duration_ms: 400,
  };
  const withoutHysteresis = helpers.detectAudioGapRemoveGaps(waveform, {
    minimumMs: 100,
    thresholdDb: -20,
    hysteresisDb: 0,
  });
  const withHysteresis = helpers.detectAudioGapRemoveGaps(waveform, {
    minimumMs: 100,
    thresholdDb: -20,
    hysteresisDb: 6,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(withoutHysteresis)), [
    { start: 100, end: 300, removed: true },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(withHysteresis)), []);
});


test('applies lead-in and lead-out padding so gaps keep surrounding silence', () => {
  const waveform = {
    peaks: new Int8Array([
      -100, 100, 0, 0, 0, 0, 0, 0, 0, 0, -100, 100, 0, 0,
    ]),
    peaks_per_second: 10,
    duration_ms: 700,
  };
  const withoutPadding = helpers.detectAudioGapRemoveGaps(waveform, {
    minimumMs: 100,
    thresholdDb: -20,
    hysteresisDb: 6,
  });
  const withPadding = helpers.detectAudioGapRemoveGaps(waveform, {
    minimumMs: 100,
    thresholdDb: -20,
    hysteresisDb: 6,
    leadInMs: 30,
    leadOutMs: 100,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(withoutPadding)), [
    { start: 100, end: 500, removed: true },
  ]);
  // 原始静音 100–500；前端预留 30 抬到 130，后端预留 100 压到 400
  assert.deepEqual(JSON.parse(JSON.stringify(withPadding)), [
    { start: 130, end: 400, removed: true },
  ]);
});


test('drops a gap entirely when lead padding consumes its duration', () => {
  const gaps = helpers.detectAudioGapRemoveGaps({
    peaks: new Int8Array([
      -100, 100, 0, 0, 0, 0, 0, 0, 0, 0, -100, 100, 0, 0,
    ]),
    peaks_per_second: 10,
    duration_ms: 700,
  }, {
    minimumMs: 100,
    thresholdDb: -20,
    hysteresisDb: 6,
    leadInMs: 250,
    leadOutMs: 250,
  });
  // 预留总量 500ms 把原始 400ms 静音完全吃掉，整段不再算移除
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)), []);
});


test('Alt-middle restoration only affects removed parts overlapped by the range', () => {
  const gaps = helpers.applyGapRemoveRange([
    { start: 100, end: 500, removed: true },
    { start: 700, end: 1000, removed: true },
  ], 300, 800, false);
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)), [
    { start: 100, end: 300, removed: true },
    { start: 300, end: 500, removed: false },
    { start: 700, end: 800, removed: false },
    { start: 800, end: 1000, removed: true },
  ]);
});


test('middle-button range adds arbitrary silence and overrides restored ranges', () => {
  const gaps = helpers.applyGapRemoveRange([
    { start: 100, end: 400, removed: false },
    { start: 700, end: 900, removed: true },
  ], 250, 800, true);
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)), [
    { start: 100, end: 250, removed: false },
    { start: 250, end: 900, removed: true },
  ]);
});


test('dragging a shared gap boundary adjusts both neighboring states', () => {
  const gaps = helpers.resizeGapRemoveBoundary([
    { start: 100, end: 400, removed: true },
    { start: 400, end: 700, removed: false },
  ], 0, 'end', 520);
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)), [
    { start: 100, end: 520, removed: true },
    { start: 520, end: 700, removed: false },
  ]);
});


test('dragging a gap boundary into the next gap merges both ranges', () => {
  const gaps = helpers.resizeGapRemoveBoundary([
    { start: 100, end: 400, removed: true },
    { start: 700, end: 900, removed: false },
    { start: 1100, end: 1300, removed: true },
  ], 0, 'end', 750);
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)), [
    { start: 100, end: 900, removed: true },
    { start: 1100, end: 1300, removed: true },
  ]);
});


test('maps source time and media intervals after restored gaps are excluded', () => {
  const gaps = [
    { start: 1000, end: 1600, removed: true },
    { start: 2400, end: 3000, removed: false },
    { start: 4000, end: 4500, removed: true },
  ];
  assert.equal(helpers.mapGapRemovedTime(900, gaps), 900);
  assert.equal(helpers.mapGapRemovedTime(1400, gaps), 1000);
  assert.equal(helpers.mapGapRemovedTime(5000, gaps), 3900);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.buildGapRemovedIntervals(6000, gaps))), [
    { start: 0, end: 1000 },
    { start: 1600, end: 4000 },
    { start: 4500, end: 6000 },
  ]);
});

test('builds an ffconcat plan from kept media intervals', () => {
  assert.equal(helpers.buildFfconcat("D:\\Media\\Alice's take.mp4", [
    { start: 0, end: 1000 },
    { start: 1600, end: 4500 },
  ]), [
    'ffconcat version 1.0',
    "file 'D:/Media/Alice'\\''s take.mp4'",
    'inpoint 0.000',
    'outpoint 1.000',
    "file 'D:/Media/Alice'\\''s take.mp4'",
    'inpoint 1.600',
    'outpoint 4.500',
    '',
  ].join('\n'));
});


test('maps a waveform click to the nearest timestamped word boundary', () => {
  const segment = {
    start: 0,
    end: 1200,
    text: '你好，世界！',
    items: [
      { text: '你好', start: 0, end: 400 },
      { text: '世界', start: 600, end: 1000 },
      { text: '！', start: 1000, end: 1200 },
    ],
  };
  assert.equal(helpers.splitCharOffsetAtTime(segment, 520), 3);
  assert.equal(helpers.splitCharOffsetAtTime(segment, 1080), 3);
  assert.equal(helpers.splitCharOffsetAtTime({
    start: 0,
    end: 100,
    text: '好！',
    items: [
      { text: '好', start: 0, end: 80 },
      { text: '！', start: 80, end: 100 },
    ],
  }, 90), null);
});


test('waveform split fallback keeps the caret on a Unicode character boundary', () => {
  const segment = { start: 0, end: 300, text: 'A😀B' };
  assert.equal(helpers.splitCharOffsetAtTime(segment, 200), 3);
  assert.equal(helpers.splitCharOffsetAtTime({ start: 0, end: 100, text: '猫' }, 50), null);
});


test('shares configured Enter semantics between list editing and current cue editing', () => {
  assert.equal(helpers.configuredEnterAction({ key: 'Enter', ctrlKey: true }, 'ctrl-enter'), 'split');
  assert.equal(helpers.configuredEnterAction({ key: 'Enter' }, 'ctrl-enter'), 'save');
  assert.equal(helpers.configuredEnterAction({ key: 'Enter' }, 'enter'), 'split');
  assert.equal(helpers.configuredEnterAction({ key: 'Enter', ctrlKey: true }, 'enter'), 'save');
  assert.equal(helpers.configuredEnterAction({ key: 'Enter', shiftKey: true }, 'ctrl-enter'), 'newline');
  // macOS：⌘（metaKey）与 Ctrl 等价
  assert.equal(helpers.configuredEnterAction({ key: 'Enter', metaKey: true }, 'ctrl-enter'), 'split');
  assert.equal(helpers.configuredEnterAction({ key: 'Enter', metaKey: true }, 'enter'), 'save');
  assert.equal(helpers.configuredEnterAction({ key: 'Enter', shiftKey: true, metaKey: true }, 'ctrl-enter'), 'split');
  assert.equal(helpers.configuredEnterAction({ key: 'Enter', ctrlKey: true, metaKey: true }, 'enter'), 'save');
  assert.equal(
    helpers.configuredEnterAction({ key: 'Enter', shiftKey: true, ctrlKey: true }, 'enter'),
    'split',
  );
});


test('isMacPlatform detects macOS while other platforms do not', () => {
  assert.equal(helpers.isMacPlatform({ platform: 'MacIntel' }), true);
  assert.equal(helpers.isMacPlatform({ platform: 'iPhone' }), true);
  assert.equal(helpers.isMacPlatform({ platform: 'Win32' }), false);
  assert.equal(helpers.isMacPlatform({ platform: 'Linux x86_64' }), false);
  // 无 navigator 环境（如 node 测试）安全降级为 false
  assert.equal(helpers.isMacPlatform(null), false);
});


test('history stack: push clears redo and peek reports top without popping', () => {
  const h = helpers.createHistoryStack(100);
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.equal(h.peekUndo(), null);
  h.push({ kind: 'segments', label: 'A', segs: [1] });
  h.push({ kind: 'segments', label: 'B', segs: [2] });
  assert.equal(h.undoLength(), 2);
  assert.equal(h.canUndo(), true);
  assert.deepEqual(h.peekUndo(), { kind: 'segments', label: 'B', segs: [2] });
  assert.equal(h.undoLength(), 2); // peek 不消费
});


test('history stack: popUndo/popRedo round-trip restores records and mirrors current snapshots', () => {
  const h = helpers.createHistoryStack(100);
  h.push({ kind: 'segments', label: 'edit1', segs: ['after1'] });
  h.push({ kind: 'segments', label: 'edit2', segs: ['after2'] });

  // undo edit2: 当前状态 'after2' 进入 redo，返回 'edit2'（其 segs 是 edit2 之前的快照）
  const undoRecord = h.popUndo({ kind: 'segments', label: 'edit2', segs: ['after2'] });
  assert.deepEqual(undoRecord, { kind: 'segments', label: 'edit2', segs: ['after2'] });
  assert.equal(h.undoLength(), 1);
  assert.equal(h.redoLength(), 1);
  assert.equal(h.canRedo(), true);

  // redo edit2: 当前状态（刚还原的 'edit2' 之前状态）回到 undo，返回 redo 顶部 'after2'
  const redoRecord = h.popRedo({ kind: 'segments', label: 'edit2', segs: ['before2'] });
  assert.deepEqual(redoRecord, { kind: 'segments', label: 'edit2', segs: ['after2'] });
  assert.equal(h.undoLength(), 2);
  assert.equal(h.redoLength(), 0);
});


test('history stack: a new push after undo clears the redo stack', () => {
  const h = helpers.createHistoryStack(100);
  h.push({ kind: 'segments', label: 'A', segs: [1] });
  h.popUndo({ kind: 'segments', label: 'A', segs: [1] });
  assert.equal(h.redoLength(), 1);
  h.push({ kind: 'segments', label: 'B', segs: [2] });
  assert.equal(h.redoLength(), 0);
  assert.equal(h.canRedo(), false);
  assert.equal(h.undoLength(), 1);
});


test('history stack: limit trims oldest undo entries and clamps to at least 1', () => {
  const h = helpers.createHistoryStack(3);
  h.push({ label: 'a' });
  h.push({ label: 'b' });
  h.push({ label: 'c' });
  h.push({ label: 'd' });
  assert.equal(h.undoLength(), 3);
  assert.equal(h.peekUndo().label, 'd');
  // 最旧的 'a' 被裁掉
  const first = h.popUndo({ label: 'cur' });
  assert.equal(first.label, 'd');
  const second = h.popUndo({ label: 'cur' });
  assert.equal(second.label, 'c');
  const third = h.popUndo({ label: 'cur' });
  assert.equal(third.label, 'b');
  assert.equal(h.canUndo(), false);
  // undo 已空：popUndo 返回 null，不抛错；redo 仍持有 3 条镜像
  assert.equal(h.popUndo({ label: 'x' }), null);
  assert.equal(h.redoLength(), 3);
  // 清空 redo 后 popRedo 才返回 null
  h.clearRedo();
  assert.equal(h.popRedo({ label: 'x' }), null);
});


test('history stack: clear and clearRedo reset the right stacks', () => {
  const h = helpers.createHistoryStack(100);
  h.push({ label: 'a' });
  h.popUndo({ label: 'cur' });
  h.push({ label: 'b' });
  // undo=[b], redo=[] 已被 push 清空
  assert.equal(h.redoLength(), 0);
  h.popUndo({ label: 'cur' });
  // undo=[], redo=[cur]
  assert.equal(h.undoLength(), 0);
  assert.equal(h.redoLength(), 1);
  h.clearRedo();
  assert.equal(h.redoLength(), 0);
  h.push({ label: 'c' });
  h.push({ label: 'd' });
  h.clear();
  assert.equal(h.undoLength(), 0);
  assert.equal(h.redoLength(), 0);
});


// === preview.subtitle geometry helpers ===

test('normalizePreviewGeometry returns default geometry for invalid input', () => {
  const expected = { x: 0.1, y: 0.76, width: 0.8, height: 0.16 };
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.normalizePreviewGeometry(null))), expected);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.normalizePreviewGeometry('bad'))), expected);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.normalizePreviewGeometry({}))), expected);
});

test('normalizePreviewGeometry clamps out-of-range values to valid bounds', () => {
  const geo = JSON.parse(JSON.stringify(helpers.normalizePreviewGeometry({ x: -0.5, y: 2, width: 0.1, height: 2 })));
  assert.equal(geo.x, 0);
  assert.equal(geo.width, helpers.PREVIEW_MIN_WIDTH); // 0.20
  assert.equal(geo.height, 1);
  // y was 2, but y + height must be <= 1, so y = 1 - height = 0
  assert.equal(geo.y, 0);
});

test('clampPreviewGeometry enforces min-size and box-fits-inside-player', () => {
  const clamped = JSON.parse(JSON.stringify(
    helpers.clampPreviewGeometry({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }),
  ));
  assert.ok(clamped.x + clamped.width <= 1.0001, 'x + width <= 1');
  assert.ok(clamped.y + clamped.height <= 1.0001, 'y + height <= 1');
  assert.ok(clamped.width >= helpers.PREVIEW_MIN_WIDTH - 0.0001, 'width >= min');
  assert.ok(clamped.height >= helpers.PREVIEW_MIN_HEIGHT - 0.0001, 'height >= min');
  assert.ok(clamped.x >= 0 && clamped.y >= 0, 'x,y >= 0');
});

test('previewGeometryToCss converts normalized fractions to percentage strings', () => {
  const css = helpers.previewGeometryToCss({ x: 0.5, y: 0.25, width: 0.4, height: 0.1 });
  assert.equal(css.left, '50.0000%');
  assert.equal(css.top, '25.0000%');
  assert.equal(css.width, '40.0000%');
  assert.equal(css.height, '10.0000%');
});

test('applyPreviewGeometryDelta moves the box and clamps to player bounds', () => {
  const geo = { x: 0.4, y: 0.4, width: 0.3, height: 0.2 };
  const moved = helpers.applyPreviewGeometryDelta(geo, 'move', 0.5, 0.5);
  // 0.4 + 0.5 = 0.9, but x + width (0.3) must be <= 1 → x = 0.7
  assert.ok(moved.x + moved.width <= 1.0001);
  assert.ok(moved.y + moved.height <= 1.0001);
  assert.ok(Math.abs(moved.width - 0.3) < 1e-9);
  assert.ok(Math.abs(moved.height - 0.2) < 1e-9);
});

test('applyPreviewGeometryDelta resize-se grows width and height', () => {
  const geo = { x: 0.1, y: 0.1, width: 0.3, height: 0.2 };
  const resized = helpers.applyPreviewGeometryDelta(geo, 'se', 0.2, 0.1);
  assert.ok(Math.abs(resized.x - 0.1) < 1e-9);
  assert.ok(Math.abs(resized.y - 0.1) < 1e-9);
  assert.ok(Math.abs(resized.width - 0.5) < 1e-9, `width ~0.5, got ${resized.width}`);
  assert.ok(Math.abs(resized.height - 0.3) < 1e-9, `height ~0.3, got ${resized.height}`);
});

test('applyPreviewGeometryDelta resize-nw shrinks and enforces min-size', () => {
  const geo = { x: 0.1, y: 0.1, width: 0.3, height: 0.2 };
  // drag nw by (+0.4, +0.15) — tries to shrink width to -0.1, height to 0.05
  const resized = helpers.applyPreviewGeometryDelta(geo, 'nw', 0.4, 0.15);
  assert.ok(resized.width >= helpers.PREVIEW_MIN_WIDTH - 0.0001, 'width >= min');
  assert.ok(resized.height >= helpers.PREVIEW_MIN_HEIGHT - 0.0001, 'height >= min');
});

test('applyPreviewGeometryDelta resize-w keeps right edge fixed at min-size', () => {
  const geo = { x: 0.2, y: 0.2, width: 0.4, height: 0.2 };
  // drag west handle right by 0.3 → width would be 0.1 < min 0.20
  const resized = helpers.applyPreviewGeometryDelta(geo, 'w', 0.3, 0);
  assert.ok(resized.width >= helpers.PREVIEW_MIN_WIDTH - 0.0001);
  // right edge (x + width) should stay at original 0.2 + 0.4 = 0.6
  assert.ok(Math.abs((resized.x + resized.width) - 0.6) < 0.001);
});
