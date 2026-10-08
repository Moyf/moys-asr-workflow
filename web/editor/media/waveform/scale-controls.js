// scale-controls: waveform class methods with explicit dependencies.
window.MAWE.register('waveform-scale-controls', function createWaveformModule(dependencies) {
  'use strict';
  const { LOUDNESS_SCHEMA, ROW_GAP, ROW_HEIGHT_PRESETS, WAVEFORM_ADJUST_DEBOUNCE_MS, ZOOM_PRESETS, clamp, isMultiRowInComfortZone, localizedWaveformMessage, saveSettings, syncSpectralColorToggle, waveformScaleAfterStep, waveformScaleFromLoudness } = dependencies;

  class WaveformMethods {


    focusWaveform() {
      this.pane.focus({ preventScroll: true });
    }


    changeWaveformScale(direction) {
      if (this.scaleDebounceTimer) {
        window.clearTimeout(this.scaleDebounceTimer);
        this.scaleDebounceTimer = 0;
        this.pendingScaleDirection = 0;
      }
      this.applyWaveformScaleSteps(Math.sign(direction));
    }


    applyWaveformScaleSteps(steps) {
      const current = this.settings.waveformScale;
      const numericSteps = Math.trunc(Number(steps));
      if (!numericSteps) return;
      const stepDirection = numericSteps > 0 ? 1 : -1;
      let next = current;
      for (let index = 0; index < Math.abs(numericSteps); index += 1) {
        const candidate = waveformScaleAfterStep(next, stepDirection);
        if (candidate === next) break;
        next = candidate;
      }
      if (next === current) {
        // 已到边界：减不下去/加不上去，通知编辑器给出提示
        document.dispatchEvent(new CustomEvent('asr:waveform-scale-limit', {
          detail: { atMin: stepDirection < 0, atMax: stepDirection > 0 },
        }));
        return;
      }
      this.settings.waveformScale = next;
      // 用户亲自动了振幅 → 本工程退出自动，响度端点之后不再覆盖它。
      this.settings.waveformScaleAuto = false;
      saveSettings(this.settings);
      this.renderWaveformScaleLabel();
      // peak 包络按行缓存；连续滚轮由上层 debounce 合并后，这里只清晰重绘一次。
      this.redrawWaveformCanvases();
    }


    renderWaveformScaleLabel() {
      if (!this.waveformScaleLabel) return;
      const value = `×${parseFloat(Number(this.settings.waveformScale).toFixed(2))}`;
      this.waveformScaleLabel.textContent = this.settings.waveformScaleAuto === false
        ? value
        : `${value} ${localizedWaveformMessage('自动', 'auto')}`;
    }


    setLoudnessStats(stats, { render = true } = {}) {
      this.loudnessStats = stats && stats.schema === LOUDNESS_SCHEMA ? stats : null;
      if (!this.loudnessStats) return false;
      // 用户已手调过振幅就绝不覆盖；「按响度适配」按钮会先把这个标志翻回真。
      if (this.settings.waveformScaleAuto === false) return false;
      const fitted = waveformScaleFromLoudness(
        this.loudnessStats,
        this.settings.rowHeight,
      );
      if (fitted === null) return false;
      this.settings.waveformScale = fitted;
      // 自动值刻意不写 saveSettings()：localStorage 里的振幅是浏览器全局偏好，
      // 为当前素材拟合的值不该污染下一个工程。
      this.renderWaveformScaleLabel();
      if (render) this.redrawWaveformCanvases();
      return true;
    }


    fitWaveformScaleToLoudness() {
      const previous = this.settings.waveformScaleAuto;
      this.settings.waveformScaleAuto = true;
      if (this.setLoudnessStats(this.loudnessStats)) {
        this.setStatus(localizedWaveformMessage(
          `已按响度适配振幅 ×${parseFloat(Number(this.settings.waveformScale).toFixed(2))}`,
          `Amplitude fitted to loudness ×${parseFloat(Number(this.settings.waveformScale).toFixed(2))}`,
        ));
        return true;
      }
      // 拟不出来就把标志还原，别让标签谎称「自动」却显示着手调值。
      this.settings.waveformScaleAuto = previous;
      document.dispatchEvent(new CustomEvent('asr:waveform-loudness-unavailable'));
      return false;
    }


    scheduleWheelScaleChange() {
      if (this.scaleDebounceTimer) window.clearTimeout(this.scaleDebounceTimer);
      this.scaleDebounceTimer = window.setTimeout(() => {
        this.scaleDebounceTimer = 0;
        const steps = this.pendingScaleDirection;
        this.pendingScaleDirection = 0;
        this.applyWaveformScaleSteps(steps);
      }, WAVEFORM_ADJUST_DEBOUNCE_MS);
    }


    scheduleRowHeightChange(direction) {
      this.pendingRowHeightDirection += direction > 0 ? 1 : -1;
      if (this.rowHeightDebounceTimer) window.clearTimeout(this.rowHeightDebounceTimer);
      this.rowHeightDebounceTimer = window.setTimeout(() => {
        this.rowHeightDebounceTimer = 0;
        const steps = this.pendingRowHeightDirection;
        this.pendingRowHeightDirection = 0;
        const current = ROW_HEIGHT_PRESETS.indexOf(this.settings.rowHeight);
        const next = clamp(current + steps, 0, ROW_HEIGHT_PRESETS.length - 1);
        if (next !== current) this.setRowHeight(ROW_HEIGHT_PRESETS[next]);
      }, WAVEFORM_ADJUST_DEBOUNCE_MS);
    }


    updateDisabledVisibility() {
      this.refreshCueOverlay();
    }


    revealTime(timeMs, center = true) {
      if (!this.payload) return;
      this.autoScrolling = false;
      this.autoScrollTarget = null;
      this.multiFollowCheckPending = true;
      if (this.settings.mode === 'basic') {
        const windowMs = this.settings.visibleSeconds * 1000;
        const maxStart = Math.max(0, this.durationMs - windowMs);
        const currentStart = clamp(this.basicWindowStartMs, 0, maxStart);
        const relative = (timeMs - currentStart) / Math.max(1, windowMs);
        const needsScroll = relative < 0.2 || relative > 0.8;
        this.basicWindowStartMs = center && needsScroll
          ? clamp(timeMs - windowMs / 2, 0, maxStart)
          : currentStart;
        this.manualFollowUntil = Date.now() + 3000;
        this.renderBasic();
        return;
      }
      const rowDurationMs = this.settings.secondsPerRow * 1000;
      const rowIndex = clamp(Math.floor(timeMs / rowDurationMs), 0, Math.max(0, Math.ceil(this.durationMs / rowDurationMs) - 1));
      const stride = this.settings.rowHeight + ROW_GAP;
      const currentScrollTop = this.scroll.scrollTop;
      const rowInComfortZone = isMultiRowInComfortZone(
        rowIndex, currentScrollTop, this.scroll.clientHeight, this.settings.rowHeight,
      );
      const scrollTop = center && rowInComfortZone
        ? currentScrollTop
        : (center
          ? rowIndex * stride - Math.max(0, (this.scroll.clientHeight - this.settings.rowHeight) * 0.45)
          : rowIndex * stride);
      const nextScrollTop = Math.max(0, scrollTop);
      this.autoScrolling = Math.abs(nextScrollTop - currentScrollTop) > 0.5;
      if (this.autoScrolling) {
        this.scroll.scrollTo({ top: nextScrollTop, behavior: 'smooth' });
      }
      this.manualFollowUntil = Date.now() + 3000;
      // 目标仍在当前可视行内时，字幕跳转只需要移动播放头；不要因为
      // revealTime() 被调用就重建整组波形 DOM/Canvas。跨行时由滚动事件
      // 或这里的合并任务增量补齐可视行。
      if (rowIndex < this.multiRange[0] || rowIndex > this.multiRange[1] || this.autoScrolling) {
        this.scheduleMultiVisible();
      }
      if (this.autoScrolling) requestAnimationFrame(() => { this.autoScrolling = false; });
    }


    changeZoom(direction) {
      const current = ZOOM_PRESETS.indexOf(this.settings.visibleSeconds);
      const next = clamp(current + direction, 0, ZOOM_PRESETS.length - 1);
      if (next === current) return;
      this.settings.visibleSeconds = ZOOM_PRESETS[next];
      saveSettings(this.settings);
      this.windowLabel.textContent = `${this.settings.visibleSeconds} 秒`;
      this.centerBasicOnCurrentTime();
      if (this.settings.mode === 'basic') this.renderBasic();
    }


    setStatus(message, kind = '') {
      this.status.textContent = message;
      this.status.classList.toggle('error', kind === 'error');
      this.status.classList.toggle('busy', kind === 'busy');
    }


    setSpectralColorStatus(message = '') {
      if (!this.spectralColorStatus) return;
      const visible = Boolean(message);
      this.spectralColorStatus.hidden = !visible;
      this.spectralColorStatus.textContent = visible ? message : '';
    }


    scheduleSpectralColorRender() {
      const toggle = this.spectralColorToggle;
      if (!toggle || !this.spectral) {
        syncSpectralColorToggle(toggle, this.spectral != null, this.settings.spectralColor, this.spectralColorBusy);
        return;
      }
      // Native disabled controls already block normal repeated clicks. Keep a
      // guard as well for synthetic change events and automation code.
      if (this.spectralColorBusy) {
        toggle.checked = this.settings.spectralColor === true;
        return;
      }

      const enabled = toggle.checked === true;
      this.settings.spectralColor = enabled;
      saveSettings(this.settings);
      this.spectralColorBusy = true;
      this.setSpectralColorStatus(localizedWaveformMessage(
        enabled ? '正在应用频谱颜色…' : '正在关闭频谱颜色…',
        enabled ? 'Applying spectral colors…' : 'Removing spectral colors…',
      ));
      syncSpectralColorToggle(toggle, true, enabled, true);

      const token = ++this.spectralColorRenderToken;
      const renderAfterPaint = () => {
        // Let the browser paint the disabled control and live status before
        // the synchronous Canvas redraw occupies the main thread.
        window.setTimeout(() => {
          if (token !== this.spectralColorRenderToken) return;
          try {
            this.render();
          } finally {
            this.spectralColorBusy = false;
            syncSpectralColorToggle(
              toggle,
              this.spectral != null,
              this.settings.spectralColor,
              false,
            );
            this.setSpectralColorStatus();
          }
        }, 0);
      };
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(renderAfterPaint);
      } else {
        window.setTimeout(renderAfterPaint, 0);
      }
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
});
