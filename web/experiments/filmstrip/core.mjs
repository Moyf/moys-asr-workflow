// Reusable experiment primitives. No editor registration or project writes.
export class FrameCache {
  constructor(maxBytes = 12 * 1024 * 1024, maxItems = 96) {
    this.maxBytes = maxBytes; this.maxItems = maxItems;
    this.items = new Map(); this.bytes = 0;
  }
  get(key) {
    const item = this.items.get(key);
    if (item) { this.items.delete(key); this.items.set(key, item); }
    return item?.value;
  }
  set(key, value, bytes) {
    if (this.items.has(key)) this.delete(key);
    this.items.set(key, { value, bytes }); this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.items.size > this.maxItems) {
      this.delete(this.items.keys().next().value);
    }
  }
  delete(key) {
    const item = this.items.get(key);
    if (item) { item.value?.close?.(); this.bytes -= item.bytes; this.items.delete(key); }
  }
  clear() { for (const key of [...this.items.keys()]) this.delete(key); }
}

export function displayToSource(ms, intervals) {
  let display = 0;
  for (const interval of intervals) {
    const length = interval.end - interval.start;
    if (ms < display + length) return interval.start + Math.max(0, ms - display);
    display += length;
  }
  return intervals.at(-1)?.end ?? 0;
}

export function visibleSamples(start, span, width, cellWidth, intervals, duration) {
  const count = Math.min(32, Math.max(1, Math.ceil(width / cellWidth)));
  return Array.from({ length: count }, (_, i) => {
    const displayMs = start + span * (i + 0.5) / count;
    return { x: i * width / count, width: width / count,
      displayMs, sourceMs: Math.min(duration - 1, displayToSource(displayMs, intervals)) };
  });
}

export function nearestFrame(times, sourceMs) {
  let best = 0;
  times.forEach((time, i) => {
    if (Math.abs(time - sourceMs) < Math.abs(times[best] - sourceMs)) best = i;
  });
  return best;
}

export function eventOnce(target, type, signal, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer); target.removeEventListener(type, done);
      target.removeEventListener('error', fail); signal?.removeEventListener('abort', abort);
    };
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Browser cannot decode this media')); };
    const abort = () => { cleanup(); reject(new DOMException('Superseded', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(type + ' timed out')); }, timeout);
    target.addEventListener(type, done, { once: true });
    target.addEventListener('error', fail, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function seekFrame(video, seconds, signal) {
  if (signal.aborted) throw new DOMException('Superseded', 'AbortError');
  if (Math.abs(video.currentTime - seconds) > 0.001 || video.readyState < 2) {
    const ready = eventOnce(video, 'seeked', signal);
    video.currentTime = seconds;
    await ready;
  }
  // seeked guarantees current decoded data. rVFC timestamp is opportunistic;
  // paused/background browsers may not deliver callbacks, so do not block on it.
  const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101722'; ctx.fillRect(0, 0, 160, 90);
  const scale = Math.min(160 / video.videoWidth, 90 / video.videoHeight);
  const w = video.videoWidth * scale, h = video.videoHeight * scale;
  ctx.drawImage(video, (160 - w) / 2, (90 - h) / 2, w, h);
  const bitmap = await createImageBitmap(canvas);
  if (signal.aborted) { bitmap.close(); throw new DOMException('Superseded', 'AbortError'); }
  return bitmap;
}
