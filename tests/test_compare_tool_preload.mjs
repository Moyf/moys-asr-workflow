import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const { chromium } = createRequire(import.meta.url)(process.env.MAW_TEST_PLAYWRIGHT || 'playwright');
const pageUrl = name => pathToFileURL(path.resolve('tools', name)).href;
const project = {
  schema: 'moy.asr.project.v2',
  timebase: { unit: 'frames', fps: 25 },
  tracks: [{ role: 'overlay', segments: [] }, { role: 'main', segments: [
    { id: 'main-001', start: 0, end: 900, text: '第一句文稿', items: [{ start: 0, end: 450, text: '第一句' }, { start: 450, end: 900, text: '文稿' }] },
    { id: 'main-002', start: 1200, end: 2100, text: '第二句文稿', items: [{ start: 1200, end: 2100, text: '第二句文稿' }] },
  ] }],
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
    await page.waitForFunction(() => document.querySelectorAll('#cards .card').length === 2);
    assert.deepEqual(await page.locator('#cards .name').evaluateAll(names => names.map(name => name.title)), ['原始.mosp', '结果.srt']);
    assert.equal(await page.evaluate(() => Object.hasOwn(window, 'MAWCompare')), false);
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
    await page.waitForFunction(() => document.querySelectorAll('#cards .file-card').length === 2);
    assert.equal(await page.locator('#empty').isVisible(), false);
    assert.equal(await page.locator('.file-cards .card, #cards > *').count(), 2);
    await page.waitForFunction(() => document.querySelectorAll('#tableWrap tr, .row-grid').length > 0);
    const summaryVisible = await page.locator('#summary').isVisible();
    assert.equal(summaryVisible, true);
    assert.equal(await page.locator('.file-card').first().locator('.stat-value').first().textContent(), '2');
    assert.equal(await page.evaluate(() => Object.hasOwn(window, 'MAWTsCompare')), false);
    assert.match(await page.locator('.card-timebase').first().innerText(), /25 fps/);
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
