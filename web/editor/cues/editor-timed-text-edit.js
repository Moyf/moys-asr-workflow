// 整轨定时编辑：逐行 diff 呈现、时间映射与覆盖统计。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweTimedTextEdit 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweTimedTextEdit(global) {
  'use strict';



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



  function renderTimedTextEditRowDiff(rowElement, reportRow) {
    const diffElement = rowElement.querySelector('.timed-text-edit-row-diff');
    if (!diffElement) return;
    diffElement.replaceChildren();
    diffElement.hidden = !reportRow.changed && !reportRow.timingChanged && !reportRow.timingEstimated;
    if (reportRow.changed) {
      appendTimedTextEditDiffLine(diffElement, '修改前：', reportRow.diff.before, 'before');
      appendTimedTextEditDiffLine(diffElement, '修改后：', reportRow.diff.after, 'after');
    }
    if (reportRow.timingChanged) {
      const timing = document.createElement('div');
      timing.className = 'timed-text-edit-timing-change';
      timing.textContent = `时间范围：${MaweCueElements.fmtSrtTime(reportRow.beforeStart)} – ${MaweCueElements.fmtSrtTime(reportRow.beforeEnd)} → ${MaweCueElements.fmtSrtTime(reportRow.afterStart)} – ${MaweCueElements.fmtSrtTime(reportRow.afterEnd)}`;
      diffElement.appendChild(timing);
    }
    if (reportRow.timingEstimated) {
      const estimated = document.createElement('div');
      estimated.className = 'timed-text-edit-estimated-timing';
      estimated.textContent = '时间范围为自动估算（按原字幕范围/文字长度分配）';
      diffElement.appendChild(estimated);
    }
    if (reportRow.deleted) {
      const deleted = document.createElement('div');
      deleted.className = 'timed-text-edit-deleted-label';
      deleted.textContent = '整句删除（时间码已转移到其他字幕）';
      diffElement.appendChild(deleted);
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
      if (row.timingChanged) {
        const timing = document.createElement('div');
        timing.className = 'timed-text-edit-timing-change';
        timing.textContent = `时间范围：${MaweCueElements.fmtSrtTime(row.beforeStart)} – ${MaweCueElements.fmtSrtTime(row.beforeEnd)} → ${MaweCueElements.fmtSrtTime(row.afterStart)} – ${MaweCueElements.fmtSrtTime(row.afterEnd)}`;
        item.appendChild(timing);
      }
      if (row.timingEstimated) {
        const estimated = document.createElement('div');
        estimated.className = 'timed-text-edit-estimated-timing';
        estimated.textContent = '时间范围为自动估算（按原字幕范围/文字长度分配）';
        item.appendChild(estimated);
      }
      if (row.deleted) {
        const deleted = document.createElement('div');
        deleted.className = 'timed-text-edit-deleted-label';
        deleted.textContent = '整句删除（时间码已转移到其他字幕）';
        item.appendChild(deleted);
      }
      MaweDom.timedTextEditChangeList.appendChild(item);
    });
    MaweDom.timedTextEditChangeDetails.open = wasOpen;
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
        ? `${MaweCueElements.fmtSrtTime(segment.start)}\n${MaweCueElements.fmtSrtTime(segment.end)}` : '—\n—';
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
      main.append(textarea, diff);
      row.append(meta, main);
      MaweDom.timedTextEditRows.appendChild(row);
    });
  }



  function timedTextEditCanUseSingleView() {
    return Boolean(MaweDom.timedTextEditDraft?.sourceSegments.every((segment, index) => {
      return !String(segment?.text || '').includes('\n');
    }));
  }



  function renderTimedTextEditView() {
    if (!MaweDom.timedTextEditDraft) return;
    const canUseSingle = timedTextEditCanUseSingleView();
    const singleOption = MaweDom.timedTextEditView?.querySelector('[data-view="single"]');
    if (singleOption) singleOption.disabled = !canUseSingle;
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
      MaweCueElements.syncCharCountThresholdInputs();
      MaweDom.timedTextEditSingleTextarea.value = MaweDom.timedTextEditDraft.singleText;
      MaweCueElements.updateTimedTextEditSingleGuide();
    }
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
    const deletedRows = (report.rows || []).filter((row) => row?.deleted);
    let deletedIndex = 0;
    return source.map((text, index) => {
      const output = outputByDraftIndex.get(index);
      if (output) return output;
      if (!String(text == null ? '' : text).trim()) return deletedRows[deletedIndex++] || null;
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



  function updateTimedTextEditReport() {
    if (!MaweDom.timedTextEditDraft) return;
    const report = window.AsrEditorUtils.buildTimedTextEditReport(
      MaweDom.timedTextEditDraft.sourceSegments,
      MaweDom.timedTextEditDraft.texts,
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
    appendTimedTextEditDivider(MaweDom.timedTextEditReportMapping);
    appendTimedTextEditStat(MaweDom.timedTextEditReportMapping, '未修改（原样保留）', `${stats.unchangedSegments} 条`, 'unchanged', stats.unchangedSegments);
    appendTimedTextEditStat(MaweDom.timedTextEditReportMapping, '修改后完整映射', `${stats.fullMappedCues} 条`, 'full', stats.fullMappedCues);
    appendTimedTextEditStat(MaweDom.timedTextEditReportMapping, '部分保留', `${stats.partialMappedCues} 条`, 'partial', stats.partialMappedCues);
    appendTimedTextEditStat(MaweDom.timedTextEditReportMapping, '边界移动（转移时间码）', `${stats.boundaryMappedCues} 条`, 'boundary', stats.boundaryMappedCues);
    if (stats.structureMappedCues > 0) {
      appendTimedTextEditStat(
        MaweDom.timedTextEditReportMapping,
        '结构调整（重新分配时间码）',
        `${stats.structureMappedCues} 条`,
        'structure',
        stats.structureMappedCues,
      );
    }
    appendTimedTextEditStat(MaweDom.timedTextEditReportMapping, '时间码丢失', `${stats.lostMappedCues} 条`, 'lost', stats.lostMappedCues);
    appendTimedTextEditStat(MaweDom.timedTextEditReportMapping, '原本没有字词码', `${stats.unavailableMappedCues} 条`, 'unavailable', stats.unavailableMappedCues);
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

    const draftRowReports = timedTextEditDraftRowReports(report, MaweDom.timedTextEditDraft.texts);
    draftRowReports.forEach((rowReport, index) => {
      const rowElement = MaweDom.timedTextEditRows.querySelector(`.timed-text-edit-row[data-index="${index}"]`);
      if (!rowElement) return;
      rowElement.classList.toggle('changed', Boolean(rowReport?.changed));
      rowElement.classList.toggle('deleted', Boolean(rowReport?.deleted));
      rowElement.hidden = Boolean(MaweDom.timedTextEditDraft.filter)
        && (!rowReport || timedTextEditRowFilterKey(rowReport) !== MaweDom.timedTextEditDraft.filter);
      if (rowReport) renderTimedTextEditRowDiff(rowElement, rowReport);
    });
    MaweDom.timedTextEditDraft.texts.forEach((text, index) => {
      const rowElement = MaweDom.timedTextEditRows.querySelector(`.timed-text-edit-row[data-index="${index}"]`);
      const coverage = rowElement?.querySelector('.timed-text-edit-coverage');
      const reuse = rowElement?.querySelector('.timed-text-edit-reuse');
      const rowReport = draftRowReports[index];
      const preview = report.structure?.valid && Number.isInteger(rowReport?.draftIndex)
        ? report.previewSegments[rowReport.index]
        : (!report.structure?.valid ? report.rows[index]?.items : null);
      const items = report.structure?.valid ? preview?.items : preview;
      const coverageData = rowReport?.itemCoverageData
        || window.AsrEditorUtils.timedTextItemCoverage(text, items);
      const reuseData = rowReport?.itemReuseData || {
        percent: 0,
        reusedCharacters: 0,
        totalCharacters: Array.from(String(text == null ? '' : text)).length,
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
      view: 'rows',
      filter: null,
      singleText: (sourceSegments || []).map((segment) => String(segment?.text || '')).join('\n'),
      singleLineError: '',
      report: null,
    };
    if (MaweDom.timedTextEditShowDisabledToggle) MaweDom.timedTextEditShowDisabledToggle.checked = Boolean(showDisabled);
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
    MaweDom.timedTextEditModal.classList.remove('show');
    MaweDom.timedTextEditDraft = null;
    MaweDom.timedTextEditRows.replaceChildren();
    MaweDom.timedTextEditReturnFocus?.focus();
    MaweDom.timedTextEditReturnFocus = null;
  }



  function timedTextEditHasUnappliedChanges() {
    return Boolean(MaweDom.timedTextEditDraft?.report?.stats.changedSegments || MaweDom.timedTextEditDraft?.singleLineError);
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
        MaweSegmentOps.splitGroupsAtCutPoints(removeSet, 'sticker', 'sticker_ref');
        MaweSegmentOps.splitGroupsAtCutPoints(removeSet, 'color', 'color_ref');
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
    MaweSelection.clearSelection({ silent: true });
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



  function openTimedTextEdit() {
    if (!MaweBoot.DATA.segments.length && !MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments?.length) {
      MaweHint.flashHint('当前没有可编辑的字幕', 'invalid');
      return;
    }
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
    MaweDom.timedTextEditReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    loadTimedTextEditTrack(currentTimedTextEditKind());
    MaweDom.timedTextEditModal.classList.add('show');
    setTimeout(() => (MaweDom.timedTextEditDraft?.view === 'single'
      ? MaweDom.timedTextEditSingleTextarea : MaweDom.timedTextEditRows.querySelector('textarea'))?.focus(), 50);
  }

  global.MaweTimedTextEdit = Object.freeze({
    timedTextEditSegments,
    timedTextEditSourceSelection,
    currentTimedTextEditKind,
    timedTextEditTrackLabel,
    appendTimedTextEditStat,
    appendTimedTextEditDivider,
    appendTimedTextEditDiffLine,
    renderTimedTextEditRowDiff,
    timedTextEditMappingLabel,
    timedTextEditCoverageClass,
    renderTimedTextEditMetric,
    renderTimedTextEditChangeList,
    renderTimedTextEditRows,
    timedTextEditCanUseSingleView,
    renderTimedTextEditView,
    timedTextEditRowFilterKey,
    timedTextEditDraftRowReports,
    normalizeTimedTextEditDraftLines,
    syncTimedTextEditDraftFromDom,
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
