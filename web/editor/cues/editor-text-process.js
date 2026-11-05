// Ordered subtitle processing, including the existing right-click wrapper.
(function initMaweTextProcess(global) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const modal = $('text-process-modal');
  const preview = $('text-process-preview');
  const apply = $('text-process-confirm');
  const selectedOnly = $('text-process-selected-only');
  const scopeInfo = $('text-process-scope-info');
  const stepList = $('text-preset-rules');
  const stepType = $('text-process-step-type');
  const presetSelect = $('text-preset-select');
  const storageStatus = $('text-preset-status');
  const projectStatus = $('text-process-project-status');
  const maxSteps = 110;
  const stepLabels = Object.fromEntries([...stepType.options].map(({ value, text }) => [value, text]));
  const translate = (value) => global.MAWE_I18N?.translateText(value) ?? value;

  const wrapCharsModal = $('wrap-chars-modal');
  const wrapCharsLeftInput = $('wrap-chars-left');
  const wrapCharsRightInput = $('wrap-chars-right');
  let wrapCharsScope = [];

  let steps = [];
  let selectedPreset = '';
  let selection = [];
  let previewController = null;
  let previewTimer;
  let result = null;
  let session = 0;
  let reading = false;
  let writing = false;
  let expanded = false;
  let showUnchanged = false;
  const openRows = new Map();

  function button(text, click) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = text;
    node.addEventListener('click', click);
    return node;
  }

  function input(label, value, onInput, type = 'text') {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    const field = document.createElement('input');
    field.type = type;
    field.setAttribute('aria-label', label);
    if (type === 'checkbox') field.checked = value;
    else {
      field.placeholder = label;
      field.value = value;
      field.autocomplete = 'off';
    }
    field.addEventListener('input', () => {
      onInput(type === 'checkbox' ? field.checked : field.value);
      refreshActions();
      schedulePreview();
    });
    wrapper.append(field);
    return wrapper;
  }

  function renderWrappers(host, step, assMode) {
    const presets = [...global.AsrEditorUtils.WRAP_CHAR_PRESETS, { id: 'custom', label: '自定义' }];
    const buttons = document.createElement('div');
    buttons.className = 'text-process-wrap-preset-buttons';
    for (const preset of presets) {
      const active = step.wraps.some(({ id }) => id === preset.id);
      if (preset.ass && !assMode && !active) continue;
      const toggle = button(preset.label, () => {
        if (active) step.wraps = step.wraps.filter(({ id }) => id !== preset.id);
        else step.wraps.push(preset.id === 'custom' ? { id: 'custom', left: '', right: '' } : { id: preset.id });
        host.replaceChildren();
        renderWrappers(host, step, assMode);
        const replacement = host.querySelector('[data-wrap-preset-id="' + preset.id + '"]');
        if (!active && preset.id === 'custom') host.querySelector('input')?.focus();
        else (replacement || host.querySelector('button'))?.focus();
        refreshActions();
        schedulePreview();
      });
      toggle.dataset.wrapPresetId = preset.id;
      toggle.setAttribute('aria-pressed', String(active));
      buttons.append(toggle);
    }
    host.append(buttons);
    for (const custom of step.wraps.filter(({ id }) => id === 'custom')) {
      const fields = document.createElement('div');
      fields.className = 'processing-controls';
      fields.append(input('左侧添加', custom.left, (value) => { custom.left = value; }),
        input('右侧添加', custom.right, (value) => { custom.right = value; }));
      host.append(fields);
    }
  }

  function renderSteps() {
    stepList.replaceChildren();
    steps.forEach((step, index) => {
      const row = document.createElement('li');
      row.className = 'text-preset-rule';
      row.dataset.stepIndex = String(index);
      const header = document.createElement('div');
      header.className = 'processing-controls';
      const label = document.createElement('strong');
      label.textContent = translate(stepLabels[step.type] || '未知步骤');
      const move = (offset) => {
        const next = index + offset;
        [steps[next], steps[index]] = [steps[index], steps[next]];
        renderSteps();
        stepList.children[next]?.querySelector('button:not(:disabled)')?.focus();
      };
      const iconButton = (symbol, name, click) => {
        const control = button(symbol, click);
        control.classList.add('processing-step-icon');
        control.setAttribute('aria-label', translate(name));
        control.title = translate(name);
        return control;
      };
      const up = iconButton('↑', '上移', () => move(-1));
      const down = iconButton('↓', '下移', () => move(1));
      up.disabled = index === 0;
      down.disabled = index === steps.length - 1;
      const enabled = input('启用', step.enabled !== false, (value) => { step.enabled = value; }, 'checkbox');
      header.append(label, enabled, up, down, iconButton('×', '删除步骤', () => {
        steps.splice(index, 1);
        renderSteps();
        (stepList.children[index]?.querySelector('button:not(:disabled)') || $('text-preset-add-rule')).focus();
      }));
      row.append(header);
      const fields = document.createElement('div');
      if (step.type === 'replace') {
        fields.className = 'processing-controls processing-replace-fields';
        fields.append(input('规则 ' + (index + 1) + ' 查找', step.find, (value) => { step.find = value; }),
          input('规则 ' + (index + 1) + ' 替换为', step.replacement, (value) => { step.replacement = value; }),
          input('区分大小写', step.caseSensitive, (value) => { step.caseSensitive = value; }, 'checkbox'),
          input('正则', step.regex, (value) => { step.regex = value; }, 'checkbox'));
      } else if (step.type === 'wrap') {
        fields.className = 'processing-wrap-fields';
        renderWrappers(fields, step, MaweSettings.EDITOR_SETTINGS.assMode);
      }
      row.append(fields);
      stepList.append(row);
    });
    refreshActions();
    schedulePreview();
  }

  function prepareStep(step, assMode = true) {
    if (step.type === 'replace') {
      if (!step.find) throw new Error('请输入查找内容');
      const compiled = global.AsrEditorUtils.compileTextSearchPattern(step.find,
        { useRegex: step.regex, caseSensitive: step.caseSensitive });
      if (compiled.error) throw new Error(translate('正则表达式无效') + ' ' + compiled.error);
      return compiled.regex;
    }
    if (step.type === 'wrap') {
      const presets = global.AsrEditorUtils.WRAP_CHAR_PRESETS;
      const pairs = step.wraps.map((wrap) => {
        if (wrap.id === 'custom') return wrap;
        const preset = presets.find(({ id }) => id === wrap.id);
        return preset && { ...preset, ...wrap };
      });
      if (pairs.some((pair) => !pair)) throw new Error('未知步骤');
      if (pairs.some((pair) => pair.ass) && !assMode) throw new Error('该预设包含 ASS 特殊文本样式，请先开启 ASS 模式');
      if (!pairs.length || pairs.some(({ left, right }) => !left && !right)) throw new Error('请选择包裹字符或填写自定义字符');
      return { addWrapChars: true, wrapPairs: pairs, skipWrapped: true };
    }
    if (!Object.hasOwn(stepLabels, step.type)) throw new Error('未知步骤');
    return { [step.type]: true };
  }

  function refreshActions() {
    const { defaultPresetId, presets } = MaweProcessing.library;
    const saved = presets.some(({ id }) => id === selectedPreset);
    const available = !reading && !writing;
    const valid = steps.length > 0;
    presetSelect.disabled = !available;
    for (const id of ['text-preset-export', 'text-preset-import']) $(id).disabled = !available;
    $('text-preset-add-rule').disabled = steps.length >= maxSteps;
    $('text-preset-save-as').disabled = !available || !valid || presets.length >= 100;
    $('text-preset-save').disabled = !available || !saved || !valid;
    $('text-preset-rename').disabled = !available || !saved;
    $('text-preset-delete').disabled = !available || !saved;
    $('text-preset-default').disabled = !available || !saved || selectedPreset === defaultPresetId;
    $('text-preset-clear').disabled = !available || !defaultPresetId;
    $('text-process-project-save').disabled = !valid;
    const override = MaweProcessing.projectOverride('text');
    $('text-process-project-reset').disabled = !available || override === undefined;
    $('text-process-project-empty').disabled = Array.isArray(override) && !override.length;
    projectStatus.textContent = override === undefined ? '此工程继承用户默认'
      : override.length ? '此工程使用自己的文本处理默认' : '此工程不预填';
  }

  function renderPresets() {
    const { presets, defaultPresetId } = MaweProcessing.library;
    presetSelect.replaceChildren(new Option(translate('自定义步骤'), ''));
    for (const { id, name } of presets) {
      const option = new Option(name + (id === defaultPresetId ? ' ★' : ''), id);
      option.dataset.markerProjectContent = '';
      presetSelect.add(option);
    }
    if (!presets.some(({ id }) => id === selectedPreset)) selectedPreset = '';
    presetSelect.value = selectedPreset;
    refreshActions();
  }

  function setPresetScope(scope) {
    const hasSelection = selection.length > 0;
    selectedOnly.checked = scope === undefined ? hasSelection : scope === 'selected';
    selectedOnly.disabled = !hasSelection && !selectedOnly.checked;
    $('text-process-selected-only-hint').hidden = hasSelection || selectedOnly.checked;
  }

  function loadDefault({ preserveScope = false } = {}) {
    const { presets, defaultPresetId } = MaweProcessing.library;
    const preset = presets.find(({ id }) => id === defaultPresetId);
    const project = MaweProcessing.projectOverride('text');
    selectedPreset = project === undefined ? preset?.id || '' : '';
    steps = structuredClone(project ?? preset?.steps ?? []);
    if (!preserveScope) setPresetScope(project === undefined ? preset?.scope : undefined);
    renderPresets();
    renderSteps();
  }

  async function saveLibrary(change, newSelection = selectedPreset) {
    const current = session;
    writing = true;
    refreshActions();
    const status = await MaweProcessing.update(change);
    writing = false;
    if (current !== session) {
      if (modal.classList.contains('show')) {
        if (status === 'saved') storageStatus.textContent = '预设库已保存';
        renderPresets();
      }
      return;
    }
    if (status === 'saved') selectedPreset = newSelection;
    storageStatus.textContent = status === 'saved' ? '预设库已保存'
      : status === 'conflict' ? '预设库已被其他页面修改，请重新打开'
        : '保存失败：' + (status instanceof Error ? status.message : '无法保存用户配置');
    renderPresets();
  }

  function captureTargets(mainIndexes) {
    const main = MaweBoot.DATA.segments;
    const track = mainIndexes ? null : MaweMultiSubtitleCore.getActiveExtensionTrack();
    return [
      ...[...(mainIndexes ?? MaweSelection.selectedIdxs)].sort((a, b) => a - b)
        .map((index) => ({ id: main[index]?.id })),
      ...[...MaweSelection.selectedExtensionIdxs].sort((a, b) => a - b)
        .filter(() => track).map((index) => ({ id: track.segments[index]?.id, trackId: track.id })),
    ].filter(({ id }) => id);
  }

  function currentRows() {
    const main = MaweBoot.DATA.segments;
    const rows = (segments, trackId) => segments.map((segment, index) => ({
      segment, index, trackId, before: String(segment.text ?? ''),
    }));
    const mainRows = rows(main);
    const targetRows = selectedOnly.checked ? [
      ...mainRows,
      ...[...new Set(selection.map(({ trackId }) => trackId).filter(Boolean))].flatMap((id) =>
        rows(MaweMultiSubtitleCore.getExtensionTrack(id)?.segments || [], id)),
    ] : mainRows;
    if (!selectedOnly.checked) return targetRows;
    const selectedIds = new Set(selection.map(({ id, trackId }) => JSON.stringify([trackId, id])));
    return targetRows.filter(({ segment, trackId }) => selectedIds.has(JSON.stringify([trackId, segment.id])));
  }

  // Feed replacements to the worker in small batches so a
  // pathological regex can be terminated without cancelling healthy long projects.
  function replaceBatch(texts, source, flags, replacement, useRegex, expand) {
    const regex = new RegExp(source, flags);
    return texts.map((text) => {
      let result = '';
      let cursor = 0;
      const limit = Math.max(262144, text.length);
      for (const match of text.matchAll(regex)) {
        const start = match.index;
        const end = start + match[0].length;
        const value = useRegex ? expand(replacement, {
          start, end, text: match[0], captures: match.slice(1), groups: match.groups,
        }, text) : replacement;
        if (result.length + start - cursor + value.length > limit) throw new Error('替换结果过长');
        result += text.slice(cursor, start) + value;
        cursor = end;
      }
      if (result.length + text.length - cursor > limit) throw new Error('替换结果过长');
      return result + text.slice(cursor);
    });
  }

  function makeRegexWorker() {
    // The existing substitution helper is pure and self-contained. Embedding
    // both functions in a Blob also supports the standalone file:// editor.
    const source = 'const run = ' + replaceBatch.toString()
      + ';const expand = ' + global.AsrEditorUtils.expandTextSearchReplacement.toString()
      + ';self.onmessage = ({data}) => { try { self.postMessage({texts: run(...data, expand)}); }'
      + 'catch (error) { self.postMessage({error: error.message}); } };';
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { return new Worker(url); } finally { URL.revokeObjectURL(url); }
  }

  function regexRequest(worker, args, signal) {
    return new Promise((resolve, reject) => {
      const finish = (error, texts) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        worker.onmessage = null;
        worker.onerror = null;
        if (error) reject(error);
        else resolve(texts);
      };
      const cancel = () => finish(signal.reason);
      const timer = setTimeout(() => finish(new Error('规则运行超时，请简化正则表达式')), 1500);
      signal.addEventListener('abort', cancel, { once: true });
      worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.texts);
      worker.onerror = () => finish(new Error('无法启动正则预览'));
      try { worker.postMessage(args); } catch (error) { finish(error); }
    });
  }

  async function processRows(rows, recipe, signal) {
    let texts = rows.map(({ before }) => before);
    let worker;
    const { assMode, assSpecialSymbolRule } = MaweSettings.EDITOR_SETTINGS;
    try {
      for (const [index, step] of recipe.entries()) {
        try {
          signal.throwIfAborted();
          if (step.enabled === false) continue;
          const operation = prepareStep(step, assMode);
          if (step.type !== 'replace') {
            texts = texts.map((value) => global.AsrEditorUtils.applyTextProcessing(value,
              { ...operation, assSpecialSymbolRule }));
          } else {
            worker ||= makeRegexWorker();
            const next = [];
            for (let start = 0; start < texts.length; start += 64) {
              signal.throwIfAborted();
              next.push(...await regexRequest(worker, [
                texts.slice(start, start + 64), operation.source, operation.flags, step.replacement, step.regex,
              ], signal));
            }
            texts = next;
          }
        } catch (error) {
          if (!signal.aborted) {
            stepList.children[index]?.setAttribute('aria-invalid', 'true');
            throw new Error((index + 1) + '. ' + translate(stepLabels[step.type] || '未知步骤')
              + ' · ' + translate(error.message));
          }
          throw error;
        }
      }
      return rows.map((row, index) => ({ ...row, after: texts[index] }));
    } finally {
      worker?.terminate();
    }
  }

  function showResult(rows) {
    const changed = rows.filter(({ before, after }) => before !== after);
    const header = document.createElement('div');
    header.className = 'replace-preview-summary text-process-preview-summary';
    const summary = document.createElement('span');
    summary.textContent = changed.length
      ? '将处理 ' + rows.length + ' 条字幕，预计修改 ' + changed.length + ' 条（展开查看前后文本）'
      : '选定的 ' + rows.length + ' 条字幕不会发生变化';
    const controls = document.createElement('div');
    controls.className = 'text-process-preview-actions';
    header.append(summary, controls);
    preview.replaceChildren(header);
    if (changed.length < rows.length) {
      const filter = button(showUnchanged ? '仅看有变化的字幕' : '查看全部字幕', () => {
        showUnchanged = !showUnchanged;
        showResult(rows);
        preview.querySelector('.text-process-preview-filter')?.focus();
      });
      filter.className = 'text-process-preview-filter';
      filter.setAttribute('aria-pressed', String(showUnchanged));
      controls.append(filter);
    }
    const details = (showUnchanged ? rows : changed).map((row) => {
      const node = document.createElement('details');
      node.className = 'replace-preview-row';
      const key = JSON.stringify([row.trackId, row.segment.id]);
      node.open = openRows.get(key) ?? expanded;
      const title = document.createElement('summary');
      title.textContent = (row.trackId ? '副字幕' : '主字幕') + '第 ' + (row.index + 1) + ' 条';
      const before = document.createElement('div');
      const after = document.createElement('div');
      before.className = 'replace-preview-before';
      after.className = 'replace-preview-after';
      const appendText = (parent, label, value) => {
        const content = document.createElement('span');
        content.dataset.markerProjectContent = '';
        content.textContent = value;
        parent.append(document.createTextNode(label), content);
      };
      appendText(before, '处理前：', row.before);
      appendText(after, '处理后：', row.after);
      node.append(title, before, after);
      node.addEventListener('toggle', () => {
        if (!node.isConnected) return;
        openRows.set(key, node.open);
        syncExpandLabel();
      });
      return node;
    });
    const toggle = button('', () => {
      expanded = !details.every((node) => node.open);
      details.forEach((node) => { node.open = expanded; });
      syncExpandLabel();
    });
    toggle.className = 'text-process-preview-toggle';
    function syncExpandLabel() {
      toggle.textContent = details.every((node) => node.open) ? '全部收缩' : '全部展开';
    }
    if (details.length) controls.append(toggle);
    syncExpandLabel();
    for (const node of details) preview.append(node);
    apply.disabled = reading || changed.length === 0;
  }

  function cancelPreview() {
    clearTimeout(previewTimer);
    previewController?.abort();
    previewController = null;
    result = null;
    apply.disabled = true;
  }

  function schedulePreview() {
    cancelPreview();
    if (!modal.classList.contains('show')) return;
    stepList.querySelectorAll('[aria-invalid]').forEach((node) => node.removeAttribute('aria-invalid'));
    const rows = currentRows();
    scopeInfo.textContent = selectedOnly.checked ? '当前范围：仅选中的 ' + rows.length + ' 条字幕'
      : '当前范围：全部 ' + rows.length + ' 条字幕';
    scopeInfo.classList.toggle('selected', selectedOnly.checked);
    if (selectedOnly.checked && !rows.length) {
      preview.textContent = '需要先选中至少1条字幕才可启用';
      return;
    }
    const hasSteps = steps.some((step) => step.enabled !== false);
    preview.textContent = hasSteps ? '正在生成预览…' : '请选择至少一项文本处理操作';
    if (!hasSteps) return;
    const controller = new AbortController();
    previewController = controller;
    const recipe = structuredClone(steps);
    previewTimer = setTimeout(async () => {
      try {
        const rowsAfter = await processRows(rows, recipe, controller.signal);
        if (controller.signal.aborted) return;
        result = rowsAfter;
        showResult(rowsAfter);
      } catch (error) {
        if (!controller.signal.aborted) preview.textContent = error.message;
      }
    }, 120);
  }

  function closeTextProcessModal({ restoreFocus = true } = {}) {
    if (!modal.classList.contains('show')) return;
    session++;
    modal.classList.remove('show');
    cancelPreview();
    if (restoreFocus) $('text-process-btn')?.focus();
  }

  function createStep(type) {
    if (type === 'replace') return { type, find: '', replacement: '', regex: false, caseSensitive: false };
    return type === 'wrap' ? { type, wraps: [] } : { type };
  }

  async function openTextProcessModal({ replaceSelection } = {}) {
    if (!MaweBoot.DATA.segments.length && !MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments?.length) {
      MaweHint.flashHint('当前没有可处理的字幕', 'invalid');
      return;
    }
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
    MaweCuePanel.commitCuePanelEdit();
    const current = ++session;
    selection = captureTargets(replaceSelection);
    openRows.clear();
    expanded = false;
    showUnchanged = false;
    reading = true;
    modal.classList.add('show');
    $('text-process-storage-scope').hidden = !MaweProcessing.portable;
    storageStatus.textContent = '正在读取用户配置…';
    if (replaceSelection) {
      selectedPreset = '';
      steps = [createStep('replace')];
      stepType.value = 'replace';
      setPresetScope('selected');
      renderPresets();
      renderSteps();
      stepList.querySelector('.processing-replace-fields input')?.focus();
    } else {
      loadDefault();
      $('text-preset-add-rule').focus();
    }
    const fingerprint = () => JSON.stringify([steps, selectedPreset]);
    const initial = fingerprint();
    const initialScope = selectedOnly.checked;
    const ok = await MaweProcessing.refresh();
    if (session !== current) return;
    reading = false;
    storageStatus.textContent = ok ? '' : '无法读取用户配置';
    if (!replaceSelection && fingerprint() === initial) loadDefault({ preserveScope: selectedOnly.checked !== initialScope });
    else {
      renderPresets();
      schedulePreview();
    }
  }

  function confirm() {
    if (reading || !result) return;
    const current = currentRows();
    if (current.length !== result.length || current.some(({ segment, before }, index) =>
      segment !== result[index].segment || before !== result[index].before)) {
      schedulePreview();
      return;
    }
    const changes = result.filter(({ before, after }) => before !== after);
    if (!changes.length) return;
    const mappings = changes.map(({ segment, before, after }) =>
      global.AsrEditorUtils.reconcileTimedTextItems(before, segment.items, after));
    closeTextProcessModal();
    MaweCommands.run('文本处理', (command) => {
      let affected = 0;
      let extensionChanged = false;
      for (const [index, { segment, trackId, after }] of changes.entries()) {
        const mapping = mappings[index];
        segment.text = after;
        segment._dirty = true;
        if (!after || mapping.status === 'lost') delete segment.items;
        else if (mapping.items) segment.items = mapping.items;
        if (mapping.status === 'lost' || mapping.affectedItems > 0) affected++;
        if (trackId) extensionChanged = true;
      }
      if (extensionChanged) MaweMultiSubtitleCore.markMultiSubtitleDirty();
      command.commit({ cueList: true, waveform: 'overlay', preview: 'update' });
      MaweHistory.updateUndoRedoButtons();
      MaweHint.flashHint(affected
        ? '已应用文本处理：' + changes.length + ' 条字幕，' + affected + ' 条字词时间码未能完整保留'
        : '已应用文本处理：' + changes.length + ' 条字幕', affected ? 'warning' : 'success');
    });
  }

  $('text-process-btn').addEventListener('click', () => openTextProcessModal());
  $('text-process-cancel').addEventListener('click', () => closeTextProcessModal());
  modal.addEventListener('click', (event) => { if (event.target === modal) closeTextProcessModal(); });
  document.addEventListener('keydown', (event) => {
    if (!modal.classList.contains('show') || event.key !== 'Escape') return;
    event.stopImmediatePropagation();
    event.preventDefault();
    closeTextProcessModal();
  }, true);
  selectedOnly.addEventListener('change', schedulePreview);
  apply.addEventListener('click', confirm);
  $('text-preset-add-rule').addEventListener('click', () => {
    steps = [...steps, createStep(stepType.value)];
    renderSteps();
    stepList.lastElementChild?.querySelector('input, .text-process-wrap-preset-buttons button')?.focus();
  });
  presetSelect.addEventListener('change', () => {
    selectedPreset = presetSelect.value;
    const preset = MaweProcessing.library.presets.find(({ id }) => id === selectedPreset);
    steps = structuredClone(preset?.steps || []);
    if (preset) setPresetScope(preset.scope);
    renderSteps();
  });
  const currentScope = () => selectedOnly.checked ? 'selected' : 'all';
  $('text-preset-save-as').addEventListener('click', () => {
    const name = global.prompt('预设名称')?.trim();
    if (!name) return;
    const id = crypto.randomUUID();
    const recipe = structuredClone(steps);
    const scope = currentScope();
    void saveLibrary((draft) => { draft.presets.push({ id, name, scope, steps: recipe }); }, id);
  });
  $('text-preset-save').addEventListener('click', () => {
    const id = selectedPreset;
    const recipe = structuredClone(steps);
    const scope = currentScope();
    void saveLibrary((draft) => Object.assign(draft.presets.find((preset) => preset.id === id), { steps: recipe, scope }));
  });
  $('text-preset-rename').addEventListener('click', () => {
    const id = selectedPreset;
    const current = MaweProcessing.library.presets.find((preset) => preset.id === id);
    const name = global.prompt('预设名称', current.name)?.trim();
    if (name) void saveLibrary((draft) => { draft.presets.find((preset) => preset.id === id).name = name; });
  });
  $('text-preset-delete').addEventListener('click', () => {
    const id = selectedPreset;
    if (!global.confirm('删除这个预设？')) return;
    void saveLibrary((draft) => {
      draft.presets = draft.presets.filter((preset) => preset.id !== id);
      if (draft.defaultPresetId === id) draft.defaultPresetId = null;
    }, '');
  });
  $('text-preset-export').addEventListener('click', () => {
    const { schema, presets, defaultPresetId } = MaweProcessing.library;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ schema, presets, defaultPresetId }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'text-processing-presets.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('text-preset-import').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !global.confirm('导入会替换当前预设库，是否继续？')) return;
    const openedAt = session;
    try {
      if (file.size > 1024 * 1024) throw new Error('文件过大');
      const imported = MaweProcessing.validate(JSON.parse(await file.text()));
      if (openedAt !== session) return;
      await saveLibrary((draft) => {
        draft.presets = imported.presets;
        draft.defaultPresetId = imported.defaultPresetId;
      }, '');
    } catch (error) {
      if (openedAt === session) storageStatus.textContent = '导入失败：' + error.message;
    }
  });
  $('text-preset-default').addEventListener('click', () => {
    const id = selectedPreset;
    void saveLibrary((draft) => { draft.defaultPresetId = id; });
  });
  $('text-preset-clear').addEventListener('click', () => {
    void saveLibrary((draft) => { draft.defaultPresetId = null; });
  });
  $('text-process-project-save').addEventListener('click', () => {
    try {
      MaweProcessing.setProjectOverride('text', steps);
      refreshActions();
    } catch (error) {
      projectStatus.textContent = '保存失败：' + error.message;
    }
  });
  $('text-process-project-empty').addEventListener('click', () => {
    MaweProcessing.setProjectOverride('text', []);
    loadDefault();
  });
  $('text-process-project-reset').addEventListener('click', () => {
    MaweProcessing.setProjectOverride('text', undefined);
    loadDefault();
  });
  MaweState.observeProjectLoad(() => closeTextProcessModal({ restoreFocus: false }));
  MaweState.onProjectDirtyChange(() => {
    if (modal.classList.contains('show')) schedulePreview();
  });
  $('ass-mode-toggle')?.addEventListener('change', () => {
    if (modal.classList.contains('show')) renderSteps();
  });
  document.addEventListener('mawe:languagechange', () => {
    if (modal.classList.contains('show')) renderSteps();
  });

  // 「左右添加字符」：在主字幕文本两端插入字符（支持多选批量）。插入一律双符号形式；
  // 已用同一对符号包裹的条目跳过，不重复包裹。
  // warnWordTimings=false 时不再提示字词时间码失配：右键快捷包裹属于刻意
  // 加装饰符号，字词时间码必然对不上，警告只会造成困扰。
  function applyWrapChars(scope, left, right, label = '左右添加字符', { warnWordTimings = true } = {}) {
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
    const indexes = [...new Set((Array.isArray(scope) ? scope : [])
      .filter((index) => Number.isInteger(index) && index >= 0 && index < MaweBoot.DATA.segments.length))]
      .sort((a, b) => a - b);
    if (!indexes.length) return;
    const { wrapCharsAroundText } = window.AsrEditorUtils;
    const previews = indexes.map((index) => ({
      index,
      ...wrapCharsAroundText(MaweBoot.DATA.segments[index]?.text, left, right,
        MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule),
    }));
    const skipped = previews.filter((row) => row.skipped).length;
    if (!previews.some((row) => row.changed)) {
      MaweHint.flashHint(skipped ? '选中字幕已包裹相同符号，未重复添加' : '没有可添加字符的字幕', 'invalid');
      return;
    }
    return MaweCommands.run(label, (command) => {
      let changed = 0, staleWordTimings = 0;
      previews.forEach((row) => {
        if (!row.changed) return;
        const segment = MaweBoot.DATA.segments[row.index];
        const previousText = segment.text;
        segment.text = row.text;
        segment._dirty = true;
        changed += 1;
        if (window.AsrEditorUtils.planWordTimingTextSync(segment, previousText)?.warn) staleWordTimings += 1;
      });
      command.commit({ cueList: true, waveform: 'overlay', preview: 'update' });
      MaweHistory.updateUndoRedoButtons();
      MaweHint.flashHint(
        skipped ? `已为 ${changed} 条字幕添加字符；${skipped} 条已包裹相同符号，已跳过` : `已为 ${changed} 条字幕添加字符`,
        'success',
      );
      if (warnWordTimings && staleWordTimings) {
        MaweHint.flashHint(`${staleWordTimings} 条字幕的字词时间码文字未随字符添加更新，请按需检查`, 'warning');
      }
    });
  }


  function openWrapCharsModal(scope) {
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
    wrapCharsScope = (Array.isArray(scope) ? scope : [...MaweSelection.selectedIdxs])
      .filter((index) => Number.isInteger(index) && index >= 0 && index < MaweBoot.DATA.segments.length);
    if (!wrapCharsScope.length) {
      MaweHint.flashHint('请先选择要处理的字幕', 'invalid');
      return;
    }
    if (wrapCharsLeftInput) wrapCharsLeftInput.value = '';
    if (wrapCharsRightInput) wrapCharsRightInput.value = '';
    wrapCharsModal?.classList.add('show');
    setTimeout(() => {
      if (wrapCharsModal?.classList.contains('show') && !wrapCharsModal.contains(document.activeElement)) {
        wrapCharsLeftInput?.focus();
      }
    }, 50);
  }


  function closeWrapCharsModal() {
    wrapCharsModal?.classList.remove('show');
  }

  global.MaweTextProcess = Object.freeze({
    wrapCharsModal, wrapCharsLeftInput, wrapCharsRightInput,
    get wrapCharsScope() { return wrapCharsScope; },
    openTextProcessModal, applyWrapChars, openWrapCharsModal, closeWrapCharsModal,
  });
})(window);
