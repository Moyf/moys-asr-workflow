import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const compareUrl = pathToFileURL(resolve('tools/timestamp-compare.html')).href;

async function openEmbedded(page, testInfo, files) {
  const source = readFileSync('tools/timestamp-compare.html', 'utf8');
  const marker = '<script id="timestamp-compare-data" type="application/json">';
  const json = JSON.stringify({ files }).replace(/</g, '\\u003c');
  const output = testInfo.outputPath('embedded-timestamps.html');
  writeFileSync(output, source
    .replace('<head>', () => `<head><base href="${new URL('.', compareUrl).href}">`)
    .replace(marker + '</script>', () => marker + json + '</script>'));
  await page.goto(pathToFileURL(output).href);
}

const projectA = {
  timestamp_granularity: 'char',
  model: 'aligner-a',
  segments: [
    {
      start: 0,
      end: 1000,
      text: '你好',
      items: [
        { text: '你', start: 0, end: 450 },
        { text: '好', start: 450, end: 1000 },
      ],
    },
    {
      start: 1200,
      end: 2200,
      text: '世界',
      items: [
        { text: '世', start: 1200, end: 1700 },
        { text: '界', start: 1700, end: 2200 },
      ],
    },
    { start: 2300, end: 2500, text: '忽略', disabled: true },
    { start: 2300, end: 2500, text: '忽略' },
    {
      start: 3000,
      end: 3600,
      text: '时间',
      items: [
        { text: '时', start: 3000, end: 3300 },
        { text: '间', start: 3300, end: 3600 },
      ],
    },
  ],
};

const projectB = {
  timestamp_granularity: 'word',
  model: 'aligner-b',
  segments: [
    {
      start: 50,
      end: 1050,
      text: '你好',
      items: [
        { text: '你', start: 50, end: 500 },
        { text: '好', start: 500, end: 1050 },
      ],
    },
    {
      start: 1200,
      end: 2200,
      text: '世界!',
      items: [
        { text: '世', start: 1200, end: 1500 },
        { text: '界', start: 1500, end: 1900 },
        { text: '!', start: 1900, end: 2200 },
      ],
    },
    { start: 2300, end: 2500, text: '忽略' },
    { start: 3000, end: 3600, text: '时间' },
    { start: 4000, end: 4500, text: '新增' },
  ],
};

test('renders embedded projects, classifies differences, and expands item details', async ({ page }, testInfo) => {
  await openEmbedded(page, testInfo, [
    { name: 'before.mosp', project: projectA },
    { name: 'after.mosp', project: projectB },
  ]);

  await expect(page.locator('#heading')).toContainText('时间码对比');
  await expect(page.locator('.file-card')).toHaveCount(2);
  await expect(page.locator('.card-source').nth(0)).toContainText('字级');
  await expect(page.locator('.card-source').nth(1)).toContainText('词级');
  await expect(page.locator('.summary')).toContainText('段级时间一致');
  await expect(page.locator('.summary')).toContainText('仅 A 有');
  await expect(page.locator('.summary')).toContainText('完全一致');
  await expect(page.locator('.row-grid')).toHaveCount(5);
  await expect(page.locator('.chip.time').first()).toContainText('时间');
  await expect(page.locator('.chip.count').first()).toContainText('词数');
  await expect(page.locator('.chip.missing').first()).toContainText('缺段');

  await page.locator('#showItemText').locator('..').click();
  await expect(page.locator('#showItemText')).toBeChecked();
  await expect(page.locator('.item-label-row')).toHaveCount(5);
  await expect(page.locator('.item-label')).toHaveCount(11);
  await expect(page.locator('.item-label').filter({ hasText: '你' }).first()).toBeVisible();
  await expect(page.locator('.item-label').first()).toHaveCSS('font-size', '12px');
  await expect(page.locator('.item-block.odd')).not.toHaveCount(0);
  await expect(page.locator('.item-block.even')).not.toHaveCount(0);
  await expect(page.locator('.item-strip.missing-items')).toHaveCount(1);

  await page.locator('.row-grid').first().click();
  await expect(page.locator('.details')).toBeVisible();
  await expect(page.locator('.details')).toContainText('Δ 起 / 止');
  await expect(page.locator('.details')).toContainText('你');

  await page.locator('#diffOnly').check();
  await expect(page.locator('.row-grid')).toHaveCount(4);
  await expect(page.locator('#status')).toContainText('显示 4/5 组');

  await expect(page.locator('.card-name')).toHaveText(['before.mosp', 'after.mosp']);
  await expect(page.locator('.card-grid > :first-child .stat-value')).toHaveText(['4', '5']);
  await expect(page.locator('#showItemText')).toBeChecked();
  await page.getByRole('button', { name: '移除 after.mosp' }).click();
  await expect(page.locator('.file-card')).toHaveCount(1);
  await expect(page.locator('#summary')).toBeHidden();
  await expect(page.locator('#heading')).toContainText('时间码查看');
});

test('loads SRT and project files from the picker with the correct source labels', async ({ page }) => {
  await page.goto(compareUrl);
  await page.locator('#fileInput').setInputFiles([
    {
      name: 'plain.srt',
      mimeType: 'application/x-subrip',
      buffer: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\n你好\n\n2\n00:00:01,200 --> 00:00:02,200\n世界\n', 'utf8'),
    },
    {
      name: 'timed.mosp',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        timestamp_granularity: 'char',
        segments: [
          {
            start: 0,
            end: 1000,
            text: '你好',
            items: [
              { text: '你', start: 0, end: 500 },
              { text: '好', start: 500, end: 1000 },
            ],
          },
          { start: 1200, end: 2200, text: '世界' },
        ],
      }), 'utf8'),
    },
  ]);

  await expect(page.locator('.file-card')).toHaveCount(2);
  await expect(page.locator('.card-source').nth(0)).toContainText('SRT · 无字词时间码');
  await expect(page.locator('.card-source').nth(1)).toContainText('工程 · 字级');
  await expect(page.locator('.item-badge.no-items').first()).toContainText('无 items');
  await expect(page.locator('#search')).toBeEnabled();

  await page.locator('#search').fill('世界');
  await expect(page.locator('.row-grid')).toHaveCount(1);
  await expect(page.locator('.subtitle-text mark').first()).toContainText('世界');
});

test('shows durations, marks item range problems, and filters item quality', async ({ page }, testInfo) => {
  const project = {
    timestamp_granularity: 'char',
    segments: [
      {
        start: 1000,
        end: 2000,
        text: '越界',
        items: [
          { text: '越', start: 900, end: 1200 },
          { text: '界', start: 1200, end: 2200 },
        ],
      },
      { start: 3000, end: 4500, text: '空' },
      {
        start: 5000,
        end: 6000,
        text: '正常',
        items: [
          { text: '正', start: 5000, end: 5500 },
          { text: '常', start: 5500, end: 6000 },
        ],
      },
    ],
  };
  await openEmbedded(page, testInfo, [{ name: 'quality.mosp', project }]);

  await expect(page.locator('.subtitle-duration').first()).toHaveText('时长 1.00');
  await expect(page.locator('.cell-range-overflow')).toHaveCount(1);
  await expect(page.locator('.item-block.out-of-range')).toHaveCount(2);
  await expect(page.locator('.item-label.out-of-range')).toHaveCount(0);
  await expect(page.locator('.item-badge.out-of-range')).toContainText('越界 2');
  await expect(page.locator('.cell-empty-items')).toHaveCount(1);
  await expect(page.locator('.item-strip.no-items')).toHaveCount(1);
  await expect(page.locator('.item-badge.no-items')).toContainText('无 items');

  await page.locator('#showItemText').locator('..').click();
  await expect(page.locator('#showItemText')).toBeChecked();
  await expect(page.locator('.item-label.out-of-range')).toHaveCount(2);
  await expect(page.locator('.item-label-duration').first()).toHaveText('0.30');
  const labelStyle = await page.locator('.item-label').first().evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      background: style.backgroundColor,
      border: style.borderStyle,
      shadow: style.textShadow,
    };
  });
  expect(labelStyle.background).toBe('rgba(0, 0, 0, 0)');
  expect(labelStyle.border).toBe('none');
  expect(labelStyle.shadow).not.toBe('none');
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await expect(page.locator('body')).toHaveClass(/is-resizing/);
  await expect(page.locator('.item-label-row').first()).toBeHidden();
  await page.waitForTimeout(180);
  await expect(page.locator('.item-label-row').first()).toBeVisible();

  await page.locator('.row-grid').first().click();
  await expect(page.locator('.details .item-duration').first()).toHaveText('时长 0.30');

  await page.locator('#itemFilter').selectOption('empty');
  await expect(page.locator('.row-grid')).toHaveCount(1);
  await expect(page.locator('.row-no')).toContainText('002');
  await expect(page.locator('#status')).toContainText('筛选：空 items');

  await page.locator('#itemFilter').selectOption('overflow');
  await expect(page.locator('.row-grid')).toHaveCount(1);
  await expect(page.locator('.row-no')).toContainText('001');
  await expect(page.locator('#status')).toContainText('筛选：越界 items');
});
