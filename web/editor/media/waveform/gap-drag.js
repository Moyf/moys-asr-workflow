// gap-drag: waveform class methods with explicit dependencies.
window.MAWE.register('waveform-gap-drag', function createWaveformModule(dependencies) {
  'use strict';
  const { POINTER_DRAG_THRESHOLD_PX, ROUND_MS, clamp, gapOperationAllowsBoundary, roundMs } = dependencies;

  class WaveformMethods {


    beginGapBoundaryDrag(event, index, row, edge) {
      if (event.button !== 0 || !gapOperationAllowsBoundary(this.options.getGapOperationMode?.())) return;
      event.preventDefault();
      event.stopPropagation();
      const gaps = this.options.getGapRemoveGaps?.() || [];
      this.gapBoundaryDrag = {
        pointerId: event.pointerId,
        index,
        edge,
        row,
        startClientX: event.clientX,
        startClientY: event.clientY,
        originalGaps: gaps.map((gap) => ({ ...gap })),
        nextGaps: gaps.map((gap) => ({ ...gap })),
        captureTarget: event.currentTarget,
        changed: false,
        moved: false,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', this._gapBoundaryMove = (moveEvent) => this.moveGapBoundaryDrag(moveEvent));
      window.addEventListener('pointerup', this._gapBoundaryEnd = (upEvent) => this.endGapBoundaryDrag(upEvent), { once: true });
      window.addEventListener('pointercancel', this._gapBoundaryEnd, { once: true });
    }


    beginGapMoveDrag(event, index, row, mode) {
      if (event.button !== 0 || !['move', 'copy'].includes(mode)) return;
      const gaps = this.options.getGapRemoveGaps?.() || [];
      const original = gaps[index];
      if (!original) return;
      const captureTarget = event.currentTarget;
      this.gapMoveDrag = {
        pointerId: event.pointerId,
        index,
        mode,
        row,
        captureTarget,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPointerMs: this.timeFromPointerUnbounded(event, row),
        originalGaps: gaps.map((gap) => ({ ...gap })),
        nextGaps: gaps.map((gap) => ({ ...gap })),
        targetGap: { ...original },
        deltaMs: 0,
        changed: false,
        moved: false,
      };
      captureTarget.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', this._gapMoveMove = (moveEvent) => this.moveGapMoveDrag(moveEvent));
      window.addEventListener('pointerup', this._gapMoveEnd = (upEvent) => this.endGapMoveDrag(upEvent), { once: true });
      window.addEventListener('pointercancel', this._gapMoveEnd, { once: true });
    }


    gapMoveTarget(original, deltaMs) {
      const length = Math.max(1, Number(original?.end) - Number(original?.start));
      const duration = Number(this.durationMs);
      const maxStart = Number.isFinite(duration) && duration > 0
        ? Math.max(0, duration - length) : Infinity;
      const start = Math.min(maxStart, Math.max(0, Number(original?.start) + deltaMs));
      return { ...original, start, end: start + length };
    }


    moveGapMoveDrag(event) {
      const drag = this.gapMoveDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.moved) {
        const dx = event.clientX - drag.startClientX;
        const dy = event.clientY - drag.startClientY;
        if (dx * dx + dy * dy < POINTER_DRAG_THRESHOLD_PX ** 2) return;
        drag.moved = true;
        drag.captureTarget.classList.add('dragging');
      }
      event.preventDefault();
      const pointerMs = this.timeFromPointerUnbounded(event, drag.row);
      const deltaMs = roundMs(pointerMs - drag.startPointerMs);
      drag.targetGap = this.gapMoveTarget(drag.originalGaps[drag.index], deltaMs);
      drag.deltaMs = drag.targetGap.start - drag.originalGaps[drag.index].start;
      drag.nextGaps = drag.mode === 'copy'
        ? window.AsrEditorUtils.copyGapRemoveRange(
          drag.originalGaps, drag.index, drag.deltaMs, this.durationMs,
        )
        : window.AsrEditorUtils.moveGapRemoveRange(
          drag.originalGaps, drag.index, drag.deltaMs, this.durationMs,
        );
      drag.changed = JSON.stringify(drag.nextGaps) !== JSON.stringify(drag.originalGaps);
      this.scheduleGapMovePreview(drag);
    }


    scheduleGapMovePreview(drag) {
      if (this.gapMovePreviewFrame) return;
      this.gapMovePreviewFrame = requestAnimationFrame(() => {
        this.gapMovePreviewFrame = 0;
        if (this.gapMoveDrag === drag) this.previewGapMoveDrag(drag);
      });
    }


    clearGapMovePreview() {
      this.content.querySelectorAll('.waveform-gap-drag-preview').forEach((element) => element.remove());
    }


    previewGapMoveDrag(drag) {
      this.clearGapMovePreview();
      this.refreshGapBlocks(drag.originalGaps);
      if (!drag.moved) return;
      if (drag.mode === 'move') {
        this.content.querySelectorAll(`.waveform-gap-block[data-gap-index="${drag.index}"]`)
          .forEach((block) => { block.hidden = true; });
      }
      const target = drag.targetGap;
      this.content.querySelectorAll('.waveform-row').forEach((row) => {
        const rowStart = Number(row.dataset.startMs);
        const rowEnd = Number(row.dataset.endMs);
        if (target.end <= rowStart || target.start >= rowEnd) return;
        const preview = document.createElement('div');
        preview.className = `waveform-gap-block waveform-gap-drag-preview ${drag.mode}`;
        if (target.removed === false) preview.classList.add('restored');
        const label = document.createElement('span');
        label.className = 'waveform-gap-label';
        label.textContent = drag.mode === 'copy' ? '复制' : '移动';
        preview.appendChild(label);
        this.layoutGapBlock(preview, target, rowStart, rowEnd);
        row.appendChild(preview);
      });
    }


    endGapMoveDrag(event) {
      const drag = this.gapMoveDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      window.removeEventListener('pointermove', this._gapMoveMove);
      window.removeEventListener('pointerup', this._gapMoveEnd);
      window.removeEventListener('pointercancel', this._gapMoveEnd);
      try { drag.captureTarget.releasePointerCapture?.(event.pointerId); } catch (_) {}
      drag.captureTarget.classList.remove('dragging');
      this.clearGapMovePreview();
      this.gapMoveDrag = null;
      if (event.type === 'pointercancel' || !drag.moved) {
        this.refreshGapBlocks(drag.originalGaps);
        return;
      }
      this.suppressGapClickUntil = Date.now() + 250;
      if (!drag.changed) {
        this.refreshGapBlocks(drag.originalGaps);
        return;
      }
      const callback = drag.mode === 'copy' ? this.options.copyGap : this.options.moveGap;
      callback?.(drag.index, drag.deltaMs);
    }


    refreshGapBlocks(gaps) {
      this.content.querySelectorAll('.waveform-gap-block').forEach((block) => {
        const gap = gaps[Number(block.dataset.gapIndex)];
        const row = block.closest('.waveform-row');
        if (!gap || !row) {
          block.hidden = true;
          return;
        }
        this.layoutGapBlock(block, gap, Number(row.dataset.startMs), Number(row.dataset.endMs));
      });
    }


    clearGapBoundaryPreview() {
      this.content.querySelectorAll('.waveform-gap-boundary-preview').forEach((element) => element.remove());
    }


    appendGapBoundaryPreview(row, gap, index) {
      const preview = document.createElement('div');
      preview.className = 'waveform-gap-block waveform-gap-boundary-preview';
      preview.dataset.gapIndex = String(index);
      preview.classList.toggle('restored', gap.removed === false);
      preview.title = '拖动中的空隙边界预览';
      const label = document.createElement('span');
      label.className = 'waveform-gap-label';
      label.textContent = '边界预览';
      preview.appendChild(label);
      const rowStart = Number(row.dataset.startMs);
      const rowEnd = Number(row.dataset.endMs);
      this.layoutGapBlock(preview, gap, rowStart, rowEnd);
      row.appendChild(preview);
    }


    previewGapBoundaryDrag(drag) {
      this.clearGapBoundaryPreview();
      this.refreshGapBlocks(drag.originalGaps);
      if (!drag.moved) return;
      const original = drag.originalGaps[drag.index];
      if (!original) return;
      const anchor = drag.edge === 'start' ? original.end - 1 : original.start + 1;
      const target = drag.nextGaps.find((gap) => (
        gap.removed === original.removed && gap.start <= anchor && gap.end > anchor
      ));
      if (!target) return;
      const renderTarget = (nextGap, originalIndex) => {
        this.content.querySelectorAll('.waveform-row').forEach((row) => {
          const rowStart = Number(row.dataset.startMs);
          const rowEnd = Number(row.dataset.endMs);
          const existing = [...row.querySelectorAll(
            `.waveform-gap-block[data-gap-index="${originalIndex}"]`,
          )].find((block) => !block.classList.contains('waveform-gap-boundary-preview'));
          if (existing) {
            this.layoutGapBlock(existing, nextGap, rowStart, rowEnd);
          } else if (nextGap.end > rowStart && nextGap.start < rowEnd) {
            this.appendGapBoundaryPreview(row, nextGap, originalIndex);
          }
        });
      };
      renderTarget(target, drag.index);
      const adjacentIndex = drag.edge === 'start' ? drag.index - 1 : drag.index + 1;
      const adjacentOriginal = drag.originalGaps[adjacentIndex];
      const shared = adjacentOriginal && (
        drag.edge === 'start'
          ? adjacentOriginal.end === original.start
          : adjacentOriginal.start === original.end
      );
      if (!shared) return;
      const adjacentAnchor = drag.edge === 'start' ? adjacentOriginal.start + 1 : adjacentOriginal.end - 1;
      const adjacentTarget = drag.nextGaps.find((gap) => (
        gap.removed === adjacentOriginal.removed
        && gap.start <= adjacentAnchor && gap.end > adjacentAnchor
      ));
      if (!adjacentTarget) return;
      renderTarget(adjacentTarget, adjacentIndex);
    }


    moveGapBoundaryDrag(event) {
      const drag = this.gapBoundaryDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.moved) {
        const dx = event.clientX - drag.startClientX;
        const dy = event.clientY - drag.startClientY;
        if (dx * dx + dy * dy < POINTER_DRAG_THRESHOLD_PX ** 2) return;
        drag.moved = true;
        drag.captureTarget.classList.add('dragging');
      }
      event.preventDefault();
      const valueMs = clamp(
        roundMs(this.timeFromPointerUnbounded(event, drag.row)),
        0,
        Math.max(0, this.durationMs),
      );
      drag.nextGaps = window.AsrEditorUtils.resizeGapRemoveBoundary(
        drag.originalGaps,
        drag.index,
        drag.edge,
        valueMs,
      );
      drag.changed = JSON.stringify(drag.nextGaps) !== JSON.stringify(drag.originalGaps);
      drag.valueMs = valueMs;
      this.scheduleGapPreview(drag);
    }


    scheduleGapPreview(drag) {
      // 与字幕块拖拽同理：合并到每帧最多一次预览重排
      if (this.gapPreviewFrame) return;
      this.gapPreviewFrame = requestAnimationFrame(() => {
        this.gapPreviewFrame = 0;
        if (this.gapBoundaryDrag === drag) this.previewGapBoundaryDrag(drag);
      });
    }


    endGapBoundaryDrag(event) {
      const drag = this.gapBoundaryDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      window.removeEventListener('pointermove', this._gapBoundaryMove);
      window.removeEventListener('pointerup', this._gapBoundaryEnd);
      window.removeEventListener('pointercancel', this._gapBoundaryEnd);
      try { drag.captureTarget.releasePointerCapture?.(event.pointerId); } catch (_) {}
      this.content.querySelectorAll('.waveform-gap-block.dragging').forEach((block) => block.classList.remove('dragging'));
      this.clearGapBoundaryPreview();
      this.gapBoundaryDrag = null;
      if (event.type === 'pointercancel' || !drag.changed) {
        this.refreshGapBlocks(drag.originalGaps);
        return;
      }
      this.suppressGapClickUntil = Date.now() + 250;
      this.options.resizeGapBoundary?.(drag.index, drag.edge, drag.valueMs);
    }


    beginGapRangeDrag(event, row, { removed = !event.altKey } = {}) {
      event.preventDefault();
      event.stopPropagation();
      const startMs = this.gapRangePointerTime(event, row);
      this.clearGapRangePreviews();
      this.gapRangeDrag = {
        pointerId: event.pointerId,
        row,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startMs,
        endMs: startMs,
        removed,
        moved: false,
        previews: [],
      };
      row.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', this._gapRangeMove = (moveEvent) => this.moveGapRangeDrag(moveEvent));
      window.addEventListener('pointerup', this._gapRangeEnd = (upEvent) => this.endGapRangeDrag(upEvent), { once: true });
      window.addEventListener('pointercancel', this._gapRangeEnd, { once: true });
    }


    gapRangePointerTime(event, row) {
      return clamp(
        this.timeFromPointerUnbounded(event, row),
        0,
        Math.max(0, this.durationMs),
      );
    }


    clearGapRangePreviews() {
      this.content.querySelectorAll('.waveform-gap-range-preview').forEach((element) => element.remove());
    }


    layoutGapRangePreview(drag) {
      if (!drag.moved) {
        drag.previews = [];
        this.clearGapRangePreviews();
        return;
      }
      const start = Math.min(drag.startMs, drag.endMs);
      const end = Math.max(drag.startMs, drag.endMs);
      const previews = [];
      this.clearGapRangePreviews();
      this.content.querySelectorAll('.waveform-row').forEach((row) => {
        const rowStart = Number(row.dataset.startMs);
        const rowEnd = Number(row.dataset.endMs);
        if (!Number.isFinite(rowStart) || !Number.isFinite(rowEnd) || rowEnd <= rowStart) return;

        let visibleStart;
        let visibleEnd;
        if (end <= start) {
          // 保留按下瞬间的细小指示条；真正的范围仍按半开区间拆分到各行。
          if (row !== drag.row) return;
          let point = clamp(start, rowStart, rowEnd);
          if (point >= rowEnd) point = Math.max(rowStart, rowEnd - 1);
          visibleStart = point;
          visibleEnd = Math.min(rowEnd, point + 1);
        } else {
          if (end <= rowStart || start >= rowEnd) return;
          visibleStart = Math.max(start, rowStart);
          visibleEnd = Math.min(end, rowEnd);
        }
        if (visibleEnd <= visibleStart) return;

        const preview = document.createElement('div');
        preview.className = `waveform-gap-range-preview ${drag.removed ? 'remove' : 'restore'}`;
        if (previews.length === 0) {
          const label = document.createElement('span');
          label.textContent = drag.removed ? '增加静音' : '恢复声音';
          preview.appendChild(label);
        }
        const duration = Math.max(1, rowEnd - rowStart);
        preview.style.left = `${((visibleStart - rowStart) / duration) * 100}%`;
        preview.style.width = `${Math.max(0.25, ((visibleEnd - visibleStart) / duration) * 100)}%`;
        row.appendChild(preview);
        previews.push(preview);
      });
      drag.previews = previews;
    }


    moveGapRangeDrag(event) {
      const drag = this.gapRangeDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.moved) {
        const dx = event.clientX - drag.startClientX;
        const dy = event.clientY - drag.startClientY;
        if (dx * dx + dy * dy < POINTER_DRAG_THRESHOLD_PX ** 2) return;
        drag.moved = true;
      }
      event.preventDefault();
      drag.endMs = this.gapRangePointerTime(event, drag.row);
      this.layoutGapRangePreview(drag);
    }


    endGapRangeDrag(event) {
      const drag = this.gapRangeDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      window.removeEventListener('pointermove', this._gapRangeMove);
      window.removeEventListener('pointerup', this._gapRangeEnd);
      window.removeEventListener('pointercancel', this._gapRangeEnd);
      try { drag.row.releasePointerCapture?.(event.pointerId); } catch (_) {}
      this.clearGapRangePreviews();
      this.gapRangeDrag = null;
      if (event.type === 'pointercancel' || !drag.moved) return;
      const start = roundMs(Math.min(drag.startMs, drag.endMs));
      const end = roundMs(Math.max(drag.startMs, drag.endMs));
      if (end - start < ROUND_MS) return;
      this.options.applyGapRange?.(start, end, drag.removed);
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
});
