import { fmtSrtTime, syncCharCountThresholdInputs, updateTimedTextEditSingleGuide } from './editor-cue-elements.js';
import { finishEdit } from './editor-inline-edit.js';
import { releaseClosedUiFocus } from './editor-keyboard-targets.js';
import { splitGroupsAtCutPoints } from './editor-segment-ops.js';
import { clearSelection } from './editor-selection.js';

// 整轨定时编辑：逐行 diff 呈现、时间映射与覆盖统计。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweTimedTextEdit 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
// 整轨定时编辑：逐行 diff 呈现、时间映射与覆盖统计。 ESM init 模块：initMaweTimedTextEdit 在原清单位次执行原 IIFE 体（挂
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweTimedTextEdit 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。

// window.MaweTimedTextEdit 冻结门面——classic 侧出接口）；底部具名导出经门面在调用时转发，
// 兄弟模块可静态 import。
export function initMaweTimedTextEdit() {
(function initMaweTimedTextEdit(global) {
  'use strict';

  const timedTextEditFindInput = document.getElementById('timed-text-edit-find');
  const timedTextEditReplaceInput = document.getElementById('timed-text-edit-replace');
  const timedTextEditSearchCount = document.getElementById('timed-text-edit-search-count');
  const timedTextEditSearchError = document.getElementById('timed-text-edit-search-error');
  const timedTextEditSearchMirror = document.getElementById('timed-text-edit-search-mirror');
  const timedTextEditGutter = document.getElementById('timed-text-edit-gutter');
  const timedTextEditSearchReplaceToggle = document.getElementById('timed-text-edit-replace-toggle');
  const timedTextEditSearchReplaceRow = document.getElementById('timed-text-edit-replace-row');
  const timedTextEditSearchCase = document.getElementById('timed-text-edit-case');
  const timedTextEditSearchRegex = document.getElementById('timed-text-edit-regex');
  const timedTextEditSearchPrevious = document.getElementById('timed-text-edit-find-previous');
  const timedTextEditSearchNext = document.getElementById('timed-text-edit-find-next');
  const timedTextEditSearchReplaceOne = document.getElementById('timed-text-edit-replace-one');
  const timedTextEditSearchReplaceAll = document.getElementById('timed-text-edit-replace-all');
  let timedTextEditSearchIndex = -1;
  // 搜索导航把焦点移入命中所在 textarea 后记录的「待续导航」状态：
  // 此时按 Enter 继续跳下一个/上一个命中，而不是往字幕里插入换行。
  // 一旦选区不再精确等于当前命中（点击、方向键、输入），立即失效，
  // Enter 恢复为普通换行，不影响「定位后拆句」的正常工作流。
  let timedTextEditArmedMatch = null;


  // === 纯文本编辑（支持调整字幕行结构的 MVP） ===
  function timedTextEditSegments(kind) {
    return kind === 'extension' ? MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments || [] : MaweBoot.DATA.segments;
  }



  function timedTextEditSourceSelection(kind, showDisabled = false) {
    const allSegments = timedTextEditSegments(kind);
    const sourceSegmentIndexes = allSegments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => showDisabled || segment?.disabled !== true)
      .map(({ index }) => index);
    return {
      allSegments,
      sourceSegmentIndexes,
      sourceSegments: sourceSegmentIndexes.map((index) => allSegments[index]),
    };
  }



  function currentTimedTextEditKind() {
    const panelTarget = MaweCuePanel.getCurrentCuePanelTarget?.();
    if (panelTarget?.kind === 'extension' && panelTarget.track?.segments?.length) return 'extension';
    if (MaweSelection.selectedIdxs.size === 0 && MaweSelection.selectedExtensionIdxs.size > 0
        && MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments?.length) return 'extension';
    return 'main';
  }



  function timedTextEditTrackLabel(kind) {
    if (kind !== 'extension') return '主字幕';
    const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
    return track?.name ? `副字幕（${track.name}）` : '副字幕';
  }



  function appendTimedTextEditStat(container, label, value, filterKey = null, count = 0) {
    const row = document.createElement('div');
    row.className = 'timed-text-edit-stat-row';
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const valueEl = filterKey && count > 0 ? document.createElement('button') : document.createElement('strong');
    if (filterKey && count > 0) {
      valueEl.type = 'button';
      valueEl.className = 'timed-text-edit-stat-filter';
      valueEl.classList.toggle('active', MaweDom.timedTextEditDraft?.filter === filterKey);
      valueEl.addEventListener('click', () => {
        if (!MaweDom.timedTextEditDraft) return;
        MaweDom.timedTextEditDraft.filter = filterKey;
        MaweDom.timedTextEditChangeDetails.open = true;
        flushTimedTextEditReport();
      });
    }
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    container.appendChild(row);
  }



  function appendTimedTextEditDivider(container) {
    const divider = document.createElement('div');
    divider.className = 'timed-text-edit-report-divider';
    container.appendChild(divider);
  }



  function appendTimedTextEditDiffLine(container, label, parts, className) {
    const line = document.createElement('div');
    line.className = `timed-text-edit-diff-line ${className}`;
    const labelEl = document.createElement('span');
    labelEl.className = 'timed-text-edit-diff-label';
    labelEl.textContent = label;
    line.appendChild(labelEl);
    (parts || []).forEach((part) => {
      if (!part?.text) return;
      const text = document.createElement('span');
      text.className = `timed-text-edit-diff-part ${part.kind || 'equal'}`;
      text.textContent = part.text;
      line.appendChild(text);
    });
    container.appendChild(line);
  }



  function timedTextEditTimingPill(value, kind) {
    const pill = document.createElement('span');
    pill.className = kind ? `timed-text-edit-timing-pill ${kind}` : 'timed-text-edit-timing-pill';
    pill.textContent = value;
    return pill;
  }


  function timedTextEditEstimatedBadge() {
    // badge 文案与 title 只写中文原文，i18n 的 MutationObserver 会按当前语言翻译。
    const badge = document.createElement('span');
    badge.className = 'timed-text-edit-estimated-badge';
    badge.textContent = '估算';
    badge.title = '缺少可靠时间码，新时间范围基于字数估算。';
    return badge;
  }


  function appendTimedTextEditTimingChange(container, beforeStart, beforeEnd, afterStart, afterEnd, timingEstimated) {
    // diff 布局：未变化的值只出现一次，箭头分隔变化对，起止沿用「 – 」。
    // timing 未变化但为估算时，badge 单独成行，避免估算提示凭空消失。
    if (beforeStart !== afterStart || beforeEnd !== afterEnd) {
      const timing = document.createElement('div');
      timing.className = 'timed-text-edit-timing-change';
      timing.appendChild(document.createTextNode('时间范围：'));
      if (beforeStart !== afterStart && beforeEnd !== afterEnd) {
        timing.append(
          timedTextEditTimingPill(fmtSrtTime(beforeStart), 'before'),
          document.createTextNode(' – '),
          timedTextEditTimingPill(fmtSrtTime(beforeEnd), 'before'),
          document.createTextNode(' → '),
          timedTextEditTimingPill(fmtSrtTime(afterStart), 'after'),
          document.createTextNode(' – '),
          timedTextEditTimingPill(fmtSrtTime(afterEnd), 'after'),
        );
      } else if (beforeStart !== afterStart) {
        timing.append(
          timedTextEditTimingPill(fmtSrtTime(beforeStart), 'before'),
          document.createTextNode(' – '),
          timedTextEditTimingPill(fmtSrtTime(afterStart), 'after'),
          document.createTextNode(' → '),
          timedTextEditTimingPill(fmtSrtTime(afterEnd)),
        );
      } else {
        timing.append(
          timedTextEditTimingPill(fmtSrtTime(beforeStart)),
          document.createTextNode(' → '),
          timedTextEditTimingPill(fmtSrtTime(beforeEnd), 'before'),
          document.createTextNode(' – '),
          timedTextEditTimingPill(fmtSrtTime(afterEnd), 'after'),
        );
      }
      if (timingEstimated) timing.appendChild(timedTextEditEstimatedBadge());
      container.appendChild(timing);
      return;
    }
    if (!timingEstimated) return;
    const estimatedOnly = document.createElement('div');
    estimatedOnly.className = 'timed-text-edit-timing-change';
    estimatedOnly.appendChild(timedTextEditEstimatedBadge());
    container.appendChild(estimatedOnly);
  }


  function renderTimedTextEditRowDiff(rowElement, reportRow) {
    const diffElement = rowElement.querySelector('.timed-text-edit-row-diff');
    const timingElement = rowElement.querySelector('.timed-text-edit-row-timing');
    if (!diffElement || !timingElement) return;
    diffElement.replaceChildren();
    timingElement.replaceChildren();
    diffElement.hidden = !reportRow.changed;
    timingElement.hidden = !reportRow.timingChanged && !reportRow.timingEstimated && !reportRow.deleted;
    if (reportRow.changed) {
      appendTimedTextEditDiffLine(diffElement, '修改前：', reportRow.diff.before, 'before');
      appendTimedTextEditDiffLine(diffElement, '修改后：', reportRow.diff.after, 'after');
    }
    if (reportRow.timingChanged || reportRow.timingEstimated) {
      appendTimedTextEditTimingChange(
        timingElement,
        reportRow.beforeStart,
        reportRow.beforeEnd,
        reportRow.afterStart,
        reportRow.afterEnd,
        reportRow.timingEstimated,
      );
    }
    if (reportRow.deleted) {
      const deleted = document.createElement('div');
      deleted.className = 'timed-text-edit-deleted-label';
      deleted.textContent = '整句删除（时间码已转移到其他字幕）';
      timingElement.appendChild(deleted);
    }
  }



  function timedTextEditMappingLabel(status) {
    return {
      full: '完整映射',
      partial: '部分映射',
      lost: '时间码丢失',
      unavailable: '原本没有字词时间码',
      boundary: '边界移动（时间码已转移）',
      structure: '结构调整（时间码已重新分配）',
      deleted: '整句删除（时间码已转移）',
    }[status] || '未分析';
  }



  function timedTextEditCoverageClass(percent) {
    if (percent <= 0) return 'none';
    return percent > 90 ? 'good' : 'partial';
  }



  function renderTimedTextEditMetric(element, percent, kind, title = '') {
    if (!element) return;
    const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    const isReuse = kind === 'reuse';
    element.textContent = `${isReuse ? '♻️' : '⌚️'}${safePercent}%`;
    element.className = `timed-text-edit-${isReuse ? 'reuse' : 'coverage'} ${timedTextEditCoverageClass(safePercent)}`;
    element.title = title || `${isReuse ? '原始时间码复用率' : '有效字词时间码覆盖率'}：${safePercent}%`;
  }



  function renderTimedTextEditChangeList(report) {
    const wasOpen = MaweDom.timedTextEditChangeDetails.open;
    // 默认展开：用户没有手动点过 summary（changeListTouched）时，有修改内容就展开；
    // 一旦手动收起/展开过，后续渲染只保留用户的选择，避免每次击键把面板强行弹开。
    const touched = Boolean(MaweDom.timedTextEditDraft?.changeListTouched);
    MaweDom.timedTextEditChangeList.replaceChildren();
    const filter = MaweDom.timedTextEditDraft?.filter || null;
    const deletedRows = report.structure?.valid
      ? (report.rows || [])
        .filter((row) => row.deleted)
        .map((row) => ({ ...row, mappingStatus: 'deleted' }))
      : [];
    const displayRows = report.structure?.valid && report.outputRows?.length
      ? [...report.outputRows, ...deletedRows]
      : report.changedRows;
    const rows = filter === 'unchanged'
      ? []
      : displayRows.filter((row) => row.changed && (!filter || row.mappingStatus === filter));
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'modal-hint';
      empty.textContent = filter ? '当前筛选没有修改内容。' : '还没有修改内容。';
      MaweDom.timedTextEditChangeList.appendChild(empty);
      MaweDom.timedTextEditChangeDetails.open = Boolean(filter && filter !== 'unchanged');
      return;
    }
    rows.forEach((row) => {
      const item = document.createElement('div');
      item.className = `timed-text-edit-change-item${row.deleted ? ' deleted' : ''}`;
      const title = document.createElement('div');
      title.className = 'timed-text-edit-change-item-title';
      title.textContent = `第 ${row.index + 1} 条 · ${timedTextEditMappingLabel(row.mappingStatus)}`;
      item.appendChild(title);
      appendTimedTextEditDiffLine(item, '前：', row.diff.before, 'before');
      appendTimedTextEditDiffLine(item, '后：', row.diff.after, 'after');
      if (row.timingChanged || row.timingEstimated) {
        appendTimedTextEditTimingChange(
          item,
          row.beforeStart,
          row.beforeEnd,
          row.afterStart,
          row.afterEnd,
          row.timingEstimated,
        );
      }
      if (row.deleted) {
        const deleted = document.createElement('div');
        deleted.className = 'timed-text-edit-deleted-label';
        deleted.textContent = '整句删除（时间码已转移到其他字幕）';
        item.appendChild(deleted);
      }
      MaweDom.timedTextEditChangeList.appendChild(item);
    });
    MaweDom.timedTextEditChangeDetails.open = touched ? wasOpen : true;
  }



  function renderTimedTextEditRows() {
    MaweDom.timedTextEditRows.replaceChildren();
    if (!MaweDom.timedTextEditDraft) return;
    const report = MaweDom.timedTextEditDraft.report;
    const rowReports = timedTextEditDraftRowReports(report, MaweDom.timedTextEditDraft.texts);
    MaweDom.timedTextEditDraft.texts.forEach((textValue, index) => {
      const rowReport = rowReports[index];
      const segment = report?.structure?.valid && Number.isInteger(rowReport?.draftIndex)
        ? report.previewSegments[rowReport.index]
        : (!report?.structure?.valid && MaweDom.timedTextEditDraft.texts.length === MaweDom.timedTextEditDraft.sourceSegments.length
          ? MaweDom.timedTextEditDraft.sourceSegments[index] : null);
      const rowSourceIndexes = Array.isArray(rowReport?.sourceIndexes)
        ? rowReport.sourceIndexes : [index];
      const rowIncludesDisabled = rowSourceIndexes.some((sourceIndex) => (
        MaweDom.timedTextEditDraft.sourceSegments[sourceIndex]?.disabled === true
      ));
      const row = document.createElement('div');
      row.className = `timed-text-edit-row${rowReport?.deleted ? ' deleted' : ''}${rowIncludesDisabled ? ' disabled' : ''}`;
      if (rowIncludesDisabled) row.title = '已禁用字幕';
      row.dataset.index = String(index);
      const meta = document.createElement('div');
      meta.className = 'timed-text-edit-row-meta';
      const number = document.createElement('strong');
      number.textContent = String(index + 1);
      const time = document.createElement('span');
      time.className = 'timed-text-edit-row-time';
      time.textContent = segment
        ? `${fmtSrtTime(segment.start)}\n${fmtSrtTime(segment.end)}` : '—\n—';
      const coverage = document.createElement('span');
      const coverageData = window.AsrEditorUtils.timedTextItemCoverage(
        textValue, segment?.items,
      );
      const reuseData = window.AsrEditorUtils.timedTextItemReuse(
        textValue, segment?.items, textValue, segment?.items, 'full',
      );
      renderTimedTextEditMetric(
        coverage,
        coverageData.percent,
        'coverage',
        segment ? `有效字词时间码覆盖率：${coverageData.coveredCharacters}/${coverageData.totalCharacters}` : '等待可靠时间码映射',
      );
      const reuse = document.createElement('span');
      renderTimedTextEditMetric(
        reuse,
        reuseData.percent,
        'reuse',
        segment ? `原始时间码复用率：${reuseData.reusedCharacters}/${reuseData.totalCharacters}` : '等待原始时间码映射',
      );
      const badges = document.createElement('span');
      badges.className = 'timed-text-edit-time-badges';
      badges.append(coverage, reuse);
      const timeLine = document.createElement('div');
      timeLine.className = 'timed-text-edit-row-time-line';
      timeLine.append(time, badges);
      meta.append(number, timeLine);
      const main = document.createElement('div');
      main.className = 'timed-text-edit-row-main';
      const textarea = document.createElement('textarea');
      textarea.dataset.index = String(index);
      textarea.value = textValue;
      textarea.rows = Math.min(5, Math.max(2, String(textValue || '').split('\n').length));
      textarea.spellcheck = false;
      textarea.setAttribute('aria-label', `第 ${index + 1} 条字幕文本`);
      const diff = document.createElement('div');
      diff.className = 'timed-text-edit-row-diff';
      diff.hidden = true;
      // 行编辑器容器承载搜索高亮镜像（结构与整体编辑的 single-editor 一致）。
      const editor = document.createElement('div');
      editor.className = 'timed-text-edit-row-editor';
      const mirror = document.createElement('div');
      mirror.className = 'timed-text-edit-row-search-mirror';
      mirror.setAttribute('aria-hidden', 'true');
      editor.append(mirror, textarea);
      const timing = document.createElement('div');
      timing.className = 'timed-text-edit-row-timing';
      timing.hidden = true;
      main.append(editor, diff, timing);
      row.append(meta, main);
      MaweDom.timedTextEditRows.appendChild(row);
    });
  }



  function timedTextEditCanUseSingleView() {
    const draft = MaweDom.timedTextEditDraft;
    if (!draft) return false;
    // sourceSegments 只在 loadTimedTextEditTrack 重建 draft 时替换，与会话内的
    // 文本草稿无关；结果恒定，读缓存避免每次击键全量扫描所有字幕行。
    if (typeof draft.canUseSingleView !== 'boolean') {
      draft.canUseSingleView = draft.sourceSegments.every(
        (segment) => !String(segment?.text || '').includes('\n'),
      );
    }
    return draft.canUseSingleView;
  }



  function renderTimedTextEditView() {
    if (!MaweDom.timedTextEditDraft) return;
    const canUseSingle = timedTextEditCanUseSingleView();
    const singleOption = MaweDom.timedTextEditView?.querySelector('[data-view="single"]');
    if (singleOption) {
      singleOption.disabled = !canUseSingle;
      const reason = canUseSingle ? '' : '当前字幕包含换行，暂不能切换到整体编辑视图';
      singleOption.parentElement.title = window.MAWE_I18N?.translateText?.(reason) || reason;
    }
    if (!canUseSingle && MaweDom.timedTextEditDraft.view === 'single') MaweDom.timedTextEditDraft.view = 'rows';
    const single = MaweDom.timedTextEditDraft.view === 'single' && canUseSingle;
    MaweDom.timedTextEditView?.querySelectorAll('[data-view]').forEach((button) => {
      const active = button.dataset.view === (single ? 'single' : 'rows');
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    MaweDom.timedTextEditRows.hidden = single;
    MaweDom.timedTextEditCharcountThresholdControl.hidden = !single;
    MaweDom.timedTextEditSingleEditor.hidden = !single;
    MaweDom.timedTextEditSingleTextarea.hidden = !single;
    MaweDom.timedTextEditSingleHint.hidden = !single || !MaweDom.timedTextEditDraft.singleLineError;
    if (single) {
      syncCharCountThresholdInputs();
      MaweDom.timedTextEditSingleTextarea.value = MaweDom.timedTextEditDraft.singleText;
      updateTimedTextEditSingleGuide();
    }
    updateTimedTextEditGutter();
    refreshTimedTextEditSearch({ preserveIndex: true });
  }


  // 整体编辑行号列（账本 #33）：textarea 左侧的字幕行序号。单视图关闭软换行
  // （white-space: pre + wrap="off"），可视行与字幕行一一对应，序号即「第 N 条」；
  // 行号取自 textarea 当前值（含末尾因输入习惯多出的空行），与草稿的规范化
  // 结果无关。数字列不横向滚动：只在 textarea 滚动时同步 scrollTop。
  function updateTimedTextEditGutter() {
    if (!timedTextEditGutter || !MaweDom.timedTextEditDraft) return;
    const numbers = window.AsrEditorUtils.timedTextEditGutterNumbers(
      MaweDom.timedTextEditSingleTextarea?.value ?? '',
    );
    // 序号始终是 1..N 的位置编号，行数没变就没有任何可见变化。
    if (timedTextEditGutter.childElementCount === numbers.length) return;
    const fragment = document.createDocumentFragment();
    numbers.forEach((number) => {
      const line = document.createElement('div');
      line.className = 'timed-text-edit-gutter-line';
      line.textContent = String(number);
      fragment.appendChild(line);
    });
    timedTextEditGutter.replaceChildren(fragment);
    timedTextEditGutter.scrollTop = MaweDom.timedTextEditSingleTextarea?.scrollTop || 0;
  }


  function timedTextEditSearchOptions() {
    return {
      caseSensitive: timedTextEditSearchCase?.getAttribute('aria-pressed') === 'true',
      useRegex: timedTextEditSearchRegex?.getAttribute('aria-pressed') === 'true',
    };
  }


  function collectTimedTextEditSearchMatches() {
    if (!MaweDom.timedTextEditDraft) return { error: null, matches: [] };
    return window.AsrEditorUtils.collectTextSearchMatches(
      MaweDom.timedTextEditDraft.texts,
      timedTextEditFindInput?.value || '',
      timedTextEditSearchOptions(),
    );
  }


  function renderTimedTextEditSearchMirror(matches) {
    const mirror = timedTextEditSearchMirror;
    if (!mirror || !MaweDom.timedTextEditDraft) return;
    const text = MaweDom.timedTextEditDraft.singleText || '';
    const current = matches[timedTextEditSearchIndex] || null;
    mirror.replaceChildren();
    let cursor = 0;
    matches.forEach((match) => {
      const start = Math.max(cursor, Math.min(text.length, match.globalStart));
      const end = Math.max(start, Math.min(text.length, match.globalEnd));
      if (start > cursor) mirror.appendChild(document.createTextNode(text.slice(cursor, start)));
      const mark = document.createElement('span');
      mark.className = `search-match${match === current ? ' is-current' : ''}${start === end ? ' is-zero-length' : ''}`;
      mark.dataset.searchMatchIndex = String(match.matchIndex);
      if (start < end) mark.textContent = text.slice(start, end);
      mirror.appendChild(mark);
      cursor = end;
    });
    if (cursor < text.length) mirror.appendChild(document.createTextNode(text.slice(cursor)));
    const textarea = MaweDom.timedTextEditSingleTextarea;
    mirror.scrollTop = textarea?.scrollTop || 0;
    mirror.scrollLeft = textarea?.scrollLeft || 0;
  }


  // 逐条编辑的每行高亮：与整体编辑的镜像层同款做法。只为有命中的行渲染镜像
  // 并把该行文字透明化（行多时不给无命中行增加任何渲染成本）。
  function renderTimedTextEditRowSearchMirrors(matches, currentMatch) {
    const rowsContainer = MaweDom.timedTextEditRows;
    if (!rowsContainer || !MaweDom.timedTextEditDraft) return;
    const matchesByLine = new Map();
    (matches || []).forEach((match) => {
      if (!matchesByLine.has(match.lineIndex)) matchesByLine.set(match.lineIndex, []);
      matchesByLine.get(match.lineIndex).push(match);
    });
    if (!matchesByLine.size) {
      rowsContainer.querySelectorAll('.timed-text-edit-row.search-highlight').forEach((row) => {
        row.classList.remove('search-highlight');
        row.querySelector('.timed-text-edit-row-search-mirror')?.replaceChildren();
      });
      return;
    }
    rowsContainer.querySelectorAll('.timed-text-edit-row').forEach((row) => {
      const mirror = row.querySelector('.timed-text-edit-row-search-mirror');
      if (!mirror) return;
      const lineMatches = matchesByLine.get(Number(row.dataset.index));
      if (!lineMatches?.length) {
        if (mirror.firstChild) mirror.replaceChildren();
        row.classList.remove('search-highlight');
        return;
      }
      row.classList.add('search-highlight');
      const text = String(MaweDom.timedTextEditDraft.texts?.[Number(row.dataset.index)] ?? '');
      mirror.replaceChildren();
      let cursor = 0;
      lineMatches.forEach((match) => {
        const start = Math.max(cursor, Math.min(text.length, match.start));
        const end = Math.max(start, Math.min(text.length, match.end));
        if (start > cursor) mirror.appendChild(document.createTextNode(text.slice(cursor, start)));
        const mark = document.createElement('span');
        mark.className = `search-match${match === currentMatch ? ' is-current' : ''}${start === end ? ' is-zero-length' : ''}`;
        mark.dataset.searchMatchIndex = String(match.matchIndex);
        if (start < end) mark.textContent = text.slice(start, end);
        mirror.appendChild(mark);
        cursor = end;
      });
      if (cursor < text.length) mirror.appendChild(document.createTextNode(text.slice(cursor)));
      mirror.scrollTop = row.querySelector('textarea')?.scrollTop || 0;
      mirror.scrollLeft = row.querySelector('textarea')?.scrollLeft || 0;
    });
  }


  function refreshTimedTextEditSearch({ resetIndex = false, preserveIndex = false } = {}) {
    const result = collectTimedTextEditSearchMatches();
    const matches = result.matches || [];
    if (result.error || !matches.length) timedTextEditSearchIndex = -1;
    else if (resetIndex) timedTextEditSearchIndex = 0;
    else if (preserveIndex) timedTextEditSearchIndex = Math.max(0, Math.min(timedTextEditSearchIndex, matches.length - 1));
    else timedTextEditSearchIndex = timedTextEditSearchIndex < 0
      ? 0 : Math.min(timedTextEditSearchIndex, matches.length - 1);

    if (timedTextEditSearchError) {
      timedTextEditSearchError.textContent = result.error
        ? `${window.MAWE_I18N?.translateText?.('正则表达式无效') || '正则表达式无效'}：${result.error}` : '';
      timedTextEditSearchError.hidden = !result.error;
    }
    if (timedTextEditSearchCount) {
      timedTextEditSearchCount.textContent = timedTextEditSearchIndex < 0
        ? `0/${matches.length}` : `${timedTextEditSearchIndex + 1}/${matches.length}`;
    }
    const canReplace = !result.error && matches.length > 0;
    if (timedTextEditSearchReplaceOne) timedTextEditSearchReplaceOne.disabled = !canReplace;
    if (timedTextEditSearchReplaceAll) timedTextEditSearchReplaceAll.disabled = !canReplace;
    renderTimedTextEditSearchMirror(matches);
    renderTimedTextEditRowSearchMirrors(matches, matches[timedTextEditSearchIndex] || null);
    MaweDom.timedTextEditRows?.querySelectorAll('.timed-text-edit-row.search-current').forEach((row) => {
      row.classList.remove('search-current');
    });
    return result;
  }


  // 显式导航（Enter / 上一个 / 下一个 / F3）时把焦点移入目标 textarea：
  // 选区随焦点落在命中文字上，caret 可见，用户可以直接继续编辑。
  // 在查找框输入时的预览定位（focusEditor=false）保持焦点在查找框，
  // 否则每敲一个字符焦点都会被抢走。
  function revealTimedTextEditSearchMatch(match, matches, { focusEditor = false } = {}) {
    timedTextEditArmedMatch = null;
    if (!match || !MaweDom.timedTextEditDraft) return;
    const draft = MaweDom.timedTextEditDraft;
    if (draft.view !== 'single') {
      const rowReports = timedTextEditDraftRowReports(draft.report, draft.texts);
      const rowReport = rowReports[match.lineIndex];
      if (draft.filter && (!rowReport || timedTextEditRowFilterKey(rowReport) !== draft.filter)) {
        draft.filter = null;
        flushTimedTextEditReport();
      }
      const row = MaweDom.timedTextEditRows.querySelector(`.timed-text-edit-row[data-index="${match.lineIndex}"]`);
      if (row) {
        row.classList.add('search-current');
        const containerRect = MaweDom.timedTextEditRows.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        MaweDom.timedTextEditRows.scrollTop += rowRect.top - containerRect.top
          + rowRect.height / 2 - MaweDom.timedTextEditRows.clientHeight / 2;
        const textarea = row.querySelector('textarea');
        textarea?.setSelectionRange(match.start, match.end);
        if (focusEditor && textarea) {
          textarea.focus({ preventScroll: true });
          timedTextEditArmedMatch = { textarea, start: match.start, end: match.end };
        }
      }
    } else {
      const textarea = MaweDom.timedTextEditSingleTextarea;
      const highlight = timedTextEditSearchMirror?.querySelector(
        `.search-match[data-search-match-index="${match.matchIndex}"]`,
      );
      if (textarea) textarea.setSelectionRange(match.globalStart, match.globalEnd);
      if (textarea && highlight) {
        const range = document.createRange();
        if (highlight.firstChild) range.selectNodeContents(highlight);
        else range.selectNode(highlight);
        const rect = range.getBoundingClientRect();
        const editorRect = textarea.getBoundingClientRect();
        if (rect.width || rect.height) {
          textarea.scrollTop += rect.top - editorRect.top - textarea.clientHeight / 2 + rect.height / 2;
          textarea.scrollLeft += rect.left - editorRect.left - textarea.clientWidth / 2 + rect.width / 2;
          timedTextEditSearchMirror.scrollTop = textarea.scrollTop;
          timedTextEditSearchMirror.scrollLeft = textarea.scrollLeft;
        }
      }
      if (focusEditor && textarea) {
        textarea.focus({ preventScroll: true });
        timedTextEditArmedMatch = { textarea, start: match.globalStart, end: match.globalEnd };
      }
    }
    if (!focusEditor) timedTextEditFindInput?.focus({ preventScroll: true });
  }


  function moveTimedTextEditSearchMatch(direction) {
    timedTextEditArmedMatch = null;
    const result = refreshTimedTextEditSearch({ preserveIndex: true });
    const matches = result.matches || [];
    if (result.error || !matches.length) return false;
    timedTextEditSearchIndex = ((timedTextEditSearchIndex + direction) % matches.length + matches.length) % matches.length;
    refreshTimedTextEditSearch({ preserveIndex: true });
    revealTimedTextEditSearchMatch(matches[timedTextEditSearchIndex], matches, { focusEditor: true });
    return true;
  }


  function applyTimedTextEditSearchReplacement(replaceAll) {
    const result = refreshTimedTextEditSearch({ preserveIndex: true });
    const matches = result.matches || [];
    if (result.error || !matches.length || !MaweDom.timedTextEditDraft) return false;
    const draft = MaweDom.timedTextEditDraft;
    const previousIndex = Math.max(0, timedTextEditSearchIndex);
    const current = matches[previousIndex];
    const options = timedTextEditSearchOptions();
    const replacement = timedTextEditReplaceInput?.value || '';
    const currentLine = draft.texts[current.lineIndex] || '';
    const inserted = options.useRegex
      ? window.AsrEditorUtils.expandTextSearchReplacement(replacement, current, currentLine)
      : replacement;
    const nextLines = replaceAll
      ? window.AsrEditorUtils.replaceAllTextSearchMatches(draft.texts, matches, replacement, options)
      : window.AsrEditorUtils.replaceTextSearchMatch(draft.texts, current, replacement, options);
    draft.texts.splice(0, draft.texts.length, ...normalizeTimedTextEditDraftLines(nextLines));
    draft.singleText = draft.texts.join('\n');
    draft.singleLineError = '';
    renderTimedTextEditRows();
    renderTimedTextEditView();
    flushTimedTextEditReport();
    const nextResult = refreshTimedTextEditSearch({ preserveIndex: false });
    if (nextResult.matches.length) {
      let nextIndex = 0;
      if (replaceAll) {
        nextIndex = Math.min(previousIndex, nextResult.matches.length - 1);
      } else {
        const afterInsertedText = current.globalStart + inserted.length;
        const skipSameZeroLengthMatch = current.start === current.end && inserted.length === 0;
        nextIndex = nextResult.matches.findIndex((match) => skipSameZeroLengthMatch
          ? match.globalStart > afterInsertedText
          : match.globalStart >= afterInsertedText);
        if (nextIndex < 0) nextIndex = 0;
      }
      timedTextEditSearchIndex = nextIndex;
      refreshTimedTextEditSearch({ preserveIndex: true });
      revealTimedTextEditSearchMatch(nextResult.matches[nextIndex], nextResult.matches);
    }
    return true;
  }


  function setTimedTextEditReplaceExpanded(expanded, { focus = false } = {}) {
    const open = Boolean(expanded);
    if (!timedTextEditSearchReplaceRow || !timedTextEditSearchReplaceToggle) return;
    timedTextEditSearchReplaceRow.hidden = !open;
    timedTextEditSearchReplaceToggle.setAttribute('aria-expanded', String(open));
    timedTextEditSearchReplaceToggle.textContent = open ? '▾' : '▸';
    timedTextEditSearchReplaceToggle.title = window.MAWE_I18N?.translateText?.(open ? '隐藏替换' : '显示替换')
      || (open ? '隐藏替换' : '显示替换');
    if (focus) (open ? timedTextEditReplaceInput : timedTextEditFindInput)?.focus();
  }



  function timedTextEditRowFilterKey(row) {
    return row.changed ? row.mappingStatus : 'unchanged';
  }



  function timedTextEditDraftRowReports(report, texts) {
    const source = Array.isArray(texts) ? texts : [];
    if (!report?.structure?.valid) {
      return source.map((_, index) => report?.rows?.[index] || null);
    }
    const outputByDraftIndex = new Map(
      (report.outputRows || [])
        .filter((row) => Number.isInteger(row?.draftIndex))
        .map((row) => [row.draftIndex, row]),
    );
    // 空草稿行按顺序对应「没有输出」的来源行：既包括被清空删除的行，也包括本来就为空的行。
    // 只取 deleted 行会让已空的来源行错误消耗队列，真正清空的行反而拿不到 deleted 行
    // （报告为 null、diff 维持初始 hidden），表现为「整句删除」提示时有时无。
    const removedRows = (report.rows || []).filter((row) => {
      const outputIndexes = report.structure?.sourceOutputIndexes?.[row.index];
      return !Array.isArray(outputIndexes) || !outputIndexes.length;
    });
    let removedIndex = 0;
    return source.map((text, index) => {
      const output = outputByDraftIndex.get(index);
      if (output) return output;
      if (!String(text == null ? '' : text).trim()) return removedRows[removedIndex++] || null;
      return null;
    });
  }



  function normalizeTimedTextEditDraftLines(texts) {
    const lines = (Array.isArray(texts) ? texts : [])
      .map((text) => String(text == null ? '' : text));
    // 整体编辑末尾的换行只是输入习惯，不额外创建一条空字幕；真正清空的
    // 中间行仍保留到预览中，并在应用时按删除字幕处理。
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines.length ? lines : [''];
  }



  function syncTimedTextEditDraftFromDom() {
    if (!MaweDom.timedTextEditDraft || MaweDom.timedTextEditDraft.view !== 'single'
        || !MaweDom.timedTextEditSingleTextarea) return;
    const normalized = MaweDom.timedTextEditSingleTextarea.value.replace(/\r\n?/g, '\n');
    MaweDom.timedTextEditDraft.texts = normalizeTimedTextEditDraftLines(normalized.split('\n'));
    MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditDraft.texts.join('\n');
    MaweDom.timedTextEditDraft.singleLineError = '';
  }



  function cancelTimedTextEditReport() {
    if (MaweDom.timedTextEditReportTimer === null) return;
    clearTimeout(MaweDom.timedTextEditReportTimer);
    MaweDom.timedTextEditReportTimer = null;
  }



  function flushTimedTextEditReport() {
    cancelTimedTextEditReport();
    updateTimedTextEditReport();
  }



  function scheduleTimedTextEditReport() {
    cancelTimedTextEditReport();
    MaweDom.timedTextEditReportTimer = setTimeout(() => {
      MaweDom.timedTextEditReportTimer = null;
      updateTimedTextEditReport();
    }, MaweDom.TIMED_TEXT_EDIT_REPORT_DEBOUNCE_MS);
  }



  // 勾选「修改后移除字幕前后空格」时，报告预览与应用都使用 trim 后的文本，
  // 保证「看到的 diff」与「实际应用的结果」一致；草稿 texts 本身保持原样。
  function timedTextEditEffectiveTexts() {
    const draft = MaweDom.timedTextEditDraft;
    const texts = Array.isArray(draft?.texts) ? draft.texts : [];
    if (draft?.trimWhitespace !== true) return texts;
    return texts.map((text) => String(text == null ? '' : text).trim());
  }



  function updateTimedTextEditReport() {
    if (!MaweDom.timedTextEditDraft) return;
    const draftTexts = timedTextEditEffectiveTexts();
    // 传入上一轮报告供逐行复用：draft.report 每轮整体替换，此刻仍是上一轮结果。
    const report = window.AsrEditorUtils.buildTimedTextEditReport(
      MaweDom.timedTextEditDraft.sourceSegments,
      draftTexts,
      { rule: MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule },
      MaweDom.timedTextEditDraft.report,
    );
    MaweDom.timedTextEditDraft.report = report;
    const { stats } = report;
    if (MaweDom.timedTextEditRows.childElementCount !== MaweDom.timedTextEditDraft.texts.length) {
      renderTimedTextEditRows();
    }
    MaweDom.timedTextEditReportSummary.replaceChildren();
    appendTimedTextEditStat(
      MaweDom.timedTextEditReportSummary,
      '字幕行',
      report.structure?.valid ? `${stats.totalSegments} → ${report.previewSegments.length} 条` : `${stats.totalSegments} 条`,
    );
    appendTimedTextEditStat(
      MaweDom.timedTextEditReportSummary,
      '修改内容',
      `${stats.changedSegments} 条（未修改 ${stats.unchangedSegments} 条）`,
    );
    appendTimedTextEditStat(
      MaweDom.timedTextEditReportSummary,
      '字符变化',
      `+${stats.addedCharacters} / -${stats.removedCharacters}`,
    );

    MaweDom.timedTextEditReportMapping.replaceChildren();
    // 0 条的映射项不显示，只保留数量大于 0 的行；全部为 0 时连同分隔线一起隐藏。
    const mappingEntries = [
      ['未修改（原样保留）', 'unchanged', stats.unchangedSegments],
      ['修改后完整映射', 'full', stats.fullMappedCues],
      ['部分保留', 'partial', stats.partialMappedCues],
      ['边界移动（转移时间码）', 'boundary', stats.boundaryMappedCues],
      ['结构调整（重新分配时间码）', 'structure', stats.structureMappedCues],
      ['时间码丢失', 'lost', stats.lostMappedCues],
      ['原本没有字词码', 'unavailable', stats.unavailableMappedCues],
    ];
    if (mappingEntries.some(([, , count]) => count > 0)) {
      appendTimedTextEditDivider(MaweDom.timedTextEditReportMapping);
      mappingEntries.forEach(([label, filterKey, count]) => {
        if (count > 0) {
          appendTimedTextEditStat(MaweDom.timedTextEditReportMapping, label, `${count} 条`, filterKey, count);
        }
      });
    }
    MaweDom.timedTextEditShowAll.hidden = !MaweDom.timedTextEditDraft.filter;
    MaweDom.timedTextEditShowAll.textContent = '显示全部';

    MaweDom.timedTextEditReportHint.classList.remove('warning');
    if (report.structure && !report.structure.valid && report.structure.error) {
      MaweDom.timedTextEditReportHint.classList.add('warning');
      MaweDom.timedTextEditReportHint.textContent = report.structure.error;
    } else if (stats.estimatedTimingCues) {
      MaweDom.timedTextEditReportHint.classList.add('warning');
      MaweDom.timedTextEditReportHint.textContent = `有 ${stats.estimatedTimingCues} 条字幕缺少可复用的字词时间码，应用后将按原字幕范围/文字长度自动估算时间；不会伪造精确字词时间码。`;
    } else if (!stats.changedSegments) {
      MaweDom.timedTextEditReportHint.textContent = '修改后会保持当前字幕段的开始、结束时间不变。';
    } else if (stats.lostMappedCues) {
      MaweDom.timedTextEditReportHint.classList.add('warning');
      MaweDom.timedTextEditReportHint.textContent = '部分字幕无法可靠映射原字词时间码；应用后只保留字幕段整体时间范围。';
    } else if (stats.partialMappedCues) {
      MaweDom.timedTextEditReportHint.classList.add('warning');
      MaweDom.timedTextEditReportHint.textContent = '修改范围内的字词会合并为较粗的时间码，未受影响的字词仍会保留。';
    } else if (stats.boundaryMoves) {
      MaweDom.timedTextEditReportHint.textContent = '检测到相邻字幕之间的开头/结尾移动；对应字词时间码会一起转移，并更新字幕段范围。';
    } else if (stats.structureMappedCues) {
      MaweDom.timedTextEditReportHint.textContent = '检测到字幕行结构变化；应用后会按字词时间码拆分、合并或删除字幕行，并解除受影响的多字幕绑定。';
    } else {
      MaweDom.timedTextEditReportHint.textContent = '当前修改可以完整复用原字词时间码；字幕段整体时间范围不会改变。';
    }

    const draftRowReports = timedTextEditDraftRowReports(report, draftTexts);
    // renderTimedTextEditRows 按 index 顺序 append，行数与草稿不一致时整体重建
    // （上方守卫），children 顺序即 data-index 顺序；逐行 querySelector 是
    // O(N²)，数千行时每键卡顿的第二来源。
    const rowElements = MaweDom.timedTextEditRows.children;
    draftRowReports.forEach((rowReport, index) => {
      const rowElement = rowElements[index];
      if (!rowElement) return;
      rowElement.classList.toggle('changed', Boolean(rowReport?.changed));
      rowElement.classList.toggle('deleted', Boolean(rowReport?.deleted));
      rowElement.hidden = Boolean(MaweDom.timedTextEditDraft.filter)
        && (!rowReport || timedTextEditRowFilterKey(rowReport) !== MaweDom.timedTextEditDraft.filter);
      if (rowReport) renderTimedTextEditRowDiff(rowElement, rowReport);
    });
    MaweDom.timedTextEditDraft.texts.forEach((_text, index) => {
      const rowElement = rowElements[index];
      const coverage = rowElement?.querySelector('.timed-text-edit-coverage');
      const reuse = rowElement?.querySelector('.timed-text-edit-reuse');
      const rowReport = draftRowReports[index];
      const preview = report.structure?.valid && Number.isInteger(rowReport?.draftIndex)
        ? report.previewSegments[rowReport.index]
        : (!report.structure?.valid ? report.rows[index]?.items : null);
      const items = report.structure?.valid ? preview?.items : preview;
      const effectiveText = draftTexts[index];
      const coverageData = rowReport?.itemCoverageData
        || window.AsrEditorUtils.timedTextItemCoverage(effectiveText, items);
      const reuseData = rowReport?.itemReuseData || {
        percent: 0,
        reusedCharacters: 0,
        totalCharacters: Array.from(String(effectiveText == null ? '' : effectiveText)).length,
      };
      renderTimedTextEditMetric(
        coverage,
        coverageData.percent,
        'coverage',
        `有效字词时间码覆盖率：${coverageData.coveredCharacters}/${coverageData.totalCharacters}`,
      );
      renderTimedTextEditMetric(
        reuse,
        reuseData.percent,
        'reuse',
        `原始时间码复用率：${reuseData.reusedCharacters}/${reuseData.totalCharacters}`,
      );
    });
    renderTimedTextEditChangeList(report);
    const singleHint = report.structure?.valid ? '' : (report.structure?.error || MaweDom.timedTextEditDraft.singleLineError || '');
    MaweDom.timedTextEditSingleHint.textContent = singleHint;
    MaweDom.timedTextEditSingleHint.hidden = MaweDom.timedTextEditDraft.view !== 'single' || !singleHint;
    if (!MaweDom.timedTextEditDraft.sourceSegments.length && MaweDom.timedTextEditDraft.allSourceSegments.length) {
      MaweDom.timedTextEditReportHint.textContent = '当前没有显示中的字幕；打开“显示已禁用字幕”后才能编辑。';
    }
    MaweDom.timedTextEditApply.disabled = !report.valid;
    refreshTimedTextEditSearch({ preserveIndex: true });
  }



  function refreshTimedTextEditTrackOptions(kind = currentTimedTextEditKind()) {
    const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
    // 「已开启模式但尚未导入副轨」时没有第二条字幕可编辑，不显示轨道切换控件。
    const multiSubtitleEnabled = multi.enabled === true && Boolean((multi.tracks || []).length);
    if (MaweDom.timedTextEditTrackControl) MaweDom.timedTextEditTrackControl.hidden = !multiSubtitleEnabled;
    const extensionAvailable = multiSubtitleEnabled && Boolean(MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments?.length);
    const extensionOption = MaweDom.timedTextEditTrack.querySelector('option[value="extension"]');
    if (extensionOption) extensionOption.hidden = !extensionAvailable;
    const nextKind = kind === 'extension' && extensionAvailable ? 'extension' : 'main';
    MaweDom.timedTextEditTrack.value = nextKind;
    return nextKind;
  }



  function loadTimedTextEditTrack(kind, { showDisabled = false } = {}) {
    cancelTimedTextEditReport();
    const nextKind = refreshTimedTextEditTrackOptions(kind);
    const selection = timedTextEditSourceSelection(nextKind, showDisabled);
    const sourceSegments = selection.sourceSegments;
    const hiddenDisabledCount = selection.allSegments.length - sourceSegments.length;
    MaweDom.timedTextEditDraft = {
      kind: nextKind,
      trackId: nextKind === 'extension' ? MaweMultiSubtitleCore.getActiveExtensionTrack()?.id || null : null,
      showDisabled: Boolean(showDisabled),
      sourceSegmentIndexes: selection.sourceSegmentIndexes,
      allSourceSegments: JSON.parse(JSON.stringify(selection.allSegments || [])),
      sourceSegments: JSON.parse(JSON.stringify(sourceSegments || [])),
      texts: (sourceSegments || []).map((segment) => String(segment?.text || '')),
      view: MaweBoot.DATA.timed_text_edit_view === 'single' ? 'single' : 'rows',
      filter: null,
      trimWhitespace: false,
      singleText: (sourceSegments || []).map((segment) => String(segment?.text || '')).join('\n'),
      singleLineError: '',
      // sourceSegments 在面板会话内不变，单视图可用性只取决于它，这里算一次。
      canUseSingleView: (sourceSegments || []).every(
        (segment) => !String(segment?.text || '').includes('\n'),
      ),
      report: null,
    };
    if (MaweDom.timedTextEditShowDisabledToggle) MaweDom.timedTextEditShowDisabledToggle.checked = Boolean(showDisabled);
    if (MaweDom.timedTextEditTrimToggle) MaweDom.timedTextEditTrimToggle.checked = false;
    MaweDom.timedTextEditSourceInfo.textContent = `${timedTextEditTrackLabel(nextKind)} · ${sourceSegments.length} 条${hiddenDisabledCount ? `（已隐藏 ${hiddenDisabledCount} 条禁用字幕）` : ''}`;
    renderTimedTextEditRows();
    renderTimedTextEditView();
    updateTimedTextEditReport();
  }



  function refreshTimedTextEditButton() {
    if (!MaweDom.timedTextEditButton) return;
    const hasMain = MaweBoot.DATA.segments.length > 0;
    const hasExtension = Boolean(MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments?.length);
    MaweDom.timedTextEditButton.disabled = !hasMain && !hasExtension;
  }



  function closeTimedTextEdit() {
    cancelTimedTextEditReport();
    timedTextEditArmedMatch = null;
    MaweDom.timedTextEditModal.classList.remove('show');
    MaweDom.timedTextEditDraft = null;
    MaweDom.timedTextEditRows.replaceChildren();
    const returnFocus = MaweDom.timedTextEditReturnFocus;
    if (returnFocus?.matches('button, input, select, textarea, a')) {
      releaseClosedUiFocus(MaweDom.timedTextEditModal, returnFocus);
    } else returnFocus?.focus();
    MaweDom.timedTextEditReturnFocus = null;
  }



  function timedTextEditHasUnappliedChanges() {
    // The report is debounced; closing or switching scope can happen before it
    // catches up with input. Compare the current draft itself to its source.
    const draft = MaweDom.timedTextEditDraft;
    if (!draft) return false;
    syncTimedTextEditDraftFromDom();
    return Boolean(draft.singleLineError
      || draft.texts.length !== draft.sourceSegments.length
      || draft.sourceSegments.some((segment, index) => String(segment?.text || '') !== draft.texts[index]));
  }



  function mergeTimedTextEditSegmentsWithHidden(
    allSourceSegments,
    sourceSegmentIndexes,
    nextSegments,
    report,
  ) {
    const all = Array.isArray(allSourceSegments) ? allSourceSegments : [];
    const visibleIndexes = Array.isArray(sourceSegmentIndexes) ? sourceSegmentIndexes : [];
    const outputBySourceIndex = new Map();
    const unassigned = [];
    const structural = report?.structure?.valid === true;
    const sourceIndexById = new Map();
    visibleIndexes.forEach((sourceIndex) => {
      const id = all[sourceIndex]?.id;
      if (id) sourceIndexById.set(id, sourceIndex);
    });
    const fixedOutputSourceIndexes = structural ? [] : (report?.rows || [])
      .map((row, index) => (row?.deleted ? -1 : index))
      .filter((index) => index >= 0);
    (nextSegments || []).forEach((segment, outputIndex) => {
      const sourceIndexes = structural
        ? report.structure.outputMeta?.[outputIndex]?.sourceIndexes
        : null;
      let sourceIndex = null;
      if (segment?.id && sourceIndexById.has(segment.id)) {
        sourceIndex = sourceIndexById.get(segment.id);
      } else {
        const visibleIndex = Number.isInteger(sourceIndexes?.[0])
          ? sourceIndexes[0] : (fixedOutputSourceIndexes[outputIndex] ?? outputIndex);
        sourceIndex = visibleIndexes[visibleIndex];
      }
      if (!Number.isInteger(sourceIndex)) {
        unassigned.push(segment);
        return;
      }
      const outputs = outputBySourceIndex.get(sourceIndex) || [];
      outputs.push(segment);
      outputBySourceIndex.set(sourceIndex, outputs);
    });

    const visibleSet = new Set(visibleIndexes);
    const merged = [];
    all.forEach((segment, sourceIndex) => {
      if (!visibleSet.has(sourceIndex)) {
        merged.push(JSON.parse(JSON.stringify(segment)));
        return;
      }
      (outputBySourceIndex.get(sourceIndex) || []).forEach((output) => merged.push(output));
    });
    // 正常的结构计划每个输出都应能追溯到至少一个可见来源行；保留兜底，
    // 避免异常数据被静默丢掉，且不影响默认的可见字幕编辑路径。
    unassigned.forEach((segment) => merged.push(segment));
    return merged;
  }



  function applyTimedTextEditSegments(
    kind,
    sourceSegments,
    targetSegments,
    nextSegments,
    report,
    texts,
    sourceSegmentIndexes = null,
  ) {
    const visibleSourceIndexes = Array.isArray(sourceSegmentIndexes)
      ? sourceSegmentIndexes : (sourceSegments || []).map((_, index) => index);
    const filtered = visibleSourceIndexes.length !== targetSegments.length
      || visibleSourceIndexes.some((sourceIndex, index) => sourceIndex !== index);
    const allSourceSegments = filtered ? targetSegments : sourceSegments;
    const publishedSegments = filtered
      ? mergeTimedTextEditSegmentsWithHidden(
        allSourceSegments,
        visibleSourceIndexes,
        nextSegments,
        report,
      )
      : nextSegments;
    const nextIds = new Set((nextSegments || []).map((segment) => segment?.id).filter(Boolean));
    const removedVisibleIndexes = new Set((sourceSegments || []).map((segment, index) => {
      if (segment?.id) return nextIds.has(segment.id) ? -1 : index;
      const row = report?.rows?.[index];
      return row?.changed && !String(row.after || '') ? index : -1;
    }).filter((index) => index >= 0));
    (report?.structure?.removedSourceIndexes || []).forEach((index) => removedVisibleIndexes.add(index));
    const removedIndexes = new Set([...removedVisibleIndexes]
      .map((index) => visibleSourceIndexes[index])
      .filter((index) => Number.isInteger(index)));
    const structureChanged = Boolean(report?.structure?.valid
      && (report.structure.affectedSourceIndexes?.length || nextSegments.length !== sourceSegments.length));
    if (!removedIndexes.size && !structureChanged) {
      targetSegments.splice(0, targetSegments.length, ...publishedSegments);
      return 0;
    }

    const removedIndexList = [...removedIndexes].sort((a, b) => a - b);
    const removeSet = new Set(removedIndexList);
    const removedIds = removedIndexList.map((index) => allSourceSegments[index]?.id).filter(Boolean);
    const affectedIndexes = new Set((report?.structure?.affectedSourceIndexes || [])
      .map((index) => visibleSourceIndexes[index])
      .filter((index) => Number.isInteger(index)));
    removedIndexList.forEach((index) => affectedIndexes.add(index));
    const affectedIds = [...affectedIndexes].map((index) => allSourceSegments[index]?.id).filter(Boolean);
    const pairedExtensionIndices = new Set();
    let extensionTrack = null;
    let bindingsChanged = false;

    if (kind === 'extension') {
      const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
      const beforeBindingCount = (multi.bindings || []).length;
      MaweMultiSubtitleCore.removeBindingsForSegmentIds([], affectedIds);
      bindingsChanged = (multi.bindings || []).length !== beforeBindingCount;
    } else {
      const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
      extensionTrack = MaweMultiSubtitleCore.multiSubtitleVisible() && removedIds.length ? MaweMultiSubtitleCore.getActiveExtensionTrack() : null;
      if (extensionTrack) {
        (multi.bindings || []).forEach((binding) => {
          if (!binding.main_segment_ids?.some((id) => removedIds.includes(id))) return;
          (binding.extension_segment_ids || []).forEach((id) => {
            const index = extensionTrack.segments.findIndex((segment) => segment?.id === id);
            if (index >= 0) pairedExtensionIndices.add(index);
          });
        });
      }
      const beforeBindingCount = (multi.bindings || []).length;
      MaweMultiSubtitleCore.removeBindingsForSegmentIds(
        affectedIds,
        extensionTrack
          ? [...pairedExtensionIndices].map((index) => extensionTrack.segments[index]?.id)
          : [],
      );
      bindingsChanged = (multi.bindings || []).length !== beforeBindingCount;

      if (removedIndexList.length) {
        // 与删除字幕相同的分组语义：来源行离开后，颜色 / 表情包组在切点处拆开。
        splitGroupsAtCutPoints(removeSet, 'sticker', 'sticker_ref');
        splitGroupsAtCutPoints(removeSet, 'color', 'color_ref');
        MaweBoot.DATA.segments.forEach((segment, index) => {
          if (removeSet.has(index)) return;
          if (segment.sticker_ref && removeSet.has(segment.sticker_ref.headIdx)) {
            segment.sticker_ref = null;
          }
          if (segment.color_ref && removeSet.has(segment.color_ref.headIdx)) {
            segment.color_ref = null;
          }
        });
      }
    }

    // 结构发生变化后，旧下标选中态和字幕编辑面板都必须失效，避免渲染后指向相邻字幕。
    clearSelection({ silent: true });
    MaweCuePanelState.currentCuePanelKind = 'main';
    MaweCuePanelState.currentCuePanelIdx = -1;
    MaweCuePanelState.currentCuePanelTrackId = null;
    MaweSelection.lastClickedIdx = -1;
    MaweSelection.lastClickedExtensionIdx = -1;
    MawePlaybackLoop.lastActive = -1;
    targetSegments.splice(0, targetSegments.length, ...publishedSegments);

    if (kind !== 'extension') {
      const shiftHeadIdx = (ref) => {
        let shift = 0;
        for (const removedIndex of removedIndexList) {
          if (removedIndex < ref.headIdx) shift += 1;
          else break;
        }
        if (shift) ref.headIdx -= shift;
      };
      MaweBoot.DATA.segments.forEach((segment) => {
        if (segment.sticker_ref) shiftHeadIdx(segment.sticker_ref);
        if (segment.color_ref) shiftHeadIdx(segment.color_ref);
      });
      window.AsrEditorUtils.repairGroupReferenceIndices(MaweBoot.DATA.segments);
      if (extensionTrack && pairedExtensionIndices.size) {
        [...pairedExtensionIndices].sort((a, b) => b - a)
          .forEach((index) => extensionTrack.segments.splice(index, 1));
      }
    }
    if (bindingsChanged || pairedExtensionIndices.size) MaweMultiSubtitleCore.markMultiSubtitleDirty();
    return removedIndexes.length;
  }



  function requestCloseTimedTextEdit() {
    if (timedTextEditHasUnappliedChanges()
        && !window.confirm('当前有未应用的文本修改，确定关闭编辑窗口吗？')) return false;
    closeTimedTextEdit();
    return true;
  }



  // 打开编辑窗口时定位选中字幕对应的草稿行（多选取序号最小的一条）。
  // 选中项不在当前显示范围（如已禁用被隐藏）时维持原状。
  function timedTextEditInitialScrollRowIndex() {
    const draft = MaweDom.timedTextEditDraft;
    if (!draft) return -1;
    const selected = draft.kind === 'extension'
      ? MaweSelection.selectedExtensionIdxs : MaweSelection.selectedIdxs;
    let target = -1;
    (selected || []).forEach((index) => {
      if (Number.isInteger(index) && index >= 0 && (target < 0 || index < target)) target = index;
    });
    if (target < 0) return -1;
    return (draft.sourceSegmentIndexes || []).indexOf(target);
  }



  function openTimedTextEdit() {
    if (!MaweBoot.DATA.segments.length && !MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments?.length) {
      MaweHint.flashHint('当前没有可编辑的字幕', 'invalid');
      return;
    }
    if (MaweInlineEdit.editingState) finishEdit(true);
    MaweDom.timedTextEditReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    timedTextEditFindInput.value = '';
    timedTextEditReplaceInput.value = '';
    timedTextEditSearchCase?.setAttribute('aria-pressed', 'false');
    timedTextEditSearchRegex?.setAttribute('aria-pressed', 'false');
    timedTextEditSearchIndex = -1;
    setTimedTextEditReplaceExpanded(false);
    loadTimedTextEditTrack(currentTimedTextEditKind());
    MaweDom.timedTextEditModal.classList.add('show');
    const scrollRowIndex = timedTextEditInitialScrollRowIndex();
    setTimeout(() => {
      // 整体视图没有行元素可滚（Greptile P2：此前无条件查 rows 容器，single
      // 视图下为空导致选中字幕留在屏外）：把 caret 预置到选中行首再聚焦，
      // 浏览器随焦点滚动到该行；逐条视图维持 scrollIntoView 原路径。
      const singleView = MaweDom.timedTextEditDraft?.view === 'single';
      if (singleView && MaweDom.timedTextEditSingleTextarea) {
        const textarea = MaweDom.timedTextEditSingleTextarea;
        const texts = MaweDom.timedTextEditDraft?.texts || [];
        if (scrollRowIndex >= 0 && scrollRowIndex < texts.length) {
          const offset = texts.slice(0, scrollRowIndex)
            .reduce((sum, text) => sum + String(text || '').length + 1, 0);
          textarea.setSelectionRange(offset, offset);
        }
        textarea.focus();
        return;
      }
      MaweDom.timedTextEditRows.querySelector('textarea')?.focus();
      // 行已在 loadTimedTextEditTrack 内同步渲染完成，这里只需滚动定位。
      if (scrollRowIndex >= 0) {
        MaweDom.timedTextEditRows.querySelector(`.timed-text-edit-row[data-index="${scrollRowIndex}"]`)
          ?.scrollIntoView({ block: 'center' });
      }
    }, 50);
  }


  function onTimedTextEditSearchKeydown(event) {
    if (!MaweDom.timedTextEditModal?.classList.contains('show')) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = String(event.key || '').toLowerCase();
    if (modifier && !event.altKey && key === 'f') {
      event.preventDefault();
      event.stopImmediatePropagation();
      timedTextEditFindInput?.focus();
      timedTextEditFindInput?.select();
      return;
    }
    if (modifier && !event.altKey && key === 'h') {
      event.preventDefault();
      event.stopImmediatePropagation();
      setTimedTextEditReplaceExpanded(true, { focus: true });
      timedTextEditReplaceInput?.select();
      return;
    }
    // F3 / Shift+F3：焦点在任意位置（含字幕 textarea）都可以继续跳命中。
    if (event.key === 'F3') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) moveTimedTextEditSearchMatch(event.shiftKey ? -1 : 1);
      return;
    }
    // 焦点在命中所在 textarea 且选区仍精确等于当前命中时，Enter 继续
    // 跳下一个/上一个命中；选区一变（点击/方向键/输入）就失效，Enter
    // 恢复为普通换行，不影响定位到命中后直接拆句的编辑流。
    if (event.key === 'Enter' && timedTextEditArmedMatch && !event.isComposing && event.keyCode !== 229
        && event.target === timedTextEditArmedMatch.textarea
        && event.target.selectionStart === timedTextEditArmedMatch.start
        && event.target.selectionEnd === timedTextEditArmedMatch.end) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) moveTimedTextEditSearchMatch(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.target !== timedTextEditFindInput || event.key !== 'Enter'
        || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    moveTimedTextEditSearchMatch(event.shiftKey ? -1 : 1);
  }


  timedTextEditFindInput?.addEventListener('input', () => {
    const result = refreshTimedTextEditSearch({ resetIndex: true });
    if (result.matches.length) revealTimedTextEditSearchMatch(result.matches[0], result.matches);
  });
  [timedTextEditSearchCase, timedTextEditSearchRegex].forEach((button) => {
    button?.addEventListener('click', () => {
      button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
      const result = refreshTimedTextEditSearch({ resetIndex: true });
      if (result.matches.length) revealTimedTextEditSearchMatch(result.matches[0], result.matches);
    });
  });
  timedTextEditSearchReplaceToggle?.addEventListener('click', () => {
    setTimedTextEditReplaceExpanded(timedTextEditSearchReplaceRow?.hidden);
  });
  timedTextEditSearchPrevious?.addEventListener('click', () => moveTimedTextEditSearchMatch(-1));
  timedTextEditSearchNext?.addEventListener('click', () => moveTimedTextEditSearchMatch(1));
  timedTextEditSearchReplaceOne?.addEventListener('click', () => applyTimedTextEditSearchReplacement(false));
  timedTextEditSearchReplaceAll?.addEventListener('click', () => applyTimedTextEditSearchReplacement(true));
  MaweDom.timedTextEditSingleTextarea?.addEventListener('scroll', () => {
    if (timedTextEditGutter) timedTextEditGutter.scrollTop = MaweDom.timedTextEditSingleTextarea.scrollTop;
    if (!timedTextEditSearchMirror) return;
    timedTextEditSearchMirror.scrollTop = MaweDom.timedTextEditSingleTextarea.scrollTop;
    timedTextEditSearchMirror.scrollLeft = MaweDom.timedTextEditSingleTextarea.scrollLeft;
  });
  // 输入过程中的增删行要立刻反映到行号列；行数不变时 updateTimedTextEditGutter
  // 直接跳过，逐键成本可以忽略。
  MaweDom.timedTextEditSingleTextarea?.addEventListener('input', updateTimedTextEditGutter);
  // 逐条行 textarea 滚动时同步各自的高亮镜像（捕获阶段委托，行可随时增删）。
  MaweDom.timedTextEditRows?.addEventListener('scroll', (event) => {
    const textarea = event.target;
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    const mirror = textarea.parentElement?.querySelector(':scope > .timed-text-edit-row-search-mirror');
    if (!mirror) return;
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
  }, true);
  document.addEventListener('keydown', onTimedTextEditSearchKeydown, true);
  // 输入即解除武装（Greptile P2）：武装状态不能只靠选区比对被动失效，
  // 否则打字后又撤销回原位置，选区恰好回到命中坐标，Enter 会复活成跳转。
  const disarmTimedTextEditArmedMatch = (event) => {
    if (event.target instanceof HTMLTextAreaElement) timedTextEditArmedMatch = null;
  };
  MaweDom.timedTextEditRows?.addEventListener('input', disarmTimedTextEditArmedMatch, true);
  MaweDom.timedTextEditSingleTextarea?.addEventListener('input', disarmTimedTextEditArmedMatch);
  // 记录用户对「查看修改内容」的手动开合：click 只由用户触发，
  // 程序里的 details.open = ... 赋值不会经过这里。
  MaweDom.timedTextEditChangeDetails?.querySelector('summary')?.addEventListener('click', () => {
    if (MaweDom.timedTextEditDraft) MaweDom.timedTextEditDraft.changeListTouched = true;
  });
  document.addEventListener('mawe:languagechange', () => {
    if (timedTextEditSearchReplaceToggle) {
      const open = timedTextEditSearchReplaceToggle.getAttribute('aria-expanded') === 'true';
      timedTextEditSearchReplaceToggle.title = window.MAWE_I18N?.translateText?.(open ? '隐藏替换' : '显示替换')
        || (open ? '隐藏替换' : '显示替换');
    }
  });

  global.MaweTimedTextEdit = Object.freeze({
    timedTextEditSegments,
    timedTextEditSourceSelection,
    currentTimedTextEditKind,
    timedTextEditTrackLabel,
    appendTimedTextEditStat,
    appendTimedTextEditDivider,
    appendTimedTextEditDiffLine,
    appendTimedTextEditTimingChange,
    renderTimedTextEditRowDiff,
    timedTextEditMappingLabel,
    timedTextEditCoverageClass,
    renderTimedTextEditMetric,
    renderTimedTextEditChangeList,
    renderTimedTextEditRows,
    timedTextEditCanUseSingleView,
    renderTimedTextEditView,
    refreshTimedTextEditSearch,
    moveTimedTextEditSearchMatch,
    applyTimedTextEditSearchReplacement,
    revealTimedTextEditSearchMatch,
    timedTextEditRowFilterKey,
    timedTextEditDraftRowReports,
    normalizeTimedTextEditDraftLines,
    syncTimedTextEditDraftFromDom,
    timedTextEditEffectiveTexts,
    cancelTimedTextEditReport,
    flushTimedTextEditReport,
    scheduleTimedTextEditReport,
    updateTimedTextEditReport,
    refreshTimedTextEditTrackOptions,
    loadTimedTextEditTrack,
    refreshTimedTextEditButton,
    closeTimedTextEdit,
    timedTextEditHasUnappliedChanges,
    mergeTimedTextEditSegmentsWithHidden,
    applyTimedTextEditSegments,
    requestCloseTimedTextEdit,
    openTimedTextEdit
  });
})(typeof window !== 'undefined' ? window : globalThis);
}

export function timedTextEditSegments(...args) { return window.MaweTimedTextEdit.timedTextEditSegments(...args); }
export function timedTextEditSourceSelection(...args) { return window.MaweTimedTextEdit.timedTextEditSourceSelection(...args); }
export function currentTimedTextEditKind(...args) { return window.MaweTimedTextEdit.currentTimedTextEditKind(...args); }
export function timedTextEditTrackLabel(...args) { return window.MaweTimedTextEdit.timedTextEditTrackLabel(...args); }
export function appendTimedTextEditStat(...args) { return window.MaweTimedTextEdit.appendTimedTextEditStat(...args); }
export function appendTimedTextEditDivider(...args) { return window.MaweTimedTextEdit.appendTimedTextEditDivider(...args); }
export function appendTimedTextEditDiffLine(...args) { return window.MaweTimedTextEdit.appendTimedTextEditDiffLine(...args); }
export function appendTimedTextEditTimingChange(...args) { return window.MaweTimedTextEdit.appendTimedTextEditTimingChange(...args); }
export function renderTimedTextEditRowDiff(...args) { return window.MaweTimedTextEdit.renderTimedTextEditRowDiff(...args); }
export function timedTextEditMappingLabel(...args) { return window.MaweTimedTextEdit.timedTextEditMappingLabel(...args); }
export function timedTextEditCoverageClass(...args) { return window.MaweTimedTextEdit.timedTextEditCoverageClass(...args); }
export function renderTimedTextEditMetric(...args) { return window.MaweTimedTextEdit.renderTimedTextEditMetric(...args); }
export function renderTimedTextEditChangeList(...args) { return window.MaweTimedTextEdit.renderTimedTextEditChangeList(...args); }
export function renderTimedTextEditRows(...args) { return window.MaweTimedTextEdit.renderTimedTextEditRows(...args); }
export function timedTextEditCanUseSingleView(...args) { return window.MaweTimedTextEdit.timedTextEditCanUseSingleView(...args); }
export function renderTimedTextEditView(...args) { return window.MaweTimedTextEdit.renderTimedTextEditView(...args); }
export function refreshTimedTextEditSearch(...args) { return window.MaweTimedTextEdit.refreshTimedTextEditSearch(...args); }
export function moveTimedTextEditSearchMatch(...args) { return window.MaweTimedTextEdit.moveTimedTextEditSearchMatch(...args); }
export function applyTimedTextEditSearchReplacement(...args) { return window.MaweTimedTextEdit.applyTimedTextEditSearchReplacement(...args); }
export function revealTimedTextEditSearchMatch(...args) { return window.MaweTimedTextEdit.revealTimedTextEditSearchMatch(...args); }
export function timedTextEditRowFilterKey(...args) { return window.MaweTimedTextEdit.timedTextEditRowFilterKey(...args); }
export function timedTextEditDraftRowReports(...args) { return window.MaweTimedTextEdit.timedTextEditDraftRowReports(...args); }
export function normalizeTimedTextEditDraftLines(...args) { return window.MaweTimedTextEdit.normalizeTimedTextEditDraftLines(...args); }
export function syncTimedTextEditDraftFromDom(...args) { return window.MaweTimedTextEdit.syncTimedTextEditDraftFromDom(...args); }
export function timedTextEditEffectiveTexts(...args) { return window.MaweTimedTextEdit.timedTextEditEffectiveTexts(...args); }
export function cancelTimedTextEditReport(...args) { return window.MaweTimedTextEdit.cancelTimedTextEditReport(...args); }
export function flushTimedTextEditReport(...args) { return window.MaweTimedTextEdit.flushTimedTextEditReport(...args); }
export function scheduleTimedTextEditReport(...args) { return window.MaweTimedTextEdit.scheduleTimedTextEditReport(...args); }
export function updateTimedTextEditReport(...args) { return window.MaweTimedTextEdit.updateTimedTextEditReport(...args); }
export function refreshTimedTextEditTrackOptions(...args) { return window.MaweTimedTextEdit.refreshTimedTextEditTrackOptions(...args); }
export function loadTimedTextEditTrack(...args) { return window.MaweTimedTextEdit.loadTimedTextEditTrack(...args); }
export function refreshTimedTextEditButton(...args) { return window.MaweTimedTextEdit.refreshTimedTextEditButton(...args); }
export function closeTimedTextEdit(...args) { return window.MaweTimedTextEdit.closeTimedTextEdit(...args); }
export function timedTextEditHasUnappliedChanges(...args) { return window.MaweTimedTextEdit.timedTextEditHasUnappliedChanges(...args); }
export function mergeTimedTextEditSegmentsWithHidden(...args) { return window.MaweTimedTextEdit.mergeTimedTextEditSegmentsWithHidden(...args); }
export function applyTimedTextEditSegments(...args) { return window.MaweTimedTextEdit.applyTimedTextEditSegments(...args); }
export function requestCloseTimedTextEdit(...args) { return window.MaweTimedTextEdit.requestCloseTimedTextEdit(...args); }
export function openTimedTextEdit(...args) { return window.MaweTimedTextEdit.openTimedTextEdit(...args); }
