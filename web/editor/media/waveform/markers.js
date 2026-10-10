// waveform-markers: 每个可见波形行顶部的通用 Marker / Region 轨道。
// 轨道与字幕块、静音空隙的手势完全分离：空点按 = 添加单点 Marker，
// 横向拖动 = 拖出 Region，拖旗标/条身 = 移动，拖条身两端 = 调整边界。
// 跨行拖动按指针当前所在行换算时间，并支持视口边缘自动滚动；预览裁剪到可见行。
// 数据变更不在这里发生：拖动只更新 DOM 预览，提交经 options 回调进入
// MaweMarkerEditing（撤销/重做与保存状态统一在那一层处理）。
export function createWaveformModule(dependencies) {
  'use strict';
  const { clamp, roundMs } = dependencies;

  const MARKER_DRAG_THRESHOLD_PX = 4;
  const MARKER_EDGE_SCROLL_PX = 36;
  const MARKER_EDGE_SCROLL_STEP_PX = 12;
  // 拖出距离低于该毫秒数时视为点击添加单点 Marker，而不是 Region。
  const MARKER_REGION_MIN_SPAN_MS = 150;

  // 纯函数：按 clientY 挑选指针所在行（含行间隙时取最近行）。
  // rows 是 [{top, bottom, startMs, endMs}] 的普通对象，便于单测。
  function pickMarkerRow(rows, clientY) {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const row of rows || []) {
      if (!row) continue;
      if (clientY >= row.top && clientY <= row.bottom) return row;
      const distance = clientY < row.top ? row.top - clientY : clientY - row.bottom;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = row;
      }
    }
    return nearest;
  }

  // 纯函数：行几何 + clientX -> 行内时间（毫秒），钳制到该行范围。
  function markerRowTimeMs(geometry, clientX) {
    const width = Math.max(1, Number(geometry?.width) || 0);
    const ratio = clamp((clientX - Number(geometry?.left) || 0) / width, 0, 1);
    const startMs = Number(geometry?.startMs);
    const endMs = Number(geometry?.endMs);
    return startMs + ratio * (endMs - startMs);
  }

  class WaveformMethods {

    /** @this {import('./waveform-types.js').WaveformInstance} */
    getMarkers() {
      return this.options.getMarkers?.() || [];
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    appendMarkerTrack(row, startMs, endMs) {
      const markers = this.getMarkers();
      // 行时间标签是否需要给标记轨道让位：仅当该行可见范围内确有标记时下移。
      const hasVisibleMarkers = markers.some((marker) => window.AsrEditorUtils.markerVisibleRange(marker, startMs, endMs));
      row.classList.toggle('waveform-row-has-markers', hasVisibleMarkers);
      if (!markers.length) return;
      const track = document.createElement('div');
      track.className = 'waveform-marker-track';
      track.addEventListener('pointerdown', (event) => {
        // 只有轨道空白区才进入“点击添加 / 拖出 Region”；已有标记元素
        // 会自行 stopPropagation，不会走到这里。
        if (event.button !== 0 || event.target !== track) return;
        this.beginMarkerCreateDrag(event, row);
      });
      track.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      track.addEventListener('contextmenu', (event) => {
        if (event.target !== track) return;
        event.preventDefault();
        event.stopPropagation();
      });
      for (const marker of markers) {
        this.appendMarkerElement(track, row, marker, startMs, endMs);
      }
      row.appendChild(track);
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    appendMarkerElement(track, row, marker, startMs, endMs) {
      const visible = window.AsrEditorUtils.markerVisibleRange(marker, startMs, endMs);
      if (!visible) return;
      const isRegion = window.AsrEditorUtils.markerKind(marker) === 'region';
      const element = document.createElement('div');
      element.className = `waveform-marker-item ${isRegion ? 'region' : 'point'}`;
      element.dataset.markerId = marker.id;
      element.style.setProperty('--marker-color', marker.color || '#3e63dd');
      // 单点 Marker 用更宽的最小可见宽度，便于点中查看。
      const minVisiblePercent = isRegion
        ? window.AsrEditorUtils.MARKER_MIN_VISIBLE_PERCENT
        : window.AsrEditorUtils.MARKER_POINT_MIN_VISIBLE_PERCENT;
      const duration = Math.max(1, endMs - startMs);
      const left = ((visible.start - startMs) / duration) * 100;
      const widthPercent = Math.max(
        minVisiblePercent,
        ((visible.end - visible.start) / duration) * 100,
      );
      element.style.left = `${left}%`;
      element.style.width = `${widthPercent}%`;
      if (!isRegion) {
        const shape = document.createElement('span');
        shape.className = 'waveform-marker-point-shape';
        shape.setAttribute('aria-hidden', 'true');
        element.appendChild(shape);
      }
      const timeLabel = isRegion
        ? `${marker.start} → ${marker.end}`
        : String(marker.start);
      const kindLabel = window.MAWE_I18N?.translateText(isRegion ? '区段' : '标记') || (isRegion ? '区段' : '标记');
      element.title = `${marker.name || kindLabel} · ${timeLabel}${marker.note ? `\n${marker.note}` : ''}`;
      element.setAttribute('aria-label', element.title);
      element.dataset.markerProjectReason = 'true';
      if (marker.review?.status === 'pending') element.classList.add('review-pending');
      if (marker.review?.status === 'confirmed') element.classList.add('review-confirmed');
      if (marker.name) {
        const label = document.createElement('span');
        label.className = 'waveform-marker-label';
        label.textContent = marker.name;
        label.dataset.markerProjectContent = 'true';
        element.appendChild(label);
      }
      if (isRegion) {
        if (marker.start >= startMs) {
          const leftHandle = document.createElement('span');
          leftHandle.className = 'waveform-marker-handle left';
          leftHandle.title = '拖动调整区段起点';
          element.appendChild(leftHandle);
        }
        if (marker.end <= endMs) {
          const rightHandle = document.createElement('span');
          rightHandle.className = 'waveform-marker-handle right';
          rightHandle.title = '拖动调整区段终点';
          element.appendChild(rightHandle);
        }
      }
      element.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const handle = (/** @type {Element | null} */ ((/** @type {HTMLElement} */ (event.target)).closest('.waveform-marker-handle')));
        const mode = handle
          ? (handle.classList.contains('left') ? 'resize-start' : 'resize-end')
          : 'move';
        this.beginMarkerDrag(event, marker.id, row, mode);
      });
      element.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openMarkerQuickEdit(marker.id, element);
      });
      element.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        // 右键等同双击：直接打开标记编辑小弹窗。
        this.openMarkerQuickEdit(marker.id, element);
      });
      track.appendChild(element);
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    refreshMarkerOverlay() {
      if (!this.payload) return;
      // 标记编辑未启用时不渲染标记轨道（工具栏 🔖 / 项目设置镜像控制）。
      if (MaweSettings.EDITOR_SETTINGS.markerEditingEnabled !== true) {
        this.content.querySelectorAll('.waveform-marker-track').forEach((element) => element.remove());
        this.content.querySelectorAll('.waveform-row.waveform-row-has-markers').forEach((row) => {
          row.classList.remove('waveform-row-has-markers');
        });
        return;
      }
      (/** @type {NodeListOf<HTMLElement>} */ (this.content.querySelectorAll('.waveform-marker-track'))).forEach((element) => element.remove());
      (/** @type {NodeListOf<import('./waveform-types.js').WaveformRow>} */ (this.content.querySelectorAll('.waveform-row'))).forEach((row) => {
        this.appendMarkerTrack(row, Number(row.dataset.startMs), Number(row.dataset.endMs));
      });
    }


    // 双击 marker 弹出的小型编辑浮层：名称 / 颜色 / 复核三态。
    // 浮层挂载在滚动内容层（随内容滚动），点击浮层以外或 Esc 关闭；
    // 数据变更经 options.onMarkerQuickEditFields 进入 MaweMarkerEditing。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    openMarkerQuickEdit(markerId, anchorElement) {
      const utils = window.AsrEditorUtils;
      const marker = this.getMarkers().find((candidate) => candidate?.id === markerId);
      if (!marker) return;
      this.closeMarkerQuickEdit();
      const popup = document.createElement('div');
      popup.className = 'waveform-marker-quick-edit';

      const nameField = document.createElement('label');
      nameField.className = 'markers-edit-field';
      const nameCaption = document.createElement('span');
      nameCaption.textContent = '名称';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = marker.name || '';
      nameInput.maxLength = utils.MARKER_NAME_MAX_LENGTH;
      nameInput.placeholder = utils.markerKind(marker) === 'region' ? '区段名称' : '标记名称';
      nameInput.addEventListener('change', () => {
        this.options.onMarkerQuickEditFields?.(markerId, { name: nameInput.value });
      });
      nameField.append(nameCaption, nameInput);

      const swatches = document.createElement('div');
      swatches.className = 'markers-color-swatches';
      for (const preset of utils.MARKER_PRESET_COLORS) {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'markers-color-swatch';
        swatch.dataset.color = preset;
        swatch.style.setProperty('--marker-color', preset);
        swatch.title = utils.markerPresetColorLabel(preset) || preset;
        swatch.setAttribute('aria-label', `使用颜色 ${swatch.title}`);
        swatch.addEventListener('click', () => {
          this.options.onMarkerQuickEditFields?.(markerId, { color: preset });
          this.syncMarkerQuickEdit();
        });
        swatches.appendChild(swatch);
      }

      const reviewToggle = document.createElement('button');
      reviewToggle.type = 'button';
      reviewToggle.className = 'markers-review-toggle';
      reviewToggle.addEventListener('click', () => {
        const latest = this.getMarkers().find((candidate) => candidate?.id === markerId);
        if (!latest) {
          this.closeMarkerQuickEdit();
          return;
        }
        this.options.onMarkerQuickEditFields?.(markerId, { review: utils.nextMarkerReviewStatus(latest) });
        this.syncMarkerQuickEdit();
      });

      // 底部行：复核三态在左，删除在右（样式与编辑卡的操作行一致）。
      const actionsRow = document.createElement('div');
      actionsRow.className = 'markers-item-actions';
      actionsRow.appendChild(reviewToggle);
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'danger';
      deleteButton.textContent = '删除';
      deleteButton.addEventListener('click', () => {
        this.options.onMarkerQuickEditDelete?.(markerId);
        this.closeMarkerQuickEdit();
      });
      actionsRow.appendChild(deleteButton);

      popup.append(nameField, swatches, actionsRow);
      this.content.appendChild(popup);
      this.markerQuickEdit = { markerId, element: popup };
      this.syncMarkerQuickEdit();
      this.positionMarkerQuickEdit(anchorElement);

      this._markerQuickEditOutside = (event) => {
        if (popup.contains(event.target)) return;
        this.closeMarkerQuickEdit();
      };
      this._markerQuickEditKey = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          this.closeMarkerQuickEdit();
        }
      };
      document.addEventListener('pointerdown', this._markerQuickEditOutside, true);
      document.addEventListener('keydown', this._markerQuickEditKey, true);
      nameInput.focus({ preventScroll: true });
    }


    // 打开时 / 每次数据变更后同步浮层的动态状态（激活色、复核按钮文案）。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    syncMarkerQuickEdit() {
      const popup = this.markerQuickEdit?.element;
      if (!popup || !popup.isConnected) return;
      const utils = window.AsrEditorUtils;
      const marker = this.getMarkers().find((candidate) => candidate?.id === this.markerQuickEdit.markerId);
      if (!marker) {
        this.closeMarkerQuickEdit();
        return;
      }
      const currentColor = utils.normalizeMarkerColor(marker.color);
      (/** @type {NodeListOf<HTMLElement>} */ (popup.querySelectorAll('.markers-color-swatch'))).forEach((swatch) => {
        swatch.classList.toggle('active', swatch.dataset.color === currentColor);
      });
      const reviewToggle = (/** @type {HTMLElement} */ (popup.querySelector('.markers-review-toggle')));
      if (reviewToggle) {
        // 无前缀，仅状态名；配色与编辑卡一致（待复核琥珀 / 已确认绿）。
        reviewToggle.textContent = utils.markerReviewStatusLabel(marker);
        reviewToggle.classList.toggle('has-review', Boolean(marker.review));
        reviewToggle.classList.toggle('pending', marker.review?.status === 'pending');
        reviewToggle.classList.toggle('confirmed', marker.review?.status === 'confirmed');
        if (marker.review?.reason) {
          reviewToggle.title = marker.review.reason;
          reviewToggle.dataset.markerProjectReason = 'true';
        } else {
          reviewToggle.removeAttribute('title');
          delete reviewToggle.dataset.markerProjectReason;
        }
      }
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    positionMarkerQuickEdit(anchorElement) {
      const popup = this.markerQuickEdit?.element;
      if (!popup) return;
      const popupWidth = popup.offsetWidth || 208;
      const popupHeight = popup.offsetHeight || 120;
      const contentRect = this.content.getBoundingClientRect();
      const anchorRect = anchorElement.getBoundingClientRect();
      const anchorLeft = anchorRect.left - contentRect.left;
      const anchorTop = anchorRect.top - contentRect.top;
      const maxLeft = Math.max(0, this.content.clientWidth - popupWidth - 4);
      const maxTop = Math.max(0, this.content.clientHeight - popupHeight - 4);
      popup.style.left = `${Math.min(Math.max(4, anchorLeft - 8), maxLeft)}px`;
      // 默认浮层在标记上方；贴着可视区顶部时放到下方。
      const aboveTop = anchorTop - popupHeight - 8;
      popup.style.top = `${Math.min(Math.max(4, aboveTop >= 4 ? aboveTop : anchorTop + anchorRect.height + 8), maxTop)}px`;
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    closeMarkerQuickEdit() {
      if (this._markerQuickEditOutside) {
        document.removeEventListener('pointerdown', this._markerQuickEditOutside, true);
        this._markerQuickEditOutside = null;
      }
      if (this._markerQuickEditKey) {
        document.removeEventListener('keydown', this._markerQuickEditKey, true);
        this._markerQuickEditKey = null;
      }
      this.markerQuickEdit?.element?.remove();
      this.markerQuickEdit = null;
    }


    // 拖动期间的时间换算：以指针当前所在行为准（跨行拖动按新行换算），
    // 行间隙取最近行。基础模式只有一行，行为与旧行几何一致。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    findMarkerRowAtClientY(clientY, fallbackRow = null) {
      const rows = (this.renderedRows?.length
        ? this.renderedRows
        : [...(/** @type {NodeListOf<import('./waveform-types.js').WaveformRow>} */ (this.content.querySelectorAll('.waveform-row')))])
        .map((row) => {
          const rect = row.getBoundingClientRect();
          return {
            row,
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left + row.clientLeft,
            width: Math.max(1, row.clientWidth),
            startMs: Number(row.dataset.startMs),
            endMs: Number(row.dataset.endMs),
          };
        });
      const hit = pickMarkerRow(rows, clientY);
      if (hit) return hit;
      return fallbackRow ? {
        row: fallbackRow,
        ...this.captureRowGeometry(fallbackRow),
      } : null;
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    markerPointerGeometry(event) {
      const drag = this.markerDrag || this.markerCreateDrag || null;
      const hit = this.findMarkerRowAtClientY(event.clientY, drag?.row || null);
      if (!hit) return null;
      return hit;
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    markerPointerTimeMs(event) {
      const geometry = this.markerPointerGeometry(event);
      if (!geometry) return NaN;
      return clamp(
        markerRowTimeMs(geometry, event.clientX),
        0,
        Math.max(0, this.durationMs),
      );
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    _beginMarkerPointerTracking(drag) {
      try { drag.captureTarget?.setPointerCapture?.(drag.pointerId); } catch (_) {}
      this._markerDragMove = (moveEvent) => this.moveMarkerDrag(moveEvent);
      this._markerDragEnd = (upEvent) => this.endMarkerDrag(upEvent);
      window.addEventListener('pointermove', this._markerDragMove);
      window.addEventListener('pointerup', this._markerDragEnd, { once: true });
      window.addEventListener('pointercancel', this._markerDragEnd, { once: true });
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    _teardownMarkerPointerTracking(drag) {
      window.removeEventListener('pointermove', this._markerDragMove);
      window.removeEventListener('pointerup', this._markerDragEnd);
      window.removeEventListener('pointercancel', this._markerDragEnd);
      try { drag.captureTarget?.releasePointerCapture?.(drag.pointerId); } catch (_) {}
      this.stopMarkerEdgeAutoScroll();
    }

    /** @this {import('./waveform-types.js').WaveformInstance} */
    beginMarkerDrag(event, markerId, row, mode) {
      const marker = this.getMarkers().find((candidate) => candidate?.id === markerId);
      if (!marker) return;
      event.preventDefault();
      event.stopPropagation();
      this.focusWaveform?.();
      this.markerDrag = {
        pointerId: event.pointerId,
        markerId,
        mode,
        row,
        captureTarget: event.currentTarget,
        startClientX: event.clientX,
        startClientY: event.clientY,
        original: { ...marker },
        pointerStartMs: this.markerPointerTimeMs(event),
        pending: { ...marker },
        moved: false,
        frame: 0,
        lastEvent: null,
      };
      this._beginMarkerPointerTracking(this.markerDrag);
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    beginMarkerCreateDrag(event, row) {
      event.preventDefault();
      event.stopPropagation();
      this.focusWaveform?.();
      const startMs = this.markerPointerTimeMs(event);
      this.markerCreateDrag = {
        pointerId: event.pointerId,
        mode: 'create',
        row,
        captureTarget: event.currentTarget,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startMs,
        endMs: startMs,
        moved: false,
        frame: 0,
        lastEvent: null,
      };
      this._beginMarkerPointerTracking(this.markerCreateDrag);
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    moveMarkerDrag(event) {
      const drag = this.markerDrag || this.markerCreateDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.moved) {
        const dx = event.clientX - drag.startClientX;
        const dy = event.clientY - drag.startClientY;
        if (dx * dx + dy * dy < MARKER_DRAG_THRESHOLD_PX ** 2) return;
        drag.moved = true;
        drag.captureTarget?.classList?.add('dragging');
      }
      event.preventDefault();
      drag.lastEvent = event;
      this.markerEdgeAutoScroll(event);
      this.applyMarkerDragTime(drag, event);
      if (!drag.frame) {
        drag.frame = requestAnimationFrame(() => {
          drag.frame = 0;
          if ((this.markerDrag === drag) || (this.markerCreateDrag === drag)) {
            this.updateMarkerDragPreview(drag);
          }
        });
      }
    }


    // moveMarkerDrag 的时间换算主体（move / resize / create 三种模式共用）。
    // 视口边缘自动滚动循环也复用：滚动改变指针下的行，需按最后一次指针事件重算。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    applyMarkerDragTime(drag, event) {
      if (drag.mode === 'create') {
        drag.endMs = this.markerPointerTimeMs(event);
        return;
      }
      const pointerMs = this.markerPointerTimeMs(event);
      const duration = Math.max(0, this.durationMs);
      if (drag.mode === 'move') {
        const deltaMs = roundMs(pointerMs - drag.pointerStartMs);
        const length = window.AsrEditorUtils.markerKind(drag.original) === 'region'
          ? drag.original.end - drag.original.start : 0;
        const start = clamp(drag.original.start + deltaMs, 0, Math.max(0, duration - length));
        drag.pending = length
          ? { ...drag.original, start, end: start + length }
          : { ...drag.original, start };
      } else {
        const edge = drag.mode === 'resize-start' ? 'start' : 'end';
        const anchor = edge === 'start' ? drag.original.end : drag.original.start;
        const min = edge === 'start' ? 0 : anchor + 1;
        const max = edge === 'start' ? anchor - 1 : duration;
        const value = clamp(roundMs(pointerMs), min, Math.max(min, max));
        drag.pending = { ...drag.original, [edge]: value };
      }
    }


    // 视口边缘自动滚动：指针贴近滚动容器上下边缘时持续滚动；
    // 滚动会改变指针下的行，因此每帧用最后一次指针事件重算预览。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    markerEdgeAutoScroll(event) {
      const rect = this.scroll.getBoundingClientRect();
      const direction = event.clientY < rect.top + MARKER_EDGE_SCROLL_PX
        ? -1
        : event.clientY > rect.bottom - MARKER_EDGE_SCROLL_PX ? 1 : 0;
      if (direction === 0) {
        this.stopMarkerEdgeAutoScroll();
        return;
      }
      if (this.markerEdgeScrollDirection === direction && this.markerEdgeScrollFrame) return;
      this.stopMarkerEdgeAutoScroll();
      this.markerEdgeScrollDirection = direction;
      const step = () => {
        if (!(this.markerDrag || this.markerCreateDrag)) {
          this.stopMarkerEdgeAutoScroll();
          return;
        }
        this.scroll.scrollTop += this.markerEdgeScrollDirection * MARKER_EDGE_SCROLL_STEP_PX;
        const drag = this.markerDrag || this.markerCreateDrag;
        const lastEvent = drag?.lastEvent;
        if (drag && lastEvent) {
          // 复用 move 的时间换算并立即重绘预览（本回调已在 rAF 帧内）。
          this.applyMarkerDragTime(drag, lastEvent);
          this.updateMarkerDragPreview(drag);
        }
        this.markerEdgeScrollFrame = requestAnimationFrame(step);
      };
      this.markerEdgeScrollFrame = requestAnimationFrame(step);
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    stopMarkerEdgeAutoScroll() {
      if (this.markerEdgeScrollFrame) {
        cancelAnimationFrame(this.markerEdgeScrollFrame);
        this.markerEdgeScrollFrame = 0;
      }
      this.markerEdgeScrollDirection = 0;
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    clearMarkerDragPreviews() {
      (/** @type {NodeListOf<HTMLElement>} */ (this.content.querySelectorAll('.waveform-marker-item.drag-preview'))).forEach((element) => element.remove());
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    updateMarkerDragPreview(drag) {
      this.clearMarkerDragPreviews();
      let range = null;
      if (drag.mode === 'create') {
        const start = Math.min(drag.startMs, drag.endMs);
        const end = Math.max(drag.startMs, drag.endMs);
        if (drag.moved && end - start >= 1) range = { start, end, region: true };
      } else {
        const pending = drag.pending;
        if (window.AsrEditorUtils.markerKind(pending) === 'region') {
          range = { start: pending.start, end: pending.end, region: true };
        } else {
          range = { start: pending.start, end: pending.start + 1, region: false };
        }
      }
      if (!range) return;
      if (drag.mode !== 'create') {
        // 拖既有标记时隐藏原元素，避免同一标记出现两份。
        (/** @type {NodeListOf<HTMLElement>} */ (this.content.querySelectorAll(
          `.waveform-marker-item[data-marker-id="${CSS.escape(String(drag.markerId))}"]`,
        ))).forEach((element) => { element.hidden = true; });
      }
      (/** @type {NodeListOf<import('./waveform-types.js').WaveformRow>} */ (this.content.querySelectorAll('.waveform-row'))).forEach((row) => {
        const rowStart = Number(row.dataset.startMs);
        const rowEnd = Number(row.dataset.endMs);
        const visibleStart = Math.max(range.start, rowStart);
        const visibleEnd = Math.min(range.end, rowEnd);
        if (visibleEnd <= visibleStart) return;
        const duration = Math.max(1, rowEnd - rowStart);
        const preview = document.createElement('div');
        preview.className = `waveform-marker-item drag-preview ${range.region ? 'region' : 'point'}`;
        preview.style.setProperty('--marker-color', drag.original?.color || drag.pending?.color || '#3e63dd');
        preview.style.left = `${((visibleStart - rowStart) / duration) * 100}%`;
        preview.style.width = `${Math.max(
          range.region ? window.AsrEditorUtils.MARKER_MIN_VISIBLE_PERCENT : window.AsrEditorUtils.MARKER_POINT_MIN_VISIBLE_PERCENT,
          ((visibleEnd - visibleStart) / duration) * 100,
        )}%`;
        if (!range.region) {
          const shape = document.createElement('span');
          shape.className = 'waveform-marker-point-shape';
          shape.setAttribute('aria-hidden', 'true');
          preview.appendChild(shape);
        }
        if (range.region) {
          const label = document.createElement('span');
          label.className = 'waveform-marker-label';
          label.textContent = drag.mode === 'create' ? '新区段' : (drag.original?.name || '');
          if (drag.mode !== 'create') label.dataset.markerProjectContent = 'true';
          preview.appendChild(label);
        }
        row.appendChild(preview);
      });
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    endMarkerDrag(event) {
      const drag = this.markerDrag || this.markerCreateDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      this._teardownMarkerPointerTracking(drag);
      drag.captureTarget?.classList?.remove('dragging');
      this.clearMarkerDragPreviews();
      (/** @type {NodeListOf<HTMLElement>} */ (this.content.querySelectorAll('.waveform-marker-item[hidden]'))).forEach((element) => {
        element.hidden = false;
      });
      if (this.markerDrag === drag) this.markerDrag = null;
      if (this.markerCreateDrag === drag) this.markerCreateDrag = null;
      if (event.type === 'pointercancel') return;
      if (drag.mode === 'create') {
        const start = roundMs(Math.min(drag.startMs, drag.endMs));
        const end = roundMs(Math.max(drag.startMs, drag.endMs));
        if (drag.moved && end - start >= MARKER_REGION_MIN_SPAN_MS) {
          this.options.onMarkerCreateRegion?.(start, end);
        } else {
          this.options.onMarkerAdd?.(start);
        }
        return;
      }
      if (!drag.moved) {
        // 点击（未拖动）：定位试听。单点跳到标记处，区段跳到起点。
        this.options.seek(drag.original.start / 1000, { mouseClick: true });
        this.updatePlayback();
        return;
      }
      if (drag.mode === 'move') {
        const deltaMs = roundMs(drag.pending.start - drag.original.start);
        if (deltaMs) this.options.onMarkerMove?.(drag.markerId, deltaMs);
        return;
      }
      const edge = drag.mode === 'resize-start' ? 'start' : 'end';
      const value = roundMs(drag.pending[edge]);
      if (value !== drag.original[edge]) {
        this.options.onMarkerResize?.(drag.markerId, edge, value);
      }
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return Object.assign(descriptors, {
    pickMarkerRow: { value: pickMarkerRow },
    markerRowTimeMs: { value: markerRowTimeMs },
  });
}
