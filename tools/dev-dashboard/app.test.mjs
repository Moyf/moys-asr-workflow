// 真实 Chromium + 本地路由夹具：不启动服务、不调用 gh，也不改维护者的状态文件。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const ORIGIN = 'http://127.0.0.1:8262';
const assets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html'],
  ['/app.js', 'app.js', 'text/javascript'],
  ['/marked-15.0.12.min.js', 'marked-15.0.12.min.js', 'text/javascript'],
  ['/style.css', 'style.css', 'text/css'],
  ['/shared/tool-page.css', '../shared/tool-page.css', 'text/css'],
  ['/shared/tool-page.js', '../shared/tool-page.js', 'text/javascript'],
].map(async ([url, file, contentType]) => [url, {
  body: await readFile(new URL(file, import.meta.url), 'utf8'),
  contentType,
}])));
const LONG_BODY = '# 改动说明\n\n保留换行与 Markdown 源文。\n'
  + '<img src="https://example.invalid/tracker" onerror="window.previewExecuted=true">\n'
  + '<script>window.previewExecuted=true</script>\n\n'
  + Array.from({ length: 80 }, (_, i) => `- 第 ${i + 1} 条验证内容`).join('\n')
  + '\n' + 'long-branch-'.repeat(120);
function makePr(number, body = LONG_BODY) {
  return {
    number, title: `PR ${number} 预览测试`, body,
    url: `https://github.com/test/repo/pull/${number}`,
    author: { login: 'test' }, milestone: { title: 'next' },
    headRefName: 'preview', baseRefName: 'main', updatedAt: '2026-11-10T00:00:00Z',
  };
}

let browser;
before(async () => { browser = await chromium.launch({ timeout: 20_000 }); });
after(async () => { await browser?.close(); });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function openDashboard(t, {
  prs = [makePr(42)], statusMap = {}, viewport, pending = {}, failures = {}, waitForLoad = true, clock = false, missingParser = false,
} = {}) {
  const page = await browser.newPage({ viewport: viewport ?? { width: 1280, height: 800 } });
  t.after(() => page.close());
  if (clock) {
    const time = new Date('2026-11-10T00:00:00Z');
    await page.clock.install({ time });
    await page.clock.pauseAt(time);
  }
  const apiCalls = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], '页面不应出现运行时错误'));
  const data = { prs, statusMap, ignored: {}, checklists: [], pending, failures };
  await page.route(`${ORIGIN}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (missingParser && pathname === '/marked-15.0.12.min.js') return route.fulfill({ status: 404, body: 'Not Found' });
    if (pathname.startsWith('/api/')) {
      apiCalls.push(pathname);
      await data.pending[pathname];
      if (data.failures[pathname]) return route.fulfill({ status: 500, json: { error: data.failures[pathname] } });
      const payload = {
        '/api/prs': data.prs, '/api/status': data.statusMap,
        '/api/ignored': data.ignored, '/api/checklists': data.checklists,
      }[pathname];
      return route.fulfill({ json: payload });
    }
    const asset = assets.get(pathname);
    if (!asset) return route.abort();
    return route.fulfill({ ...asset, headers: {
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
    } });
  });
  await page.goto(ORIGIN);
  if (waitForLoad) {
    await expect(page.locator('.card')).toHaveCount(prs.length);
    await expect(page.locator('#refresh-btn')).toBeEnabled();
  }
  return { page, apiCalls, data };
}

test('悬停卡片显示安全的正文，浮层可停留滚动且不额外请求', async (t) => {
  const { page, apiCalls } = await openDashboard(t);
  const preview = page.locator('#pr-preview');
  await expect(preview).toBeHidden();
  const callsBefore = apiCalls.length;
  await page.locator('.card').hover();
  await expect(preview).toBeVisible();
  await expect(page.locator('#pr-preview-body h1')).toHaveText('改动说明');
  assert.equal(await preview.locator('img, script').count(), 0);
  assert.equal(await page.evaluate(() => window.previewExecuted), undefined);
  await preview.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.locator('#pr-preview-body').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(preview).toBeVisible();
  assert.equal(apiCalls.length, callsBefore, 'hover 和阅读正文不能增加 API 请求');
  await page.mouse.move(5, 5);
  await expect(preview).toBeHidden();
});

test('正文支持 Markdown 结构且不执行外部内容', async (t) => {
  const body = '## 背景\n\n中文段落和 *斜体*。\n\n## 三处对照结论\n\n1. **`<timecode>` 必填（真实缺陷，已修）**\n   - 内联 `<file id="x"/>`\n\n- [x] 完成\n- [ ] 待办\n\n| 名称 | 值 |\n| --- | --- |\n| a | b |\n\n> 引用\n\n```xml\n<file>\n```\n\n[安全](https://example.com/a) [危险](javascript:alert(1))\n\n![图片](https://example.invalid/tracker)\n\n<img src="https://example.invalid/x" onerror="window.previewExecuted=true">';
  const { page } = await openDashboard(t, { prs: [makePr(42, body)] });
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.locator('.card-title').focus();
  const preview = page.locator('#pr-preview-body');
  await expect(preview.locator('h2')).toHaveCount(2);
  await expect(preview.locator('strong code')).toHaveText('<timecode>');
  await expect(preview.locator('ol ul code')).toHaveText('<file id="x"/>');
  await expect(preview.locator('table tbody tr')).toHaveCount(1);
  await expect(preview.locator('input[type=checkbox]')).toHaveCount(2);
  await expect(preview.locator('pre code')).toHaveText('<file>\n');
  await expect(preview.locator('blockquote')).toContainText('引用');
  await expect(preview.locator('a')).toHaveCount(1);
  await expect(preview.locator('a')).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(preview.locator('img,script,svg')).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.previewExecuted), undefined);
  assert.deepEqual(requests, []);
  const gaps = await page.locator('#pr-preview').evaluate((el) => {
    const title = el.querySelector('#pr-preview-title').getBoundingClientRect();
    const hint = el.querySelector('#pr-preview-hint').getBoundingClientRect();
    const bodyRect = el.querySelector('#pr-preview-body').getBoundingClientRect();
    return { titleHint: hint.top - title.bottom, hintBody: bodyRect.top - hint.bottom };
  });
  assert.ok(gaps.titleHint >= 8 && gaps.hintBody >= 8, JSON.stringify(gaps));
  console.log('Markdown preview spacing (px):', JSON.stringify(gaps));
  if (process.env.MAW_DASHBOARD_SCREENSHOTS) {
    await mkdir('.artifacts/dev-dashboard-preview', { recursive: true });
    await page.screenshot({ path: '.artifacts/dev-dashboard-preview/markdown.png' });
  }
});

test('链接目标先解码 Markdown 实体再校验协议，不执行 HTML 或发出请求', async (t) => {
  const body = '[query](https://example.com/a?x=1&amp;y=2) [path](https://example.com/&#x61;) '
    + '[slashes](https:&#x2f;&#x2f;example.com/ok) [evil-js](jav&#x61;script:alert) '
    + '[evil-relative](&#x2f;&#x2f;evil.invalid/x) [evil-mixed](java&#x73;cript%3aalert) '
    + '[evil-backslash](https:&#x2f;&#x5c;evil.invalid/x)\n\n'
    + '<img src="https://evil.invalid/track" onerror="window.previewExecuted=1">'
    + '<script>window.previewExecuted=2</script>';
  const { page } = await openDashboard(t, { prs: [makePr(42, body)] });
  const requests = [];
  page.on('request', (req) => requests.push(req.url()));
  await page.locator('.card-title').focus();
  const preview = page.locator('#pr-preview-body');
  await expect(preview.getByRole('link', { name: 'query' })).toHaveAttribute('href', 'https://example.com/a?x=1&y=2');
  await expect(preview.getByRole('link', { name: 'path' })).toHaveAttribute('href', 'https://example.com/a');
  await expect(preview.getByRole('link', { name: 'slashes' })).toHaveAttribute('href', 'https://example.com/ok');
  for (const name of ['evil-js', 'evil-relative', 'evil-mixed', 'evil-backslash']) {
    await expect(preview.getByRole('link', { name })).toHaveCount(0);
    await expect(preview).toContainText(name);
  }
  await expect(preview.locator('img,script,svg')).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.previewExecuted), undefined);
  assert.deepEqual(requests, []);
});

test('危险协议、原始 HTML 和远程图片不能执行或触发网络', async (t) => {
  const body = '[ok](https://example.com/x) [js](javascript:alert%281%29) [encoded](java&#x73;cript:alert) [double](java%2573cript:alert) [data](data:text/html,x) [file](file:///test) [relative](//example.invalid/a) [slash](https:\\\\example.invalid/x)\n\n![追踪](https://example.invalid/image)\n\n<svg onload="window.previewExecuted=1"><script>window.previewExecuted=2</script></svg>\n\n&lt;/textarea&gt;&lt;img src="https://example.invalid/entity" onerror="window.previewExecuted=3"&gt;';
  const { page } = await openDashboard(t, { prs: [makePr(42, body)] });
  const requests = [];
  page.on('request', (req) => requests.push(req.url()));
  await page.locator('.card-title').focus();
  const preview = page.locator('#pr-preview-body');
  const links = await preview.locator('a').evaluateAll((nodes) => nodes.map((node) => ({ href: node.href, target: node.target, rel: node.rel })));
  assert.ok(links.some((link) => link.href === 'https://example.com/x'));
  assert.ok(links.every((link) => /^https?:\/\//.test(link.href) && link.target === '_blank' && link.rel === 'noopener noreferrer'));
  await expect(preview).toContainText('追踪');
  await expect(preview.locator('img,svg,script')).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.previewExecuted), undefined);
  assert.deepEqual(requests, []);
});

test('旧服务缺少解析器时降级显示原文和重启提示', async (t) => {
  const { page } = await openDashboard(t, { prs: [makePr(42, '## 标题\n\n正文')], missingParser: true });
  await page.locator('.card-title').focus();
  await expect(page.locator('#pr-preview-body')).toContainText('Markdown 预览不可用，请重启看板服务后刷新');
  await expect(page.locator('#pr-preview-body')).toContainText('## 标题');
});

test('快速移出不弹出旧正文，区分空白、null 与缺失正文，切换卡片更新内容', async (t) => {
  const missing = makePr(44);
  delete missing.body;
  const { page } = await openDashboard(t, {
    prs: [makePr(42), makePr(43, ' \n '), missing, makePr(45, null), makePr(46, '')],
    viewport: { width: 1280, height: 1400 },
  });
  const preview = page.locator('#pr-preview');
  await page.locator('[data-pr="42"] .card-title').hover();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(450);
  await expect(preview).toBeHidden();
  for (const number of [43, 45, 46, 44, 42]) {
    await page.locator(`[data-pr="${number}"] .card-title`).hover();
    await expect(preview).toBeVisible();
    await expect(page.locator('#pr-preview-title')).toContainText(`#${number}`);
    if (number === 42) await expect(page.locator('#pr-preview-body h1')).toHaveText('改动说明');
    else assert.equal(await page.locator('#pr-preview-body').textContent(), number === 44
      ? '此 PR 正文尚未获取。请重启看板服务后刷新；仅刷新网页不会更新后端。' : '此 PR 暂无正文。');
  }
});

test('缺失或非法 body 显示服务不匹配告警，真空正文无告警，恢复后清除', async (t) => {
  const { page, data, apiCalls } = await openDashboard(t, {
    prs: [makePr(42, ''), makePr(43, ' \n '), makePr(44, null)],
  });
  const banner = page.locator('#banner');
  await expect(banner).toBeHidden();
  for (const body of [undefined, 42, false, {}, []]) {
    data.prs = [{ ...makePr(42), body }];
    await page.evaluate(() => refresh());
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('看板服务与页面不匹配');
    await expect(banner).toContainText('重启看板服务');
    await expect(banner).toContainText('仅刷新网页不会更新后端');
    const callsBefore = apiCalls.length;
    await page.locator('.card-title').focus();
    await expect(page.locator('#pr-preview-body')).toContainText('正文尚未获取');
    assert.equal(apiCalls.length, callsBefore, '缺字段不能触发逐 PR 补取请求');
    if (body === undefined && process.env.MAW_DASHBOARD_SCREENSHOTS) {
      await mkdir('.artifacts/dev-dashboard-preview', { recursive: true });
      await page.screenshot({ path: '.artifacts/dev-dashboard-preview/unavailable-body.png' });
    }
  }
  data.prs = [makePr(42, '恢复后的正文')];
  await page.evaluate(() => refresh());
  await expect(banner).toBeHidden();
  await page.locator('.card-title').focus();
  await expect(page.locator('#pr-preview-body')).toHaveText('恢复后的正文');
});

test('键盘聚焦可预览并进入正文阅读，Escape 关闭且保留 PR 链接行为', async (t) => {
  const { page } = await openDashboard(t, { prs: [makePr(42, null)] });
  const title = page.locator('.card-title');
  const preview = page.locator('#pr-preview');
  await title.focus();
  await expect(preview).toBeVisible();
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  await title.press('ArrowDown');
  await expect(page.locator('#pr-preview-body')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  await expect(title).toHaveAttribute('href', makePr(42).url);
  await expect(title).toHaveAttribute('target', '_blank');
});

test('刷新、过滤、拖拽、看板滚动与窗口缩放清理浮层和待弹出计时器', async (t) => {
  const { page, data } = await openDashboard(t);
  const preview = page.locator('#pr-preview');
  const card = page.locator('.card');
  await card.hover();
  await expect(preview).toBeVisible();
  await card.dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  await expect(preview).toBeHidden();
  await card.dispatchEvent('dragend');

  data.prs = [makePr(42, '更新后的正文')];
  await page.locator('#refresh-btn').click();
  await card.hover();
  await expect(page.locator('#pr-preview-body')).toHaveText('更新后的正文');
  await expect(preview).toBeVisible();
  await page.locator('.board').evaluate((el) => { el.scrollLeft = 30; });
  await expect(preview).toBeHidden();

  await page.locator('.card-title').focus();
  await expect(preview).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(preview).toBeHidden();
  await page.mouse.move(5, 5);
  await card.hover();
  await page.locator('#search').fill('不存在的 PR');
  await page.waitForTimeout(450);
  await expect(preview).toBeHidden();
  await expect(card).toHaveCount(0);
});

test('长正文在宽屏、窄屏、矮窗口与最右列均不越界，内容在浮层内滚动', async (t) => {
  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 800 }],
    ['narrow', { width: 360, height: 640 }],
    ['short', { width: 900, height: 300 }],
  ]) {
    const { page } = await openDashboard(t, { viewport, statusMap: { '42': 'pass' } });
    await page.locator('.card').hover();
    const preview = page.locator('#pr-preview');
    await expect(preview).toBeVisible();
    const metrics = await preview.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const body = document.getElementById('pr-preview-body');
      const title = document.getElementById('pr-preview-title').getBoundingClientRect();
      const hint = document.getElementById('pr-preview-hint').getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      return {
        x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
        pageWidth: document.documentElement.scrollWidth,
        gap: hint.top - title.bottom,
        bodyGap: bodyRect.top - hint.bottom,
        scrollable: body.scrollHeight > body.clientHeight,
      };
    });
    assert.ok(metrics.x >= 0 && metrics.y >= 0, `${name}: 左上边界`);
    assert.ok(metrics.right <= viewport.width && metrics.bottom <= viewport.height, `${name}: 右下边界`);
    assert.ok(metrics.pageWidth <= viewport.width, `${name}: 页面不应被正文撑宽`);
    assert.ok(metrics.gap >= 8, `${name}: 标题与提示间距至少 8px（实际 ${metrics.gap}px）`);
    assert.ok(metrics.bodyGap >= 8, `${name}: 提示与正文间距至少 8px（实际 ${metrics.bodyGap}px）`);
    console.log(`${name} preview spacing (px):`, metrics.gap, metrics.bodyGap);
    assert.equal(metrics.scrollable, true);
    if (process.env.MAW_DASHBOARD_SCREENSHOTS) {
      await mkdir('.artifacts/dev-dashboard-preview', { recursive: true });
      await page.screenshot({ path: `.artifacts/dev-dashboard-preview/${name}.png` });
    }
    await page.close();
  }
});

test('浮层不遮挡原卡片，Escape 原地关闭后不重开，原标题仍可实际点击', async (t) => {
  for (const viewport of [{ width: 1000, height: 700 }, { width: 360, height: 640 }]) {
    const { page } = await openDashboard(t, { viewport, statusMap: { '42': 'backlog' } });
    await page.context().route('https://github.com/test/repo/**', (route) => route.fulfill({
      contentType: 'text/html', body: '<title>Mock GitHub PR</title>',
    }));
    const title = page.locator('.card-title');
    const preview = page.locator('#pr-preview');
    await title.hover();
    await expect(preview).toBeVisible();
    const rect = await title.boundingBox();
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const titleClickable = await page.evaluate(({ x, y }) =>
      Boolean(document.elementFromPoint(x, y)?.closest('.card-title')), center);
    assert.equal(titleClickable, true, `${viewport.width}px: 浮层不能挡住原标题`);
    const noOverlap = await preview.evaluate((el) => {
      const popup = el.getBoundingClientRect();
      const card = document.querySelector('.card').getBoundingClientRect();
      return popup.right <= card.left || popup.left >= card.right
        || popup.bottom <= card.top || popup.top >= card.bottom;
    });
    assert.equal(noOverlap, true, '不能妨碍原卡片的链接、按钮和拖拽');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(450);
    await expect(preview).toBeHidden();
    const popupPromise = page.waitForEvent('popup');
    await page.mouse.click(center.x, center.y);
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    assert.equal(popup.url(), makePr(42).url);
    await popup.close();
    await page.close();
  }
});

test('Tab 聚焦横向屏外标题时，自动滚动结束后仍显示正文预览', async (t) => {
  const { page } = await openDashboard(t, { statusMap: { '42': 'pass' } });
  await page.locator('#reset-filters').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('.card-title')).toBeFocused();
  await expect.poll(() => page.locator('.board').evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await page.waitForTimeout(450);
  await expect(page.locator('#pr-preview')).toBeVisible();
  await expect(page.locator('.card-title')).toHaveAttribute('aria-expanded', 'true');
});

test('首次慢读取显示原生不定进度与可访问状态，宽窄屏间距至少 8px，成功后清理', async (t) => {
  for (const width of [1280, 360]) {
    const gate = deferred();
    t.after(gate.resolve);
    const { page, apiCalls } = await openDashboard(t, {
      viewport: { width, height: 800 }, pending: { '/api/prs': gate.promise }, waitForLoad: false,
    });
    const loading = page.locator('#loading-status');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading).toHaveAttribute('aria-live', 'polite');
    await expect(loading).toContainText('正在读取看板数据');
    const progress = loading.locator('progress');
    await expect(progress).toBeVisible();
    assert.equal(await progress.getAttribute('value'), null, 'gh 没有真实百分比，不设置 value');
    assert.equal(await progress.getAttribute('aria-valuenow'), null);
    assert.equal(await progress.evaluate((el) => el.position), -1, '原生 progress 必须处于不定模式');
    await expect(progress).toHaveAccessibleName('看板数据加载进度');
    await expect(page.locator('#refresh-btn')).toBeDisabled();
    await expect(page.locator('#refresh-btn')).toHaveText('读取中…');
    await expect(page.locator('#board')).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => apiCalls.length).toBe(4);
    const metrics = await loading.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return {
        titleGap: rect.top - document.querySelector('#topbar h1').getBoundingClientRect().bottom,
        headerGap: rect.top - document.getElementById('topbar').getBoundingClientRect().bottom,
        toolbarGap: document.getElementById('milestone-filter').getBoundingClientRect().top - rect.bottom,
        pageWidth: document.documentElement.scrollWidth,
      };
    });
    for (const key of ['titleGap', 'headerGap', 'toolbarGap']) assert.ok(metrics[key] >= 8, `${key}: ${metrics[key]}px`);
    assert.ok(metrics.pageWidth <= width, '进度行不能撑宽页面');
    console.log(`loading-layout ${width}px ${JSON.stringify(metrics)}`);
    if (process.env.MAW_DASHBOARD_SCREENSHOTS) {
      await mkdir('.artifacts/dev-dashboard-preview', { recursive: true });
      await page.screenshot({ path: `.artifacts/dev-dashboard-preview/loading-${width}.png` });
    }
    gate.resolve();
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(loading).toBeHidden();
    await expect(progress).toBeHidden();
    await expect(page.locator('#refresh-btn')).toBeEnabled();
    await expect(page.locator('#refresh-btn')).toHaveText('刷新');
    await expect(page.locator('#board')).toHaveAttribute('aria-busy', 'false');
    await page.close();
  }
});

test('慢手动与自动刷新共用 busy guard，保留可用旧卡片并在开始时关闭预览', async (t) => {
  const { page, data, apiCalls } = await openDashboard(t, { clock: true });
  await page.locator('#auto-refresh').check();
  await page.locator('.card-title').focus();
  await page.clock.runFor(20);
  await expect(page.locator('#pr-preview')).toBeVisible();
  for (const automatic of [false, true]) {
    const gate = deferred();
    t.after(gate.resolve);
    data.pending['/api/prs'] = gate.promise;
    const callsBefore = apiCalls.length;
    const oldNumber = automatic ? 43 : 42;
    data.prs = [makePr(oldNumber + 1, '刷新后的正文')];
    if (automatic) await page.clock.fastForward(60_000);
    else await page.evaluate(() => { void refresh(); });
    await expect(page.locator('#loading-status')).toContainText('正在刷新看板数据');
    await expect(page.locator('#refresh-btn')).toBeDisabled();
    await expect(page.locator('#refresh-btn')).toHaveText('刷新中…');
    await expect(page.locator('#pr-preview')).toBeHidden();
    if (!automatic && process.env.MAW_DASHBOARD_SCREENSHOTS) {
      await mkdir('.artifacts/dev-dashboard-preview', { recursive: true });
      await page.screenshot({ path: '.artifacts/dev-dashboard-preview/refreshing.png' });
    }
    await expect(page.locator(`[data-pr="${oldNumber}"] .card-title`)).toBeVisible();
    await expect(page.locator(`[data-pr="${oldNumber}"] select`)).toBeEnabled();
    await page.locator('#search').fill(String(oldNumber));
    await expect(page.locator('.card')).toHaveCount(1);
    await page.locator('#search').fill('');
    await expect.poll(() => apiCalls.length).toBe(callsBefore + 4);
    await page.evaluate(() => { void refresh(); void refresh(); document.getElementById('refresh-btn').click(); });
    await page.clock.fastForward(60_000);
    assert.equal(apiCalls.length, callsBefore + 4, '手动与自动重入不能再发四路请求');
    gate.resolve();
    await expect(page.locator(`[data-pr="${oldNumber + 1}"]`)).toBeVisible();
    await expect(page.locator('#loading-status')).toBeHidden();
    await expect(page.locator('#refresh-btn')).toBeEnabled();
  }
});

test('一路早失败仍等其他请求结束才解除 busy，原子保留旧数据，重试成功清除错误', async (t) => {
  const { page, data, apiCalls } = await openDashboard(t, { statusMap: { '42': 'backlog' }, clock: true });
  const gate = deferred();
  t.after(gate.resolve);
  data.pending['/api/ignored'] = gate.promise;
  data.failures['/api/prs'] = '模拟 GitHub 读取失败';
  data.statusMap = { '42': 'pass' };
  const failedResponse = page.waitForResponse(`${ORIGIN}/api/prs`);
  await page.locator('#refresh-btn').click();
  await (await failedResponse).finished();
  await page.clock.fastForward(60_000);
  await expect(page.locator('#loading-status')).toBeVisible();
  await expect(page.locator('#refresh-btn')).toBeDisabled();
  await expect(page.locator('#banner')).toBeHidden();
  await expect(page.locator('[data-status="backlog"] [data-pr="42"]')).toHaveCount(1);
  await page.evaluate(() => { void refresh(); });
  assert.equal(apiCalls.length, 8, '早失败但剩余请求 pending 时不能允许重入');
  gate.resolve();
  await expect(page.locator('#loading-status')).toBeHidden();
  await expect(page.locator('#refresh-btn')).toBeEnabled();
  await expect(page.locator('#refresh-btn')).toHaveText('刷新');
  await expect(page.locator('#board')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#banner')).toContainText('数据加载失败：模拟 GitHub 读取失败');
  await expect(page.locator('[data-status="backlog"] [data-pr="42"]')).toHaveCount(1);
  data.failures = {};
  await page.locator('#refresh-btn').click();
  await expect(page.locator('[data-status="pass"] [data-pr="42"]')).toHaveCount(1);
  await expect(page.locator('#loading-status')).toBeHidden();
  await expect(page.locator('#banner')).toBeHidden();
  assert.equal(apiCalls.length, 12);
});

test('首次读取失败也结束进度与禁用状态，错误不能当作成功吞掉', async (t) => {
  const { page } = await openDashboard(t, {
    failures: { '/api/prs': '首次读取失败' }, waitForLoad: false,
  });
  await expect(page.locator('#banner')).toHaveText('数据加载失败：首次读取失败');
  await expect(page.locator('#loading-status')).toBeHidden();
  await expect(page.locator('#loading-status progress')).toBeHidden();
  await expect(page.locator('#refresh-btn')).toBeEnabled();
  await expect(page.locator('#refresh-btn')).toHaveText('刷新');
  await expect(page.locator('#board')).toHaveAttribute('aria-busy', 'false');
});

test('refresh-end: 失败收尾关闭刷新中重开的预览，窄屏原标题仍可实际点击', async (t) => {
  const { page, data } = await openDashboard(t, { viewport: { width: 360, height: 640 }, clock: true });
  await page.context().route('https://github.com/test/repo/**', (route) => route.fulfill({
    contentType: 'text/html', body: '<title>Mock GitHub PR</title>',
  }));
  const gate = deferred();
  t.after(gate.resolve);
  data.pending['/api/prs'] = gate.promise;
  data.failures['/api/prs'] = 'Simulated refresh failure';
  await page.locator('#refresh-btn').click();
  const title = page.locator('.card-title');
  const preview = page.locator('#pr-preview');
  await title.focus();
  await page.clock.runFor(20);
  await expect(preview).toBeVisible();
  gate.resolve();
  await expect(page.locator('#refresh-btn')).toBeEnabled();
  await expect(page.locator('#banner')).toContainText('Simulated refresh failure');
  await expect(preview).toBeHidden();
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  if (process.env.MAW_DASHBOARD_SCREENSHOTS) {
    await mkdir('.artifacts/dev-dashboard-preview', { recursive: true });
    await page.screenshot({ path: '.artifacts/dev-dashboard-preview/failed-refresh-preview-cleanup.png' });
  }
  const rect = await title.boundingBox();
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  assert.equal(await page.evaluate(({ x, y }) =>
    Boolean(document.elementFromPoint(x, y)?.closest('.card-title')), center), true);
  const popupPromise = page.waitForEvent('popup');
  await page.mouse.click(center.x, center.y);
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  assert.equal(popup.url(), makePr(42).url);
  await popup.close();
});

for (const trigger of ['hover', 'focus']) {
  test(`refresh-end: 失败收尾取消 ${trigger} 待弹出任务，收尾后不突然显示旧预览`, async (t) => {
    const { page, data } = await openDashboard(t, { viewport: { width: 360, height: 640 }, clock: true });
    const gate = deferred();
    t.after(gate.resolve);
    data.pending['/api/prs'] = gate.promise;
    data.failures['/api/prs'] = 'Simulated refresh failure';
    await page.locator('#refresh-btn').click();
    if (trigger === 'focus') await page.locator('.card-title').focus();
    else {
      const rect = await page.locator('.card').boundingBox();
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    }
    assert.equal(await page.evaluate((trigger) => trigger === 'focus'
      ? previewFocusFrame > 0 : previewOpenTimer > 0, trigger), true, '先确认任务确实处于待执行状态');
    await expect(page.locator('#pr-preview')).toBeHidden();
    gate.resolve();
    await expect(page.locator('#refresh-btn')).toBeEnabled();
    assert.deepEqual(await page.evaluate(() => ({ hover: previewOpenTimer, focus: previewFocusFrame })),
      { hover: 0, focus: 0 }, '刷新收尾必须取消 hover 计时器和 focus 帧任务');
    await page.clock.runFor(500);
    await expect(page.locator('#pr-preview')).toBeHidden();
  });
}
