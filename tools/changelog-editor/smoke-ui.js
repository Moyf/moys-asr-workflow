/* CHANGELOG 编辑器 UI 冒烟：真实 CL 载入 → 默认分屏 → 编辑/对比/增删/小节 → 卡片拖拽排序 → 分屏预览 → 对照(含跨系列测试版) →
 * 图片统一条(alt/拖拽/已有图) → 多版本批量 dirty 检测 → beta 编辑锁 → 归档一致性 → 侧栏收缩/手动编辑/刷新 → 仓库重连(假句柄)。 */
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

  // 默认分屏：载入后未手动切 tab 时应已在分屏视图
  const defaultTab = await page.evaluate(() => ({
    tab: S.tab,
    splitRendered: Boolean(document.querySelector('#split-wrap')),
    activeBtn: document.querySelector('#tabs button.active')?.dataset.tab,
  }));
  console.log('default split:', JSON.stringify(defaultTab));

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

  // 卡片拖拽排序：把手发起 dragstart → 目标卡 dragover → drop（下半部/上半部各一次，测后还原）
  const cardDrag = await page.evaluate(() => {
    S.tab = 'edit';
    renderPane();
    const parsed = S.parsed.get('1.9.0');
    const original = parsed.cards.map((c) => c.lines[0]);
    const fire = (el, type, dt, clientY) => el.dispatchEvent(
      new DragEvent(type, { bubbles: true, dataTransfer: dt, ...(clientY != null ? { clientY } : {}) }));
    const dragByHandle = (fromEl) => {
      fromEl.querySelector('.drag-handle')
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      const dt = new DataTransfer();
      const idx = Number(fromEl.dataset.idx);
      dt.setData('text/cl-card-idx', String(idx));
      fire(fromEl, 'dragstart', dt);
      return { dt, idx };
    };
    const cards = () => [...document.querySelectorAll('#cards .card')];
    const order = () => S.parsed.get('1.9.0').cards.map((c) => c.lines[0]);
    const result = {};

    // 1) 下半部 → 移到目标之后
    let firstTitle = order()[0];
    let [c0, c1] = cards();
    let d = dragByHandle(c0);
    let r = cards()[1].getBoundingClientRect();
    fire(cards()[1], 'dragover', d.dt, r.top + r.height / 2 + 1);
    result.dropMark = cards()[1].classList.contains('drop-after');
    fire(cards()[1], 'drop', d.dt, r.top + r.height / 2 + 1);
    result.movedAfter = order()[1] === firstTitle;

    // 2) 上半部 → 移到目标之前（把刚移下去的拖回去）
    d = dragByHandle(cards()[1]);
    r = cards()[0].getBoundingClientRect();
    fire(cards()[0], 'dragover', d.dt, r.top + 1);
    result.dropMarkBefore = cards()[0].classList.contains('drop-before');
    fire(cards()[0], 'drop', d.dt, r.top + 1);
    result.movedBefore = order()[0] === firstTitle;

    // 3) 拖到自身 → 不动
    d = dragByHandle(cards()[0]);
    fire(cards()[0], 'dragover', d.dt, 0);
    fire(cards()[0], 'drop', d.dt, 0);
    result.selfDropNoop = order().join('\n') === original.join('\n');
    // 选中跟随被拖拽的卡片：case 2 已把它拖回原位（index 0）
    result.selectionFollows = S.selectedCard === S.parsed.get('1.9.0').cards[0];

    // 4) 子元素（如 textarea）发起的 dragstart 冒泡到卡片层不得被取消或污染
    const childDt = new DataTransfer();
    const childStart = new DragEvent('dragstart', { bubbles: true, dataTransfer: childDt, cancelable: true });
    result.childDragUntouched = cards()[0].querySelector('textarea').dispatchEvent(childStart)
      && !childDt.types.includes('text/cl-card-idx');

    // 5) 把手普通点击（mousedown → mouseup，无拖拽）后 draggable 必须复位
    cards()[0].querySelector('.drag-handle')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    result.handleClickResetsDraggable = !cards()[0].draggable;

    result.marksCleared = !document.querySelector('.card.drop-before, .card.drop-after');
    result.restored = order().join('\n') === original.join('\n');
    S.selectedCard = null;
    return result;
  });
  console.log('card drag:', JSON.stringify(cardDrag));

  // 粘贴目标解析：聚焦文本框所在卡片必须优先于「已选中」卡片（修复图片贴错条目）
  const pasteTarget = await page.evaluate(() => {
    const parsed = S.parsed.get('1.9.0');
    const entries = parsed.cards.filter((c) => c.kind === 'entry');
    const [a, b] = entries;
    const elOf = (card) => [...document.querySelectorAll('#cards .card')]
      .find((el) => parsed.cards[Number(el.dataset.idx)] === card);
    // 场景：选中第一条，但焦点在第二条的文本框 → 焦点必须赢；
    // 失焦后按「选中」回退——选中已被 focus 更新为第二条，符合设计
    selectCard(a);
    const ta = elOf(b).querySelector('textarea');
    ta.focus();
    const byFocus = resolvePasteCard(parsed);
    ta.blur();
    const bySelected = resolvePasteCard(parsed);
    // 选中对象在卡片重排后仍指向原卡（对象引用制 vs 旧索引制）
    selectCard(a);
    parsed.cards.splice(parsed.cards.indexOf(a), 1);
    parsed.cards.push(a);
    const afterShuffle = resolvePasteCard(parsed);
    parsed.cards.splice(parsed.cards.indexOf(a), 1);
    parsed.cards.unshift(a);
    return {
      focusWins: byFocus.source === 'focus' && byFocus.card === b,
      selectedFallback: bySelected.source === 'selected' && bySelected.card === b,
      stableAfterShuffle: afterShuffle.source === 'selected' && afterShuffle.card === a,
    };
  });
  console.log('paste target:', JSON.stringify(pasteTarget));

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
    // 新图 alt 默认 = 文件名（不含扩展名）
    const defaultAltMatchesFilename = newMeta != null && newMeta.alt === filenameInputValue;
    // 输入框内拖动不触发图片条排序：mousedown 临时关 draggable，mouseup 恢复
    const filenameInput = items[1].querySelector('input[data-f="filename"]');
    filenameInput.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const dragSuppressed = items[1].draggable === false;
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const dragRestored = items[1].draggable === true;
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
      title, defaultName: newMeta ? newMeta.filename : null, defaultAltMatchesFilename,
      dragSuppressed, dragRestored, extBadge: extBadge ? extBadge.textContent : null,
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

  // layout: 侧栏拖宽手柄 + 归档盒
  const dragFix = await page.evaluate(() => {
    return {
      resizer: Boolean(document.querySelector('#sb-resizer')),
      archiveBox: Boolean(document.querySelector('#archive-box')),
    };
  });
  console.log('layout:', JSON.stringify(dragFix));

  // 侧栏收缩/展开：点击折叠、状态持久化、再展开还原
  const sidebarCollapse = await page.evaluate(() => {
    const t = $('#sidebar-toggle');
    t.click();
    const collapsed = $('#sidebar').classList.contains('collapsed')
      && document.body.classList.contains('side-collapsed')
      && localStorage.getItem('cl-editor:sidebar-collapsed') === '1';
    t.click();
    const restored = !$('#sidebar').classList.contains('collapsed')
      && localStorage.getItem('cl-editor:sidebar-collapsed') === '';
    return { hadToggle: Boolean(t), collapsed, restored };
  });
  console.log('sidebar collapse:', JSON.stringify(sidebarCollapse));

  // 侧栏工具行：手动编辑（无 server 端点时显示降级提示）+ 刷新（用假仓库句柄走真实重载路径）
  const clTextForFile = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const sidebarTools = await page.evaluate(async (clText) => {
    const out = {};
    // 1) 手动编辑：fetch 失败（如 file:// 或非 dev-dashboard 服务）→ 应弹「需通过 dev-dashboard」提示。
    //    stub 掉 fetch，避免对静态服务发真实 POST 留下预期内的控制台错误。
    const realFetch = window.fetch;
    window.fetch = async () => { throw new TypeError('Failed to fetch'); };
    $('#btn-external-edit').click();
    await new Promise((r) => setTimeout(r, 200));
    window.fetch = realFetch;
    out.externalEditHint = $('#toast').textContent.includes('dev-dashboard');
    // 2) 刷新：先通过假句柄连接仓库（复用 tryReconnect；重置状态模拟全新页面），再点击刷新走磁盘重载
    const good = {
      name: 'fake-repo',
      queryPermission: async () => 'granted',
      getFileHandle: async () => ({ getFile: async () => new File([clText], 'CHANGELOG.md', { type: 'text/markdown' }) }),
    };
    S.repo = null; S.selected = null;
    await tryReconnect(good);
    $('#btn-reload-cl').click();
    await new Promise((r) => setTimeout(r, 200));
    out.reloadToast = $('#toast').textContent.includes('已从磁盘重新载入');
    out.chipKept = $('#repo-chip').textContent.includes('fake-repo');
    // 3) 无仓库时刷新：连接假仓库会残留 S.repo → 恢复只读假载入基线后再点应弹未连接提示
    S.repo = null;
    $('#btn-reload-cl').click();
    await new Promise((r) => setTimeout(r, 150));
    out.noRepoHint = $('#toast').textContent.includes('未连接仓库目录');
    await loadClText(clText, '🧪 冒烟测试');
    return out;
  }, clTextForFile);
  console.log('sidebar tools:', JSON.stringify(sidebarTools));

  // 仓库目录重连：tryReconnect 的三条路径（granted 直连 / 坏句柄清理 / 授权被拒），
  // 用注入的假句柄直接驱动真实代码路径；真实句柄的 IDB 持久化只能人工验证。
  const clTextForReconnect = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const reconnect = await page.evaluate(async (clText) => {
    const good = {
      name: 'fake-repo',
      queryPermission: async () => 'granted',
      getFileHandle: async () => ({ getFile: async () => new File([clText], 'CHANGELOG.md', { type: 'text/markdown' }) }),
    };
    // 模拟全新页面（m1 守卫：已有载入状态时 tryReconnect 拒绝接管）
    S.repo = null; S.selected = null;
    showReconnectUi('x'); // 先让按钮可见，才能断言连接成功后确实被 hideReconnectUi 收起
    await new Promise((r) => setTimeout(r, 50));
    const uiWasShown = !$('#btn-reconnect').hidden;
    const ok = await tryReconnect(good);
    const chipOk = $('#repo-chip').textContent.includes('fake-repo');
    const uiHidden = uiWasShown && $('#btn-reconnect').hidden && $('#btn-forget-repo').hidden;
    const bad = { name: 'broken-repo', queryPermission: async () => 'granted', getFileHandle: async () => { throw new Error('gone'); } };
    S.repo = null; S.selected = null; // 走到 stale 清理分支本身
    const staleHandled = await tryReconnect(bad) === false;
    const denied = { name: 'denied-repo', queryPermission: async () => 'prompt', requestPermission: async () => 'denied' };
    const deniedHandled = await tryReconnect(denied) === false;
    // 恢复冒烟基线（只读假载入），避免残留 fake-repo 状态影响后续
    await loadClText(clText, '🧪 冒烟测试');
    return { ok, chipOk, uiHidden, staleHandled, deniedHandled };
  }, clTextForReconnect);
  console.log('repo reconnect:', JSON.stringify(reconnect));

  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((err) => { console.error('SMOKE FAILED:', err); process.exit(1); });
