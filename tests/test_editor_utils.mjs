import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { TextDecoder, TextEncoder } from 'node:util';
import vm from 'node:vm';


const source = fs.readFileSync(new URL('../web/editor-utils.js', import.meta.url), 'utf8');
const context = { window: {}, TextDecoder, TextEncoder, Uint8Array };
vm.runInNewContext(source, context);
const helpers = context.window.AsrEditorUtils;
const i18nSource = fs.readFileSync(new URL('../web/editor-i18n.js', import.meta.url), 'utf8');
const i18nContext = { window: {} };
vm.runInNewContext(i18nSource, i18nContext);
const i18n = i18nContext.window.MAWE_I18N;

function parseXml(xml) {
  const result = spawnSync('python', ['-c', [
    'import sys, xml.etree.ElementTree as ET',
    'ET.fromstring(sys.stdin.read())',
    'print("ok")',
  ].join(';')], { input: xml, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
  assert.equal(result.status, 0, result.stderr);
  return xml;
}

function parseXmlFileAudio(xml) {
  const script = [
    'import json, sys, xml.etree.ElementTree as ET',
    'root = ET.fromstring(sys.stdin.read())',
    'files = []',
    'for element in root.findall(".//file"):','  audio = element.find("./media/audio")',
    '  files.append({"id": element.attrib["id"], "channelcount": audio.findtext("channelcount") if audio is not None else None})',
    'print(json.dumps(files))',
  ].join('\n');
  const result = spawnSync('python', ['-c', script], { input: xml, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function parseSrt(srt) {
  return srt.trim().split(/\n\n+/).map((block) => {
    const lines = block.split('\n');
    const match = /^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/.exec(lines[1]);
    assert.ok(match);
    return { number: Number(lines[0]), start: match[1], end: match[2], text: lines.slice(2).join('\n') };
  });
}

function xmlElements(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'g'))].map((match) => match[0]);
}


test('maps exactly the approved preview font families in Chinese', () => {
  const cases = [
    ['Microsoft YaHei', '微软雅黑'],
    ['Microsoft YaHei UI', '微软雅黑'],
    ['SimHei', '黑体'],
    ['SimSun', '宋体'],
    ['NSimSun', '新宋体'],
    ['FangSong', '仿宋'],
    ['KaiTi', '楷体'],
    ['PingFang SC', '苹方'],
    ['Heiti SC', '黑体-简'],
    ['Songti SC', '宋体-简'],
    ['Kaiti SC', '楷体-简'],
    ['Source Han Sans SC', '思源黑体'],
    ['Source Han Serif SC', '思源宋体'],
    ['Noto Sans CJK SC', 'Noto Sans CJK 简体中文'],
    ['Noto Serif CJK SC', 'Noto Serif CJK 简体中文'],
  ];
  for (const [family, displayName] of cases) {
    assert.equal(helpers.subtitleFontFamilyDisplayName(family, 'zh'), displayName);
    assert.equal(helpers.subtitleFontFamilyDisplayName(family, 'en'), family);
  }
});


test('leaves unknown and non-string preview font families unchanged', () => {
  assert.equal(helpers.subtitleFontFamilyDisplayName('MAW Test Sans', 'zh'), 'MAW Test Sans');
  assert.equal(helpers.subtitleFontFamilyDisplayName('Microsoft Yahei', 'zh'), 'Microsoft Yahei');
  assert.equal(helpers.subtitleFontFamilyDisplayName(null, 'zh'), null);
});

test('decodes UTF-8, BOM, UTF-16, and Windows GB18030 subtitle bytes', () => {
  const encode = (label, text) => new TextEncoder().encode(text);
  const utf8 = encode('utf-8', '1\n00:00:00,000 --> 00:00:01,000\n你好');
  assert.equal(helpers.decodeSubtitleText(utf8), '1\n00:00:00,000 --> 00:00:01,000\n你好');

  const utf8Bom = new Uint8Array([0xEF, 0xBB, 0xBF, ...utf8]);
  assert.equal(helpers.decodeSubtitleText(utf8Bom), '1\n00:00:00,000 --> 00:00:01,000\n你好');

  const utf16le = new Uint8Array([0xFF, 0xFE, ...Buffer.from('你好', 'utf16le')]);
  assert.equal(helpers.decodeSubtitleText(utf16le), '你好');

  assert.equal(helpers.decodeSubtitleText(new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3])), '你好');
});

test('normalizes and resolves keyboard operation references', () => {
  assert.equal(helpers.normalizeKeyboardOperationReferenceMode('pointer'), 'pointer');
  assert.equal(helpers.normalizeKeyboardOperationReferenceMode('playhead'), 'playhead');
  assert.equal(helpers.normalizeKeyboardOperationReferenceMode('invalid'), 'pointer');
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.resolveKeyboardOperationReference('pointer', {
    pointer: { timeMs: 2000, track: 'extension', trackId: 'secondary' },
  }))), { timeMs: 2000, track: 'extension', trackId: 'secondary', source: 'pointer' });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.resolveKeyboardOperationReference('playhead', {
    pointer: { timeMs: 2000, track: 'main' },
    playheadTarget: { kind: 'extension', timeMs: 6000, trackId: 'secondary' },
  }))), { timeMs: 6000, track: 'extension', trackId: 'secondary', source: 'playhead' });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.resolveKeyboardOperationReference('playhead', {
    playheadTarget: { kind: 'main', timeMs: 6000 },
  }))), { timeMs: 6000, track: 'main', trackId: null, source: 'playhead' });
  assert.equal(helpers.resolveKeyboardOperationReference('pointer', { pointer: null }), null);
});

test('normalizes editor settings without preserving invalid persisted values', () => {
  const settings = helpers.normalizeEditorSettings({
    multiSubtitleRowHeight: 999,
    mediaSeekStepSeconds: 2,
    cueMoveStepMs: -1,
    theme: 'light',
    stickerOtioExportMode: 'portable',
    autoMergeShortCount: 99,
  });
  assert.equal(settings.multiSubtitleRowHeight, 168);
  assert.equal(settings.mediaSeekStepMs, 2000);
  assert.equal(settings.cueMoveStepMs, 10);
  assert.equal(settings.theme, 'light');
  assert.equal(settings.stickerOtioExportMode, 'portable');
  assert.equal(settings.autoMergeShortCount, 20);
  assert.equal(settings.waveShapeSource, 'reapeaks');
  assert.equal(helpers.normalizeEditorSettings({ waveShapeSource: 'self' }).waveShapeSource, 'self');
  assert.equal(helpers.normalizeEditorSettings({ waveShapeSource: 'invalid' }).waveShapeSource, 'reapeaks');
});

test('normalizes gap-remove data and returns independent gap values', () => {
  const input = { detector: 'legacy_subtitle_gap', minimum_ms: 1, gaps: [{ start: 10, end: 20 }] };
  const normalized = helpers.normalizeGapRemoveData(input);
  assert.equal(normalized.minimum_ms, 100);
  assert.equal(normalized.detector, 'legacy_subtitle_gap');
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.gaps)), [{ start: 10, end: 20, removed: true }]);
  input.gaps[0].start = 999;
  assert.equal(normalized.gaps[0].start, 10);
});

test('builds immutable-shaped history records for each editor history kind', () => {
  const snapshot = helpers.buildSegmentsHistorySnapshot([{ text: 'before' }], { enabled: false });
  const record = helpers.buildHistoryRecord('segments', '', snapshot, { mainIds: ['a'] });
  assert.deepEqual(JSON.parse(JSON.stringify(record)), {
    kind: 'segments', label: '编辑',
    segs: JSON.parse(JSON.stringify(snapshot)), view: { mainIds: ['a'] },
  });
  snapshot.segments[0].text = 'after';
  assert.equal(record.segs.segments[0].text, 'before');
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.buildHistoryRecord('gap_remove', null, {
    gapRemove: { gaps: [] }, gapRemoveDirty: true,
  }))), {
    kind: 'gap_remove', label: '空隙移除', gapRemove: { gaps: [] }, gapRemoveDirty: true,
  });
});


test('translates editor project controls and dynamic save messages to English', () => {
  assert.equal(i18n.translateText('保存工程', 'en'), 'Save project');
  assert.equal(i18n.translateText('自动打开上次工程', 'en'), 'Automatically open last project');
  assert.equal(i18n.translateText('上次打开：demo.json', 'en'), 'Last opened: demo.json');
  assert.equal(i18n.translateText('已加载媒体：synthetic.wav', 'en'), 'Media loaded: synthetic.wav');
  assert.equal(i18n.translateText('保存成功！', 'en'), 'Saved!');
  assert.equal(i18n.translateText('字幕忍者', 'en'), 'Subtitle Ninja');
  assert.equal(i18n.translateText('显示刀光特效', 'en'), 'Show slash effect');
  assert.equal(i18n.translateText('字幕大小', 'en'), 'Font size');
  assert.equal(i18n.translateText('字幕预览设置', 'en'), 'Subtitle preview settings');
  assert.equal(i18n.translateText('交换主副字幕', 'en'), 'Swap main and secondary subtitles');
  assert.equal(i18n.translateText('主字幕 1', 'en'), 'Main subtitle 1');
  assert.equal(i18n.translateText('副字幕 1', 'en'), 'Secondary subtitle 1');
 assert.equal(
    i18n.translateText('已交换主副字幕：主轨 2 条，副轨 3 条', 'en'),
    'Swapped main and extension subtitles: 2 main, 3 extension',
  );
  assert.equal(
    i18n.translateText('已替换主字幕 1 的绑定，改为扩展字幕 2', 'en'),
    'Replaced the binding for main subtitle 1 with extension subtitle 2',
  );
  assert.equal(i18n.translateText('保存工程', 'zh'), '保存工程');
});


test('translates adjacent adjustment and current-cue operation settings to English', () => {
  assert.equal(i18n.translateText('字幕时间调整', 'en'), 'Subtitle timing adjustment');
  assert.equal(i18n.translateText('自动吸附调整相邻字幕', 'en'), 'Automatically snap-adjust adjacent subtitles');
  assert.equal(
    i18n.translateText('开启后，拖动或微调同轨相邻字幕时默认保持联动；按住 Alt 临时解除。关闭后默认独立调整；按住 Alt 临时联动', 'en'),
    'When enabled, dragging or fine-tuning adjacent cues on the same track links them by default; hold Alt to temporarily separate them. When disabled, they adjust independently by default; hold Alt to temporarily link them.',
  );
  assert.equal(
    i18n.translateText('开启后，按 Esc 会恢复当前字幕编辑前的文本；关闭后按 Esc 保留文本改动并退出编辑', 'en'),
    'When enabled, Esc restores the text from before editing; when disabled, Esc keeps text changes and exits editing.',
  );
  assert.equal(
    i18n.translateText('关闭后按 Esc 保留文本改动；开启后恢复编辑前的文本。', 'en'),
    'When disabled, Esc keeps text changes; when enabled, it restores the text from before editing.',
  );
});

test('translates OTIOZ export labels, mode hints and dynamic messages to English', () => {
  assert.equal(i18n.translateText('表情包 OTIOZ', 'en'), 'Sticker OTIOZ');
  assert.equal(i18n.translateText('下载表情包 OTIOZ 工程', 'en'), 'Download sticker OTIOZ project');
  const hint = '服务器打包模式不可用：请以 server-editor 打开并绑定工程文件后再导出 OTIOZ';
  assert.equal(
    i18n.translateText(hint, 'en'),
    'Server packaging is unavailable: open the project via server-editor and bind a project file before exporting OTIOZ',
  );
  assert.equal(
    i18n.translateText(`当前模式不可用：${hint}`, 'en'),
    'Unavailable in the current mode: Server packaging is unavailable: open the project via server-editor and bind a project file before exporting OTIOZ',
  );
  assert.equal(
    i18n.translateText('当前工程无法导出表情包 OTIOZ（需要以 server-editor 打开并绑定工程文件）', 'en'),
    'Cannot export sticker OTIOZ here (requires server-editor with a bound project file)',
  );
  assert.equal(i18n.translateText('正在生成表情包 OTIOZ 工程…', 'en'), 'Generating sticker OTIOZ bundle…');
  assert.equal(i18n.translateText('OTIOZ 已生成，图片已打包进 zip', 'en'), 'OTIOZ generated; images are packed into the zip');
  // zh 语言下返回原文
  assert.equal(i18n.translateText('表情包 OTIOZ', 'zh'), '表情包 OTIOZ');
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

test('counts subtitle units according to the configured language type', () => {
  assert.equal(helpers.countSubtitleUnits('Hello, world!', 'word'), 2);
  assert.equal(helpers.countSubtitleUnits('Hello, world!', 'continuous'), 10);
  assert.equal(helpers.countSubtitleUnits('你好，世界。', 'continuous'), 4);
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.cueMetrics('Hello, world!', 0, 1000, 'word'))),
    { totalLength: 2, charsPerSecond: 2 },
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

test('absorbs a short subtitle when it is directly adjacent with a zero gap', () => {
  const segments = [
    { start: 0, end: 1000, text: '这是个短' },
    { start: 1000, end: 2000, text: '字幕' },
  ];
  const plan = JSON.parse(JSON.stringify(helpers.planAutoMerge(segments, { gapMs: 200, shortCount: 3 })));
  assert.deepEqual(plan.groups, [[0, 1]]);
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

test('extends all subtitles in two phases and keeps items at absolute times', () => {
  const segments = [
    { start: 0, end: 1000, text: '第一句', items: [{ text: '一', start: 200, end: 500 }] },
    { start: 1200, end: 2000, text: '第二句', items: [{ text: '二', start: 1300, end: 1600 }] },
    { start: 2300, end: 3000, text: '第三句', items: [{ text: '三', start: 2400, end: 2600 }] },
  ];
  const originalItems = JSON.parse(JSON.stringify(segments.map((segment) => segment.items)));
  const plan = helpers.applySubtitleExtension(segments, [], {
    forwardMs: 250,
    backwardMs: 200,
    durationMs: 3200,
  });
  assert.deepEqual(
    segments.map((segment) => [segment.start, segment.end]),
    [[0, 1000], [1000, 2050], [2050, 3200]],
  );
  assert.deepEqual(segments.map((segment) => segment.items), originalItems);
  assert.deepEqual(Array.from(plan.changedIndices), [1, 2]);
  assert.equal(plan.fullCount, 1);
  assert.equal(plan.partialCount, 1);
  assert.equal(plan.unchangedCount, 1);
});

test('extends only selected subtitles and stops at neighboring boundaries', () => {
  const segments = [
    { start: 0, end: 1000, text: '第一句' },
    { start: 1200, end: 2000, text: '第二句', items: [{ text: '二', start: 1400, end: 1700 }] },
    { start: 2300, end: 3000, text: '第三句' },
  ];
  const originalItems = JSON.parse(JSON.stringify(segments[1].items));
  const plan = helpers.applySubtitleExtension(segments, [1], { forwardMs: 500, backwardMs: 500 });
  assert.deepEqual([segments[1].start, segments[1].end], [1000, 2300]);
  assert.deepEqual([segments[0].start, segments[0].end], [0, 1000]);
  assert.deepEqual([segments[2].start, segments[2].end], [2300, 3000]);
  assert.deepEqual(segments[1].items, originalItems);
  assert.deepEqual(Array.from(plan.changedIndices), [1]);
  assert.equal(plan.fullCount, 0);
  assert.equal(plan.partialCount, 1);
  assert.equal(plan.unchangedCount, 0);
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
  assert.equal(i18n.translateText('拼接/合并字幕', 'en'), 'Join / merge subtitles');
  assert.equal(i18n.translateText('吸附方向', 'en'), 'Snap direction');
  assert.equal(i18n.translateText('没有需要拼合的间隔或过短字幕', 'en'), 'No intervals or short subtitles to snap');
  assert.equal(
    i18n.translateText('没有需要拼接/合并的间隔或过短字幕', 'en'),
    'No intervals or short subtitles to join / merge',
  );
  assert.equal(
    i18n.translateText('已拼合字幕：拼合 2 处间隔，吸收 1 条短字幕', 'en'),
    'Snap subtitles: snapped 2 intervals, absorbed 1 short subtitles',
  );
  assert.equal(
    i18n.translateText('已拼合字幕：吸收 3 条短字幕', 'en'),
    'Snap subtitles: absorbed 3 short subtitles',
  );
  assert.equal(
    i18n.translateText('已拼接/合并字幕：吸附 2 处间隔，吸收 1 条短字幕', 'en'),
    'Join / merge subtitles: snapped 2 intervals, absorbed 1 short subtitles',
  );
  assert.equal(i18n.translateText('延长字幕', 'en'), 'Extend subtitles');
  assert.equal(
    i18n.translateText('已处理 3 个选中字幕：完整延长 1 条，部分延长 1 条，未延长 1 条', 'en'),
    'Processed 3 selected subtitles: 1 fully extended, 1 partially extended, 1 unchanged',
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

test('repairs a one-ms rounded item overlap before persistence', () => {
  const segments = [{
    start: 65000,
    end: 67000,
    text: '非常',
    items: [
      { text: '非', start: 65000, end: 66051 },
      { text: '常', start: 66050, end: 66130 },
    ],
  }];

  const fixed = helpers.normalizeSegmentTimings(segments);

  assert.equal(fixed, 1);
  assert.equal(segments[0].items[1].start, 66051);
});

test('repairs item overlap without hiding a real subtitle-segment overlap', () => {
  const segments = [
    { start: 0, end: 1000, text: '第一句', items: [{ start: 0, end: 600 }] },
    { start: 900, end: 1800, text: '第二句', items: [{ start: 900, end: 1200 }] },
  ];

  const fixed = helpers.normalizeItemTimingRanges(segments);

  assert.equal(fixed, 0);
  assert.deepEqual(segments.map(({ start, end }) => [start, end]), [[0, 1000], [900, 1800]]);
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

test('prefers the later subtitle at a shared playhead boundary', () => {
  const segments = [
    { start: 1000, end: 2000 },
    { start: 2000, end: 3000 },
    { start: 4000, end: 5000 },
  ];

  assert.equal(helpers.findCueNavigationTarget(segments, -1, 2000, -1), 0);
  assert.equal(helpers.findCueNavigationTarget(segments, -1, 2000, 1), 2);
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

test('characterizes removed-gap mapping and sticker inheritance without mutation', () => {
  const gaps = [
    { start: 1000, end: 1600, removed: true },
    { start: 2400, end: 3000, removed: false },
    { start: 4000, end: 4500, removed: true },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.getRemovedGapRanges(gaps))), [
    { start: 1000, end: 1600 },
    { start: 4000, end: 4500 },
  ]);
  const segments = [
    { sticker: { name: 'head', path: 'head.png' } },
    { sticker_ref: { name: 'head', headIdx: 0 } },
  ];
  const before = JSON.stringify(segments);
  const inherited = helpers.resolveMergedGroupInheritance(segments, [1], 'sticker', 'sticker_ref');
  assert.deepEqual(JSON.parse(JSON.stringify(inherited.ref)), segments[1].sticker_ref);
  inherited.ref.name = 'changed';
  assert.equal(JSON.stringify(segments), before);
});

test('builds an immutable gap-removed export plan with cue and sticker projection', () => {
  const project = {
    media: { path: 'C:\\Media\\测试 & take.mp4', type: 'video', durationMs: 6000 },
    gaps: [
      { start: 1000, end: 1600, removed: true },
      { start: 4000, end: 4500, removed: true },
    ],
    segments: [
      { id: 'a', start: 700, end: 950, text: 'before', sticker: { name: 's', path: 's.png' } },
       { id: 'b', start: 1200, end: 1800, text: 'crossing', sticker_ref: { name: 'wrong', headIdx: 0 } },
      { id: 'c', start: 1300, end: 1500, text: 'removed', sticker_ref: { name: 's', headIdx: 0 } },
      { id: 'd', start: 2000, end: 2200, text: 'disabled', disabled: true },
      { id: 'e', start: 4700, end: 5200, text: 'after', sticker_ref: { name: 's', headIdx: 0 } },
      { id: 'f', start: 2500, end: 2600, text: 'dangling', sticker_ref: { name: 'bad', headIdx: 99 } },
    ],
    multi_subtitle: { enabled: true, tracks: [{ id: 'translation', segments: [
      { id: 'x', start: 2100, end: 2300, text: '副轨' },
      { id: 'y', start: 4100, end: 4700, text: 'disabled extension', disabled: true },
    ] }] },
  };
  const snapshot = JSON.stringify(project);
  const plan = helpers.buildProjectExportPlan(project, {
    mode: 'gap_removed', fps: '30000/1001', dropFrame: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(plan.keptIntervals)), [
    { start: 0, end: 1000 }, { start: 1600, end: 4000 }, { start: 4500, end: 6000 },
  ]);
  assert.equal(plan.outputDurationMs, 4900);
  assert.equal(plan.mapSourceToOutput(5000), 3900);
  const serializedPlan = JSON.parse(JSON.stringify(plan));
  assert.equal(helpers.mapExportTime(serializedPlan.mapping, 5000), 3900);
  assert.equal(helpers.exportPolicyMsToFrames(serializedPlan.framePolicy, 1001), 30);
  assert.deepEqual(plan.cues.main.map((cue) => cue.id), ['a', 'b', 'e', 'f']);
  assert.deepEqual(plan.cues.extension.map((cue) => cue.id), ['x']);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.cues.extension.map((cue) => [cue.startMs, cue.endMs]))), [[1500, 1700]]);
  const disabledExtension = helpers.buildProjectExportPlan({
    ...project, multi_subtitle: { ...project.multi_subtitle, enabled: false },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(disabledExtension.cues.extension)), []);
  assert.ok(plan.cues.main.find((cue) => cue.id === 'b').endMs > plan.cues.main.find((cue) => cue.id === 'b').startMs);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.stickers.map((sticker) => sticker.headIndex))), [0, 1, 4]);
  assert.ok(plan.warnings.some((warning) => warning.code === 'dangling_sticker_reference'));
  assert.ok(plan.warnings.some((warning) => warning.code === 'stale_sticker_reference'));
  assert.equal(JSON.stringify(project), snapshot);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.keptIntervals), true);
  project.gaps[0].start = 0;
  assert.equal(plan.mapSourceToOutput(1400), 1000);
});

test('consumes schema-shaped media, duration, gap_remove, and sticker resources', () => {
  const plan = helpers.buildProjectExportPlan({
    media: 'fixture.mp4',
    waveform: { duration_ms: 6000 },
    gap_remove: { gaps: [{ start: 1000, end: 1600, removed: true }] },
    segments: [{ id: 'head', start: 0, end: 900, sticker: {
      name: 'schema-sticker', rel: 'nested/sticker.png', filename: 'sticker.png', start: 100, end: 800,
    } }],
  });
  assert.equal(plan.media.path, 'fixture.mp4');
  assert.equal(plan.sourceDurationMs, 6000);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.keptIntervals)), [
    { start: 0, end: 1000 }, { start: 1600, end: 6000 },
  ]);
  assert.equal(plan.stickers[0].path, 'nested/sticker.png');
});

test('omits malformed cue timings without coercion', () => {
  const plan = helpers.buildProjectExportPlan({
    media: 'fixture.mp4', duration_ms: 1000,
    segments: [
      { id: 'string', start: '0', end: 100 },
      { id: 'fraction', start: 100, end: 100.5 },
      { id: 'negative', start: -1, end: 200 },
      { id: 'inverted', start: 300, end: 200 },
      { id: 'good', start: 400, end: 500 },
    ],
  }, { mode: 'gap_removed' });
  assert.deepEqual(plan.cues.main.map((cue) => cue.id), ['good']);
  assert.equal(plan.warnings.filter((warning) => warning.code === 'invalid_cue').length, 4);
});

test('uses sticker bounds when present and reports self references and empty exports', () => {
  const project = {
    media: { path: 'fixture.mp4', durationMs: 3000 },
    gaps: [{ start: 1000, end: 2000, removed: true }],
    segments: [
      { start: 0, end: 3000, sticker: { name: 'bounded', path: 's.png', start: 2200, end: 2800 } },
      { start: 0, end: 500, sticker: { name: 'self', path: 'self.png' }, sticker_ref: { headIdx: 1 } },
      { start: 0, end: 500, disabled: true },
    ],
  };
  const plan = helpers.buildProjectExportPlan(project);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.stickers.map(({ sourceStartMs, sourceEndMs }) => [sourceStartMs, sourceEndMs]))), [[2200, 2800]]);
  assert.ok(plan.warnings.some((warning) => warning.code === 'dangling_sticker_reference'));

  const disabled = helpers.buildProjectExportPlan({
    media: { path: 'fixture.mp4', durationMs: 3000 },
    gaps: [{ start: 1000, end: 2000, removed: true }],
    segments: [{ start: 0, end: 500, disabled: true }],
  });
  assert.ok(disabled.warnings.some((warning) => warning.code === 'no_enabled_cues'));
});

test('omits disabled sticker heads and their references, including all-disabled projects', () => {
  const project = {
    media: { path: 'fixture.mp4', durationMs: 2000 },
    segments: [
      { start: 0, end: 500, disabled: true, sticker: { path: 'disabled.png' } },
      { start: 500, end: 1000, sticker_ref: { headIdx: 0 } },
    ],
  };
  const plan = helpers.buildProjectExportPlan(project, { mode: 'source' });
  assert.deepEqual(JSON.parse(JSON.stringify(plan.stickers)), []);
  assert.ok(plan.warnings.some((warning) => warning.code === 'dangling_sticker_reference'));
  const allDisabled = helpers.buildProjectExportPlan({
    media: { path: 'fixture.mp4', durationMs: 2000 },
    segments: [{ start: 0, end: 500, disabled: true, sticker: { path: 'disabled.png' } }],
  }, { mode: 'source' });
  assert.equal(allDisabled.stickers.length, 0);
});

test('uses exact fractional frame profiles and rejects drop-frame requests', () => {
  for (const fps of [24, 25, 30, 50, 60, '30000/1001', '60000/1001']) {
    assert.equal(helpers.resolveExportFrameProfile(fps).name, String(fps));
  }
  assert.equal(helpers.exportMsToFrames(1001, '30000/1001', 'floor'), 30);
  assert.equal(helpers.exportMsToFrames(1001, '30000/1001', 'ceil'), 30);
  assert.equal(helpers.exportMsToFrames(41, 24, 'ceil'), 1);
  assert.throws(() => helpers.resolveExportFrameProfile('30000/1001', true), /drop-frame/);
  assert.throws(() => helpers.resolveExportFrameProfile(29.97, false), /unsupported/);
});

test('rejects malformed export inputs and unknown options explicitly', () => {
  const base = { media: { path: 'fixture.mp4', durationMs: 1000 }, segments: [] };
  assert.throws(() => helpers.buildProjectExportPlan({ ...base, media: { durationMs: 1000 } }), /missing export media path/);
  assert.throws(() => helpers.buildProjectExportPlan({ ...base, media: { path: 'x', durationMs: 0 } }), /missing export media duration/);
  assert.throws(() => helpers.buildProjectExportPlan({ ...base, gaps: [{ start: 500, end: 400 }] }), /invalid export gap interval/);
  assert.throws(() => helpers.buildProjectExportPlan({ ...base, gaps: [{ start: '1', end: 2 }] }), /invalid export gap interval/);
  assert.throws(() => helpers.buildProjectExportPlan({ ...base, gaps: [{ start: 1.5, end: 2 }] }), /invalid export gap interval/);
  assert.throws(() => helpers.buildProjectExportPlan({ ...base, gaps: [{ start: -1, end: 2 }] }), /invalid export gap interval/);
  assert.throws(() => helpers.buildProjectExportPlan({ ...base, gaps: 'bad' }), /invalid export gaps/);
  assert.throws(() => helpers.buildProjectExportPlan({ ...base, gaps: [{ start: 1, end: 2 }] }, { mode: 'unknown' }), /unsupported export mode/);
  assert.throws(() => helpers.buildProjectExportPlan(base, { dropFrame: 'false' }), /must be boolean/);
  assert.ok(helpers.buildProjectExportPlan(base).warnings.some((warning) => warning.code === 'no_removed_gaps'));
});

test('baseline export plan keeps Todo 2 defaults and source path content', () => {
  const project = {
    media: 'C:\\fixtures\\baseline take.mp4',
    waveform: { duration_ms: 1000 },
    segments: [],
  };
  const plan = helpers.buildProjectExportPlan(project);
  assert.equal(plan.mode, 'gap_removed');
  assert.equal(plan.frameProfile.name, '30');
  assert.equal(plan.media.path, project.media);
  assert.equal(plan.framePolicy.dropFrame, false);
});

test('defines a portable export-options contract from synthetic fixture data', () => {
  const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'export');
  const fixturePaths = ['synthetic-windows.mosp', 'synthetic-posix.mosp'].map((name) => path.join(fixtureRoot, name));
  assert.deepEqual(fixturePaths.map((fixturePath) => fs.existsSync(fixturePath)), [true, true]);
  const options = helpers.normalizeExportOptions({
    timelineMode: 'gap_removed', fps: '30000/1001', subtitleTracks: 'main',
    baseName: '测试-take',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(options)), JSON.parse(fs.readFileSync(
    path.join(fixtureRoot, 'expected-options.json'), 'utf8',
  )));
  assert.equal(options.nativeTextObjects, false);
  assert.equal(options.dropFrame, false);
  fixturePaths.forEach((fixturePath, index) => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const plan = helpers.buildProjectExportPlan(fixture, options);
    assert.equal(plan.media.path, fixture.media);
    assert.equal(plan.outputDurationMs, index === 0 ? 4900 : 6000);
    assert.equal(plan.stickers.length, 1);
  });
  assert.equal(Object.isFrozen(options), true);
});

test('normalizes closed FPS and track choices without guessing unsupported values', () => {
  for (const fps of [24, 25, 30, 50, 60, '30000/1001', '60000/1001']) {
    assert.equal(helpers.normalizeExportOptions({ fps }).fps, String(fps));
  }
  assert.equal(helpers.normalizeExportOptions({ subtitleTracks: 'main_and_extension' }).subtitleTracks, 'main_and_extension');
  assert.throws(() => helpers.normalizeExportOptions({ fps: 29.97 }), /unsupported export FPS/);
  assert.throws(() => helpers.normalizeExportOptions({ dropFrame: true }), /drop-frame/);
  assert.throws(() => helpers.normalizeExportOptions({ subtitleTracks: 'all' }), /unsupported subtitle tracks/);
  assert.throws(() => helpers.normalizeExportOptions([]), /export options must be an object/);
  assert.throws(() => helpers.normalizeExportOptions({ unknownOption: true }), /unknown export option: unknownOption/);
});

test('sanitizes deterministic names and escapes XML and file URLs', () => {
  const names = helpers.buildExportNames('..\\CON: 测试 / take?.mp4');
  assert.equal(names.baseName, '__CON_ 测试 _ take_');
  assert.deepEqual(JSON.parse(JSON.stringify(names.files)), {
    project: '__CON_ 测试 _ take_.xml',
    subtitles: '__CON_ 测试 _ take_.srt',
  });
  assert.ok(!/[\\/\u0000-\u001f]/.test(names.baseName));
  assert.notEqual(names.baseName, '.');
  assert.notEqual(names.baseName, '..');
  for (const reserved of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'con. ', 'AUX...']) {
    const safe = helpers.buildExportNames(reserved).baseName;
    assert.notEqual(safe.toUpperCase(), reserved.trim().toUpperCase());
    assert.equal(safe, safe.replace(/[. ]+$/, ''));
    assert.ok(!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:[. ]*)$/i.test(safe));
  }
  assert.equal(helpers.escapeExportXml('a<&>"\''), 'a&lt;&amp;&gt;&quot;&apos;');
  assert.equal(
    helpers.exportPathToFileUrl('C:\\Fixtures\\测试 & take\".mp4'),
    'file://localhost/C:/Fixtures/%E6%B5%8B%E8%AF%95%20%26%20take%22.mp4',
  );
  assert.equal(
    helpers.exportPathToFileUrl('/fixtures/测试 & take.mp4'),
    'file:///fixtures/%E6%B5%8B%E8%AF%95%20%26%20take.mp4',
  );
  assert.equal(
    helpers.exportPathToFileUrl('file://server/share/测试.mp4'),
    'file://server/share/%E6%B5%8B%E8%AF%95.mp4',
  );
  assert.equal(
    helpers.exportPathToFileUrl('\\\\server\\share\\测试.mp4'),
    'file://server/share/%E6%B5%8B%E8%AF%95.mp4',
  );
  assert.throws(() => helpers.exportPathToFileUrl('file://server'), /UNC file URL must include a share/);
});

test('rejects XML 1.0 forbidden controls and preserves allowed whitespace controls', () => {
  for (const codePoint of [0, 8, 11, 12, 14, 31]) {
    assert.throws(() => helpers.escapeExportXml(`bad${String.fromCodePoint(codePoint)}`), /XML 1\.0 forbidden control/);
  }
  assert.equal(helpers.escapeExportXml('tab\tline\nreturn\r'), 'tab\tline\nreturn\r');
});

test('rejects pathless or malformed names before any output ownership is claimed', () => {
  assert.throws(() => helpers.normalizeExportOptions({ baseName: '' }), /base name/);
  assert.throws(() => helpers.normalizeExportOptions({ baseName: '\u0000' }), /base name/);
  assert.throws(() => helpers.normalizeExportOptions({ baseName: '.' }), /base name/);
  assert.throws(() => helpers.exportPathToFileUrl(''), /path/);
});

test('serializes the shared plan as deterministic FCP 7 XML and mapped SRT', () => {
  const plan = helpers.buildProjectExportPlan({
    media: { path: 'C:\\fixtures\\测试 & take.mp4', type: 'video', durationMs: 6000 },
    gaps: [{ start: 1000, end: 1600, removed: true }, { start: 4000, end: 4500, removed: true }],
    segments: [
      { id: 'before', start: 700, end: 950, text: 'A & <B>' },
      { id: 'crossing', start: 1200, end: 1800, text: 'crossing' },
      { id: 'after', start: 4700, end: 5200, text: 'quote " and apostrophe \'', sticker: {
        name: 'sticker', rel: 'icons/测试 & icon.png', start: 4700, end: 5200,
      } },
    ],
  }, { fps: '30000/1001', nativeTextObjects: false });
  const xml = helpers.serializeFcp7Xml(plan, { nativeTextObjects: false });
  const srt = helpers.serializeMappedSrt(plan);
  parseXml(xml);
  assert.equal((xml.match(/<clipitem\b/g) || []).length, 7);
  assert.equal((xml.match(/<generatoritem\b/g) || []).length, 0);
  assert.equal(xmlElements(xml, 'track').length, 3);
  assert.ok(xml.includes('<duration>149</duration>'));
  assert.ok(xml.includes('<in>47</in><out>120</out>'));
  assert.ok(xml.includes('file://localhost/C:/fixtures/%E6%B5%8B%E8%AF%95%20%26%20take.mp4'));
  assert.ok(xml.includes('file:///icons/%E6%B5%8B%E8%AF%95%20%26%20icon.png'));
  assert.deepEqual(parseSrt(srt).map(({ start, end }) => [start, end]), [
    ['00:00:00,700', '00:00:00,950'],
    ['00:00:01,000', '00:00:01,200'],
    ['00:00:03,600', '00:00:04,100'],
  ]);
  assert.equal(helpers.serializeFcp7Xml(plan, { nativeTextObjects: false }), xml);
  assert.equal(helpers.serializeMappedSrt(plan), srt);
});

test('resolves sticker media from sticker_root and emits one clip per subtitle occurrence', () => {
  const plan = helpers.buildProjectExportPlan({
    media: { path: 'C:\\fixtures\\source.mp4', type: 'video', durationMs: 12000 },
    sticker_root: 'E:/素材/表情包',
    segments: [
      {
        id: 'cue-1', start: 1000, end: 2000,
        sticker: { name: '你得死', filename: '你得死.gif', rel: '描边gif/你得死.gif' },
      },
      {
        id: 'cue-2', start: 3000, end: 4000,
        sticker_ref: { name: '你得死', headIdx: 0 },
      },
    ],
  }, { mode: 'source' });
  assert.equal(plan.stickers.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.stickers.map(({ path, startMs, endMs }) => ({ path, startMs, endMs })))), [
    { path: 'E:/素材/表情包/描边gif/你得死.gif', startMs: 1000, endMs: 2000 },
    { path: 'E:/素材/表情包/描边gif/你得死.gif', startMs: 3000, endMs: 4000 },
  ]);
  const xml = helpers.serializeFcp7Xml(plan);
  parseXml(xml);
  assert.equal((xml.match(/<clipitem id="sticker-clip-/g) || []).length, 2);
  assert.equal((xml.match(/<file id="file-sticker-[^"]+">/g) || []).length, 1);
  assert.match(xml, /<pathurl>file:\/\/localhost\/E(?:%3A|:)\/%E7%B4%A0%E6%9D%90\/%E8%A1%A8%E6%83%85%E5%8C%85\/%E6%8F%8F%E8%BE%B9gif\/.+<\/pathurl>/);
  assert.match(xml, /<clipitem id="sticker-clip-1"><masterclipid>master-sticker-1<\/masterclipid><name>[^<]+<\/name><enabled>TRUE<\/enabled><alphatype>straight<\/alphatype><pixelaspectratio>square<\/pixelaspectratio>/);
  assert.match(xml, /<file id="file-sticker-[^"]+">[\s\S]*?<timecode><rate><timebase>30\/1<\/timebase><ntsc>FALSE<\/ntsc><\/rate><string>00:00:00:00<\/string><frame>0<\/frame><displayformat>NDF<\/displayformat><\/timecode>[\s\S]*?<media><video><samplecharacteristics>[\s\S]*?<width>720<\/width><height>480<\/height>/);
  assert.match(xml, /<clipitem id="sticker-clip-1">[\s\S]*?<start>30<\/start><end>60<\/end>/);
  assert.match(xml, /<clipitem id="sticker-clip-2">[\s\S]*?<start>90<\/start><end>120<\/end>/);
});

test('preserves supplied sticker dimensions in FCP7 media metadata', () => {
  const project = {
    media: { path: 'fixture.mp4', type: 'video', durationMs: 1000 },
    gaps: [],
    sticker_root: 'E:/素材/表情包',
    segments: [{ start: 0, end: 1000, text: '问号', sticker: {
      name: '超多疑问-黑', filename: '超多疑问-黑.jpg', rel: '超多疑问-黑.jpg',
      width: 1920, height: 1080, start: 0, end: 1000,
    } }],
  };
  const plan = helpers.buildProjectExportPlan(project, { timelineMode: 'source', fps: 30 });
  const xml = helpers.serializeFcp7Xml(plan);
  assert.match(xml, /<width>1920<\/width><height>1080<\/height>/);
  assert.doesNotMatch(xml, /<width>720<\/width><height>480<\/height>/);
});

test('keeps FCP7 sticker source range equal to its timeline range', () => {
  const project = {
    media: { path: 'fixture.mp4', type: 'video', durationMs: 1001 }, gaps: [], sticker_root: 'E:/素材/表情包',
    segments: [{ start: 101, end: 901, text: '问号', sticker: {
      name: '超多疑问-黑', filename: '超多疑问-黑.jpg', rel: '超多疑问-黑.jpg', width: 1920, height: 1080,
      start: 101, end: 901,
    } }],
  };
  const plan = helpers.buildProjectExportPlan(project, { timelineMode: 'source', fps: 30 });
  const xml = helpers.serializeFcp7Xml(plan);
  const sticker = xml.match(/<clipitem id="sticker-clip-1">[\s\S]*?<duration>(\d+)<\/duration>[\s\S]*?<start>(\d+)<\/start><end>(\d+)<\/end>[\s\S]*?<in>(\d+)<\/in><out>(\d+)<\/out>/);
  assert.ok(sticker, 'sticker clip should be serialized');
  assert.equal(Number(sticker[1]), Number(sticker[3]) - Number(sticker[2]));
  assert.equal(Number(sticker[1]), Number(sticker[5]) - Number(sticker[4]));
});

test('declares two-channel video source audio for linked FCP7 media', () => {
  const plan = helpers.buildProjectExportPlan({
    media: { path: 'C:\\fixtures\\stereo.mp4', type: 'video', durationMs: 1000 },
    segments: [{ id: 'cue', start: 100, end: 400, text: 'stereo source' }],
  }, { mode: 'source' });
  const xml = helpers.serializeFcp7Xml(plan);
  parseXml(xml);
  const videoFile = /<file id="file-source-video-1">[\s\S]*?<\/file>/.exec(xml)?.[0];
  const audioFile = /<file id="file-source-audio">[\s\S]*?<\/file>/.exec(xml)?.[0];
  assert.ok(videoFile);
  assert.ok(audioFile);
  assert.match(videoFile, /<audio><duration>30<\/duration><channelcount>2<\/channelcount><\/audio>/);
  assert.match(audioFile, /<audio><duration>30<\/duration><channelcount>2<\/channelcount><\/audio>/);
  assert.deepEqual(parseXmlFileAudio(xml).filter(({ id }) => id.startsWith('file-source-')), [
    { id: 'file-source-video-1', channelcount: '2' },
    { id: 'file-source-audio', channelcount: '2' },
  ]);
  assert.match(xml, /<clipitem id="audio-clip-1">[\s\S]*?<sourcetrack><mediatype>audio<\/mediatype><trackindex>1<\/trackindex><channel>1<\/channel><channelcount>2<\/channelcount><\/sourcetrack>[\s\S]*?<link><linkclipref>video-clip-1<\/linkclipref><mediatype>audio<\/mediatype><trackindex>1<\/trackindex>/);
});

test('emits visible GraphicAndType text clips and omits video for audio-only plans', () => {
  const audioPlan = helpers.buildProjectExportPlan({
    media: { path: '/fixtures/audio.wav', type: 'audio', durationMs: 1000 },
    segments: [{ id: 'cue', start: 100, end: 400, text: 'Audio cue' }],
  }, { mode: 'source', fps: 30 });
  const xml = helpers.serializeFcp7Xml(audioPlan, { nativeTextObjects: true });
  parseXml(xml);
  assert.equal((xml.match(/<track>/g) || []).length, 1);
  assert.equal((xml.match(/<clipitem\b/g) || []).length, 1);
  assert.equal((xml.match(/<generatoritem\b/g) || []).length, 0);
  assert.doesNotMatch(xml, /<video>/);
  const videoPlan = helpers.buildProjectExportPlan({
    media: { path: 'fixture.mp4', type: 'video', durationMs: 1000 },
    segments: [{ id: 'cue', start: 100, end: 400, text: 'Video cue' }],
  }, { mode: 'source', fps: 30 });
  const videoXml = helpers.serializeFcp7Xml(videoPlan, { nativeTextObjects: true });
  assert.equal((videoXml.match(/<generatoritem\b/g) || []).length, 0);
  assert.match(videoXml, /<clipitem id="text-main-1">[\s\S]*?<effectid>GraphicAndType<\/effectid>[\s\S]*?<parameterid>1<\/parameterid>[\s\S]*?<value>[A-Za-z0-9+/=]+<\/value>/);
  assert.match(videoXml, /<mediaSource>GraphicAndType<\/mediaSource>/);
});

test('encodes native GraphicAndType text as Premiere UTF-16LE payload', () => {
  const plan = helpers.buildProjectExportPlan({
    media: { path: 'fixture.mp4', type: 'video', durationMs: 1000 },
    segments: [{ id: 'cue', start: 100, end: 400, text: 'TETe 改名' }],
  }, { mode: 'source', fps: 30 });
  const xml = helpers.serializeFcp7Xml(plan, { nativeTextObjects: true });
  const encoded = /<parameterid>1<\/parameterid>[\s\S]*?<value>([^<]+)<\/value>/.exec(xml)?.[1];
  assert.ok(encoded);
  const bytes = Buffer.from(encoded, 'base64');
  assert.equal(bytes[0], 0xf6);
  assert.deepEqual([...bytes.subarray(1, 8)], [10, 0, 0, 0, 0, 0, 0]);
  const payload = JSON.parse(bytes.subarray(8).toString('utf16le'));
  assert.equal(payload.mTextParam.mStyleSheet.mText, 'TETe 改名');
  assert.equal(payload.mVersion, 1);
});

test('writes the preview subtitle font into the GraphicAndType payload', () => {
  const plan = helpers.buildProjectExportPlan({
    media: { path: 'fixture.mp4', type: 'video', durationMs: 1000 },
    preview: { subtitle: { font_family: 'song' } },
    segments: [{ id: 'cue', start: 100, end: 400, text: '字体' }],
  }, { mode: 'source', fps: 30 });
  const xml = helpers.serializeFcp7Xml(plan, { nativeTextObjects: true });
  const encoded = /<parameterid>1<\/parameterid>[\s\S]*?<value>([^<]+)<\/value>/.exec(xml)?.[1];
  const bytes = Buffer.from(encoded, 'base64');
  const payload = JSON.parse(bytes.subarray(8).toString('utf16le'));
  assert.equal(payload.mTextParam.mStyleSheet.mFontName.mParamValues[0][1], 'FangSong');
});

test('selects main, extension, and both subtitle tracks in XML and SRT', () => {
  const plan = helpers.buildProjectExportPlan({
    media: { path: 'fixture.mp4', type: 'video', durationMs: 1000 },
    segments: [{ start: 100, end: 300, text: 'main' }],
    multi_subtitle: { enabled: true, tracks: [{ segments: [{ start: 400, end: 700, text: 'extension' }] }] },
  }, { mode: 'source' });
  for (const subtitleTracks of ['main', 'main_and_extension']) {
    const xml = helpers.serializeFcp7Xml(plan, { subtitleTracks, nativeTextObjects: true });
    const srt = helpers.serializeMappedSrt(plan, { subtitleTracks });
    assert.equal((xml.match(/<clipitem id="text-/g) || []).length, subtitleTracks === 'main' ? 1 : 2);
    assert.equal(parseSrt(srt).length, subtitleTracks === 'main' ? 1 : 2);
  }
});

test('reports malformed intervals, missing sticker paths, and stale serializer warnings', () => {
  const plan = helpers.buildProjectExportPlan({
    media: { path: 'fixture.mp4', type: 'video', durationMs: 1000 },
    gaps: [{ start: 100, end: 200, removed: true }],
    segments: [
      { start: 100, end: 100, text: 'empty' },
      { start: 250, end: 300, text: 'missing sticker', sticker: { name: 'missing', start: 250, end: 300 } },
    ],
  });
  assert.ok(plan.warnings.some((warning) => warning.code === 'invalid_cue'));
  assert.ok(plan.warnings.some((warning) => warning.code === 'missing_sticker_path'));
  assert.throws(() => helpers.serializeFcp7Xml({ ...plan, keptIntervals: [{ start: 0, end: 0 }] }), /empty export interval/);
});

test('clamps gap-removed cues and stickers to source duration before serialization', () => {
  const plan = helpers.buildProjectExportPlan({
    media: { path: 'fixture.mp4', type: 'video', durationMs: 1000 },
    gaps: [{ start: 200, end: 300, removed: true }, { start: 700, end: 800, removed: true }],
    segments: [
      { start: 900, end: 5000, text: 'outside', sticker: { path: 's.png', start: 900, end: 5000 } },
    ],
  }, { fps: 30 });
  assert.equal(plan.cues.main[0].sourceEndMs, 1000);
  assert.equal(plan.stickers[0].sourceEndMs, 1000);
  assert.ok(plan.warnings.some((warning) => warning.code === 'clamped_cue_to_duration'));
  assert.ok(plan.warnings.some((warning) => warning.code === 'clamped_sticker_to_duration'));
  const xml = helpers.serializeFcp7Xml(plan, { nativeTextObjects: true });
  const sequenceDuration = Number(/<sequence id="MAW-sequence">[\s\S]*?<duration>(\d+)<\/duration>/.exec(xml)[1]);
  for (const match of xml.matchAll(/<(?:clipitem|generatoritem)[^>]*>[\s\S]*?<start>(\d+)<\/start><end>(\d+)<\/end>/g)) {
    assert.ok(Number(match[2]) <= sequenceDuration);
  }
});

test('resolves every source video and audio file reference to one definition', () => {
  const plan = helpers.buildProjectExportPlan({
    media: { path: 'fixture.mp4', type: 'video', durationMs: 1000 },
    gaps: [{ start: 200, end: 300, removed: true }],
    segments: [
      { start: 0, end: 200, sticker: { path: 'one.png' } },
      { start: 300, end: 600, sticker: { path: 'two.png' } },
    ],
  });
  const xml = helpers.serializeFcp7Xml(plan);
  const sourceVideoRefs = [...xml.matchAll(/<clipitem id="video-clip-\d+">[\s\S]*?<file id="([^"]+)"/g)].map((match) => match[1]);
  const sourceAudioRefs = [...xml.matchAll(/<clipitem id="audio-clip-\d+">[\s\S]*?<file id="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(sourceVideoRefs.length > 1);
  assert.deepEqual(new Set(sourceVideoRefs), new Set(['file-source-video-1']));
  assert.deepEqual(new Set(sourceAudioRefs), new Set(['file-source-audio']));
  assert.equal((xml.match(/<file id="file-source-video-1"><name>/g) || []).length, 1);
  assert.equal((xml.match(/<file id="file-source-audio"><name>/g) || []).length, 1);
  assert.match(xml, /<clipitem id="video-clip-1">[\s\S]*?<in>0<\/in><out>6<\/out>/);
  assert.match(xml, /<clipitem id="video-clip-2">[\s\S]*?<in>9<\/in><out>30<\/out>/);
  assert.match(xml, /<clipitem id="audio-clip-1">[\s\S]*?<in>0<\/in><out>6<\/out>/);
  assert.match(xml, /<clipitem id="audio-clip-2">[\s\S]*?<in>9<\/in><out>30<\/out>/);
});

test('clamps public export mappings beyond source duration to output duration', () => {
  const plan = helpers.buildProjectExportPlan({
    media: { path: 'fixture.mp4', durationMs: 1000 },
    gaps: [{ start: 200, end: 300, removed: true }], segments: [],
  });
  assert.equal(plan.mapSourceToOutput(5000), plan.outputDurationMs);
  assert.equal(helpers.mapExportTime(plan.mapping, 5000), plan.outputDurationMs);
});

test('rejects unsupported serializer subtitle track values', () => {
  const plan = helpers.buildProjectExportPlan({
    media: { path: 'fixture.mp4', durationMs: 1000 }, segments: [],
  }, { mode: 'source' });
  assert.throws(() => helpers.serializeFcp7Xml(plan, { subtitleTracks: 'invalid' }), /unsupported subtitle tracks/);
  assert.throws(() => helpers.serializeMappedSrt(plan, { subtitleTracks: 'invalid' }), /unsupported subtitle tracks/);
});

test('rejects serializer input that lacks media path, duration, or frame profile', () => {
  assert.throws(() => helpers.serializeFcp7Xml({ media: { type: 'video' } }), /media path/);
  assert.throws(() => helpers.serializeMappedSrt({ cues: { main: [] } }), /media path/);
  const plan = helpers.buildProjectExportPlan({
    media: { path: 'fixture.mp4', type: 'video', durationMs: 1000 }, segments: [],
  }, { mode: 'source' });
  assert.throws(() => helpers.serializeFcp7Xml({ ...plan, frameProfile: null }), /frame profile/);
});

test('translates every project-export option, outcome, and warning key in both locales', () => {
  const keys = [
    '导出时间线模式', '去空隙时间线', '原始时间线', '导出帧率', '写入原生字幕文本对象',
    '导出扩展字幕轨', '主轨字幕', '主轨与扩展轨字幕', '导出文件名', '导出媒体路径缺失',
    '导出媒体时长缺失', '导出文件名无效', '导出警告',
    'Premiere FCP 7 XML（实验性）',
    '实验性 Premiere 交接：导出 FCP 7 XML',
    '导出 FCP 7 XML 供 Premiere 交接。此交接尚未完成目标应用验证。',
    '原生文本仅作为可选交接数据，不承诺样式或位置还原；SRT 可通过独立按钮导出。',
    '导出 XML', 'FCP 7 XML 已保存', 'FCP 7 XML 下载已发起',
    'FCP 7 XML 保存已取消', 'FCP 7 XML 保存失败', 'FCP 7 XML 导出失败',
  ];
  assert.equal(JSON.stringify(i18n.validateTranslationKeys(keys)), JSON.stringify({ zh: [], en: [] }));
  for (const key of keys) assert.equal(i18n.translateText(key, 'zh'), key);
  assert.equal(JSON.stringify(i18n.validateTranslationKeys([...keys, '不存在的 Todo 3 key'])), JSON.stringify({
    zh: ['不存在的 Todo 3 key'], en: ['不存在的 Todo 3 key'],
  }));
});

test('builds XML and SRT artifacts from one shared export plan', async () => {
  // Given: two artifacts derived from one frozen export plan.
  const plan = helpers.buildProjectExportPlan({
    media: { path: 'fixture.mp4', type: 'video', durationMs: 1000 },
    segments: [{ start: 100, end: 400, text: 'shared plan' }],
  }, { mode: 'source' });
  const artifacts = helpers.buildFcp7ExportArtifacts(plan, {
    baseName: 'fixture', nativeTextObjects: false, subtitleTracks: 'main',
  });
  const order = [];

  // When: both browser saves complete.
  const result = await helpers.saveSequentialExportArtifacts(artifacts, async (artifact) => {
    order.push(artifact.kind);
    return { status: 'saved' };
  });

  // Then: XML is first, SRT is second, and both retain the same plan identity.
  assert.deepEqual(order, ['xml', 'srt']);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    xml: 'saved', srt: 'saved', complete: true,
  });
  assert.equal(artifacts[0].plan, plan);
  assert.equal(artifacts[1].plan, plan);
  assert.equal(Object.isFrozen(artifacts), true);
  assert.equal(Object.isFrozen(artifacts[0]), true);
});

test('stops artifact saving after XML cancellation', async () => {
  // Given: an XML-first export pair.
  const artifacts = Object.freeze([
    Object.freeze({ kind: 'xml' }), Object.freeze({ kind: 'srt' }),
  ]);
  let calls = 0;

  // When: the first save is cancelled.
  const result = await helpers.saveSequentialExportArtifacts(artifacts, async () => {
    calls += 1;
    return { status: 'cancelled' };
  });

  // Then: SRT is never requested and is reported as not attempted.
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    xml: 'cancelled', srt: 'not_attempted', complete: false,
  });
});

test('reports second artifact failure without false complete success', async () => {
  // Given: an XML-first export pair and distinct browser outcomes.
  const artifacts = Object.freeze([
    Object.freeze({ kind: 'xml' }), Object.freeze({ kind: 'srt' }),
  ]);
  const outcomes = [{ status: 'saved' }, { status: 'failed' }];

  // When: XML saves and SRT fails.
  const result = await helpers.saveSequentialExportArtifacts(
    artifacts,
    async () => outcomes.shift(),
  );

  // Then: the partial save remains explicit.
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    xml: 'saved', srt: 'failed', complete: false,
  });
});

test('keeps dispatched artifact downloads distinct from confirmed saves', async () => {
  // Given: a browser that can only dispatch anchor downloads.
  const artifacts = Object.freeze([
    Object.freeze({ kind: 'xml' }), Object.freeze({ kind: 'srt' }),
  ]);

  // When: both downloads are dispatched without save confirmation.
  const result = await helpers.saveSequentialExportArtifacts(
    artifacts,
    async () => ({ status: 'dispatched' }),
  );

  // Then: the pair completes, but neither artifact is called saved.
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    xml: 'dispatched', srt: 'dispatched', complete: true,
  });
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


test('distinguishes usable word timestamps from missing or invalid timing data', () => {
  assert.equal(helpers.hasUsableSplitTimestamps({ start: 0, end: 1000, text: '没有时间码' }), false);
  assert.equal(helpers.hasUsableSplitTimestamps({
    start: 0,
    end: 1000,
    text: '有时间码',
    items: [
      { start: 0, end: 450, text: '有时' },
      { start: 550, end: 1000, text: '间码' },
    ],
  }), true);
  assert.equal(helpers.hasUsableSplitTimestamps({
    start: 0,
    end: 1000,
    text: '时间不完整',
    items: [
      { text: '时间' },
      { text: '不完整' },
    ],
  }), false);
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


// === multi-subtitle helpers ===

test('normalizes legacy multi-subtitle data with stable IDs and preserves optional extension items', () => {
  const project = {
    segments: [{ start: 0, end: 1000, text: '主' }],
    multi_subtitle: {
      enabled: true,
      tracks: [{
        id: 'translation',
        segments: [{ start: 40, end: 960, text: 'extension', items: [{ start: 40, end: 960 }] }],
      }],
      bindings: [],
    },
  };
  helpers.normalizeMultiSubtitleProject(project);
  assert.equal(project.segments[0].id, 'main-001');
  assert.equal(project.multi_subtitle.tracks[0].segments[0].id, 'translation-segment-001');
  assert.deepEqual(JSON.parse(JSON.stringify(project.multi_subtitle.tracks[0].segments[0].items)), [
    { start: 40, end: 960 },
  ]);
  assert.equal(project.multi_subtitle.display_mode, 'both');
  assert.equal(project.multi_subtitle.main_split_mode, 'continuous');
});


test('browser ID repair reserves later explicit IDs like the server contract', () => {
  const project = {
    segments: [
      { start: 0, end: 1000, text: 'generated' },
      { id: 'main-001', start: 1000, end: 2000, text: 'explicit' },
      { start: 2000, end: 3000, text: 'next' },
    ],
  };

  helpers.normalizeMultiSubtitleProject(project);

  assert.deepEqual(project.segments.map((segment) => segment.id), [
    'main-001-generated', 'main-001', 'main-003',
  ]);
});


test('swaps main and extension subtitle tracks and rewrites binding offsets', () => {
  const project = {
    segments: [{
      id: 'main-001', start: 0, end: 1000, text: 'English',
      items: [{ start: 0, end: 1000, text: 'English' }],
    }],
    multi_subtitle: {
      enabled: true,
      main_split_mode: 'word',
      tracks: [{
        id: 'translation',
        split_mode: 'continuous',
        segments: [{
          id: 'translation-001', start: 40, end: 960, text: '中文',
          items: [{ start: 40, end: 960, text: '中文' }],
        }],
      }],
      bindings: [{
        id: 'binding-001', track_id: 'translation',
        main_segment_ids: ['main-001'], extension_segment_ids: ['translation-001'],
        start_offset_ms: 40, end_offset_ms: -40,
      }],
    },
  };

  const result = helpers.swapMainAndExtensionSubtitle(project, 'translation');
  assert.equal(result.swapped, true);
  assert.equal(project.segments[0].text, '中文');
  assert.deepEqual(JSON.parse(JSON.stringify(project.segments[0].items)), [
    { start: 40, end: 960, text: '中文' },
  ]);
  assert.equal(project.multi_subtitle.tracks[0].segments[0].text, 'English');
  assert.deepEqual(JSON.parse(JSON.stringify(project.multi_subtitle.tracks[0].segments[0].items)), [
    { start: 0, end: 1000, text: 'English' },
  ]);
  assert.equal(project.multi_subtitle.main_split_mode, 'continuous');
  assert.equal(project.multi_subtitle.tracks[0].split_mode, 'word');
  assert.deepEqual([...project.multi_subtitle.bindings[0].main_segment_ids], ['translation-001']);
  assert.deepEqual([...project.multi_subtitle.bindings[0].extension_segment_ids], ['main-001']);
  assert.equal(project.multi_subtitle.bindings[0].start_offset_ms, -40);
  assert.equal(project.multi_subtitle.bindings[0].end_offset_ms, 40);

  const secondResult = helpers.swapMainAndExtensionSubtitle(project, 'translation');
  assert.equal(secondResult.swapped, true);
  assert.deepEqual(JSON.parse(JSON.stringify(project.segments)), [{
    id: 'main-001', start: 0, end: 1000, text: 'English',
    items: [{ start: 0, end: 1000, text: 'English' }],
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(project.multi_subtitle.tracks[0].segments)), [{
    id: 'translation-001', start: 40, end: 960, text: '中文',
    items: [{ start: 40, end: 960, text: '中文' }],
  }]);
});


test('matches extension cues within the 300ms tolerance and reports unmatched cues', () => {
  const result = helpers.matchSubtitleSegments(
    [
      { start: 0, end: 1000 },
      { start: 1100, end: 2100 },
    ],
    [
      { start: 250, end: 900 },
      { start: 1120, end: 2080 },
      { start: 2500, end: 3000 },
    ],
    300,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result.matches)), [
    { mainIndex: 1, extensionIndex: 1, startDiff: 20, endDiff: 20, cost: 40 },
    { mainIndex: 0, extensionIndex: 0, startDiff: 250, endDiff: 100, cost: 350 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.unmatchedExtension)), [2]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.unmatchedMain)), []);
  assert.equal(result.tolerance_ms, 300);
});


test('uses character boundaries for continuous text and protects words for word text', () => {
  assert.ok(helpers.splitSubtitleText('这是一句字幕', 3, 'continuous'));
  assert.equal(helpers.splitSubtitleText('split a word', 9, 'word'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.subtitleSplitOffsets('A B', 'continuous'))), [2]);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.subtitleSplitOffsets('A  B', 'continuous'))), [3]);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.subtitleSplitOffsets('你好，世界。', 'continuous'))), [1, 2, 3, 4]);
  assert.equal(helpers.splitSubtitleText('你好，世界。', 5, 'continuous'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.subtitleSplitOffsets('A B', 'word'))), [2]);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.subtitleSplitOffsets('split a, sentence', 'word'))), [6, 9]);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.subtitleSplitOffsets('the story—you', 'word'))), [4, 9, 10]);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.splitSubtitleText('the story—you', 9, 'word'))), {
    left: 'the story', right: '—you', offset: 9,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.splitSubtitleText('the story—you', 10, 'word'))), {
    left: 'the story—', right: 'you', offset: 10,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.subtitleSplitOffsets('quickly.And', 'word'))), [8]);
  assert.equal(helpers.splitSubtitleText('quickly.And', 7, 'word'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.splitSubtitleText('quickly.And', 8, 'word'))), {
    left: 'quickly.', right: 'And', offset: 8,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.subtitleSplitOffsets('3.14', 'word'))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.subtitleSplitOffsets('U.S.', 'word'))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.subtitleSplitOffsets("don't", 'word'))), []);
  const parts = helpers.splitSubtitleText('split a, sentence', 6, 'word');
  assert.deepEqual(JSON.parse(JSON.stringify(parts)), {
    left: 'split', right: 'a, sentence', offset: 6,
  });
});


test('cleans punctuation and whitespace at a linked split point', () => {
  const parts = helpers.cleanSplitTextParts('这是一句。它是这样', 4);
  assert.deepEqual(JSON.parse(JSON.stringify(parts)), {
    left: '这是一句', right: '它是这样', offset: 4,
  });
});


test('builds bindings with offsets and aligns bound/unbound dual display rows', () => {
  const main = [
    { id: 'm1', start: 0, end: 1000 },
    { id: 'm2', start: 2000, end: 3000 },
  ];
  const extension = [
    { id: 'e1', start: 50, end: 950 },
    { id: 'e2', start: 1300, end: 1800 },
  ];
  const binding = helpers.buildSubtitleBinding(main[0], extension[0], 'translation');
  assert.equal(binding.start_offset_ms, 50);
  assert.equal(binding.end_offset_ms, -50);
  assert.deepEqual(JSON.parse(JSON.stringify(
    helpers.buildMultiDisplayRows(main, extension, [binding]),
  )), [
    { mainIndex: 0, extensionIndex: 0 },
    { mainIndex: 1, extensionIndex: null },
    { mainIndex: null, extensionIndex: 1 },
  ]);
});
