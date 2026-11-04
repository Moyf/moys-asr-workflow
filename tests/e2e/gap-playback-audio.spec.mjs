import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, generateWaveformPayload,
  makeTempDir, startServer } from './helpers.mjs';

let directory, server;
test.beforeAll(async () => {
  directory = makeTempDir('gap-playback-audio');
  const media = join(directory, 'tone.wav'), project = join(directory, 'project.mosp');
  generateWav(media, 4);
  const bytes = readFileSync(media);
  // Audible content exists only inside the removed interval. Its small inset
  // avoids treating decoder resampling at the cut itself as a leaked syllable.
  for (let i = 0; i < (bytes.length - 44) / 2; i++) {
    const seconds = i / 8000;
    bytes.writeInt16LE(seconds >= 1.02 && seconds < 1.9
      ? Math.round(4000 * Math.sin(2 * Math.PI * 440 * seconds)) : 0, 44 + i * 2);
  }
  writeFileSync(media, bytes);
  writeFileSync(project, JSON.stringify({ media, segments: [{ id: 'cue', start: 0, end: 3000, text: '试听' }],
    waveform: generateWaveformPayload(4000), gap_remove: { skip_playback: true,
      gaps: [{ start: 1000, end: 2000, removed: true }] } }));
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });
test.beforeEach(async ({ page }, info) => {
  await disableOnboarding(page);
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false }));
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(...args) { super(...args); window.sampleContext = this; }
      createGain() {
        const node = super.createGain(), connect = node.connect.bind(node), context = this;
        node.connect = function(destination, ...args) {
          if (destination === context.destination) window.sampleOutput = node;
          return connect(destination, ...args);
        };
        return node;
      }
    };
  });
  await page.goto(server.url);
  await expect(page.locator('.cue[data-idx="0"]')).toBeVisible();
  await page.evaluate(() => { MaweCoreState.player.currentTime = .5; MaweCoreState.player.volume = .6; });
  if (info.title.includes('default project gain')) return;
  await page.locator('#audio-processing-toggle').click();
  await page.locator('#audio-gain-down').click();
  await installProbe(page);
});

async function installProbe(page) {
  await expect.poll(() => page.evaluate(() => Boolean(window.sampleOutput))).toBe(true);
  await page.evaluate(async () => {
    // AudioWorklet runs on the audio thread while the page thread is blocked.
    const source = `class Probe extends AudioWorkletProcessor {
      constructor() { super(); this.maximum = 0; this.frames = 0; this.firstTone = null;
        this.port.onmessage = () => this.port.postMessage({ maximum: this.maximum, frames: this.frames, firstTone: this.firstTone }); }
      process(inputs) { for (const channel of inputs[0] || []) {
        this.frames += channel.length; for (const sample of channel) { this.maximum = Math.max(this.maximum, Math.abs(sample));
          if (Math.abs(sample) > .005 && this.firstTone === null) this.firstTone = currentTime; }
      } return true; }
    } registerProcessor('gap-probe', Probe);`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { await window.sampleContext.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    window.sampleProbe = new AudioWorkletNode(window.sampleContext, 'gap-probe');
    window.sampleOutput.connect(window.sampleProbe);
    window.sampleProbe.connect(window.sampleContext.destination);
    await window.sampleContext.resume();
  });
}

async function samples(page) {
  return page.evaluate(() => new Promise(resolve => {
    window.sampleProbe.port.onmessage = event => resolve(event.data);
    window.sampleProbe.port.postMessage('read');
  }));
}

test('removed speech stays inaudible when a busy page delays the boundary seek', async ({ page }) => {
  await page.evaluate(() => {
    MaweCoreState.player.addEventListener('playing', () => {
      const block = () => {
        if (MaweCoreState.player.currentTime < .82) { requestAnimationFrame(block); return; }
        window.busyStart = MaweCoreState.player.currentTime;
        const started = performance.now(), until = started + 600;
        while (performance.now() < until) { /* Deliberately delay visual refresh and timers. */ }
        window.busyDuration = performance.now() - started;
      };
      requestAnimationFrame(block);
    }, { once: true });
  });
  await page.locator('#media-play-toggle').click();
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.currentTime), { timeout: 10000 }).toBeGreaterThan(2.1);
  await page.evaluate(() => MaweCoreState.player.pause());
  const measured = await samples(page);
  const busy = await page.evaluate(() => ({ start: window.busyStart, duration: window.busyDuration }));
  console.log(JSON.stringify({ measured, busy }));
  expect(busy.start).toBeLessThan(1);
  // currentTime is stable within one JS task; elapsed wall time establishes
  // that this deliberate stall spans the audible inset of the removed range.
  expect(busy.start + busy.duration / 1000).toBeGreaterThan(1.02);
  expect(measured.frames).toBeGreaterThan(8000);
  expect(measured.maximum).toBeLessThan(.005);
  expect(await page.evaluate(() => ({ volume: MaweCoreState.player.volume, muted: MaweCoreState.player.muted })))
    .toEqual({ volume: .6, muted: false });
});

test('explicit region audition plays the same removed speech and releases the audio gate', async ({ page }) => {
  await page.evaluate(() => MaweMediaPlayback.auditionRange(900, 2100));
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.paused), { timeout: 10000 }).toBe(true);
  expect((await samples(page)).maximum).toBeGreaterThan(.05);
  await page.evaluate(() => {
    MaweCoreState.player.currentTime = 1.2;
    MaweMediaPlayback.togglePlayback();
  });
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.currentTime)).toBeGreaterThanOrEqual(2);
});

test('default project gain prepares the gap gate on the first playback gesture', async ({ page }) => {
  expect(await page.evaluate(() => MaweAudioProcessing.settings().gain_db)).toBe(0);
  await page.locator('#media-play-toggle').click();
  await installProbe(page);
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.currentTime), { timeout: 10000 }).toBeGreaterThan(2.1);
  await page.evaluate(() => MaweCoreState.player.pause());
  const measured = await samples(page);
  expect(measured.frames).toBeGreaterThan(8000);
  expect(measured.maximum).toBeLessThan(.005);
});
