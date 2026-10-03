// canvas: waveform class methods with explicit dependencies.
window.MAWE.register('waveform-canvas', function createWaveformModule(dependencies) {
  'use strict';
  const { ZOOM_PRESETS, buildWaveformEnvelope, clamp, freqColor, waveformAmplitude, waveformGridStepMs } = dependencies;

  class WaveformMethods {


    getWaveformEnvelope(row, width, startMs, endMs, activePeaks, peaksPerSecond, activeCount, useInterpolation) {
      const key = row._waveformEnvelopeKey;
      if (row._waveformEnvelope && key
          && key.width === width
          && key.startMs === startMs
          && key.endMs === endMs
          && key.source === activePeaks
          && key.peaksPerSecond === peaksPerSecond
          && key.peakCount === activeCount
          && key.useInterpolation === useInterpolation) {
        return row._waveformEnvelope;
      }
      const envelope = buildWaveformEnvelope(
        activePeaks,
        peaksPerSecond,
        activeCount,
        startMs,
        endMs,
        width,
        useInterpolation,
      );
      row._waveformEnvelopeKey = {
        width,
        startMs,
        endMs,
        source: activePeaks,
        peaksPerSecond,
        peakCount: activeCount,
        useInterpolation,
      };
      row._waveformEnvelope = envelope;
      return envelope;
    }


    drawRow(row, { measure = true } = {}) {
      const canvas = row.querySelector('canvas');
      if (!canvas || !this.peaks) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      let width = Number(row._waveformCanvasWidth);
      let height = Number(row._waveformCanvasHeight);
      if (measure || !Number.isFinite(width) || !Number.isFinite(height)) {
        const rect = row.getBoundingClientRect();
        width = Math.max(1, Math.round(rect.width));
        height = Math.max(1, Math.round(rect.height));
      }
      if (width <= 0 || height <= 0) return;
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      const cssWidth = `${width}px`;
      const cssHeight = `${height}px`;
      if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
      if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
      row._waveformCanvasWidth = width;
      row._waveformCanvasHeight = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const colors = this._getWaveColors();
      ctx.fillStyle = colors.rowBg;
      ctx.fillRect(0, 0, width, height);

      const startMs = Number(row.dataset.startMs);
      const endMs = Number(row.dataset.endMs);
      const rangeMs = Math.max(1, endMs - startMs);
      const showFineGrid = (this.settings.mode === 'basic' && this.settings.visibleSeconds === 2)
        || (this.settings.mode === 'multi' && this.settings.secondsPerRow === 2);
      if (showFineGrid) {
        const gridStepMs = waveformGridStepMs(this.cueTiming());
        const firstGrid = Math.ceil(startMs / gridStepMs) * gridStepMs;
        ctx.strokeStyle = colors.rowGrid;
        ctx.lineWidth = 1;
        for (let grid = firstGrid; grid < endMs; grid += gridStepMs) {
          const x = ((grid - startMs) / rangeMs) * width;
          ctx.beginPath();
          ctx.moveTo(x + 0.5, 0);
          ctx.lineTo(x + 0.5, height);
          ctx.stroke();
        }
      }
      const tickSeconds = rangeMs <= 10000 ? 1 : rangeMs <= 30000 ? 2 : 5;
      const firstTick = Math.ceil(startMs / (tickSeconds * 1000)) * tickSeconds * 1000;
      ctx.strokeStyle = colors.rowBorder;
      ctx.lineWidth = 1;
      for (let tick = firstTick; tick < endMs; tick += tickSeconds * 1000) {
        const x = ((tick - startMs) / rangeMs) * width;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
        ctx.stroke();
      }
      ctx.strokeStyle = colors.rowTick;
      ctx.beginPath();
      ctx.moveTo(0, height * 0.46);
      ctx.lineTo(width, height * 0.46);
      ctx.stroke();

      // 形状来源开关（默认 .ReaPeaks，缺数据自动回退自研）与音量门限检测共用同一选取。
      const waveShape = this.activeWaveShape();
      if (!waveShape) return;
      const activePeaks = waveShape.peaks;
      const peaksPerSecond = waveShape.peaksPerSecond;
      const activeCount = waveShape.peakCount;
      const useInterpolation = this.settings.mode === 'basic'
        && this.settings.visibleSeconds === ZOOM_PRESETS[0]
        && (rangeMs / 1000) * peaksPerSecond < width;
      const envelope = this.getWaveformEnvelope(
        row,
        width,
        startMs,
        endMs,
        activePeaks,
        peaksPerSecond,
        activeCount,
        useInterpolation,
      );
      const center = height * 0.46;
      const amplitude = waveformAmplitude(height, this.settings.waveformScale);
      const minWaveY = 2;
      const maxWaveY = Math.max(minWaveY, height - 2);
      const spectral = this.settings.spectralColor === true ? this.spectral : null;
      const defaultColor = this.mediaAvailable ? colors.peak : colors.peakDim;
      const spectralRate = spectral ? spectral.sample_rate / spectral.division : 0;
      ctx.lineWidth = 1;
      // 有频谱缓存时逐像素按主频染色（颜色只填充在波形包络内）；
      // 否则沿用单次批量描边，避免无频谱时的逐像素绘制开销。
      let pathOpen = false;
      for (let x = 0; x < width; x++) {
        const xStartMs = startMs + (x / width) * rangeMs;
        const low = envelope.low[x];
        const high = envelope.high[x];
        const yTop = clamp(center - (high / 127) * amplitude, minWaveY, maxWaveY);
        const yBot = clamp(center - (low / 127) * amplitude, minWaveY, maxWaveY);
        if (spectral) {
          const centerMs = xStartMs + rangeMs / width / 2;
          const specIndex = Math.floor((centerMs / 1000) * spectralRate);
          let color = defaultColor;
          if (specIndex >= 0 && specIndex < spectral.freq.length) {
            const freq = spectral.freq[specIndex];
            if (freq > 0) {
              color = freqColor(freq, spectral.density[specIndex], spectral.densityMax);
            }
          }
          ctx.fillStyle = color;
          ctx.fillRect(x + 0.5, yTop, 1, Math.max(1, yBot - yTop));
        } else {
          if (!pathOpen) {
            ctx.beginPath();
            ctx.strokeStyle = defaultColor;
            pathOpen = true;
          }
          ctx.moveTo(x + 0.5, yTop);
          ctx.lineTo(x + 0.5, yBot);
        }
      }
      if (!spectral && pathOpen) ctx.stroke();
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
});
