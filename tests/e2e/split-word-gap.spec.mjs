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

// 任务 42 回归：拆分切点两侧词之间有真实静音空隙时（本地 ASR 常见，
// 如「型、」end 6480 与下一词「AI」start 6720 之间 240ms），拆分必须
// 输出非对称边界——左段停在自家最后一词的 end，右段起自自家首词的
// start——而不是把一侧拉长跨过静音贴住另一词。连续词场景保持共享
// 边界的旧行为；切点落在单个词内部时仍按比例插值单点切分。

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('asym-split');
  const mediaPath = join(tempDir, 'synthetic.wav');
  const projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  generateProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false }));
  });
});

// 与用户实测工程一致的数据形态：标点合入前一词 item，词间存在静音。
const GAP_SEGMENT = {
  id: 'asym-gap',
  start: 5760,
  end: 8880,
  text: '本地模型、AI校准和翻译、双语字幕、',
  items: [
    { text: '本', start: 5760, end: 5920 },
    { text: '地', start: 5920, end: 6000 },
    { text: '模', start: 6000, end: 6160 },
    { text: '型、', start: 6160, end: 6480 },
    { text: 'AI', start: 6720, end: 6880 },
    { text: '校', start: 6880, end: 7120 },
    { text: '准', start: 7120, end: 7200 },
  ],
};

const CONTIGUOUS_SEGMENT = {
  id: 'asym-contiguous',
  start: 20000,
  end: 24000,
  text: '本地模型、AI校准',
  items: [
    { text: '本', start: 20000, end: 20160 },
    { text: '地', start: 20160, end: 20320 },
    { text: '模', start: 20320, end: 20480 },
    { text: '型、', start: 20480, end: 20800 },
    { text: 'AI', start: 20800, end: 21120 },
    { text: '校', start: 21120, end: 21600 },
    { text: '准', start: 21600, end: 22000 },
  ],
};

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
  await text.dblclick();
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

test('splitting inside a word gap keeps both cues on their own word times', async ({ page }) => {
  await injectSegment(page, GAP_SEGMENT);
  // 光标在偏移 5：「本地模型、|AI…」，切点落在 型、(…6480) 与 AI(6720…) 的静音里。
  await splitAtCaretOffset(page, 5);

  const [left, right] = await readSplitState(page);
  expect(left.text).toBe('本地模型');
  expect(right.text).toBe('AI校准和翻译、双语字幕、');
  // 非对称边界：左段停在自家词尾，右段起于自家首词，空隙保留在两段之间。
  expect(left.end).toBe(6480);
  expect(right.start).toBe(6720);
  expect(left.start).toBe(5760);
  expect(right.end).toBe(8880);

  // cleanSplitItems 会裁掉左段末 item 文本的尾部标点（型、→型），时间保留。
  expect(left.items.at(-1)).toEqual({ text: '型', start: 6160, end: 6480 });
  expect(right.items[0]).toEqual({ text: 'AI', start: 6720, end: 6880 });
  for (const segment of [left, right]) {
    for (const item of segment.items) {
      expect(item.start).toBeGreaterThanOrEqual(segment.start);
      expect(item.end).toBeLessThanOrEqual(segment.end);
      expect(item.end).toBeGreaterThan(item.start);
    }
  }
});

test('splitting between contiguous words keeps a shared boundary', async ({ page }) => {
  await injectSegment(page, CONTIGUOUS_SEGMENT);
  await splitAtCaretOffset(page, 5);

  const [left, right] = await readSplitState(page);
  expect(left.text).toBe('本地模型');
  expect(right.text).toBe('AI校准');
  // 连续 item 上 prev.end === next.start：左右段仍共享同一个切点（旧行为）。
  expect(left.end).toBe(20800);
  expect(right.start).toBe(20800);
  expect(left.items.at(-1)).toEqual({ text: '型', start: 20480, end: 20800 });
  expect(right.items[0]).toEqual({ text: 'AI', start: 20800, end: 21120 });
});

test('splitting inside a word still interpolates a single shared point', async ({ page }) => {
  await injectSegment(page, GAP_SEGMENT);
  // 光标在偏移 4：「本地模型|、AI…」，切点位于「型、」item 内部（3/5 处）。
  await splitAtCaretOffset(page, 4);

  const [left, right] = await readSplitState(page);
  // 词内切点仍为单一共享边界：6160 + (6480-6160) * 1/2 = 6320。
  expect(left.end).toBe(6320);
  expect(right.start).toBe(6320);
  // 「型」留在左侧，「、」文本在右侧起点被裁剪，右侧第一个有效词是 AI。
  expect(left.items.at(-1)).toEqual({ text: '型', start: 6160, end: 6320 });
  expect(right.items[0]).toEqual({ text: 'AI', start: 6720, end: 6880 });
  expect(right.start).toBeLessThanOrEqual(right.items[0].start);
});
