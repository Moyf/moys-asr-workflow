// scale: waveform helpers with explicit dependencies.
window.MAWE.register('waveform-scale', function createWaveformModule(dependencies) {
  'use strict';
  const { MAX_WAVEFORM_SCALE, MIN_WAVEFORM_SCALE, clamp } = dependencies;


  function clampWaveformScale(value) {
    const numeric = Number(value);
    return clamp(Number.isFinite(numeric) ? numeric : 1, MIN_WAVEFORM_SCALE, MAX_WAVEFORM_SCALE);
  }


  function wheelScrollDelta(event) {
    const deltaY = Number(event?.deltaY) || 0;
    const deltaX = Number(event?.deltaX) || 0;
    // macOS may remap Shift+wheel's vertical movement to deltaX.
    return deltaY || deltaX;
  }


  function waveformScaleAfterStep(value, direction) {
    const current = clampWaveformScale(value);
    // 低于 1 时用 0.25 细步（0.25 / 0.5 / 0.75），否则 0.5
    const step = current < 1 ? 0.25 : 0.5;
    return Number(clampWaveformScale(current + Number(direction) * step).toFixed(2));
  }


  function waveformAmplitude(height, scale) {
    return Math.max(0, Number(height) * 0.36 * clampWaveformScale(scale));
  }


  // ---- 响度 → 振幅标尺 ----------------------------------------------------
  // 后端 moy.asr.loudness.v1 给的是 0..1 线性满量程 RMS（不是 peak、不是 dB）。
  // 要把「典型响度」换算成「典型峰值占多少半行高」，还差一个波峰因子。
  const LOUDNESS_CREST_FACTOR = 2.0;
 // RMS→峰值，约 +6 dB：正弦 √2 与语音 ~3.5 之间
  const LOUDNESS_TARGET_FILL = 0.85;
 // 参考峰值占可用上半高的比例，留 15% 余量
  const FULL_SCALE = 1.0;
 // 归一化满量程：预测峰值不可能超过它

  function waveformScaleFromLoudness(stats, height) {
    const reference = Number(stats && stats.p95);
    const rowHeight = Number(height);
    // 全静音（p95<=0）或缺响度层时返回 null：宁可不猜，也不要把振幅拉到上限。
    if (!Number.isFinite(reference) || reference <= 0) return null;
    if (!Number.isFinite(rowHeight) || rowHeight <= 0) return null;
    // 削顶发生在上方：可用高度是 center - 2 = 0.46h - 2，比下方 0.54h - 2 更紧。
    const headroom = Math.max(1, rowHeight * 0.46 - 2);
    // 不钳到满量程的话，响素材会算出 >1 的「预测峰值」，把波形画得偏小。
    const expectedPeak = Math.min(FULL_SCALE, reference * LOUDNESS_CREST_FACTOR);
    return clampWaveformScale(
      (LOUDNESS_TARGET_FILL * headroom) / (0.36 * rowHeight * expectedPeak),
    );
  }


  function sampleInterpolatedPeak(peaks, position, peakCount, target = [0, 0]) {
    if (!peaks || peakCount <= 0) {
      target[0] = 0;
      target[1] = 0;
      return target;
    }
    const clampedPosition = clamp(Number(position) || 0, 0, peakCount - 1);
    const left = Math.floor(clampedPosition);
    const right = Math.min(peakCount - 1, left + 1);
    const mix = clampedPosition - left;
    target[0] = peaks[left * 2] + (peaks[right * 2] - peaks[left * 2]) * mix;
    target[1] = peaks[left * 2 + 1] + (peaks[right * 2 + 1] - peaks[left * 2 + 1]) * mix;
    return target;
  }


  function buildWaveformEnvelope(
    peaks,
    peaksPerSecond,
    peakCount,
    startMs,
    endMs,
    width,
    useInterpolation = false,
  ) {
    const numericWidth = Number(width);
    const safeWidth = Number.isFinite(numericWidth)
      ? Math.max(1, Math.round(numericWidth)) : 1;
    const low = new Float32Array(safeWidth);
    const high = new Float32Array(safeWidth);
    if (!peaks || peakCount <= 0 || !Number.isFinite(peaksPerSecond) || peaksPerSecond <= 0) {
      return { low, high };
    }
    const rangeMs = Math.max(1, Number(endMs) - Number(startMs));
    const interpolatedPeak = [0, 0];
    for (let x = 0; x < safeWidth; x++) {
      const xStartMs = startMs + (x / safeWidth) * rangeMs;
      const xEndMs = startMs + ((x + 1) / safeWidth) * rangeMs;
      if (useInterpolation) {
        const centerMs = (xStartMs + xEndMs) / 2;
        const peakPosition = (centerMs / 1000) * peaksPerSecond - 0.5;
        sampleInterpolatedPeak(peaks, peakPosition, peakCount, interpolatedPeak);
        low[x] = interpolatedPeak[0];
        high[x] = interpolatedPeak[1];
        continue;
      }
      const firstPeak = clamp(Math.floor((xStartMs / 1000) * peaksPerSecond), 0, peakCount - 1);
      const lastPeak = clamp(Math.ceil((xEndMs / 1000) * peaksPerSecond), firstPeak + 1, peakCount);
      let min = 127;
      let max = -127;
      for (let peak = firstPeak; peak < lastPeak; peak++) {
        min = Math.min(min, peaks[peak * 2]);
        max = Math.max(max, peaks[peak * 2 + 1]);
      }
      low[x] = min;
      high[x] = max;
    }
    return { low, high };
  }

  return Object.freeze({ buildWaveformEnvelope, clampWaveformScale, sampleInterpolatedPeak, waveformAmplitude, waveformScaleAfterStep, waveformScaleFromLoudness, wheelScrollDelta });
});
