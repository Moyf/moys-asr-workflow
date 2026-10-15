import { FrameCache, displayToSource, visibleSamples, nearestFrame, eventOnce, seekFrame } from './core.mjs';
import { createWaveformModule } from '/scale.mjs';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wave = createWaveformModule({ clamp, MAX_WAVEFORM_SCALE: 10, MIN_WAVEFORM_SCALE: 0.25 });
const $ = (id) => document.getElementById(id);
const player = $('player'), decoder = $('decoder'), cache = new FrameCache();
const sprites = new Map(), portable = window.FILMSTRIP_PORTABLE;
let config, media, waveform, controller, objectUrl, serial = Promise.resolve(), generation = 0;
let loadGeneration = 0;
let cancellation = Promise.resolve();
let zoom = 1, timelineRows = [], measurement = {}, pending = 0;
let mainSeeks = 0; player.addEventListener('seeking', () => mainSeeks++);
const gaps = () => $('gap').checked ? [{ start: Math.round(media.duration * 250), end: Math.round(media.duration * 350), removed: true }] : [];
const intervals = () => window.AsrGapRemoveCore.buildGapRemovedIntervals(Math.round(media.duration * 1000), gaps());
const duration = () => intervals().reduce((n, x) => n + x.end - x.start, 0);
const sourceToDisplay = (ms) => window.AsrGapRemoveCore.mapGapRemovedTime(ms, gaps());
function cancelServer() {
  if (config?.token && !portable) cancellation = cancellation.catch(() => {}).then(() =>
    fetch('/api/cancel', { method: 'POST', headers: { 'X-Lab-Token': config.token },
      signal: AbortSignal.timeout(5000) }).catch(() => {}));
  return cancellation;
}
function reset() {
  cancelServer();
  controller?.abort(); controller = new AbortController(); generation++;
  cache.clear(); measurement = {}; $('metrics').textContent = '等待新视图'; $('status').textContent = '准备当前视图…';
}
function download(data, name, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function updateMetrics() {
  measurement.cacheBytes = cache.bytes; measurement.cachedFrames = cache.items.size;
  measurement.mainSeeks = mainSeeks;
  $('metrics').textContent = JSON.stringify(measurement, null, 2);
}
function geometry(row) {
  const width = row.scroller.clientWidth;
  const start = (row.scroller.scrollLeft / zoom) * 1000;
  const span = Math.min(duration() - start, width / zoom * 1000);
  return { width, start, span };
}
function cellsFor(row) {
  const { width, start, span } = geometry(row);
  return visibleSamples(start, span, width, Number($('density').value), intervals(), media.duration * 1000);
}
function makeRows() {
  timelineRows.forEach(r => r.localSprite?.image.close());
  $('timelines').replaceChildren(); timelineRows = [];
  for (let i = 0; i < Number($('rows').value); i++) {
    const row = document.createElement('div'); row.className = 'timeline';
    const label = document.createElement('p'); label.className = 'row-label'; label.textContent = '视窗 ' + (i + 1) + ' · 源时间定位';
    const scroller = document.createElement('div'); scroller.className = 'scroller';
    const spacer = document.createElement('div'); spacer.className = 'spacer';
    const canvas = document.createElement('canvas'); canvas.className = 'viewport';
    spacer.append(canvas); scroller.append(spacer); row.append(label, scroller); $('timelines').append(row);
    const state = { row, scroller, spacer, canvas, cells: [], localSprite: null };
    timelineRows.push(state);
    scroller.addEventListener('scroll', () => {
      clearTimeout(pending); pending = setTimeout(() => renderView(), 100);
      draw(state);
    });
    let dragging = false;
    const seek = (event) => {
      const g = geometry(state), rect = canvas.getBoundingClientRect();
      const ms = displayToSource(g.start + clamp(event.clientX - rect.left, 0, g.width) / g.width * g.span, intervals());
      player.currentTime = Math.min(media.duration - 0.001, ms / 1000);
      $('player-state').textContent = '定位源时间 ' + (ms / 1000).toFixed(3) + ' s';
    };
    canvas.addEventListener('pointerdown', e => { dragging = true; canvas.setPointerCapture(e.pointerId); seek(e); });
    canvas.addEventListener('pointermove', e => { if (dragging) seek(e); });
    canvas.addEventListener('pointerup', () => dragging = false);
    canvas.addEventListener('pointercancel', () => dragging = false);
  }
  layout();
  timelineRows.forEach((r, i) => { r.scroller.scrollLeft = i * r.scroller.clientWidth; });
}
function layout() {
  zoom = Math.pow(10, Number($('zoom').value) / 25 - 2);
  timelineRows.forEach((row) => {
    row.spacer.style.width = Math.max(row.scroller.clientWidth, duration() / 1000 * zoom) + 'px';
    draw(row);
  });
}
function draw(row) {
  const g = geometry(row), ctx = row.canvas.getContext('2d');
  const strip = media.videos.length && !$('collapse').checked ? Number($('height').value) : 0;
  const total = 34 + 64 + 32 + (strip ? strip + 8 : 0);
  row.canvas.width = g.width; row.canvas.height = total;
  ctx.fillStyle = '#111e27'; ctx.fillRect(0, 0, g.width, total);
  ctx.font = '11px system-ui'; ctx.fillStyle = '#a9c6cf';
  for (let i = 0; i <= 5; i++) ctx.fillText(((g.start + g.span * i / 5) / 1000).toFixed(1) + 's', g.width * i / 5 + 3, 20);
  const pos = $('position').value;
  const stripY = pos === 'above' ? 34 : pos === 'between' ? 106 : 138;
  const waveY = pos === 'above' && strip ? stripY + strip + 8 : 34;
  const cuesY = pos === 'between' && strip ? stripY + strip + 8 : waveY + 72;
  const samples = cellsFor(row);
  if (waveform) {
    // Actual waveform samples reused from maw.waveform, not a decorative sine.
    const segments = Math.max(1, Math.ceil(g.width));
    for (let x = 0; x < segments; x++) {
      const a = displayToSource(g.start + g.span * x / segments, intervals());
      const b = displayToSource(g.start + g.span * (x + 1) / segments, intervals());
      const e = wave.buildWaveformEnvelope(waveform.peaks, waveform.peaks_per_second, waveform.peak_count, a, b, 1);
      ctx.strokeStyle = '#7acaba'; ctx.beginPath();
      ctx.moveTo(x, waveY + 32 + e.low[0] / 127 * 25); ctx.lineTo(x, waveY + 32 + e.high[0] / 127 * 25); ctx.stroke();
    }
  } else {
    ctx.fillStyle = '#6e8793'; ctx.fillText('无波形缓存 / 无音频 · 非实际编辑器', 12, waveY + 36);
  }
  samples.forEach((cell, i) => {
    ctx.fillStyle = i % 2 ? '#345674' : '#3e637e';
    ctx.fillRect(cell.x + 2, cuesY, cell.width - 4, 24);
    ctx.fillStyle = '#dbe6ee'; ctx.fillText('演示 cue ' + i, cell.x + 5, cuesY + 16);
    if (!strip) return;
    let imageTime = cell.sourceMs;
    const bitmap = cache.get(frameKey(cell.sourceMs));
    const sprite = row.localSprite || sprites.get(spriteKey());
    if (bitmap && ['browser', 'hybrid'].includes($('route').value)) {
      ctx.drawImage(bitmap, cell.x, stripY, cell.width - 2, strip);
    } else if (sprite) {
      const index = nearestFrame(sprite.times, cell.sourceMs), c = sprite.config.columns;
      imageTime = sprite.times[index];
      ctx.drawImage(sprite.image, index % c * 160, Math.floor(index / c) * 90, 160, 90, cell.x, stripY, cell.width - 2, strip);
    } else {
      ctx.fillStyle = '#233b48'; ctx.fillRect(cell.x, stripY, cell.width - 2, strip);
    }
    ctx.fillStyle = '#0a1624c9'; ctx.fillRect(cell.x, stripY + strip - 17, cell.width - 2, 17);
    ctx.fillStyle = '#def0ee'; ctx.fillText('≈' + (imageTime / 1000).toFixed(1) + 's', cell.x + 5, stripY + strip - 5);
  });
  ctx.strokeStyle = '#ffd185'; ctx.beginPath();
  const playX = (sourceToDisplay(player.currentTime * 1000) - g.start) / g.span * g.width;
  ctx.moveTo(playX, 28); ctx.lineTo(playX, total); ctx.stroke();
  $('window-label').textContent = (g.start / 1000).toFixed(1) + ' – ' + ((g.start + g.span) / 1000).toFixed(1) + ' s';
}
const frameKey = ms => media.id + ':' + $('stream').value + ':' + Math.round(ms);
const spriteKey = () => media.id + ':' + $('stream').value + ':' + ($('route').value === 'adaptive' ? 'adaptive' : 'fixed');
async function serverSprite(row, signal) {
  const route = $('route').value, windowed = route === 'window';
  const cached = windowed ? null : sprites.get(spriteKey());
  if (cached) { measurement.spriteMemoryHit = true; return cached; }
  if (portable || media.id === 'local') throw new Error('该媒体没有 Server sprite；请选择 B');
  const samples = cellsFor(row);
  const g = geometry(row);
  const sourceStart = displayToSource(g.start, intervals()) / 1000;
  const sourceEnd = Math.min(media.duration, displayToSource(g.start + g.span, intervals()) / 1000);
  const body = { media: media.id, stream: Number($('stream').value),
    mode: windowed ? 'window' : route === 'adaptive' ? 'adaptive' : 'fixed',
    start: windowed ? sourceStart : 0, span: windowed ? sourceEnd - sourceStart : media.duration,
    count: windowed ? Math.min(32, samples.length) : 100 };
  await cancellation;
  if (signal.aborted) throw new DOMException('Superseded', 'AbortError');
  const response = await fetch('/api/job', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lab-Token': config.token },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Server refused job');
  const { job } = await response.json();
  if (signal.aborted) { cancelServer(); throw new DOMException('Superseded', 'AbortError'); }
  const onAbort = () => cancelServer();
  signal.addEventListener('abort', onAbort, { once: true });
  let result;
  while (true) {
    await new Promise((resolve, reject) => {
      const done = () => { signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(done, 100);
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Superseded', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const r = await (await fetch('/api/job/' + job, { signal })).json();
    if (r.state === 'error') throw new Error(r.error);
    if (r.state === 'cancelled') throw new DOMException('Superseded', 'AbortError');
    if (r.state === 'done') { result = r.result; break; }
  }
  signal.removeEventListener('abort', onAbort);
  const blob = await (await fetch('/sprite/' + result.key, { signal })).blob();
  const image = await createImageBitmap(blob);
  if (signal.aborted) { image.close(); throw new DOMException('Superseded', 'AbortError'); }
  const sprite = { ...result, image, blob };
  measurement.spriteBytes = result.bytes; measurement.serverCacheHit = result.hit;
  measurement.serverSeconds = result.elapsed; measurement.sampleCount = result.times.length;
  if (!windowed) {
    sprites.set(spriteKey(), sprite);
    while (sprites.size > 4) {
      const oldest = sprites.keys().next().value;
      sprites.get(oldest).image.close(); sprites.delete(oldest);
    }
  }
  return sprite;
}
async function browserFrames(row, signal, first, began) {
  if (decoder.readyState < 2 && !decoder.error) await eventOnce(decoder, 'loadeddata', signal);
  if (!decoder.videoWidth || decoder.error) throw new Error('浏览器无法解码；A 可独立生成缩略图');
  // HTMLVideoElement has no portable API for selecting alternate video streams.
  if (Number($('stream').value) !== media.videos[0]?.index) throw new Error('浏览器路线只支持浏览器默认视频流');
  for (const cell of cellsFor(row)) {
    const key = frameKey(cell.sourceMs);
    if (cache.get(key)) { measurement.hits = (measurement.hits || 0) + 1; draw(row); first(began); continue; }
    const bitmap = await seekFrame(decoder, cell.sourceMs / 1000, signal);
    cache.set(key, bitmap, 160 * 90 * 4); measurement.decoded = (measurement.decoded || 0) + 1;
    draw(row); first(began);
  }
}
async function renderView() {
  controller?.abort(); controller = new AbortController(); const signal = controller.signal;
  const viewGeneration = ++generation;
  // Serialize use of the one independent decoder; abort before the next view.
  serial = serial.catch(() => {}).then(async () => {
    if (signal.aborted) return;
    $('status').textContent = '正在生成当前窗口…';
    const began = performance.now(), baseline = player.currentTime, baselineSeeks = mainSeeks;
    measurement = { route: $('route').value, media: media.name, duration: media.duration,
      generation: viewGeneration, visibleFrames: 0, decoded: 0, hits: 0 };
    const first = () => {
      if (measurement.firstVisibleMs === undefined) measurement.firstVisibleMs = performance.now() - began;
    };
    try {
      if (!media.videos.length || $('collapse').checked) {
        timelineRows.forEach(draw); $('status').textContent = '缩略图已隐藏，播放器与波形仍可用'; return;
      }
      for (const row of timelineRows) {
        row.localSprite?.image.close(); row.localSprite = null;
        const route = $('route').value;
        if (route !== 'browser') {
          const sprite = await serverSprite(row, signal);
          if (signal.aborted) break;
          if (route === 'window') row.localSprite = sprite;
          draw(row); first();
        }
        if (route === 'browser' || route === 'hybrid') await browserFrames(row, signal, first, began);
        measurement.visibleFrames += cellsFor(row).length;
      }
      if (signal.aborted) return;
      measurement.completeMs = performance.now() - began;
      measurement.primaryClockDelta = player.currentTime - baseline;
      measurement.backgroundPrimarySeeks = mainSeeks - baselineSeeks;
      $('status').textContent = '完成当前窗口；水平滚动 / 缩放触发新代次，取消旧抽帧。';
    } catch (error) {
      if (error.name !== 'AbortError') {
        measurement.error = error.message; $('status').textContent = error.message;
      }
    } finally {
      if (!signal.aborted) updateMetrics();
    }
  });
  return serial;
}
async function loadMedia() {
  const loadId = ++loadGeneration;
  reset(); media = config.media.find(m => m.id === $('media').value);
  $('stream').replaceChildren(...media.videos.map(v => {
    const option = document.createElement('option'); option.value = v.index;
    option.textContent = '#' + v.index + ' ' + v.codec_name + ' ' + v.width + '×' + v.height; return option;
  }));
  if (portable && media.id === 'portable') $('stream').value = String(portable.sprite.config.stream);
  if (media.id !== 'portable') player.src = media.id === 'local' ? objectUrl : '/media/' + media.id;
  decoder.src = player.src;
  waveform = null;
  if (!portable && media.id !== 'local') {
    const payload = await (await fetch('/api/wave/' + media.id)).json();
    if (loadId !== loadGeneration) return;
    waveform = payload.waveform;
  } else waveform = portable?.waveform || null;
  if (waveform) waveform.peaks = Int8Array.from(atob(waveform.data), c => c.charCodeAt(0));
  makeRows(); await renderView();
}
$('file').addEventListener('change', async () => {
  const file = $('file').files[0]; if (!file) return;
  reset(); if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  decoder.src = objectUrl;
  try { await eventOnce(decoder, 'loadedmetadata', controller.signal); }
  catch (error) { $('status').textContent = error.message; return; }
  const local = { id: 'local', name: file.name, duration: decoder.duration,
    videos: decoder.videoWidth ? [{ index: 0, codec_name: 'browser', width: decoder.videoWidth, height: decoder.videoHeight }] : [] };
  // Local replacement cannot reuse a prior sprite without signature equality.
  for (const value of sprites.values()) value.image.close(); sprites.clear();
  if (portable?.sprite?.config.stream === 0 && portable?.sprite?.identity.source.name === file.name
      && portable.sprite.identity.source.size === file.size
      && portable.sprite.identity.source.modified_ms === file.lastModified) {
    const blob = await (await fetch(portable.sprite.dataUrl)).blob();
    const image = await createImageBitmap(blob);
    sprites.set('local:0:fixed', { ...portable.sprite, image, blob });
  }
  config.media = config.media.filter(m => m.id !== 'local'); config.media.push(local);
  const option = document.createElement('option'); option.value = 'local'; option.textContent = file.name + ' · 本地';
  $('media').append(option); $('media').value = 'local';
  $('route').value = sprites.size ? 'hybrid' : 'browser'; await loadMedia();
});
$('media').addEventListener('change', loadMedia);
$('refresh').addEventListener('click', () => {
  reset(); for (const sprite of sprites.values()) sprite.image.close(); sprites.clear(); renderView();
});
for (const id of ['route', 'stream', 'height', 'density', 'position', 'gap', 'collapse']) {
  $(id).addEventListener('change', () => { reset(); layout(); renderView(); });
}
$('rows').addEventListener('change', () => { reset(); makeRows(); renderView(); });
$('zoom').addEventListener('input', () => { layout(); clearTimeout(pending); pending = setTimeout(renderView, 100); });
window.addEventListener('resize', () => { layout(); clearTimeout(pending); pending = setTimeout(renderView, 100); });
player.addEventListener('timeupdate', () => timelineRows.forEach(draw));
$('save-metrics').addEventListener('click', () => download(JSON.stringify(measurement, null, 2), 'filmstrip-measurement.json'));
$('export').addEventListener('click', async () => {
  try {
    const sprite = sprites.get(spriteKey()) || timelineRows[0]?.localSprite;
    if (!sprite) throw new Error('先完成一条 A 路线，再导出便携页');
    const dataUrl = await new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(sprite.blob); });
    const [html, css, js, gap] = await Promise.all(['/','/lab.css','/lab-inline.js','/gap.js'].map(p => fetch(p).then(r => {
      if (!r.ok) throw new Error('先运行 build.mjs'); return r.text();
    })));
    const { image, blob, ...meta } = sprite;
    const payload = { media: [{ ...media, id: 'portable' }], waveform: waveform ? { ...waveform, peaks: undefined } : null,
      sprite: { ...meta, dataUrl } };
    const safe = s => s.replace(/<\/script/gi, '<\\/script');
    const output = html.replace('<link rel="stylesheet" href="/lab.css">', '<style>' + css + '</style>')
      .replace('<script src="/gap.js"></script><script type="module" src="/lab.mjs"></script>',
        '<script>window.FILMSTRIP_PORTABLE=' + safe(JSON.stringify(payload)) + ';</script><script>' + safe(gap) + '</script><script>' + safe(js) + '</script>');
    measurement.portableBytes = new Blob([output]).size; updateMetrics();
    download(output, 'filmstrip-portable.html', 'text/html');
  } catch (error) { $('status').textContent = error.message; }
});
async function init() {
  config = portable || await (await fetch('/api/config')).json();
  $('media').replaceChildren(...config.media.map(m => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.name; return o; }));
  if (portable) {
    const blob = await (await fetch(portable.sprite.dataUrl)).blob();
    sprites.set('portable:' + portable.sprite.config.stream + ':fixed', { ...portable.sprite, image: await createImageBitmap(blob), blob });
    $('export').disabled = true; $('route').value = 'fixed';
  }
  await loadMedia();
}
init().catch(error => { $('status').textContent = error.message; });
