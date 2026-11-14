'use strict';
// MAW Dev Dashboard 前端。
// 数据全部来自本地 server（/api/prs、/api/checklists、/api/status），
// 外部输入只通过安全的 DOM 节点输出；不得将外部 HTML 注入页面。

// 自定义状态集：之后要调整只改这里（server 端不做枚举校验，宽松存储）。
const STATUSES = [
  { id: 'backlog', label: 'Backlog', hint: '待排期' },
  { id: 'review', label: 'Review', hint: '审查中' },
  { id: 'fixing', label: 'Fixing', hint: '修复中' },
  { id: 'hold', label: 'Hold', hint: '搁置' },
  { id: 'pass', label: 'Pass', hint: '验收通过' },
];
const UNASSIGNED = 'unassigned';
const COLUMNS = [{ id: UNASSIGNED, label: '未分配', hint: '尚未归类' }, ...STATUSES];

const AUTO_REFRESH_KEY = 'maw-dev-dashboard.auto-refresh';
const AUTO_REFRESH_MS = 60_000;

const state = {
  prs: [],
  checklists: [],
  statusMap: {},
  ignored: {},
  showIgnored: false,
  milestoneFilter: 'all',
  authorFilter: 'all',
  query: '',
};

const el = {
  board: document.getElementById('board'),
  stats: document.getElementById('stats'),
  banner: document.getElementById('banner'),
  toast: document.getElementById('toast'),
  refreshBtn: document.getElementById('refresh-btn'),
  loadingStatus: document.getElementById('loading-status'),
  loadingText: document.getElementById('loading-text'),
  openChangelog: document.getElementById('open-changelog'),
  autoRefresh: document.getElementById('auto-refresh'),
  milestoneFilter: document.getElementById('milestone-filter'),
  authorFilter: document.getElementById('author-filter'),
  toggleIgnored: document.getElementById('toggle-ignored'),
  search: document.getElementById('search'),
  filterMeta: document.getElementById('filter-meta'),
  prPreview: document.getElementById('pr-preview'),
  prPreviewTitle: document.getElementById('pr-preview-title'),
  prPreviewBody: document.getElementById('pr-preview-body'),
};

// ---------------------------------------------------------------- 工具函数

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function duePill(milestone) {
  if (!milestone || !milestone.dueOn) return null;
  const days = Math.ceil((new Date(milestone.dueOn).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { text: `${milestone.title} · 逾期 ${-days} 天`, cls: 'due-over' };
  if (days <= 14) return { text: `${milestone.title} · 剩 ${days} 天`, cls: 'due-soon' };
  return null;
}

let toastTimer = 0;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

async function copyText(text, doneMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(doneMessage);
  } catch {
    toast('复制失败：请检查浏览器剪贴板权限');
  }
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  let data = null;
  try {
    data = await res.json();
  } catch { /* 非 JSON 响应走下面的错误分支 */ }
  if (!res.ok || (data && data.error)) {
    throw new Error(data?.error ?? `${url} 请求失败（HTTP ${res.status}）`);
  }
  return data;
}

// ---------------------------------------------------------------- 正文预览
// 全看板共用一个浮层，只在打开时填正文，避免把 100 份长正文都放进 DOM。
const PR_BODY_RESTART_HINT = '请重启看板服务后刷新；仅刷新网页不会更新后端。';
function hasPrBody(pr) {
  return typeof pr.body === 'string' || pr.body === null;
}

let previewCard = null;
let previewTitle = null;
let previewOpenTimer = 0;
let previewCloseTimer = 0;
let previewFocusFrame = 0;
let previewHoverDismissed = false;
let previewPointerX = null;
let previewPointerY = null;

function hidePrPreview() {
  clearTimeout(previewOpenTimer);
  clearTimeout(previewCloseTimer);
  cancelAnimationFrame(previewFocusFrame);
  previewOpenTimer = previewCloseTimer = previewFocusFrame = 0;
  previewTitle?.setAttribute('aria-expanded', 'false');
  previewCard = null;
  previewTitle = null;
  el.prPreview.hidden = true;
}

// Marked 只负责词法分析；不使用其 HTML 输出。所有节点由白名单构造。
function renderPrMarkdown(target, source) {
  target.replaceChildren();
  if (!window.marked?.lexer) {
    target.textContent = `Markdown 预览不可用，请重启看板服务后刷新。\n\n${source}`;
    return;
  }
  const decode = (text) => {
    // textarea 的片段解析是纯文本上下文；不把该临时节点插入页面。
    const node = document.createElement('textarea');
    node.innerHTML = text;
    return node.value;
  };
  const safeUrl = (href) => {
    if (typeof href !== 'string') return null;
    href = decode(href);
    if (!/^https?:\/\/[^\s\\]+$/i.test(href)) return null;
    try {
      const url = new URL(href);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname ? url.href : null;
    } catch { return null; }
  };
  function append(parent, tokens) {
    for (const token of tokens || []) {
      let node;
      switch (token.type) {
        case 'space': continue;
        case 'text': case 'escape':
          if (token.tokens) append(parent, token.tokens);
          else parent.append(document.createTextNode(decode(token.text)));
          continue;
        case 'html': parent.append(document.createTextNode(token.raw)); continue;
        case 'br': parent.append(document.createElement('br')); continue;
        case 'hr': parent.append(document.createElement('hr')); continue;
        case 'heading': node = document.createElement(`h${token.depth}`); break;
        case 'paragraph': node = document.createElement('p'); break;
        case 'strong': node = document.createElement('strong'); break;
        case 'em': node = document.createElement('em'); break;
        case 'del': node = document.createElement('del'); break;
        case 'blockquote': node = document.createElement('blockquote'); break;
        case 'codespan': node = document.createElement('code'); node.textContent = token.text; parent.append(node); continue;
        case 'code':
          node = document.createElement('pre');
          { const code = document.createElement('code'); code.textContent = token.text + '\n'; node.append(code); }
          parent.append(node); continue;
        case 'link': {
          const url = safeUrl(token.href);
          node = document.createElement(url ? 'a' : 'span');
          if (url) { node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
          break;
        }
        case 'image': parent.append(document.createTextNode(token.text || '图片')); continue;
        case 'list':
          node = document.createElement(token.ordered ? 'ol' : 'ul');
          if (token.ordered && Number.isSafeInteger(token.start)) node.start = token.start;
          for (const item of token.items) {
            const li = document.createElement('li');
            if (item.task) { const box = document.createElement('input'); box.type = 'checkbox'; box.disabled = true; box.checked = item.checked; li.append(box, ' '); }
            append(li, item.tokens); node.append(li);
          }
          parent.append(node); continue;
        case 'table': {
          const wrap = document.createElement('div'); wrap.className = 'markdown-table';
          const table = document.createElement('table');
          const head = document.createElement('thead'); const row = document.createElement('tr');
          for (const cell of token.header) { const th = document.createElement('th'); append(th, cell.tokens); row.append(th); }
          head.append(row); table.append(head);
          const body = document.createElement('tbody');
          for (const cells of token.rows) { const tr = document.createElement('tr'); for (const cell of cells) { const td = document.createElement('td'); append(td, cell.tokens); tr.append(td); } body.append(tr); }
          table.append(body); wrap.append(table); parent.append(wrap); continue;
        }
        default: parent.append(document.createTextNode(token.raw || '')); continue;
      }
      append(node, token.tokens);
      parent.append(node);
    }
  }
  try { append(target, window.marked.lexer(source, { gfm: true })); }
  catch { target.textContent = source; }
}

function showPrPreview(card, title, pr) {
  clearTimeout(previewOpenTimer);
  clearTimeout(previewCloseTimer);
  cancelAnimationFrame(previewFocusFrame);
  previewOpenTimer = previewCloseTimer = previewFocusFrame = 0;
  if (!card.isConnected || card.classList.contains('dragging')) return;
  previewTitle?.setAttribute('aria-expanded', 'false');
  previewCard = card;
  previewTitle = title;
  title.setAttribute('aria-expanded', 'true');
  el.prPreviewTitle.textContent = `#${pr.number} ${pr.title}`;
  if (!hasPrBody(pr)) el.prPreviewBody.textContent = `此 PR 正文尚未获取。${PR_BODY_RESTART_HINT}`;
  else if (typeof pr.body === 'string' && pr.body.trim()) renderPrMarkdown(el.prPreviewBody, pr.body);
  else el.prPreviewBody.textContent = '此 PR 暂无正文。';
  el.prPreviewBody.scrollTop = 0;
  el.prPreview.style.maxHeight = '';
  el.prPreview.style.maxWidth = `${document.documentElement.clientWidth - 24}px`;
  el.prPreview.hidden = false;

  // 优先放卡片右侧，其次左侧；横向不够则放整张卡片上/下方，并压缩浮层高度。
  // 不能把下方浮层向上钳制到卡片上，否则会挡住标题、动作按钮并触发 hover 循环。
  const gap = 12;
  const rect = card.getBoundingClientRect();
  const anchor = title.getBoundingClientRect();
  const width = el.prPreview.offsetWidth;
  let height = el.prPreview.offsetHeight;
  const maxX = document.documentElement.clientWidth - width - gap;
  let x = rect.right + gap;
  let y = anchor.top;
  if (x > maxX) {
    x = rect.left - width - gap;
    if (x < gap) {
      x = anchor.left;
      const below = document.documentElement.clientHeight - rect.bottom - gap * 2;
      const above = rect.top - gap * 2;
      const placeBelow = below >= above;
      const available = Math.max(below, above);
      if (available < 100) {
        hidePrPreview(); // 极矮窗口无可读空间时不遮挡原卡片；点击标题仍可阅读原文。
        return;
      }
      el.prPreview.style.maxHeight = `${Math.min(height, available)}px`;
      height = el.prPreview.offsetHeight;
      y = placeBelow ? rect.bottom + gap : rect.top - gap - height;
    }
  }
  const maxY = document.documentElement.clientHeight - height - gap;
  el.prPreview.style.left = `${Math.max(gap, Math.min(x, maxX))}px`;
  el.prPreview.style.top = `${Math.max(gap, Math.min(y, maxY))}px`;
}

function schedulePrPreview(card, title, pr) {
  clearTimeout(previewOpenTimer);
  clearTimeout(previewCloseTimer);
  if (previewCard === card && !el.prPreview.hidden) return;
  previewOpenTimer = setTimeout(() => {
    previewOpenTimer = 0;
    if (!previewHoverDismissed && card.matches(':hover')) showPrPreview(card, title, pr);
  }, 300);
}

function scheduleHidePrPreview() {
  clearTimeout(previewOpenTimer);
  clearTimeout(previewCloseTimer);
  // 留出从卡片跨过间隙进入浮层的时间；在浮层内滚动、选字不会把它关闭。
  previewCloseTimer = setTimeout(() => {
    if (previewCard?.matches(':hover, :focus-within') || el.prPreview.matches(':hover, :focus-within')) return;
    hidePrPreview();
  }, 180);
}

el.prPreview.addEventListener('mouseenter', () => clearTimeout(previewCloseTimer));
el.prPreview.addEventListener('mouseleave', scheduleHidePrPreview);
el.prPreview.addEventListener('focusin', () => clearTimeout(previewCloseTimer));
el.prPreview.addEventListener('focusout', scheduleHidePrPreview);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || (el.prPreview.hidden && !previewFocusFrame)) return;
  previewHoverDismissed = true;
  if (el.prPreview.contains(document.activeElement)) previewTitle?.focus({ preventScroll: true });
  hidePrPreview();
  event.preventDefault();
});
document.addEventListener('pointermove', (event) => {
  // 隐藏浮层可能让下面的卡片收到合成 mouseenter；Esc 后原地不能再次弹出。
  if (event.clientX !== previewPointerX || event.clientY !== previewPointerY) previewHoverDismissed = false;
  previewPointerX = event.clientX;
  previewPointerY = event.clientY;
}, { capture: true, passive: true });
document.addEventListener('pointerdown', (event) => {
  if (!el.prPreview.contains(event.target) && !previewCard?.contains(event.target)) hidePrPreview();
});
document.addEventListener('scroll', (event) => {
  // 首次移入屏外卡片时，浏览器可能刚完成自动滚动；尚未打开的预览按最终位置显示。
  if (!el.prPreview.hidden && !el.prPreview.contains(event.target)) hidePrPreview();
}, true);
window.addEventListener('resize', hidePrPreview);
window.addEventListener('blur', hidePrPreview);

// ---------------------------------------------------------------- 数据

async function loadAll() {
  // 一路早失败时，其他请求仍可能在飞；全部结束后才提交数据或解除刷新锁。
  const results = await Promise.allSettled([
    fetchJson('/api/prs'),
    fetchJson('/api/checklists'),
    fetchJson('/api/status'),
    fetchJson('/api/ignored'),
  ]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  const [prs, checklists, statusMap, ignored] = results.map((result) => result.value);
  state.prs = Array.isArray(prs) ? prs : [];
  state.checklists = Array.isArray(checklists) ? checklists : [];
  state.statusMap = statusMap && typeof statusMap === 'object' ? statusMap : {};
  state.ignored = ignored && typeof ignored === 'object' ? ignored : {};
  render();
}

async function assignStatus(pr, status) {
  const prev = state.statusMap[String(pr)] ?? null;
  const next = status === UNASSIGNED ? null : status;
  // 乐观更新，失败回滚
  if (next === null) delete state.statusMap[String(pr)];
  else state.statusMap[String(pr)] = next;
  render();
  try {
    state.statusMap = await fetchJson('/api/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr, status: next }),
    });
  } catch (err) {
    if (prev === null) delete state.statusMap[String(pr)];
    else state.statusMap[String(pr)] = prev;
    toast(`状态保存失败：${err.message}`);
  }
  render();
}

async function toggleIgnored(prNumber, ignored) {
  const key = String(prNumber);
  const prev = Boolean(state.ignored[key]);
  // 乐观更新，失败回滚
  if (ignored) state.ignored[key] = true;
  else delete state.ignored[key];
  render();
  try {
    state.ignored = await fetchJson('/api/ignored', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: prNumber, ignored }),
    });
  } catch (err) {
    if (prev) state.ignored[key] = true;
    else delete state.ignored[key];
    toast(`忽略状态保存失败：${err.message}`);
  }
  render();
}

// ---------------------------------------------------------------- 渲染

function statusOf(pr) {
  const status = state.statusMap[String(pr.number)];
  // 状态集被用户改过名/删项后，statusMap 里可能残留悬空值，回落到未分配，
  // 让卡片仍然可见、可重新指派。
  return COLUMNS.some((col) => col.id === status) ? status : UNASSIGNED;
}

function isIgnored(pr) {
  return Boolean(state.ignored[String(pr.number)]);
}

function checklistsOf(pr) {
  return state.checklists.filter((item) => item.pr === pr.number);
}

function visiblePrs() {
  const query = state.query.trim().toLowerCase();
  return state.prs.filter((pr) => {
    if (!state.showIgnored && isIgnored(pr)) return false;
    if (state.milestoneFilter === 'none' && pr.milestone) return false;
    if (state.milestoneFilter !== 'all' && state.milestoneFilter !== 'none') {
      if ((pr.milestone?.title ?? '') !== state.milestoneFilter) return false;
    }
    if (state.authorFilter !== 'all' && (pr.author?.login ?? '') !== state.authorFilter) return false;
    if (!query) return true;
    const haystack = [
      pr.title, pr.headRefName, pr.baseRefName,
      pr.author?.login ?? '', String(pr.number),
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  });
}

function renderMilestoneOptions() {
  const titles = [...new Set(state.prs.map((pr) => pr.milestone?.title).filter(Boolean))];
  const current = state.milestoneFilter;
  el.milestoneFilter.replaceChildren();
  for (const [value, label] of [
    ['all', `全部 milestone`],
    ['none', `未挂 milestone`],
    ...titles.map((title) => [title, title]),
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    el.milestoneFilter.append(option);
  }
  el.milestoneFilter.value = [...el.milestoneFilter.options].some((o) => o.value === current)
    ? current : 'all';
  // select 回落时必须同步 state：否则已消失的 milestone 仍作为筛选条件，
  // 把剩余 PR 全部过滤掉（刷新后看起来像空看板）。
  state.milestoneFilter = el.milestoneFilter.value;
}

function renderAuthorOptions() {
  // 统计每个作者的 PR 数，按数量降序、登录名升序排列
  const counts = new Map();
  for (const pr of state.prs) {
    const login = pr.author?.login ?? '';
    if (!login) continue;
    counts.set(login, (counts.get(login) ?? 0) + 1);
  }
  const authors = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const current = state.authorFilter;
  el.authorFilter.replaceChildren();
  for (const [value, label] of [
    ['all', `全部作者`],
    ...authors.map(([login, n]) => [login, `${login} · ${n}`]),
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    el.authorFilter.append(option);
  }
  el.authorFilter.value = [...el.authorFilter.options].some((o) => o.value === current)
    ? current : 'all';
  // 与 milestone 筛选同理：作者消失时回落 all 并同步 state，避免筛出空看板。
  state.authorFilter = el.authorFilter.value;
}

function renderStats() {
  const total = state.prs.length;
  const pass = state.prs.filter((pr) => statusOf(pr) === 'pass').length;
  const noMs = state.prs.filter((pr) => !pr.milestone).length;
  const ignoredCount = Object.keys(state.ignored).length;
  const clPending = state.checklists.filter((c) => c.status === 'pending').length;
  el.stats.replaceChildren();
  for (const [n,label] of [[total,'个 PR'],[pass,'已验收'],[noMs,'未挂里程碑'],[ignoredCount,'已忽略'],[clPending,'待核验清单']]) {
    const metric = document.createElement('span'), number = document.createElement('b');
    number.textContent = String(n); metric.append(number, ' ' + label); el.stats.append(metric);
  }
}

function buildBadge(text, cls = '', title = '') {
  const span = document.createElement('span');
  span.className = `pill ${cls}`.trim();
  span.textContent = text;
  if (title) span.title = title;
  return span;
}

function buildCard(pr) {
  const card = document.createElement('article');
  card.className = 'card';
  card.draggable = true;
  card.dataset.pr = String(pr.number);
  if (!pr.milestone) card.classList.add('no-milestone');
  if (statusOf(pr) === 'pass') card.classList.add('is-pass');
  const ignored = isIgnored(pr);
  if (ignored) card.classList.add('is-ignored');

  // 标题（链接到 GitHub PR）
  const title = document.createElement('a');
  title.className = 'card-title';
  title.href = pr.url ?? '#';
  title.target = '_blank';
  title.rel = 'noreferrer';
  title.textContent = `#${pr.number} ${pr.title}`;
  title.setAttribute('aria-controls', 'pr-preview');
  title.setAttribute('aria-expanded', 'false');
  title.setAttribute('aria-describedby', 'pr-preview-hint');
  title.addEventListener('focus', () => {
    hidePrPreview();
    // Tab 聚焦屏外标题会先自动滚动；等滚动事件送达后再显示，避免刚打开就被关闭。
    previewFocusFrame = requestAnimationFrame(() => {
      previewFocusFrame = 0;
      if (document.activeElement === title) showPrPreview(card, title, pr);
    });
  });
  title.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    showPrPreview(card, title, pr);
    el.prPreviewBody.focus({ preventScroll: true });
  });
  card.addEventListener('mouseenter', () => schedulePrPreview(card, title, pr));
  card.addEventListener('mouseleave', scheduleHidePrPreview);
  card.addEventListener('focusout', scheduleHidePrPreview);
  card.append(title);

  // 徽标行：CI、draft、milestone、作者
  const badges = document.createElement('div');
  badges.className = 'card-badges';

  const checks = summarizeChecksClient(pr.statusCheckRollup);
  const ci = document.createElement('span');
  ci.className = 'pill';
  ci.append(Object.assign(document.createElement('span'), { className: `ci-dot ci-${checks}` }));
  ci.append(document.createTextNode({
    ok: 'CI 通过', failing: 'CI 失败', running: 'CI 运行中', none: '无 CI',
  }[checks]));
  badges.append(ci);

  if (pr.isDraft) badges.append(buildBadge('Draft', 'draft'));
  if (pr.milestone) {
    badges.append(buildBadge(pr.milestone.title, 'ms'));
    const due = duePill(pr.milestone);
    if (due) badges.append(buildBadge(due.text, due.cls));
  } else {
    badges.append(buildBadge('未挂 milestone', 'ms-missing', '建议分配到某个 milestone'));
  }
  badges.append(buildBadge(`@${pr.author?.login ?? 'unknown'}`));
  if (ignored) badges.append(buildBadge('已忽略', 'ignored', '该 PR 已被忽略，仅在「显示已忽略」时可见'));
  if (pr.headRefName) badges.append(buildBadge(`${pr.headRefName} → ${pr.baseRefName}`));
  card.append(badges);

  // 元信息行
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = `更新于 ${timeAgo(pr.updatedAt)}`;
  card.append(meta);

  // 核对清单行
  const checkRow = document.createElement('div');
  checkRow.className = 'card-check';
  const cls = checklistsOf(pr);
  if (cls.length > 0) {
    for (const item of cls) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `cl-pill cl-${item.status}`;
      pill.textContent = `清单 ${item.status}${cls.length > 1 ? ` · ${item.date || item.task}` : ''}`;
      pill.title = `点击复制清单路径：${item.file}`;
      pill.addEventListener('click', () => copyText(item.absPath ?? item.file, '清单路径已复制'));
      checkRow.append(pill);
    }
  } else {
    const gen = document.createElement('button');
    gen.type = 'button';
    gen.className = 'mini-btn';
    gen.textContent = '生成清单';
    gen.title = '复制唤起 Hermes 的提示词，粘贴给 Hermes 即可生成人工核对清单';
    gen.addEventListener('click', () => copyText(generationPrompt(pr), '提示词已复制，贴给 Hermes 即可'));
    checkRow.append(gen);
    const hint = document.createElement('span');
    hint.className = 'muted';
    hint.textContent = '尚无核对清单';
    checkRow.append(hint);
  }
  card.append(checkRow);

  // 动作行：忽略 + 状态下拉
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const ignoreBtn = document.createElement('button');
  ignoreBtn.type = 'button';
  ignoreBtn.className = 'mini-btn';
  ignoreBtn.textContent = ignored ? '取消忽略' : '忽略';
  ignoreBtn.title = ignored
    ? '取消忽略后卡片恢复常驻看板'
    : '忽略后卡片从看板隐藏，可用工具栏「已忽略」开关找回';
  ignoreBtn.addEventListener('click', () => toggleIgnored(pr.number, !ignored));
  actions.append(ignoreBtn);
  const select = document.createElement('select');
  select.title = '分配状态';
  select.setAttribute('aria-label', `PR #${pr.number} 状态`);
  for (const col of COLUMNS) {
    const option = document.createElement('option');
    option.value = col.id;
    option.textContent = col.label;
    select.append(option);
  }
  select.value = statusOf(pr);
  select.addEventListener('change', () => assignStatus(pr.number, select.value));
  // 阻止 select 交互触发卡片拖拽
  select.addEventListener('mousedown', (e) => e.stopPropagation());
  actions.append(select);
  card.append(actions);

  // 拖拽事件
  card.addEventListener('dragstart', (e) => {
    hidePrPreview();
    e.dataTransfer.setData('text/plain', String(pr.number));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  return card;
}

// 前端版 CI 汇总（与 serve.mjs 的 summarizeChecks 同规则，避免再发一次请求；
// 两处需同步修改）。CheckRun 用 conclusion，StatusContext 用 state。
function summarizeChecksClient(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  const GOOD = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'EXPECTED']);
  const BAD = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR', 'STALE']);
  let bad = false;
  let running = false;
  for (const check of rollup) {
    const conclusion = String(check?.conclusion ?? check?.state ?? '').toUpperCase();
    if (BAD.has(conclusion)) bad = true;
    else if (!GOOD.has(conclusion)) running = true;
  }
  if (bad) return 'failing';
  if (running) return 'running';
  return 'ok';
}

function generationPrompt(pr) {
  return [
    `请为 MAW（moys-asr-workflow）PR #${pr.number}「${pr.title}」生成人工核对清单：`,
    '1. 用 gh 拉取该 PR 的 diff、描述与 CI 情况；',
    '2. 按 tools/verification-checklist 的 Markdown v2 源格式写 <主题>.checklist.md（front-matter 带本 PR 号与日期）；',
    '3. build.py --check 自查通过后，生成 HTML 到 .artifacts/dev-dashboard/pr-' + pr.number + '/verification.html；',
    '4. 完成后告诉我清单路径和覆盖范围。',
  ].join('\n');
}

function render() {
  hidePrPreview();
  renderMilestoneOptions();
  renderAuthorOptions();
  renderStats();
  el.toggleIgnored.textContent = state.showIgnored
    ? `已忽略 ${Object.keys(state.ignored).length}（显示中）`
    : `已忽略 ${Object.keys(state.ignored).length}`;
  el.toggleIgnored.classList.toggle('active', state.showIgnored);

  const prs = visiblePrs();
  const byColumn = new Map(COLUMNS.map((col) => [col.id, []]));
  for (const pr of prs) byColumn.get(statusOf(pr))?.push(pr);

  el.board.replaceChildren();
  for (const col of COLUMNS) {
    const items = byColumn.get(col.id) ?? [];
    const column = document.createElement('section');
    column.className = 'column';
    column.dataset.status = col.id;

    const head = document.createElement('div');
    head.className = 'column-head';
    const name = document.createElement('span');
    name.className = 'column-title';
    name.textContent = col.label;
    const hint = document.createElement('span');
    hint.className = 'column-hint';
    hint.textContent = col.hint;
    const count = document.createElement('span');
    count.className = 'column-count';
    count.textContent = String(items.length);
    head.append(name, hint, count);
    column.append(head);

    const body = document.createElement('div');
    body.className = 'column-body';
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'column-empty';
      empty.textContent = '拖卡片到这里';
      body.append(empty);
    } else {
      for (const pr of items) body.append(buildCard(pr));
    }
    column.append(body);

    column.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      column.classList.add('drag-over');
    });
    column.addEventListener('dragleave', () => column.classList.remove('drag-over'));
    column.addEventListener('drop', (e) => {
      e.preventDefault();
      column.classList.remove('drag-over');
      const prNumber = Number(e.dataTransfer.getData('text/plain'));
      if (Number.isInteger(prNumber) && prNumber > 0) assignStatus(prNumber, col.id);
    });

    el.board.append(column);
  }
  if(!prs.length && state.prs.length) {
    const empty=document.createElement('div'); empty.className='tool-empty';
    empty.textContent='当前筛选下没有 PR。';
    const reset=document.createElement('button'); reset.type='button'; reset.textContent='重置筛选';
    reset.addEventListener('click',()=>document.getElementById('reset-filters').click());
    empty.append(document.createElement('br'),reset); el.board.prepend(empty);
  }

  const filtered = prs.length !== state.prs.length;
  el.filterMeta.textContent = filtered ? `筛出 ${prs.length} / ${state.prs.length}` : '';
}

// ---------------------------------------------------------------- 启动

function showError(err) {
  el.banner.textContent = `数据加载失败：${err.message}`;
  el.banner.hidden = false;
}

let refreshing = false;
let hasLoaded = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  hidePrPreview();
  el.refreshBtn.disabled = true;
  el.refreshBtn.textContent = hasLoaded ? '刷新中…' : '读取中…';
  el.loadingText.textContent = hasLoaded ? '正在刷新看板数据，现有卡片仍可使用…' : '正在读取看板数据…';
  el.loadingStatus.hidden = false;
  el.board.setAttribute('aria-busy', 'true');
  try {
    await loadAll();
    hasLoaded = true;
    const missingBodies = state.prs.filter((pr) => !hasPrBody(pr)).length;
    el.banner.hidden = missingBodies === 0;
    el.banner.textContent = missingBodies
      ? `看板服务与页面不匹配：${missingBodies} 个 PR 的正文尚未获取。${PR_BODY_RESTART_HINT}` : '';
  } catch (err) {
    showError(err);
  } finally {
    hidePrPreview();
    refreshing = false;
    el.loadingStatus.hidden = true;
    el.loadingText.textContent = '';
    el.board.setAttribute('aria-busy', 'false');
    el.refreshBtn.disabled = false;
    el.refreshBtn.textContent = '刷新';
  }
}

el.refreshBtn.addEventListener('click', refresh);
el.openChangelog.addEventListener('click', () => {
  window.open('/changelog-editor/index.html', '_blank', 'noreferrer');
});
el.milestoneFilter.addEventListener('change', () => {
  state.milestoneFilter = el.milestoneFilter.value;
  render();
});
el.authorFilter.addEventListener('change', () => {
  state.authorFilter = el.authorFilter.value;
  render();
});
el.toggleIgnored.addEventListener('click', () => {
  state.showIgnored = !state.showIgnored;
  render();
});
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {state.query = el.search.value; render();},180);
});
let searchTimer = 0;
document.getElementById('reset-filters').addEventListener('click', () => {
  clearTimeout(searchTimer);
  state.query = ''; state.milestoneFilter = 'all'; state.authorFilter = 'all';
  el.search.value = ''; render();
});
el.autoRefresh.addEventListener('change', () => {
  localStorage.setItem(AUTO_REFRESH_KEY, el.autoRefresh.checked ? '1' : '');
});
el.autoRefresh.checked = localStorage.getItem(AUTO_REFRESH_KEY) === '1';
setInterval(() => {
  if (el.autoRefresh.checked && document.visibilityState === 'visible') refresh();
}, AUTO_REFRESH_MS);

refresh();
