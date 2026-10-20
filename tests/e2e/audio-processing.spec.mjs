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
        window.gainAnalyser = this.createAnalyser();
        gain.connect(window.gainAnalyser);
        return gain;
      }
      createMediaElementSource(element) { window.audioSourceCount++; return super.createMediaElementSource(element); }
    };
  });
  await page.goto(server.url);
  await expect(page.locator('.cue[data-idx="0"]')).toBeVisible();
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
  await expect.poll(() => rms(page)).toBeGreaterThan(.01);
  const before = await rms(page);
  await page.evaluate(() => {
    const slider = document.getElementById('audio-gain');
    slider.value = '-13'; slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => rms(page)).toBeLessThan(before * .3);
  const after = await rms(page);
  expect(20 * Math.log10(after / before)).toBeCloseTo(-12, 0);
  expect(await page.evaluate(() => MaweCoreState.player.volume)).toBe(.5);
  expect(await page.evaluate(() => window.audioSourceCount)).toBe(1);
  // Native range keys must not seek media or invoke the editor's Home command.
  await page.locator('#audio-processing-toggle').click();
  await page.locator('#audio-gain').focus();
  await page.keyboard.press('Home');
  await expect(page.locator('#audio-gain')).toHaveValue('-60');
  await page.keyboard.press('End');
  await expect(page.locator('#audio-gain')).toHaveValue('24');
  await page.keyboard.press('Escape');
  await expect(page.locator('#audio-processing-panel')).not.toBeVisible();
});

test('save/reload retains canonical gain; loading an older project resets it and clears the measurement', async ({ page }) => {
  await page.evaluate(() => MaweAudioProcessing.change({ gain_db: -7, target_lufs: -16 }));
  expect(await page.evaluate(() => MaweState.hasProjectChanges())).toBe(true);
  expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).audio_processing))
    .toEqual({ gain_db: -7, target_lufs: -16, peak_ceiling_dbtp: -1 });
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(true);
  expect(await page.evaluate(() => MaweState.hasProjectChanges())).toBe(false);
  await page.reload();
  await expect(page.locator('.cue[data-idx="0"]')).toBeVisible();
  expect(await page.evaluate(() => MaweAudioProcessing.settings().gain_db)).toBe(-7);
  expect(JSON.parse(readFileSync(project, 'utf8')).audio_processing.gain_db).toBe(-7);
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ media: '', segments: [] }, 'legacy.mosp');
  });
  expect(await page.evaluate(() => MaweAudioProcessing.settings())).toEqual({ gain_db: 0, target_lufs: -23, peak_ceiling_dbtp: -1 });
  expect(await page.evaluate(() => MaweAudioProcessing.measurement)).toBeNull();
  expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).audio_processing.gain_db)).toBe(0);
});

test('loudness dialog measures the bound preview track and explains estimated peak-limited normalization', async ({ page }) => {
  await page.locator('#audio-processing-toggle').click();
  await expect(page.locator('#audio-measurement-status')).toHaveText('测量完成', { timeout: 20_000 });
  const measured = await page.evaluate(() => ({ ...MaweAudioProcessing.measurement }));
  expect(measured.status).toBe('measured');
  expect(measured.integratedLufs).toBeLessThan(-10);
  await page.locator('#audio-target').selectOption('-14');
  await page.locator('#audio-normalize').click();
  const expected = Math.floor(Math.min(24, Math.max(-60, Math.min(-14 - measured.integratedLufs, -1 - measured.truePeakDbtp))) * 10) / 10;
  expect(await page.evaluate(() => MaweAudioProcessing.settings().gain_db)).toBe(expected);
  await expect(page.locator('#audio-adjusted-lufs')).toContainText('LUFS');
  await expect(page.locator('#audio-measurement-track')).toContainText('预览音轨 1');
  const gaps = await page.locator('#audio-processing-panel').evaluate(panel => {
    const blocks = ['.audio-processing-heading', 'label[for="audio-gain"]', '.audio-gain-row',
      'label[for="audio-target"]', '#audio-measurement-status', 'dl', '.audio-processing-actions',
      '#audio-measurement-track', '.audio-processing-note:not([id])', '.audio-listening-volume'];
    const boxes = blocks.map(selector => panel.querySelector(selector).getBoundingClientRect());
    return boxes.slice(1).map((box, index) => box.top - boxes[index].bottom);
  });
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(8);
  mkdirSync('.artifacts/editor-volume-management', { recursive: true });
  await page.locator('#audio-processing-panel').screenshot({ path: '.artifacts/editor-volume-management/audio-volume-panel.png', animations: 'disabled' });
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(page.locator('#audio-processing-title')).toHaveText('Project volume');
  expect(await page.locator('#audio-processing-panel').innerText()).not.toMatch(/[\u4e00-\u9fff]/);
});
