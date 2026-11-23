import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const h = context.window.AsrEditorUtils;
const plain = value => JSON.parse(JSON.stringify(value));

const dialogues = output => output.split('\n').filter(line => line.startsWith('Dialogue:'));
const karaokeProfile = { animations: { karaoke: { enabled: true } } };
// 四字各占 500ms：翻转时刻（厘秒）为 0 / 50 / 100 / 150，句长 200cs。
const KTV_CUE = {
  start: 0, end: 2000, text: '你好世界',
  items: [
    { text: '你', start: 0, end: 500 },
    { text: '好', start: 500, end: 1000 },
    { text: '世', start: 1000, end: 1500 },
    { text: '界', start: 1500, end: 2000 },
  ],
};

test('karaoke export writes one \\k per word with gap-to-next durations', () => {
  const output = h.buildAssPayload([KTV_CUE], { assStyle: { fontSize: 64 }, assProfile: karaokeProfile });
  const [line] = dialogues(output);
  // 翻转在音节窗口起点（像素 oracle 实证）：词 i 的时长 = 下一词翻转 − 本词翻转，
  // 首词 T=0 无需空引导。
  assert.ok(line.includes('{\\k50}你{\\k50}好{\\k50}世{\\k50}界'));
});

test('karaoke disabled by default and never applies outside ASS mode', () => {
  for (const options of [{}, { assProfile: {} }]) {
    const output = h.buildAssPayload([KTV_CUE], options);
    assert.ok(!output.includes('\\k'));
    assert.ok(dialogues(output).some(line => line.includes('你好世界')));
  }
});

test('leading silence before the first word emits an empty lead-in \\k', () => {
  const cue = {
    start: 0, end: 2000, text: '你好',
    items: [
      { text: '你', start: 300, end: 1000 },
      { text: '好', start: 1000, end: 2000 },
    ],
  };
  const output = h.buildAssPayload([cue], { assStyle: { fontSize: 64 }, assProfile: karaokeProfile });
  const [line] = dialogues(output);
  // 首词 30cs 才开口：空引导 {\k30} 推进时钟，随后 {\k70} 落到下一词的翻转
  //（好在 100cs 翻转，末词时长补到句尾 200cs）。
  assert.ok(line.includes('{\\k30}{\\k70}你{\\k100}好'));
});

test('cues without word timings silently fall back to plain text', () => {
  const plain = { start: 0, end: 1000, text: '普通字幕' };
  const output = h.buildAssPayload([plain], { assStyle: { fontSize: 64 }, assProfile: karaokeProfile });
  assert.ok(!output.includes('\\k'));
  assert.ok(dialogues(output).some(line => line.includes('普通字幕')));
});

test('items whose text cannot map onto the cue fall back per cue', () => {
  const mismatch = {
    start: 0, end: 2000, text: '再见',
    items: [
      { text: '你', start: 0, end: 1000 },
      { text: '好', start: 1000, end: 2000 },
    ],
  };
  const mismatched = h.buildAssPayload([mismatch, KTV_CUE],
    { assStyle: { fontSize: 64 }, assProfile: karaokeProfile });
  // 失配句回落纯文本，同工程其他句正常注入，逐句独立。
  assert.ok(!dialogues(mismatched).some(line => line.includes('再见') && line.includes('\\k')));
  assert.ok(dialogues(mismatched).some(line => line.includes('再见')));
  assert.ok(dialogues(mismatched).some(line => line.includes('{\\k50}你')));

  const partial = {
    start: 0, end: 2000, text: '你好世界',
    items: [
      { text: '你', start: 0, end: 500 },
      { text: '好', start: 500, end: 1000 },
    ],
  };
  const partialOutput = h.buildAssPayload([partial],
    { assStyle: { fontSize: 64 }, assProfile: karaokeProfile });
  // 部分覆盖：有时间的字词注入，剩余文本留在上一音节（无 \k、随好翻转）。
  assert.ok(dialogues(partialOutput).some(line => line.includes('{\\k50}你{\\k150}好世界')));
});

test('emphasis runs keep their overrides and receive \\k first in the block', () => {
  const cue = {
    start: 0, end: 1000, text: '**你**好',
    items: [
      { text: '你', start: 0, end: 500 },
      { text: '好', start: 500, end: 1000 },
    ],
  };
  const output = h.buildAssPayload([cue], { assStyle: { fontSize: 64 }, assProfile: karaokeProfile });
  const [line] = dialogues(output);
  // 强调 run 的颜色覆盖照旧；\k 作为独立引导块在覆盖块之前（未唱时次色
  // 覆盖 \1c，已唱吃覆盖，均经像素 oracle 实证）。
  assert.ok(line.includes('{\\k50}{\\1c'));
  assert.ok(line.includes('你'));
  assert.ok(line.includes('{\\k50}好'));
});

test('mapTime shifts flip times together with the cue (gap-removed export)', () => {
  const cue = {
    start: 1000, end: 3000, text: '你好',
    items: [
      { text: '你', start: 1000, end: 2000 },
      { text: '好', start: 2000, end: 3000 },
    ],
  };
  const output = h.buildAssPayload([cue], {
    assStyle: { fontSize: 64 }, assProfile: karaokeProfile,
    mapTime: timeMs => timeMs - 1000, alignFirstStart: false,
  });
  const [line] = dialogues(output);
  // 映射后事件 [0,2000]，翻转时刻随 items 的映射时间同步平移：
  // 你 0cs、好 100cs，各 100cs 差值。
  assert.ok(line.includes('{\\k100}你{\\k100}好'));
});

test('layout slices re-base the karaoke clock instead of replaying it', () => {
  const neighbour = { start: 1000, end: 2000, text: '另一句' };
  let plan;
  const output = h.buildAssPayload([KTV_CUE, neighbour], {
    assStyle: { fontSize: 64 }, assProfile: karaokeProfile,
    onAssPlan: value => { plan = value; },
  });
  const lines = dialogues(output).filter(line => line.includes('你') && line.includes('\\k'));
  // 另一句在 1s 处加入 → 布局变化，KTV 句拆成 [0,1000) / [1000,2000) 两片。
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('{\\k50}你{\\k50}好{\\k50}世{\\k50}界'));
  // 片 2 偏移 100cs：你/好已翻转（\k0），世在片内 0cs 翻转（时长落界），
  // 界保持差值；累计时钟恢复到与单片导出相同的绝对翻转时刻。
  assert.ok(lines[1].includes('{\\k0}你{\\k0}好{\\k50}世{\\k50}界'));
  assert.ok(plan.slices.length >= 2);
  assert.ok(plan.slices[0].items.some(item => item.karaoke === true));
});

test('shake slices re-base per 60ms piece with exact two-state semantics', () => {
  const cue = { ...KTV_CUE, text: `!!${KTV_CUE.text}!!` };
  const output = h.buildAssPayload([cue], { assStyle: { fontSize: 64 }, assProfile: karaokeProfile });
  const lines = dialogues(output);
  assert.ok(lines.length > 1);
  const firstTagged = lines[0].match(/\{\\k(\d+)\}你/);
  const secondTagged = lines[1].match(/\{\\k(\d+)\}你/);
  // 片 1（0–60ms）：你 \k50（首词完整窗口）；片 2 偏移 6cs：你已唱，
  // 时长收缩为 44cs 且在片起点即处于已唱色。
  assert.equal(firstTagged?.[1], '50');
  assert.equal(secondTagged?.[1], '44');
  for (const line of lines) assert.ok(line.includes('\\pos('));
});

test('karaoke keeps the style secondary colour in colour variants', () => {
  const cue = { ...KTV_CUE, color: { name: 'yellow' } };
  const options = {
    assStyle: { fontSize: 64, secondaryColor: '#00ff00' },
    appearance: { ass_color_style: 'text' },
  };
  const withKaraoke = h.buildAssPayload([cue], { ...options, assProfile: karaokeProfile });
  const yellowKaraoke = withKaraoke.split('\n')
    .find(line => line.startsWith('Style: YELLOW,'));
  // #00ff00 → &H0000FF00（BGR）：未唱色保持样式次色。
  assert.ok(yellowKaraoke.includes('&H0000FF00'));
  const withoutKaraoke = h.buildAssPayload([cue], { ...options, assProfile: {} });
  const yellowPlain = withoutKaraoke.split('\n')
    .find(line => line.startsWith('Style: YELLOW,'));
  // 关闭卡拉 OK 时维持旧行为：次色与调色板主色同步。
  assert.ok(!yellowPlain.includes('&H0000FF00'));
});

test('stack plan runs carry karaoke windows for the canvas preview', () => {
  let plan;
  h.buildAssPayload([KTV_CUE], {
    assStyle: { fontSize: 64 }, assProfile: karaokeProfile,
    onAssPlan: value => { plan = value; },
  });
  const item = plan.slices.flatMap(slice => slice.items).find(candidate => candidate.karaoke === true);
  assert.ok(item);
  const tagged = item.runs.filter(run => run.karaoke !== undefined);
  assert.equal(tagged.length, 4);
  // 跨 realm 数组经 plain() 归一后再比较（模块加载器用 vm 上下文）。
  assert.deepEqual(plain(tagged.map(run => run.karaoke.flipMs)), [0, 500, 1000, 1500]);
  assert.deepEqual(plain(tagged.map(run => run.karaoke.word)), [0, 1, 2, 3]);
  // 逐词翻转差值与导出标签一致；首词带空引导元数据（T=0 时不发射）。
  assert.equal(tagged[0].karaoke.leadCs, 0);
  assert.equal(tagged[0].karaoke.nextCs, 50);
});
