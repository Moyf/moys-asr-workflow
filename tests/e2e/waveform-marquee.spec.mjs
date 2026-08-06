// Waveform Shift+drag marquee selection regression — shared scenario suite.
// Runs identical assertions against both localhost server and portable HTML.
// Marquee is performed with real Shift+left-button mouse drags on blank waveform.
// All waits are on observable DOM/DATA state (no arbitrary sleeps).
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeTempDir,
  cleanupTempDir,
  findFreePort,
  generateWav,
  generateWaveformPayload,
  generateBlankEditor,
  startServer,
  startStaticServer,
} from './helpers.mjs';

// ---------------------------------------------------------------------------
// Fixture: five cues packed into a 12s basic-mode window (plus one outside it),
// so a horizontal marquee can deterministically hit a known subset.
// ---------------------------------------------------------------------------
const MARQUEE_DURATION_MS = 30_000;
const MARQUEE_SEGMENTS = [
  { start: 500, end: 2000, text: 'One', items: [{ start: 500, end: 2000, text: 'One' }] },
  { start: 2500, end: 4500, text: 'Two', items: [{ start: 2500, end: 4500, text: 'Two' }] },
  { start: 5000, end: 7000, text: 'Three', items: [{ start: 5000, end: 7000, text: 'Three' }] },
  { start: 7500, end: 9500, text: 'Four', items: [{ start: 7500, end: 9500, text: 'Four' }] },
  { start: 20000, end: 22000, text: 'Later', items: [{ start: 20000, end: 22000, text: 'Later' }] },
];

function generateMarqueeProject(filePath) {
  const project = {
    media: 'synthetic.wav',
    segments: MARQUEE_SEGMENTS,
    waveform: generateWaveformPayload(MARQUEE_DURATION_MS),
  };
  writeFileSync(filePath, JSON.stringify(project, null, 2), 'utf-8');
  return filePath;
}

// Basic (single-row) mode with a 12s window; dragPlayhead stays ON so the
// "Shift+drag does not seek" assertions actually exercise the marquee path
// instead of passing because seeking was disabled anyway.
async function configureBasicMode(page) {
  await page.addInitScript(() => {
    const settings = {
      mode: 'basic',
      layout: 'wave-right',
      visibleSeconds: 12,
      secondsPerRow: 5,
      rowHeight: 96,
      side: 'left',
      splitPercent: 60,
      layoutColumnPercent: 58,
      layoutRows: [42, 18, 40],
      freeOrder: ['player', 'panel', 'cues', 'wave'],
      layoutTree: null,
      layoutEditing: false,
      waveformScale: 1,
      disabledDisplay: 'dim',
      dragPlayhead: true,
    };
    localStorage.setItem('moy.asr.waveform.settings.v1', JSON.stringify(settings));
  });
}

async function waitForWaveformCues(page) {
  await page.waitForSelector('.waveform-cue-block', { state: 'visible', timeout: 15_000 });
}

async function getSelectedIndices(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.cue.selected')].map((el) => Number(el.dataset.idx)).sort((a, b) => a - b),
  );
}

async function getPlayerTime(page) {
  return page.evaluate(() => document.getElementById('player')?.currentTime ?? -1);
}

// Geometry for a marquee that covers cue blocks 1 and 2 only: start in the
// blank strip above the blocks at block-1's horizontal center, drag to just
// below block-2's bottom at its horizontal center. The rectangle then spans
// block1.centerX → block2.centerX, which cannot touch blocks 0 or 3.
async function marqueeGeometry(page) {
  const rowBox = await page.locator('.waveform-row').first().boundingBox();
  const b1 = await page.locator('.waveform-cue-block[data-idx="1"]').first().boundingBox();
  const b2 = await page.locator('.waveform-cue-block[data-idx="2"]').first().boundingBox();
  if (!rowBox || !b1 || !b2) throw new Error('marquee geometry unavailable');
  return {
    start: { x: b1.x + b1.width / 2, y: rowBox.y + 4 },
    end: { x: b2.x + b2.width / 2, y: b2.y + b2.height + 6 },
  };
}

// Real Shift+left-drag between two viewport points, in small steps.
async function shiftDrag(page, start, end, steps = 8) {
  await page.keyboard.down('Shift');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      start.x + ((end.x - start.x) * i) / steps,
      start.y + ((end.y - start.y) * i) / steps,
    );
  }
}

async function finishDrag(page) {
  await page.mouse.up();
  await page.keyboard.up('Shift');
}

// Wait for the marquee commit to land: blocks 1+2 selected in the cue list.
async function expectMarqueeSelection(page, expectedIdxs) {
  await page.waitForFunction(
    (expected) => {
      const actual = [...document.querySelectorAll('.cue.selected')]
        .map((el) => Number(el.dataset.idx))
        .sort((a, b) => a - b);
      return actual.length === expected.length && actual.every((v, i) => v === expected[i]);
    },
    expectedIdxs,
    { timeout: 5000 },
  );
}

function attachErrorCollector(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

// Shared scenario body — `openEditor` must navigate and leave the editor ready.
async function runMarqueeScenarios(page, openEditor) {
  const errors = attachErrorCollector(page);

  // --- Scenario 1: Shift+drag selects blocks 1 and 2, without seeking ---
  await openEditor(page);
  let geo = await marqueeGeometry(page);
  await shiftDrag(page, geo.start, geo.end);
  await finishDrag(page);
  await expectMarqueeSelection(page, [1, 2]);
  expect(await getSelectedIndices(page), 'marquee selects blocks 1+2').toEqual([1, 2]);
  const selCount = await page.locator('#sel-count').textContent();
  expect(selCount.trim(), 'selection count badge').toBe('2');
  expect(await getPlayerTime(page), 'Shift+drag must not seek (dragPlayhead on)').toBeLessThan(0.5);
  // 窗口外的 idx 4 块即使存在于 DOM（hidden）也不得被框选命中
  expect(
    await page.locator('.waveform-cue-block[data-idx="4"].selected').count(),
    'out-of-window cue not selected',
  ).toBe(0);
  expect(errors, 'no console errors (basic marquee)').toEqual([]);

  // --- Scenario 2: marquee is additive on top of an existing selection ---
  await openEditor(page);
  await page.locator('.waveform-cue-block[data-idx="0"]').first().click();
  await page.waitForSelector('.cue[data-idx="0"].selected', { timeout: 5000 });
  geo = await marqueeGeometry(page);
  await shiftDrag(page, geo.start, geo.end);
  await finishDrag(page);
  await expectMarqueeSelection(page, [0, 1, 2]);
  expect(await getSelectedIndices(page), 'marquee unions with previous selection').toEqual([0, 1, 2]);
  expect(errors, 'no console errors (additive marquee)').toEqual([]);

  // --- Scenario 3: Shift+click (no drag) on blank waveform is a no-op ---
  await openEditor(page);
  geo = await marqueeGeometry(page);
  await page.keyboard.down('Shift');
  await page.mouse.move(geo.start.x, geo.start.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Shift');
  // Give the app a beat to misbehave, then confirm nothing changed.
  await page.waitForTimeout(300);
  expect(await getSelectedIndices(page), 'Shift+click blank selects nothing').toEqual([]);
  expect(await getPlayerTime(page), 'Shift+click blank must not seek').toBeLessThan(0.5);
  expect(await page.locator('.waveform-marquee').count(), 'no overlay for sub-threshold click').toBe(0);
  expect(errors, 'no console errors (sub-threshold shift click)').toEqual([]);

  // --- Scenario 4: during drag the overlay + preview classes appear; after
  // release they are gone and the real .selected state replaces them ---
  await openEditor(page);
  geo = await marqueeGeometry(page);
  const b1Box = await page.locator('.waveform-cue-block[data-idx="1"]').first().boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.move(geo.start.x, geo.start.y);
  await page.mouse.down();
  // 先拖进块 1 的垂直范围（矩形已覆盖块 1、尚未碰到块 2），验证预览出现
  await page.mouse.move(geo.start.x + 10, b1Box.y + b1Box.height / 2, { steps: 4 });
  await page.waitForSelector('.waveform-marquee', { state: 'visible', timeout: 5000 });
  await page.waitForSelector('.waveform-cue-block.marquee-preview', { state: 'visible', timeout: 5000 });
  // 继续拖完整个框选路径再松开
  await page.mouse.move(geo.end.x, geo.end.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expectMarqueeSelection(page, [1, 2]);
  expect(await page.locator('.waveform-marquee').count(), 'overlay removed after release').toBe(0);
  expect(await page.locator('.waveform-cue-block.marquee-preview').count(), 'preview classes cleaned up').toBe(0);
  expect(
    await page.locator('.waveform-cue-block.selected').count(),
    'selected styling applied to waveform blocks',
  ).toBeGreaterThanOrEqual(2);
  expect(errors, 'no console errors (overlay lifecycle)').toEqual([]);
}

// ===========================================================================
// Localhost server adapter
// ===========================================================================
let localhostDir, localhostServer, localhostPort, wavPath, projectPath;

test.beforeAll(async () => {
  localhostDir = makeTempDir('marquee-localhost');
  wavPath = join(localhostDir, 'synthetic.wav');
  projectPath = join(localhostDir, 'project.json');
  generateWav(wavPath, MARQUEE_DURATION_MS / 1000);
  generateMarqueeProject(projectPath);
  localhostPort = await findFreePort();
  localhostServer = await startServer(projectPath, wavPath, localhostPort);
});

test.afterAll(async () => {
  await localhostServer?.stop();
  cleanupTempDir(localhostDir);
});

test.describe('localhost server', () => {
  test('waveform marquee scenarios', async ({ page }) => {
    await configureBasicMode(page);
    await runMarqueeScenarios(page, async (p) => {
      await p.goto(localhostServer.url);
      await waitForWaveformCues(p);
    });
  });
});

// ===========================================================================
// Portable HTML adapter
// ===========================================================================
let portableDir, portableStaticServer, portablePort, portableWavPath, portableProjectPath, blankHtmlPath;

test.beforeAll(async () => {
  portableDir = makeTempDir('marquee-portable');
  portableWavPath = join(portableDir, 'synthetic.wav');
  portableProjectPath = join(portableDir, 'project.json');
  blankHtmlPath = join(portableDir, 'blank-editor.html');
  generateWav(portableWavPath, MARQUEE_DURATION_MS / 1000);
  generateMarqueeProject(portableProjectPath);
  generateBlankEditor(blankHtmlPath);
  portablePort = await findFreePort();
  portableStaticServer = await startStaticServer(blankHtmlPath, portablePort);
});

test.afterAll(async () => {
  await portableStaticServer?.stop();
  cleanupTempDir(portableDir);
});

async function loadProjectAndMedia(page) {
  await page.locator('#open-project-file').setInputFiles(portableProjectPath);
  const mediaModal = page.locator('#project-media-modal');
  await mediaModal.waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#project-media-select').click();
  await page.locator('#load-media-file').setInputFiles(portableWavPath);
  await page.waitForFunction(
    () => {
      const p = document.getElementById('player');
      const src = p?.currentSrc || p?.querySelector('source')?.getAttribute('src');
      return Boolean(src && src.trim());
    },
    { timeout: 10_000 },
  );
  await mediaModal.waitFor({ state: 'hidden', timeout: 5000 });
}

test.describe('portable HTML', () => {
  test('waveform marquee scenarios', async ({ page }) => {
    await configureBasicMode(page);
    await runMarqueeScenarios(page, async (p) => {
      await p.goto(portableStaticServer.url);
      await loadProjectAndMedia(p);
      await waitForWaveformCues(p);
    });
  });
});
