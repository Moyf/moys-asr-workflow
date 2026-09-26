// payload: waveform helpers with explicit dependencies.
window.MAWE.register('waveform-payload', function createWaveformModule(dependencies) {
  'use strict';
  const { ENCODING, SCHEMA, SPECTRAL_ENCODING, SPECTRAL_SCHEMA, clamp } = dependencies;


  function decodePayload(payload) {
    if (!payload || payload.schema !== SCHEMA || payload.encoding !== ENCODING) return null;
    if (!Number.isInteger(payload.peak_count) || payload.peak_count <= 0) return null;
    if (!peaksRateOf(payload)) return null;
    if (typeof payload.data !== 'string') return null;
    try {
      const binary = atob(payload.data);
      if (binary.length !== payload.peak_count * 2) return null;
      const unsigned = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) unsigned[i] = binary.charCodeAt(i);
      return new Int8Array(unsigned.buffer);
    } catch (_) {
      return null;
    }
  }


  // payload.peaks_per_second 只是给人看的近似值：真实刻度是 sample_rate / division，
  // 而 .ReaPeaks 派生的层在多数采样率下都不是整数（16 kHz + div 53 = 301.8868）。
  // 任何"峰值序号 ↔ 毫秒"的换算都必须走这里，否则误差会按比例缩放整条时间轴，
  // 随媒体时长线性累积（16 kHz 在 15 分钟处约错开 1/3 秒）。
  function peaksRateOf(payload) {
    if (!payload) return 0;
    const hasSampleRate = payload.sample_rate !== undefined && payload.sample_rate !== null;
    const hasDivision = payload.division !== undefined && payload.division !== null;
    // 只出现一半的精确率字段说明 payload 已损坏：宁可判定为无刻度，
    // 也不要退回近似值画出错位波形（与 waveform.is_waveform_payload 一致）。
    if (hasSampleRate !== hasDivision) return 0;
    if (hasSampleRate) {
      const sampleRate = Number(payload.sample_rate);
      const division = Number(payload.division);
      if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
      if (!Number.isInteger(division) || division <= 0) return 0;
      return sampleRate / division;
    }
    return Number.isFinite(payload.peaks_per_second) && payload.peaks_per_second > 0
      ? payload.peaks_per_second
      : 0;
  }


  // 发布给消费者的 peaks_per_second 保留精确比率（整除时写成整数），与
  // maw/reapeaks.py::extract_waveform_payload 的取整策略完全一致，这样即使某个
  // 读取方仍在用 peaks_per_second 做几何换算，也不会重新引入按比例累积的漂移。
  function publishPeakRate(sampleRate, division) {
    if (!sampleRate || !division) return 0;
    const exactRate = sampleRate / division;
    return Number.isInteger(exactRate) ? exactRate : Math.round(exactRate * 1e6) / 1e6;
  }


  // 浏览器端只读解析 REAPER 的 .ReaPeaks 文件。桌面/服务器版会在
  // 生成页面时预先内联同一份 payload；便携版拖入 sidecar 时则走这里，
  // 因此两种编辑器得到完全相同的 wave/spectral 缓存契约。
  function decodeReapeaksFile(arrayBuffer, source = null) {
    if (!(arrayBuffer instanceof ArrayBuffer)) return null;
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 18) return null;
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    // QPK + 1 字节可打印版本号（当前 QPK1）。全局头与层表布局与 RPKN 相同，
    // wave 层同样是 i16 min/max，所以下面按 RPKM/RPKL 分支取宽度的逻辑不用改：
    // QPK1 天然落进与 RPKN 相同的 else 分支。
    const isNative = magic === 'QPK1';
    if (!isNative && !['RPKM', 'RPKN', 'RPKL'].includes(magic)) return null;
    const channels = bytes[4];
    const mipmapCount = bytes[5];
    if (!channels || !mipmapCount) return null;
    const view = new DataView(arrayBuffer);
    const sampleRate = view.getInt32(6, true);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
    const headerEnd = 18 + mipmapCount * 8;
    if (headerEnd > bytes.length) return null;
    const mipmaps = [];
    let headerOffset = 18;
    for (let i = 0; i < mipmapCount; i++) {
      const division = view.getInt32(headerOffset, true);
      const peakCount = view.getInt32(headerOffset + 4, true);
      if (peakCount < 0) return null;
      const kind = division === -'m'.charCodeAt(0)
        ? 'self-wave'
        : division === -'s'.charCodeAt(0)
        ? 'spectral'
        : division === -'g'.charCodeAt(0)
          ? 'spectrogram'
          : division === -'r'.charCodeAt(0) || division === -'l'.charCodeAt(0)
            ? 'loudness' : 'wave';
      mipmaps.push({ division, peakCount, kind });
      headerOffset += 8;
    }

    const munge = (value) => {
      if (value >= -24576 && value <= 24576) return value / 24576;
      if (value > 24576) return 2 ** ((value - 24576) / 1024);
      return -(2 ** ((-value - 24576) / 1024));
    };
    const quantize = (value) => {
      const numeric = magic === 'RPKL' ? munge(value) : value / 32768;
      return clamp(Math.round(clamp(numeric, -1, 1) * 127), -127, 127);
    };
    const waveMips = [];
    const spectralMips = [];
    let offset = headerEnd;
    const need = (count) => {
      if (count < 0 || offset + count > bytes.length) throw new Error('短文件');
    };
    try {
      for (const mip of mipmaps) {
        if (mip.kind === 'wave') {
          const encoded = new Uint8Array(mip.peakCount * 2);
          for (let peak = 0; peak < mip.peakCount; peak++) {
            let low = 127;
            let high = -127;
            for (let channel = 0; channel < channels; channel++) {
              need(magic === 'RPKL' ? 4 : magic === 'RPKM' ? 2 : 4);
              const maxRaw = view.getInt16(offset, true);
              offset += 2;
              const minRaw = magic === 'RPKM' ? -maxRaw : view.getInt16(offset, true);
              if (magic !== 'RPKM') offset += 2;
              const maxValue = quantize(maxRaw);
              const minValue = quantize(minRaw);
              low = Math.min(low, minValue);
              high = Math.max(high, maxValue);
            }
            encoded[peak * 2] = low & 0xff;
            encoded[peak * 2 + 1] = high & 0xff;
          }
          waveMips.push({ mip, data: encoded });
          continue;
        }
        if (mip.kind === 'spectral') {
          const spectral = new Uint16Array(mip.peakCount * 2);
          for (let peak = 0; peak < mip.peakCount; peak++) {
            let freq = 0;
            let density = 0;
            for (let channel = 0; channel < channels; channel++) {
              need(4);
              const packed = view.getUint32(offset, true);
              offset += 4;
              if (channel === 0) {
                freq = packed & 0x7fff;
                density = (packed >>> 15) & 0x3fff;
              }
            }
            spectral[peak * 2] = freq;
            spectral[peak * 2 + 1] = density;
          }
          spectralMips.push({ mip, data: spectral });
          continue;
        }
        if (mip.kind === 'self-wave') {
          need(8 + mip.peakCount * 2);
          offset += 8 + mip.peakCount * 2;
          continue;
        }
        // 跳过当前编辑器不显示的 spectrogram/loudness 层，但仍准确推进
        // offset，避免后面的 wave/spectral 层被错误解释。
        const bytesPerValue = mip.kind === 'spectrogram' ? 192 : 4;
        need(mip.peakCount * channels * bytesPerValue);
        offset += mip.peakCount * channels * bytesPerValue;
      }
    } catch (_) {
      return null;
    }
    if (!waveMips.length) return null;
    const finest = waveMips[0];
    const division = Math.abs(finest.mip.division);
    if (!division) return null;
    const baseSource = source && typeof source === 'object' ? source : undefined;
    // 与 maw/reapeaks.py::extract_waveform_payload 完全一致：精确比率 + sample_rate/division。
    const waveform = {
      schema: SCHEMA,
      encoding: ENCODING,
      peaks_per_second: publishPeakRate(sampleRate, division),
      sample_rate: sampleRate,
      division,
      peak_count: finest.mip.peakCount,
      duration_ms: Math.round(finest.mip.peakCount * division / sampleRate * 1000),
      ...(baseSource ? { source: baseSource } : {}),
      data: bytesToBase64(finest.data),
    };
    let spectral = null;
    if (spectralMips.length) {
      const targetDivision = Math.max(1, Math.round(sampleRate / 100));
      const paired = spectralMips.map((entry, index) => ({
        ...entry,
        division: Math.abs(waveMips[index]?.mip.division || division),
      }));
      const selected = paired.reduce((best, entry) => (
        Math.abs(entry.division - targetDivision) < Math.abs(best.division - targetDivision)
          ? entry : best
      ), paired[0]);
      const payloadBytes = new Uint8Array(selected.data.length * 2);
      selected.data.forEach((value, index) => {
        payloadBytes[index * 2] = value & 0xff;
        payloadBytes[index * 2 + 1] = value >>> 8;
      });
      spectral = {
        schema: SPECTRAL_SCHEMA,
        encoding: SPECTRAL_ENCODING,
        sample_rate: sampleRate,
        division: selected.division,
        peak_count: selected.mip.peakCount,
        duration_ms: Math.round(selected.mip.peakCount * selected.division / sampleRate * 1000),
        ...(baseSource ? { source: baseSource } : {}),
        data: bytesToBase64(payloadBytes),
      };
    }
    return { waveform, spectral };
  }


  function bytesToBase64(bytes) {
    const chunkSize = 0x8000;
    const parts = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
    }
    return btoa(parts.join(''));
  }


  // Decode a moy.asr.spectral.v1 payload into {freq, density, sample_rate,
  // division, densityMax}, or null when the payload is absent / unknown.
  // Each spectral sample is 4 bytes: freq u16 LE, density u16 LE.
  function decodeSpectralPayload(payload) {
    if (!payload || payload.schema !== SPECTRAL_SCHEMA || payload.encoding !== SPECTRAL_ENCODING) {
      return null;
    }
    if (!Number.isInteger(payload.peak_count) || payload.peak_count <= 0) return null;
    if (!Number.isInteger(payload.sample_rate) || payload.sample_rate <= 0) return null;
    if (!Number.isInteger(payload.division) || payload.division <= 0) return null;
    if (typeof payload.data !== 'string') return null;
    let binary;
    try {
      binary = atob(payload.data);
    } catch (_) {
      return null;
    }
    if (binary.length !== payload.peak_count * 4) return null;
    const freq = new Uint16Array(payload.peak_count);
    const density = new Uint16Array(payload.peak_count);
    let densityMax = 1;
    for (let i = 0; i < payload.peak_count; i++) {
      const offset = i * 4;
      freq[i] = binary.charCodeAt(offset) | (binary.charCodeAt(offset + 1) << 8);
      const d = binary.charCodeAt(offset + 2) | (binary.charCodeAt(offset + 3) << 8);
      density[i] = d;
      if (d > densityMax) densityMax = d;
    }
    return {
      freq,
      density,
      densityMax,
      sample_rate: payload.sample_rate,
      division: payload.division,
    };
  }


  // REAPER spectral coloring from the raw 15-bit freq_field (0-32767) and the
  // 14-bit density (0=noise, 16383=perfect tone). Low→high frequency sweeps
  // red→pink/green→orange/yellow; saturation & lightness rise with tonality.
  function freqColor(freq, density, densityMax) {
    let hue;
    if (freq < 300) {
      hue = (freq / 300) * 30; // red (0°) to brown (30°)
    } else if (freq < 1000) {
      hue = 300 + ((freq - 300) / 700) * 180; // pink (300°) to green (120°)
      if (hue >= 360) hue -= 360;
    } else if (freq < 3000) {
      hue = 120 - ((freq - 1000) / 2000) * 90; // green (120°) to orange (30°)
    } else {
      hue = 30 + Math.min((freq - 3000) / 5000, 1) * 30; // orange (30°) to yellow (60°)
    }
    const d = clamp(density / Math.max(1, densityMax), 0, 1);
    const sat = 0.3 + 0.7 * d;
    const light = 0.4 + 0.4 * d;
    return `hsl(${hue.toFixed(1)}, ${(sat * 100).toFixed(1)}%, ${(light * 100).toFixed(1)}%)`;
  }


  function sourceForFile(file) {
    return {
      name: file.name,
      size: file.size,
      modified_ms: file.lastModified,
    };
  }


  function sameSource(a, b) {
    return !!a && !!b && a.name === b.name && a.size === b.size && a.modified_ms === b.modified_ms;
  }

  return Object.freeze({ bytesToBase64, decodePayload, decodeReapeaksFile, decodeSpectralPayload, freqColor, peaksRateOf, publishPeakRate, sameSource, sourceForFile });
});
