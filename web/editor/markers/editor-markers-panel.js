// 「标记与区段」管理窗：搜索、过滤、定位试听与逐项编辑。
// 列表与编辑卡片全部由本模块渲染（textContent 组装，不拼 HTML 字符串）；
// 数据变更一律经 MaweMarkerEditing，撤销/重做、保存脏标记与波形轨道刷新
// 都由那一层统一处理，这里只负责展示与输入采集。
(function initMaweMarkersPanel(global) {
  'use strict';

  // 管理窗私有 UI 状态：过滤条件、选中高亮项与展开编辑项（不进工程数据）。
  const filter = { query: '', kind: 'all', color: 'all', review: 'all' };
  let selectedMarkerId = null;
  let editingMarkerId = null;
  let colorFilterSynced = false;
  let batchMode = false;
  const showNotesToggle = document.getElementById('markers-show-notes');
  const checkedMarkerIds = new Set();

  function renderBatchActions(visible = filteredMarkers()) {
    if (MaweDom.markersBatchSelectButton) {
      MaweDom.markersBatchSelectButton.textContent = batchMode ? '退出批量选择' : '批量选择';
      MaweDom.markersBatchSelectButton.setAttribute('aria-pressed', String(batchMode));
    }
    if (MaweDom.markersBatchActions) MaweDom.markersBatchActions.hidden = !batchMode;
    if (MaweDom.markersSelectAllButton) {
      MaweDom.markersSelectAllButton.disabled = !visible.length;
      MaweDom.markersSelectAllButton.textContent = visible.length && visible.every(marker => checkedMarkerIds.has(marker.id))
        ? '取消全选' : '全选';
    }
    if (MaweDom.markersDeleteSelectedButton) MaweDom.markersDeleteSelectedButton.disabled = !checkedMarkerIds.size;
    if (MaweDom.markersSelectionSummary) MaweDom.markersSelectionSummary.textContent = `已选 ${checkedMarkerIds.size} 项`;
  }

  function resetSelection() {
    batchMode = false;
    checkedMarkerIds.clear();
    selectedMarkerId = null;
    editingMarkerId = null;
    render();
  }

  function markerUtils() {
    return window.AsrEditorUtils;
  }


  function formatMarkerTime(ms) {
    const value = Math.max(0, Math.round(Number(ms) || 0));
    const totalSeconds = Math.floor(value / 1000);
    const milliseconds = value % 1000;
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    const pad = (num, width = 2) => String(num).padStart(width, '0');
    const base = hours
      ? `${hours}:${pad(minutes)}:${pad(seconds)}`
      : `${minutes}:${pad(seconds)}`;
    return `${base}.${pad(milliseconds, 3)}`;
  }


  function currentFilter() {
    return {
      query: filter.query.trim(),
      kind: filter.kind,
      color: filter.color,
      review: filter.review,
    };
  }


  function filteredMarkers() {
    return markerUtils().filterMarkers(MaweMarkerEditing.getMarkers(), currentFilter());
  }


  // 颜色过滤下拉：按当前工程中出现的颜色去重；保留已选值（颜色消失时回退 all）。
  function syncColorFilterOptions(markers) {
    if (!MaweDom.markersFilterColor) return;
    const colors = [];
    for (const marker of markers) {
      const color = markerUtils().normalizeMarkerColor(marker.color);
      if (!colors.includes(color)) colors.push(color);
    }
    const select = MaweDom.markersFilterColor;
    const previous = colorFilterSynced ? select.value : filter.color;
    select.replaceChildren();
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = '全部';
    select.appendChild(allOption);
    for (const color of colors.slice(0, 64)) {
      const option = document.createElement('option');
      option.value = color;
      // 预设颜色显示中文名称（蓝/青/绿…），自定义颜色显示色值本身。
      option.textContent = markerUtils().markerPresetColorLabel(color) || color;
      select.appendChild(option);
    }
    filter.color = previous !== 'all' && colors.includes(previous) ? previous : 'all';
    select.value = filter.color;
    colorFilterSynced = true;
  }


  // 摘要行：无过滤时显示全部统计；有过滤时左侧更新为过滤结果。
  function renderSummary(markers, visible) {
    if (!MaweDom.markersSummary) return;
    const utils = markerUtils();
    const filterActive = Boolean(filter.query.trim())
      || filter.kind !== 'all' || filter.color !== 'all' || filter.review !== 'all';
    const list = filterActive ? visible : markers;
    const summary = utils.markerSummary(list);
    if (!summary.total) {
      MaweDom.markersSummary.textContent = filterActive
        ? '没有符合当前过滤条件的标记。'
        : '尚无标记；在波形顶部标记轨道空白处点击或拖动即可添加。';
      return;
    }
    const head = filterActive ? `过滤 ${summary.total} 项` : `共 ${summary.total} 项`;
    const parts = [`${head}：标记 ${summary.markers} · 区段 ${summary.regions}`];
    if (summary.pending) parts.push(`待复核 ${summary.pending}`);
    MaweDom.markersSummary.textContent = parts.join('；');
  }


  function buildReviewBadge(marker) {
    if (marker.review?.status !== 'pending' && marker.review?.status !== 'confirmed') return null;
    const badge = document.createElement('span');
    badge.className = `markers-review-badge ${marker.review.status}`;
    badge.textContent = marker.review.status === 'pending' ? '待复核' : '已确认';
    if (marker.review.reason) {
      badge.title = marker.review.reason;
      badge.dataset.markerProjectReason = 'true';
    }
    return badge;
  }


  // 编辑卡片：仅选中项展开。所有输入只在 change 时提交，避免高频重渲染打断输入。
  function buildMarkerEditor(marker) {
    const utils = markerUtils();
    const editor = document.createElement('div');
    editor.className = 'markers-item-editor';

    const nameLabel = document.createElement('label');
    nameLabel.className = 'markers-edit-field';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = '名称';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = marker.name || '';
    nameInput.maxLength = utils.MARKER_NAME_MAX_LENGTH;
    nameInput.placeholder = `${markerUtils().markerKind(marker) === 'region' ? '区段' : '标记'}名称`;
    nameInput.addEventListener('change', () => {
      MaweMarkerEditing.updateMarkerFields(marker.id, { name: nameInput.value });
    });
    nameLabel.append(nameSpan, nameInput);

    const colorRow = document.createElement('div');
    colorRow.className = 'markers-color-row';
    const colorCaption = document.createElement('span');
    colorCaption.className = 'markers-color-caption';
    colorCaption.textContent = '颜色';
    colorRow.appendChild(colorCaption);
    const swatches = document.createElement('div');
    swatches.className = 'markers-color-swatches';
    const currentColor = utils.normalizeMarkerColor(marker.color);
    for (const preset of utils.MARKER_PRESET_COLORS) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = `markers-color-swatch${preset === currentColor ? ' active' : ''}`;
      swatch.style.setProperty('--marker-color', preset);
      swatch.title = utils.markerPresetColorLabel(preset) || preset;
      swatch.setAttribute('aria-label', `使用颜色 ${swatch.title}`);
      swatch.addEventListener('click', () => {
        MaweMarkerEditing.updateMarkerFields(marker.id, { color: preset });
      });
      swatches.appendChild(swatch);
    }
    const hexInput = document.createElement('input');
    hexInput.type = 'text';
    hexInput.className = 'markers-edit-hex';
    hexInput.value = currentColor;
    hexInput.maxLength = 7;
    hexInput.spellcheck = false;
    hexInput.placeholder = '#RRGGBB';
    hexInput.title = '自定义颜色（HEX）';
    hexInput.addEventListener('change', () => {
      const normalized = utils.normalizeMarkerColor(hexInput.value, '');
      if (!normalized) {
        MaweHint.flashHint('颜色格式无效；请使用 #RRGGBB 十六进制格式', 'warning');
        hexInput.value = utils.normalizeMarkerColor(marker.color);
        return;
      }
      MaweMarkerEditing.updateMarkerFields(marker.id, { color: normalized });
    });
    const customColor = document.createElement('div');
    customColor.className = 'markers-custom-color';
    const customCaption = document.createElement('label');
    customCaption.className = 'markers-color-caption';
    customCaption.textContent = '自定义';
    hexInput.id = `markers-color-hex-${marker.id}`;
    customCaption.htmlFor = hexInput.id;
    const colorPicker = document.createElement('input');
    colorPicker.type = 'color';
    colorPicker.className = 'markers-color-picker';
    colorPicker.value = currentColor;
    colorPicker.setAttribute('aria-label', '自定义颜色');
    colorPicker.addEventListener('input', () => {
      hexInput.value = colorPicker.value;
    });
    colorPicker.addEventListener('change', () => {
      MaweMarkerEditing.updateMarkerFields(marker.id, { color: colorPicker.value });
    });
    customColor.append(customCaption, hexInput, colorPicker);
    colorRow.append(swatches, customColor);

    const noteLabel = document.createElement('label');
    noteLabel.className = 'markers-edit-field';
    const noteSpan = document.createElement('span');
    noteSpan.textContent = '备注';
    const noteInput = document.createElement('textarea');
    noteInput.rows = 2;
    noteInput.maxLength = utils.MARKER_NOTE_MAX_LENGTH;
    noteInput.value = marker.note || '';
    noteInput.placeholder = '可选备注';
    noteInput.addEventListener('change', () => {
      MaweMarkerEditing.updateMarkerFields(marker.id, { note: noteInput.value });
    });
    noteLabel.append(noteSpan, noteInput);

    const timeRow = document.createElement('div');
    timeRow.className = 'markers-time-row';
    const startLabel = document.createElement('label');
    startLabel.className = 'markers-time-field';
    const startSpan = document.createElement('span');
    startSpan.textContent = '起点 ms';
    const startInput = document.createElement('input');
    startInput.type = 'number';
    startInput.min = '0';
    startInput.step = '1';
    startInput.inputMode = 'numeric';
    startInput.value = String(marker.start);
    startInput.addEventListener('change', () => {
      const value = Number(startInput.value);
      if (!Number.isFinite(value) || value < 0) {
        MaweHint.flashHint('起点必须是不小于 0 的整数毫秒', 'warning');
        startInput.value = String(marker.start);
        return;
      }
      MaweMarkerEditing.updateMarkerFields(marker.id, { start: value });
    });
    startLabel.append(startSpan, startInput);
    const endLabel = document.createElement('label');
    endLabel.className = 'markers-time-field';
    const endSpan = document.createElement('span');
    endSpan.textContent = '终点 ms';
    const endInput = document.createElement('input');
    endInput.type = 'number';
    endInput.min = '0';
    endInput.step = '1';
    endInput.inputMode = 'numeric';
    endInput.placeholder = '单点标记';
    if (marker.end != null) endInput.value = String(marker.end);
    endInput.addEventListener('change', () => {
      const raw = endInput.value.trim();
      if (!raw) {
        MaweMarkerEditing.updateMarkerFields(marker.id, { end: null });
        return;
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        MaweHint.flashHint('终点必须是正整数毫秒；留空表示单点标记', 'warning');
        endInput.value = marker.end != null ? String(marker.end) : '';
        return;
      }
      MaweMarkerEditing.updateMarkerFields(marker.id, { end: value });
    });
    endLabel.append(endSpan, endInput);
    // 时长与终点双向联动：时长 = 终点 - 起点；改时长即改终点。
    const durationLabel = document.createElement('label');
    durationLabel.className = 'markers-time-field';
    const durationSpan = document.createElement('span');
    durationSpan.textContent = '时长 ms';
    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.min = '1';
    durationInput.step = '1';
    durationInput.inputMode = 'numeric';
    durationInput.placeholder = '单点标记';
    if (marker.end != null) durationInput.value = String(marker.end - marker.start);
    durationInput.addEventListener('change', () => {
      const raw = durationInput.value.trim();
      if (!raw) {
        MaweMarkerEditing.updateMarkerFields(marker.id, { end: null });
        return;
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 1) {
        MaweHint.flashHint('时长必须是不小于 1 的整数毫秒；留空表示单点标记', 'warning');
        durationInput.value = marker.end != null ? String(marker.end - marker.start) : '';
        return;
      }
      MaweMarkerEditing.updateMarkerFields(marker.id, { end: marker.start + Math.round(value) });
    });
    durationLabel.append(durationSpan, durationInput);
    timeRow.append(startLabel, endLabel, durationLabel);

    const actions = document.createElement('div');
    actions.className = 'markers-item-actions';
    // 复核三态 toggle（左下角）：无 → 待复核 → 已确认 → 无；每次点击进撤销历史。
    const reviewToggle = document.createElement('button');
    reviewToggle.type = 'button';
    reviewToggle.className = `markers-review-toggle${marker.review ? ' has-review' : ''}${marker.review?.status === 'pending' ? ' pending' : ''}${marker.review?.status === 'confirmed' ? ' confirmed' : ''}`;
    reviewToggle.textContent = utils.markerReviewStatusLabel(marker);
    if (marker.review?.reason) {
      reviewToggle.title = marker.review.reason;
      reviewToggle.dataset.markerProjectReason = 'true';
    }
    reviewToggle.addEventListener('click', () => {
      MaweMarkerEditing.updateMarkerFields(marker.id, { review: utils.nextMarkerReviewStatus(marker) });
    });
    actions.appendChild(reviewToggle);
    const locateButton = document.createElement('button');
    locateButton.type = 'button';
    locateButton.textContent = '定位试听';
    locateButton.addEventListener('click', () => {
      // 「定位试听」= 跳转并播放；列表项点击 / 波形点击仍只跳转。
      MaweMarkerEditing.locateMarker(marker.id, { play: true });
      MaweHint.flashHint(`已定位到 ${formatMarkerTime(marker.start)} 并播放`, 'success');
    });
    actions.appendChild(locateButton);
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'danger';
    deleteButton.textContent = '删除';
    deleteButton.addEventListener('click', () => MaweMarkerEditing.deleteMarker(marker.id));
    actions.appendChild(deleteButton);

    editor.append(nameLabel, colorRow, noteLabel, timeRow, actions);
    return editor;
  }


  function buildMarkerItem(marker) {
    const utils = markerUtils();
    const isRegion = utils.markerKind(marker) === 'region';
    const item = document.createElement('div');
    item.className = `markers-item ${isRegion ? 'kind-region' : 'kind-marker'}${marker.id === selectedMarkerId ? ' selected' : ''}`;
    item.dataset.markerId = marker.id;
    if (batchMode) item.classList.add('batch-mode');

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'markers-item-main';
    const checkbox = batchMode ? document.createElement('input') : null;
    if (checkbox) {
      checkbox.type = 'checkbox';
      checkbox.className = 'markers-item-checkbox';
      checkbox.checked = checkedMarkerIds.has(marker.id);
      checkbox.setAttribute('aria-label', '选择此标记或区段');
      item.classList.toggle('checked', checkbox.checked);
      main.setAttribute('aria-pressed', String(checkbox.checked));
      // Update only this row and the controls so keyboard focus survives a check.
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) checkedMarkerIds.add(marker.id);
        else checkedMarkerIds.delete(marker.id);
        item.classList.toggle('checked', checkbox.checked);
        main.setAttribute('aria-pressed', String(checkbox.checked));
        renderBatchActions();
      });
      item.appendChild(checkbox);
    }
    main.title = isRegion
      ? `区段 ${formatMarkerTime(marker.start)} → ${formatMarkerTime(marker.end)}`
      : `标记 ${formatMarkerTime(marker.start)}`;

    const swatch = document.createElement('span');
    swatch.className = 'markers-color-swatch static';
    swatch.style.setProperty('--marker-color', utils.normalizeMarkerColor(marker.color));

    const title = document.createElement('span');
    title.className = 'markers-item-title';
    title.textContent = marker.name || (isRegion ? '区段' : '标记');
    if (marker.name) title.dataset.markerProjectContent = 'true';

    const time = document.createElement('span');
    time.className = 'markers-item-time';
    time.textContent = isRegion
      ? `${formatMarkerTime(marker.start)} → ${formatMarkerTime(marker.end)}`
      : formatMarkerTime(marker.start);

    main.append(swatch, title, time);
    const badge = buildReviewBadge(marker);
    if (badge) main.appendChild(badge);
    // 点击列表项：仅选中高亮 + 定位试听；编辑框由右侧「编辑」按钮展开。
    main.addEventListener('click', () => {
      if (checkbox) {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change'));
        return;
      }
      selectedMarkerId = marker.id;
      render();
      MaweMarkerEditing.locateMarker(marker.id);
    });
    // 双击列表项 = 展开 / 收起编辑框（等同「编辑」按钮）。
    main.addEventListener('dblclick', (event) => {
      event.preventDefault();
      if (batchMode) return;
      selectedMarkerId = marker.id;
      editingMarkerId = editingMarkerId === marker.id ? null : marker.id;
      render();
    });
    item.appendChild(main);

    const editButton = document.createElement('button');
    editButton.type = 'button';
    const isEditing = marker.id === editingMarkerId;
    editButton.className = `markers-item-edit${isEditing ? ' active' : ''}`;
    editButton.textContent = isEditing ? '完成' : '编辑';
    editButton.title = isEditing ? '完成' : '展开编辑此标记（名称 / 颜色 / 备注 / 时间 / 复核）';
    editButton.setAttribute('aria-label', isEditing ? '完成' : `编辑 ${marker.name || (isRegion ? '区段' : '标记')}`);
    editButton.addEventListener('click', () => {
      selectedMarkerId = marker.id;
      editingMarkerId = editingMarkerId === marker.id ? null : marker.id;
      render();
    });
    if (!batchMode) item.appendChild(editButton);

    if (showNotesToggle?.checked) {
      const note = document.createElement('div');
      note.className = 'markers-item-note';
      note.dataset.markerProjectContent = 'true';
      note.textContent = marker.note?.trim() ? marker.note : '-';
      item.appendChild(note);
    }
    if (!batchMode && marker.id === editingMarkerId) item.appendChild(buildMarkerEditor(marker));
    return item;
  }


  function render() {
    if (!MaweDom.markersList) return;
    const markers = MaweMarkerEditing.getMarkers();
    syncColorFilterOptions(markers);
    const visible = filteredMarkers();
    const visibleIds = new Set(visible.map(marker => marker.id));
    for (const id of checkedMarkerIds) {
      if (!visibleIds.has(id)) checkedMarkerIds.delete(id);
    }
    renderBatchActions(visible);
    renderSummary(markers, visible);
    if (selectedMarkerId && !markers.some((marker) => marker.id === selectedMarkerId)) {
      selectedMarkerId = null;
    } else if (selectedMarkerId && !visible.some((marker) => marker.id === selectedMarkerId)) {
      selectedMarkerId = null;
    }
    if (editingMarkerId && !markers.some((marker) => marker.id === editingMarkerId)) {
      editingMarkerId = null;
    } else if (editingMarkerId && !visible.some((marker) => marker.id === editingMarkerId)) {
      editingMarkerId = null;
    }
    const list = MaweDom.markersList;
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    if (!markers.length) {
      const empty = document.createElement('div');
      empty.className = 'markers-empty';
      empty.textContent = '尚无标记；在波形顶部标记轨道空白处点击（添加标记）或横向拖动（拉出区段）。';
      list.appendChild(empty);
      return;
    }
    if (!visible.length) {
      const noMatch = document.createElement('div');
      noMatch.className = 'markers-empty';
      noMatch.textContent = '没有符合当前搜索 / 过滤条件的标记。';
      list.appendChild(noMatch);
      return;
    }
    for (const marker of visible) list.appendChild(buildMarkerItem(marker));
    list.scrollTop = scrollTop;
  }


  // 工具窗控制器：复用浮动面板工厂（层级栈、拖动、位置持久化、Esc、工具栏按钮 active 态）。
  const panelController = global.MaweFloatingPanel?.createFloatingPanel?.({
    panel: MaweDom.markersPanel,
    dragHandle: MaweDom.markersDragHandle,
    manageButton: MaweDom.markersManageButton,
    anchorButton: MaweDom.markersManageButton,
    positionKey: MaweDom.MARKERS_PANEL_POSITION_KEY,
    onOpen: render,
  }) || { open() {}, close() {}, toggle() {}, isOpen: () => false };

  // 打开时先渲染，避免显示陈旧列表。
  function openPanel() {
    render();
    panelController.open();
  }

  function closePanel() {
    panelController.close();
  }

  function togglePanel() {
    panelController.toggle();
  }

  function isOpen() {
    return panelController.isOpen();
  }

  // 供 AI 复核流等外部入口使用：打开管理窗并选中定位指定标记。
  function openAndLocate(markerId) {
    selectedMarkerId = markerId;
    openPanel();
    MaweMarkerEditing.locateMarker(markerId);
  }


  // 输入与过滤控件：change/input 即时生效（过滤不进工程数据，不推撤销）。
  MaweDom.markersSearchInput?.addEventListener('input', () => {
    filter.query = MaweDom.markersSearchInput.value || '';
    render();
  });
  MaweDom.markersFilterKind?.addEventListener('change', () => {
    filter.kind = MaweDom.markersFilterKind.value || 'all';
    render();
  });
  MaweDom.markersFilterColor?.addEventListener('change', () => {
    filter.color = MaweDom.markersFilterColor.value || 'all';
    render();
  });
  MaweDom.markersFilterReview?.addEventListener('change', () => {
    filter.review = MaweDom.markersFilterReview.value || 'all';
    render();
  });
  showNotesToggle?.addEventListener('change', render);
  MaweDom.markersAddCurrentButton?.addEventListener('click', () => {
    MaweMarkerEditing.addMarkerAtCurrentTime();
  });
  MaweDom.markersBatchSelectButton?.addEventListener('click', () => {
    batchMode = !batchMode;
    checkedMarkerIds.clear();
    editingMarkerId = null;
    render();
  });
  MaweDom.markersSelectAllButton?.addEventListener('click', () => {
    const visible = filteredMarkers();
    const allSelected = visible.length && visible.every(marker => checkedMarkerIds.has(marker.id));
    checkedMarkerIds.clear();
    if (!allSelected) visible.forEach(marker => checkedMarkerIds.add(marker.id));
    render();
  });
  MaweDom.markersDeleteSelectedButton?.addEventListener('click', () => {
    if (!batchMode) return;
    const ids = filteredMarkers().filter(marker => checkedMarkerIds.has(marker.id)).map(marker => marker.id);
    MaweMarkerEditing.deleteMarkers(ids);
    checkedMarkerIds.clear();
    render();
  });

  global.MaweMarkersPanel = Object.freeze({
    render,
    openPanel,
    closePanel,
    togglePanel,
    isOpen,
    openAndLocate,
    resetSelection,
    getSelectedMarkerId: () => selectedMarkerId,
  });
})(typeof window !== 'undefined' ? window : globalThis);
