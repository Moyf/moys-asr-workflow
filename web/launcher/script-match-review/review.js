(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const PAGE_SIZE = 50;
  const MIN_TIMELINE_SPAN = 500;
  const SEEK_MAX_TIMELINE_SPAN = 30_000;
  const MAX_SCROLL_WIDTH = 8_000_000;
  const NOTES_GAP = 8;
  const zh = {
    title: 'MAW 文稿匹配对照', reset: '重置筛选', export: '导出调整后的 MOSP', warnings: '匹配说明',
    exportHint: '建议优先使用启动台的「文稿修正」操作',
    range: '时间 / 差异', before: '原始字幕', script: '文稿候选', after: '调整后的字幕',
    noResults: '没有符合条件的差异。', prev: '上一页', next: '下一页', timeline: '时间分布',
    timelineHint: '滚轮平移 · Ctrl+滚轮横向缩放 · 点击字幕块定位', fit: '重置缩放', seek: '定位时间（秒）', locate: '定位',
    span10: '10 秒窗口', span30: '30 秒窗口', span60: '1 分钟窗口', presets: '常用时间窗口',
    jump: '跳转到时间线位置', notesCount: n => `${n} 条说明`,
    search: '搜索字幕或文稿', filter: '筛选差异', different: '只看差异', all: '全部对照组',
    fragment: '候选长度异常 · 保留原文', unmatched: '无对应文稿 · 保留原文', estimated: '字词时间码估算',
    clipped: '重叠 · 已裁短', dropped: '重叠 · 未纳入结果', overlay: '禁用字幕已移至叠加轨', timing: '时间或分段变化',
    attributes: '词项或字幕属性变化',
    manual: '已调整', changed: '文字有变化', disabled: '禁用', none: '—', edit: '修改字幕',
    filters: {
      different: ['只看变化和异常', '显示文字、时间或分段有变化的组，也包括匹配异常和手动调整。'],
      all: ['显示全部', '显示所有字幕组，包括完全没变的组。'],
      fragment: ['保留原字幕：候选长短差太多', '对应文稿片段比原字幕过短或过长，系统没有采用它，保留了原字幕。'],
      unmatched: ['保留原字幕：没找到对应文稿', '没有找到可靠的文稿片段，系统没有替换原字幕。'],
      estimated: ['估算了字词时间', '原字幕没有字词级时间码，系统按整段的起止时间估算；不等于音频重新对齐。'],
      clipped: ['因时间重叠而缩短', '原字幕与新字幕部分重叠，只在剩余的空档保留原字幕。'],
      overlay: ['禁用字幕移至叠加轨', '原时间、词码和禁用状态均保留。恢复本组时会将这条字幕放回主轨。'],
      attributes: ['词项或字幕属性变化', '正文与段起止相同，但词项、身份或其他保存字段有变化。恢复本组可取回原字段。'],
      dropped: ['因时间重叠而未保留', '原字幕的时间被新字幕完全覆盖，没有空档可保留，因此未出现在匹配结果中。'],
      timing: ['起止时间或分段已变', '显示起止时间发生变化，或原字幕被拆分、合并的组。'],
      manual: ['手动调整过', '只显示当前已改字或已恢复原字幕的组。'],
    },
    restore: '恢复本组原字幕', adopt: '采用本组匹配结果', apply: '应用', cancel: '取消',
    scriptMode: '按文稿换行', textMode: '只更正文本', zoomIn: '放大时间线', zoomOut: '缩小时间线',
    saveError: '导出失败', saveLoading: '正在另存 MOSP…', saved: path => `已另存：${path}`,
    cards: n => `${n} 条字幕`, groups: (count, page, total) => `${count} 组 · 第 ${page} / ${total} 页`,
    state: (changed, edited) => `${changed} 组差异 · ${edited} 组手动调整。调整只在当前窗口保留，导出才写入文件。`,
    loadingError: '无法载入对照数据。请返回 Launcher 重试。', notFound: '该时间没有可定位的字幕。',
    coverage: (script, source) => `字符覆盖率：文稿 ${script} · 原字幕 ${source}`,
  };
  const en = {
    title: 'MAW Script Match Review', reset: 'Reset filters', export: 'Export adjusted MOSP', warnings: 'Match notes',
    exportHint: 'Prefer using Script Correction in Launcher.',
    range: 'Time / differences', before: 'Original subtitles', script: 'Manuscript candidates', after: 'Adjusted subtitles',
    noResults: 'No differences match the filters.', prev: 'Previous', next: 'Next', timeline: 'Timeline',
    timelineHint: 'Scroll to pan · Ctrl+scroll to zoom · click a cue to locate', fit: 'Reset zoom', seek: 'Go to time (seconds)', locate: 'Go',
    span10: '10s window', span30: '30s window', span60: '1min window', presets: 'Timeline window presets',
    jump: 'Show on timeline', notesCount: n => `${n} ${n === 1 ? 'note' : 'notes'}`,
    search: 'Search subtitles or manuscript', filter: 'Filter differences', different: 'Differences only', all: 'All groups',
    fragment: 'Candidate length mismatch · original kept', unmatched: 'No manuscript match · original kept', estimated: 'Estimated word timing',
    clipped: 'Overlap · shortened', dropped: 'Overlap · omitted', overlay: 'Disabled cue moved to overlay', timing: 'Timing or segmentation changed',
    attributes: 'Word timing or cue attributes changed',
    manual: 'Manually adjusted', changed: 'Text changed', disabled: 'Disabled', none: '—', edit: 'Edit text',
    filters: {
      different: ['Changes and issues only', 'Show changes to text, timing or segmentation, plus match issues and manual edits.'],
      all: ['Show all', 'Show every subtitle group, including unchanged groups.'],
      fragment: ['Original kept: length mismatch', 'The manuscript candidate was too short or too long compared with the original, so it was not used.'],
      unmatched: ['Original kept: no reliable match', 'No reliable manuscript passage was found, so the original subtitle was not replaced.'],
      estimated: ['Estimated word timing', 'Word timing was missing and was estimated from the original cue bounds, not realigned to the audio.'],
      overlay: ['Disabled cue moved to overlay', 'The cue keeps its original time, word timings and disabled state. Restore this group to return it to the main track.'],
      attributes: ['Changed cue attributes', 'The text and cue bounds match, but word timings or other saved fields differ. Restore the group to keep the original fields.'],
      clipped: ['Shortened due to overlap', 'The original cue partially overlapped a new cue, so it was kept only in the remaining gap.'],
      dropped: ['Omitted due to overlap', 'New cues fully covered the original cue, leaving no gap to keep it in the result.'],
      timing: ['Timing or cue splits changed', 'Show groups with changed boundaries, split cues or merged cues.'],
      manual: ['Manual adjustments only', 'Show groups with current text edits or restored original subtitles.'],
    },
    restore: 'Restore this group', adopt: 'Use matched group', apply: 'Apply', cancel: 'Cancel',
    scriptMode: 'Use manuscript breaks', textMode: 'Correct text only', zoomIn: 'Zoom in', zoomOut: 'Zoom out',
    saveError: 'Export failed', saveLoading: 'Saving MOSP…', saved: path => `Saved as: ${path}`,
    cards: n => `${n} cues`, groups: (count, page, total) => `${count} groups · page ${page} / ${total}`,
    state: (changed, edited) => `${changed} changed groups · ${edited} manually adjusted. Edits stay in this window until exported.`,
    loadingError: 'Could not load review data. Reopen it from Launcher.', notFound: 'There is no subtitle to locate at this time.',
    coverage: (script, source) => `Character coverage: manuscript ${script} · source ${source}`,
  };
  const FILTERS = ['different', 'all', 'fragment', 'unmatched', 'estimated', 'clipped', 'dropped', 'overlay', 'attributes', 'timing', 'manual'];
  let text = zh;
  let api, data, changedCount, duration;
  let visible = [], page = 0, selected = null, selectedTime = null, searchTimer, timelineFrame, saving = false;
  let windowStart = 0, windowSpan, syncedScroll = 0;
  let tracks = [[], []], tracksDirty = true, hover = null;
  let trackEnds = [[], []];
  const review = new Map();
  const rendered = new Map();

  const create = (name, content, className) => {
    const node = document.createElement(name);
    if (content != null) node.textContent = content;
    if (className) node.className = className;
    return node;
  };
  function button(label, callback, className = 'btn') {
    const node = create('button', label, className);
    node.type = 'button';
    node.addEventListener('click', callback);
    return node;
  }
  const time = value => `${String(Math.floor(value / 3600000)).padStart(2, '0')}:${String(Math.floor(value / 60000) % 60).padStart(2, '0')}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')}.${String(value % 1000).padStart(3, '0')}`;
  function tickTime(ms, step) {
    const [hours, minutes, seconds] = time(ms).split('.')[0].split(':');
    const whole = Number(hours) ? `${Number(hours)}:${minutes}:${seconds}` : `${Number(minutes)}:${seconds}`;
    if (step >= 1000 && step % 1000 === 0) return whole;
    const fraction = String(ms % 1000).padStart(3, '0');
    return `${whole}.${fraction.slice(0, step % 100 === 0 ? 1 : step % 10 === 0 ? 2 : 3)}`;
  }
  const cueTime = cue => `${time(cue.start)} – ${time(cue.end)}`;
  const output = group => review.get(group.id)?.restore ? group.before : group.after;
  const isAdjusted = group => Boolean(review.get(group.id)?.restore || review.get(group.id)?.edits.size);
  const isDifferent = group => group.changed || group.issues.length || isAdjusted(group);
  const outputText = (group, cue) => review.get(group.id)?.edits.get(cue.index) ?? cue.text;

  function updateLabels() {
    document.querySelectorAll('[data-copy]').forEach(node => { node.textContent = text[node.dataset.copy]; });
    document.title = text.title;
    $('search').placeholder = `${text.search}…`;
    $('search').setAttribute('aria-label', text.search);
    $('filter').setAttribute('aria-label', text.filter);
    $('zoom-in').setAttribute('aria-label', text.zoomIn);
    $('zoom-out').setAttribute('aria-label', text.zoomOut);
    $('zoom-presets').setAttribute('aria-label', text.presets);
    updateThemeLabel();
  }
  function updateThemeLabel() {
    if (text !== en) return;
    const toggle = document.querySelector('[data-tool-theme]');
    const label = document.documentElement.dataset.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }
  function feedback(value = '', kind = '') {
    $('feedback').textContent = value;
    $('feedback').dataset.kind = kind;
    $('feedback').hidden = !value;
  }
  function status() {
    const edited = [...review.values()].filter(state => state.restore || state.edits.size).length;
    $('state').textContent = text.state(changedCount, edited);
    let resultCount = data.afterCount;
    for (const [id, state] of review) {
      if (state.restore) resultCount += data.groups[id].before.length - data.groups[id].after.length;
    }
    $('cards').lastElementChild.lastElementChild.textContent = text.cards(resultCount);
  }
  function card(label, detail) {
    const node = create('div', null, 'card');
    const caption = create('strong', label);
    caption.title = label;
    node.append(caption, create('small', detail));
    return node;
  }

  function initMatchNotes() {
    if (!data.warnings.length) return;
    const trigger = $('warnings'), panel = $('match-notes');
    $('notes-count').textContent = text.notesCount(data.warnings.length);
    $('warning-list').append(...data.warnings.map(warning => create('li', warning)));
    trigger.hidden = false;

    let pinned = false, hideTimer;
    const contains = node => trigger.contains(node) || panel.contains(node);
    function position() {
      if (panel.hidden) return;
      const rect = trigger.getBoundingClientRect();
      const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
      const above = rect.top - NOTES_GAP * 2;
      const below = height - rect.bottom - NOTES_GAP * 2;
      const placeBelow = below >= Math.min(300, panel.scrollHeight + 2) || below >= above;
      panel.style.maxHeight = `${Math.max(0, Math.min(320, placeBelow ? below : above))}px`;
      panel.style.left = `${Math.max(NOTES_GAP, Math.min(rect.right - panel.offsetWidth, width - panel.offsetWidth - NOTES_GAP))}px`;
      panel.style.top = `${placeBelow ? rect.bottom + NOTES_GAP : rect.top - panel.offsetHeight - NOTES_GAP}px`;
    }
    function show() {
      clearTimeout(hideTimer);
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      position();
    }
    function hide() {
      clearTimeout(hideTimer);
      pinned = false;
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
    function scheduleHide() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!pinned && !trigger.matches(':hover, :focus-visible') && !panel.matches(':hover, :focus-within')) hide();
      }, 200);
    }
    for (const target of [trigger, panel]) {
      target.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse' || event.pointerType === 'pen') show(); });
      target.addEventListener('pointerleave', scheduleHide);
      target.addEventListener('focusout', scheduleHide);
    }
    trigger.addEventListener('focus', () => { if (trigger.matches(':focus-visible')) show(); });
    trigger.addEventListener('click', () => {
      if (pinned) hide();
      else { pinned = true; show(); }
    });
    trigger.addEventListener('keydown', event => {
      if (event.key === 'Tab' && !event.shiftKey && !panel.hidden) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
      }
    });
    panel.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      if (event.shiftKey) trigger.focus({ preventScroll: true });
      else document.querySelector('.table-scroll').focus({ preventScroll: true });
      if (!event.shiftKey) hide();
    });
    document.addEventListener('pointerdown', event => { if (!panel.hidden && !contains(event.target)) hide(); });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || panel.hidden) return;
      if (panel.contains(document.activeElement)) trigger.focus({ preventScroll: true });
      hide();
      event.preventDefault();
    });
    window.addEventListener('resize', position);
    trigger.closest('.review-summary').addEventListener('scroll', () => {
      const owner = trigger.closest('.review-summary').getBoundingClientRect();
      const rect = trigger.getBoundingClientRect();
      if (rect.top < owner.top || rect.bottom > owner.bottom) hide();
      else position();
    });
  }
  function showCues(parent, cues, group) {
    if (!cues.length) parent.append(create('p', text.none, 'muted'));
    for (const cue of cues) {
      const node = create('div', null, 'cue');
      node.append(create('span', `${cueTime(cue)}${cue.disabled ? ` · ${text.disabled}` : ''}`, 'time'));
      const value = create('p', group ? outputText(group, cue) : cue.text);
      node.append(value);
      if (group) {
        const actions = create('div', null, 'actions');
        const editButton = button('', () => {
          const input = create('textarea');
          input.setAttribute('aria-label', `${text.edit}: ${cueTime(cue)}`);
          const initial = outputText(group, cue);
          input.value = initial;
          const updateEdit = nextValue => {
            const state = review.get(group.id) || { restore: false, edits: new Map() };
            if (nextValue === cue.text) state.edits.delete(cue.index);
            else state.edits.set(cue.index, nextValue);
            review.set(group.id, state);
            value.textContent = nextValue;
            updateBadges(group);
            status();
          };
          input.addEventListener('input', () => updateEdit(input.value));
          const finish = apply => {
            if (!apply) updateEdit(initial);
            value.hidden = false;
            input.remove();
            actions.replaceChildren(editButton);
            editButton.focus();
          };
          value.hidden = true;
          actions.before(input);
          actions.replaceChildren(button(text.apply, () => finish(true)), button(text.cancel, () => finish(false)));
          input.addEventListener('keydown', event => { if (event.key === 'Escape') finish(false); });
          input.focus();
        });
        setActionIcon(editButton, 'edit', text.edit);
        actions.append(editButton);
        node.append(actions);
      }
      parent.append(node);
    }
  }
  function updateBadges(group) {
    const stack = rendered.get(group.id)?.querySelector('.badges');
    if (!stack) return;
    const tags = group.issues.map(key => create('span', text[key], 'badge'));
    if (group.changed && !group.issues.some(key => ['timing', 'attributes', 'overlay'].includes(key))) {
      tags.push(create('span', text.changed, 'badge changed'));
    }
    if (isAdjusted(group)) tags.push(create('span', text.manual, 'badge manual'));
    stack.replaceChildren(...tags);
  }
  const svgNS = 'http://www.w3.org/2000/svg';
  const actionPaths = {
    locate: 'M12 2v4m0 12v4M2 12h4m12 0h4 M19 12a7 7 0 1 1-14 0 7 7 0 1 1 14 0 M12 11v2',
    restore: 'M4 11V5m0 6h6M4 11l4-4a7 7 0 1 1 0 10',
    adopt: 'M20 11V5m0 6h-6m6 0-4-4a7 7 0 1 0 0 10',
    edit: 'M15 5l4 4M4 20l1-5L16.5 3.5a2.8 2.8 0 0 1 4 4L9 19z',
  };
  function setActionIcon(button, icon, label) {
    const svg = document.createElementNS(svgNS, 'svg');
    const path = document.createElementNS(svgNS, 'path');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    path.setAttribute('d', actionPaths[icon]);
    svg.append(path);
    button.classList.add('tool-icon-action');
    button.setAttribute('aria-label', label);
    button.dataset.toolTip = label;
    button.replaceChildren(svg);
  }
  function makeRow(group) {
    const row = create('tr');
    row.tabIndex = -1;
    row.toggleAttribute('data-active', selected === group.id);
    const wrap = () => {
      const cell = row.insertCell();
      const stack = create('div', null, 'cell-stack');
      cell.append(stack);
      return stack;
    };
    const range = wrap();
    range.append(create('span', `${time(group.start)}\n${time(group.end)}`, 'time range-text'), create('div', null, 'badges'));
    const actions = create('div', null, 'actions');
    const jump = button('', () => selectTimeline(group, group.start, { center: true, maxSpan: SEEK_MAX_TIMELINE_SPAN }), 'btn jump-timeline');
    setActionIcon(jump, 'locate', text.jump);
    actions.append(jump);
    range.append(actions);
    let action;
    if (group.changed || group.issues.length) {
      action = button('', () => {
        const current = review.get(group.id);
        if (current?.edits.size && !window.confirm(text === en ? 'Discard manual text edits in this group?' : '要清除此组的手动改字吗？')) return;
        review.set(group.id, { restore: !current?.restore, edits: new Map() });
        tracksDirty = true;
        drawOutput();
        updateBadges(group);
        drawTimeline();
        status();
      });
      actions.append(action);
    }
    showCues(wrap(), group.before);
    const candidates = wrap();
    for (const candidate of group.candidates) candidates.append(create('p', candidate, 'candidate'));
    if (!group.candidates.length) candidates.append(create('p', text.none, 'muted'));
    const result = wrap();
    function drawOutput() {
      if (action) {
        const restored = review.get(group.id)?.restore;
        setActionIcon(action, restored ? 'adopt' : 'restore', restored ? text.adopt : text.restore);
      }
      result.replaceChildren();
      showCues(result, output(group), group);
    }
    drawOutput();
    return row;
  }
  function renderRows(scrollToTop = true) {
    rendered.clear();
    const nodes = visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(group => {
      const row = makeRow(group);
      rendered.set(group.id, row);
      updateBadges(group);
      return row;
    });
    $('rows').replaceChildren(...nodes);
    $('no-results').hidden = visible.length !== 0;
    $('prev').disabled = page <= 0;
    $('next').disabled = (page + 1) * PAGE_SIZE >= visible.length;
    $('page-count').textContent = text.groups(visible.length, page + 1, Math.max(1, Math.ceil(visible.length / PAGE_SIZE)));
    if (scrollToTop) $('rows').closest('.table-scroll').scrollTop = 0;
  }
  function applyFilters() {
    const filter = $('filter').value;
    const hint = $('filter-hint');
    const description = text.filters[filter][1];
    if (hint.textContent !== description) hint.textContent = description;
    const query = $('search').value.trim().toLocaleLowerCase();
    visible = data.groups.filter(group => {
      if (!(filter === 'all' || (filter === 'different' && isDifferent(group)) || (filter === 'manual' && isAdjusted(group)) || group.issues.includes(filter))) return false;
      return !query || [...group.before.map(c => c.text), ...group.candidates, ...output(group).map(c => outputText(group, c))].some(value => value.toLocaleLowerCase().includes(query));
    });
    page = 0;
    renderRows();
  }
  function resetFilters(filter = 'different') {
    clearTimeout(searchTimer);
    $('search').value = '';
    $('filter').value = filter;
    applyFilters();
  }

  const maxWindowStart = () => Math.max(0, duration - windowSpan);
  const viewportWidth = () => Math.max(1, $('wave-scroll').clientWidth);

  // The wide element only supplies a scrollbar. A viewport-sized canvas follows
  // it, so fine zoom on long recordings does not allocate a giant bitmap.
  function syncTimelineScroll() {
    const scroller = $('wave-scroll');
    const width = viewportWidth();
    $('timeline').style.width = `${width}px`;
    $('wave-track').style.width = `${Math.min(MAX_SCROLL_WIDTH, Math.max(width, Math.ceil(width * duration / windowSpan)))}px`;
    const limit = maxWindowStart();
    windowStart = Math.max(0, Math.min(windowStart, limit));
    scroller.scrollLeft = limit ? windowStart / limit * (scroller.scrollWidth - scroller.clientWidth) : 0;
    syncedScroll = scroller.scrollLeft;
  }
  function readTimelineScroll() {
    const scroller = $('wave-scroll');
    if (scroller.scrollLeft === syncedScroll) return;
    const scrollRange = scroller.scrollWidth - scroller.clientWidth;
    syncedScroll = scroller.scrollLeft;
    windowStart = scrollRange ? syncedScroll / scrollRange * maxWindowStart() : 0;
  }
  function firstGroupEndingAfter(ms) {
    let low = 0, high = data.groups.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (data.groups[middle].end <= ms) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  function scheduleTimelineDraw() {
    if (timelineFrame !== undefined) return;
    timelineFrame = requestAnimationFrame(() => {
      timelineFrame = undefined;
      drawTimeline();
    });
  }
  // 时间轴两条轨道的扁平字幕序列。奇偶交替的明暗锚定在整条序列的序号上，
  // 滚动或缩放时单个字幕块的明暗不会翻转。
  function rebuildTracks() {
    tracks = [[], []];
    for (const group of data.groups) {
      for (const cue of group.before) tracks[0].push(cue);
      for (const cue of output(group)) tracks[1].push(cue);
    }
    trackEnds = tracks.map(track => {
      let maximum = 0;
      return track.map(cue => (maximum = Math.max(maximum, cue.end)));
    });
    tracksDirty = false;
  }
  function firstCueEndingAfter(side, ms) {
    const ends = trackEnds[side];
    let low = 0, high = ends.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (ends[middle] <= ms) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  function cueAt(ms, side) {
    if (tracksDirty) rebuildTracks();
    const track = tracks[side];
    let hit = null;
    for (let i = firstCueEndingAfter(side, ms); i < track.length && track[i].start <= ms; i++) {
      if (ms < track[i].end) hit = track[i];
    }
    return hit;
  }
  function drawTimeline() {
    if (tracksDirty) rebuildTracks();
    const canvas = $('timeline');
    const width = viewportWidth();
    const scale = Math.min(devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * scale), pixelHeight = Math.round(76 * scale);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / 76, 0, 0);
    ctx.clearRect(0, 0, width, 76);
    ctx.globalAlpha = 1;
    const palette = getComputedStyle(document.documentElement);
    const color = name => palette.getPropertyValue(name).trim();
    const windowEnd = windowStart + windowSpan;
    const x = ms => (ms - windowStart) * width / windowSpan;
    const paintRange = (start, end, y, height) => {
      if (end <= windowStart || start >= windowEnd) return;
      const left = x(Math.max(start, windowStart)), right = x(Math.min(end, windowEnd));
      ctx.fillRect(left, y, Math.max(1, right - left), height);
    };
    const active = selected !== null ? data.groups[selected] : null;
    if (active) {
      ctx.fillStyle = color('--accent-soft');
      paintRange(active.start, active.end, 23, 48);
    }
    ctx.font = `11px ${color('--font-mono')}`;
    const rawStep = windowSpan / Math.max(2, width / 104);
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, rawStep)));
    const step = Math.ceil(rawStep / magnitude) * magnitude;
    const gridColor = color('--border'), tickColor = color('--text-muted');
    for (let ms = Math.ceil(windowStart / step) * step; ms < windowEnd; ms += step) {
      const left = x(ms);
      ctx.fillStyle = gridColor;
      ctx.fillRect(left, 21, 1, 51);
      ctx.fillStyle = tickColor;
      const label = tickTime(ms, step);
      if (left + 4 + ctx.measureText(label).width <= width) ctx.fillText(label, left + 4, 15);
    }
    const colors = [color('--series-1'), color('--series-2')];
    // 相邻字幕块之间留出发丝缝，块本身按序号明暗交替：时间上无缝相接的
    // 字幕也能数清块数；真实停顿仍然直接露出背景。
    for (let side = 0; side < 2; side++) {
      const track = tracks[side];
      ctx.fillStyle = colors[side];
      for (let i = firstCueEndingAfter(side, windowStart); i < track.length; i++) {
        const cue = track[i];
        if (cue.start >= windowEnd) break;
        if (cue.end <= windowStart) continue;
        ctx.globalAlpha = cue.disabled ? .4 : (i % 2 ? .68 : .9);
        const clippedStart = cue.start < windowStart, clippedEnd = cue.end > windowEnd;
        const left = x(Math.max(cue.start, windowStart)) + (clippedStart ? 0 : .75);
        const right = x(Math.min(cue.end, windowEnd)) - (clippedEnd ? 0 : .75);
        ctx.fillRect(left, 28 + side * 24, Math.max(1, right - left), 16);
      }
    }
    if (hover && hover.end > windowStart && hover.start < windowEnd) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color('--accent');
      ctx.lineWidth = 1.5;
      const left = x(Math.max(hover.start, windowStart)), right = x(Math.min(hover.end, windowEnd));
      ctx.strokeRect(left + .75, 28 + hover.side * 24 + .75, Math.max(1.5, right - left - 1.5), 13.5);
    }
    if (selectedTime !== null && windowStart <= selectedTime && selectedTime < windowEnd) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = color('--accent');
      ctx.fillRect(x(selectedTime), 21, 2, 51);
    }
  }
  function selectTimeline(group, ms, { center = false, maxSpan = Infinity } = {}) {
    if (selected !== null) rendered.get(selected)?.removeAttribute('data-active');
    selected = group.id;
    selectedTime = ms;
    rendered.get(selected)?.setAttribute('data-active', '');
    $('seek-feedback').textContent = '';
    $('seek').value = `${ms / 1000}`;
    const narrowed = windowSpan > maxSpan;
    if (narrowed) setWindowSpan(maxSpan);
    if (center || narrowed || ms < windowStart || ms >= windowStart + windowSpan) {
      windowStart = ms - windowSpan / 2;
      syncTimelineScroll();
    }
    drawTimeline();
  }
  function locate(ms, side, maxSpan = Infinity) {
    readTimelineScroll();
    const narrowed = Number.isFinite(ms) && windowSpan > maxSpan;
    if (narrowed) {
      setWindowSpan(maxSpan);
      windowStart = ms - windowSpan / 2;
      syncTimelineScroll();
    }
    const group = data.groups[firstGroupEndingAfter(ms)];
    const contains = cue => cue.start <= ms && cue.end > ms;
    if (!Number.isFinite(ms) || !group || group.start > ms ||
        !((side !== 1 && group.before.some(contains)) || (side !== 0 && output(group).some(contains)))) {
      $('seek-feedback').textContent = text.notFound;
      if (narrowed) drawTimeline();
      return;
    }
    if (!visible.includes(group)) resetFilters('all');
    page = Math.floor(visible.indexOf(group) / PAGE_SIZE);
    renderRows(false);
    rendered.get(group.id)?.focus({ preventScroll: true });
    rendered.get(group.id)?.scrollIntoView({ block: 'center', inline: 'nearest' });
    selectTimeline(group, ms);
  }
  function setWindowSpan(span) {
    windowSpan = span;
    $('zoom-in').disabled = windowSpan <= Math.min(MIN_TIMELINE_SPAN, duration);
    $('zoom-out').disabled = windowSpan >= duration;
    $('zoom-presets').querySelectorAll('button').forEach(item => {
      item.setAttribute('aria-pressed', `${Number(item.dataset.span) === windowSpan}`);
    });
  }
  function changeZoom(span, fit = false, pointerFraction = null) {
    readTimelineScroll();
    const anchor = selectedTime !== null && selectedTime >= windowStart && selectedTime < windowStart + windowSpan
      ? selectedTime : windowSpan >= duration ? windowStart : windowStart + windowSpan / 2;
    const minSpan = Math.min(MIN_TIMELINE_SPAN, duration);
    const pointerTime = pointerFraction === null ? null : windowStart + windowSpan * pointerFraction;
    const nextSpan = Math.max(minSpan, span);
    if (!fit && nextSpan === windowSpan) return;
    setWindowSpan(nextSpan);
    windowStart = fit ? 0 : pointerTime === null ? anchor - windowSpan / 2 : pointerTime - windowSpan * pointerFraction;
    syncTimelineScroll();
    drawTimeline();
  }
  async function save() {
    if (saving) return;
    saving = true;
    $('export').disabled = true;
    feedback(text.saveLoading);
    const restore = [], edits = [];
    for (const [id, state] of review) {
      if (state.restore) restore.push(id);
      for (const [index, value] of state.edits) edits.push([state.restore ? 0 : 1, index, value]);
    }
    try {
      const result = await api.export_review({ restore, edits });
      if (result.cancelled) feedback();
      else if (result.ok) feedback(text.saved(result.path));
      else feedback(`${text.saveError}：${result.error || ''}`, 'error');
    } catch (error) {
      feedback(`${text.saveError}：${error.message || ''}`, 'error');
    } finally {
      saving = false;
      $('export').disabled = false;
    }
  }
  async function start() {
    api = window.pywebview?.api;
    if (!api || data) return;
    try { data = await api.review_data(); }
    catch (_) { $('empty').textContent = text.loadingError; return; }
    text = data.lang === 'en' ? en : zh;
    document.documentElement.lang = data.lang === 'en' ? 'en' : 'zh-CN';
    updateLabels();
    changedCount = data.groups.filter(isDifferent).length;
    duration = Math.max(1, data.groups.at(-1)?.end || 0);
    windowSpan = duration;
    $('empty').hidden = true;
    $('workspace').hidden = false;
    $('toolbar').hidden = false;
    $('heading').textContent = `${text.before} → ${text.after} · ${data.mode === 'text' ? text.textMode : text.scriptMode}`;
    const formattedCoverage = data.coverage?.map(rate => new Intl.NumberFormat(document.documentElement.lang, { style: 'percent' }).format(rate));
    $('cards').append(card(data.source, text.cards(data.beforeCount)), card(data.script, formattedCoverage ? text.coverage(...formattedCoverage) : text.script), card(text.after, text.cards(data.afterCount)));
    initMatchNotes();
    $('filter').append(...FILTERS.map(key => Object.assign(create('option', text.filters[key][0]), { value: key })));
    $('filter').addEventListener('change', applyFilters);
    $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilters, 150); });
    $('reset').addEventListener('click', () => { resetFilters(); $('filter').focus(); });
    $('clear-empty').addEventListener('click', () => { resetFilters('all'); $('filter').focus(); });
    $('prev').addEventListener('click', () => { page--; renderRows(); if ($('prev').disabled) $('next').focus(); });
    $('next').addEventListener('click', () => { page++; renderRows(); if ($('next').disabled) $('prev').focus(); });
    $('export').addEventListener('click', save);
    $('zoom-out').addEventListener('click', () => changeZoom(Math.min(duration, windowSpan * 2)));
    $('zoom-in').addEventListener('click', () => changeZoom(windowSpan / 2));
    $('fit').addEventListener('click', () => changeZoom(duration, true));
    $('zoom-presets').querySelectorAll('button').forEach(item => {
      item.addEventListener('click', () => changeZoom(Number(item.dataset.span)));
    });
    $('seek-form').addEventListener('submit', event => {
      event.preventDefault();
      locate(Math.round(Number($('seek').value) * 1000), undefined, SEEK_MAX_TIMELINE_SPAN);
    });
    $('timeline').addEventListener('click', event => {
      readTimelineScroll();
      const box = $('timeline').getBoundingClientRect();
      const y = event.clientY - box.top;
      locate(Math.floor(windowStart + (event.clientX - box.left) * windowSpan / box.width), y < 24 ? undefined : Number(y >= 48));
    });
    $('timeline').addEventListener('pointermove', event => {
      readTimelineScroll();
      const box = $('timeline').getBoundingClientRect();
      const y = event.clientY - box.top;
      const side = y < 24 ? null : Number(y >= 48);
      const ms = windowStart + (event.clientX - box.left) * windowSpan / box.width;
      const cue = side === null ? null : cueAt(ms, side);
      const next = cue ? { start: cue.start, end: cue.end, side } : null;
      if (next?.start !== hover?.start || next?.end !== hover?.end || next?.side !== hover?.side) {
        hover = next;
        scheduleTimelineDraw();
      }
    });
    $('timeline').addEventListener('pointerleave', () => {
      if (!hover) return;
      hover = null;
      scheduleTimelineDraw();
    });
    $('wave-scroll').addEventListener('scroll', () => { readTimelineScroll(); scheduleTimelineDraw(); });
    // Ctrl/Command anchors zoom under the pointer; ordinary wheel input pans.
    $('wave-scroll').addEventListener('wheel', event => {
      if (event.altKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const scroller = $('wave-scroll');
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = scroller.getBoundingClientRect();
        const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / scroller.clientWidth));
        const span = event.deltaY < 0 ? windowSpan / 1.25 : Math.min(Math.max(duration, windowSpan), windowSpan * 1.25);
        changeZoom(span, false, fraction);
        return;
      }
      if (scroller.scrollWidth <= scroller.clientWidth) return;
      event.preventDefault();
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      scroller.scrollLeft += delta;
    }, { passive: false });
    new ResizeObserver(() => {
      syncTimelineScroll();
      scheduleTimelineDraw();
    }).observe($('wave-scroll'));
    document.addEventListener('tool-theme-change', () => { updateThemeLabel(); drawTimeline(); });
    resetFilters();
    status();
    changeZoom(duration, true);
  }
  if (window.pywebview?.api) void start();
  else window.addEventListener('pywebviewready', () => { void start(); }, { once: true });
})();
