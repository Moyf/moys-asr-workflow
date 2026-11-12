// AI suggestions remain drafts until the user explicitly applies selected rows.
(function initMaweAiPreview(global) {
  'use strict';

  let pending = null;
  const element = (id) => document.getElementById(`ai-preview-${id}`);
  const text = (zh, en) => global.MAWE_I18N?.language === 'en' ? en : zh;
  const translate = (value) => global.MAWE_I18N?.translateText?.(String(value)) || String(value);
  const snapshot = (rows) => rows.map((row) => ({ ...row }));

  function normalizeRows(rows) {
    if (!Array.isArray(rows)) throw new TypeError('AI preview rows must be an array');
    const ids = new Set();
    return rows.map((row) => {
      if (!row || !['string', 'number'].includes(typeof row.id) || ids.has(row.id)) {
        throw new TypeError('AI preview rows need unique IDs');
      }
      ids.add(row.id);
      return {
        ...row,
        source: String(row.source ?? ''),
        before: String(row.before ?? ''),
        after: String(row.after ?? ''),
        checked: !row.conflict && row.checked !== false,
      };
    });
  }

  function hasPending() { return Boolean(pending?.rows.length); }
  function token() { return pending?.identity ?? null; }

  // The entry is a sibling of the task progress box. Task hide timers cannot
  // remove it, and announcing ready results never changes the current focus.
  function syncEntry() {
    const entry = element('entry');
    if (!entry) return;
    entry.hidden = !hasPending();
    if (!pending) return;
    element('ready').textContent = text(
      `${translate(pending.label)} · ${pending.rows.length} 条建议待检查`,
      `${translate(pending.label)} · ${pending.rows.length} suggestions ready`,
    );
    element('open').textContent = text('查看建议', 'Review suggestions');
  }

  function setStatus(message) { element('status').textContent = message || ''; }

  function rowHasChange(row) {
    // Stale/invalid results stay visible even when their text matches. A result
    // whose only issue is "no changes" belongs in the full view.
    return row.before !== row.after || Boolean(row.conflict && row.reason !== '没有变化');
  }

  function rowTitle(row, fallbackIndex) {
    const number = Number.isInteger(row.index) ? row.index + 1 : fallbackIndex + 1;
    const title = text(`第 ${number} 条`, `Cue ${number}`);
    if (!Number.isFinite(row.start) || !Number.isFinite(row.end)) return title;
    const format = (ms) => global.MaweCueElements?.fmtSrtTime?.(ms) || `${Math.round(ms)} ms`;
    return `${title} · ${format(row.start)} → ${format(row.end)}`;
  }

  function syncSelection() {
    if (!pending) return;
    const applicable = pending.rows.filter((row) => !row.conflict);
    const count = applicable.filter((row) => row.checked).length;
    const conflicts = pending.rows.length - applicable.length;
    const selectAll = element('select-all');
    selectAll.checked = applicable.length > 0 && count === applicable.length;
    selectAll.indeterminate = count > 0 && count < applicable.length;
    selectAll.disabled = pending.busy || !applicable.length;
    element('apply').disabled = pending.busy || !count;
    element('discard').disabled = pending.busy;
    element('apply').textContent = pending.busy
      ? text('正在应用…', 'Applying…')
      : text(`应用勾选 ${count} 条`, `Apply ${count} selected`);
    element('summary').textContent = text(
      `${count} / ${pending.rows.length} 条已勾选${conflicts ? ` · ${conflicts} 条不可应用` : ''}`,
      `${count} / ${pending.rows.length} selected${conflicts ? ` · ${conflicts} unavailable` : ''}`,
    );
    const filter = element('filter');
    filter.hidden = !pending.multiple;
    filter.textContent = pending.changedOnly ? text('查看全部', 'View all') : text('只看有变化', 'Changes only');
    filter.setAttribute('aria-pressed', String(pending.changedOnly));
  }

  function contentNode(tag, value, className = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.setAttribute('data-ai-preview-content', '');
    node.textContent = value;
    return node;
  }

  function appendField(container, label, value, parts) {
    const heading = document.createElement('span');
    heading.className = 'ai-preview-field-label';
    heading.textContent = label;
    container.appendChild(heading);
    const line = contentNode('div', parts ? '' : value, 'ai-preview-content');
    if (parts) {
      line.classList.add('timed-text-edit-diff-line', 'before');
      for (const part of parts) {
        line.appendChild(contentNode('span', part.text, `timed-text-edit-diff-part ${part.kind}`));
      }
    }
    container.appendChild(line);
  }

  function renderRows() {
    const container = element('rows');
    container.replaceChildren();
    if (!pending) return;
    const current = pending;
    pending.rows.forEach((row, index) => {
      if (pending.multiple && pending.changedOnly && !rowHasChange(row)) return;
      const card = document.createElement(pending.multiple ? 'details' : 'section');
      card.className = `ai-preview-row${row.conflict ? ' is-conflict' : ''}`;
      if (pending.multiple) {
        card.open = pending.expanded.has(row.id);
        card.addEventListener('toggle', () => {
          if (pending !== current || !card.isConnected) return;
          if (card.open) current.expanded.add(row.id);
          else current.expanded.delete(row.id);
        });
      }
      const header = document.createElement(pending.multiple ? 'summary' : 'div');
      header.className = 'ai-preview-row-header';
      const label = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = row.checked;
      check.disabled = Boolean(row.conflict || pending.busy);
      check.addEventListener('change', () => { row.checked = check.checked; syncSelection(); });
      label.append(check, document.createTextNode(` ${rowTitle(row, index)}`));
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'ai-preview-copy';
      copy.textContent = text('复制建议', 'Copy suggestion');
      const snippet = contentNode('span', '', 'ai-preview-row-snippet');
      const rowState = document.createElement('span');
      rowState.className = 'ai-preview-row-state';
      header.append(label);
      if (pending.multiple) header.append(snippet, rowState);
      header.append(copy);
      card.appendChild(header);
      const body = document.createElement('div');
      body.className = 'ai-preview-row-body';
      card.appendChild(body);

      if (row.translation || (row.source && row.source !== row.before)) {
        appendField(body, text('原文参考', 'Source reference'), row.source);
      }
      // Character changes aid correction review. Translation is shown as two
      // complete texts, because cross-language character diffs obscure meaning.
      const diff = !row.translation && row.before.length + row.after.length <= 4000
        ? global.AsrEditorUtils?.buildTimedTextDiff?.(row.before, row.after) : null;
      const beforeLine = document.createElement('div');
      appendField(beforeLine, row.translation ? text('已有译文', 'Existing translation') : text('原文', 'Original'), row.before, diff?.before);
      body.appendChild(beforeLine);

      const candidateLabel = document.createElement('label');
      candidateLabel.className = 'ai-preview-field-label';
      candidateLabel.textContent = row.translation ? text('建议（可编辑）', 'Suggestion (editable)') : text('建议', 'Suggestion');
      const editor = document.createElement('textarea');
      editor.id = `ai-preview-candidate-${index}`;
      editor.className = 'ai-preview-candidate';
      editor.value = row.after;
      editor.readOnly = !row.translation;
      editor.rows = Math.min(6, Math.max(2, row.after.split('\n').length));
      editor.disabled = Boolean(pending.busy);
      editor.setAttribute('data-ai-preview-content', '');
      candidateLabel.htmlFor = editor.id;
      editor.setAttribute('aria-label', row.translation
        ? text(`第 ${index + 1} 条建议（可编辑）`, `Cue ${index + 1} suggestion (editable)`)
        : text(`第 ${index + 1} 条建议`, `Cue ${index + 1} suggestion`));
      const feedback = document.createElement('div');
      const syncRowFeedback = () => {
        card.classList.toggle('is-conflict', Boolean(row.conflict));
        check.checked = row.checked;
        check.disabled = Boolean(row.conflict || pending?.busy);
        snippet.textContent = row.before && row.before !== row.after ? `${row.before} → ${row.after}` : row.after;
        rowState.textContent = row.conflict ? translate(row.reason || text('不可应用', 'Unavailable')) : '';
        feedback.replaceChildren();
        if (row.reason) feedback.appendChild(contentNode('p', translate(row.reason), 'ai-preview-reason'));
        if (row.conflict) {
          const warning = text('此建议无法应用，仍可复制。', 'This suggestion cannot be applied. You can still copy it.');
          feedback.appendChild(contentNode('p', typeof row.conflict === 'string' ? `${warning} ${translate(row.conflict)}` : warning, 'ai-preview-conflict'));
        }
      };
      editor.addEventListener('input', () => {
        row.after = editor.value;
        if (row.translation) {
          try {
            if (typeof pending?.refresh === 'function') {
              const updatedRows = normalizeRows(pending.refresh(snapshot([row])));
              const updated = updatedRows.find((item) => item.id === row.id);
              if (!updated) throw new Error('The suggestion is no longer available');
              // Keep the live row and textarea identities: validation may change
              // selection/conflicts, but must not replace an in-progress edit.
              Object.assign(row, updated, { after: editor.value });
            }
            setStatus('');
          } catch (error) {
            row.conflict = true;
            row.checked = false;
            row.reason = text(`无法检查建议：${error.message || error}`, `Could not check suggestions: ${error.message || error}`);
          }
          syncRowFeedback();
          syncSelection();
          return;
        }
        if (row.before.length + row.after.length > 4000) return;
        const updated = global.AsrEditorUtils?.buildTimedTextDiff?.(row.before, row.after);
        beforeLine.replaceChildren();
        appendField(beforeLine, text('原文', 'Original'), row.before, updated?.before);
      });
      body.append(candidateLabel, editor, feedback);
      copy.addEventListener('click', async () => {
        try {
          await global.navigator.clipboard.writeText(row.after);
          setStatus(text('已复制建议', 'Suggestion copied'));
        } catch {
          if (current.multiple) {
            current.expanded.add(row.id);
            card.open = true;
          }
          editor.focus();
          editor.select();
          setStatus(text('请选择并复制建议文本', 'Select and copy the suggestion text'));
        }
      });
      syncRowFeedback();
      container.appendChild(card);
    });
    if (!container.childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'ai-preview-empty';
      empty.textContent = text('没有文字变化。点击“查看全部”检查所有建议。', 'No text changes. Choose View all to review every suggestion.');
      container.appendChild(empty);
    }
    syncSelection();
  }

  function refreshRows() {
    if (!pending) return false;
    if (typeof pending.refresh === 'function') {
      // Pass user edits and selections to the data layer so it can merge fresh
      // conflict status without replacing the draft with the provider output.
      pending.rows = normalizeRows(pending.refresh(snapshot(pending.rows)));
    }
    syncEntry();
    return true;
  }

  function close() {
    const dialog = element('dialog');
    if (dialog?.open) dialog.close();
  }

  function clear() {
    close();
    pending = null;
    element('rows')?.replaceChildren();
    if (element('status')) setStatus('');
    syncEntry();
  }

  // A follow-up split dialog can keep a suggestion pending until its actual
  // commit. Call consume only after that commit has succeeded.
  function consume(ids, expectedToken) {
    if (!pending || !Array.isArray(ids)
      || (expectedToken !== undefined && expectedToken !== pending.identity)) return;
    const consumed = new Set(ids);
    pending.rows = pending.rows.filter((row) => !consumed.has(row.id));
    if (!pending.rows.length) { clear(); return; }
    if (element('dialog')?.open) renderRows();
    syncEntry();
  }

  function renderHeading() {
    if (!pending) return;
    element('title').textContent = text(`${translate(pending.label)} · 检查建议`, `${translate(pending.label)} · Review suggestions`);
    element('close').textContent = text('稍后查看', 'Review later');
    element('hint').textContent = text('检查并编辑建议，再应用勾选的字幕。关闭窗口会保留建议。', 'Review and edit suggestions, then apply the selected cues. Closing this window keeps the suggestions.');
    element('select-label').textContent = text('全选可应用的建议', 'Select all applicable suggestions');
    element('discard').textContent = text('丢弃全部', 'Discard all');
  }

  function open() {
    if (!hasPending()) return false;
    if (global.MaweSplitCore?.pendingLinkedSplit || document.getElementById('multi-subtitle-split-modal')?.classList.contains('show')) {
      global.MaweHint?.flashHint?.(text('请先关闭当前拆分窗口，再查看 AI 建议', 'Close the current split window before reviewing AI suggestions'), 'warning');
      return false;
    }
    try {
      refreshRows();
      if (!hasPending()) { clear(); return false; }
      setStatus('');
      renderHeading();
      renderRows();
      if (!element('dialog').open) element('dialog').showModal();
      return true;
    } catch (error) {
      renderHeading();
      renderRows();
      setStatus(text(`无法检查建议：${error.message || error}`, `Could not check suggestions: ${error.message || error}`));
      element('apply').disabled = true;
      if (!element('dialog').open) element('dialog').showModal();
      return false;
    }
  }

  async function applySelected() {
    const current = pending;
    if (!current || current.busy) return;
    try {
      refreshRows();
      const selected = current.rows.filter((row) => row.checked && !row.conflict);
      renderRows();
      if (!selected.length) return;
      current.busy = true;
      setStatus('');
      renderRows();
      const processed = await current.apply(snapshot(selected));
      if (pending !== current) return;
      const selectedIds = new Set(selected.map((row) => row.id));
      const processedIds = new Set(Array.isArray(processed) ? processed.filter((id) => selectedIds.has(id)) : []);
      current.rows = current.rows.filter((row) => !processedIds.has(row.id));
      if (!current.rows.length) { clear(); return; }
      refreshRows();
      setStatus(processedIds.size
        ? text(`已应用 ${processedIds.size} 条，剩余建议已保留。`, `Applied ${processedIds.size} cues. Remaining suggestions are kept.`)
        : text('没有应用建议。建议已保留。', 'No suggestions were applied. Suggestions are kept.'));
    } catch (error) {
      if (pending === current) setStatus(text(`无法应用建议：${error.message || error}`, `Could not apply suggestions: ${error.message || error}`));
    } finally {
      if (pending === current) {
        current.busy = false;
        renderRows();
        syncEntry();
      }
    }
  }

  // Reject replacement rather than silently losing an earlier result.
  // refresh(rows) is synchronous; apply(selectedRows) resolves to processed IDs.
  function present({ label, rows, refresh, apply, onDiscard } = {}) {
    if (hasPending() || typeof apply !== 'function' || !element('dialog')) return false;
    const normalized = normalizeRows(rows);
    if (!normalized.length) return false;
    pending = { identity: Symbol('ai-preview'), label: String(label || text('AI 建议', 'AI suggestions')), rows: normalized, refresh, apply, onDiscard, busy: false,
      multiple: normalized.length > 1, changedOnly: true, expanded: new Set() };
    syncEntry();
    return true;
  }

  element('open')?.addEventListener('click', open);
  element('close')?.addEventListener('click', close);
  element('apply')?.addEventListener('click', applySelected);
  element('filter')?.addEventListener('click', () => {
    if (!pending) return;
    pending.changedOnly = !pending.changedOnly;
    renderRows();
  });
  element('discard')?.addEventListener('click', () => {
    if (!pending || pending.busy) return;
    const onDiscard = pending.onDiscard;
    clear();
    onDiscard?.();
  });
  element('select-all')?.addEventListener('change', (event) => {
    if (!pending || pending.busy) return;
    pending.rows.forEach((row) => { row.checked = !row.conflict && event.target.checked; });
    renderRows();
  });
  // Registered before editor shortcut wiring: preserve native textarea editing
  // and dialog Tab/Escape behavior without triggering subtitle/playback actions.
  for (const type of ['keydown', 'keyup']) {
    document.addEventListener(type, (event) => {
      if (element('dialog')?.open) event.stopImmediatePropagation();
    }, true);
  }
  document.addEventListener('mawe:languagechange', () => {
    syncEntry();
    if (pending && element('dialog')?.open) { renderHeading(); renderRows(); }
  });

  global.MaweAiPreview = Object.freeze({ hasPending, token, present, clear, consume, open, close, syncEntry });
})(window);
