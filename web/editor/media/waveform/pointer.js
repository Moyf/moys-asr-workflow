// pointer: waveform class methods with explicit dependencies.
window.MAWE.register('waveform-pointer', function createWaveformModule(dependencies) {
  'use strict';
  const { clamp, resolveTiming, snapPointerTimeToTimingGrid } = dependencies;

  class WaveformMethods {


    pointerTimeMs(event, row, geometry = null, allowCrossRow = false) {
      const requestedMs = allowCrossRow
        ? this.timeFromPointerUnbounded(event, row, geometry)
        : this.timeFromPointer(event, row, geometry);
      return snapPointerTimeToTimingGrid(
        requestedMs,
        this.cueTiming(),
        this.options.getSnapToFrame?.() === true,
      );
    }


    refreshPointerLine() {
      if (this.pointerLineOverrideActive) {
        this.refreshBoundaryDragPointerLine();
        return;
      }
      if (!this.pointerLineEvent || !this.pointerLineRow || !this.pointerLineMarker) return;
      if (!this.pointerLineRow.isConnected) return;
      this.showPointerLine(this.pointerLineEvent, this.pointerLineRow, this.pointerLineMarker);
    }


    showPointerLine(event, row, marker) {
      if (!row || !marker) return;
      const rect = row.getBoundingClientRect();
      const contentLeft = rect.left + row.clientLeft;
      const contentWidth = Math.max(1, row.clientWidth);
      const rawLeft = clamp(event.clientX - contentLeft, 0, contentWidth);
      const startMs = Number(row.dataset.startMs);
      const endMs = Number(row.dataset.endMs);
      const timeMs = this.pointerTimeMs(event, row);
      const left = Number.isFinite(timeMs) && Number.isFinite(startMs) && Number.isFinite(endMs)
        ? clamp(((timeMs - startMs) / Math.max(1, endMs - startMs)) * contentWidth, 0, contentWidth)
        : rawLeft;
      marker.style.left = `${left}px`;
      marker.classList.remove('boundary-snapped');
      marker.hidden = false;
    }


    hidePointerLine(marker) {
      if (marker) marker.hidden = true;
    }


    isCueBoundaryDrag(drag = this.drag) {
      return Boolean(drag && [
        'resize-left', 'resize-right', 'resize-boundary', 'resize-boundary-independent',
      ].includes(drag.kind));
    }


    findVisibleWaveformRowAtPoint(clientX, clientY) {
      const viewport = this.scroll.getBoundingClientRect();
      const viewportLeft = viewport.left + this.scroll.clientLeft;
      const viewportTop = viewport.top + this.scroll.clientTop;
      const viewportRight = viewportLeft + this.scroll.clientWidth;
      const viewportBottom = viewportTop + this.scroll.clientHeight;
      if (clientX < viewportLeft || clientX > viewportRight
          || clientY < viewportTop || clientY > viewportBottom) return null;
      return this.findVisibleWaveformRowAtY(clientY);
    }


    findVisibleWaveformRowAtY(clientY) {
      const viewport = this.scroll.getBoundingClientRect();
      const viewportTop = viewport.top + this.scroll.clientTop;
      const viewportBottom = viewportTop + this.scroll.clientHeight;
      if (clientY < viewportTop || clientY > viewportBottom) return null;
      return [...this.content.querySelectorAll('.waveform-row')].find((row) => {
        const rect = row.getBoundingClientRect();
        return clientY >= rect.top && clientY <= rect.bottom;
      }) || null;
    }


    findVisibleWaveformRowForTime(timeMs) {
      const rows = [...this.content.querySelectorAll('.waveform-row')];
      // 行末时间由前一行持有，和中缝覆盖层的归属规则一致。
      const endingRow = rows.find((row) => Math.abs(Number(row.dataset.endMs) - timeMs) < 1);
      if (endingRow) return endingRow;
      return rows.find((row) => timeMs >= Number(row.dataset.startMs)
        && timeMs < Number(row.dataset.endMs))
        || rows.find((row) => timeMs >= Number(row.dataset.startMs)
          && timeMs <= Number(row.dataset.endMs))
        || null;
    }


    cueBoundaryDragTimeMs(drag = this.drag) {
      if (!this.isCueBoundaryDrag(drag)) return NaN;
      const segment = this.options.getSegments(drag.track || 'main')[drag.index];
      if (!segment) return NaN;
      const timing = resolveTiming(drag.timing || this.cueTiming());
      const edge = drag.kind === 'resize-left'
        ? 'start'
        : drag.kind === 'resize-boundary-independent'
          ? drag.edge
          : 'end';
      return timing.toMs(edge === 'start' ? timing.getStart(segment) : timing.getEnd(segment));
    }


    refreshBoundaryDragPointerLine(force = false) {
      const drag = this.drag;
      if (!this.isCueBoundaryDrag(drag) || (!drag.started && !force)) return;
      this.pointerLineOverrideActive = true;
      const timeMs = this.cueBoundaryDragTimeMs(drag);
      const row = Number.isFinite(timeMs) ? this.findVisibleWaveformRowForTime(timeMs) : null;
      this.content.querySelectorAll('.waveform-pointer-line').forEach((marker) => {
        marker.classList.remove('boundary-snapped');
        marker.hidden = true;
      });
      if (!row) return;
      const marker = row.querySelector('.waveform-pointer-line');
      if (!marker) return;
      const contentWidth = Math.max(1, row.clientWidth);
      const startMs = Number(row.dataset.startMs);
      const endMs = Number(row.dataset.endMs);
      const left = clamp(
        ((timeMs - startMs) / Math.max(1, endMs - startMs)) * contentWidth,
        0,
        contentWidth,
      );
      marker.style.left = `${left}px`;
      marker.classList.add('boundary-snapped');
      marker.hidden = false;
    }


    restorePointerLineAfterBoundaryDrag(position = null) {
      this.pointerLineOverrideActive = false;
      this.content.querySelectorAll('.waveform-pointer-line').forEach((marker) => {
        marker.classList.remove('boundary-snapped');
        marker.hidden = true;
      });
      if (!position || !Number.isFinite(position.clientX) || !Number.isFinite(position.clientY)) {
        this.pointerLineEvent = null;
        this.pointerLineRow = null;
        this.pointerLineMarker = null;
        return;
      }
      const row = this.findVisibleWaveformRowAtPoint(position.clientX, position.clientY);
      const marker = row?.querySelector('.waveform-pointer-line');
      if (!row || !marker) {
        this.pointerLineEvent = null;
        this.pointerLineRow = null;
        this.pointerLineMarker = null;
        return;
      }
      const pointerEvent = { clientX: position.clientX };
      this.pointerLineEvent = pointerEvent;
      this.pointerLineRow = row;
      this.pointerLineMarker = marker;
      this.showPointerLine(pointerEvent, row, marker);
    }


    // 暂停时指针在波形上移动即把画面预览到指针时间。与拖动播放头一样按
    // 最新事件合并到每帧最多一次；真正 seek 前重新检查开关与播放状态，
    // 避免调度之后状态已变化（开始播放、关闭开关、行被虚拟化重建）仍执行。
    scheduleHoverSeekPreview(event, row) {
      if (this.playheadDragActive || this.isCueBoundaryDrag()
          || this.options.getHoverSeekPreview?.() !== true) return;
      this.hoverSeekPreviewLastEvent = event;
      this.hoverSeekPreviewRow = row;
      if (this.hoverSeekPreviewFrame) return;
      this.hoverSeekPreviewFrame = requestAnimationFrame(() => this.flushHoverSeekPreview());
    }


    cancelHoverSeekPreview() {
      if (this.hoverSeekPreviewFrame) {
        cancelAnimationFrame(this.hoverSeekPreviewFrame);
        this.hoverSeekPreviewFrame = 0;
      }
      this.hoverSeekPreviewLastEvent = null;
      this.hoverSeekPreviewRow = null;
    }


    flushHoverSeekPreview() {
      this.hoverSeekPreviewFrame = 0;
      const event = this.hoverSeekPreviewLastEvent;
      const row = this.hoverSeekPreviewRow;
      this.hoverSeekPreviewLastEvent = null;
      this.hoverSeekPreviewRow = null;
      if (!event || !row) return;
      if (this.options.getHoverSeekPreview?.() !== true) return;
      if (!this.player || !this.mediaAvailable) return;
      if (!this.player.paused) return;
      if (event.buttons !== 0) return;
      if (!row.isConnected) return;
      this.seekFromPointer(event, row, false);
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
});
