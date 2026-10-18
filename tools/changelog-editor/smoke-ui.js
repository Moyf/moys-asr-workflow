/* CHANGELOG 编辑器 UI 冒烟：真实 CL 载入 → 编辑/对比/新增/删除 → 预览/对照 → 归档生成（写盘走临时目录模拟）。 */
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.resolve(__dirname, '..', '..');
const url = 'http://127.0.0.1:8791/tools/changelog-editor/index.html';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });

  await page.goto(url);
  await page.evaluate(async (clText) => {
    await loadClText(clText, '🧪 冒烟测试');
  }, fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8'));
  await page.waitForTimeout(300);

  const loaded = await page.evaluate(() => ({
    versions: document.querySelectorAll('#version-list .version-item').length,
    selected: S.selected,
    stableCount: S.sections.filter((s) => L.isStable(s.name)).length,
    cards19: S.parsed.get('1.9.0').cards.length,
    entries19: [...S.parsed.get('1.9.0').cards].filter((c) => c.kind === 'entry').length,
    secure: window.isSecureContext,
  }));
  console.log('loaded:', JSON.stringify(loaded));

  // 选中 1.9.0，编辑第一条 + 查看 diff
  await page.evaluate(() => selectSection('1.9.0'));
  await page.waitForTimeout(120);
  const before = await page.evaluate(() => S.parsed.get('1.9.0').cards.find((c) => c.kind === 'entry').lines[0].slice(0, 30));
  const firstTa = page.locator('.card.kind-entry textarea').first();
  await firstTa.click();
  const originalText = await firstTa.inputValue();
  await firstTa.fill(originalText + '（冒烟测试追加）');
  await page.waitForTimeout(50);
  const diffShown = await page.evaluate(() => {
    const el = document.querySelector('.card.kind-entry');
    el.querySelector('[data-act="diff"]').click();
    return el.querySelector('[data-diff]').innerHTML.includes('<ins>');
  });
  console.log('edit+diff:', JSON.stringify({ before, diffShown }));

  // 新增 / 删除条目
  const counts = await page.evaluate(() => {
    const parsed = S.parsed.get('1.9.0');
    const n0 = parsed.cards.length;
    addEntry(parsed.cards.length);
    const n1 = S.parsed.get('1.9.0').cards.length;
    S.parsed.get('1.9.0').cards.pop();
    return { n0, n1, restored: S.parsed.get('1.9.0').cards.length === n0 };
  });
  console.log('add/remove entry:', JSON.stringify(counts));

  // 预览与对照
  await page.evaluate(() => { S.tab = 'preview'; renderPane(); });
  const previewOk = await page.evaluate(() => {
    const pane = document.querySelector('#pane');
    return { h2: Boolean(pane.querySelector('h2')), h3: pane.querySelectorAll('h3').length, code: pane.querySelectorAll('code').length > 0 };
  });
  await page.evaluate(() => { S.tab = 'reference'; renderPane(); });
  const refOk = await page.evaluate(() => {
    const pane = document.querySelector('#pane');
    return { groups: pane.querySelectorAll('.ref-group').length, entries: pane.querySelectorAll('.ref-entry').length };
  });
  console.log('preview:', JSON.stringify(previewOk), 'reference:', JSON.stringify(refOk));

  // 归档生成（在页面里直接对 1.9.0 调 buildArchive，并与磁盘文件对比）
  const archiveEqual = await page.evaluate(async () => {
    const expected = await L.buildArchive(S.clText, '1.9.0');
    return expected.length;
  });
  const disk = fs.readFileSync(path.join(repoRoot, 'docs', 'releases', '1.9.0.md'), 'utf8');
  console.log('archive bytes js vs disk:', archiveEqual, disk.length, archiveEqual === disk.length);

  // 图片附加（模拟粘贴结果：直接构造 blob 走 attachImage 路径）
  const imgInfo = await page.evaluate(async () => {
    const parsed = S.parsed.get('1.9.0');
    const idx = parsed.cards.findIndex((c) => c.kind === 'entry');
    // 1x1 PNG
    const png = await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==').then((r) => r.blob());
    await attachImage(parsed.cards[idx], idx, new File([png], 'shot.png', { type: 'image/png' }));
    return { pending: S.images.size, cardKey: [...S.images.values()][0].cardKey, filename: [...S.images.values()][0].filename };
  });
  console.log('attach image:', JSON.stringify(imgInfo));
  await page.screenshot({ path: path.join(repoRoot, '.artifacts', 'cl-editor-smoke.png'), fullPage: false });

  // 校验完成编辑的校验器（模板条目应报错）
  const validation = await page.evaluate(() => {
    const parsed = S.parsed.get('1.9.0');
    addEntry(parsed.cards.length);
    const errs = validateForFinish();
    S.parsed.get('1.9.0').cards.pop();
    return errs;
  });
  console.log('validation with template entry:', JSON.stringify(validation));

  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((err) => { console.error('SMOKE FAILED:', err); process.exit(1); });
