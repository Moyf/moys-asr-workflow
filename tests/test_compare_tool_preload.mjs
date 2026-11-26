import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const { chromium } = createRequire(import.meta.url)(process.env.MAW_TEST_PLAYWRIGHT || 'playwright');
const pageUrl = name => pathToFileURL(path.resolve('tools', name)).href;
const project = {
  segments: [
    { id: 'main-001', start: 0, end: 900, text: '第一句文稿', items: [{ start: 0, end: 450, text: '第一句' }, { start: 450, end: 900, text: '文稿' }] },
    { id: 'main-002', start: 1200, end: 2100, text: '第二句文稿', items: [{ start: 1200, end: 2100, text: '第二句文稿' }] },
  ],
};
const encode = value => Buffer.from(value, 'utf8').toString('base64');

test('transcript compare preloads Launcher bytes without touching the offline flow', async () => {
  const browser = await chromium.launch({ executablePath: process.env.MAW_E2E_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(payload => {
      window.pywebview = { api: { compare_preload: async () => payload } };
    }, {
      files: [
        { name: '原始.mosp', bytes: encode(JSON.stringify(project)) },
        { name: '结果.srt', bytes: encode('1\n00:00:00,000 --> 00:00:00,900\n第一句文稿\n') },
      ],
      warning: '已跳过：别的.txt',
    });
    await page.goto(pageUrl('compare.html'));
    await page.waitForFunction(() => window.MAWCompare && window.MAWCompare.state.files.length === 2);
    assert.deepEqual(await page.evaluate(() => window.MAWCompare.state.files.map(file => file.name)), ['原始.mosp', '结果.srt']);
    assert.equal(await page.locator('#empty').isVisible(), false);
    assert.equal(await page.locator('#cards .card').count(), 2);
    await page.getByRole('button', { name: '设为基准' }).first().click();
    await page.waitForFunction(() => !document.getElementById('tableWrap').hidden
      && document.querySelectorAll('#tableWrap .grid > div').length > 2);
    const jump = page.getByRole('button', { name: '跳转到时间线位置' }).first();
    await jump.hover();
    await page.getByRole('tooltip').filter({ hasText: '跳转到时间线位置' }).waitFor();
    assert.equal(await jump.locator('svg').count(), 1);
    await jump.click();
    assert.equal(await page.locator('.wave-marker').count(), 3);
    await page.locator('#zxIn').click();
    assert.equal(await page.locator('.wave-marker').count(), 3);
    const shades = await page.locator('.wave-lane').first().locator('.wave-cue').evaluateAll(cues => cues.map(cue => getComputedStyle(cue).backgroundColor));
    assert.notEqual(shades[0], shades[1]);
    await page.locator('#waveScroll').hover();
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(() => document.querySelector('#waveScroll').scrollLeft > 0);
    await page.locator('#search').fill('第一句');
    await page.waitForFunction(() => document.querySelectorAll('.jump-wave').length === 1);
    const cue = page.locator('.wave-lane').first().locator('.wave-cue').last();
    await cue.hover();
    await page.getByRole('tooltip').filter({ hasText: '第二句文稿' }).waitFor();
    assert.equal(await cue.getAttribute('title'), null);
    await cue.click();
    assert.equal(await page.locator('#search').inputValue(), '第一句');
    assert.match(await page.locator('#tableWrap .wave-selected').allTextContents().then(cells => cells.join(' ')), /第二句文稿/);
    for (const [name, ms] of [['10 秒窗口', 10000], ['30 秒窗口', 30000], ['1 分钟窗口', 60000]]) {
      const control = page.getByRole('button', { name });
      await control.click();
      assert.equal(await control.getAttribute('aria-pressed'), 'true');
      const ratio = await page.locator('.wave-cue').first().evaluate(block => (block.getBoundingClientRect().width + 1.5) / block.parentElement.clientWidth);
      assert.ok(Math.abs(ratio - 900 / ms) < 0.002);
    }
    await jump.click();
    assert.equal(await page.getByRole('button', { name: '30 秒窗口' }).getAttribute('aria-pressed'), 'true');
    await jump.click();
    assert.equal(await page.getByRole('button', { name: '30 秒窗口' }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '10 秒窗口' }).click();
    await jump.click();
    assert.equal(await page.getByRole('button', { name: '10 秒窗口' }).getAttribute('aria-pressed'), 'true');
    const screenshots = process.env.MAW_REVIEW_SCREENSHOTS;
    if (screenshots) await page.screenshot({ path: `${screenshots}/transcript-compare-aligned.png` });
    page.on('dialog', dialog => dialog.accept());
    await page.locator('#clearBtn').click();
    assert.equal(await page.locator('#empty').isVisible(), true);

    const offline = await browser.newPage();
    offline.on('pageerror', error => errors.push(error.message));
    await offline.goto(pageUrl('compare.html'));
    assert.equal(await offline.locator('#empty').isVisible(), true);
    await offline.close();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('transcript compare caps loaded files and hides columns and lanes without unloading', async () => {
  const browser = await chromium.launch({ executablePath: process.env.MAW_E2E_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage();
    await page.goto(pageUrl('compare.html'));
    const files = Array.from({ length: 11 }, (_, i) => ({
      name: `version-${i + 1}.srt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(`1\n00:00:${String(i).padStart(2, '0')},000 --> 00:00:${String(i).padStart(2, '0')},500\n${i === 0 ? 'sole-hidden-text' : `unique-${i + 1}`}\n`),
    }));
    await page.locator('#fileInput').setInputFiles(files);
    await page.getByText(/最多.*10.*已跳过/).waitFor({ timeout: 3000 });
    const cards = page.locator('#cards .card');
    assert.equal(await cards.count(), 10);
    assert.equal(await page.locator('.wave-lane').count(), 10);
    await cards.first().getByRole('button', { name: '设为基准' }).click();
    await page.locator('#diffOnly').check();
    const first = cards.first().getByRole('switch');
    await first.focus();
    await page.keyboard.press('Space');
    assert.equal(await first.isChecked(), false);
    assert.equal(await first.evaluate(node => node === document.activeElement), true);
    assert.equal(await cards.count(), 10);
    assert.equal(await page.locator('.wave-lane').count(), 9);
    assert.equal(await page.locator('#tableWrap .hcell').count(), 10);
    assert.equal(await page.getByText('sole-hidden-text', { exact: true }).count(), 0);
    assert.equal(await page.locator('#diffOnly').isDisabled(), true);
    await page.locator('#search').fill('sole-hidden-text');
    await page.getByText('当前筛选下没有字幕。').waitFor({ timeout: 3000 });
    await page.locator('#resetFilters').click();
    await cards.first().locator('label.switch').click();
    assert.equal(await page.locator('.wave-lane').count(), 10);
    assert.equal(await cards.first().getByRole('button', { name: '取消基准' }).count(), 1);
    await page.locator('#diffOnly').check();
    await cards.first().locator('label.switch').click();
    await cards.first().locator('label.switch').click();
    assert.equal(await page.locator('#diffOnly').isChecked(), true);
    for (const width of [1280, 768, 414, 375, 320]) {
      await page.setViewportSize({ width, height: 850 });
      const layout = await page.evaluate(() => {
        const control = document.querySelector('.card-actions .switch');
        const track = control.querySelector('.switch-track');
        const stats = document.querySelector('.card-stats');
        const table = document.querySelector('#tableWrap');
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          gap: control.getBoundingClientRect().top - stats.getBoundingClientRect().bottom,
          font: parseFloat(getComputedStyle(control).fontSize),
          track: [track.offsetWidth, track.offsetHeight],
          tableScrollable: table.scrollWidth > table.clientWidth,
        };
      });
      assert.equal(layout.overflow, 0, `root overflow at ${width}px`);
      assert.ok(layout.gap >= 8 && layout.font >= 11);
      assert.deepEqual(layout.track, [34, 20]);
      assert.equal(layout.tableScrollable, true);
    }
    const screenshots = process.env.MAW_REVIEW_SCREENSHOTS;
    if (screenshots) await page.screenshot({ path: `${screenshots}/transcript-compare-ten-narrow.png` });
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.locator('[data-tool-theme]').click();
    if (screenshots) await page.screenshot({ path: `${screenshots}/transcript-compare-ten-alternate.png` });
    for (const control of await cards.locator('label.switch').all()) await control.click();
    assert.equal(await page.locator('#wavePanel').isVisible(), false);
    assert.equal(await page.getByText('所有文件均已隐藏').isVisible(), true);
    assert.equal(await cards.count(), 10);
    await cards.last().locator('label.switch').click();
    assert.equal(await page.locator('.wave-lane').count(), 1);
    assert.equal(await page.locator('#tableWrap .hcell').count(), 2);
  } finally { await browser.close(); }
});

test('timestamp compare preloads Launcher projects and keeps the file picker usable', async () => {
  const browser = await chromium.launch({ executablePath: process.env.MAW_E2E_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(payload => {
      window.pywebview = { api: { compare_preload: async () => payload } };
    }, {
      files: [
        { name: '原始.mosp', project },
        { name: '结果.mosp', project },
      ],
      warning: '',
    });
    await page.goto(pageUrl('timestamp-compare.html'));
    await page.waitForFunction(() => window.MAWTsCompare && window.MAWTsCompare.state.files.length === 2);
    assert.equal(await page.locator('#empty').isVisible(), false);
    assert.equal(await page.locator('.file-cards .card, #cards > *').count(), 2);
    await page.waitForFunction(() => document.querySelectorAll('#tableWrap tr, .row-grid').length > 0);
    const summaryVisible = await page.locator('#summary').isVisible();
    assert.equal(summaryVisible, true);
    assert.equal(await page.evaluate(() => window.MAWTsCompare.state.files[0].segments.length), 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('timestamp compare groups splits, merges and one-sided cues without shifting later rows', async () => {
  const browser = await chromium.launch({ executablePath: process.env.MAW_E2E_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const item = (start, end, text) => ({ start, end, text });
    const cue = (start, end, text, items = [item(start, end, text)]) => ({ start, end, text, items });
    const before = { segments: [cue(100, 700, 'split'), cue(800, 900, 'A only'), cue(1000, 1400, 'merge A'), cue(1400, 2000, 'merge B'), cue(2400, 3000, 'unchanged')] };
    const after = { segments: [cue(100, 400, 's'), cue(400, 700, 'plit'), cue(900, 1000, 'B only'), cue(1000, 2000, 'merged', []), cue(2400, 3000, 'unchanged')] };
    await page.goto(pageUrl('timestamp-compare.html'));
    await page.locator('#fileInput').setInputFiles([before, after].map((value, index) => ({
      name: `case-${index}.mosp`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)),
    })));
    await page.waitForFunction(() => document.querySelectorAll('.table-row').length === 5);
    const rows = page.locator('.table-row');
    await rows.nth(0).getByText('1 对 2', { exact: true }).waitFor({ state: 'attached' });
    assert.equal(await rows.nth(0).locator('.delta-line').count(), 0);
    assert.deepEqual(await rows.nth(0).locator('.cue-number').allTextContents(), ['原第 1 段', '原第 1 段', '原第 2 段']);
    assert.equal(await rows.nth(1).locator('.cell-missing').count(), 1);
    assert.equal(await rows.nth(2).locator('.cell-missing').count(), 1);
    await rows.nth(3).getByText('2 对 1', { exact: true }).waitFor({ state: 'attached' });
    assert.match(await rows.nth(4).locator('.delta-line').innerText(), /起 \+0 ms · 止 \+0 ms/);
    await rows.nth(0).locator('.row-grid').press('Enter');
    assert.equal(await rows.nth(0).locator('.item-row').count(), 1);
    assert.equal(await rows.nth(0).locator('.item-row .item-time').count(), 3);
    assert.equal(await rows.nth(0).locator('.item-delta').textContent(), '—');
    await page.locator('#diffOnly').check();
    assert.equal(await rows.count(), 4);
    await page.locator('#search').fill('plit');
    await page.waitForFunction(() => document.querySelectorAll('.table-row').length === 1);
    assert.equal(await rows.first().locator('.row-grid').getAttribute('aria-expanded'), 'true');
    await page.locator('#resetFilters').click();
    await page.locator('#itemFilter').selectOption('empty');
    assert.equal(await rows.count(), 1);
    assert.match(await rows.first().locator('.chip').first().textContent(), /2 对 1/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
