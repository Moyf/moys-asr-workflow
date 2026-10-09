export function createWordBlocks(dependencies) {
  'use strict';
  const { colorForSegment, firstCueIndexOverlapping, resolveTiming, localizedWaveformMessage } = dependencies;
  class WordMethods {
    /** @this {import('./waveform-types.js').WaveformInstance} */
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
        // 供拖动中的就地刷新定位与校验：区块按句隔离、中缝按左侧条目锚定。
        zone.dataset.segmentIdx = String(index);
        zone.dataset.leftIdx = String(left.index);
        zone.style.left = `${(seam - startMs) / Math.max(1, endMs - startMs) * 100}%`;
        zone.title = localizedWaveformMessage('拖动调整贴合字词边界（两侧一起移动）', 'Drag the shared timed text boundary');
        zone.addEventListener('pointerdown', event => this.beginWordDrag(event, index, left.index, row, true));
        row.append(zone);
      });
    }

    /** @this {import('./waveform-types.js').WaveformInstance} */
    refreshWordBlocks() {
      (/** @type {NodeListOf<HTMLElement>} */ (this.content.querySelectorAll('.waveform-row'))).forEach(row => {
        row.querySelectorAll('.waveform-word-block, .waveform-word-boundary').forEach(block => block.remove());
        const start = Number(row.dataset.startMs), end = Number(row.dataset.endMs);
        const segments = this.options.getSegments('main');
        for (let index = firstCueIndexOverlapping(segments, start); index < segments.length; index += 1) {
          if (segments[index].start >= end) break;
          this.appendWordBlocks(row, index, start, end);
        }
      });
    }

    // 拖动中的轻量刷新：editWordTiming 把字词夹在句边界内，拖动不会改变
    // 块所属的行，因此默认只按新时间重排该句既有块（left/width，不删建
    // DOM），与字幕块拖动的 refreshCueBlocks 同款。字词跨行、手柄增删、
    // 中缝贴合状态变化等结构变化回退到该句所在行的局部重建——整体移动
    // （body move）和接缝处的独立 resize 会拆散贴合关系，因此这类拖动
    // 每帧都走局部重建（仍远轻于全量）。
    // 不再每帧 refreshWordBlocks()（删除并重建所有可视行的全部字词块），
    // 那是横向拖动卡顿的根因。
    /** @this {import('./waveform-types.js').WaveformInstance}
     * @param {import('./waveform-types.js').WordDragState} drag */
    previewWordBlocks(drag) {
      const index = this.options.getSegments('main').indexOf(drag.segment);
      if (index < 0) return;
      const timing = drag.timing;
      const entries = window.AsrEditorUtils.getWordTimingEntries(drag.segment, timing);
      const byIndex = new Map(entries.map(entry => [entry.index, entry]));
      const blockSelector = `.waveform-word-block[data-segment-idx="${index}"]`;
      const zoneSelector = `.waveform-word-boundary[data-segment-idx="${index}"]`;
      const displayable = this.options.wordTiming?.enabled
        && !this.isSegmentHiddenForDisplay(drag.segment);
      const dual = this.options.getAdjacentBoundaryMode?.() === 'dual';
      let rebuild = displayable && !entries.length;
      const updates = [];
      for (const row of /** @type {NodeListOf<HTMLElement>} */ (this.content.querySelectorAll('.waveform-row'))) {
        if (rebuild) break;
        const startMs = Number(row.dataset.startMs);
        const endMs = Number(row.dataset.endMs);
        const blocks = [.../** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll(blockSelector))];
        const zones = [.../** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll(zoneSelector))];
        const expected = displayable
          ? entries.filter(entry => timing.toMs(entry.end) > startMs && timing.toMs(entry.start) < endMs)
          : [];
        if (blocks.length !== expected.length) { rebuild = true; break; }
        const blockUpdates = [];
        for (const block of blocks) {
          const entry = byIndex.get(Number(block.dataset.itemIdx));
          if (!entry) { rebuild = true; break; }
          const start = timing.toMs(entry.start);
          const end = timing.toMs(entry.end);
          // 手柄存在性由条目与本行边界的包含关系决定（见 appendWordBlocks），
          // 条目跨过行边界时需要增删手柄，只能局部重建。
          const wantLeft = start >= startMs;
          const wantRight = end <= endMs;
          if (wantLeft !== Boolean(block.querySelector('.waveform-cue-handle.left'))
            || wantRight !== Boolean(block.querySelector('.waveform-cue-handle.right'))) {
            rebuild = true;
            break;
          }
          blockUpdates.push({ block, range: { start, end } });
        }
        if (rebuild) break;
        let expectedZones = 0;
        if (displayable && dual) {
          for (let position = 0; position + 1 < entries.length; position += 1) {
            const left = entries[position];
            if (left.end !== entries[position + 1].start) continue;
            const seamMs = timing.toMs(left.end);
            if (seamMs > startMs && seamMs <= endMs) expectedZones += 1;
          }
        }
        if (zones.length !== expectedZones) { rebuild = true; break; }
        const zoneUpdates = [];
        for (const zone of zones) {
          const left = byIndex.get(Number(zone.dataset.leftIdx));
          const position = left ? entries.indexOf(left) : -1;
          const right = position >= 0 ? entries[position + 1] : null;
          if (!left || !right || left.end !== right.start) { rebuild = true; break; }
          const seamMs = timing.toMs(left.end);
          if (seamMs <= startMs || seamMs > endMs) { rebuild = true; break; }
          zoneUpdates.push({ zone, left: `${(seamMs - startMs) / Math.max(1, endMs - startMs) * 100}%` });
        }
        if (rebuild) break;
        if (blockUpdates.length || zoneUpdates.length) updates.push({ row, startMs, endMs, blockUpdates, zoneUpdates });
      }
      if (rebuild) {
        this.rebuildWordBlocksForSegment(index);
        return;
      }
      updates.forEach(({ row, startMs, endMs, blockUpdates, zoneUpdates }) => {
        blockUpdates.forEach(({ block, range }) => this.layoutBlock(block, range, startMs, endMs, row));
        zoneUpdates.forEach(({ zone, left }) => { zone.style.left = left; });
      });
    }

    // 结构变化时的局部重建：整行重排受影响行（与该句时间范围重叠、或仍残留
    // 该句旧块的行）的字词层，算法与 refreshWordBlocks 相同，保证块/中缝的
    // 文档序与全量重建一致；其余行不动。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    rebuildWordBlocksForSegment(index) {
      const segments = this.options.getSegments('main');
      const segment = segments[index];
      const selector = `.waveform-word-block[data-segment-idx="${index}"], .waveform-word-boundary[data-segment-idx="${index}"]`;
      (/** @type {NodeListOf<HTMLElement>} */ (this.content.querySelectorAll('.waveform-row'))).forEach(row => {
        const startMs = Number(row.dataset.startMs);
        const endMs = Number(row.dataset.endMs);
        const overlaps = Boolean(segment) && segment.end > startMs && segment.start < endMs;
        if (!overlaps && !row.querySelector(selector)) return;
        row.querySelectorAll('.waveform-word-block, .waveform-word-boundary')
          .forEach(element => element.remove());
        for (let i = firstCueIndexOverlapping(segments, startMs); i < segments.length; i += 1) {
          if (segments[i].start >= endMs) break;
          this.appendWordBlocks(row, i, startMs, endMs);
        }
      });
    }

    /** @this {import('./waveform-types.js').WaveformInstance} */
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
      /** @type {import('./waveform-types.js').WordDragState} */
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

    /** @this {import('./waveform-types.js').WaveformInstance} */
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
        // 拖动可能已结束（endWordDrag 会撤销未执行的帧），这里再守一次。
        if (this.wordDrag !== drag) return;
        this.previewWordBlocks(drag);
      });
    }

    /** @this {import('./waveform-types.js').WaveformInstance} */
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

    /** @this {import('./waveform-types.js').WaveformInstance} */
    endWordDrag(event) {
      const drag = this.wordDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.moved) this.updateWordDrag(event);
      this.detachWordDrag(drag);
      if (!drag.command || !this.options.commitWordEdit(drag.command, drag.segment)) this.refreshWordBlocks();
    }

    /** @this {import('./waveform-types.js').WaveformInstance} */
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
}
