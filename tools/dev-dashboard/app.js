'use strict';
// MAW Dev Dashboard 前端。
// 数据全部来自本地 server（/api/prs、/api/checklists、/api/status），
// 渲染只用 createElement + textContent（PR 标题、作者名都是外部输入，禁止 innerHTML 拼接）。

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
  milestoneFilter: 'all',
  query: '',
};

const el = {
  board: document.getElementById('board'),
  stats: document.getElementById('stats'),
  banner: document.getElementById('banner'),
  toast: document.getElementById('toast'),
  refreshBtn: document.getElementById('refresh-btn'),
  openChangelog: document.getElementById('open-changelog'),
  autoRefresh: document.getElementById('auto-refresh'),
  milestoneFilter: document.getElementById('milestone-filter'),
  search: document.getElementById('search'),
  filterMeta: document.getElementById('filter-meta'),
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
  if (days <= 7) return { text: `${milestone.title} · 剩 ${days} 天`, cls: 'due-soon' };
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

// ---------------------------------------------------------------- 数据

async function loadAll() {
  const [prs, checklists, statusMap] = await Promise.all([
    fetchJson('/api/prs'),
    fetchJson('/api/checklists'),
    fetchJson('/api/status'),
  ]);
  state.prs = Array.isArray(prs) ? prs : [];
  state.checklists = Array.isArray(checklists) ? checklists : [];
  state.statusMap = statusMap && typeof statusMap === 'object' ? statusMap : {};
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

// ---------------------------------------------------------------- 渲染

function statusOf(pr) {
  return state.statusMap[String(pr.number)] ?? UNASSIGNED;
}

function checklistsOf(pr) {
  return state.checklists.filter((item) => item.pr === pr.number);
}

function visiblePrs() {
  const query = state.query.trim().toLowerCase();
  return state.prs.filter((pr) => {
    if (state.milestoneFilter === 'none' && pr.milestone) return false;
    if (state.milestoneFilter !== 'all' && state.milestoneFilter !== 'none') {
      if ((pr.milestone?.title ?? '') !== state.milestoneFilter) return false;
    }
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
}

function renderStats() {
  const total = state.prs.length;
  const pass = state.prs.filter((pr) => statusOf(pr) === 'pass').length;
  const noMs = state.prs.filter((pr) => !pr.milestone).length;
  const clPending = state.checklists.filter((c) => c.status === 'pending').length;
  el.stats.textContent =
    `${total} 个 open PR · pass ${pass} · 未挂 milestone ${noMs} · 待核验清单 ${clPending}`;
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

  // 标题（链接到 GitHub PR）
  const title = document.createElement('a');
  title.className = 'card-title';
  title.href = pr.url ?? '#';
  title.target = '_blank';
  title.rel = 'noreferrer';
  title.textContent = `#${pr.number} ${pr.title}`;
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

  // 动作行：打开 PR + 状态下拉
  const actions = document.createElement('div');
  actions.className = 'card-actions';
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
    e.dataTransfer.setData('text/plain', String(pr.number));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  return card;
}

// 前端版 CI 汇总（与 serve.mjs 的 summarizeChecks 同规则，避免再发一次请求）。
function summarizeChecksClient(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  const GOOD = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'EXPECTED']);
  const BAD = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR', 'STALE']);
  let bad = false;
  let running = false;
  for (const check of rollup) {
    const conclusion = String(check?.conclusion ?? '').toUpperCase();
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
  renderMilestoneOptions();
  renderStats();

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

  const filtered = prs.length !== state.prs.length;
  el.filterMeta.textContent = filtered ? `筛出 ${prs.length} / ${state.prs.length}` : '';
}

// ---------------------------------------------------------------- 启动

function showError(err) {
  el.banner.textContent = `数据加载失败：${err.message}`;
  el.banner.hidden = false;
}

async function refresh() {
  el.refreshBtn.disabled = true;
  try {
    await loadAll();
    el.banner.hidden = true;
  } catch (err) {
    showError(err);
  } finally {
    el.refreshBtn.disabled = false;
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
el.search.addEventListener('input', () => {
  state.query = el.search.value;
  render();
});
el.autoRefresh.addEventListener('change', () => {
  localStorage.setItem(AUTO_REFRESH_KEY, el.autoRefresh.checked ? '1' : '');
});
el.autoRefresh.checked = localStorage.getItem(AUTO_REFRESH_KEY) === '1';
setInterval(() => {
  if (el.autoRefresh.checked && document.visibilityState === 'visible') refresh();
}, AUTO_REFRESH_MS);

refresh();
