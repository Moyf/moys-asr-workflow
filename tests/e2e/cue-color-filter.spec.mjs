// 颜色过滤下拉与「拆分时移除的标点符号」设置回归：
// - 工程存在彩色字幕时显示 🎨；点击行=只显示该颜色；勾选 checkbox=多选；清除=全部显示。
// - 拆分移除符号：前 5 个高频 chip + 「其他符号」自由文本框（空格分隔），
//   变更实时驱动共享工具层的拆分边缘修剪并持久化。
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  cleanupTempDir,
  DURATION_MS,
  findFreePort,
  generateProjectJson,
  generateWav,
  disableOnboarding,
  startServer,
  makeTempDir,
} from './helpers.mjs';

let tempDir;
let server;
let projectPath;

const FIRST_SEGMENT_END_MS = 58000;

test.beforeAll(async () => {
  tempDir = makeTempDir('colorfilter');
  const mediaPath = join(tempDir, 'synthetic.wav');
  projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  generateProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
});

async function waitEditorReady(page) {
  await page.goto(server.url);
  await page.waitForFunction(() => document.querySelectorAll('.cue').length > 0);
}

async function paintFirstSegmentRed(page) {
  await page.evaluate((segmentEndMs) => {
    const segment = DATA.segments[0];
    segment.color = {
      name: 'red', value: '#e74c3c', start: segment.start,
      end: Math.max(segment.end, segment.start) || segmentEndMs,
    };
    renderAll({ waveform: 'none' });
  }, FIRST_SEGMENT_END_MS);
}

test('color filter button appears only for projects with colored subtitles', async ({ page }) => {
  await waitEditorReady(page);
  await expect(page.locator('#color-filter-btn')).toBeHidden();
  await paintFirstSegmentRed(page);
  await expect(page.locator('#color-filter-btn')).toBeVisible();
});

test('clicking a row shows only that color; checkboxes multi-select; clear restores all', async ({ page }) => {
  await waitEditorReady(page);
  await paintFirstSegmentRed(page);
  const total = await page.evaluate(() => DATA.segments.length);

  await page.locator('#color-filter-btn').click();
  const rows = page.locator('#color-filter-menu .color-filter-item');
  await expect(rows).toHaveCount(2); // 默认 + 红

  // 点击“红”这一行（非 checkbox 区域）= 只显示该颜色。
  await rows.nth(1).locator('.color-name').click();
  let visibleCount = await page.locator('#visible-count').textContent();
  expect(Number(visibleCount)).toBe(1);
  await expect(page.locator('.cue:not(.hidden)')).toHaveCount(1);

  // 勾选“默认”= 多选：红色行保持勾选，无颜色的字幕重新出现。
  await rows.first().locator('input[type="checkbox"]').check();
  visibleCount = await page.locator('#visible-count').textContent();
  expect(Number(visibleCount)).toBe(total);
  await expect(rows.nth(1).locator('input[type="checkbox"]')).toBeChecked();

  // 取消“红”后只剩默认字幕。
  await rows.nth(1).locator('input[type="checkbox"]').uncheck();
  visibleCount = await page.locator('#visible-count').textContent();
  expect(Number(visibleCount)).toBe(total - 1);

  // 清除按钮恢复完整列表。
  const clearButton = page.locator('#color-filter-menu .color-filter-clear');
  await expect(clearButton).toBeVisible();
  await clearButton.click();
  await expect(clearButton).toBeHidden();
  visibleCount = await page.locator('#visible-count').textContent();
  expect(Number(visibleCount)).toBe(total);
  await expect(page.locator('#color-filter-btn')).not.toHaveClass(/filter-active/);
});

test('split trim chips and extra input drive shared trim behavior and persist', async ({ page }) => {
  await waitEditorReady(page);
  await page.evaluate(() => {
    window.MAWE_EDITOR_BRIDGE.setEditorSettingsPanelOpen(true);
  });
  const grid = page.locator('#split-trim-symbol-grid');
  await expect(grid).toBeVisible();
  const labels = grid.locator('label');
  // 仅前 5 个高频符号提供 chip；其余走「其他符号」文本框。
  await expect(labels).toHaveCount(
    await page.evaluate(() => window.AsrEditorUtils.SPLIT_TRIM_PRIMARY_SYMBOLS.length),
  );
  const reset = page.locator('#split-trim-symbols-reset');
  await expect(reset).toBeHidden();
  const extra = page.locator('#split-trim-extra-symbols');
  // 文本框默认预填半角逗号句点（延续历史行为）。
  await expect(extra).toHaveValue(', .');

  // 关闭全角逗号 chip 后，拆分修剪不再移除右缘全角逗号（半角逗号仍由文本框生效）。
  const fullwidthCommaChip = grid.locator('label[title="全角逗号"]');
  const fullwidthComma = grid.locator('input[value="，"]');
  await expect(fullwidthComma).toBeChecked();
  await fullwidthCommaChip.click();
  await expect(fullwidthComma).not.toBeChecked();
  await expect(reset).toBeVisible();
  expect(await page.evaluate(() => window.AsrEditorUtils.applySplitEdgeTrim('世界，', 'end'))).toBe('世界，');
  expect(await page.evaluate(() => window.AsrEditorUtils.applySplitEdgeTrim('ok,', 'end'))).toBe('ok');

  // 文本框输入即时生效：改为省略号后存储与修剪行为同时体现。
  await extra.fill('…');
  await extra.press('Tab');
  await expect(extra).toHaveValue('…');
  const storedSymbols = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('moy.asr.editor.settings.v1')).splitTrimSymbols);
  expect(storedSymbols).not.toContain('，');
  expect(storedSymbols).toContain('。');
  expect(storedSymbols).toContain('…');
  expect(await page.evaluate(() => window.AsrEditorUtils.applySplitEdgeTrim('真的……', 'end'))).toBe('真的');

  // 恢复默认符号：chip 全部回勾、文本框回到预填值、行为还原。
  await reset.click();
  await expect(fullwidthComma).toBeChecked();
  await expect(extra).toHaveValue(', .');
  await expect(reset).toBeHidden();
  expect(await page.evaluate(() => window.AsrEditorUtils.applySplitEdgeTrim('世界，', 'end'))).toBe('世界');
});

test('merge join hint shows detected main type; clicking pins and syncs the multi-subtitle dropdown', async ({ page }) => {
  await waitEditorReady(page);
  await page.evaluate(() => {
    window.MAWE_EDITOR_BRIDGE.setEditorSettingsPanelOpen(true);
  });
  const hintText = page.locator('#merge-join-mode-text');
  const switchButton = page.locator('#merge-join-mode-switch');
  const multiSelect = page.locator('#multi-subtitle-main-language-mode');

  // 英文工程 → 自动检测为单词型；短提示 + 统一的「切换为」按钮。
  await expect(hintText).toContainText('当前为「单词型」');
  await expect(switchButton).toHaveText('切换为字符型');
  // 与多重字幕菜单的「主字幕语言类型」共享同一状态（下拉框此时是检测值）。
  await expect(multiSelect).toHaveValue('word');

  // 点击 → 指定为字符型；提示统一样式并同步多重字幕下拉框。
  await switchButton.click();
  await expect(hintText).toContainText('当前为「字符型」');
  await expect(switchButton).toHaveText('切换为单词型');
  await expect(multiSelect).toHaveValue('continuous');
  expect(await page.evaluate(() => DATA.multi_subtitle.main_split_mode)).toBe('continuous');

  // 再点一次切回单词型。
  await switchButton.click();
  await expect(hintText).toContainText('当前为「单词型」');
  await expect(multiSelect).toHaveValue('word');

  // 连续型/单词型两组在同一行、各占约一半宽度（列标签右缘不超过彼此起点）。
  const rowBoxes = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.split-join-inline-row > .split-join-row')];
    return rows.map((el) => el.getBoundingClientRect());
  });
  expect(rowBoxes).toHaveLength(2);
  expect(rowBoxes[0].top).toBeCloseTo(rowBoxes[1].top, 0);
  expect(Math.abs(rowBoxes[0].width - rowBoxes[1].width)).toBeLessThan(24);

  // 提示按钮在窄容器下不越界：面板已保持足够宽，这里仅确认元素可点击可见。
  await expect(switchButton).toBeVisible();
});
