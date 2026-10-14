// Server-bound thumbnail transport and decoded-image ownership.
export function createThumbnailModule(dependencies) {
  'use strict';
  const { browser, getConfig, storage } = dependencies;
  const INTERVALS = [250, 500, 1000, 2000, 5000, 10000];
  const IMAGE_BUDGET = 48 * 1024 * 1024;
  const DISPLAY_WIDTH = 48 * 160 / 90;

  function chooseInterval(pxPerSecond, previous = 0) {
    const ideal = DISPLAY_WIDTH * 1000 / Math.max(0.001, pxPerSecond);
    const selected = INTERVALS.reduce((best, value) =>
      Math.abs(Math.log(value / ideal)) < Math.abs(Math.log(best / ideal)) ? value : best, INTERVALS[0]);
    if (INTERVALS.includes(previous) && selected !== previous) {
      const boundary = Math.sqrt(previous * selected);
      if (selected > previous ? ideal < boundary * 1.15 : ideal > boundary / 1.15) return previous;
    }
    return selected;
  }

  function mergeRanges(ranges, duration) {
    const sorted = ranges.map(range => ({start_ms: Math.max(0, Math.floor(range.start_ms)),
      end_ms: Math.min(duration, Math.ceil(range.end_ms))}))
      .filter(range => range.end_ms > range.start_ms).sort((a, b) => a.start_ms - b.start_ms);
    const merged = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (last && range.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, range.end_ms);
      else merged.push({...range});
    }
    return merged;
  }

  function gridTargets(ranges, interval, duration) {
    const result = new Set();
    for (const range of ranges) {
      for (let time = Math.floor(range.start_ms / interval) * interval;
          time < range.end_ms && time < duration; time += interval) {
        if (time >= 0) result.add(time);
      }
    }
    return [...result].sort((a, b) => a - b);
  }

  function prefetchRanges(ranges, duration) {
    return mergeRanges(ranges.map(range => {
      const padding = Math.round((range.end_ms - range.start_ms) * 0.15);
      return {start_ms: range.start_ms - padding, end_ms: range.end_ms + padding};
    }), duration);
  }

  function makeDemand(rows, duration, previousInterval = 0) {
    const visible = mergeRanges(rows.map(row => ({start_ms: row.start, end_ms: row.end})), duration);
    const pxPerSecond = rows.length ? rows[0].width * 1000 / Math.max(1, rows[0].end - rows[0].start) : 1;
    const interval = chooseInterval(pxPerSecond, previousInterval);
    // The Server adds the single 15% prefetch band and assigns its lower priority.
    const visibleRows = rows.flatMap(row => mergeRanges([{start_ms:row.start, end_ms:row.end}], duration))
      .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
    const representatives = new Set();
    const addRepresentative = time => {
      if (representatives.size < 32 && time >= 0 && time < duration) representatives.add(time);
    };
    // Give every row a center before spending the bounded representative budget on second pictures.
    for (const range of visibleRows) {
      addRepresentative(Math.floor((range.start_ms + range.end_ms) / 2 / interval) * interval);
    }
    for (const range of visibleRows) addRepresentative(Math.floor(range.start_ms / interval) * interval);
    return { interval_ms: interval, ranges: visible, representative_ms: [...representatives] };
  }

  function createController(onChange) {
    let binding = '', lease = '', source = '', revision = '', view = 0, playheadMs = 0;
    let preloadRanges = [];
    const clientId = browser.crypto?.randomUUID?.() || `filmstrip-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let controlRequest = null;
    const protectedKeys = new Set();
    let enabled = true;
    try { enabled = storage.getItem('mawe-filmstrip-visible') !== 'false'; } catch (_) {}
    let available = false, playing = false, closed = false, state = 'idle', persisted = true;
    let samples = [], fallbackSamples = [], assets = [], demand = {interval_ms: 2000, ranges: [], representative_ms: []};
    let demandKey = '', debounce = 0, pollTimer = 0, heartbeat = 0, requestEpoch = 0;
    let statusBusy = false, demandBusy = false, demandAgain = false;
    let networkSuspended = false;
    const failures = {status:0, demand:0, control:0};
    const dirtyRanges = [];
    const requests = new Set(), images = new Map(), imageQueue = new Map();
    const imagePending = new Set(), imageFailures = new Set(), imageCapacityFailures = new Set();
    let imageBytes = 0, imageActive = 0, paintFrame = 0;
    const config = () => getConfig() || {};
    const urls = () => config().thumbnailUrls || {};
    const repaint = (ranges) => {
      dirtyRanges.push(...ranges);
      if (paintFrame || closed || !dirtyRanges.length) return;
      paintFrame = browser.requestAnimationFrame(() => {
        paintFrame = 0;
        const changed = mergeRanges(dirtyRanges.splice(0), Infinity);
        onChange(false, changed);
      });
    };
    function sampleRanges(changed) {
      const radius = demand.interval_ms * 2;
      return changed.map(sample => ({start_ms:sample.requested_ms - radius,
        end_ms:sample.requested_ms + radius + demand.interval_ms}));
    }
    function networkFailed(channel, epoch, requestedView) {
      if (closed || epoch !== requestEpoch || requestedView !== view || networkSuspended) return;
      failures[channel] += 1;
      if (failures[channel] < 3) { schedulePoll(); return; }
      networkSuspended = true; state = 'network-error';
      release(false);
      // Keep already decoded navigation pictures. A new view, reconnect or explicit retry
      // starts another bounded attempt; unchanged playback does not retry forever.
      onChange(false, []);
    }
    function resumeNetwork() {
      if (!binding || !enabled || closed) return;
      networkSuspended = false; failures.status = failures.demand = failures.control = 0;
      available = true; state = 'idle'; view += 1;
      void poll(); heartbeat = browser.setInterval(() => void submit(), 2000);
      onChange(true, []);
    }
    function dropImages() {
      for (const entry of images.values()) {
        entry.image.close?.();
        if (entry.url) browser.URL.revokeObjectURL(entry.url);
      }
      images.clear(); imageQueue.clear(); imageFailures.clear(); imageCapacityFailures.clear(); imageBytes = 0;
    }
    function abortRequests() {
      for (const controller of requests) controller.abort();
      requests.clear(); imageQueue.clear();
    }
    function active() { return !closed && enabled && available && !!binding; }
    function evict() {
      while (imageBytes > IMAGE_BUDGET && images.size) {
        const [key, entry] = images.entries().next().value;
        images.delete(key); imageBytes -= entry.bytes;
        entry.image.close?.();
        if (entry.url) browser.URL.revokeObjectURL(entry.url);
      }
    }
    function assetUrl(sample) {
      const template = sample.asset_url_template || controller.assetTemplate;
      if (!template || typeof sample.asset !== 'string') return '';
      return template.replace(/\{asset\}/g, encodeURIComponent(sample.asset))
        .replace(/\{binding\}/g, encodeURIComponent(binding))
        .replace(/\{cache_revision\}/g, encodeURIComponent(sample.cache_revision || revision));
    }
    function imageKey(sample) { return `${source}|${sample.cache_revision || revision}|${sample.asset}`; }
    async function loadImage(key, sample, epoch) {
      const abort = new browser.AbortController(); requests.add(abort); imageActive += 1; imagePending.add(key);
      const timeout = browser.setTimeout(() => abort.abort(), 8000);
      let bitmap = null, blobUrl = '';
      try {
        const response = await browser.fetch(assetUrl(sample), {signal: abort.signal, cache: 'default'});
        if (response.status === 409) { void poll(); return; }
        if (!response.ok) { imageFailures.add(key); return; }
        const blob = await response.blob();
        if (browser.createImageBitmap) bitmap = await browser.createImageBitmap(blob);
        else {
          blobUrl = browser.URL.createObjectURL(blob);
          bitmap = await new Promise((resolve, reject) => {
            const image = new browser.Image();
            image.onload = () => resolve(image); image.onerror = reject; image.src = blobUrl;
          });
        }
        if (epoch !== requestEpoch || !active()) return;
        const bytes = bitmap.width * bitmap.height * 4;
        if (bytes > IMAGE_BUDGET) { imageFailures.add(key); return; }
        for (const [oldKey, oldEntry] of images) {
          if (imageBytes + bytes <= IMAGE_BUDGET) break;
          if (protectedKeys.has(oldKey)) continue;
          images.delete(oldKey); imageBytes -= oldEntry.bytes;
          oldEntry.image.close?.(); if (oldEntry.url) browser.URL.revokeObjectURL(oldEntry.url);
        }
        // An oversized active view reduces image admission instead of thrashing its own assets.
        if (imageBytes + bytes > IMAGE_BUDGET) { imageCapacityFailures.add(key); return; }
        images.set(key, {image: bitmap, bytes, url: blobUrl});
        imageBytes += bytes; bitmap = null; blobUrl = ''; evict(); repaint(sampleRanges([...samples, ...fallbackSamples].filter(candidate => imageKey(candidate) === key)));
      } catch (_) { if (!abort.signal.aborted) imageFailures.add(key); }
      finally {
        browser.clearTimeout(timeout);
        bitmap?.close?.(); if (blobUrl) browser.URL.revokeObjectURL(blobUrl);
        requests.delete(abort); imagePending.delete(key); imageActive -= 1; drainImages();
      }
    }
    function drainImages() {
      while (active() && !networkSuspended && imageActive < 2 && imageQueue.size) {
        const [key, sample] = imageQueue.entries().next().value;
        imageQueue.delete(key); void loadImage(key, sample, requestEpoch);
      }
    }
    function preload() {
      if (!active() || networkSuspended) return;
      // Limit asset reads to this view, including the bounded neighbouring placeholder range.
      const nearby = preloadRanges;
      protectedKeys.clear();
      for (const sample of samples) {
        if (typeof sample.asset !== 'string') continue;
        if (nearby.some(range => sample.requested_ms >= range.start_ms - demand.interval_ms * 2
            && sample.requested_ms < range.end_ms + demand.interval_ms * 2)) protectedKeys.add(imageKey(sample));
      }
      for (const key of imageQueue.keys()) { if (!protectedKeys.has(key)) imageQueue.delete(key); }
      for (const sample of samples) {
        if (typeof sample.asset !== 'string') continue;
        if (!nearby.some(range => sample.requested_ms >= range.start_ms - demand.interval_ms * 2
            && sample.requested_ms < range.end_ms + demand.interval_ms * 2)) continue;
        const key = imageKey(sample);
        if (images.has(key) || imageQueue.has(key) || imagePending.has(key) || imageFailures.has(key)
            || imageCapacityFailures.has(key)) continue;
        if (imageQueue.size < 64) imageQueue.set(key, sample);
      }
      drainImages();
    }
    function ingest(result, expectedBinding, expectedView, epoch) {
      if (closed || epoch !== requestEpoch || expectedBinding !== binding || result.binding !== binding) return;
      if (expectedView !== view || Number(result.view) !== view) return;
      // A changed source cannot reuse decoded assets from the previous identity.
      const nextSource = JSON.stringify(result.source_identity || null);
      if (source && nextSource !== source) { dropImages(); fallbackSamples = []; }
      source = nextSource;
      if (result.lease) lease = result.lease;
      if (revision && result.cache_revision !== revision) {
        fallbackSamples = [...samples, ...fallbackSamples].slice(0, 384);
      }
      revision = result.cache_revision || '';
      controller.assetTemplate = result.asset_url_template || '';
      const previousSamples = samples;
      samples = Array.isArray(result.samples) ? result.samples.filter(sample =>
        Number.isFinite(sample.requested_ms)
        && ((sample.status === 'unavailable' && sample.asset == null)
          || (typeof sample.asset === 'string' && Array.isArray(sample.crop_rect) && sample.crop_rect.length === 4)))
        .map(sample => ({...sample, cache_revision:sample.cache_revision || revision})) : [];
      assets = Array.isArray(result.assets) ? result.assets : [];
      if (typeof result.persisted === 'boolean') persisted = result.persisted;
      state = result.state || 'idle';
      const nextAvailable = !['unavailable', 'error', 'cancelled'].includes(state);
      const changed = nextAvailable !== available; available = nextAvailable;
      if (!nextAvailable) {
        release(); onChange(changed, []); return;
      }
      const sampleSignature = sample => JSON.stringify([sample.asset, sample.cache_revision, sample.crop_rect, sample.status]);
      const previous = new Map(previousSamples.map(sample => [sample.requested_ms, sampleSignature(sample)]));
      const current = new Map(samples.map(sample => [sample.requested_ms, sampleSignature(sample)]));
      const changedSamples = [...samples.filter(sample => previous.get(sample.requested_ms) !== current.get(sample.requested_ms)),
        ...previousSamples.filter(sample => !current.has(sample.requested_ms))];
      preload(); onChange(changed, []); repaint(sampleRanges(changedSamples)); schedulePoll();
    }
    async function send(url, body = null, control = false) {
      const abort = new browser.AbortController(); requests.add(abort);
      if (control) { controlRequest?.abort(); controlRequest = abort; }
      const timeout = browser.setTimeout(() => abort.abort(), 8000);
      try {
        const response = await browser.fetch(url, body ? {method:'POST', signal:abort.signal,
          headers:{'Content-Type':'application/json', 'X-MAW-Request-Token':config().requestToken || ''},
          body:JSON.stringify({...body, requestToken:config().requestToken || ''})}
          : {signal:abort.signal, cache:'no-store'});
        if (!response.ok) throw new Error(`Thumbnail request ${response.status}`);
        const result = await response.json(); return result.result || result;
      } finally { browser.clearTimeout(timeout); requests.delete(abort); if (controlRequest === abort) controlRequest = null; }
    }
    function schedulePoll() {
      browser.clearTimeout(pollTimer);
      if (!binding || !enabled || closed || !available || networkSuspended) return;
      // Even ready manifests may gain compatible Launcher base sprites.
      pollTimer = browser.setTimeout(() => void poll(), state === 'ready' ? 2000 : 400);
    }
    async function poll() {
      if (!binding || !enabled || closed || networkSuspended || statusBusy || !urls().status) return;
      const epoch = requestEpoch, requestedBinding = binding, requestedView = view;
      statusBusy = true;
      try {
        const url = new browser.URL(urls().status, browser.location.href);
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('binding', binding); url.searchParams.set('view', String(view));
        if (lease) url.searchParams.set('lease', lease);
        const result = await send(url.href);
        failures.status = 0; ingest(result, requestedBinding, requestedView, epoch);
      } catch (_) { networkFailed('status', epoch, requestedView); }
      finally { statusBusy = false; }
    }
    async function submit() {
      if (!binding || !enabled || closed || !available || networkSuspended || !urls().demand) return;
      if (demandBusy) { demandAgain = true; return; }
      demandBusy = true;
      const epoch = requestEpoch, requestedBinding = binding, requestedView = view;
      try {
        const result = await send(urls().demand, {binding, lease, client_id:clientId, view, ...demand, playhead_ms:playheadMs, playing, visible:true});
        failures.demand = 0; ingest(result, requestedBinding, requestedView, epoch);
      } catch (_) { networkFailed('demand', epoch, requestedView); }
      finally {
        demandBusy = false;
        if (demandAgain) { demandAgain = false; void submit(); }
      }
    }
    function release(disposeImages = true) {
      browser.clearTimeout(debounce); browser.clearTimeout(pollTimer); browser.clearInterval(heartbeat);
      requestEpoch += 1; abortRequests();
      if (binding && urls().release) {
        const body = {binding, lease, client_id:clientId, view, requestToken:config().requestToken || ''};
        void browser.fetch(urls().release, {method:'POST', keepalive:true,
          headers:{'Content-Type':'application/json', 'X-MAW-Request-Token':config().requestToken || ''},
          body:JSON.stringify(body)}).catch(() => {});
      }
      lease = ''; if (disposeImages) { demandKey = ''; dropImages(); }
      browser.cancelAnimationFrame(paintFrame); paintFrame = 0; dirtyRanges.length = 0;
    }
    const controller = {
      assetTemplate: '',
      get visible() { return active(); },
      get enabled() { return enabled; },
      get state() { return state; },
      get persisted() { return persisted; },
      get interval() { return demand.interval_ms; },
      get bytes() { return imageBytes; },
      get manifestAssets() { return assets; },
      setBinding(next) {
        if (String(next || '') === binding) return;
        release(); binding = String(next || ''); source = ''; samples = []; fallbackSamples = []; state = 'idle'; persisted = true;
        available = !!binding && !!urls().status; networkSuspended = false;
        failures.status = failures.demand = failures.control = 0;
        view += 1; onChange(true);
        if (active()) {
          void poll(); heartbeat = browser.setInterval(() => void submit(), 2000);
        }
      },
      setEnabled(next) {
        if (!!next === enabled) return;
        enabled = !!next; try { storage.setItem('mawe-filmstrip-visible', String(enabled)); } catch (_) {}
        release(false); onChange(true);
        if (enabled && binding) {
          available = true; networkSuspended = false;
          failures.status = failures.demand = failures.control = 0;
          view += 1; void poll();
          heartbeat = browser.setInterval(() => void submit(), 2000);
        }
      },
      setPlaying(next) {
        if (!!next === playing) return;
        playing = !!next; browser.clearTimeout(debounce);
        if (!active() || networkSuspended || !urls().demand) return;
        // A newer control view prevents a late ordinary demand from restoring old playback state.
        view += 1;
        const epoch = requestEpoch, requestedBinding = binding, requestedView = view;
        void send(urls().demand, {binding, lease, client_id:clientId, view, ...demand, playhead_ms:playheadMs, playing, visible:true}, true)
          .then(result => { failures.control = 0; ingest(result, requestedBinding, requestedView, epoch); })
          .catch(() => networkFailed('control', epoch, requestedView));
      },
      setPlayhead(time) {
        if (!Number.isFinite(time)) return;
        const next = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(time)));
        if (next === playheadMs) return;
        playheadMs = next;
        // Source-time seeks only reprioritize existing targets; playback never sends per-frame work.
        if (playing || !active() || networkSuspended) return;
        browser.clearTimeout(debounce);
        debounce = browser.setTimeout(() => void submit(), 200);
      },
      setView(rows, duration) {
        if (!active()) return;
        const next = makeDemand(rows, duration, demand.interval_ms);
        const key = JSON.stringify(next);
        if (key === demandKey) { preload(); return; }
        demandKey = key; demand = next; preloadRanges = prefetchRanges(next.ranges, duration);
        // Admission pressure belongs to this view; a smaller/new view can evict old assets.
        // Transport, corrupt-image and individually oversized failures retain their bounded guard.
        imageCapacityFailures.clear();
        if (networkSuspended) { resumeNetwork(); return; }
        view += 1;
        browser.clearTimeout(debounce); preload();
        debounce = browser.setTimeout(() => void submit(), 200);
      },
      picture(time, maxDistance) {
        // A known source-time cell without video is authoritative. Nearby/future pictures
        // and compatible older assets may fill a cache miss, but never this explicit gap.
        if (samples.some(sample => sample.status === 'unavailable' && sample.asset == null
            && time >= sample.requested_ms && time < sample.requested_ms + demand.interval_ms)) return null;
        let best = null, distance = Infinity;
        for (const sample of [...samples, ...fallbackSamples]) {
          if (typeof sample.asset !== 'string') continue;
          const delta = Math.abs(sample.requested_ms - time);
          if (delta > maxDistance || delta >= distance) continue;
          const key = imageKey(sample), entry = images.get(key);
          if (!entry) continue;
          best = {image:entry.image, crop:sample.crop_rect, status:sample.status}; distance = delta;
          images.delete(key); images.set(key, entry);
        }
        return best;
      },
      retry() {
        if (!binding || !enabled || closed) return;
        release(false); resumeNetwork();
      },
      close() { release(); closed = true; browser.cancelAnimationFrame(paintFrame); },
    };
    return controller;
  }
  return { createController, chooseInterval, mergeRanges, gridTargets, makeDemand, prefetchRanges, IMAGE_BUDGET, DISPLAY_WIDTH };
}
