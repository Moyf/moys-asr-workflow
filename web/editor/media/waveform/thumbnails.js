// The filmstrip shell adds height without changing subtitle/marker lane geometry.
export function createWaveformModule(dependencies) {
  'use strict';
  const { thumbnailCore, ROW_GAP, localizedWaveformMessage } = dependencies;
  class WaveformMethods {
    /** @this {import('./waveform-types.js').WaveformInstance} */
    initThumbnails() {
      this.thumbnailLayoutHeight = 0;
      this.thumbnailController = thumbnailCore.createController((layoutChanged, dirtyRanges = []) => {
        this.updateThumbnailStatus();
        if (layoutChanged) {
          const oldStride = this.settings.rowHeight + this.thumbnailLayoutHeight + ROW_GAP;
          const anchorRow = this.scroll.scrollTop / Math.max(1, oldStride);
          this.thumbnailLayoutHeight = this.thumbnailHeight();
          cancelAnimationFrame(this.resizeFrame);
          this.resizeFrame = requestAnimationFrame(() => {
            this.render();
            if (this.isMultiMode()) {
              this.scroll.scrollTop = anchorRow * (this.getTimelineRowHeight() + ROW_GAP);
              this.renderMultiVisible();
            }
          });
        } else this.renderedRows.forEach(row => {
          const start = Number(row.dataset.startMs), end = Number(row.dataset.endMs);
          if (dirtyRanges.some(range => range.end_ms > start && range.start_ms < end)) this.drawThumbnails(row, true);
        });
      });
      this.thumbnailPlayListener = () => {
        this.thumbnailController.setPlayhead(this.currentTimeMs());
        this.thumbnailController.setPlaying(!this.player?.paused);
      };
      const toggle = /** @type {HTMLInputElement | null} */ (document.getElementById('waveform-show-thumbnails'));
      if (toggle) {
        toggle.checked = this.thumbnailController.enabled;
        toggle.disabled = !window.MaweBoot?.SERVER_CONFIG?.thumbnailBinding;
        toggle.addEventListener('change', () => this.thumbnailController.setEnabled(toggle.checked));
      }
      document.addEventListener('mawe:languagechange', () => this.updateThumbnailStatus());
      window.addEventListener('online', () => this.thumbnailController.retry());
      window.addEventListener('pagehide', () => this.thumbnailController.close());
      this.setThumbnailBinding(window.MaweBoot?.SERVER_CONFIG?.thumbnailBinding || '');
    }
    /** @this {import('./waveform-types.js').WaveformInstance} */
    thumbnailStatusText() {
      const labels = {
        idle: ['正在准备视频画面', 'Preparing video pictures'],
        queued: ['等待补齐画面', 'Pictures queued'],
        generating: ['正在补齐画面', 'Loading pictures'],
        partial: ['画面逐步补齐', 'Pictures loading progressively'],
        ready: ['画面已就绪', 'Pictures ready'],
        paused: ['播放中：暂停补帧', 'Playing: picture generation paused'],
        unavailable: ['当前媒体没有可用画面', 'No video pictures available for this media'],
        error: ['画面缓存暂不可用', 'Picture cache unavailable'],
        cancelled: ['已取消画面加载', 'Picture loading cancelled'],
        'network-error': ['连接中断；重新显示或网络恢复后重试', 'Connection lost; re-enable pictures or reconnect to retry'],
      };
      const pair = labels[this.thumbnailController.state] || labels.idle;
      let text = localizedWaveformMessage(pair[0], pair[1]);
      if (this.thumbnailController.persisted === false) {
        text += ' · ' + localizedWaveformMessage('本次会话缓存', 'Session cache');
      }
      return text;
    }
    /** @this {import('./waveform-types.js').WaveformInstance} */
    updateThumbnailStatus() {
      const toggle = /** @type {HTMLInputElement | null} */ (document.getElementById('waveform-show-thumbnails'));
      const status = document.getElementById('waveform-thumbnail-status');
      const hasBinding = !!window.MaweBoot?.SERVER_CONFIG?.thumbnailBinding;
      const text = !hasBinding
        ? localizedWaveformMessage('从本机 Server 加载视频后可用', 'Available after loading video through the local Server')
        : !this.thumbnailController.enabled
          ? localizedWaveformMessage('视频画面已隐藏', 'Video pictures hidden')
          : this.thumbnailStatusText();
      if (toggle) {
        toggle.checked = this.thumbnailController.enabled;
        toggle.disabled = !hasBinding || ['unavailable', 'error'].includes(this.thumbnailController.state);
        toggle.parentElement.title = text;
      }
      if (status && status.textContent !== text) status.textContent = text;
      for (const row of this.renderedRows) {
        if (row._thumbnailCanvas) row._thumbnailCanvas.title = text;
      }
    }
    /** @this {import('./waveform-types.js').WaveformInstance} */
    setThumbnailBinding(binding) {
      this.thumbnailController?.setBinding(binding);
    }
    /** @this {import('./waveform-types.js').WaveformInstance} */
    thumbnailHeight() { return this.thumbnailController?.visible ? 48 : 0; }
    /** @this {import('./waveform-types.js').WaveformInstance} */
    getTimelineRowHeight() { return this.settings.rowHeight + this.thumbnailHeight(); }
    /** @this {import('./waveform-types.js').WaveformInstance} */
    wrapThumbnailRow(row, basic) {
      if (!this.thumbnailHeight()) return row;
      const shell = document.createElement('div');
      shell.className = 'waveform-row-shell';
      shell.dataset.rowIndex = row.dataset.rowIndex;
      if (basic) shell.classList.add('waveform-row-shell-basic');
      const canvas = document.createElement('canvas');
      canvas.className = 'waveform-filmstrip';
      canvas.setAttribute('aria-label', '视频画面导航，点击或拖动定位');
      shell.appendChild(canvas); shell.appendChild(row);
      row._thumbnailShell = shell; row._thumbnailCanvas = canvas;
      canvas.addEventListener('pointerdown', event => {
        event.stopPropagation();
        if (event.button !== 0) return;
        event.preventDefault();
        const geometry = this.captureRowGeometry(row);
        if (this.settings.dragPlayhead) this.beginPlayheadDrag(event, row, geometry);
        this.seekFromPointer(event, row, false, geometry);
      });
      canvas.addEventListener('contextmenu', event => event.preventDefault());
      return shell;
    }
    /** @this {import('./waveform-types.js').WaveformInstance} */
    appendTimelineRow(row, basic = false) {
      const shell = this.wrapThumbnailRow(row, basic);
      if (shell !== row && !basic) {
        shell.style.top = row.style.top; shell.style.width = row.style.width;
        shell.style.height = `${this.getTimelineRowHeight()}px`;
        row.style.top = '48px'; row.style.width = '100%';
      }
      if (shell !== row && basic) {
        shell.style.height = `${Math.max(1, this.scroll.clientHeight - 16) + 48}px`;
        row.style.height = `${Math.max(1, this.scroll.clientHeight - 16)}px`;
      }
      this.content.appendChild(shell);
      return row;
    }
    /** @this {import('./waveform-types.js').WaveformInstance} */
    syncThumbnailView() {
      if (!this.thumbnailController?.visible) return;
      const viewport = this.scroll.getBoundingClientRect();
      const rows = this.renderedRows.filter(row => {
        const rect = (row._thumbnailShell || row).getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      }).map(row => ({start:Number(row.dataset.startMs), end:Number(row.dataset.endMs), width:row.clientWidth}));
      this.thumbnailController.setView(rows, this.durationMs);
      for (const row of this.renderedRows) this.drawThumbnails(row);
    }
    /** @this {import('./waveform-types.js').WaveformInstance} */
    drawThumbnails(row, force = false) {
      const canvas = row._thumbnailCanvas;
      if (!canvas || !this.thumbnailController?.visible) return;
      const width = Math.max(1, row.clientWidth), height = 48;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const start = Number(row.dataset.startMs), end = Number(row.dataset.endMs);
      const interval = this.thumbnailController.interval;
      const renderKey = `${width}|${dpr}|${start}|${end}|${interval}`;
      if (!force && row._thumbnailRenderKey === renderKey) return;
      row._thumbnailRenderKey = renderKey;
      canvas.width = Math.round(width * dpr); canvas.height = height * dpr;
      const ctx = canvas.getContext('2d', {alpha:false});
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = this._getWaveColors().rowBg; ctx.fillRect(0, 0, width, height);
      const pxPerMs = width / Math.max(1, end - start);
      const tileWidth = height * 160 / 90;
      for (let time = Math.floor(start / interval) * interval; time < end; time += interval) {
        const left = Math.max(0, (time - start) * pxPerMs);
        const right = Math.min(width, (time + interval - start) * pxPerMs);
        const picture = this.thumbnailController.picture(time, interval * 2);
        if (!picture) {
          ctx.fillStyle = this._getWaveColors().rowBorder;
          ctx.fillRect(left + 1, 1, Math.max(0, right - left - 2), height - 2);
          continue;
        }
        const [sx, sy, sw, sh] = picture.crop;
        // Repeat within each source-zero sampling cell; clip the tail cell to actual media duration.
        ctx.save(); ctx.beginPath(); ctx.rect(left, 0, right - left, height); ctx.clip();
        const cellStart = (time - start) * pxPerMs;
        for (let x = cellStart; x < right; x += tileWidth) {
          ctx.drawImage(picture.image, sx, sy, sw, sh, x, 0, tileWidth, height);
        }
        ctx.restore();
      }
      canvas.title = this.thumbnailStatusText();
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
}
