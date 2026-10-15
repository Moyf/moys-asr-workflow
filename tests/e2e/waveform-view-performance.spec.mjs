import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';

let tempDir, server;
test.beforeAll(async () => {
  tempDir = makeTempDir('waveform-view');
  const media = join(tempDir, 'synthetic.wav');
  const project = join(tempDir, 'view.mosp');
  generateWav(media, 60);
  writeFileSync(project, JSON.stringify({ media, waveform: generateWaveformPayload(60000), segments:
    Array.from({ length: 40 }, (_, index) => ({ id: `view-${index}`, start: index * 1500, end: index * 1500 + 1200,
      text: '甲乙丙丁', items: Array.from('甲乙丙丁', (text, item) => ({ text, start: index * 1500 + item * 300, end: index * 1500 + (item + 1) * 300 })) })),
  }), 'utf8');
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
  await page.goto(server.url);
  await expect(page.locator('.waveform-row').first()).toBeVisible();
  await page.locator('[data-waveform-mode="basic"]').click();
});

test('horizontal wheel keeps the row and Canvas while updating the visible window and pointer mapping', async ({ page }) => {
  await page.evaluate(() => {
    const editor = MaweCoreState.waveformEditor;
    editor.settings.visibleSeconds = 10;
    editor.basicWindowStartMs = 0;
    editor.renderBasic();
    const row = editor.renderedRows[0];
    row.dataset.testIdentity = 'stable';
    row.querySelector('canvas').dataset.testIdentity = 'stable';
  });
  const row = page.locator('.waveform-row').first();
  const box = await row.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => row.getAttribute('data-start-ms')).toBe('1200');
  await expect(row).toHaveAttribute('data-test-identity', 'stable');
  await expect(row.locator('canvas')).toHaveAttribute('data-test-identity', 'stable');
  const result = await row.evaluate(element => {
    const editor = MaweCoreState.waveformEditor;
    const rect = element.getBoundingClientRect();
    return { firstCue: element.querySelector('.waveform-cue-block').dataset.idx,
      pointerTime: editor.pointerTimeMs({ clientX: rect.left + element.clientLeft + element.clientWidth / 2 }, element),
      pointerVisible: !element.querySelector('.waveform-pointer-line').hidden };
  });
  expect(result.firstCue).toBe('1');
  expect(result.pointerTime).toBeCloseTo(6200, 0);
  expect(result.pointerVisible).toBe(true);
});

test('Q toggles only basic cue overlays and restores multi-row presets with one render', async ({ page }) => {
  const initial = await page.evaluate(() => {
    const editor = MaweCoreState.waveformEditor;
    editor.renderedRows[0].querySelector('canvas').dataset.testIdentity = 'stable';
    return editor.basicWindowStartMs;
  });
  await page.locator('#waveform-pane').click({ position: { x: 10, y: 10 } });
  await page.keyboard.press('q');
  await expect(page.locator('.waveform-word-block').first()).toBeVisible();
  await expect(page.locator('.waveform-row canvas')).toHaveAttribute('data-test-identity', 'stable');
  expect(await page.evaluate(() => MaweCoreState.waveformEditor.basicWindowStartMs)).toBe(initial);
  await page.keyboard.press('q');
  await expect(page.locator('.waveform-word-block')).toHaveCount(0);
  await expect(page.locator('.waveform-row canvas')).toHaveAttribute('data-test-identity', 'stable');

  await page.locator('[data-waveform-mode="multi"]').click();
  await page.evaluate(() => {
    const editor = MaweCoreState.waveformEditor;
    editor.setRowHeight(192);
    editor.setSecondsPerRow(20);
    let renders = 0;
    const render = editor.render;
    editor.render = function (...args) { renders += 1; return render.apply(this, args); };
    MaweWordTiming.setEnabled(true);
    window.__viewPresetResult = { renders, rowHeight: editor.settings.rowHeight, secondsPerRow: editor.settings.secondsPerRow };
    MaweWordTiming.setEnabled(false);
    window.__viewPresetResult.restored = { renders, rowHeight: editor.settings.rowHeight, secondsPerRow: editor.settings.secondsPerRow };
    editor.render = render;
  });
  const presets = await page.evaluate(() => window.__viewPresetResult);
  expect(presets.renders).toBe(1);
  expect(presets.secondsPerRow).toBe(5);
  expect(presets.restored).toEqual({ renders: 2, rowHeight: 192, secondsPerRow: 20 });
});
