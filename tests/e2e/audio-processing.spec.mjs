import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, generateWaveformPayload,
  makeTempDir, startServer } from './helpers.mjs';

let dir, server, project;
test.beforeAll(async () => {
  dir = makeTempDir('audio-processing');
  const media = join(dir, 'tone.wav');
  generateWav(media, 12);
  const bytes = readFileSync(media);
  for (let i = 0; i < (bytes.length - 44) / 2; i++) bytes.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 440 * i / 8000)), 44 + i * 2);
  writeFileSync(media, bytes);
  project = join(dir, 'project.mosp');
  writeFileSync(project, JSON.stringify({ media, segments: [{ id: 'one', start: 100, end: 1000, text: '音量' }],
    waveform: generateWaveformPayload(12000) }));
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(dir); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false }));
    // Observe real samples downstream of the real GainNode. No audio graph,
    // gain calculations, AudioContext state or media decoding is mocked.
    const NativeAudioContext = window.AudioContext;
    window.audioSourceCount = 0;
    window.AudioContext = class extends NativeAudioContext {
      createGain() {
        const gain = super.createGain();
        window.audioGainNode = gain;
        window.gainAnalyser = this.createAnalyser();
        gain.connect(window.gainAnalyser);
        return gain;
      }
      createMediaElementSource(element) { window.audioSourceCount++; return super.createMediaElementSource(element); }
    };
  });
  await page.goto(server.url);
  await expect(page.locator('.cue[data-idx="0"]')).toBeVisible();
  await expect(page.locator('#hint-stack .hint-card')).toHaveCount(0);
});

async function rms(page) {
  return page.evaluate(() => {
    const data = new Float32Array(window.gainAnalyser.fftSize);
    window.gainAnalyser.getFloatTimeDomainData(data);
    return Math.sqrt(data.reduce((total, sample) => total + sample * sample, 0) / data.length);
  });
}

test('project gain changes actual decoded audio, preserves listening volume, and stays keyboard accessible', async ({ page }) => {
  await page.locator('#audio-processing-toggle').click();
  await expect(page.locator('#audio-processing-panel')).toBeVisible();
  await page.evaluate(() => { MaweCoreState.player.loop = true; MaweCoreState.player.volume = .5; });
  await page.locator('#audio-gain-down').click(); // -1 dB, enables graph from a real click
  await page.locator('#media-play-toggle').click();
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.paused)).toBe(false);
  // Wait for the analyser's initially silent window to fill with the known
  // decoded sine, otherwise an early baseline understates the gain ratio.
  const steadyRms = (3000 / 32768) / Math.sqrt(2) * .5 * 10 ** (-1 / 20);
  await expect.poll(() => rms(page)).toBeGreaterThan(steadyRms * .95);
  const before = await rms(page);
  await expect(page.locator('#audio-processing-panel')).toBeVisible();
  await expect(page.locator('#audio-listening-volume-value')).toHaveText('50%');
  await page.locator('#audio-gain-expanded').check();
  await expect(page.locator('#audio-gain')).toHaveAttribute('min', '-60');
  await expect(page.locator('#audio-gain')).toHaveAttribute('max', '24');
  await page.evaluate(() => {
    const slider = document.getElementById('audio-gain');
    slider.value = '-13'; slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(await page.evaluate(() => MaweAudioProcessing.settings().gain_db)).toBe(-13);
  expect(await page.evaluate(() => window.audioGainNode.gain.value)).toBeCloseTo(10 ** (-13 / 20), 5);
  await expect.poll(() => rms(page)).toBeLessThan(before * .3);
  const after = await rms(page);
  expect(20 * Math.log10(after / before)).toBeCloseTo(-12, 0);
  expect(await page.evaluate(() => MaweCoreState.player.volume)).toBe(.5);
  expect(await page.evaluate(() => window.audioSourceCount)).toBe(1);
  // Native range keys must not seek media or invoke the editor's Home command.
  await page.locator('#audio-gain').focus();
  await page.keyboard.press('Home');
  await expect(page.locator('#audio-gain')).toHaveValue('-60');
  await page.keyboard.press('End');
  await expect(page.locator('#audio-gain')).toHaveValue('24');
  await page.keyboard.press('Escape');
  await expect(page.locator('#audio-processing-panel')).not.toBeVisible();
  expect(await page.evaluate(() => document.activeElement.closest('#audio-processing-panel'))).toBeNull();
});

test('save/reload retains canonical gain; loading an older project resets it and clears the measurement', async ({ page }) => {
  await page.locator('#audio-processing-toggle').click();
  await page.locator('#audio-target').selectOption('custom');
  await page.locator('#audio-target-custom').fill('-18.5');
  await page.locator('#audio-target-custom').press('Tab');
  expect(await page.evaluate(() => MaweAudioProcessing.settings().target_lufs)).toBe(-18.5);
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await page.evaluate(() => MaweAudioProcessing.settings().target_lufs)).toBe(-14);
  await page.evaluate(() => MaweHistory.performRedo());
  expect(await page.evaluate(() => MaweAudioProcessing.settings().target_lufs)).toBe(-18.5);
  await page.evaluate(() => MaweAudioProcessing.change({ gain_db: -7 }));
  expect(await page.evaluate(() => MaweState.hasProjectChanges())).toBe(true);
  expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).audio_processing))
    .toEqual({ gain_db: -7, target_lufs: -18.5, peak_ceiling_dbtp: -1 });
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(true);
  expect(await page.evaluate(() => MaweState.hasProjectChanges())).toBe(false);
  await page.reload();
  await expect(page.locator('.cue[data-idx="0"]')).toBeVisible();
  expect(await page.evaluate(() => MaweAudioProcessing.settings().gain_db)).toBe(-7);
  await page.locator('#audio-processing-toggle').click();
  await expect(page.locator('#audio-gain')).toHaveValue('-7');
  await expect(page.locator('#audio-gain-expanded')).toBeChecked();
  await expect(page.locator('#audio-target')).toHaveValue('custom');
  await expect(page.locator('#audio-target-custom')).toHaveValue('-18.5');
  expect(JSON.parse(readFileSync(project, 'utf8')).audio_processing.gain_db).toBe(-7);
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ media: '', segments: [] }, 'legacy.mosp');
  });
  expect(await page.evaluate(() => MaweAudioProcessing.settings())).toEqual({ gain_db: 0, target_lufs: -14, peak_ceiling_dbtp: -1 });
  expect(await page.evaluate(() => MaweAudioProcessing.measurement)).toBeNull();
  expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).audio_processing.gain_db)).toBe(0);
});

test('loudness floating window measures the bound preview track and shows spaced metrics and actions', async ({ page }) => {
  let releaseMeasurement;
  const measurementGate = new Promise(resolve => { releaseMeasurement = resolve; });
  await page.route('**/api/audio/loudness', async route => {
    await measurementGate;
    await route.continue();
  });
  await page.locator('#audio-processing-toggle').click();
  await expect(page.locator('#audio-measurement-status')).toHaveClass('measuring');
  const measuringColor = await page.locator('#audio-measurement-status').evaluate(node => {
    const swatch = document.createElement('span');
    swatch.style.color = 'var(--amber-hover)';
    node.append(swatch);
    const matches = getComputedStyle(node).color === getComputedStyle(swatch).color;
    swatch.remove();
    return matches;
  });
  expect(measuringColor).toBe(true);
  mkdirSync('.artifacts/editor-volume-management', { recursive: true });
  await page.locator('#audio-processing-panel').screenshot({ path: '.artifacts/editor-volume-management/audio-volume-panel-measuring.png', animations: 'disabled' });
  releaseMeasurement();
  await expect(page.locator('#audio-measurement-status')).toHaveText('测量完成', { timeout: 20_000 });
  const measured = await page.evaluate(() => ({ ...MaweAudioProcessing.measurement }));
  expect(measured.status).toBe('measured');
  expect(measured.integratedLufs).toBeLessThan(-10);
  await page.locator('#audio-target').selectOption('-14');
  await page.locator('#audio-normalize').click();
  const expected = Math.floor(Math.min(24, Math.max(-60, Math.min(-14 - measured.integratedLufs, -1 - measured.truePeakDbtp))) * 10) / 10;
  expect(await page.evaluate(() => MaweAudioProcessing.settings().gain_db)).toBe(expected);
  await expect(page.locator('#audio-adjusted-lufs')).toContainText('LUFS');
  await expect(page.locator('.audio-processing-notes')).toContainText('响度匹配受峰值等参数影响');
  const gaps = await page.locator('#audio-processing-panel').evaluate(panel => {
    const blocks = ['#audio-processing-drag-handle', '.audio-gain-control', '.audio-reference-control',
      '#audio-measurement-status', 'dl', '.audio-processing-actions', '.audio-processing-notes',
      '.audio-listening-volume', '.audio-gain-range-control'];
    const boxes = blocks.map(selector => panel.querySelector(selector).getBoundingClientRect());
    return boxes.slice(1).map((box, index) => box.top - boxes[index].bottom);
  });
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(8);
  expect(await page.locator('.audio-metrics').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(2);
  mkdirSync('.artifacts/editor-volume-management', { recursive: true });
  await page.locator('#audio-processing-panel').screenshot({ path: '.artifacts/editor-volume-management/audio-volume-panel.png', animations: 'disabled' });
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(page.locator('#audio-processing-title')).toHaveText('Project volume');
  expect(await page.locator('#audio-processing-panel').innerText()).not.toMatch(/[\u4e00-\u9fff]/);
  await page.locator('#audio-processing-panel').screenshot({ path: '.artifacts/editor-volume-management/audio-volume-panel-en.png', animations: 'disabled' });
});

test('floating volume window stays open through playback, drags, reclamps and preserves out-of-range gains', async ({ page }) => {
  await page.evaluate(() => MaweAudioProcessing.loadProject({ gain_db: 0, target_lufs: -14 }));
  await page.locator('#audio-processing-toggle').click();
  await expect(page.locator('#audio-gain')).toHaveAttribute('min', '-6');
  await expect(page.locator('#audio-gain')).toHaveAttribute('max', '12');
  await page.locator('#audio-gain').focus();
  await page.keyboard.press('Home');
  await expect(page.locator('#audio-gain')).toHaveValue('-6');
  await page.keyboard.press('End');
  await expect(page.locator('#audio-gain')).toHaveValue('12');
  await page.locator('#audio-gain-reset').click();
  const before = await page.locator('#audio-processing-panel').boundingBox();
  const header = await page.locator('#audio-processing-drag-handle').boundingBox();
  await page.mouse.move(header.x + 100, header.y + 20);
  await page.mouse.down();
  await page.mouse.move(page.viewportSize().width - before.width - 12 + 100, 32, { steps: 10 });
  await page.mouse.up();
  const moved = await page.locator('#audio-processing-panel').boundingBox();
  expect(Math.abs(moved.x - before.x)).toBeGreaterThan(50);
  await page.locator('#media-play-toggle').click();
  await expect(page.locator('#audio-processing-panel')).toBeVisible();
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.paused)).toBe(false);
  await page.evaluate(() => MaweAudioProcessing.change({ gain_db: -40 }));
  await expect(page.locator('#audio-gain')).toHaveValue('-40');
  await expect(page.locator('#audio-gain-expanded')).toBeChecked();
  await expect(page.locator('#audio-gain-expanded')).toBeDisabled();
  await page.locator('#audio-processing-close').click();
  await expect(page.locator('#audio-processing-panel')).not.toBeVisible();
  await page.locator('#audio-processing-toggle').click();
  await expect(page.locator('#audio-gain')).toHaveValue('-40');
  await page.setViewportSize({ width: 640, height: 560 });
  await expect.poll(async () => {
    const box = await page.locator('#audio-processing-panel').boundingBox();
    return box.x >= 6 && box.y >= 6 && box.x + box.width <= 634 && box.y + box.height <= 554;
  }).toBe(true);
  mkdirSync('.artifacts/editor-volume-management', { recursive: true });
  await page.locator('#audio-processing-panel').screenshot({ path: '.artifacts/editor-volume-management/audio-volume-panel-small.png', animations: 'disabled' });
  await page.locator('#audio-gain-reset').click();
  await page.locator('#audio-gain-expanded').uncheck();
  await expect(page.locator('#audio-gain')).toHaveAttribute('min', '-6');
  await expect(page.locator('#audio-gain')).toHaveValue('0');
});
