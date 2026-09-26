// render: waveform class methods with explicit dependencies.
window.MAWE.register('waveform-render', function createWaveformModule(dependencies) {
  'use strict';
  const { MULTI_ROW_BUFFER, ROW_GAP, clamp, computeGroupBadges } = dependencies;

  class WaveformMethods {


    scheduleRender() {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = requestAnimationFrame(() => this.render());
    }


    scheduleMultiVisible() {
      // 滚动事件一帧内可能触发多次；合并到每帧最多一次可视区渲染
      if (this.multiVisibleFrame) return;
      this.multiVisibleFrame = requestAnimationFrame(() => {
        this.multiVisibleFrame = 0;
        this.renderMultiVisible();
      });
    }


    scheduleBasicRender() {
      // 高频滚轮逐事件全绘单行波形会卡顿；合并到每帧最多一次
      if (this.basicRenderFrame) return;
      this.basicRenderFrame = requestAnimationFrame(() => {
        this.basicRenderFrame = 0;
        this.renderBasic();
      });
    }


    scheduleRefreshCueBlocks() {
      // 高回报率指针设备一帧内触发多次 pointermove；合并到每帧最多一次块重排
      if (this.cueRefreshFrame) return;
      this.cueRefreshFrame = requestAnimationFrame(() => {
        this.cueRefreshFrame = 0;
        this.refreshCueBlocks();
      });
    }


    // 画布颜色取自 CSS 令牌，以便跟随暗/亮主题。每次 render() 前刷新缓存。
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
      };
    }


    _getWaveColors() {
      if (!this._waveColors) this._readWaveColors();
      return this._waveColors;
    }


    render() {
      // 主题切换后令牌值变化：每次全量渲染前刷新画布颜色缓存，供 drawRow 读取。
      this._readWaveColors();
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


    stretchWaveformCanvases() {
      // 字幕块/空隙块/播放头均为百分比定位，会随行宽自动跟随；
      // 只有 canvas 位图需要按新尺寸临时拉伸
      this.renderedRows.forEach((row) => {
        const canvas = row.querySelector('canvas');
        if (!canvas) return;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
      });
    }


    redrawWaveformCanvases({ measure = true } = {}) {
      if (!this.payload || !this.peaks) return;
      if (!this.renderedRows.length) {
        this.renderSegments();
        return;
      }
      this.renderedRows.forEach((row) => this.drawRow(row, { measure }));
      this.updatePlayback(false);
    }


    renderSegments() {
      if (!this.payload) {
        this.render();
        return;
      }
      if (this.settings.mode === 'basic') this.renderBasic();
      else this.renderMultiVisible(true);
    }


    renderBasic() {
      if (!this.payload) return;
      const windowMs = this.settings.visibleSeconds * 1000;
      const maxStart = Math.max(0, this.durationMs - windowMs);
      this.basicWindowStartMs = clamp(this.basicWindowStartMs, 0, maxStart);
      const endMs = Math.min(this.durationMs, this.basicWindowStartMs + windowMs);
      this.content.replaceChildren();
      this.content.style.height = '100%';
      const groupBadges = computeGroupBadges(this.options.getSegments('main'));
      const row = this.createRow(this.basicWindowStartMs, endMs, -1, true, groupBadges);
      this.content.appendChild(row);
      this.renderedRows = [row];
      this.drawRow(row);
      this.updatePlayback(false);
    }


    renderMulti() {
      const rowDurationMs = this.settings.secondsPerRow * 1000;
      const rowCount = Math.max(1, Math.ceil(this.durationMs / rowDurationMs));
      this.content.style.height = `${rowCount * (this.settings.rowHeight + ROW_GAP) - ROW_GAP}px`;
      this.multiRange = [-1, -1];
      this.multiFollowCheckPending = true;
      this.renderMultiVisible(true);
    }


    renderMultiVisible(force = false) {
      if (!this.isMultiMode() || !this.payload) return;
      const rowDurationMs = this.settings.secondsPerRow * 1000;
      const rowCount = Math.max(1, Math.ceil(this.durationMs / rowDurationMs));
      const stride = this.settings.rowHeight + ROW_GAP;
      const first = clamp(Math.floor(this.scroll.scrollTop / stride) - MULTI_ROW_BUFFER, 0, rowCount - 1);
      const last = clamp(Math.ceil((this.scroll.scrollTop + this.scroll.clientHeight) / stride) + MULTI_ROW_BUFFER, 0, rowCount - 1);
      if (!force && first === this.multiRange[0] && last === this.multiRange[1]) {
        this.updatePlayback(false);
        return;
      }
      this.multiRange = [first, last];
      this.content.style.height = `${rowCount * stride - ROW_GAP}px`;
      const groupBadges = computeGroupBadges(this.options.getSegments('main'));
      if (force) {
        // 全量重建：先完成所有 DOM 变更再统一绘制，避免逐行强制同步布局
        this.content.replaceChildren();
        const rows = [];
        for (let index = first; index <= last; index++) {
          rows.push(this.content.appendChild(this.createMultiRow(index, rowDurationMs, groupBadges)));
        }
        this.renderedRows = rows;
        for (const row of rows) this.drawRow(row);
        this.updatePlayback(false);
        return;
      }
      // 增量更新：只移除滚出可视范围的行、只绘制新进入的行；
      // 仍在范围内的行保留原 canvas 不重绘，消除滚动时的整体重建卡顿
      const wanted = new Set();
      for (let index = first; index <= last; index++) wanted.add(String(index));
      const existing = new Set();
      this.content.querySelectorAll('.waveform-row').forEach((row) => {
        if (wanted.has(row.dataset.rowIndex)) existing.add(row.dataset.rowIndex);
        else row.remove();
      });
      const created = [];
      for (let index = first; index <= last; index++) {
        if (existing.has(String(index))) continue;
        created.push(this.content.appendChild(this.createMultiRow(index, rowDurationMs, groupBadges)));
      }
      this.renderedRows = [...this.content.querySelectorAll('.waveform-row')];
      for (const row of created) this.drawRow(row);
      this.updatePlayback(false);
    }


    createMultiRow(index, rowDurationMs, groupBadges = null) {
      const startMs = index * rowDurationMs;
      const endMs = Math.min(this.durationMs, startMs + rowDurationMs);
      const row = this.createRow(startMs, endMs, index, false, groupBadges);
      row.style.top = `${index * (this.settings.rowHeight + ROW_GAP)}px`;
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
});
