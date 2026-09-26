// controls: waveform class methods with explicit dependencies.
window.MAWE.register('waveform-controls', function createWaveformModule(dependencies) {
  'use strict';
  const { saveSettings, shouldAdjustAdjacentCuesIndependently, shouldAdjustSharedBoundaryHandleIndependently, syncSpectralColorToggle } = dependencies;

  class WaveformMethods {


    isAdjacentCueAdjustmentIndependent(altKey = false) {
      return shouldAdjustAdjacentCuesIndependently(
        altKey,
        this.options.getAutoSnapAdjacentCues?.() === true,
      );
    }


    // 相接字幕边界手柄命中时的模式判定：dual 模式下手柄始终独立调整
    // （联动由中缝拖动区负责）；classic 模式沿用自动吸附开关 + Alt 反转。
    isSharedBoundaryHandleIndependent(altKey = false) {
      return shouldAdjustSharedBoundaryHandleIndependently(
        altKey,
        this.options.getAutoSnapAdjacentCues?.() === true,
        this.options.getAdjacentBoundaryMode?.(),
      );
    }


    // 共享边界拖动期间，在「共享边界」状态文本旁提示当前的贴合边界模式。
    adjacentSnapModeStatusHint() {
      if (this.options.getAdjacentBoundaryMode?.() === 'dual') {
        return '中缝联动：中缝拖动两侧一起移动，手柄只调整单侧字幕。';
      }
      return this.options.getAutoSnapAdjacentCues?.() === true
        ? '当前为相邻字幕自动吸附模式，按住 Alt 可以临时解除吸附。'
        : '当前未启用相邻字幕自动吸附，按住 Alt 可以临时启用。';
    }


    hasCueDrag() {
      return Boolean(this.drag || this.createCueDrag);
    }


    bindControls() {
      document.querySelectorAll('[data-waveform-mode]').forEach((button) => {
        button.addEventListener('click', () => this.setMode(button.dataset.waveformMode));
      });
      document.querySelectorAll('[data-waveform-tool]').forEach((button) => {
        button.addEventListener('click', () => this.setTool(button.dataset.waveformTool));
      });
      // 初始工具按钮高亮（默认 select）
      document.querySelectorAll('[data-waveform-tool]').forEach((button) => {
        button.classList.toggle('active', button.dataset.waveformTool === this.tool);
      });
      this.pane?.classList.toggle('tool-select', this.tool === 'select');
      this.pane?.classList.toggle('tool-razor', this.tool === 'razor');
      document.getElementById('waveform-zoom-in')?.addEventListener('click', () => this.changeZoom(-1));
      document.getElementById('waveform-zoom-out')?.addEventListener('click', () => this.changeZoom(1));
      this.waveformScaleDownButton?.addEventListener('click', () => this.changeWaveformScale(-1));
      this.waveformScaleUpButton?.addEventListener('click', () => this.changeWaveformScale(1));
      this.waveformScaleFitButton?.addEventListener('click', () => this.fitWaveformScaleToLoudness());
      this.pane.addEventListener('pointerdown', () => {
        this.autoScrolling = false;
        this.autoScrollTarget = null;
        this.multiFollowCheckPending = true;
        this.focusWaveform();
      });
      this.secondsPerRowSelect?.addEventListener('change', () => {
        this.settings.secondsPerRow = Number(this.secondsPerRowSelect.value);
        saveSettings(this.settings);
        this.multiRange = [-1, -1];
        this.render();
      });
      this.rowHeightSelect?.addEventListener('change', () => {
        this.setRowHeight(Number(this.rowHeightSelect.value));
      });
      this.showGroupBadgesToggle?.addEventListener('change', () => {
        this.settings.showGroupBadges = this.showGroupBadgesToggle.checked;
        saveSettings(this.settings);
        this.render();
      });
      if (this.dragPlayheadToggle) this.dragPlayheadToggle.checked = this.settings.dragPlayhead === true;
      this.dragPlayheadToggle?.addEventListener('change', () => {
        this.settings.dragPlayhead = this.dragPlayheadToggle.checked;
        saveSettings(this.settings);
      });
      if (this.spectralColorToggle) {
        syncSpectralColorToggle(this.spectralColorToggle, false, this.settings.spectralColor);
      }
      this.spectralColorToggle?.addEventListener('change', () => {
        this.scheduleSpectralColorRender();
      });
      this.sideSelect?.addEventListener('change', () => {
        this.settings.side = this.sideSelect.value === 'right' ? 'right' : 'left';
        saveSettings(this.settings);
        this.applyLayout();
        this.scheduleRender();
      });
      this.disabledDisplaySelect?.addEventListener('change', () => {
        this.settings.disabledDisplay = this.disabledDisplaySelect.value === 'hidden' ? 'hidden' : 'dim';
        saveSettings(this.settings);
        this.refreshCueOverlay();
      });
      this.layoutEditToggle?.addEventListener('click', () => this.toggleLayoutEditMode());
      this.layoutResetButton?.addEventListener('click', () => this.resetLayout());
      this.scroll.addEventListener('wheel', (event) => this.handleWheel(event), { passive: false });
      this.scroll.addEventListener('pointerdown', () => {
        this.autoScrolling = false;
        this.autoScrollTarget = null;
        this.multiFollowCheckPending = true;
      });
      this.scroll.addEventListener('scroll', (event) => {
        if (!this.isMultiMode()) return;
        const wasAutoScroll = this.autoScrolling || this.autoScrollTarget !== null;
        if (this.autoScrollTarget !== null
            && Math.abs(this.scroll.scrollTop - this.autoScrollTarget) <= 0.5) {
          this.autoScrolling = false;
          this.autoScrollTarget = null;
        }
        if (event.isTrusted && !wasAutoScroll) {
          this.manualFollowUntil = Date.now() + 3000;
          this.multiFollowCheckPending = true;
        }
        this.scheduleMultiVisible();
      });
      this.bindDivider();
      this.bindLayoutResizers();
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
});
