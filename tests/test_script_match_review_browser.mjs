import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const { chromium } = createRequire(import.meta.url)(process.env.MAW_TEST_PLAYWRIGHT || 'playwright');
const url = pathToFileURL(path.resolve('web/launcher/script-match-review/index.html')).href;
const cue = (index, start, end, text) => ({ index, start, end, text, disabled: false });
const fixture = {
  source: '比赛解说.mosp', script: '解说文稿.txt', beforeCount: 6, afterCount: 5, mode: 'script', lang: 'zh',
  coverage: [.92, .86], warnings: [
    '断句符号：8 个；保留：8 个。', '文稿匹配度：92%；已按字词时间码重新生成字幕段。',
    '覆盖率：文稿 92%，原字幕 86%（按可匹配字符计算）。', '1 个字幕段缺少字词时间码，已按原字幕起止时间估算。',
  ],
  groups: [
    { id: 0, start: 0, end: 2600, before: [cue(0, 0, 1100, '欢迎收看今天的比赛'), cue(1, 1500, 2600, '我们一起回顾关键回合')], after: [cue(0, 120, 2600, '欢迎收看今天的比赛。我们一起回顾关键回合。')], candidates: ['欢迎收看今天的比赛。我们一起回顾关键回合。'], issues: ['timing'], changed: true },
    { id: 1, start: 3500, end: 4900, before: [cue(2, 3500, 4900, '他确实在拿到名局的时候')], after: [cue(1, 3500, 4900, '他确实在拿到名局的时候')], candidates: ['Z'], issues: ['fragment'], changed: false },
    { id: 2, start: 6000, end: 7700, before: [cue(3, 6000, 7700, '这一局打得非常灵活')], after: [cue(2, 6000, 7700, '这一局打得非常灵活。')], candidates: ['这一局打得非常灵活。'], issues: ['estimated'], changed: true },
    { id: 3, start: 8400, end: 9600, before: [cue(4, 8400, 9600, '比赛即将结束')], after: [cue(3, 8400, 9600, '比赛即将结束')], candidates: ['比赛即将结束'], issues: [], changed: false },
    { id: 4, start: 10400, end: 12000, before: [cue(5, 10400, 12000, '感谢大家收看')], after: [cue(4, 10400, 12000, '感谢大家收看！')], candidates: ['感谢大家收看！'], issues: [], changed: true },
  ],
};

test('review filters preserve edits, timeline locates hidden groups and export sends current decisions', async () => {
  const browser = await chromium.launch({ executablePath: process.env.MAW_E2E_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 830 }, colorScheme: 'dark' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(data => {
      window.pywebview = { api: {
        review_data: async () => data,
        export_review: async payload => { window.exportedReview = payload; return { ok: true, path: 'reviewed.mosp' }; },
      } };
    }, fixture);
    await page.goto(url);
    await page.locator('#workspace').waitFor();
    assert.equal(await page.locator('#rows tr').count(), 4);
    if (process.env.MAW_REVIEW_SCREENSHOTS) await page.screenshot({ path: `${process.env.MAW_REVIEW_SCREENSHOTS}/review-dark.png`, fullPage: true });
    if (process.env.MAW_REVIEW_SCREENSHOTS) {
      await page.locator('#warnings').hover();
      await page.screenshot({ path: `${process.env.MAW_REVIEW_SCREENSHOTS}/review-notes-card.png` });
      await page.mouse.move(1, 1);
      await page.locator('#match-notes').waitFor({ state: 'hidden' });
    }
    const restore = page.getByRole('button', { name: '恢复本组原字幕' }).first();
    assert.equal(await restore.locator('svg').count(), 1);
    await restore.hover();
    await page.getByRole('tooltip').filter({ hasText: '恢复本组原字幕' }).waitFor({ timeout: 3000 });
    await restore.click();
    assert.equal(await page.getByRole('button', { name: '采用本组匹配结果' }).locator('svg').count(), 1);
    assert.match(await page.locator('#rows tr').first().locator('td').last().textContent(), /我们一起回顾关键回合/);
    const item = page.locator('#rows tr').filter({ hasText: '候选长度异常' });
    const edit = item.getByRole('button', { name: '修改字幕' });
    assert.equal(await edit.locator('svg').count(), 1);
    assert.equal(await edit.getAttribute('title'), null);
    await edit.hover();
    await page.getByRole('tooltip', { name: '修改字幕', exact: true }).waitFor({ timeout: 3000 });
    if (process.env.MAW_REVIEW_SCREENSHOTS) await page.screenshot({ path: `${process.env.MAW_REVIEW_SCREENSHOTS}/review-edit-icon.png` });
    await edit.click();
    await item.getByRole('textbox').fill('<img src=x onerror=alert(1)>人工新文本');
    await page.locator('#filter').selectOption('estimated');
    assert.match(await page.locator('#filter-hint').textContent(), /不等于音频重新对齐/);
    const filterGap = await page.locator('#filter-hint').evaluate(hint => hint.getBoundingClientRect().top - Math.max(
      ...[...hint.parentElement.children].filter(node => node !== hint).map(node => node.getBoundingClientRect().bottom),
    ));
    assert.ok(filterGap >= 8, `filter hint spacing: ${filterGap}px`);
    assert.match(await page.locator('#timeline').evaluate(canvas => canvas.getContext('2d').font), /11px ui-monospace/);
    if (process.env.MAW_REVIEW_SCREENSHOTS) await page.screenshot({ path: `${process.env.MAW_REVIEW_SCREENSHOTS}/review-filter-hint.png` });
    assert.equal(await page.locator('#rows tr').count(), 1);
    await page.locator('#filter').selectOption('manual');
    assert.match(await page.locator('#filter-hint').textContent(), /已改字或已恢复原字幕/);
    assert.equal(await page.locator('#rows tr').count(), 2);
    assert.equal(await item.locator('img').count(), 0);
    assert.match(await item.locator('td').last().textContent(), /<img src=x onerror=alert\(1\)>人工新文本/);
    await page.getByRole('button', { name: '导出调整后的 MOSP' }).click();
    await page.getByText('已另存：reviewed.mosp', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.exportedReview), {
      restore: [0], edits: [[1, 1, '<img src=x onerror=alert(1)>人工新文本']],
    });
    await page.locator('#seek').fill('9');
    await page.getByRole('button', { name: '定位', exact: true }).click();
    assert.match(await page.locator('#rows tr[data-active]').textContent(), /比赛即将结束/);
    await page.getByRole('button', { name: '切换为浅色主题' }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    if (process.env.MAW_REVIEW_SCREENSHOTS) await page.screenshot({ path: `${process.env.MAW_REVIEW_SCREENSHOTS}/review-light.png`, fullPage: true });

    for (const width of [320, 375, 414, 640, 641, 768, 1240]) {
      await page.setViewportSize({ width, height: 830 });
      const metrics = await page.evaluate(() => {
        const table = document.querySelector('.table-scroll');
        return [document.documentElement.scrollWidth, table.clientWidth, table.scrollWidth,
          Math.min(...[...document.querySelectorAll('#workspace span, #workspace td, #workspace button')].map(node => parseFloat(getComputedStyle(node).fontSize)))];
      });
      assert.ok(metrics[0] <= width, `${width}px page overflow: ${metrics}`);
      if (width < 712) assert.ok(metrics[2] > metrics[1], `${width}px table should scroll independently`);
      assert.ok(metrics[3] >= 11, `${width}px minimum font: ${metrics[3]}`);
      const [brand, theme] = await Promise.all([page.locator('.brand').boundingBox(), page.locator('[data-tool-theme]').boundingBox()]);
      assert.ok(theme.x > brand.x && theme.y + theme.height / 2 < brand.y + brand.height + 8 && width - theme.x - theme.width <= 20);
      if (width === 375 && process.env.MAW_REVIEW_SCREENSHOTS) await page.screenshot({ path: `${process.env.MAW_REVIEW_SCREENSHOTS}/review-narrow.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('long projects paginate the table and keep resize layout bounded', async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.MAW_E2E_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 830 } });
    const groups = Array.from({ length: 1800 }, (_, id) => {
      const start = id * 1500, end = start + 1200;
      return { id, start, end, before: [cue(id, start, end, '长项目原文'.repeat(6))], after: [cue(id, start + 30, end, '长项目文稿'.repeat(6))], candidates: ['长项目文稿'.repeat(6)], issues: ['timing'], changed: true };
    });
    await page.addInitScript(data => { window.pywebview = { api: { review_data: async () => data } }; }, { ...fixture, groups });
    await page.goto(url);
    await page.locator('#workspace').waitFor();
    assert.equal(await page.locator('#rows tr').count(), 50);
    const metrics = await page.evaluate(() => {
      const main = document.querySelector('main');
      const measures = [];
      for (const width of Array.from({ length: 50 }, (_, i) => 360 + i * 19)) {
        const started = performance.now();
        main.style.width = `${width}px`;
        void main.offsetHeight;
        measures.push(performance.now() - started);
      }
      measures.sort((a, b) => a - b);
      return { p95: measures[47], peak: measures[49] };
    });
    t.diagnostic(`1800 groups; 50 DOM rows; synchronous layout p95=${metrics.p95.toFixed(1)}ms; peak=${metrics.peak.toFixed(1)}ms`);
    await page.locator('#next').click();
    assert.match(await page.locator('#page-count').textContent(), /2 \/ 36/);
    assert.equal(await page.locator('#rows tr').count(), 50);
  } finally { await browser.close(); }
});

test('match notes float without resizing the table or timeline and support hover, touch and keyboard', async () => {
  const browser = await chromium.launch({ executablePath: process.env.MAW_E2E_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 830 } });
    await page.addInitScript(data => { window.pywebview = { api: { review_data: async () => data } }; }, {
      ...fixture, warnings: Array.from({ length: 20 }, () => '这是一条较长的匹配说明。'.repeat(10)),
    });
    await page.goto(url);
    await page.locator('#workspace').waitFor();
    const timeline = page.locator('.wave-panel');
    const start = await timeline.boundingBox();
    const initialTable = await page.locator('.table-scroll').boundingBox();
    const spacing = await page.evaluate(() => {
      const presets = document.querySelector('#zoom-presets');
      return { gap: presets.nextElementSibling.getBoundingClientRect().left - presets.getBoundingClientRect().right,
        vertical: document.querySelector('.wave-panel').getBoundingClientRect().top - document.querySelector('.review-content').getBoundingClientRect().bottom,
        notes: document.querySelector('#warnings').getBoundingClientRect().left - document.querySelector('#cards').getBoundingClientRect().right,
        jump: document.querySelector('.jump-timeline').getBoundingClientRect().top - document.querySelector('.range-text').getBoundingClientRect().bottom };
    });
    assert.ok(Object.values(spacing).every(gap => gap >= 8), JSON.stringify(spacing));
    const notes = page.locator('#warnings'), flyout = page.locator('#match-notes');
    assert.match(await notes.textContent(), /20 条说明/);
    await notes.hover();
    await flyout.waitFor({ state: 'visible' });
    const flyoutBox = await flyout.boundingBox();
    assert.ok(flyoutBox.height <= 320);
    assert.ok(flyoutBox.y - (await notes.boundingBox()).y - (await notes.boundingBox()).height >= 8);
    await flyout.hover();
    assert.equal(await flyout.locator('li').count(), 20);
    assert.equal(await flyout.evaluate(node => node.scrollHeight > node.clientHeight), true);
    const frame = await timeline.boundingBox();
    assert.deepEqual(frame, start);
    assert.deepEqual(await page.locator('.table-scroll').boundingBox(), initialTable);
    if (process.env.MAW_REVIEW_SCREENSHOTS) await page.screenshot({ path: `${process.env.MAW_REVIEW_SCREENSHOTS}/review-notes-hover.png` });
    await page.mouse.move(2, 2);
    await flyout.waitFor({ state: 'hidden' });
    await notes.focus();
    await flyout.waitFor({ state: 'visible' });
    await page.keyboard.press('Tab');
    assert.equal(await flyout.evaluate(node => node.matches(':focus')), true);
    await page.keyboard.press('Escape');
    assert.equal(await notes.getAttribute('aria-expanded'), 'false');
    assert.equal(await notes.evaluate(node => node.matches(':focus')), true);

    const touch = await browser.newPage({ viewport: { width: 480, height: 700 }, hasTouch: true });
    await touch.addInitScript(data => { window.pywebview = { api: { review_data: async () => data } }; }, fixture);
    await touch.goto(url);
    await touch.locator('#warnings').tap();
    const touchPanel = touch.locator('#match-notes');
    const touchBox = await touchPanel.boundingBox();
    assert.ok(touchBox.x >= 8 && touchBox.x + touchBox.width <= 472);
    await touch.locator('#warnings').tap();
    assert.equal(await touchPanel.isVisible(), false);
    await touch.close();
    await page.locator('#seek').fill('3');
    await page.getByRole('button', { name: '定位', exact: true }).click();
    assert.equal(await page.locator('.wave-head #seek-feedback').textContent(), '该时间没有可定位的字幕。');
    assert.equal(await page.locator('#feedback').isVisible(), false);
    assert.deepEqual(await timeline.boundingBox(), frame);
    if (process.env.MAW_REVIEW_SCREENSHOTS) await page.screenshot({ path: `${process.env.MAW_REVIEW_SCREENSHOTS}/review-timeline-hint.png` });
    await page.setViewportSize({ width: 1240, height: 520 });
    const smaller = await timeline.boundingBox();
    assert.equal(smaller.height, start.height);
    assert.equal(smaller.y, start.y - 310);
    assert.ok((await page.locator('.table-scroll').boundingBox()).height < initialTable.height);
    if (process.env.MAW_REVIEW_SCREENSHOTS) await page.screenshot({ path: `${process.env.MAW_REVIEW_SCREENSHOTS}/review-timeline-short.png` });

    for (const width of [320, 375, 480, 640, 768, 1240]) {
      await page.setViewportSize({ width, height: 520 });
      const bounds = await timeline.boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 520, `${width}: ${JSON.stringify(bounds)}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), 520);
      assert.ok((await page.locator('.table-scroll').boundingBox()).height >= 48);
    }
    await page.locator('#seek').fill('9');
    await page.getByRole('button', { name: '定位', exact: true }).click();
    assert.equal(await page.locator('#seek-feedback').textContent(), '');
    // Even when the clip is shorter than the preset, one minute is one
    // minute: the remaining width is an empty part of the time ruler.
    await page.getByRole('button', { name: '1 分钟窗口' }).click();
    await page.locator('#timeline').click({ position: { x: 275, y: 33 } });
    assert.equal(await page.locator('#seek-feedback').textContent(), '该时间没有可定位的字幕。');
  } finally { await browser.close(); }
});

test('pagination never flashes a page scrollbar or covers the pager', async () => {
  const browser = await chromium.launch({ executablePath: process.env.MAW_E2E_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 700 } });
    const groups = Array.from({ length: 1800 }, (_, id) => {
      const start = id * 1500, end = start + 1200;
      return { id, start, end, before: [cue(id, start, end, '长项目原文')], after: [cue(id, start + 30, end, '长项目文稿')], candidates: ['长项目文稿'], issues: ['timing'], changed: true };
    });
    await page.addInitScript(data => { window.pywebview = { api: { review_data: async () => data } }; }, {
      ...fixture, groups, warnings: ['匹配说明一条'],
    });
    await page.goto(url);
    await page.locator('#workspace').waitFor();
    await page.evaluate(() => {
      window.overflowFrames = 0;
      const doc = document.documentElement;
      const review = document.querySelector('.review-content');
      const loop = () => {
        if (doc.scrollHeight > doc.clientHeight || doc.scrollTop > 0
          || getComputedStyle(review).overflowY === 'auto' || getComputedStyle(review).overflowY === 'scroll') window.overflowFrames += 1;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    let expectedPage = 0;
    for (const [width, height] of [[640, 700], [480, 520], [480, 700], [768, 520], [1240, 400], [1240, 830]]) {
      expectedPage += 1;
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(80);
      await page.locator('#next').click();
      await page.locator('#next').click();
      await page.locator('#prev').click();
      const state = await page.evaluate(() => {
        const doc = document.documentElement;
        const next = document.querySelector('#next').getBoundingClientRect();
        const hit = document.elementFromPoint(next.left + next.width / 2, next.top + next.height / 2);
        return {
          docScrollH: doc.scrollHeight, innerH: window.innerHeight,
          nextHittable: hit && (hit.closest('#next') !== null || hit.closest('.pager') !== null),
        };
      });
      assert.equal(state.docScrollH, state.innerH, JSON.stringify({ width, height, ...state }));
      assert.ok(state.nextHittable, `${width}x${height}: next button covered: ${JSON.stringify(state)}`);
      assert.match(await page.locator('#page-count').textContent(), new RegExp(`第 ${expectedPage + 1} / 36 页`));
    }
    assert.equal(await page.evaluate(() => window.overflowFrames), 0);
  } finally { await browser.close(); }
});

test('seamless cues stay countable on the timeline and hover singles one out', async () => {
  const browser = await chromium.launch({ executablePath: process.env.MAW_E2E_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 830 }, colorScheme: 'dark' });
    await page.addInitScript(data => { window.pywebview = { api: { review_data: async () => data } }; }, {
      ...fixture,
      groups: [
        { id: 0, start: 0, end: 3000, before: [cue(0, 0, 1000, '一'), cue(1, 1000, 2000, '二'), cue(2, 2000, 3000, '三')], after: [cue(0, 0, 3000, '一二三。')], candidates: ['一二三。'], issues: [], changed: true },
        { id: 1, start: 3000, end: 6000, before: [cue(3, 3000, 4000, '四'), cue(4, 4000, 5000, '五')], after: [cue(1, 3000, 4500, '四。'), cue(2, 4500, 6000, '五。')], candidates: ['四。', '五。'], issues: [], changed: true },
        { id: 2, start: 6000, end: 12000, before: [cue(5, 6000, 12000, '尾部')], after: [cue(3, 6000, 12000, '尾部。')], candidates: ['尾部。'], issues: [], changed: true },
      ],
    });
    await page.goto(url);
    await page.locator('#workspace').waitFor();
    await page.getByRole('button', { name: '10 秒窗口' }).click();
    await page.waitForFunction(() => document.querySelector('#timeline').getBoundingClientRect().width > 0);

    const sample = await page.evaluate(() => {
      const canvas = document.querySelector('#timeline');
      const ctx = canvas.getContext('2d');
      const box = canvas.getBoundingClientRect();
      const width = box.width, windowStart = 0, windowSpan = 10000;
      const px = ms => (ms - windowStart) * width / windowSpan;
      const read = (x, y) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data);
      return {
        cueOne: read(px(500), 36), cueTwo: read(px(1500), 36), cueThree: read(px(2500), 36),
        seamA: read(px(1000), 36), seamB: read(px(2000), 36),
        afterTrack: read(px(500), 60), afterSeam: read(px(3000), 60),
      };
    });
    const isSeries = pixel => {
      const [r, g, b, a] = pixel;
      return Math.abs(r - 108) < 45 && Math.abs(g - 165) < 45 && Math.abs(b - 232) < 45 && a > 80;
    };
    const isGreen = pixel => {
      const [r, g, b, a] = pixel;
      return Math.abs(r - 87) < 45 && Math.abs(g - 201) < 45 && Math.abs(b - 147) < 45 && a > 80;
    };
    assert.ok(isSeries(sample.cueOne), JSON.stringify(sample.cueOne));
    assert.ok(isSeries(sample.cueTwo), JSON.stringify(sample.cueTwo));
    // 相邻块明暗交替，数块数不依赖缝隙。
    assert.ok(Math.abs(sample.cueOne[3] - sample.cueTwo[3]) > 50, JSON.stringify(sample));
    assert.ok(Math.abs(sample.cueTwo[3] - sample.cueThree[3]) > 50, JSON.stringify(sample));
    // 无缝相接处的发丝缝不画字幕色（可能是背景或网格线，但绝不是系列色）。
    assert.ok(!isSeries(sample.seamA) && !isSeries(sample.seamB), JSON.stringify(sample));
    assert.ok(!isSeries(sample.afterSeam), JSON.stringify(sample));
    assert.ok(isGreen(sample.afterTrack), JSON.stringify(sample.afterTrack));

    const target = await page.evaluate(() => {
      const box = document.querySelector('#timeline').getBoundingClientRect();
      const px = (box.width / 10000) * 1500;
      return { x: box.left + px, y: box.top + 36 };
    });
    await page.mouse.move(target.x, target.y);
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#timeline');
      const box = canvas.getBoundingClientRect();
      const b = Math.round(box.width / 10000 * 1000);
      for (const x of [b, b + 1]) {
        const [r, g, b2] = Array.from(canvas.getContext('2d').getImageData(x, 36, 1, 1).data);
        if (Math.abs(r - 240) < 45 && Math.abs(g - 154) < 45 && Math.abs(b2 - 80) < 45) return true;
      }
      return false;
    });
    if (process.env.MAW_REVIEW_SCREENSHOTS) await page.screenshot({ path: `${process.env.MAW_REVIEW_SCREENSHOTS}/review-timeline-hover.png` });
    await page.mouse.move(target.x, target.y - 25);
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#timeline');
      const box = canvas.getBoundingClientRect();
      const b = Math.round(box.width / 10000 * 1000);
      for (let x = b - 1; x <= b + 2; x++) {
        const [r, g, b2] = Array.from(canvas.getContext('2d').getImageData(x, 36, 1, 1).data);
        if (Math.abs(r - 240) < 45 && Math.abs(g - 154) < 45 && Math.abs(b2 - 80) < 45) return false;
      }
      return true;
    });
  } finally { await browser.close(); }
});

test('zoom presets show exact time spans and support subsecond zoom on a long project', async () => {
  const browser = await chromium.launch({ executablePath: process.env.MAW_E2E_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 650 } });
    const duration = 3600000;
    const last = cue(6, duration - 1000, duration, '最后一句');
    await page.addInitScript(data => { window.pywebview = { api: { review_data: async () => data } }; }, {
      ...fixture, groups: [...fixture.groups, { id: 5, start: last.start, end: last.end, before: [last], after: [last], candidates: [last.text], changed: false, issues: [] }],
    });
    await page.goto(url);
    await page.locator('#workspace').waitFor();
    const scroller = page.locator('#wave-scroll');
    async function measure() {
      return scroller.evaluate(node => ({ width: node.clientWidth, total: node.scrollWidth,
        left: node.scrollLeft, canvasWidth: node.querySelector('canvas').getBoundingClientRect().width }));
    }
    for (const [name, seconds] of [['10 秒窗口', 10], ['30 秒窗口', 30], ['1 分钟窗口', 60]]) {
      const preset = page.getByRole('button', { name });
      await preset.click();
      assert.equal(await preset.getAttribute('aria-pressed'), 'true');
      const { width, total, left, canvasWidth } = await measure();
      assert.ok(Math.abs(total - width * duration / (seconds * 1000)) <= 1);
      assert.equal(canvasWidth, width);
      assert.equal(left, 0);
    }
    await page.getByRole('button', { name: '10 秒窗口' }).click();
    const beforeWheelZoom = await measure();
    const wheelBox = await page.locator('#timeline').boundingBox();
    const wheelX = 0.35;
    await page.mouse.move(wheelBox.x + wheelBox.width * wheelX, wheelBox.y + 32);
    await page.keyboard.down('Control');
    try {
      await page.mouse.wheel(0, -100);
      await page.waitForFunction(previous => document.querySelector('#wave-scroll').scrollWidth > previous, beforeWheelZoom.total);
      const afterWheelZoom = await measure();
      const timeAtPointer = ({left, width, total}) => (left + width * wheelX) / total * duration;
      assert.ok(Math.abs(timeAtPointer(afterWheelZoom) - timeAtPointer(beforeWheelZoom)) < 20);
      await page.mouse.wheel(0, 100);
      await page.waitForFunction(previous => document.querySelector('#wave-scroll').scrollWidth === previous, beforeWheelZoom.total);
    } finally { await page.keyboard.up('Control'); }
    for (let i = 0; i < 5; i++) await page.locator('#zoom-in').click();
    assert.equal(await page.locator('#zoom-in').isDisabled(), true);
    const finest = await measure();
    assert.equal(finest.total, finest.width * duration / 500);

    // 普通滚轮在时间线上横向平移：向下滚动向右，向上滚动向左，
    // 不带动整页滚动；Shift 交给浏览器的原生横向映射。
    const canvasBox = await page.locator('#timeline').boundingBox();
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + 40);
    await page.mouse.wheel(0, 600);
    await page.waitForFunction(() => document.querySelector('#wave-scroll').scrollLeft > 0);
    const pannedRight = await measure();
    assert.ok(pannedRight.left > 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollTop), 0);
    await page.mouse.wheel(0, -300);
    await page.waitForFunction(() => window.scrollY === 0 && document.querySelector('#wave-scroll').scrollLeft >= 0);
    const pannedLeft = await measure();
    assert.ok(pannedLeft.left < pannedRight.left);
    await page.evaluate(() => { document.querySelector('#wave-scroll').scrollLeft = 0; });
    await page.locator('#filter').selectOption('all');
    await page.locator('#search').fill('最后一句');
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1);
    const row = page.locator('#rows tr').filter({ hasText: '最后一句' });
    const jump = row.getByRole('button', { name: '跳转到时间线位置' });
    assert.equal(await jump.locator('svg').count(), 1);
    await jump.hover();
    await page.getByRole('tooltip').filter({ hasText: '跳转到时间线位置' }).waitFor();
    await jump.click();
    assert.equal(await page.locator('#search').inputValue(), '最后一句');
    assert.equal(await page.locator('#rows tr').count(), 1);
    assert.equal(await jump.evaluate(node => node.matches(':focus')), true);
    assert.equal(await row.getAttribute('data-active'), '');
    assert.equal(await page.locator('#seek').inputValue(), '3599');
    const jumped = await measure();
    assert.equal(jumped.total, finest.total);
    assert.ok(jumped.left > jumped.total - 4 * jumped.width);
    if (process.env.MAW_REVIEW_SCREENSHOTS) await page.screenshot({ path: `${process.env.MAW_REVIEW_SCREENSHOTS}/review-row-jump.png` });
    await scroller.evaluate(node => { node.scrollLeft = node.scrollWidth; });
    const canvas = page.locator('#timeline');
    const box = await canvas.boundingBox();
    assert.equal(box.x, (await scroller.boundingBox()).x);
    await canvas.click({ position: { x: Math.floor(box.width / 2), y: 33 } });
    assert.match(await page.locator('#rows tr[data-active]').textContent(), /最后一句/);
    assert.ok(Number(await page.locator('#seek').inputValue()) > 3599.5);
    await page.setViewportSize({ width: 900, height: 650 });
    await page.waitForFunction(() => document.querySelector('#timeline').getBoundingClientRect().width === document.querySelector('#wave-scroll').clientWidth);
    const resized = await measure();
    assert.equal(resized.left, resized.total - resized.width);
    await page.getByRole('button', { name: '重置缩放' }).click();
    const reset = await measure();
    assert.equal(reset.width, reset.total);
    assert.equal(reset.left, 0);
    const seek = page.locator('#seek');
    const locate = page.getByRole('button', { name: '定位', exact: true });
    await page.getByRole('button', { name: '1 分钟窗口' }).click();
    await seek.fill('120');
    await locate.click();
    assert.equal(await page.getByRole('button', { name: '30 秒窗口' }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#seek-feedback').textContent(), '该时间没有可定位的字幕。');
    await page.getByRole('button', { name: '重置缩放' }).click();
    await seek.fill('3599');
    await locate.click();
    assert.equal(await page.getByRole('button', { name: '30 秒窗口' }).getAttribute('aria-pressed'), 'true');
    const located = await measure();
    assert.equal(located.left, located.total - located.width);
    assert.match(await page.locator('#rows tr[data-active]').textContent(), /最后一句/);
    await page.getByRole('button', { name: '10 秒窗口' }).click();
    await seek.fill('0.5');
    await locate.click();
    assert.equal(await page.getByRole('button', { name: '10 秒窗口' }).getAttribute('aria-pressed'), 'true');
    assert.equal((await measure()).left, 0);
    assert.match(await page.locator('#rows tr[data-active]').textContent(), /欢迎收看今天的比赛/);
  } finally { await browser.close(); }
});
