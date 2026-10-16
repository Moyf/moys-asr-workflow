export function createWordBlocks(dependencies) {
  'use strict';
  const { colorForSegment, firstCueIndexOverlapping, resolveTiming, localizedWaveformMessage } = dependencies;
  // 全文预览气泡（仅基础模式单行 + 字词码全条带）的密度控制旋钮：
  // 同屏 chip 硬上限与最多向上叠的行数；超限按优先级丢弃。
  // 上限评估（账本 #29）：canvas 同 pass 绘制 64 个 chip ~1-2ms，相对整行
  // 重绘是零头；密度实际由「3 行 + 水平不重叠」自限，64 只是防病态保险丝。
  const WORD_CHIP_MAX_COUNT = 64;
  const WORD_CHIP_MAX_ROWS = 3;
  const WORD_CHIP_HEIGHT = 16;
  const WORD_CHIP_PAD_X = 6;      // chip 内左右留白
  const WORD_CHIP_GAP_X = 4;      // chip 之间与行边缘的水平最小间距
  const WORD_CHIP_ROW_GAP = 2;    // 相邻两行 chip 的垂直间距
  const WORD_CHIP_STRIP_GAP = 6;  // 最底层 chip 行与字词条带顶部的间距（紧贴难看，账本 #29）
  // 每帧重复的 measureText 消除：(font\0text) → 宽度。字号/字体随行样式变化，
  // 所以 key 必须带 font；超长文本兜底裁剪不依赖这里的精确值，脏了也只是宽度误差。
  const wordChipMeasureCache = new Map();
  const WORD_CHIP_MEASURE_CACHE_LIMIT = 4096;

  // 气泡文字测量缓存：drawWordChips 每帧对同批字词重复 measureText，这里按
  // (font, text) 记忆宽度。字词被编辑后旧 key 自然失配淘汰；超限整表清空，
  // 避免长会话缓慢膨胀（宽度本身可随时重测，无正确性风险）。
  function measureWordChipText(ctx, text, font) {
    const key = `${font}\u0000${text}`;
    let width = wordChipMeasureCache.get(key);
    if (width === undefined) {
      width = ctx.measureText(text).width;
      if (wordChipMeasureCache.size >= WORD_CHIP_MEASURE_CACHE_LIMIT) wordChipMeasureCache.clear();
      wordChipMeasureCache.set(key, width);
    }
    return width;
  }

  // 圆角矩形路径（canvas.roundRect 在旧 webview 上不可用，手写 arcTo 兜底）。
  function traceChipRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }

  class WordMethods {
    /** @this {import('./waveform-types.js').WaveformInstance} */
    appendWordBlocks(row, index, startMs, endMs) {
      if (!this.options.wordTiming?.enabled) return;
      const segment = this.options.getSegments('main')[index];
      if (!segment || this.isSegmentHiddenForDisplay(segment)) return;
      const timing = resolveTiming(this.options.getCueTiming?.());
      const entries = window.AsrEditorUtils.getWordTimingEntries(segment, timing);
      const selection = this.options.wordTiming.getSelection(segment);
      // 与整句块采用相同分层条件，确保字词与整句的操作区域不重叠。
      const fullLane = this.options.multiSubtitleVisible?.() !== true
        && (this.settings.mode === 'basic'
          || (this.settings.mode === 'multi' && (Number(this.settings.rowHeight) || 0) >= 96));
      entries.forEach(entry => {
        const range = { start: timing.toMs(entry.start), end: timing.toMs(entry.end) };
        if (range.end <= startMs || range.start >= endMs) return;
        const block = document.createElement('div');
        block.className = `waveform-word-block ${fullLane ? 'word-timing-full' : 'word-timing-compact'}`;
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
          this.appendWordHandle(block, 'left');
        }
        if (range.end <= endMs) {
          this.appendWordHandle(block, 'right');
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
        zone.className = `waveform-word-boundary ${fullLane ? 'word-timing-full' : 'word-timing-compact'}`;
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
    appendWordHandle(block, side) {
      const handle = document.createElement('span');
      handle.className = `waveform-cue-handle ${side}`;
      handle.title = side === 'left'
        ? localizedWaveformMessage('调整字词起点', 'Adjust timed text start')
        : localizedWaveformMessage('调整字词终点', 'Adjust timed text end');
      block.append(handle);
      return handle;
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
      this.refreshWordChips();
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
        this.refreshWordChips();
        return;
      }
      updates.forEach(({ row, startMs, endMs, blockUpdates, zoneUpdates }) => {
        blockUpdates.forEach(({ block, range }) => this.layoutBlock(block, range, startMs, endMs, row));
        zoneUpdates.forEach(({ zone, left }) => { zone.style.left = left; });
      });
      if (updates.length) this.refreshWordChips();
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


    // 全文预览气泡：与波形同 pass 画进行 canvas（零额外 DOM，随窗口重绘）。
    // chip 纯展示——canvas 本身 pointer-events:none，命中始终落在下层块上；
    // 块的原生 title 保持不变。字块 DOM 变化后通过 refreshWordChips 重绘。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    drawWordChips(row, ctx, width, height, startMs, endMs) {
      if (!this.options.wordTiming?.enabled) return;
      if (this.settings.mode !== 'basic' || row.dataset.basic !== 'true') return;
      if (row.classList.contains('multi-subtitle-row')) return;
      const blocks = /** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll('.waveform-word-block.word-timing-full'));
      if (!blocks.length) return;
      // 条带几何读第一个可见块的 computed style：bottom/height 是解析后的
      // px，自动跟随 CSS 中 `calc(9px + max(35px, min(72px, 40%)))` 的变化。
      // hidden 块 display:none，computed bottom/height 不可用，必须跳过。
      let sample = null;
      for (const block of blocks) {
        if (!block.hidden) { sample = block; break; }
      }
      if (!sample) return;
      const stripStyle = getComputedStyle(sample);
      const stripBottom = Number.parseFloat(stripStyle.bottom);
      const stripHeight = Number.parseFloat(stripStyle.height);
      if (!Number.isFinite(stripBottom) || !Number.isFinite(stripHeight)) return;
      const label = sample.querySelector('.waveform-word-label');
      const labelStyle = label ? getComputedStyle(label) : null;
      ctx.font = labelStyle
        ? `${labelStyle.fontStyle} ${labelStyle.fontWeight} ${labelStyle.fontSize} ${labelStyle.fontFamily}`.trim()
        : '11px sans-serif';
      const rangeMs = Math.max(1, endMs - startMs);
      const now = this.currentTimeMs();
      // 优先级参考点：播放头在窗口内用播放头 x，否则用窗口中心。
      const referenceX = now >= startMs && now <= endMs
        ? ((now - startMs) / rangeMs) * width
        : width / 2;
      const items = [];
      blocks.forEach((block, order) => {
        if (block.hidden) return;
        const text = (block.querySelector('.waveform-word-label')?.textContent || '').trim();
        if (!text) return;
        const leftPct = Number.parseFloat(block.style.left);
        const widthPct = Number.parseFloat(block.style.width);
        if (!Number.isFinite(leftPct) || !Number.isFinite(widthPct)) return;
        items.push({
          text,
          textWidth: measureWordChipText(ctx, text, ctx.font),
          leftPx: (leftPct / 100) * width,
          widthPx: Math.max(1, (widthPct / 100) * width),
          order,
          isPlaying: now >= startMs + (leftPct / 100) * rangeMs
            && now < startMs + ((leftPct + widthPct) / 100) * rangeMs,
        });
      });
      if (!items.length) return;
      const colors = this._getWaveColors();
      const { placed } = this.computeWordChipLayout(items, {
        rowWidth: width,
        rowHeight: height,
        stripTopPx: stripBottom + stripHeight,
        referenceX,
      });
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (const chip of placed) {
        traceChipRect(ctx, chip.x, chip.y, chip.chipWidth, WORD_CHIP_HEIGHT, 4);
        ctx.fillStyle = colors.chipBg;
        ctx.fill();
        ctx.strokeStyle = colors.chipFg;
        ctx.globalAlpha = 0.28;
        ctx.stroke();
        ctx.globalAlpha = 1;
        // 超长文本兜底：chip 被钳到行宽内，文字用裁剪避免画出圆角外。
        ctx.save();
        ctx.beginPath();
        ctx.rect(chip.x + WORD_CHIP_PAD_X - 1, chip.y,
          Math.max(0, chip.chipWidth - WORD_CHIP_PAD_X * 2 + 2), WORD_CHIP_HEIGHT);
        ctx.clip();
        ctx.fillStyle = colors.chipFg;
        ctx.fillText(chip.text, chip.x + WORD_CHIP_PAD_X, chip.y + WORD_CHIP_HEIGHT / 2 + 0.5);
        ctx.restore();
      }
    }


    /**
     * 纯函数（不读 this，供单测直调）：把已测量的字词块信息变成气泡布局。
     * 决策分三步：候选 = 全部可见字词块（不做文本截断过滤，账本 #29——
     * 显示就都显示，密度交给上限与行堆叠）→ 优先级排序（当前播放字 >
     * 距参考点近 > 行序稳定）→ 同屏上限截断 → 自下向上找第一个水平
     * 不重叠的行（行数受 maxRows 与行内剩余空间双重限制）。
     * 坐标约定：leftPx/widthPx/referenceX 以行左缘为原点；stripTopPx 是
     * 条带顶边到行底边的距离；返回 y 为 chip 顶边的画布 y（原点行顶）。
     * @this {void}
     * @param {Array<{text: string, textWidth: number, leftPx: number, widthPx: number, isPlaying?: boolean, centerX?: number, order?: number}>} blocks
     * @param {{rowWidth: number, rowHeight: number, stripTopPx: number, referenceX?: number, chipHeight?: number, padX?: number, gapX?: number, rowGap?: number, stripGap?: number, maxCount?: number, maxRows?: number}} options
     */
    computeWordChipLayout(blocks, options) {
      const {
        rowWidth, rowHeight, stripTopPx, referenceX = rowWidth / 2,
        chipHeight = WORD_CHIP_HEIGHT, padX = WORD_CHIP_PAD_X, gapX = WORD_CHIP_GAP_X,
        rowGap = WORD_CHIP_ROW_GAP, stripGap = WORD_CHIP_STRIP_GAP,
        maxCount = WORD_CHIP_MAX_COUNT,
        maxRows = WORD_CHIP_MAX_ROWS,
      } = options || {};
      const placed = [];
      let dropped = 0;
      if (!Array.isArray(blocks) || !blocks.length
        || !Number.isFinite(rowWidth) || rowWidth <= 0
        || !Number.isFinite(rowHeight) || rowHeight <= 0) {
        return { placed, dropped };
      }
      const candidates = [];
      blocks.forEach((block, index) => {
        const centerX = Number.isFinite(block.centerX)
          ? block.centerX : block.leftPx + block.widthPx / 2;
        const chipWidth = Math.min(block.textWidth + padX * 2,
          Math.max(padX * 2 + 8, rowWidth - gapX * 2));
        const x = Math.round(Math.min(
          Math.max(centerX - chipWidth / 2, gapX),
          Math.max(gapX, rowWidth - chipWidth - gapX),
        ));
        candidates.push({
          text: block.text, chipWidth, x, order: block.order ?? index,
          isPlaying: block.isPlaying === true,
          distance: Math.abs(centerX - referenceX),
        });
      });
      // order 作最终并列决胜，排序本身也稳定：滚动时同距块不会互换，气泡不闪。
      candidates.sort((a, b) => Number(b.isPlaying) - Number(a.isPlaying)
        || a.distance - b.distance || a.order - b.order);
      const picked = candidates.slice(0, Math.max(0, maxCount));
      dropped = candidates.length - picked.length;
      // 行高受行内剩余空间限制：条带上方放不下一整行 chip 时少叠一层。
      const rowPitch = chipHeight + rowGap;
      const usableRows = Math.max(0, Math.min(
        maxRows,
        Math.floor((rowHeight - stripTopPx - stripGap + rowGap) / rowPitch),
      ));
      const rowIntervals = Array.from({ length: usableRows }, () => []);
      for (const chip of picked) {
        const from = chip.x - gapX / 2;
        const to = chip.x + chip.chipWidth + gapX / 2;
        const targetRow = rowIntervals.findIndex(intervals =>
          !intervals.some(([lo, hi]) => from < hi && to > lo));
        if (targetRow < 0) { dropped += 1; continue; }
        rowIntervals[targetRow].push([from, to]);
        // chip 顶边到行底边的距离：首行与条带留 stripGap 间距，其后逐行向上。
        const topFromBottom = stripTopPx + stripGap + targetRow * rowPitch + chipHeight;
        placed.push({
          text: chip.text, x: chip.x, chipWidth: chip.chipWidth,
          y: Math.round(rowHeight - topFromBottom), row: targetRow, order: chip.order,
        });
      }
      placed.sort((a, b) => a.y - b.y || a.x - b.x || a.order - b.order);
      return { placed, dropped };
    }


    // 字块 DOM 变化（编辑、拖动提交、选区驱动的整层重建）后重绘基础行
    // canvas，让气泡层与块几何保持同步；measure:false 复用缓存尺寸与包络。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    refreshWordChips() {
      if (!this.options.wordTiming?.enabled || this.settings.mode !== 'basic') return;
      const row = this.renderedRows[0];
      if (!row || row.dataset.basic !== 'true') return;
      this.drawRow(row, { measure: false });
    }


    // 滚轮平移期的字词层原位重排（账本 #22 批次 2）：已有块/中缝按新窗口
    // 重算 left/width/hidden，不重建 DOM。oldWindow 用于找回仍挂在行上、
    // 但已滑出新窗口的块（原位隐藏而非判为结构变化）。
    /** @this {import('./waveform-types.js').WaveformInstance}
     * @param {HTMLElement} row */
    relayoutWordBlocksInRow(row, startMs, endMs, oldStartMs = startMs, oldEndMs = endMs) {
      if (!this.options.wordTiming?.enabled) return true;
      const segments = this.options.getSegments('main');
      const timing = resolveTiming(this.options.getCueTiming?.());
      const unionStart = Math.min(startMs, oldStartMs);
      const unionEnd = Math.max(endMs, oldEndMs);
      const dual = this.options.getAdjacentBoundaryMode?.() === 'dual';
      const entriesByIndex = new Map();
      for (let index = firstCueIndexOverlapping(segments, unionStart); index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment.start >= unionEnd) break;
        if (segment.end <= unionStart) continue;
        if (this.isSegmentHiddenForDisplay(segment)) continue;
        entriesByIndex.set(index, window.AsrEditorUtils.getWordTimingEntries(segment, timing));
      }
      const blocks = [.../** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll('.waveform-word-block'))];
      for (const block of blocks) {
        const index = Number(block.dataset.segmentIdx);
        let entries = entriesByIndex.get(index);
        if (!entries) {
          // 块所属句在并集窗外（新建后立即平移等罕见时序）：按句现算，
          // 句消失/隐藏才视为结构变化。
          const segment = segments[index];
          if (!segment || this.isSegmentHiddenForDisplay(segment)) return false;
          entries = window.AsrEditorUtils.getWordTimingEntries(segment, timing);
          entriesByIndex.set(index, entries);
        }
        const entry = entries.find(candidate => candidate.index === Number(block.dataset.itemIdx));
        if (!entry) return false;
        const range = { start: timing.toMs(entry.start), end: timing.toMs(entry.end) };
        // 手柄是可原位增删的 span（无独立监听器，命中经块级 pointerdown 的
        // closest 解析）；条目跨越窗口边界时原位增删，避免回退整层重建。
        if (range.start >= startMs && !block.querySelector('.waveform-cue-handle.left')) {
          this.appendWordHandle(block, 'left');
        }
        if (range.end <= endMs && !block.querySelector('.waveform-cue-handle.right')) {
          this.appendWordHandle(block, 'right');
        }
        if (range.start < startMs) block.querySelector('.waveform-cue-handle.left')?.remove();
        if (range.end > endMs) block.querySelector('.waveform-cue-handle.right')?.remove();
        this.layoutBlock(block, range, startMs, endMs, row);
      }
      // 新窗口内的每个条目都必须已有 DOM 块；缺失 → 结构变化。
      for (const [index, entries] of entriesByIndex) {
        for (const entry of entries) {
          const entryStart = timing.toMs(entry.start);
          const entryEnd = timing.toMs(entry.end);
          if (entryEnd <= startMs || entryStart >= endMs) continue;
          if (!blocks.some(block => Number(block.dataset.segmentIdx) === index
            && Number(block.dataset.itemIdx) === entry.index)) {
            return false;
          }
        }
      }
      // 中缝原位重排；贴合关系变化（结构性）交由整层重建处理。
      if (dual) {
        const zones = [.../** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll('.waveform-word-boundary'))];
        for (const zone of zones) {
          const index = Number(zone.dataset.segmentIdx);
          if (!entriesByIndex.has(index)) {
            const segment = segments[index];
            if (!segment || this.isSegmentHiddenForDisplay(segment)) return false;
            entriesByIndex.set(index, window.AsrEditorUtils.getWordTimingEntries(segment, timing));
          }
          const entries = entriesByIndex.get(index) || [];
          const left = entries.find(candidate => candidate.index === Number(zone.dataset.leftIdx));
          const position = left ? entries.indexOf(left) : -1;
          const right = position >= 0 ? entries[position + 1] : null;
          if (!left || !right || left.end !== right.start) return false;
          const seamMs = timing.toMs(left.end);
          const visible = seamMs > startMs && seamMs <= endMs;
          zone.hidden = !visible;
          if (visible) {
            zone.style.left = `${((seamMs - startMs) / Math.max(1, endMs - startMs)) * 100}%`;
          }
        }
      }
      return true;
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WordMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
}
