/* CHANGELOG 编辑器 UI 冒烟：真实 CL 载入 → 编辑/对比/增删/小节 → 分屏预览 → 对照(含跨系列测试版) →
 * 图片统一条(alt/拖拽/已有图) → 多版本批量 dirty 检测 → beta 编辑锁 → 归档一致性。 */
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
    entries19: [...S.parsed.get('1.9.0').cards].filter((c) => c.kind === 'entry').length,
  }));
  console.log('loaded:', JSON.stringify(loaded));

  // 1.9.0 编辑一条 + dirty 检测
  await page.evaluate(() => selectSection('1.9.0'));
  await page.waitForTimeout(120);
  const edit = await page.evaluate(() => {
    const parsed = S.parsed.get('1.9.0');
    const card = parsed.cards.find((c) => c.kind === 'entry');
    card.lines[0] += '（冒烟追加）';
    const dirty = dirtyVersions().map((s) => s.name);
    return { dirty, has19: dirty.includes('1.9.0') };
  });
  console.log('dirty after edit:', JSON.stringify(edit));

  // 分屏：渲染 + 实时刷新
  const split = await page.evaluate(() => {
    S.tab = 'split';
    renderPane();
    const wrap = document.querySelector('#split-wrap');
    const okStructure = Boolean(wrap && wrap.querySelector('.split-edit .card') && wrap.querySelector('.split-preview h2'));
    // 触发一次防抖刷新
    scheduleSplitPreview();
    return { okStructure };
  });
  await page.waitForTimeout(600);
  const splitAfter = await page.evaluate(() => {
    const side = document.querySelector('#split-wrap > .split-preview');
    return { refreshed: Boolean(side), hasMarkedText: side.textContent.includes('冒烟追加') };
  });
  console.log('split:', JSON.stringify({ ...split, ...splitAfter }));

  // 对照：1.9.0 应覆盖 beta.3/2/1 与 1.8.0-beta.1
  const ref = await page.evaluate(() => {
    S.tab = 'reference';
    renderPane();
    const pane = document.querySelector('#pane');
    return {
      groups: [...pane.querySelectorAll('.ref-group h4')].map((h) => h.textContent.trim().split(/\s+/)[0]),
      entries: pane.querySelectorAll('.ref-entry').length,
    };
  });
  console.log('reference:', JSON.stringify(ref));

  // 小节标题增删
  const headingOps = await page.evaluate(() => {
    const parsed = S.parsed.get('1.9.0');
    const n0 = parsed.cards.length;
    addCard('heading', parsed.cards.length);
    const added = S.parsed.get('1.9.0').cards[n0].kind === 'heading';
    const text = S.parsed.get('1.9.0').cards[n0].lines[0];
    S.parsed.get('1.9.0').cards.splice(n0, 1);
    return { added, text, restored: S.parsed.get('1.9.0').cards.length === n0 };
  });
  console.log('heading ops:', JSON.stringify(headingOps));

  // 统一图片条：新图片(默认取条目标题做文件名/待写盘徽标/扩展名分离) + 模拟已有图片 + 真实拖拽排序
  const images = await page.evaluate(async () => {
    selectSection('1.6.0');
    await new Promise((r) => setTimeout(r, 100));
    const parsed = S.parsed.get('1.6.0');
    const entry = parsed.cards.find((c) => c.kind === 'entry');
    const idx = parsed.cards.indexOf(entry);
    const title = entry.lines[0].match(/^-\s*\*\*(.+?)\*\*/)?.[1] || 'entry';
    // 模拟一个已有图片引用（正常来自 CL 解析）
    entry.images = [{ kind: 'existing', alt: '旧图描述', path: 'docs/assets/1.6.0/example.webp' }];
    // 附加一张新图（默认文件名应取条目标题）
    const png = await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==').then((r) => r.blob());
    await attachImage(entry, idx, new File([png], 'shot.png', { type: 'image/png' }));
    renderPane();
    await new Promise((r) => setTimeout(r, 100));
    const strip = document.querySelector('.card .img-strip');
    const items = [...strip.querySelectorAll('.img-item')];
    const newMeta = [...S.images.values()][0];
    const extBadge = items[1].querySelector('.ext-badge');
    const filenameInputValue = items[1].querySelector('input[data-f="filename"]').value;
    const filenameHasExt = filenameInputValue.includes('.');
    // 扩展名分离后校验应通过（中文文件名合法）
    const errs = collectErrors('1.6.0');
    const validationClean = !errs.some((e) => e.includes('文件名'));
    // 真实拖拽：把第二个（新图）拖到第一位
    const dt = new DataTransfer();
    dt.setData('text/cl-img-pos', '1');
    items[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    items[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    items[0].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 100));
    const orderAfterDrag = entry.images.map((im) => im.kind).join(',');
    // 序列化后新图不进 CL、已有图保留
    const section = S.sections.find((s) => s.name === '1.6.0');
    const serialized = L.serializeSection(section, S.parsed.get('1.6.0'));
    const emitted = serialized.includes('![旧图描述](docs/assets/1.6.0/example.webp)');
    const notEmitted = !serialized.includes('docs/assets/1.6.0/shot');
    // 还原
    entry.images = [];
    for (const [id] of [...S.images]) S.images.delete(id);
    return {
      title, defaultName: newMeta ? newMeta.filename : null, extBadge: extBadge ? extBadge.textContent : null,
      filenameHasExt, validationClean, orderAfterDrag, emitted, notEmitted, errs,
    };
  });
  console.log('images:', JSON.stringify(images));

  // 多版本批量：给两个版本分别制造改动，检查批量弹窗出现
  const batch = await page.evaluate(() => {
    selectSection('1.9.0');
    S.tab = 'edit';
    renderPane();
    const p19 = S.parsed.get('1.9.0');
    p19.cards.find((c) => c.kind === 'entry').lines[0] += '（再改一次）';
    const p17 = S.parsed.get('1.7.0');
    p17.cards.find((c) => c.kind === 'entry').lines[0] += '（1.7 勘误测试）';
    return dirtyVersions().map((s) => s.name);
  });
  await page.click('#btn-finish');
  await page.waitForTimeout(200);
  const batchModal = await page.evaluate(() => {
    const title = document.querySelector('#modal h3');
    const rows = document.querySelectorAll('[data-batch]').length;
    const archBoxes = document.querySelectorAll('[data-batch-arch]').length;
    const out = { title: title ? title.textContent : null, rows, archBoxes };
    document.querySelector('#mask').classList.remove('show');
    return out;
  });
  console.log('batch modal:', JSON.stringify({ dirty: batch, ...batchModal }));

  // beta 编辑锁
  const lock = await page.evaluate(() => {
    selectSection('1.9.0-beta.3');
    const locked = editLocked();
    const bannerShown = document.querySelector('#lock-banner').classList.contains('show');
    document.querySelector('#btn-unlock')?.click();
    const unlockedAfter = !editLocked();
    return { locked, bannerShown, unlockedAfter };
  });
  console.log('beta lock:', JSON.stringify(lock));

  // 归档一致性（页面内 vs 磁盘）
  const archiveEqual = await page.evaluate(async () => {
    const expected = await L.buildArchive(S.clText.replace(/（冒烟追加）/g, '').replace(/（再改一次）/g, '').replace(/（1\.7 勘误测试）/g, ''), '1.9.0');
    return expected.length;
  });
  const disk = fs.readFileSync(path.join(repoRoot, 'docs', 'releases', '1.9.0.md'), 'utf8');
  console.log('archive bytes js(cleaned) vs disk:', archiveEqual, disk.length, archiveEqual === disk.length);

  await page.evaluate(() => selectSection('1.9.0'));
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(repoRoot, '.artifacts', 'cl-editor-smoke2.png') });

  // 侧栏拖宽手柄存在 + 文本选区拖动不再被拦截
  const dragFix = await page.evaluate(() => {
    return {
      resizer: Boolean(document.querySelector('#sb-resizer')),
      archiveBox: Boolean(document.querySelector('#archive-box')),
    };
  });
  console.log('layout:', JSON.stringify(dragFix));

  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((err) => { console.error('SMOKE FAILED:', err); process.exit(1); });
