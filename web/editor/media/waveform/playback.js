// playback: waveform class methods with explicit dependencies.
window.MAWE.register('waveform-playback', function createWaveformModule(dependencies) {
  'use strict';
  const { ROW_GAP, clamp, findActiveCueIndex, isActiveCueVisualHit, isMultiRowInComfortZone, restoreWaveformTopEdgeMs, waveformTopEdgeMs } = dependencies;

  class WaveformMethods {


    updatePlayback(allowFollow = true) {
      if (!this.payload) return;
      const now = this.currentTimeMs();
      const segments = this.options.getSegments('main');
      const activeIndex = findActiveCueIndex(segments, now);
      const activeVisualHit = activeIndex >= 0 && isActiveCueVisualHit(segments, activeIndex, now);
      if (activeIndex !== this.activeIndex || activeVisualHit !== this.activeVisualHit) {
        this.activeIndex = activeIndex;
        this.activeVisualHit = activeVisualHit;
        this.content.querySelectorAll('.waveform-cue-block[data-track="main"]').forEach((block) => {
          block.classList.toggle('active', Number(block.dataset.idx) === activeIndex && activeVisualHit);
        });
      }
      const extensionSegments = this.options.getExtensionSegments?.() || [];
      const activeExtensionIndex = findActiveCueIndex(extensionSegments, now);
      const activeExtensionVisualHit = activeExtensionIndex >= 0
        && isActiveCueVisualHit(extensionSegments, activeExtensionIndex, now);
      if (activeExtensionIndex !== this.activeExtensionIndex
          || activeExtensionVisualHit !== this.activeExtensionVisualHit) {
        this.activeExtensionIndex = activeExtensionIndex;
        this.activeExtensionVisualHit = activeExtensionVisualHit;
        this.content.querySelectorAll('.waveform-cue-block[data-track="extension"]')
          .forEach((block) => {
            block.classList.toggle('active', Number(block.dataset.extIdx) === activeExtensionIndex && activeExtensionVisualHit);
          });
      }
      const overlaySegments = this.options.getSegments('overlay') || [];
      const activeOverlayIndex = findActiveCueIndex(overlaySegments, now);
      const activeOverlayVisualHit = activeOverlayIndex >= 0
        && isActiveCueVisualHit(overlaySegments, activeOverlayIndex, now);
      if (activeOverlayIndex !== this.activeOverlayIndex
          || activeOverlayVisualHit !== this.activeOverlayVisualHit) {
        this.activeOverlayIndex = activeOverlayIndex;
        this.activeOverlayVisualHit = activeOverlayVisualHit;
        this.content.querySelectorAll('.waveform-cue-block[data-track="overlay"]')
          .forEach((block) => {
            block.classList.toggle('active', Number(block.dataset.overlayIdx) === activeOverlayIndex && activeOverlayVisualHit);
          });
      }

      if (allowFollow && this.settings.mode === 'basic' && !this.navigationRestoring) {
        const windowMs = this.settings.visibleSeconds * 1000;
        const relative = (now - this.basicWindowStartMs) / Math.max(1, windowMs);
        if (now < this.basicWindowStartMs || now > this.basicWindowStartMs + windowMs ||
            (this.player && !this.player.paused && Date.now() > this.manualFollowUntil && (relative < 0.2 || relative > 0.8))) {
          this.centerBasicOnCurrentTime();
          this.renderBasic();
          return;
        }
      }

      if (allowFollow && this.isMultiMode() && !this.navigationRestoring
          && this.player && !this.player.paused && Date.now() > this.manualFollowUntil) {
        const rowIndex = Math.floor(now / (this.settings.secondsPerRow * 1000));
        const shouldCheckFollow = this.multiFollowCheckPending || rowIndex !== this.multiFollowRowIndex;
        if (!shouldCheckFollow) {
          this.positionPlayheads();
          return;
        }
        this.multiFollowRowIndex = rowIndex;
        this.multiFollowCheckPending = false;
        const viewportHeight = this.scroll.clientHeight;
        const rowInComfortZone = viewportHeight > 0 && isMultiRowInComfortZone(
          rowIndex, this.scroll.scrollTop, viewportHeight, this.settings.rowHeight,
        );
        const stride = this.settings.rowHeight + ROW_GAP;
        const targetScrollTop = clamp(
          rowIndex * stride - viewportHeight * 0.35,
          0,
          Math.max(0, this.scroll.scrollHeight - viewportHeight),
        );
        const currentScrollTop = this.scroll.scrollTop;
        const targetChanged = this.autoScrollTarget === null
          || Math.abs(targetScrollTop - this.autoScrollTarget) > 0.5;
        const needsScroll = Math.abs(targetScrollTop - currentScrollTop) > 0.5;
        if (!rowInComfortZone && needsScroll && targetChanged) {
          this.autoScrolling = true;
          this.autoScrollTarget = targetScrollTop;
          this.scroll.scrollTo({
            top: targetScrollTop,
            behavior: 'smooth',
          });
          requestAnimationFrame(() => { this.autoScrolling = false; });
          // 滚动事件会在新的可视范围稳定后增量补行；播放热路径不应在
          // 每次跨行时强制重建当前整组 DOM/Canvas。
          this.scheduleMultiVisible();
        }
        if (!needsScroll) this.autoScrollTarget = null;
      }
      this.positionPlayheads();
    }


    getNavigationSnapshot() {
      return {
        cueListScrollTop: Math.max(0, Math.round(Number(this.cues?.scrollTop) || 0)),
        waveformTopEdgeMs: waveformTopEdgeMs({
          mode: this.settings.mode,
          basicWindowStartMs: this.basicWindowStartMs,
          scrollTop: this.scroll?.scrollTop,
          rowHeight: this.settings.rowHeight,
          rowGap: ROW_GAP,
          secondsPerRow: this.settings.secondsPerRow,
        }),
      };
    }


    restoreNavigation(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return false;
      if (!this.payload) {
        this.pendingNavigation = snapshot;
        if (typeof snapshot.cueListScrollTop === 'number' && Number.isFinite(snapshot.cueListScrollTop)) {
          const maxTop = Math.max(0, this.cues.scrollHeight - this.cues.clientHeight);
          this.cues.scrollTop = clamp(Math.round(snapshot.cueListScrollTop), 0, maxTop);
        }
        return true;
      }
      const topEdgeMs = restoreWaveformTopEdgeMs({
        mode: this.settings.mode,
        durationMs: this.durationMs,
        visibleSeconds: this.settings.visibleSeconds,
        secondsPerRow: this.settings.secondsPerRow,
      }, snapshot.waveformTopEdgeMs);
      this.navigationRestoring = true;
      if (topEdgeMs !== null) {
        if (this.settings.mode === 'basic') {
          this.basicWindowStartMs = topEdgeMs;
          this.renderBasic();
        } else {
          const rowDurationMs = Math.max(1, this.settings.secondsPerRow * 1000);
          const stride = this.settings.rowHeight + ROW_GAP;
          const rowTop = Math.floor(topEdgeMs / rowDurationMs) * stride;
          const maxTop = Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight);
          this.scroll.scrollTop = clamp(rowTop, 0, maxTop);
          this.renderMultiVisible();
        }
      }
      if (typeof snapshot.cueListScrollTop === 'number' && Number.isFinite(snapshot.cueListScrollTop)) {
        const maxTop = Math.max(0, this.cues.scrollHeight - this.cues.clientHeight);
        this.cues.scrollTop = clamp(Math.round(snapshot.cueListScrollTop), 0, maxTop);
      }
      this.manualFollowUntil = Date.now() + 5000;
      this.autoScrolling = false;
      this.autoScrollTarget = null;
      requestAnimationFrame(() => { this.navigationRestoring = false; });
      return topEdgeMs !== null || typeof snapshot.cueListScrollTop === 'number';
    }


    positionPlayheads() {
      const now = this.currentTimeMs();
      this.renderedRows.forEach((row) => {
        const startMs = Number(row.dataset.startMs);
        const endMs = Number(row.dataset.endMs);
        const playhead = row._waveformPlayhead || row.querySelector('.waveform-playhead');
        if (!playhead) return;
        const visible = now >= startMs && now <= endMs;
        playhead.hidden = !visible;
        if (visible) playhead.style.left = `${((now - startMs) / Math.max(1, endMs - startMs)) * 100}%`;
      });
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
});
