// render: waveform class methods with explicit dependencies.
export function createWaveformModule(dependencies) {
  'use strict';
  const { MULTI_ROW_BUFFER, ROW_GAP, clamp, computeGroupBadges, formatCompact } = dependencies;

  class WaveformMethods {


    /** @this {import('./waveform-types.js').WaveformInstance} */
    scheduleRender() {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = requestAnimationFrame(() => this.render());
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    scheduleMultiVisible() {
      // 滚动事件一帧内可能触发多次；合并到每帧最多一次可视区渲染
      if (this.multiVisibleFrame) return;
      this.multiVisibleFrame = requestAnimationFrame(() => {
        this.multiVisibleFrame = 0;
        this.renderMultiVisible();
      });
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    scheduleBasicRender() {
      // 高频滚轮逐事件全绘单行波形会卡顿；合并到每帧最多一次
      if (this.basicRenderFrame) return;
      this.basicRenderFrame = requestAnimationFrame(() => {
        this.basicRenderFrame = 0;
        this.renderBasic({ reuseRow: true });
      });
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    scheduleRefreshCueBlocks() {
      // 高回报率指针设备一帧内触发多次 pointermove；合并到每帧最多一次块重排
      if (this.cueRefreshFrame) return;
      this.cueRefreshFrame = requestAnimationFrame(() => {
        this.cueRefreshFrame = 0;
        this.refreshCueBlocks();
      });
    }


    // 画布颜色取自 CSS 令牌，以便跟随暗/亮主题。每次 render() 前刷新缓存。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    _readWaveColors() {
      const styles = getComputedStyle(document.documentElement);
      const get = (name, fallback) => {
        const value = styles.getPropertyValue(name).trim();
        return value || fallback;
      };
      this._waveColors = {
        rowBg: get('--wave-row-bg', '#1d252d'),
        rowBorder: get('--wave-row-border', '#2d3944'),
        rowGrid: get('--wave-row-grid', 'rgba(255, 255, 255, 0.04)'),
        rowTick: get('--wave-row-tick', '#3b4b59'),
        peak: get('--wave-peak', '#65b89a'),
        peakDim: get('--wave-peak-dim', '#83909a'),
        // 全文预览气泡沿用徽章底/字幕文字两个令牌，深浅主题自动翻转。
        chipBg: get('--wave-badge-bg', 'rgba(0, 0, 0, 0.65)'),
        chipFg: get('--wave-cue-text', '#eef6ff'),
      };
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    _getWaveColors() {
      if (!this._waveColors) this._readWaveColors();
      return this._waveColors;
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    render() {
      // 主题切换后令牌值变化：每次全量渲染前刷新画布颜色缓存，供 drawRow 读取。
      this._readWaveColors();
      // 全量渲染可能来自数据变更（工程加载/撤销重做）：徽章缓存作废。
      this.invalidateGroupBadges();
      this.applyLayout();
      if (!this.payload || !this.peaks) {
        this.content.replaceChildren();
        this.renderedRows = [];
        this.empty.classList.remove('hidden');
        return;
      }
      this.empty.classList.add('hidden');
      if (this.layoutDragging) {
        // 布局拖拽中：不做全量重建（每帧 14 个 canvas 重绘会卡顿），
        // 只把已有位图按新尺寸拉伸；松手后由 finish 里的 scheduleRender 恢复清晰
        this.stretchWaveformCanvases();
        return;
      }
      if (this.settings.mode === 'basic') this.renderBasic();
      else this.renderMulti();
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    stretchWaveformCanvases() {
      // 字幕块/空隙块/播放头均为百分比定位，会随行宽自动跟随；
      // 只有 canvas 位图需要按新尺寸临时拉伸
      this.renderedRows.forEach((row) => {
        const canvas = /** @type {HTMLCanvasElement | null} */ (row.querySelector('canvas.waveform-canvas'));
        if (!canvas) return;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
      });
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    redrawWaveformCanvases({ measure = true } = {}) {
      if (!this.payload || !this.peaks) return;
      if (!this.renderedRows.length) {
        this.renderSegments();
        return;
      }
      this.renderedRows.forEach((row) => this.drawRow(row, { measure }));
      this.syncThumbnailView();
      this.updatePlayback(false);
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    renderSegments() {
      if (!this.payload) {
        this.render();
        return;
      }
      if (this.settings.mode === 'basic') this.renderBasic();
      else this.renderMultiVisible(true);
    }


    // 组序号徽章缓存：computeGroupBadges 对全部段全量扫描，曾挂在滚轮
    // 平移热路径上每帧重算。徽章只依赖 color/sticker 分组字段，与时间
    // 无关；缓存按「失效纪元 + 段数组引用 + 长度」命中，任何可能改分组
    // 的路径（refreshCueOverlay/render）先推进纪元，未变数据直接复用。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    invalidateGroupBadges() {
      this._groupBadgesEpoch = (this._groupBadgesEpoch || 0) + 1;
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    computeGroupBadgesCached(segments) {
      const epoch = this._groupBadgesEpoch || 0;
      const cache = this._groupBadgesCache;
      if (cache && cache.epoch === epoch && cache.segments === segments
        && cache.length === segments.length) {
        return cache.badges;
      }
      const badges = computeGroupBadges(segments);
      this._groupBadgesCache = { epoch, segments, length: segments.length, badges };
      return badges;
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    renderBasic({ reuseRow = false } = {}) {
      if (!this.payload) return;
      const windowMs = this.settings.visibleSeconds * 1000;
      const maxStart = Math.max(0, this.durationMs - windowMs);
      this.basicWindowStartMs = clamp(this.basicWindowStartMs, 0, maxStart);
      const endMs = Math.min(this.durationMs, this.basicWindowStartMs + windowMs);
      const groupBadges = this.computeGroupBadgesCached(this.options.getSegments('main'));
      let row = reuseRow && this.renderedRows.length === 1 ? this.renderedRows[0] : null;
      const reused = row?.dataset.basic === 'true'
        && (row._thumbnailShell || row).parentElement === this.content
        && Boolean(row._thumbnailShell) === Boolean(this.thumbnailHeight());
      if (reused) {
        // 在修改覆盖层之前只测量一次；保留 Canvas、行事件和指针节点，
        // 避免滚轮每帧销毁画布并在整行新 DOM 挂载后强制同步布局。
        const rect = row.getBoundingClientRect();
        const pointerGeometry = {
          left: rect.left + row.clientLeft,
          width: Math.max(1, row.clientWidth),
          startMs: this.basicWindowStartMs,
          endMs,
        };
        row._waveformCanvasWidth = Math.max(1, Math.round(rect.width));
        row._waveformCanvasHeight = Math.max(1, Math.round(rect.height));
        row.dataset.startMs = String(this.basicWindowStartMs);
        row.dataset.endMs = String(endMs);
        row.querySelector('.waveform-row-time').textContent = `${formatCompact(this.basicWindowStartMs)} → ${formatCompact(endMs)}`;
        row.querySelectorAll('.waveform-gap-block, .waveform-cue-block, .waveform-cue-badge, .waveform-cue-boundary, .waveform-word-block, .waveform-word-boundary, .waveform-marker-track')
          .forEach(element => element.remove());
        row.classList.remove('waveform-row-has-markers');
        this.appendGapBlocks(row, this.basicWindowStartMs, endMs);
        this.appendCueBlocks(row, this.basicWindowStartMs, endMs, groupBadges);
        this.appendMarkerTrack(row, this.basicWindowStartMs, endMs);
        this.refreshPointerLine(pointerGeometry);
      } else {
        this.content.replaceChildren();
        this.content.style.height = '100%';
        row = this.createRow(this.basicWindowStartMs, endMs, -1, true, groupBadges);
        this.appendTimelineRow(row, true);
      }
      this.renderedRows = [row];
      this.drawRow(row, { measure: !reused });
      this.syncThumbnailView();
      this.updatePlayback(false);
    }


    // 滚轮平移基础波形（账本 #22 批次 2）：不再整行重绘——先把已绘位图
    // 按整数设备像素平移，再只精绘露出的窄条；块层原位重排（结构变化
    // 回退全量）；滚轮停止 ~160ms 后 renderBasic 整行精绘对齐（chip 层、
    // 徽章宽度阈值、画面带 renderKey 全部刷新）。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    panBasicByMs(deltaMs) {
      const windowMs = this.settings.visibleSeconds * 1000;
      const maxStart = Math.max(0, this.durationMs - windowMs);
      const oldStart = clamp(this.basicWindowStartMs, 0, maxStart);
      const newStart = clamp(oldStart + deltaMs, 0, maxStart);
      const appliedMs = newStart - oldStart;
      this.basicWindowStartMs = newStart;
      if (appliedMs === 0) return;
      const row = this.renderedRows[0];
      const canvas = row
        ? /** @type {HTMLCanvasElement | null} */ (row.querySelector('canvas.waveform-canvas'))
        : null;
      const width = row ? Number(row._waveformCanvasWidth) : NaN;
      const height = row ? Number(row._waveformCanvasHeight) : NaN;
      if (this.settings.mode !== 'basic' || !row || row.dataset.basic !== 'true' || !canvas
        || !Number.isFinite(width) || width < 8 || !Number.isFinite(height) || height < 8
        || !this.payload || !this.peaks) {
        this.scheduleBasicRender();
        return;
      }
      const oldEndMs = Math.min(this.durationMs, oldStart + windowMs);
      const oldRangeMs = Math.max(1, oldEndMs - oldStart);
      const endMs = Math.min(this.durationMs, newStart + windowMs);
      // 用旧窗口的真实跨度换算像素位移（媒体尾端窗口会被截短）。
      const shift = Math.round((appliedMs / oldRangeMs) * width);
      if (shift === 0 || Math.abs(shift) >= width) {
        this.scheduleBasicRender();
        return;
      }
      // 布局读取放在写样式之前，避免同帧读写强制回流。
      const rect = row.getBoundingClientRect();
      row.dataset.startMs = String(newStart);
      row.dataset.endMs = String(endMs);
      const timeLabel = row.querySelector('.waveform-row-time');
      if (timeLabel) timeLabel.textContent = `${formatCompact(newStart)} → ${formatCompact(endMs)}`;
      // 块层先原位重排（失败 = 存在无法原位表达的结构差异，如块进出窗口）；
      // 回退 scheduleBasicRender（rAF 合并）走全量重建，与旧路径一致。
      if (!this.relayoutBasicOverlays(row, newStart, endMs, oldStart, oldEndMs)) {
        this.scheduleBasicRender();
        return;
      }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const backShift = Math.round(shift * dpr);
      const ctx = canvas.getContext('2d', { alpha: false });
      // 位图平移在设备像素坐标系进行（整数偏移，不触发重采样插值）。
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (backShift > 0) {
        ctx.drawImage(canvas, backShift, 0, canvas.width - backShift, canvas.height,
          0, 0, canvas.width - backShift, canvas.height);
      } else {
        const back = -backShift;
        ctx.drawImage(canvas, 0, 0, canvas.width - back, canvas.height,
          back, 0, canvas.width - back, canvas.height);
      }
      ctx.restore();
      // 补画露出的窄条；多画 1px 盖住位图平移的取整接缝。
      const stripSpan = Math.min(width, Math.abs(shift) + 1);
      const stripX = shift > 0 ? width - stripSpan : 0;
      this.paintWaveRow(row, ctx, width, height, newStart, endMs, stripX, stripSpan, { withChips: false });
      this.rebuildMarkerTrackForPan(row, newStart, endMs);
      // 评审条目 2：连续平移会不断重置 settle 计时器，若 setView 只在
      // settle 后经 syncThumbnailView 发出，持续滚动超出已缓存画面时将
      // 一直停留在占位格。这里每档把新可见范围交给内部节流（首拍立即
      // + 每 150ms 尾拍收尾）的 setView，取图节奏由节流器保证。
      if (this.thumbnailController?.visible) {
        this.thumbnailController.setView([{ start: newStart, end: endMs, width }], this.durationMs);
      }
      this.panThumbnailStrip(row, shift, newStart, endMs, width);
      this.positionPlayheads();
      this.refreshPointerLine({ left: rect.left + row.clientLeft, width: Math.max(1, row.clientWidth) });
      if (this.basicPanSettleTimer) clearTimeout(this.basicPanSettleTimer);
      this.basicPanSettleTimer = setTimeout(() => {
        this.basicPanSettleTimer = 0;
        if (this.settings.mode !== 'basic' || !this.payload) return;
        this.renderBasic({ reuseRow: true });
      }, 160);
    }


    // 平移期块层轻量重排：字幕/字词/空隙块按新窗口原位重算 left/width/hidden，
    // 不重建 DOM。共享边界区（.waveform-cue-boundary，main+extension 两轨）
    // 复用 refreshBoundaryZones 的原位重定位（贴合关系变化时原地移除，由
    // 下次整层重建恢复）。任一层报告结构性差异（无法原位表达）时返回 false。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    relayoutBasicOverlays(row, startMs, endMs, oldStartMs = startMs, oldEndMs = endMs) {
      if (!this.relayoutCueBlocksInRow(row, startMs, endMs)) return false;
      if (!this.relayoutWordBlocksInRow(row, startMs, endMs, oldStartMs, oldEndMs)) return false;
      if (!this.relayoutGapBlocksInRow(row, startMs, endMs)) this.refreshGapOverlay();
      this.refreshBoundaryZones();
      return true;
    }


    // 标记轨元素按窗口百分比定位，平移期直接按新窗口重建（窗口内标记
    // 通常为 0 至少数个，重建成本远低于字幕/字词层的逐块重排）。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    rebuildMarkerTrackForPan(row, startMs, endMs) {
      row.querySelectorAll('.waveform-marker-track').forEach(element => element.remove());
      row.classList.remove('waveform-row-has-markers');
      this.appendMarkerTrack(row, startMs, endMs);
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    renderMulti() {
      const rowDurationMs = this.settings.secondsPerRow * 1000;
      const rowCount = Math.max(1, Math.ceil(this.durationMs / rowDurationMs));
      this.content.style.height = `${rowCount * (this.getTimelineRowHeight() + ROW_GAP) - ROW_GAP}px`;
      this.multiRange = [-1, -1];
      this.multiFollowCheckPending = true;
      this.renderMultiVisible(true);
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    renderMultiVisible(force = false) {
      if (!this.isMultiMode() || !this.payload) return;
      const rowDurationMs = this.settings.secondsPerRow * 1000;
      const rowCount = Math.max(1, Math.ceil(this.durationMs / rowDurationMs));
      const stride = this.getTimelineRowHeight() + ROW_GAP;
      const first = clamp(Math.floor(this.scroll.scrollTop / stride) - MULTI_ROW_BUFFER, 0, rowCount - 1);
      const last = clamp(Math.ceil((this.scroll.scrollTop + this.scroll.clientHeight) / stride) + MULTI_ROW_BUFFER, 0, rowCount - 1);
      if (!force && first === this.multiRange[0] && last === this.multiRange[1]) {
        this.syncThumbnailView();
        this.updatePlayback(false);
        return;
      }
      this.multiRange = [first, last];
      this.content.style.height = `${rowCount * stride - ROW_GAP}px`;
      const groupBadges = this.computeGroupBadgesCached(this.options.getSegments('main'));
      if (force) {
        // 全量重建：先完成所有 DOM 变更再统一绘制，避免逐行强制同步布局
        this.content.replaceChildren();
        const rows = [];
        for (let index = first; index <= last; index++) {
          rows.push(this.appendTimelineRow(this.createMultiRow(index, rowDurationMs, groupBadges)));
        }
        this.renderedRows = rows;
        for (const row of rows) this.drawRow(row);
        this.syncThumbnailView();
        this.updatePlayback(false);
        return;
      }
      // 增量更新：只移除滚出可视范围的行、只绘制新进入的行；
      // 仍在范围内的行保留原 canvas 不重绘，消除滚动时的整体重建卡顿
      const wanted = new Set();
      for (let index = first; index <= last; index++) wanted.add(String(index));
      const existing = new Set();
      (/** @type {NodeListOf<import('./waveform-types.js').WaveformRow>} */ (this.content.querySelectorAll('.waveform-row'))).forEach((row) => {
        if (wanted.has(row.dataset.rowIndex)) existing.add(row.dataset.rowIndex);
        else (row._thumbnailShell || row).remove();
      });
      const created = [];
      for (let index = first; index <= last; index++) {
        if (existing.has(String(index))) continue;
        created.push(this.appendTimelineRow(this.createMultiRow(index, rowDurationMs, groupBadges)));
      }
      this.renderedRows = [...(/** @type {NodeListOf<import('./waveform-types.js').WaveformRow>} */ (this.content.querySelectorAll('.waveform-row')))];
      for (const row of created) this.drawRow(row);
      this.syncThumbnailView();
      this.updatePlayback(false);
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    createMultiRow(index, rowDurationMs, groupBadges = null) {
      const startMs = index * rowDurationMs;
      const endMs = Math.min(this.durationMs, startMs + rowDurationMs);
      const row = this.createRow(startMs, endMs, index, false, groupBadges);
      row.style.top = `${index * (this.getTimelineRowHeight() + ROW_GAP)}px`;
      row.style.height = `${this.settings.rowHeight}px`;
      // 最后一行只代表媒体剩余的真实时长；缩短容器不会减少采样量，
      // 但能避免把不存在的尾部时间误画成整行波形。
      row.style.right = 'auto';
      row.style.width = `${Math.max(0.01, Math.min(1, (endMs - startMs) / rowDurationMs) * 100)}%`;
      return row;
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
}
