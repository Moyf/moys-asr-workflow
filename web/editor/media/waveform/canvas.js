// canvas: waveform class methods with explicit dependencies.
export function createWaveformModule(dependencies) {
  'use strict';
  const { ZOOM_PRESETS, clamp, freqColor, sampleInterpolatedPeak, waveformAmplitude, waveformGridStepMs } = dependencies;

  class WaveformMethods {


    /**
     * 绝对时间锚定的列包络缓存：固定毫秒列宽，聚合列内全部原生峰值的
     * min/max。与旧的按窗口 key 缓存不同，列不随滚轮平移失效——平移帧
     * 只读列（零聚合），窗口滑出缓存覆盖范围时才整体重建一次。
     * 列宽取当前窗口的每像素毫秒数（rangeMs/width），因此每像素最多跨
     * 2 列；边界列并入相邻列的过取幅度与旧实现 floor/ceil 的跨峰行为
     * 等价，渲染结果不变。
     * @this {import('./waveform-types.js').WaveformInstance}
     */
    getWaveformColumnEnvelope(width, startMs, endMs) {
      const waveShape = this.activeWaveShape();
      if (!waveShape || !waveShape.peaks || !(waveShape.peakCount > 0)) return null;
      const { peaks, peaksPerSecond, peakCount } = waveShape;
      const rangeMs = Math.max(1, endMs - startMs);
      const columnMs = rangeMs / Math.max(1, width);
      if (!Number.isFinite(columnMs) || columnMs <= 0) return null;
      const cached = this._waveColumnCache;
      if (cached && cached.source === peaks && cached.peakCount === peakCount
        && cached.peaksPerSecond === peaksPerSecond
        && Math.abs(cached.columnMs - columnMs) <= columnMs * 0.001
        && startMs >= cached.coverStartMs && endMs <= cached.coverEndMs) {
        return cached;
      }
      // 覆盖窗口 ± 3 倍余量：连续滚轮平移约二十余档才触发一次重建；
      // 多行模式下也足以覆盖预生成的相邻行，摊销后与逐窗重建持平。
      const marginMs = rangeMs * 3;
      const coverStartMs = Math.max(0, startMs - marginMs);
      const coverEndMs = Math.min(Math.max(this.durationMs, endMs), endMs + marginMs);
      const columns = Math.max(1, Math.ceil((coverEndMs - coverStartMs) / columnMs));
      const low = new Float32Array(columns);
      const high = new Float32Array(columns);
      const peaksPerMs = peaksPerSecond / 1000;
      for (let column = 0; column < columns; column += 1) {
        const columnStartMs = coverStartMs + column * columnMs;
        // 边界语义与 scale.js buildWaveformEnvelope 一致：floor/ceil 并保证
        // 至少聚合 1 个峰值；首尾列钳制在峰值数组范围内。
        const firstPeak = clamp(Math.floor(columnStartMs * peaksPerMs), 0, peakCount - 1);
        const lastPeak = clamp(Math.ceil((columnStartMs + columnMs) * peaksPerMs), firstPeak + 1, peakCount);
        let min = 127;
        let max = -127;
        for (let peak = firstPeak; peak < lastPeak; peak += 1) {
          min = Math.min(min, peaks[peak * 2]);
          max = Math.max(max, peaks[peak * 2 + 1]);
        }
        low[column] = min;
        high[column] = max;
      }
      const next = {
        source: peaks, peakCount, peaksPerSecond, columnMs,
        coverStartMs, coverEndMs, columns, low, high,
      };
      this._waveColumnCache = next;
      return next;
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    drawRow(row, { measure = true } = {}) {
      const canvas = row.querySelector('canvas.waveform-canvas');
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
      const startMs = Number(row.dataset.startMs);
      const endMs = Number(row.dataset.endMs);
      this.paintWaveRow(row, ctx, width, height, startMs, endMs, 0, width, { withChips: true });
    }


    /**
     * 绘制行画布的 [x0, x0+span) 区段：背景、网格、刻度、中线、峰形，可选
     * 字词气泡层。全量绘制传 (0, width)；滚轮平移补条传露出的窄条范围
     * （withChips:false，chip 层随停止后的整行精绘对齐）。
     * @this {import('./waveform-types.js').WaveformInstance}
     */
    paintWaveRow(row, ctx, width, height, startMs, endMs, x0, span, { withChips = true } = {}) {
      const colors = this._getWaveColors();
      const rangeMs = Math.max(1, endMs - startMs);
      ctx.fillStyle = colors.rowBg;
      ctx.fillRect(x0, 0, span, height);

      const showFineGrid = (this.settings.mode === 'basic' && this.settings.visibleSeconds === 2)
        || (this.settings.mode === 'multi' && this.settings.secondsPerRow === 2);
      ctx.lineWidth = 1;
      if (showFineGrid) {
        const gridStepMs = waveformGridStepMs(this.cueTiming());
        const firstGrid = Math.ceil(startMs / gridStepMs) * gridStepMs;
        // 一条 path 收齐全部网格线后单次 stroke：2 秒档逐条 stroke 每帧
        // 60+ 次绘制调用，是滚轮平移卡顿的组成之一。
        ctx.strokeStyle = colors.rowGrid;
        ctx.beginPath();
        for (let grid = firstGrid; grid < endMs; grid += gridStepMs) {
          const x = ((grid - startMs) / rangeMs) * width;
          if (x + 1 < x0 || x > x0 + span) continue;
          ctx.moveTo(x + 0.5, 0);
          ctx.lineTo(x + 0.5, height);
        }
        ctx.stroke();
      }
      const tickSeconds = rangeMs <= 10000 ? 1 : rangeMs <= 30000 ? 2 : 5;
      const firstTick = Math.ceil(startMs / (tickSeconds * 1000)) * tickSeconds * 1000;
      ctx.strokeStyle = colors.rowBorder;
      ctx.beginPath();
      for (let tick = firstTick; tick < endMs; tick += tickSeconds * 1000) {
        const x = ((tick - startMs) / rangeMs) * width;
        if (x + 1 < x0 || x > x0 + span) continue;
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
      }
      ctx.stroke();
      ctx.strokeStyle = colors.rowTick;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, height * 0.46);
      ctx.lineTo(x0 + span - 0.5, height * 0.46);
      ctx.stroke();

      // 形状来源开关（默认 .ReaPeaks，缺数据自动回退自研）与音量门限检测共用同一选取。
      const waveShape = this.activeWaveShape();
      if (!waveShape) {
        if (withChips) this.drawWordChips(row, ctx, width, height, startMs, endMs);
        return;
      }
      const activePeaks = waveShape.peaks;
      const peaksPerSecond = waveShape.peaksPerSecond;
      const activeCount = waveShape.peakCount;
      const useInterpolation = this.settings.mode === 'basic'
        && this.settings.visibleSeconds === ZOOM_PRESETS[0]
        && (rangeMs / 1000) * peaksPerSecond < width;
      const columns = useInterpolation ? null : this.getWaveformColumnEnvelope(width, startMs, endMs);
      const columnMs = columns ? columns.columnMs : 0;
      const coverStartMs = columns ? columns.coverStartMs : 0;
      const columnsLength = columns ? columns.columns : 0;
      const columnsLow = columns ? columns.low : null;
      const columnsHigh = columns ? columns.high : null;
      const peaksPerMs = peaksPerSecond / 1000;
      const spectral = this.settings.spectralColor === true ? this.spectral : null;
      const defaultColor = this.mediaAvailable ? colors.peak : colors.peakDim;
      const spectralRate = spectral ? spectral.sample_rate / spectral.division : 0;
      const center = height * 0.46;
      const amplitude = waveformAmplitude(height, this.settings.waveformScale);
      const minWaveY = 2;
      const maxWaveY = Math.max(minWaveY, height - 2);
      const interpolatedPeak = [0, 0];
      ctx.lineWidth = 1;
      // 有频谱缓存时逐像素按主频染色（颜色只填充在波形包络内）；
      // 否则沿用单次批量描边，避免无频谱时的逐像素绘制开销。
      let pathOpen = false;
      for (let x = x0; x < x0 + span; x++) {
        const xStartMs = startMs + (x / width) * rangeMs;
        const xEndMs = startMs + ((x + 1) / width) * rangeMs;
        let low;
        let high;
        if (useInterpolation) {
          // 稀疏峰值的插值是像素中心连续函数，无法按绝对时间缓存；
          // 逐像素内联计算（每次约十次浮点运算，本就廉价）。
          const centerMs = xStartMs + (xEndMs - xStartMs) / 2;
          const peakPosition = (centerMs / 1000) * peaksPerSecond - 0.5;
          sampleInterpolatedPeak(activePeaks, peakPosition, activeCount, interpolatedPeak);
          low = interpolatedPeak[0];
          high = interpolatedPeak[1];
        } else if (columnsLow) {
          // 列缓存：像素覆盖的列范围取 min/max，绝大多数像素只读 1-2 列。
          let first = Math.floor((xStartMs - coverStartMs) / columnMs);
          let last = Math.ceil((xEndMs - coverStartMs) / columnMs);
          first = clamp(first, 0, columnsLength - 1);
          last = clamp(Math.max(last, first + 1), 0, columnsLength);
          low = columnsLow[first];
          high = columnsHigh[first];
          for (let column = first + 1; column < last; column += 1) {
            low = Math.min(low, columnsLow[column]);
            high = Math.max(high, columnsHigh[column]);
          }
        } else {
          // 列缓存不可用（峰值数据缺失）时逐像素聚合兜底，语义一致。
          const firstPeak = clamp(Math.floor(xStartMs * peaksPerMs), 0, activeCount - 1);
          const lastPeak = clamp(Math.ceil(xEndMs * peaksPerMs), firstPeak + 1, activeCount);
          let min = 127;
          let max = -127;
          for (let peak = firstPeak; peak < lastPeak; peak += 1) {
            min = Math.min(min, activePeaks[peak * 2]);
            max = Math.max(max, activePeaks[peak * 2 + 1]);
          }
          low = min;
          high = max;
        }
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
      // 全文预览气泡层：画在波形之上（基础模式 + 字词码时才有内容）。
      if (withChips) this.drawWordChips(row, ctx, width, height, startMs, endMs);
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
}
