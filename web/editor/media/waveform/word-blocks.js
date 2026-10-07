window.MAWE.register('waveform-word-blocks', function createWordBlocks(dependencies) {
  'use strict';
  const { colorForSegment, firstCueIndexOverlapping, resolveTiming, localizedWaveformMessage } = dependencies;
  class WordMethods {
    appendWordBlocks(row, index, startMs, endMs) {
      if (!this.options.wordTiming?.enabled) return;
      const segment = this.options.getSegments('main')[index];
      if (!segment || this.isSegmentHiddenForDisplay(segment)) return;
      const timing = resolveTiming(this.options.getCueTiming?.());
      const entries = window.AsrEditorUtils.getWordTimingEntries(segment, timing);
      const selection = this.options.wordTiming.getSelection(segment);
      entries.forEach(entry => {
        const range = { start: timing.toMs(entry.start), end: timing.toMs(entry.end) };
        if (range.end <= startMs || range.start >= endMs) return;
        const block = document.createElement('div');
        block.className = 'waveform-word-block';
        block.dataset.segmentIdx = String(index);
        block.dataset.itemIdx = String(entry.index);
        block.dataset.track = 'main';
        block.style.setProperty('--cue-color', colorForSegment(segment));
        block.classList.toggle('selected', selection.has(entry.index));
        block.classList.toggle('disabled', Boolean(segment.disabled));
        const time = `${timing.format(entry.start)} → ${timing.format(entry.end)}`;
        block.title = `${entry.text}\n${time}`;
        const label = document.createElement('span');
        label.className = 'waveform-word-label';
        label.dataset.wordProjectContent = 'true';
        label.textContent = entry.text;
        block.append(label);
        if (range.start >= startMs) {
          const handle = document.createElement('span');
          handle.className = 'waveform-cue-handle left';
          handle.title = localizedWaveformMessage('调整字词起点', 'Adjust timed text start');
          block.append(handle);
        }
        if (range.end <= endMs) {
          const handle = document.createElement('span');
          handle.className = 'waveform-cue-handle right';
          handle.title = localizedWaveformMessage('调整字词终点', 'Adjust timed text end');
          block.append(handle);
        }
        this.layoutBlock(block, range, startMs, endMs, row);
        block.addEventListener('pointerdown', event => this.beginWordDrag(event, index, entry.index, row));
        block.addEventListener('contextmenu', event => {
          event.preventDefault(); event.stopPropagation();
          this.focusWaveform();
          this.options.wordTiming.showMenu(event.clientX, event.clientY, index, entry.index);
        });
        block.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); });
        row.append(block);
      });
      if (this.options.getAdjacentBoundaryMode?.() !== 'dual') return;
      entries.slice(0, -1).forEach((left, position) => {
        const right = entries[position + 1];
        const seam = timing.toMs(left.end);
        if (left.end !== right.start || seam <= startMs || seam > endMs) return;
        const zone = document.createElement('span');
        zone.className = 'waveform-word-boundary';
        zone.style.left = `${(seam - startMs) / Math.max(1, endMs - startMs) * 100}%`;
        zone.title = localizedWaveformMessage('拖动调整贴合字词边界（两侧一起移动）', 'Drag the shared timed text boundary');
        zone.addEventListener('pointerdown', event => this.beginWordDrag(event, index, left.index, row, true));
        row.append(zone);
      });
    }

    refreshWordBlocks() {
      this.content.querySelectorAll('.waveform-row').forEach(row => {
        row.querySelectorAll('.waveform-word-block, .waveform-word-boundary').forEach(block => block.remove());
        const start = Number(row.dataset.startMs), end = Number(row.dataset.endMs);
        const segments = this.options.getSegments('main');
        for (let index = firstCueIndexOverlapping(segments, start); index < segments.length; index += 1) {
          if (segments[index].start >= end) break;
          this.appendWordBlocks(row, index, start, end);
        }
      });
    }

    beginWordDrag(event, index, itemIndex, row, seam = false) {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      this.cancelWordDrag();
      this.cancelHoverSeekPreview();
      this.focusWaveform();
      const geometry = this.captureRowGeometry(row);
      const timing = resolveTiming(this.options.getCueTiming?.());
      const pointer = timing.fromMs(this.pointerTimeMs(event, row, geometry));
      const handle = event.target.closest('.waveform-cue-handle');
      this.options.wordTiming.select(index, itemIndex, event);
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      const segment = this.options.getSegments('main')[index];
      const entries = window.AsrEditorUtils.getWordTimingEntries(segment, timing);
      const entry = entries.find(e => e.index === itemIndex);
      if (!entry) return;
      const edge = seam || handle?.classList.contains('right') ? 'end' : 'start';
      const resize = seam || Boolean(handle);
      const drag = {
        pointerId: event.pointerId, segment, timing, row, geometry, pointer,
        clientX: event.clientX, clientY: event.clientY, moved: false, command: null,
        original: { ...segment, items: JSON.parse(JSON.stringify(segment.items)) },
        indices: resize ? [itemIndex] : [...this.options.wordTiming.getSelection(segment)],
        resize, edge, seam, itemIndex,
      };
      this.wordDrag = drag;
      drag.move = next => this.updateWordDrag(next);
      drag.up = next => this.endWordDrag(next);
      drag.cancel = () => this.cancelWordDrag();
      window.addEventListener('pointermove', drag.move);
      window.addEventListener('pointerup', drag.up);
      window.addEventListener('pointercancel', drag.cancel);
      window.addEventListener('blur', drag.cancel);
      this.pane.setPointerCapture?.(event.pointerId);
    }

    updateWordDrag(event) {
      const drag = this.wordDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!this.options.getSegments('main').includes(drag.segment)) { this.cancelWordDrag(); return; }
      if (!drag.moved && Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < 3) return;
      event.preventDefault();
      drag.moved = true;
      const row = this.findVisibleWaveformRowAtPoint(event.clientX, event.clientY);
      const target = drag.timing.fromMs(row ? this.pointerTimeMs(event, row)
        : this.pointerTimeMs(event, drag.row, drag.geometry, true));
      const linked = drag.seam ? !event.altKey : !this.isSharedBoundaryHandleIndependent(event.altKey);
      const items = window.AsrEditorUtils.editWordTiming(drag.original, drag.indices,
        drag.resize ? { kind: 'resize', edge: drag.edge, target, linked }
          : { kind: 'move', delta: target - drag.pointer }, drag.timing);
      if (!items) return;
      drag.command ||= this.options.beginWordEdit();
      this.options.wordTiming.previewItems(drag.segment, items);
      this.wordRefreshFrame ||= requestAnimationFrame(() => {
        this.wordRefreshFrame = 0;
        this.refreshWordBlocks();
      });
    }

    detachWordDrag(drag) {
      cancelAnimationFrame(this.wordRefreshFrame);
      this.wordRefreshFrame = 0;
      window.removeEventListener('pointermove', drag.move);
      window.removeEventListener('pointerup', drag.up);
      window.removeEventListener('pointercancel', drag.cancel);
      window.removeEventListener('blur', drag.cancel);
      if (this.pane.hasPointerCapture?.(drag.pointerId)) this.pane.releasePointerCapture(drag.pointerId);
      this.wordDrag = null;
    }

    endWordDrag(event) {
      const drag = this.wordDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.moved) this.updateWordDrag(event);
      this.detachWordDrag(drag);
      if (!drag.command || !this.options.commitWordEdit(drag.command, drag.segment)) this.refreshWordBlocks();
    }

    cancelWordDrag() {
      const drag = this.wordDrag;
      if (!drag) return;
      this.detachWordDrag(drag);
      if (drag.command) drag.command.cancel();
      this.options.wordTiming.clearSelection();
      this.refreshCueOverlay();
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WordMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
});
