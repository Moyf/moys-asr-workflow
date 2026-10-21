import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, generateWaveformPayload,
  makeTempDir, openSettingsPage, closeSettingsPanels, startServer } from './helpers.mjs';

let directory;
let server;
test.beforeAll(async () => {
  directory = makeTempDir('waveform-feedback');
  const media = generateWav(join(directory, 'synthetic.wav'), 12);
  const project = join(directory, 'feedback.json');
  writeFileSync(project, JSON.stringify({ segments: [
    { id: 'dragged', start: 1000, end: 2000, text: 'dragged cue',
      items: [{ start: 1000, end: 1500, text: 'dragged' }, { start: 1500, end: 2000, text: 'cue' }] },
    { id: 'anchor', start: 5000, end: 6000, text: 'anchor cue' },
  ], overlay_track: { enabled: true, segments: [
    { id: 'blocked', start: 4800, end: 5500, text: 'blocking overlay' },
  ] }, markers: { items: [{ id: 'point', start: 2500, name: 'point' },
    { id: 'region', start: 3000, end: 3400, name: 'region' }] },
  waveform: generateWaveformPayload(12000) }));
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });
async function load(page) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.locator('[data-waveform-mode="basic"]').click();
  await expect(page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first()).toBeVisible();
}

test('Shift drag stays stable when its main-overlapping target is occupied on the overlay', async ({ page }) => {
  await load(page);
  const geometry = await page.evaluate(() => {
    const row = document.querySelector('.waveform-row');
    const rect = row.getBoundingClientRect();
    return { left: rect.left, width: rect.width, start: Number(row.dataset.startMs), end: Number(row.dataset.endMs) };
  });
  const box = await page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first().boundingBox();
  const xAt = time => geometry.left + (time - geometry.start) / (geometry.end - geometry.start) * geometry.width;
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Every requested interval overlaps both the main anchor and the preceding overlay.
  for (const time of [4800, 4900, 5000, 5100, 5200, 5300, 5200, 5100]) {
    await page.mouse.move(xAt(time), box.y + box.height / 2);
    expect(await page.evaluate(() => MaweCoreState.waveformEditor.drag.track)).toBe('main');
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].end)).toBe(5000);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].start)).toBe(1000);
});

test('point markers and drag previews stay 8px across zoom; regions stop audition at their end', async ({ page }) => {
  await load(page);
  await page.evaluate(() => MaweMarkerEditing.setEditingEnabled(true));
  for (const seconds of [5, 10, 20]) {
    await page.evaluate(seconds => {
      MaweCoreState.waveformEditor.settings.visibleSeconds = seconds;
      MaweCoreState.waveformEditor.render();
    }, seconds);
    await expect(page.locator('.waveform-marker-item.point[data-marker-id="point"]').first()).toHaveCSS('width', '8px');
  }
  const point = page.locator('.waveform-marker-item.point[data-marker-id="point"]').first();
  const box = await point.boundingBox();
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 3 });
  await expect(page.locator('.waveform-marker-item.drag-preview.point').first()).toHaveCSS('width', '8px');
  await page.mouse.up();
  await page.evaluate(() => MaweMarkerEditing.locateMarker('region', { play: true }));
  await expect.poll(() => page.evaluate(() => MaweCoreState.player.paused)).toBe(true);
  const stopped = await page.evaluate(() => MaweCoreState.player.currentTime);
  expect(stopped).toBeGreaterThanOrEqual(3.3);
  expect(stopped).toBeLessThan(3.55);
});

for (const thumbnailMode of ['strip', 'marks']) {
test(`single-row ${thumbnailMode} thumbnails fit the viewport and bilingual settings keep measured spacing`, async ({ page }) => {
  await load(page);
  await page.setViewportSize({ width: 1100, height: 680 });
  await page.evaluate(mode => {
    const editor = MaweCoreState.waveformEditor;
    // Isolate layout from cache/server state; thumbnail lifecycle is tested by its module.
    editor.thumbnailController.close();
    editor.thumbnailController = { visible: true, enabled: true, mode, decodeEnabled: true, interval: 1000, state: 'ready',
      setView() {}, picture() { return null; }, keyframesInRange() { return []; },
      setPlayhead() {}, setPlaying() {}, close() {} };
    editor.render();
  }, thumbnailMode);
  const geometry = await page.evaluate(() => {
    const editor = MaweCoreState.waveformEditor;
    const viewport = editor.scroll.getBoundingClientRect();
    const row = editor.renderedRows[0];
    const shell = row._thumbnailShell.getBoundingClientRect();
    const block = row.querySelector('.waveform-cue-block').getBoundingClientRect();
    return { mode: editor.settings.mode, top: shell.top - viewport.top, bottom: viewport.bottom - shell.bottom,
      subtitleBottom: viewport.bottom - block.bottom };
  });
  expect(geometry.mode).toBe('basic');
  console.log('single-row geometry', JSON.stringify(geometry));
  expect(geometry.top).toBeGreaterThanOrEqual(8);
  expect(geometry.bottom).toBeGreaterThanOrEqual(8);
  expect(geometry.subtitleBottom).toBeGreaterThanOrEqual(8);
  await page.locator('.waveform-pane').screenshot({ path: test.info().outputPath('single-filmstrip.png') });
  await openSettingsPage(page, 'multi-subtitle');
  const toggle = page.locator('#editor-settings-page-multi-subtitle #multi-subtitle-toggle');
  await expect(toggle).toHaveCount(1);
  const spacing = await page.evaluate(() => {
    const controls = document.querySelector('.multi-subtitle-mode-controls');
    return controls.nextElementSibling.getBoundingClientRect().top - controls.getBoundingClientRect().bottom;
  });
  expect(spacing).toBeGreaterThanOrEqual(8);
  console.log('bilingual control spacing', spacing);
  await page.locator('#project-settings-panel').screenshot({ path: test.info().outputPath('bilingual-settings.png') });
  await closeSettingsPanels(page);
});
}

test('compact timed-word sentences retain their selected outline', async ({ page }) => {
  await load(page);
  await page.locator('[data-waveform-mode="multi"]').click();
  await page.evaluate(() => {
    MaweWordTiming.setEnabled(true);
    MaweCoreState.waveformEditor.setRowHeight(64);
    MaweCoreState.waveformEditor.options.selectCue(0);
    MaweCoreState.waveformEditor.refreshCueOverlay();
  });
  const selected = page.locator('.waveform-cue-block.word-timing-background.selected').first();
  await expect(selected).toBeVisible();
  const outline = await selected.evaluate(element => ({ color: getComputedStyle(element).outlineColor,
    width: parseFloat(getComputedStyle(element).outlineWidth) }));
  expect(outline.color).not.toBe('rgba(0, 0, 0, 0)');
  expect(outline.width).toBeGreaterThan(0);
  await page.locator('.waveform-pane').screenshot({ path: test.info().outputPath('compact-outline.png') });
});

test('occupied cue creation suggests overlap only while overlap is disabled', async ({ page }) => {
  await load(page);
  for (const enabled of [false, true]) {
    await page.evaluate(enabled => {
      document.getElementById('hint-stack')?.replaceChildren();
      AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).enabled = enabled;
      MaweCoreState.waveformEditor.options.onCueCreateRejected('occupied');
      MaweAddCue.addCueRangeFromWaveform(1100, 1600, 0, 0, 'main');
    }, enabled);
    const hints = page.locator('.hint-card');
    await expect(hints).toHaveCount(2);
    for (const text of await hints.allTextContents()) {
      expect(text.includes('如果你需要重叠字幕')).toBe(!enabled);
    }
  }
});
