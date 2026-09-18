import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  cleanupTempDir,
  DURATION_MS,
  findFreePort,
  generateProjectJson,
  generateWav,
  makeTempDir,
  startServer,
} from './helpers.mjs';

// 蓝色片段回归（真实工程 Video_1789439584813_538.mosp 的 main-182-b-b-a/-b）：
// ASR 词「傲」被人工改写成「Alt(noir)」（多 9 字符）后，字幕文本与 items 脱钩。
// 旧拆分实现一处 indexOf 失配就把全部对齐作废、退回顺序长度映射，切点随插入
// 文本长度漂移到段尾——「字拆对、时拆错」：文本在「骨|要」处分开，时间却切在
// 最后一个词「程|度」的边界（右段只剩一个 2690ms 的「度」）。
// 修复后顺序保持对齐让其余词各归各位、失配词按时间落边，时间切分必须落在
// 「骨」与「要被」之间的真实静音（原工程 722630 / 722730；下方时间按同结构
// 重制到合成音频 5 分钟范围内，形态逐一对应）。

let tempDir;
let server;

const DESYNC_SEGMENT = {
  id: 'desync-altnoir',
  start: 60000,
  end: 65000,
  text: '这Alt(noir)骨燕的傲骨要被践踏到什么程度',
  items: [
    { text: '这', start: 60000, end: 60160 },
    { text: '傲', start: 60160, end: 60310 },
    { text: '骨', start: 60310, end: 60430 },
    { text: '燕', start: 60430, end: 60620 },
    { text: '的', start: 60620, end: 60720 },
    { text: '傲', start: 60720, end: 60860 },
    { text: '骨', start: 60860, end: 61170 },
    { text: '要被', start: 61270, end: 61520 },
    { text: '践踏', start: 61520, end: 61850 },
    { text: '到什么', start: 61850, end: 62240 },
    { text: '程', start: 62240, end: 62430 },
    { text: '度', start: 62430, end: 65000 },
  ],
};

// 问题1 场景（review 最小复现，同构）：失配词「傲」的替换区「X」整体在
// 刀点左侧，必须归左段；边界扩到包住它（leftEnd=2000），保留与「乙」
// 之间 200ms 静音。修复前按纯时间比较会把它错分到右段。
const LEFT_SIDE_REPLACEMENT_SEGMENT = {
  id: 'desync-left-replacement',
  start: 0,
  end: 3000,
  text: '甲X 乙',
  items: [
    { text: '甲', start: 0, end: 1000 },
    { text: '傲', start: 1000, end: 2000 },
    { text: '乙', start: 2200, end: 3000 },
  ],
};

// 问题2 场景（review 最小复现，同构）：全部词都与文本失配。修复前
// Number(null)=0 被当成切点钳到段首，光标入口拒拆并提示强制重试；
// 修复后按文字偏移占比映射词序，在 2000ms（两词边界）拆分。
const ALL_UNALIGNED_SEGMENT = {
  id: 'desync-all-unaligned',
  start: 1000,
  end: 3000,
  text: '丙 丁',
  items: [
    { text: '甲', start: 1000, end: 2000 },
    { text: '乙', start: 2000, end: 3000 },
  ],
};

test.beforeAll(async () => {
  tempDir = makeTempDir('desync-split');
  const mediaPath = join(tempDir, 'synthetic.wav');
  const projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  generateProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

// A2 场景（GUI 验证发现的缺口，main-211 同构）：失配词「傲」的语音
// （846000–846200）正是右段文本 Alt(noir) 的发音。右段起点必须前移到
// 「傲」的 start，否则「傲」先于段起点 200ms，保存时被时间码兜底逻辑
// 二次改写（「已自动修复 N 处异常时间码」）。
const DESYNC_GAP_WORD_SEGMENT = {
  id: 'desync-gap-word',
  start: 843680,
  end: 846720,
  text: '那就不打扰你了  Alt(noir)骨燕',
  items: [
    { text: '那', start: 843680, end: 844280 },
    { text: '就不', start: 844360, end: 845000 },
    { text: '打扰', start: 845000, end: 845360 },
    { text: '你了', start: 845360, end: 845720 },
    { text: '傲', start: 846000, end: 846200 },
    { text: '骨', start: 846200, end: 846400 },
    { text: '燕', start: 846400, end: 846720 },
  ],
};

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test.beforeEach(async ({ page }) => {
  // 加高视口让 idx=0 的 cue 完整落在首屏内：cue 列表在波形下方，默认
  // 1280x800 时该 cue 在折叠线以下，双击会引入自动滚动与列表重绘的竞态，
  // 第二次点击可能落到相邻 cue 上。
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false }));
  });
});

async function injectSegment(page, segment) {
  await page.goto(server.url);
  await expect(page.locator('.cue[data-idx="0"] .text')).toBeVisible();
  await page.evaluate((value) => {
    DATA.segments[0] = value;
    renderAll({ waveform: 'full' });
  }, segment);
}

async function splitAtCaretOffset(page, offset) {
  const text = page.locator('.cue[data-idx="0"] .text');
  // 程序化派发 dblclick 而非物理双击：首次物理点击会选中本行并使行高
  // 变化，第二次点击可能滑到相邻 cue 上（坐标竞态）。合成事件直接在
  // 目标 cue 上触发编辑，clientX/Y 只用于初始光标，随后按 offset 重设。
  await text.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + 2,
      clientY: rect.top + rect.height / 2,
    }));
  });
  await expect(text).toHaveAttribute('contenteditable', 'plaintext-only');
  await text.evaluate((element, caretOffset) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, caretOffset);
    range.setEnd(node, caretOffset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, offset);
  await page.keyboard.press('Enter');
  await expect(page.locator('.cue[data-idx="1"]')).toHaveCount(1);
}

async function readSplitState(page) {
  return page.evaluate(() => DATA.segments.slice(0, 2).map((segment) => ({
    start: segment.start,
    end: segment.end,
    text: segment.text,
    items: (segment.items || []).map((item) => ({ text: item.text, start: item.start, end: item.end })),
  })));
}

test('splitting a rewritten-over-ASR segment keeps the time split at the spoken gap', async ({ page }) => {
  await injectSegment(page, DESYNC_SEGMENT);
  // 光标在偏移 15：「这Alt(noir)骨燕的傲骨|要被…」，即「骨|要」之间的静音。
  await splitAtCaretOffset(page, 15);

  const [left, right] = await readSplitState(page);
  expect(left.text).toBe('这Alt(noir)骨燕的傲骨');
  expect(right.text).toBe('要被践踏到什么程度');
  // 非对称边界落在真实静音两侧，而不是漂移到段尾的「程|度」。
  expect(left.end).toBe(61170);
  expect(right.start).toBe(61270);
  expect(left.start).toBe(60000);
  expect(right.end).toBe(65000);

  // 核心回归：右侧必须带走下一句的全部词（5 项，首词「要被」），
  // 而不是旧 bug 里只剩一个 2690ms 的「度」；失配词「傲」留在左侧。
  expect(left.items).toHaveLength(7);
  expect(right.items).toHaveLength(5);
  expect(left.items.at(-1)).toEqual({ text: '骨', start: 60860, end: 61170 });
  expect(left.items[1]).toEqual({ text: '傲', start: 60160, end: 60310 });
  expect(right.items[0]).toEqual({ text: '要被', start: 61270, end: 61520 });
  expect(right.items.at(-1)).toEqual({ text: '度', start: 62430, end: 65000 });
  for (const segment of [left, right]) {
    for (const item of segment.items) {
      expect(item.start).toBeGreaterThanOrEqual(segment.start);
      expect(item.end).toBeLessThanOrEqual(segment.end);
      expect(item.end).toBeGreaterThan(item.start);
    }
  }
});

test('unaligned word in the split gap pulls the right cue start to its own start', async ({ page }) => {
  await injectSegment(page, DESYNC_GAP_WORD_SEGMENT);
  // 光标在偏移 9：「那就不打扰你了  ｜Alt(noir)骨燕」（空格组之后）。
  await splitAtCaretOffset(page, 9);

  const [left, right] = await readSplitState(page);
  expect(left.text).toBe('那就不打扰你了');
  expect(right.text).toBe('Alt(noir)骨燕');
  expect(left.end).toBe(845720);
  // 修复点：右段起点前移到失配词「傲」的 start（846000），而不是下一个
  // 对齐词「骨」的 846200——否则「傲」先于段起点，保存时会被时间码兜底
  // 逻辑二次改写（「已自动修复 N 处异常时间码」）。
  expect(right.start).toBe(846000);
  expect(right.items[0]).toEqual({ text: '傲', start: 846000, end: 846200 });
  expect(right.items[1]).toEqual({ text: '骨', start: 846200, end: 846400 });
  expect(right.items.at(-1)).toEqual({ text: '燕', start: 846400, end: 846720 });
  for (const segment of [left, right]) {
    for (const item of segment.items) {
      expect(item.start).toBeGreaterThanOrEqual(segment.start);
      expect(item.end).toBeLessThanOrEqual(segment.end);
      expect(item.end).toBeGreaterThan(item.start);
    }
  }
});

test('replacement word left of the cut stays in the left cue with its own boundary', async ({ page }) => {
  await injectSegment(page, LEFT_SIDE_REPLACEMENT_SEGMENT);
  // 光标在偏移 3：「甲X ｜乙」（空格组之后）；替换区「X」整体在刀点左侧。
  await splitAtCaretOffset(page, 3);

  const [left, right] = await readSplitState(page);
  expect(left.text).toBe('甲X');
  expect(right.text).toBe('乙');
  // 「傲」是「X」的发音，必须留在左段；左段边界扩到它的 end，
  // 与「乙」之间 200ms 静音保留。修复前它被按时间错分到右段。
  expect(left.end).toBe(2000);
  expect(right.start).toBe(2200);
  expect(left.items).toHaveLength(2);
  expect(left.items[1]).toEqual({ text: '傲', start: 1000, end: 2000 });
  expect(right.items).toEqual([{ text: '乙', start: 2200, end: 3000 }]);
});

test('fully unaligned items still split at the mapped word boundary', async ({ page }) => {
  await injectSegment(page, ALL_UNALIGNED_SEGMENT);
  // 光标在偏移 2：「丙｜丁」。全部词失配时按文字占比映射词序：
  // 切点应落在两词边界 2000，而不是退到段首 1000（那会拒拆并提示强制重试）。
  await splitAtCaretOffset(page, 2);

  const [left, right] = await readSplitState(page);
  expect(left.text).toBe('丙');
  expect(right.text).toBe('丁');
  expect(left.end).toBe(2000);
  expect(right.start).toBe(2000);
  expect(left.items).toEqual([{ text: '甲', start: 1000, end: 2000 }]);
  expect(right.items).toEqual([{ text: '乙', start: 2000, end: 3000 }]);
});

// 漂移提示场景：失配词「傲」（500–1500ms）强制归左后，左段边界前移到
// 1500ms，与下刀 250ms 相距 1250ms（>500ms 阈值）——走主字幕波形拆分
// 弹窗入口（openMainWaveformSplitModal → commitMainWaveformSplit）时必须
// 出现「文本与词时间戳不一致」提示；拆分本身仍按词边界完成。
const DRIFT_WARNING_SEGMENT = {
  id: 'desync-drift-warning',
  start: 0,
  end: 2700,
  text: '甲X 乙丙丁',
  items: [
    { text: '甲', start: 0, end: 500 },
    { text: '傲', start: 500, end: 1500 },
    { text: '乙', start: 1500, end: 1900 },
    { text: '丙', start: 1900, end: 2300 },
    { text: '丁', start: 2300, end: 2700 },
  ],
};

test('waveform split modal warns when desynced replacement drifts from the cut', async ({ page }) => {
  await injectSegment(page, DRIFT_WARNING_SEGMENT);
  const opened = await page.evaluate(() => openMainWaveformSplitModal(0, 250));
  expect(opened).toBe(true);
  await expect(page.locator('#multi-subtitle-split-modal.show')).toBeVisible();
  await page.evaluate(() => confirmLinkedSplit());

  await expect(page.locator('#hint-stack .hint-card').filter({ hasText: '字幕文本与词时间戳' })).toHaveCount(1);
  const [left, right] = await readSplitState(page);
  expect(left.text).toBe('甲X');
  expect(right.text).toBe('乙丙丁');
  expect(left.end).toBe(1500);
  expect(right.start).toBe(1500);
  expect(left.items.at(-1)).toEqual({ text: '傲', start: 500, end: 1500 });
  expect(right.items[0]).toEqual({ text: '乙', start: 1500, end: 1900 });
});
