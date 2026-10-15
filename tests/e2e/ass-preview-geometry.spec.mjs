import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWaveformPayload,
  makeTempDir, startServer } from './helpers.mjs';

let tempDir;
let server;
let portraitServer;
test.beforeAll(async () => {
  tempDir = makeTempDir('ass-preview-geometry');
  const media = join(tempDir, 'video.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=4:r=10', '-c:v', 'libx264', '-y', media]);
  const project = join(tempDir, 'project.json');
  writeFileSync(project, JSON.stringify({ media: 'video.mp4',
    segments: [{ start: 0, end: 4000, text: 'ASS 字幕预览 OwO' }],
    waveform: generateWaveformPayload(4000) }));
  server = await startServer(project, media, await findFreePort());
  const portraitMedia = join(tempDir, 'portrait.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=360x640:d=4:r=10', '-c:v', 'libx264', '-y', portraitMedia]);
  const portraitProject = join(tempDir, 'portrait.json');
  writeFileSync(portraitProject, JSON.stringify({ media: 'portrait.mp4',
    segments: [{ start: 0, end: 4000, text: '竖屏字幕 OwO' }],
    waveform: generateWaveformPayload(4000) }));
  portraitServer = await startServer(portraitProject, portraitMedia, await findFreePort());
});
test.afterAll(async () => { await portraitServer?.stop(); await server?.stop(); if (tempDir) cleanupTempDir(tempDir); });

async function prepare(page, url = server.url, videoWidth = 640) {
  await disableOnboarding(page);
  await page.goto(url);
  await page.waitForFunction(width => window.MaweCoreState?.player?.videoWidth === width, videoWidth);
  await page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
}

test('paused video refreshes resized ASS geometry during repeated layout events', async ({ page }) => {
  await prepare(page);
  const frames = await page.evaluate(async () => {
    const stage = MaweDom.playerStage;
    const rect = stage.getBoundingClientRect();
    // The browser supplies successive transition boxes, all with usable sizes.
    // Dispatch resize on every frame so a trailing debounce cannot settle.
    stage.getBoundingClientRect = () => ({ ...rect.toJSON(), width: 480, height: 270 });
    const result = [];
    for (let i = 0; i < 8; i++) {
      window.dispatchEvent(new Event('resize'));
      await new Promise(resolve => requestAnimationFrame(resolve));
      result.push({ width: Number.parseFloat(MaweDom.overlayEl.style.width),
        height: Number.parseFloat(MaweDom.overlayEl.style.height) });
    }
    delete stage.getBoundingClientRect;
    return result;
  });
  expect(frames[1].width).toBeCloseTo(480, 0);
  expect(frames[1].height).toBeCloseTo(270, 0);
  for (const frame of frames.slice(1)) expect(frame.width / frame.height).toBeCloseTo(16 / 9, 3);
});

test('sample fits a narrow card without changing its aspect ratio', async ({ page }) => {
  await prepare(page);
  const sizes = await page.evaluate(() => {
    const card = document.createElement('div');
    card.className = 'ass-style-preview-card';
    card.style.cssText = 'width:260px;box-sizing:border-box';
    const canvas = document.createElement('canvas');
    canvas.id = 'ass-style-preview-sample';
    card.append(canvas);
    document.body.append(card);
    MaweAssCanvas.renderSample(canvas, AsrEditorUtils.assStyleForId(
      AsrEditorUtils.defaultAssStyleLibrary(), 'ass'), 'ASS 字幕预览 OwO');
    const bounds = canvas.getBoundingClientRect();
    const result = { width: bounds.width, height: bounds.height, ratio: canvas.width / canvas.height,
      scroll: card.scrollWidth, client: card.clientWidth };
    card.remove();
    return result;
  });
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
  expect(sizes.width / sizes.height).toBeCloseTo(sizes.ratio, 2);
});

for (const portrait of [false, true]) {
  test(`native fullscreen keeps ${portrait ? 'portrait' : 'landscape'} video and ASS Canvas geometry aligned`, async ({ page }) => {
    await prepare(page, portrait ? portraitServer.url : server.url, portrait ? 360 : 640);
    const telemetry = [];
    try {
      for (const playing of [false, true]) {
        await page.evaluate(async play => {
          if (play) await MaweCoreState.player.play(); else MaweCoreState.player.pause();
        }, playing);
        for (const fullscreen of [true, false]) {
          await page.locator('#media-fullscreen').click();
          await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(fullscreen);
          const frames = await page.evaluate(async () => {
            const result = [];
            for (let i = 0; i < 8; i++) {
              await new Promise(resolve => requestAnimationFrame(resolve));
              const video = MaweCoreState.player;
              const stage = MaweDom.playerStage.getBoundingClientRect();
              const overlay = MaweDom.overlayEl.getBoundingClientRect();
              const canvas = document.querySelector('.ass-preview-canvas').getBoundingClientRect();
              const aspect = video.videoWidth / video.videoHeight;
              result.push({ timestamp: performance.now(), inline: { width: MaweDom.overlayEl.style.width,
                height: MaweDom.overlayEl.style.height, left: MaweDom.overlayEl.style.left, top: MaweDom.overlayEl.style.top }, stage: [stage.width, stage.height], video: [video.videoWidth, video.videoHeight],
                overlay: [overlay.width, overlay.height], canvas: [canvas.width, canvas.height],
                expected: [Math.min(stage.width, stage.height * aspect), Math.min(stage.height, stage.width / aspect)] });
            }
            return result;
          });
          telemetry.push({ playing, fullscreen, frames });
          for (const frame of frames.slice(1)) {
            expect(frame.overlay[0]).toBeCloseTo(frame.expected[0], 0);
            expect(frame.overlay[1]).toBeCloseTo(frame.expected[1], 0);
            expect(frame.canvas[0] / frame.canvas[1]).toBeCloseTo(frame.video[0] / frame.video[1], 3);
          }
        }
      }
    } finally {
      const artifacts = join(process.cwd(), '.artifacts', 'ass-preview-geometry');
      mkdirSync(artifacts, { recursive: true });
      const telemetryJson = JSON.stringify(telemetry, null, 2);
      writeFileSync(join(artifacts, `${portrait ? 'portrait' : 'landscape'}-frames.json`), telemetryJson);
      writeFileSync(test.info().outputPath('fullscreen-frames.json'), telemetryJson);
      await page.screenshot({ path: join(artifacts, `${portrait ? 'portrait' : 'landscape'}.png`) }).catch(() => {});
    }
  });
}

test('failed cross-type media import restores observation of the original video', async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.ResizeObserver;
    window.__resizeObservers = [];
    window.ResizeObserver = class extends Original {
      constructor(callback) { super(callback); this.targets = new Set(); window.__resizeObservers.push(this); }
      observe(target, options) { this.targets.add(target); return super.observe(target, options); }
      unobserve(target) { this.targets.delete(target); return super.unobserve(target); }
      disconnect() { this.targets.clear(); return super.disconnect(); }
    };
  });
  await prepare(page);
  const result = await page.evaluate(async () => {
    const original = MaweCoreState.player;
    const observer = window.__resizeObservers.find(item => item.targets.has(original));
    const imported = await MaweMediaLoad.loadMediaFile(new File(['invalid audio data'], 'invalid.wav', { type: 'audio/wav' }));
    return { imported, restored: MaweCoreState.player === original,
      attached: document.getElementById('player') === original,
      observed: observer.targets.has(original),
      detachedTargets: [...observer.targets].filter(target => !target.isConnected).length };
  });
  expect(result).toEqual({ imported: false, restored: true, attached: true,
    observed: true, detachedTargets: 0 });
});

test('real resize observers never replace the ASS Canvas box with CSS subtitle geometry', async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.ResizeObserver;
    window.__assResizeEvents = [];
    window.ResizeObserver = class extends Original {
      constructor(callback) {
        super((entries, observer) => {
          callback(entries, observer);
          if (window.MaweSettings?.EDITOR_SETTINGS?.assMode === true && window.MaweDom?.overlayEl) {
            window.__assResizeEvents.push({ time: performance.now(), width: MaweDom.overlayEl.style.width,
              height: MaweDom.overlayEl.style.height, targets: entries.map(entry => entry.target.id || entry.target.className) });
          }
        });
      }
    };
  });
  await prepare(page);
  await page.evaluate(() => {
    window.__assResizeEvents.length = 0;
    MaweDom.playerStage.style.width = '80%';
  });
  await expect.poll(() => page.evaluate(() => window.__assResizeEvents.length)).toBeGreaterThan(0);
  const events = await page.evaluate(() => window.__assResizeEvents);
  const artifacts = join(process.cwd(), '.artifacts', 'ass-preview-geometry');
  mkdirSync(artifacts, { recursive: true });
  const eventJson = JSON.stringify(events, null, 2);
  writeFileSync(join(artifacts, 'resize-observer-writes.json'), eventJson);
  writeFileSync(test.info().outputPath('resize-observer-writes.json'), eventJson);
  expect(events.filter(event => event.width.endsWith('%') || event.height.endsWith('%'))).toEqual([]);
});

test('ASS stores CSS geometry without applying it and restores it immediately when disabled', async ({ page }) => {
  await prepare(page);
  const result = await page.evaluate(() => {
    const geometry = { x: .2, y: .3, width: .4, height: .2 };
    const style = () => ({ left: MaweDom.overlayEl.style.left, top: MaweDom.overlayEl.style.top,
      width: MaweDom.overlayEl.style.width, height: MaweDom.overlayEl.style.height });
    const before = style();
    MawePreviewGeometry.setPreviewGeometry(geometry);
    const duringAss = style();
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const restored = style();
    MawePreviewGeometry.applyPreviewGeometryToDom({ x: .1, y: .1, width: .5, height: .3 });
    return { before, duringAss, restored, ordinaryCss: style() };
  });
  expect(result.duringAss).toEqual(result.before);
  expect(result.restored).toEqual({ left: '20%', top: '30%', width: '40%', height: '20%' });
  expect(result.ordinaryCss).toEqual({ left: '10%', top: '10%', width: '50%', height: '30%' });
});
